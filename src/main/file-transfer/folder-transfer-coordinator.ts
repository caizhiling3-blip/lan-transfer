import { createHash, randomBytes, randomUUID } from 'node:crypto'

import {
  FOLDER_TRANSFER_TIMEOUT_MS,
  MAX_FOLDER_MANIFEST_BYTES,
  MAX_FOLDER_MANIFEST_CHUNK_BYTES,
  MAX_FOLDER_MANIFEST_CHUNKS,
} from '@shared/constants'
import type { FolderOfferReceivedDto } from '@shared/ipc'
import { manifestIdSchema, transferIdSchema } from '@shared/types'
import type {
  DeviceInfo,
  FolderManifestContents,
  ManifestId,
  TransferId,
  TransferTaskDto,
} from '@shared/types'
import { createPortablePathCollisionKey, parsePortableRelativePath } from '@shared/utils'

import type { ConnectionManager, FolderControlMessage } from '../websocket'
import type { AuthorizedSourceFolder } from './file-access-registry'

type TaskListener = (task: TransferTaskDto) => void
type OfferListener = (offer: FolderOfferReceivedDto) => void

export interface FolderAccessAdapter {
  consumeFolder(selectionToken: string): AuthorizedSourceFolder | null
  resolveReceiveDirectory(directoryToken?: string): Promise<string>
}

interface ManifestChunk {
  readonly files: FolderManifestContents['files']
  readonly emptyDirectories: readonly string[]
}

interface OutgoingFolderTransfer {
  task: TransferTaskDto
  readonly source: AuthorizedSourceFolder
  readonly manifestId: ManifestId
  readonly manifestSha256: string
  readonly chunks: readonly ManifestChunk[]
  uploadKey?: string
  timeout?: ReturnType<typeof setTimeout>
}

interface IncomingFolderTransfer {
  task?: TransferTaskDto
  readonly peer: DeviceInfo
  readonly offer: Extract<FolderControlMessage, { type: 'folder:offer' }>['payload']
  readonly chunks: Map<number, ManifestChunk>
  manifest?: FolderManifestContents
  receiveDirectory?: string
  timeout?: ReturnType<typeof setTimeout>
}

const hashManifest = (manifest: FolderManifestContents): string =>
  createHash('sha256').update(JSON.stringify(manifest)).digest('hex')

const buildManifestChunks = (manifest: FolderManifestContents): readonly ManifestChunk[] => {
  const chunks: ManifestChunk[] = []
  let files: FolderManifestContents['files'][number][] = []
  let emptyDirectories: string[] = []
  const flush = (): void => {
    if (files.length === 0 && emptyDirectories.length === 0) return
    chunks.push({ files, emptyDirectories })
    files = []
    emptyDirectories = []
  }
  for (const file of manifest.files) {
    const candidate = { files: [...files, file], emptyDirectories }
    if (Buffer.byteLength(JSON.stringify(candidate)) > MAX_FOLDER_MANIFEST_CHUNK_BYTES) flush()
    files.push(file)
  }
  for (const directory of manifest.emptyDirectories) {
    const candidate = { files, emptyDirectories: [...emptyDirectories, directory] }
    if (Buffer.byteLength(JSON.stringify(candidate)) > MAX_FOLDER_MANIFEST_CHUNK_BYTES) flush()
    emptyDirectories.push(directory)
  }
  flush()
  if (chunks.length === 0) chunks.push({ files: [], emptyDirectories: [] })
  if (chunks.length > MAX_FOLDER_MANIFEST_CHUNKS) throw new Error('FOLDER_MANIFEST_TOO_LARGE')
  return chunks
}

const createFolderTask = (
  transferId: TransferId,
  direction: 'send' | 'receive',
  peer: DeviceInfo,
  manifest: FolderManifestContents,
): TransferTaskDto => {
  const now = Date.now()
  return {
    transferId,
    direction,
    kind: 'folder',
    peer,
    status: 'awaitingAcceptance',
    files: [],
    folder: {
      displayName: manifest.displayName,
      fileCount: manifest.files.length,
      emptyDirectoryCount: manifest.emptyDirectories.length,
    },
    totalBytes: manifest.totalSize,
    transferredBytes: 0,
    bytesPerSecond: 0,
    createdAt: now,
    updatedAt: now,
  }
}

export class FolderTransferCoordinator {
  private readonly outgoing = new Map<TransferId, OutgoingFolderTransfer>()
  private readonly incoming = new Map<TransferId, IncomingFolderTransfer>()
  private readonly taskListeners = new Set<TaskListener>()
  private readonly offerListeners = new Set<OfferListener>()
  private readonly unsubscribeMessages: () => void
  private readonly unsubscribeConnection: () => void

  public constructor(
    private readonly connectionManager: ConnectionManager,
    private readonly fileAccess: FolderAccessAdapter,
    private readonly canStartOutgoingTransfer: () => boolean = () => true,
  ) {
    this.unsubscribeMessages = connectionManager.subscribeFolderMessages((message) =>
      this.handleMessage(message),
    )
    this.unsubscribeConnection = connectionManager.subscribeStatus((status) => {
      if (status.state === 'disconnected') this.failActiveTransfers('CONNECTION_CLOSED')
    })
  }

  public subscribeTasks(listener: TaskListener): () => void {
    this.taskListeners.add(listener)
    return () => this.taskListeners.delete(listener)
  }

  public subscribeOffers(listener: OfferListener): () => void {
    this.offerListeners.add(listener)
    return () => this.offerListeners.delete(listener)
  }

  public getTasks(): readonly TransferTaskDto[] {
    return [
      ...[...this.outgoing.values()].map(({ task }) => task),
      ...[...this.incoming.values()].flatMap(({ task }) => (task === undefined ? [] : [task])),
    ]
  }

  public getPendingOffer(): FolderOfferReceivedDto | null {
    const transfer = [...this.incoming.values()].find(
      ({ task }) => task?.status === 'awaitingAcceptance',
    )
    return transfer?.task === undefined ? null : this.toOfferDto(transfer.task)
  }

  public ownsTransfer(transferId: TransferId): boolean {
    return this.outgoing.has(transferId) || this.incoming.has(transferId)
  }

  public hasActiveTransfers(): boolean {
    return this.getTasks().some(
      (task) => !['completed', 'failed', 'cancelled', 'rejected'].includes(task.status),
    )
  }

  public async offerFolder(selectionToken: string): Promise<TransferTaskDto | null> {
    const hasActiveOutgoing = [...this.outgoing.values()].some(
      ({ task }) => !['completed', 'failed', 'cancelled', 'rejected'].includes(task.status),
    )
    if (hasActiveOutgoing || !this.canStartOutgoingTransfer()) return null
    const source = this.fileAccess.consumeFolder(selectionToken)
    const peer = this.connectionManager.getPeer()
    if (source === null || peer === null) return null
    const transferId = transferIdSchema.parse(randomUUID())
    const manifestId = manifestIdSchema.parse(randomUUID())
    const manifestSha256 = hashManifest(source.manifest)
    const chunks = buildManifestChunks(source.manifest)
    const task = createFolderTask(transferId, 'send', peer, source.manifest)
    const transfer: OutgoingFolderTransfer = {
      task,
      source,
      manifestId,
      manifestSha256,
      chunks,
    }
    this.outgoing.set(transferId, transfer)
    transfer.timeout = this.createTimeout(() => this.failOutgoing(transfer, 'TRANSFER_TIMEOUT'))
    const offered = await this.connectionManager.sendFolderOffer({
      transferId,
      manifestId,
      displayName: source.manifest.displayName,
      totalSize: source.manifest.totalSize,
      fileCount: source.manifest.files.length,
      emptyDirectoryCount: source.manifest.emptyDirectories.length,
      manifestChunkCount: chunks.length,
      manifestSha256,
    })
    if (!offered) {
      this.failOutgoing(transfer, 'CONNECTION_CLOSED')
      return transfer.task
    }
    for (const [chunkIndex, chunk] of chunks.entries()) {
      if (
        !(await this.connectionManager.sendFolderManifest({
          transferId,
          manifestId,
          chunkIndex,
          files: [...chunk.files],
          emptyDirectories: [...chunk.emptyDirectories],
        }))
      ) {
        this.failOutgoing(transfer, 'CONNECTION_CLOSED')
        break
      }
    }
    this.emitTask(transfer.task)
    return transfer.task
  }

  public async respondToOffer(
    transferId: TransferId,
    decision: 'accept' | 'reject',
    directoryToken?: string,
  ): Promise<TransferTaskDto | null> {
    const transfer = this.incoming.get(transferId)
    if (transfer?.task === undefined || transfer.manifest === undefined) return null
    if (transfer.task.status !== 'awaitingAcceptance') return null
    this.clearTimeout(transfer)
    if (decision === 'reject') {
      await this.connectionManager.sendFolderReject({ transferId, reason: 'user_rejected' })
      transfer.task = this.updateStatus(transfer.task, 'rejected', 'FILE_REJECTED')
    } else {
      try {
        transfer.receiveDirectory = await this.fileAccess.resolveReceiveDirectory(directoryToken)
        const uploadKey = randomBytes(32).toString('base64url')
        const expiresAt = Date.now() + FOLDER_TRANSFER_TIMEOUT_MS
        if (
          !(await this.connectionManager.sendFolderAccept({ transferId, uploadKey, expiresAt }))
        ) {
          throw new Error('CONNECTION_CLOSED')
        }
        transfer.task = this.updateStatus(transfer.task, 'accepted')
      } catch (error) {
        transfer.task = this.updateStatus(
          transfer.task,
          'failed',
          error instanceof Error && error.message === 'CONNECTION_CLOSED'
            ? 'CONNECTION_CLOSED'
            : 'SAVE_DIRECTORY_INVALID',
        )
      }
    }
    this.emitTask(transfer.task)
    return transfer.task
  }

  public shutdown(): void {
    this.unsubscribeMessages()
    this.unsubscribeConnection()
    this.failActiveTransfers('TRANSFER_CANCELLED')
  }

  private handleMessage(message: FolderControlMessage): void {
    if (message.type === 'folder:offer') this.handleOffer(message.payload)
    else if (message.type === 'folder:manifest') this.handleManifest(message.payload)
    else if (message.type === 'folder:accept') this.handleAccept(message.payload)
    else if (message.type === 'folder:reject') this.handleReject(message.payload.transferId)
  }

  private handleOffer(
    offer: Extract<FolderControlMessage, { type: 'folder:offer' }>['payload'],
  ): void {
    const peer = this.connectionManager.getPeer()
    if (
      peer === null ||
      this.incoming.has(offer.transferId) ||
      this.outgoing.has(offer.transferId)
    ) {
      return
    }
    const transfer: IncomingFolderTransfer = { peer, offer, chunks: new Map() }
    transfer.timeout = this.createTimeout(() => this.failIncoming(transfer, 'TRANSFER_TIMEOUT'))
    this.incoming.set(offer.transferId, transfer)
  }

  private handleManifest(
    chunk: Extract<FolderControlMessage, { type: 'folder:manifest' }>['payload'],
  ): void {
    const transfer = this.incoming.get(chunk.transferId)
    if (
      transfer === undefined ||
      transfer.offer.manifestId !== chunk.manifestId ||
      chunk.chunkIndex >= transfer.offer.manifestChunkCount ||
      transfer.chunks.has(chunk.chunkIndex)
    ) {
      if (transfer !== undefined) this.failIncoming(transfer, 'PROTOCOL_INVALID')
      return
    }
    transfer.chunks.set(chunk.chunkIndex, {
      files: chunk.files,
      emptyDirectories: chunk.emptyDirectories,
    })
    if (transfer.chunks.size !== transfer.offer.manifestChunkCount) return
    try {
      const ordered = [...transfer.chunks.entries()].sort((left, right) => left[0] - right[0])
      const manifest: FolderManifestContents = {
        displayName: transfer.offer.displayName,
        totalSize: transfer.offer.totalSize,
        files: ordered.flatMap(([, value]) => value.files),
        emptyDirectories: ordered.flatMap(([, value]) => value.emptyDirectories),
      }
      this.validateManifest(transfer, manifest)
      transfer.manifest = manifest
      transfer.task = createFolderTask(
        transfer.offer.transferId,
        'receive',
        transfer.peer,
        manifest,
      )
      this.clearTimeout(transfer)
      transfer.timeout = this.createTimeout(() => this.failIncoming(transfer, 'TRANSFER_TIMEOUT'))
      this.emitTask(transfer.task)
      for (const listener of this.offerListeners) listener(this.toOfferDto(transfer.task))
    } catch {
      this.failIncoming(transfer, 'PROTOCOL_INVALID')
    }
  }

  private validateManifest(
    transfer: IncomingFolderTransfer,
    manifest: FolderManifestContents,
  ): void {
    if (
      manifest.files.length !== transfer.offer.fileCount ||
      manifest.emptyDirectories.length !== transfer.offer.emptyDirectoryCount ||
      manifest.files.reduce((total, file) => total + file.size, 0) !== transfer.offer.totalSize ||
      hashManifest(manifest) !== transfer.offer.manifestSha256 ||
      Buffer.byteLength(JSON.stringify(manifest)) > MAX_FOLDER_MANIFEST_BYTES
    ) {
      throw new Error('PROTOCOL_INVALID')
    }
    const pathKeys = new Set<string>()
    const terminalPathKeys = new Set<string>()
    const fileIds = new Set<string>()
    for (const file of manifest.files) {
      if (fileIds.has(file.fileId)) throw new Error('PROTOCOL_INVALID')
      fileIds.add(file.fileId)
      const segments = parsePortableRelativePath(file.relativePath)
      const key = createPortablePathCollisionKey(segments)
      if (pathKeys.has(key)) throw new Error('PROTOCOL_INVALID')
      pathKeys.add(key)
      terminalPathKeys.add(key)
    }
    for (const directory of manifest.emptyDirectories) {
      const segments = parsePortableRelativePath(directory)
      const key = createPortablePathCollisionKey(segments)
      if (pathKeys.has(key)) throw new Error('PROTOCOL_INVALID')
      pathKeys.add(key)
      terminalPathKeys.add(key)
    }
    for (const path of [
      ...manifest.files.map(({ relativePath }) => relativePath),
      ...manifest.emptyDirectories,
    ]) {
      const segments = parsePortableRelativePath(path)
      for (let depth = 1; depth < segments.length; depth += 1) {
        const ancestorKey = createPortablePathCollisionKey(segments.slice(0, depth))
        if (terminalPathKeys.has(ancestorKey)) throw new Error('PROTOCOL_INVALID')
      }
    }
  }

  private handleAccept(
    accept: Extract<FolderControlMessage, { type: 'folder:accept' }>['payload'],
  ): void {
    const transfer = this.outgoing.get(accept.transferId)
    if (transfer === undefined || transfer.task.status !== 'awaitingAcceptance') return
    this.clearTimeout(transfer)
    transfer.uploadKey = accept.uploadKey
    transfer.task = this.updateStatus(transfer.task, 'accepted')
    this.emitTask(transfer.task)
  }

  private handleReject(transferId: TransferId): void {
    const transfer = this.outgoing.get(transferId)
    if (transfer === undefined || transfer.task.status !== 'awaitingAcceptance') return
    this.clearTimeout(transfer)
    transfer.task = this.updateStatus(transfer.task, 'rejected', 'FILE_REJECTED')
    this.emitTask(transfer.task)
  }

  private failActiveTransfers(errorCode: 'CONNECTION_CLOSED' | 'TRANSFER_CANCELLED'): void {
    for (const transfer of this.outgoing.values()) {
      if (!['completed', 'failed', 'cancelled', 'rejected'].includes(transfer.task.status)) {
        this.failOutgoing(transfer, errorCode)
      }
    }
    for (const transfer of this.incoming.values()) {
      if (
        transfer.task !== undefined &&
        !['completed', 'failed', 'cancelled', 'rejected'].includes(transfer.task.status)
      ) {
        this.failIncoming(transfer, errorCode)
      }
    }
  }

  private failOutgoing(
    transfer: OutgoingFolderTransfer,
    errorCode: 'CONNECTION_CLOSED' | 'TRANSFER_TIMEOUT' | 'TRANSFER_CANCELLED',
  ): void {
    this.clearTimeout(transfer)
    transfer.task = this.updateStatus(
      transfer.task,
      errorCode === 'TRANSFER_CANCELLED' ? 'cancelled' : 'failed',
      errorCode,
    )
    this.emitTask(transfer.task)
  }

  private failIncoming(
    transfer: IncomingFolderTransfer,
    errorCode: 'PROTOCOL_INVALID' | 'CONNECTION_CLOSED' | 'TRANSFER_TIMEOUT' | 'TRANSFER_CANCELLED',
  ): void {
    this.clearTimeout(transfer)
    if (transfer.task !== undefined) {
      transfer.task = this.updateStatus(
        transfer.task,
        errorCode === 'TRANSFER_CANCELLED' ? 'cancelled' : 'failed',
        errorCode,
      )
      this.emitTask(transfer.task)
    }
    this.incoming.delete(transfer.offer.transferId)
  }

  private updateStatus(
    task: TransferTaskDto,
    status: TransferTaskDto['status'],
    errorCode?: TransferTaskDto['errorCode'],
  ): TransferTaskDto {
    return {
      ...task,
      status,
      updatedAt: Date.now(),
      ...(errorCode === undefined ? {} : { errorCode }),
    }
  }

  private toOfferDto(task: TransferTaskDto): FolderOfferReceivedDto {
    return {
      transferId: task.transferId,
      peer: task.peer,
      displayName: task.folder?.displayName ?? '文件夹',
      fileCount: task.folder?.fileCount ?? 0,
      emptyDirectoryCount: task.folder?.emptyDirectoryCount ?? 0,
      totalSize: task.totalBytes,
      receivedAt: task.createdAt,
    }
  }

  private emitTask(task: TransferTaskDto): void {
    for (const listener of this.taskListeners) listener(task)
  }

  private createTimeout(onTimeout: () => void): ReturnType<typeof setTimeout> {
    const timeout = setTimeout(onTimeout, FOLDER_TRANSFER_TIMEOUT_MS)
    timeout.unref()
    return timeout
  }

  private clearTimeout(transfer: { timeout?: ReturnType<typeof setTimeout> }): void {
    if (transfer.timeout !== undefined) clearTimeout(transfer.timeout)
    delete transfer.timeout
  }
}

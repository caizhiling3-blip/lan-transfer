import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { link, lstat, mkdir, open, rm, unlink } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { request as createHttpRequest } from 'node:http'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'

import {
  FOLDER_TRANSFER_TIMEOUT_MS,
  MAX_FOLDER_MANIFEST_BYTES,
  MAX_FOLDER_MANIFEST_CHUNK_BYTES,
  MAX_FOLDER_MANIFEST_CHUNKS,
  TRANSFER_IDLE_TIMEOUT_MS,
  TRANSFER_PROGRESS_MESSAGE_INTERVAL_MS,
  TRANSFER_PROGRESS_UPDATE_INTERVAL_MS,
} from '@shared/constants'
import type { ErrorCode } from '@shared/errors'
import type { FolderOfferReceivedDto } from '@shared/ipc'
import { fileIdSchema, manifestIdSchema, transferIdSchema } from '@shared/types'
import type {
  ConnectionId,
  DeviceInfo,
  FileId,
  FolderManifestContents,
  HistoryEntryDto,
  ManifestId,
  TransferId,
  TransferStatus,
  TransferTaskDto,
} from '@shared/types'
import { createPortablePathCollisionKey, parsePortableRelativePath } from '@shared/utils'

import { assertSafeReceiveDirectory, assertSufficientDiskSpace } from '../security'
import type { SessionHistory } from '../storage'
import type { ConnectionManager, FolderControlMessage } from '../websocket'
import type { AuthorizedSourceFolder } from './file-access-registry'
import type { AuthorizedFolderFile } from './folder-scanner'
import { mapFileError } from './file-system'
import { publishFolderStaging } from './folder-publish'
import { rebuildTask, updateAllNonTerminalFiles, updateFile } from './task-state'

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
  tokenExpiresAt?: number
  activeFileId?: FileId
  abortUpload?: () => void
  queuePromise?: Promise<void>
  readonly remoteProgress: Map<FileId, number>
  remoteFolderComplete: boolean
  timeout?: ReturnType<typeof setTimeout>
}

interface IncomingFolderFile {
  readonly manifest: FolderManifestContents['files'][number]
  tokenUsed: boolean
  temporaryPath?: string
  abortUpload?: () => void
  uploadPromise?: Promise<void>
  failureOverride?: ErrorCode
}

interface IncomingFolderTransfer {
  task?: TransferTaskDto
  readonly peer: DeviceInfo
  readonly connectionId: ConnectionId
  readonly offer: Extract<FolderControlMessage, { type: 'folder:offer' }>['payload']
  readonly chunks: Map<number, ManifestChunk>
  readonly files: Map<FileId, IncomingFolderFile>
  manifest?: FolderManifestContents
  receiveDirectory?: string
  stagingRoot?: string
  uploadKey?: string
  tokenExpiresAt?: number
  activeFileId?: FileId
  publishedPath?: string
  publishPromise?: Promise<void>
  timeout?: ReturnType<typeof setTimeout>
}

type UploadOutcome = 'completed' | 'cancelled' | 'failed'

const FOLDER_UPLOAD_ROUTE = /^\/v2\/folder-transfers\/([^/]+)\/files\/([^/?]+)$/u
const TERMINAL_TASK_STATUSES: readonly TransferStatus[] = [
  'completed',
  'failed',
  'cancelled',
  'rejected',
]

const hashManifest = (manifest: FolderManifestContents): string =>
  createHash('sha256').update(JSON.stringify(manifest)).digest('hex')

const deriveUploadToken = (uploadKey: string, transferId: TransferId, fileId: FileId): string =>
  createHmac('sha256', uploadKey).update(`${transferId}:${fileId}`).digest('base64url')

const tokensMatch = (actual: string, expected: string): boolean => {
  const actualBytes = Buffer.from(actual)
  const expectedBytes = Buffer.from(expected)
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes)
}

const normalizeRemoteAddress = (address: string | undefined): string => {
  if (address === undefined) return ''
  return address.startsWith('::ffff:') ? address.slice(7) : address
}

const isWithinDirectory = (root: string, candidate: string): boolean => {
  const relativePath = relative(root, candidate)
  return (
    relativePath === '' ||
    (!isAbsolute(relativePath) && relativePath !== '..' && !relativePath.startsWith(`..${sep}`))
  )
}

const resolveManifestPath = (stagingRoot: string, portablePath: string): string => {
  const candidate = resolve(stagingRoot, ...parsePortableRelativePath(portablePath))
  if (!isWithinDirectory(stagingRoot, candidate)) throw new Error('FOLDER_PATH_INVALID')
  return candidate
}

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
  includeFiles = true,
): TransferTaskDto => {
  const now = Date.now()
  return {
    transferId,
    direction,
    kind: 'folder',
    peer,
    status: 'awaitingAcceptance',
    files: includeFiles
      ? manifest.files.map((file) => ({
          fileId: file.fileId,
          displayName: file.relativePath,
          size: file.size,
          mimeType: file.mimeType,
          transferredBytes: 0,
          bytesPerSecond: 0,
          status: 'pending' as const,
        }))
      : [],
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
  private readonly recordedTransfers = new Set<TransferId>()
  private readonly unsubscribeMessages: () => void
  private readonly unsubscribeConnection: () => void

  public constructor(
    private readonly connectionManager: ConnectionManager,
    private readonly fileAccess: FolderAccessAdapter,
    private readonly canStartTransfer: () => boolean = () => true,
    private readonly history?: SessionHistory,
  ) {
    this.unsubscribeMessages = connectionManager.subscribeFolderMessages((message) =>
      this.handleMessage(message),
    )
    this.unsubscribeConnection = connectionManager.subscribeStatus((status) => {
      if (status.state === 'disconnected') {
        void this.failActiveTransfers('CONNECTION_CLOSED')
      }
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
    return this.getTasks().some((task) => !TERMINAL_TASK_STATUSES.includes(task.status))
  }

  public getReceivedFolderPath(transferId: TransferId): string | null {
    const transfer = this.incoming.get(transferId)
    return transfer?.task?.status === 'completed' ? (transfer.publishedPath ?? null) : null
  }

  public async offerFolder(selectionToken: string): Promise<TransferTaskDto | null> {
    const hasActiveOutgoing = [...this.outgoing.values()].some(
      ({ task }) => !TERMINAL_TASK_STATUSES.includes(task.status),
    )
    if (hasActiveOutgoing || !this.canStartTransfer()) return null
    const source = this.fileAccess.consumeFolder(selectionToken)
    if (source === null) return null
    return this.createAndSendOffer(source)
  }

  public offerAuthorizedFolder(source: AuthorizedSourceFolder): Promise<TransferTaskDto | null> {
    return this.createAndSendOffer(source)
  }

  public async retry(transferId: TransferId): Promise<TransferTaskDto | null> {
    const previous = this.outgoing.get(transferId)
    if (
      previous === undefined ||
      !['failed', 'cancelled', 'rejected'].includes(previous.task.status)
    ) {
      return null
    }
    const manifestFiles = previous.source.manifest.files.map((file) => ({
      ...file,
      fileId: fileIdSchema.parse(randomUUID()),
    }))
    const fileByPreviousId = new Map(
      previous.source.files.map((file) => [file.manifest.fileId, file]),
    )
    const source: AuthorizedSourceFolder = {
      ...previous.source,
      selection: {
        ...previous.source.selection,
        selectionToken: `retry-${randomUUID()}`,
      },
      manifest: {
        ...previous.source.manifest,
        files: manifestFiles,
      },
      files: previous.source.manifest.files.map((previousManifest, index) => {
        const previousFile = fileByPreviousId.get(previousManifest.fileId)
        const manifest = manifestFiles[index]
        if (previousFile === undefined || manifest === undefined) {
          throw new Error('FILE_NOT_FOUND')
        }
        return { ...previousFile, manifest }
      }),
    }
    return this.createAndSendOffer(source)
  }

  private async createAndSendOffer(
    source: AuthorizedSourceFolder,
  ): Promise<TransferTaskDto | null> {
    const hasActiveOutgoing = [...this.outgoing.values()].some(
      ({ task }) => !TERMINAL_TASK_STATUSES.includes(task.status),
    )
    if (hasActiveOutgoing || !this.canStartTransfer()) return null
    const peer = this.connectionManager.getPeer()
    if (peer === null) return null
    const transferId = transferIdSchema.parse(randomUUID())
    const manifestId = manifestIdSchema.parse(randomUUID())
    const manifestSha256 = hashManifest(source.manifest)
    const chunks = buildManifestChunks(source.manifest)
    const transfer: OutgoingFolderTransfer = {
      task: createFolderTask(transferId, 'send', peer, source.manifest),
      source,
      manifestId,
      manifestSha256,
      chunks,
      remoteProgress: new Map(),
      remoteFolderComplete: false,
    }
    this.outgoing.set(transferId, transfer)
    transfer.timeout = this.createTimeout(() => {
      void this.failOutgoing(transfer, 'TRANSFER_TIMEOUT', true)
    })
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
      await this.failOutgoing(transfer, 'CONNECTION_CLOSED')
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
        await this.failOutgoing(transfer, 'CONNECTION_CLOSED')
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
    if (decision === 'reject') {
      this.clearTimeout(transfer)
      await this.connectionManager.sendFolderReject({ transferId, reason: 'user_rejected' })
      transfer.task = updateAllNonTerminalFiles(
        transfer.task,
        'rejected',
        'rejected',
        'FILE_REJECTED',
      )
      this.emitTask(transfer.task)
      this.recordHistory(transfer.task)
      return transfer.task
    }

    try {
      transfer.receiveDirectory = await this.fileAccess.resolveReceiveDirectory(directoryToken)
      const safeDirectory = await assertSafeReceiveDirectory(transfer.receiveDirectory)
      await assertSufficientDiskSpace(safeDirectory, transfer.manifest.totalSize)
      transfer.stagingRoot = resolve(
        safeDirectory,
        `.lindu-folder-${transfer.task.transferId}.part`,
      )
      if (!isWithinDirectory(safeDirectory, transfer.stagingRoot)) {
        throw new Error('SAVE_DIRECTORY_INVALID')
      }
      await mkdir(transfer.stagingRoot, { mode: 0o700 })
      await this.createManifestDirectories(transfer)
      transfer.uploadKey = randomBytes(32).toString('base64url')
      transfer.tokenExpiresAt = Date.now() + FOLDER_TRANSFER_TIMEOUT_MS
      const detailedTask = createFolderTask(
        transfer.offer.transferId,
        'receive',
        transfer.peer,
        transfer.manifest,
      )
      transfer.task = rebuildTask(transfer.task, detailedTask.files, 'accepted')
      if (
        !(await this.connectionManager.sendFolderAccept({
          transferId,
          uploadKey: transfer.uploadKey,
          expiresAt: transfer.tokenExpiresAt,
        }))
      ) {
        throw new Error('CONNECTION_CLOSED')
      }
      this.emitTask(transfer.task)
      if (transfer.task.files.length === 0) await this.finishIncomingContent(transfer)
    } catch (error) {
      const errorCode = mapFileError(error)
      await this.failIncoming(transfer, errorCode, true)
    }
    return transfer.task
  }

  public async cancel(transferId: TransferId): Promise<TransferTaskDto | null> {
    const outgoing = this.outgoing.get(transferId)
    if (outgoing !== undefined) {
      if (TERMINAL_TASK_STATUSES.includes(outgoing.task.status)) return outgoing.task
      await this.connectionManager.sendFolderCancel({
        transferId,
        reason: 'user_cancelled',
      })
      await this.failOutgoing(outgoing, 'TRANSFER_CANCELLED')
      return outgoing.task
    }
    const incoming = this.incoming.get(transferId)
    if (incoming?.task === undefined || TERMINAL_TASK_STATUSES.includes(incoming.task.status)) {
      return null
    }
    if (incoming.publishPromise !== undefined) {
      await incoming.publishPromise.catch(() => undefined)
      return incoming.task
    }
    await this.connectionManager.sendFolderCancel({
      transferId,
      reason: 'user_cancelled',
    })
    await this.failIncoming(incoming, 'TRANSFER_CANCELLED')
    return incoming.task
  }

  public handleHttpRequest(request: IncomingMessage, response: ServerResponse): boolean {
    const match = FOLDER_UPLOAD_ROUTE.exec(request.url ?? '')
    if (match === null) return false
    const transferId = transferIdSchema.safeParse(match[1])
    const fileId = fileIdSchema.safeParse(match[2])
    if (!transferId.success || !fileId.success || request.method !== 'POST') {
      this.writeResponse(response, 400)
      return true
    }
    const transfer = this.incoming.get(transferId.data)
    const file = transfer?.files.get(fileId.data)
    const expectedFile = transfer?.task?.files.find((candidate) =>
      ['pending', 'transferring'].includes(candidate.status),
    )
    const authorization = request.headers.authorization
    const contentLength = Number(request.headers['content-length'])
    const connectionStatus = this.connectionManager.getStatus()
    const expectedToken =
      transfer?.uploadKey === undefined
        ? null
        : deriveUploadToken(transfer.uploadKey, transferId.data, fileId.data)
    if (file?.tokenUsed === true) {
      this.writeResponse(response, 409)
      return true
    }
    if (
      transfer === undefined ||
      transfer.task === undefined ||
      file === undefined ||
      expectedFile?.fileId !== fileId.data ||
      !['accepted', 'transferring'].includes(transfer.task.status) ||
      expectedToken === null ||
      typeof authorization !== 'string' ||
      !authorization.startsWith('Bearer ') ||
      !tokensMatch(authorization.slice(7), expectedToken) ||
      transfer.tokenExpiresAt === undefined ||
      transfer.tokenExpiresAt < Date.now() ||
      !Number.isSafeInteger(contentLength) ||
      contentLength !== file.manifest.size ||
      normalizeRemoteAddress(request.socket.remoteAddress) !== transfer.peer.ipAddress ||
      connectionStatus.state !== 'connected' ||
      connectionStatus.connectionId !== transfer.connectionId ||
      request.headers['transfer-encoding'] !== undefined ||
      request.headers['content-type'] !== 'application/octet-stream'
    ) {
      this.writeResponse(response, 403)
      return true
    }
    file.tokenUsed = true
    transfer.activeFileId = fileId.data
    request.setTimeout(TRANSFER_IDLE_TIMEOUT_MS, () => {
      file.failureOverride = 'TRANSFER_TIMEOUT'
      request.destroy(new Error('TRANSFER_TIMEOUT'))
    })
    file.abortUpload = () => request.destroy(new Error('Transfer interrupted'))
    const uploadPromise = this.receiveUpload(transfer, file, request, response)
    file.uploadPromise = uploadPromise
    void uploadPromise.finally(() => {
      delete file.abortUpload
      delete file.uploadPromise
      delete transfer.activeFileId
    })
    return true
  }

  public async shutdown(): Promise<void> {
    this.unsubscribeMessages()
    this.unsubscribeConnection()
    await this.failActiveTransfers('TRANSFER_CANCELLED')
  }

  private handleMessage(message: FolderControlMessage): void {
    if (message.type === 'folder:offer') this.handleOffer(message.payload)
    else if (message.type === 'folder:manifest') this.handleManifest(message.payload)
    else if (message.type === 'folder:accept') this.handleAccept(message.payload)
    else if (message.type === 'folder:reject') this.handleReject(message.payload.transferId)
    else if (message.type === 'folder:progress') this.handleProgress(message.payload)
    else if (message.type === 'folder:complete') this.handleComplete(message.payload)
    else if (message.type === 'folder:error') {
      const outgoing = this.outgoing.get(message.payload.transferId)
      const incoming = this.incoming.get(message.payload.transferId)
      if (outgoing !== undefined) void this.failOutgoing(outgoing, message.payload.errorCode)
      if (incoming !== undefined) void this.failIncoming(incoming, message.payload.errorCode)
    } else if (message.type === 'folder:cancel') {
      const outgoing = this.outgoing.get(message.payload.transferId)
      const incoming = this.incoming.get(message.payload.transferId)
      if (outgoing !== undefined) void this.failOutgoing(outgoing, 'TRANSFER_CANCELLED')
      if (incoming !== undefined) void this.failIncoming(incoming, 'TRANSFER_CANCELLED')
    }
  }

  private handleOffer(
    offer: Extract<FolderControlMessage, { type: 'folder:offer' }>['payload'],
  ): void {
    const peer = this.connectionManager.getPeer()
    const connectionId = this.connectionManager.getStatus().connectionId
    const hasActiveIncoming = [...this.incoming.values()].some(
      ({ task }) => task === undefined || !TERMINAL_TASK_STATUSES.includes(task.status),
    )
    if (
      peer === null ||
      connectionId === undefined ||
      hasActiveIncoming ||
      !this.canStartTransfer() ||
      this.incoming.has(offer.transferId) ||
      this.outgoing.has(offer.transferId)
    ) {
      return
    }
    const transfer: IncomingFolderTransfer = {
      peer,
      connectionId,
      offer,
      chunks: new Map(),
      files: new Map(),
    }
    transfer.timeout = this.createTimeout(() => {
      void this.failIncoming(transfer, 'TRANSFER_TIMEOUT', true)
    })
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
      if (transfer !== undefined) void this.failIncoming(transfer, 'PROTOCOL_INVALID', true)
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
      for (const file of manifest.files) {
        transfer.files.set(file.fileId, { manifest: file, tokenUsed: false })
      }
      transfer.task = createFolderTask(
        transfer.offer.transferId,
        'receive',
        transfer.peer,
        manifest,
        false,
      )
      this.emitTask(transfer.task)
      for (const listener of this.offerListeners) listener(this.toOfferDto(transfer.task))
    } catch {
      void this.failIncoming(transfer, 'PROTOCOL_INVALID', true)
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
      const key = createPortablePathCollisionKey(parsePortableRelativePath(file.relativePath))
      if (pathKeys.has(key)) throw new Error('PROTOCOL_INVALID')
      pathKeys.add(key)
      terminalPathKeys.add(key)
    }
    for (const directory of manifest.emptyDirectories) {
      const key = createPortablePathCollisionKey(parsePortableRelativePath(directory))
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
        if (terminalPathKeys.has(createPortablePathCollisionKey(segments.slice(0, depth)))) {
          throw new Error('PROTOCOL_INVALID')
        }
      }
    }
  }

  private handleAccept(
    accept: Extract<FolderControlMessage, { type: 'folder:accept' }>['payload'],
  ): void {
    const transfer = this.outgoing.get(accept.transferId)
    if (transfer === undefined) return
    if (transfer.task.status !== 'awaitingAcceptance' || accept.expiresAt <= Date.now()) {
      void this.failOutgoing(transfer, 'PROTOCOL_INVALID', true)
      return
    }
    transfer.uploadKey = accept.uploadKey
    transfer.tokenExpiresAt = accept.expiresAt
    transfer.task = rebuildTask(transfer.task, transfer.task.files, 'accepted')
    this.emitTask(transfer.task)
    const queuePromise = this.runOutgoingQueue(transfer)
    transfer.queuePromise = queuePromise
    void queuePromise.finally(() => delete transfer.queuePromise)
  }

  private handleReject(transferId: TransferId): void {
    const transfer = this.outgoing.get(transferId)
    if (transfer === undefined || transfer.task.status !== 'awaitingAcceptance') return
    this.clearTimeout(transfer)
    transfer.task = updateAllNonTerminalFiles(
      transfer.task,
      'rejected',
      'rejected',
      'FILE_REJECTED',
    )
    this.emitTask(transfer.task)
    this.recordHistory(transfer.task)
  }

  private handleProgress(
    progress: Extract<FolderControlMessage, { type: 'folder:progress' }>['payload'],
  ): void {
    const transfer = this.outgoing.get(progress.transferId)
    const file = transfer?.task.files.find((candidate) => candidate.fileId === progress.fileId)
    const previousRemoteProgress = transfer?.remoteProgress.get(progress.fileId) ?? 0
    const expectedTotalProgress =
      transfer?.task.files
        .filter((candidate) => candidate.status === 'completed')
        .reduce((total, candidate) => total + candidate.size, 0) ?? 0
    if (file?.status === 'completed' && progress.transferredBytes <= file.size) return
    if (
      transfer === undefined ||
      file === undefined ||
      file.status !== 'transferring' ||
      progress.transferredBytes < previousRemoteProgress ||
      progress.transferredBytes > file.size ||
      progress.totalTransferredBytes !== expectedTotalProgress + progress.transferredBytes ||
      progress.totalTransferredBytes > transfer.task.totalBytes
    ) {
      if (transfer !== undefined) void this.failOutgoing(transfer, 'PROTOCOL_INVALID', true)
      return
    }
    transfer.remoteProgress.set(progress.fileId, progress.transferredBytes)
    transfer.task = updateFile(
      transfer.task,
      file.fileId,
      'transferring',
      Math.max(file.transferredBytes, progress.transferredBytes),
      file.bytesPerSecond,
      'transferring',
    )
    this.emitTask(transfer.task)
  }

  private handleComplete(
    complete: Extract<FolderControlMessage, { type: 'folder:complete' }>['payload'],
  ): void {
    const transfer = this.outgoing.get(complete.transferId)
    if (transfer === undefined) return
    if (complete.scope === 'file') {
      const file = transfer.task.files.find((candidate) => candidate.fileId === complete.fileId)
      if (file === undefined || complete.size !== file.size) {
        void this.failOutgoing(transfer, 'PROTOCOL_INVALID', true)
        return
      }
      this.completeOutgoingFile(transfer, file.fileId)
      return
    }
    if (transfer.task.files.some((file) => file.status !== 'completed')) {
      void this.failOutgoing(transfer, 'PROTOCOL_INVALID', true)
      return
    }
    transfer.remoteFolderComplete = true
    this.completeOutgoingFolder(transfer)
  }

  private async runOutgoingQueue(transfer: OutgoingFolderTransfer): Promise<void> {
    const uploadKey = transfer.uploadKey
    if (uploadKey === undefined) {
      await this.failOutgoing(transfer, 'PROTOCOL_INVALID', true)
      return
    }
    for (const source of transfer.source.files) {
      if (TERMINAL_TASK_STATUSES.includes(transfer.task.status)) break
      const outcome = await this.uploadFile(transfer, source, uploadKey)
      if (outcome !== 'completed') break
    }
    if (
      transfer.task.status !== 'completed' &&
      transfer.task.files.every((file) => file.status === 'completed')
    ) {
      transfer.task = rebuildTask(transfer.task, transfer.task.files, 'publishing')
      this.emitTask(transfer.task)
      if (transfer.remoteFolderComplete) this.completeOutgoingFolder(transfer)
    }
  }

  private async uploadFile(
    transfer: OutgoingFolderTransfer,
    sourceFile: AuthorizedFolderFile,
    uploadKey: string,
  ): Promise<UploadOutcome> {
    const fileId = sourceFile.manifest.fileId
    const startedAt = Date.now()
    transfer.activeFileId = fileId
    transfer.task = updateFile(transfer.task, fileId, 'transferring', 0, 0, 'transferring')
    this.emitTask(transfer.task)
    let sourceHandle: Awaited<ReturnType<typeof open>> | null = null
    try {
      if (transfer.tokenExpiresAt === undefined || transfer.tokenExpiresAt <= Date.now()) {
        throw new Error('TRANSFER_TIMEOUT')
      }
      const pathMetadata = await lstat(sourceFile.path)
      if (!pathMetadata.isFile() || pathMetadata.isSymbolicLink()) {
        throw new Error('FILE_NOT_FOUND')
      }
      sourceHandle = await open(sourceFile.path, 'r')
      const sourceMetadata = await sourceHandle.stat()
      if (
        !sourceMetadata.isFile() ||
        sourceMetadata.dev !== pathMetadata.dev ||
        sourceMetadata.ino !== pathMetadata.ino ||
        sourceMetadata.dev !== sourceFile.identity.device ||
        sourceMetadata.ino !== sourceFile.identity.inode ||
        sourceMetadata.mtimeMs !== sourceFile.identity.modifiedAt ||
        sourceMetadata.size !== sourceFile.manifest.size
      ) {
        throw new Error('FILE_NOT_FOUND')
      }
      const activeSourceHandle = sourceHandle
      await new Promise<void>((resolveResponse, rejectResponse) => {
        let uploadedBytes = 0
        let lastUpdateAt = 0
        const uploadRequest = createHttpRequest(
          {
            host: transfer.task.peer.ipAddress,
            port: transfer.task.peer.servicePort,
            path: `/v2/folder-transfers/${transfer.task.transferId}/files/${fileId}`,
            method: 'POST',
            headers: {
              Authorization: `Bearer ${deriveUploadToken(
                uploadKey,
                transfer.task.transferId,
                fileId,
              )}`,
              'Content-Length': sourceFile.manifest.size,
              'Content-Type': 'application/octet-stream',
            },
          },
          (response) => {
            response.resume()
            response.once('end', () => {
              if (response.statusCode === 200) resolveResponse()
              else rejectResponse(new Error('TRANSFER_FAILED'))
            })
          },
        )
        transfer.abortUpload = () => uploadRequest.destroy(new Error('TRANSFER_CANCELLED'))
        uploadRequest.setTimeout(TRANSFER_IDLE_TIMEOUT_MS, () => {
          uploadRequest.destroy(new Error('TRANSFER_TIMEOUT'))
        })
        uploadRequest.once('error', rejectResponse)
        const source = activeSourceHandle.createReadStream()
        source.on('data', (chunk) => {
          uploadedBytes += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.byteLength
          const current = transfer.task.files.find((file) => file.fileId === fileId)
          if (current === undefined) return
          const transferred = Math.min(uploadedBytes, current.size)
          const elapsedSeconds = Math.max((Date.now() - startedAt) / 1_000, 0.001)
          transfer.task = updateFile(
            transfer.task,
            fileId,
            'transferring',
            transferred,
            Math.round(transferred / elapsedSeconds),
            'transferring',
          )
          if (Date.now() - lastUpdateAt >= TRANSFER_PROGRESS_UPDATE_INTERVAL_MS) {
            lastUpdateAt = Date.now()
            this.emitTask(transfer.task)
          }
        })
        void pipeline(source, uploadRequest).catch(rejectResponse)
      })
      this.completeOutgoingFile(transfer, fileId)
      return 'completed'
    } catch (error) {
      if (transfer.task.status === 'cancelled') return 'cancelled'
      const errorCode = mapFileError(error)
      await this.failOutgoing(transfer, errorCode)
      await this.connectionManager.sendFolderError({
        transferId: transfer.task.transferId,
        fileId,
        errorCode,
      })
      return 'failed'
    } finally {
      await sourceHandle?.close().catch(() => undefined)
      delete transfer.activeFileId
      delete transfer.abortUpload
    }
  }

  private async receiveUpload(
    transfer: IncomingFolderTransfer,
    file: IncomingFolderFile,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (transfer.task === undefined || transfer.stagingRoot === undefined) {
      this.writeResponse(response, 403)
      return
    }
    const fileId = file.manifest.fileId
    const startedAt = Date.now()
    const temporaryPath = resolve(transfer.stagingRoot, `.lindu-file-${randomUUID()}.part`)
    file.temporaryPath = temporaryPath
    transfer.task = updateFile(transfer.task, fileId, 'transferring', 0, 0, 'transferring')
    this.emitTask(transfer.task)
    try {
      const targetPath = resolveManifestPath(transfer.stagingRoot, file.manifest.relativePath)
      await mkdir(dirname(targetPath), { recursive: true, mode: 0o700 })
      const output = createWriteStream(temporaryPath, { flags: 'wx', mode: 0o600 })
      let receivedBytes = 0
      let lastUpdateAt = 0
      let lastProgressMessageAt = 0
      request.on('data', (chunk: Buffer) => {
        receivedBytes += chunk.byteLength
        if (receivedBytes > file.manifest.size) {
          file.failureOverride = 'PROTOCOL_INVALID'
          request.destroy(new Error('PROTOCOL_INVALID'))
          return
        }
        if (transfer.task === undefined) return
        const elapsedSeconds = Math.max((Date.now() - startedAt) / 1_000, 0.001)
        transfer.task = updateFile(
          transfer.task,
          fileId,
          'transferring',
          receivedBytes,
          Math.round(receivedBytes / elapsedSeconds),
          'transferring',
        )
        const now = Date.now()
        if (now - lastUpdateAt >= TRANSFER_PROGRESS_UPDATE_INTERVAL_MS) {
          lastUpdateAt = now
          this.emitTask(transfer.task)
        }
        if (now - lastProgressMessageAt >= TRANSFER_PROGRESS_MESSAGE_INTERVAL_MS) {
          lastProgressMessageAt = now
          void this.connectionManager.sendFolderProgress({
            transferId: transfer.offer.transferId,
            fileId,
            transferredBytes: receivedBytes,
            totalTransferredBytes: transfer.task.transferredBytes,
          })
        }
      })
      await pipeline(request, output)
      if (receivedBytes !== file.manifest.size) throw new Error('TRANSFER_FAILED')
      await link(temporaryPath, targetPath)
      await unlink(temporaryPath)
      delete file.temporaryPath
      transfer.task = updateFile(
        transfer.task,
        fileId,
        'completed',
        receivedBytes,
        0,
        transfer.task.files.every((item) => item.fileId === fileId || item.status === 'completed')
          ? 'publishing'
          : 'transferring',
      )
      this.emitTask(transfer.task)
      await this.connectionManager.sendFolderComplete({
        scope: 'file',
        transferId: transfer.offer.transferId,
        fileId,
        size: receivedBytes,
      })
      this.writeResponse(response, 200)
      if (transfer.task.files.every((item) => item.status === 'completed')) {
        await this.finishIncomingContent(transfer)
      }
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined)
      delete file.temporaryPath
      const errorCode = file.failureOverride ?? mapFileError(error)
      if (errorCode === 'TRANSFER_CANCELLED') {
        await this.failIncoming(transfer, 'TRANSFER_CANCELLED')
        this.writeResponse(response, 409)
      } else {
        await this.failIncoming(transfer, errorCode)
        this.writeResponse(response, 500)
        await this.connectionManager.sendFolderError({
          transferId: transfer.offer.transferId,
          fileId,
          errorCode,
        })
      }
      delete file.failureOverride
    }
  }

  private async createManifestDirectories(transfer: IncomingFolderTransfer): Promise<void> {
    if (transfer.manifest === undefined || transfer.stagingRoot === undefined) {
      throw new Error('PROTOCOL_INVALID')
    }
    for (const directory of transfer.manifest.emptyDirectories) {
      await mkdir(resolveManifestPath(transfer.stagingRoot, directory), {
        recursive: true,
        mode: 0o700,
      })
    }
    for (const file of transfer.manifest.files) {
      await mkdir(dirname(resolveManifestPath(transfer.stagingRoot, file.relativePath)), {
        recursive: true,
        mode: 0o700,
      })
    }
  }

  private async finishIncomingContent(transfer: IncomingFolderTransfer): Promise<void> {
    if (
      transfer.task === undefined ||
      transfer.stagingRoot === undefined ||
      transfer.receiveDirectory === undefined
    ) {
      return
    }
    if (transfer.publishPromise !== undefined) return transfer.publishPromise
    const publishPromise = this.publishIncomingContent(transfer)
    transfer.publishPromise = publishPromise
    await publishPromise.finally(() => delete transfer.publishPromise)
  }

  private async publishIncomingContent(transfer: IncomingFolderTransfer): Promise<void> {
    if (
      transfer.task === undefined ||
      transfer.stagingRoot === undefined ||
      transfer.receiveDirectory === undefined
    ) {
      return
    }
    this.clearTimeout(transfer)
    transfer.task = rebuildTask(transfer.task, transfer.task.files, 'publishing')
    this.emitTask(transfer.task)
    try {
      transfer.publishedPath = await publishFolderStaging(
        transfer.stagingRoot,
        transfer.receiveDirectory,
        transfer.manifest?.displayName ?? '文件夹',
        transfer.offer.transferId,
      )
      delete transfer.stagingRoot
      transfer.task = rebuildTask(transfer.task, transfer.task.files, 'completed')
      this.emitTask(transfer.task)
      this.recordHistory(transfer.task)
      await this.connectionManager.sendFolderComplete({
        scope: 'folder',
        transferId: transfer.offer.transferId,
      })
    } catch {
      transfer.task = updateAllNonTerminalFiles(
        transfer.task,
        'failed',
        'failed',
        'FOLDER_PUBLISH_FAILED',
      )
      this.emitTask(transfer.task)
      this.recordHistory(transfer.task)
      await this.connectionManager.sendFolderError({
        transferId: transfer.offer.transferId,
        errorCode: 'FOLDER_PUBLISH_FAILED',
      })
    }
  }

  private completeOutgoingFile(transfer: OutgoingFolderTransfer, fileId: FileId): void {
    const file = transfer.task.files.find((candidate) => candidate.fileId === fileId)
    if (file === undefined || file.status === 'completed') return
    transfer.task = updateFile(transfer.task, fileId, 'completed', file.size, 0, 'transferring')
    this.emitTask(transfer.task)
  }

  private completeOutgoingFolder(transfer: OutgoingFolderTransfer): void {
    if (transfer.task.status === 'completed') return
    this.clearTimeout(transfer)
    transfer.task = rebuildTask(transfer.task, transfer.task.files, 'completed')
    this.emitTask(transfer.task)
    this.recordHistory(transfer.task)
  }

  private async failActiveTransfers(
    errorCode: 'CONNECTION_CLOSED' | 'TRANSFER_CANCELLED',
  ): Promise<void> {
    await Promise.all([
      ...[...this.outgoing.values()]
        .filter(({ task }) => !TERMINAL_TASK_STATUSES.includes(task.status))
        .map((transfer) => this.failOutgoing(transfer, errorCode)),
      ...[...this.incoming.values()]
        .filter(({ task }) => task !== undefined && !TERMINAL_TASK_STATUSES.includes(task.status))
        .map((transfer) => this.failIncoming(transfer, errorCode)),
    ])
  }

  private async failOutgoing(
    transfer: OutgoingFolderTransfer,
    errorCode: ErrorCode,
    notifyPeer = false,
  ): Promise<void> {
    if (TERMINAL_TASK_STATUSES.includes(transfer.task.status)) return
    this.clearTimeout(transfer)
    transfer.abortUpload?.()
    transfer.task = updateAllNonTerminalFiles(
      transfer.task,
      errorCode === 'TRANSFER_CANCELLED' ? 'cancelled' : 'failed',
      errorCode === 'TRANSFER_CANCELLED' ? 'cancelled' : 'failed',
      errorCode,
    )
    this.emitTask(transfer.task)
    this.recordHistory(transfer.task)
    if (notifyPeer) {
      await this.connectionManager.sendFolderError({
        transferId: transfer.task.transferId,
        ...(transfer.activeFileId === undefined ? {} : { fileId: transfer.activeFileId }),
        errorCode,
      })
    }
  }

  private async failIncoming(
    transfer: IncomingFolderTransfer,
    errorCode: ErrorCode,
    notifyPeer = false,
  ): Promise<void> {
    if (transfer.publishPromise !== undefined) {
      await transfer.publishPromise.catch(() => undefined)
      return
    }
    this.clearTimeout(transfer)
    if (transfer.activeFileId !== undefined) {
      const activeFile = transfer.files.get(transfer.activeFileId)
      if (activeFile !== undefined) activeFile.failureOverride = errorCode
      activeFile?.abortUpload?.()
    }
    if (transfer.stagingRoot !== undefined) {
      const removed = await rm(transfer.stagingRoot, { recursive: true, force: true })
        .then(() => true)
        .catch(() => false)
      if (removed) delete transfer.stagingRoot
    }
    if (transfer.task !== undefined && !TERMINAL_TASK_STATUSES.includes(transfer.task.status)) {
      transfer.task = updateAllNonTerminalFiles(
        transfer.task,
        errorCode === 'TRANSFER_CANCELLED' ? 'cancelled' : 'failed',
        errorCode === 'TRANSFER_CANCELLED' ? 'cancelled' : 'failed',
        errorCode,
      )
      this.emitTask(transfer.task)
      this.recordHistory(transfer.task)
    }
    if (notifyPeer) {
      await this.connectionManager.sendFolderError({
        transferId: transfer.offer.transferId,
        ...(transfer.activeFileId === undefined ? {} : { fileId: transfer.activeFileId }),
        errorCode,
      })
    }
    if (transfer.task === undefined) this.incoming.delete(transfer.offer.transferId)
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

  private recordHistory(task: TransferTaskDto): void {
    if (this.history === undefined || this.recordedTransfers.has(task.transferId)) return
    const entry: Omit<HistoryEntryDto, 'id'> = {
      transferId: task.transferId,
      direction: task.direction,
      kind: 'folder',
      peer: task.peer,
      status: task.status,
      displayName: task.folder?.displayName ?? '文件夹',
      size: task.totalBytes,
      createdAt: task.createdAt,
      ...(task.errorCode === undefined ? {} : { errorCode: task.errorCode }),
    }
    this.history.add(entry)
    this.recordedTransfers.add(task.transferId)
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

  private writeResponse(response: ServerResponse, statusCode: number): void {
    if (response.headersSent || response.writableEnded) return
    response.writeHead(statusCode, {
      'Cache-Control': 'no-store',
      Connection: 'close',
      'Content-Length': '0',
      'X-Content-Type-Options': 'nosniff',
    })
    response.end()
  }
}

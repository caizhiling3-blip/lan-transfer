import { randomBytes, randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { lstat, open, unlink } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { request as createHttpRequest } from 'node:http'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'

import {
  MAX_FILES_PER_TRANSFER,
  MAX_IN_MEMORY_TRANSFER_TASKS,
  TRANSFER_IDLE_TIMEOUT_MS,
  TRANSFER_ID_RETENTION_MS,
  TRANSFER_PROGRESS_MESSAGE_INTERVAL_MS,
  TRANSFER_PROGRESS_UPDATE_INTERVAL_MS,
  TRANSFER_TIMEOUT_MS,
} from '@shared/constants'
import type { ErrorCode } from '@shared/errors'
import type { FileOfferReceivedDto } from '@shared/ipc'
import type { FileAcceptMessage } from '@shared/protocols'
import { fileIdSchema, transferIdSchema } from '@shared/types'
import type {
  ConnectionId,
  FileId,
  FileMetadata,
  HistoryEntryDto,
  TransferId,
  TransferStatus,
  TransferTaskDto,
} from '@shared/types'

import type { SessionHistory } from '../storage'
import { assertSafeReceiveDirectory, assertSufficientDiskSpace } from '../security'
import type { ConnectionManager, FileControlMessage } from '../websocket'
import type { AuthorizedSourceFile } from './file-access-registry'
import { mapFileError, publishTemporaryFile } from './file-system'
import {
  calculateFinishedStatus,
  createTask,
  rebuildTask,
  updateAllNonTerminalFiles,
  updateFile,
} from './task-state'

type TaskListener = (task: TransferTaskDto) => void
type OfferListener = (offer: FileOfferReceivedDto) => void

export interface FileAccessAdapter {
  consumeSource(selectionToken: string): AuthorizedSourceFile | null
  resolveReceiveDirectory(directoryToken?: string): Promise<string>
}

interface OutgoingTransfer {
  task: TransferTaskDto
  readonly sources: readonly AuthorizedSourceFile[]
  readonly authorizations: Map<FileId, string>
  readonly remoteProgress: Map<FileId, number>
  readonly cancelledFiles: Set<FileId>
  cancelAll: boolean
  activeFileId?: FileId
  abortUpload?: () => void
  queuePromise?: Promise<void>
  offerTimeout?: ReturnType<typeof setTimeout>
}

interface IncomingFileState {
  readonly metadata: FileMetadata
  uploadToken?: string
  tokenExpiresAt?: number
  tokenUsed: boolean
  temporaryPath?: string
  publishedPath?: string
  abortUpload?: () => void
  uploadPromise?: Promise<void>
  failureOverride?: ErrorCode
}

interface IncomingTransfer {
  task: TransferTaskDto
  readonly files: Map<FileId, IncomingFileState>
  readonly connectionId: ConnectionId
  directoryPath?: string
  cancelAll: boolean
  offerTimeout?: ReturnType<typeof setTimeout>
}

type UploadOutcome = 'completed' | 'cancelled' | 'failed'

const UPLOAD_ROUTE = /^\/v1\/transfers\/([^/]+)\/files\/([^/?]+)$/u
const TERMINAL_TASK_STATUSES: readonly TransferStatus[] = [
  'completed',
  'failed',
  'cancelled',
  'rejected',
]

const normalizeRemoteAddress = (address: string | undefined): string => {
  if (address === undefined) return ''
  return address.startsWith('::ffff:') ? address.slice(7) : address
}

export class FileTransferCoordinator {
  private readonly outgoing = new Map<TransferId, OutgoingTransfer>()
  private readonly incoming = new Map<TransferId, IncomingTransfer>()
  private readonly taskListeners = new Set<TaskListener>()
  private readonly offerListeners = new Set<OfferListener>()
  private readonly recordedTransfers = new Map<TransferId, number>()
  private readonly unsubscribeFromMessages: () => void
  private readonly unsubscribeFromConnection: () => void

  public constructor(
    private readonly connectionManager: ConnectionManager,
    private readonly fileAccess: FileAccessAdapter,
    private readonly history: SessionHistory,
    private readonly getMaximumFileSize: () => number = () => Number.MAX_SAFE_INTEGER,
  ) {
    this.unsubscribeFromMessages = connectionManager.subscribeFileMessages((message) => {
      this.handleControlMessage(message)
    })
    this.unsubscribeFromConnection = connectionManager.subscribeStatus((status) => {
      if (status.state === 'disconnected') void this.failActiveTransfers('CONNECTION_CLOSED')
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
      ...[...this.outgoing.values()].map((transfer) => transfer.task),
      ...[...this.incoming.values()].map((transfer) => transfer.task),
    ]
  }

  public getPendingOffer(): FileOfferReceivedDto | null {
    const transfer = [...this.incoming.values()].find(
      (candidate) => candidate.task.status === 'awaitingAcceptance',
    )
    if (transfer === undefined) return null
    return {
      transferId: transfer.task.transferId,
      peer: transfer.task.peer,
      files: [...transfer.files.values()].map(({ metadata }) => metadata),
      receivedAt: transfer.task.createdAt,
    }
  }

  public hasActiveTransfers(): boolean {
    return this.getTasks().some(
      (task) => task.kind === 'file' && !TERMINAL_TASK_STATUSES.includes(task.status),
    )
  }

  public getReceivedFilePath(transferId: TransferId, fileId?: FileId): string | null {
    const transfer = this.incoming.get(transferId)
    if (transfer === undefined || transfer.task.status !== 'completed') return null
    if (fileId !== undefined) return transfer.files.get(fileId)?.publishedPath ?? null
    return (
      [...transfer.files.values()].find((file) => file.publishedPath !== undefined)
        ?.publishedPath ?? null
    )
  }

  public async offerFiles(selectionTokens: readonly string[]): Promise<TransferTaskDto | null> {
    if (selectionTokens.length === 0 || selectionTokens.length > MAX_FILES_PER_TRANSFER) return null
    const sources = selectionTokens.map((token) => this.fileAccess.consumeSource(token))
    if (sources.some((source) => source === null)) return null
    return this.createAndSendOffer(sources.filter((source) => source !== null))
  }

  public async respondToOffer(
    transferId: TransferId,
    decision: 'accept' | 'reject',
    directoryToken?: string,
  ): Promise<TransferTaskDto | null> {
    const transfer = this.incoming.get(transferId)
    if (transfer === undefined || transfer.task.status !== 'awaitingAcceptance') return null
    this.clearOfferTimeout(transfer)
    if (decision === 'reject') {
      transfer.task = updateAllNonTerminalFiles(
        transfer.task,
        'rejected',
        'rejected',
        'FILE_REJECTED',
      )
      await this.connectionManager.sendFileReject(transferId)
      this.finishTask(transfer.task)
      return transfer.task
    }

    try {
      transfer.directoryPath = await this.fileAccess.resolveReceiveDirectory(directoryToken)
      await assertSufficientDiskSpace(
        transfer.directoryPath,
        transfer.task.files
          .filter((file) => file.status === 'pending')
          .reduce((total, file) => total + file.size, 0),
      )
      const authorizationStartedAt = Date.now()
      let authorizationIndex = 0
      const authorizations: FileAcceptMessage['payload']['files'] = []
      for (const file of transfer.files.values()) {
        const taskFile = transfer.task.files.find((item) => item.fileId === file.metadata.fileId)
        if (taskFile?.status === 'cancelled') continue
        authorizationIndex += 1
        const expiresAt = authorizationStartedAt + TRANSFER_TIMEOUT_MS * authorizationIndex
        file.uploadToken = randomBytes(32).toString('base64url')
        file.tokenExpiresAt = expiresAt
        authorizations.push({
          fileId: file.metadata.fileId,
          uploadToken: file.uploadToken,
          expiresAt,
        })
      }
      transfer.task = rebuildTask(transfer.task, transfer.task.files, 'accepted')
      if (!(await this.connectionManager.sendFileAccept(transferId, authorizations))) {
        transfer.task = updateAllNonTerminalFiles(
          transfer.task,
          'failed',
          'failed',
          'CONNECTION_CLOSED',
        )
      }
    } catch (error) {
      const errorCode = mapFileError(error)
      transfer.task = updateAllNonTerminalFiles(transfer.task, 'failed', 'failed', errorCode)
      const firstFile = transfer.task.files[0]
      if (firstFile !== undefined) {
        await this.connectionManager.sendFileError(transferId, firstFile.fileId, errorCode)
      }
    }
    this.emitTask(transfer.task)
    if (transfer.task.status === 'failed') this.recordHistory(transfer.task)
    return transfer.task
  }

  public async cancel(transferId: TransferId, fileId?: FileId): Promise<TransferTaskDto | null> {
    const outgoing = this.outgoing.get(transferId)
    if (outgoing !== undefined) {
      if (TERMINAL_TASK_STATUSES.includes(outgoing.task.status)) return outgoing.task
      await this.connectionManager.sendFileCancel(transferId, fileId)
      this.cancelOutgoing(outgoing, fileId)
      return outgoing.task
    }
    const incoming = this.incoming.get(transferId)
    if (incoming === undefined || TERMINAL_TASK_STATUSES.includes(incoming.task.status)) return null
    await this.connectionManager.sendFileCancel(transferId, fileId)
    this.cancelIncoming(incoming, fileId)
    return incoming.task
  }

  public async retry(transferId: TransferId): Promise<TransferTaskDto | null> {
    const previous = this.outgoing.get(transferId)
    if (
      previous === undefined ||
      !['failed', 'cancelled', 'rejected'].includes(previous.task.status)
    ) {
      return null
    }
    const sources = previous.sources.map((source): AuthorizedSourceFile => ({
      path: source.path,
      ...(source.identity === undefined ? {} : { identity: source.identity }),
      selection: {
        ...source.selection,
        selectionToken: `retry-${randomUUID()}`,
        fileId: fileIdSchema.parse(randomUUID()),
      },
    }))
    return this.createAndSendOffer(sources)
  }

  public handleHttpRequest(request: IncomingMessage, response: ServerResponse): boolean {
    const match = UPLOAD_ROUTE.exec(request.url ?? '')
    if (match === null) return false
    const parsedTransferId = transferIdSchema.safeParse(match[1])
    const parsedFileId = fileIdSchema.safeParse(match[2])
    if (!parsedTransferId.success || !parsedFileId.success || request.method !== 'POST') {
      this.writeResponse(response, 400)
      return true
    }
    const transfer = this.incoming.get(parsedTransferId.data)
    const file = transfer?.files.get(parsedFileId.data)
    const expectedFile = transfer?.task.files.find((item) => item.status === 'pending')
    const authorization = request.headers.authorization
    const contentLength = Number(request.headers['content-length'])
    const remoteAddress = normalizeRemoteAddress(request.socket.remoteAddress)
    const connectionStatus = this.connectionManager.getStatus()
    if (file?.tokenUsed === true) {
      this.writeResponse(response, 409)
      return true
    }
    if (
      transfer === undefined ||
      file === undefined ||
      expectedFile?.fileId !== parsedFileId.data ||
      !['accepted', 'transferring'].includes(transfer.task.status) ||
      file.uploadToken === undefined ||
      typeof authorization !== 'string' ||
      authorization !== `Bearer ${file.uploadToken}` ||
      file.tokenExpiresAt === undefined ||
      file.tokenExpiresAt < Date.now() ||
      !Number.isSafeInteger(contentLength) ||
      contentLength !== file.metadata.size ||
      remoteAddress !== transfer.task.peer.ipAddress ||
      connectionStatus.state !== 'connected' ||
      connectionStatus.connectionId !== transfer.connectionId ||
      request.headers['transfer-encoding'] !== undefined ||
      request.headers['content-type'] !== 'application/octet-stream'
    ) {
      this.writeResponse(response, 403)
      return true
    }
    file.tokenUsed = true
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
    })
    return true
  }

  public async shutdown(): Promise<void> {
    this.unsubscribeFromMessages()
    this.unsubscribeFromConnection()
    await this.failActiveTransfers('TRANSFER_CANCELLED')
  }

  private async createAndSendOffer(
    sources: readonly AuthorizedSourceFile[],
  ): Promise<TransferTaskDto | null> {
    const peer = this.connectionManager.getPeer()
    const hasActiveOutgoing = [...this.outgoing.values()].some(
      (transfer) => !TERMINAL_TASK_STATUSES.includes(transfer.task.status),
    )
    if (peer === null || sources.length === 0 || sources.length > MAX_FILES_PER_TRANSFER)
      return null
    if (hasActiveOutgoing) return null
    const transferId = transferIdSchema.parse(randomUUID())
    const files = sources.map(({ selection }): FileMetadata => ({
      fileId: selection.fileId,
      displayName: selection.displayName,
      size: selection.size,
      mimeType: selection.mimeType,
    }))
    const transfer: OutgoingTransfer = {
      sources,
      task: createTask(transferId, 'send', peer, files),
      authorizations: new Map(),
      remoteProgress: new Map(),
      cancelledFiles: new Set(),
      cancelAll: false,
    }
    this.outgoing.set(transferId, transfer)
    transfer.offerTimeout = this.createOfferTimeout(() => {
      this.failWholeOutgoing(transfer, 'TRANSFER_TIMEOUT')
      const firstFile = transfer.task.files[0]
      if (firstFile !== undefined) {
        void this.connectionManager.sendFileError(transferId, firstFile.fileId, 'TRANSFER_TIMEOUT')
      }
    })
    if (!(await this.connectionManager.sendFileOffer(transferId, files))) {
      transfer.task = updateAllNonTerminalFiles(
        transfer.task,
        'failed',
        'failed',
        'CONNECTION_CLOSED',
      )
      this.finishTask(transfer.task)
    }
    return transfer.task
  }

  private handleControlMessage(message: FileControlMessage): void {
    if (message.type === 'file:offer') {
      this.handleOffer(message.payload.transferId, message.payload.files)
      return
    }
    const incoming = this.incoming.get(message.payload.transferId)
    if (incoming !== undefined && message.type === 'file:error') {
      this.failIncomingFile(incoming, message.payload.fileId, message.payload.errorCode)
      return
    }
    if (incoming !== undefined && message.type === 'file:cancel') {
      this.cancelIncoming(incoming, message.payload.fileId)
      return
    }

    const outgoing = this.outgoing.get(message.payload.transferId)
    if (outgoing === undefined) return
    if (message.type === 'file:accept') {
      this.handleAccept(outgoing, message.payload.files)
    } else if (message.type === 'file:reject') {
      outgoing.task = updateAllNonTerminalFiles(
        outgoing.task,
        'rejected',
        'rejected',
        'FILE_REJECTED',
      )
      this.finishTask(outgoing.task)
    } else if (message.type === 'file:progress') {
      const current = outgoing.task.files.find((file) => file.fileId === message.payload.fileId)
      if (
        current === undefined ||
        current.status !== 'transferring' ||
        message.payload.transferredBytes < (outgoing.remoteProgress.get(current.fileId) ?? 0) ||
        message.payload.transferredBytes > current.size
      ) {
        this.failOutgoingFile(outgoing, message.payload.fileId, 'PROTOCOL_INVALID')
        return
      }
      outgoing.remoteProgress.set(current.fileId, message.payload.transferredBytes)
      outgoing.task = updateFile(
        outgoing.task,
        current.fileId,
        'transferring',
        Math.max(current.transferredBytes, message.payload.transferredBytes),
        current.bytesPerSecond,
        'transferring',
      )
      this.emitTask(outgoing.task)
    } else if (message.type === 'file:complete') {
      const current = outgoing.task.files.find((file) => file.fileId === message.payload.fileId)
      if (
        current === undefined ||
        current.status !== 'transferring' ||
        message.payload.size !== current.size
      ) {
        this.failOutgoingFile(outgoing, message.payload.fileId, 'PROTOCOL_INVALID')
        return
      }
      this.completeOutgoingFile(outgoing, current.fileId)
    } else if (message.type === 'file:error') {
      this.failOutgoingFile(outgoing, message.payload.fileId, message.payload.errorCode)
    } else if (message.type === 'file:cancel') {
      this.cancelOutgoing(outgoing, message.payload.fileId)
    }
  }

  private handleOffer(transferId: TransferId, files: readonly FileMetadata[]): void {
    const peer = this.connectionManager.getPeer()
    const connectionId = this.connectionManager.getStatus().connectionId
    if (peer === null || connectionId === undefined || files.length === 0) return
    this.pruneRecordedTransfers()
    if (this.recordedTransfers.has(transferId)) {
      const firstFile = files[0]
      if (firstFile !== undefined) {
        void this.connectionManager.sendFileError(transferId, firstFile.fileId, 'PROTOCOL_INVALID')
      }
      return
    }
    const oversizedFile = files.find((file) => file.size > this.getMaximumFileSize())
    if (oversizedFile !== undefined) {
      const rejectedTask = updateAllNonTerminalFiles(
        createTask(transferId, 'receive', peer, files),
        'failed',
        'failed',
        'FILE_TOO_LARGE',
      )
      this.emitTask(rejectedTask)
      this.recordHistory(rejectedTask)
      void this.connectionManager.sendFileError(transferId, oversizedFile.fileId, 'FILE_TOO_LARGE')
      return
    }
    const hasActiveIncoming = [...this.incoming.values()].some(
      (transfer) => !TERMINAL_TASK_STATUSES.includes(transfer.task.status),
    )
    if (hasActiveIncoming) {
      const firstFile = files[0]
      if (firstFile !== undefined) {
        void this.connectionManager.sendFileError(transferId, firstFile.fileId, 'TRANSFER_FAILED')
      }
      return
    }
    if (this.incoming.has(transferId)) {
      void this.connectionManager.sendFileError(
        transferId,
        files[0]?.fileId ?? fileIdSchema.parse(randomUUID()),
        'PROTOCOL_INVALID',
      )
      return
    }
    const transfer: IncomingTransfer = {
      task: createTask(transferId, 'receive', peer, files),
      files: new Map(
        files.map((metadata) => [metadata.fileId, { metadata, tokenUsed: false }] as const),
      ),
      connectionId,
      cancelAll: false,
    }
    this.incoming.set(transferId, transfer)
    transfer.offerTimeout = this.createOfferTimeout(() => {
      transfer.task = updateAllNonTerminalFiles(
        transfer.task,
        'failed',
        'failed',
        'TRANSFER_TIMEOUT',
      )
      this.finishTask(transfer.task)
      const firstFile = transfer.task.files[0]
      if (firstFile !== undefined) {
        void this.connectionManager.sendFileError(transferId, firstFile.fileId, 'TRANSFER_TIMEOUT')
      }
    })
    this.emitTask(transfer.task)
    const offer = { transferId, peer, files, receivedAt: Date.now() }
    for (const listener of this.offerListeners) listener(offer)
  }

  private handleAccept(
    transfer: OutgoingTransfer,
    authorizations: FileAcceptMessage['payload']['files'],
  ): void {
    this.clearOfferTimeout(transfer)
    const expectedIds = new Set(
      transfer.sources
        .map(({ selection }) => selection.fileId)
        .filter(
          (fileId) =>
            transfer.task.files.find((file) => file.fileId === fileId)?.status !== 'cancelled',
        ),
    )
    const receivedIds = new Set(authorizations.map(({ fileId }) => fileId))
    if (
      transfer.task.status !== 'awaitingAcceptance' ||
      authorizations.length !== expectedIds.size ||
      receivedIds.size !== expectedIds.size ||
      authorizations.some(
        ({ fileId, expiresAt }) => !expectedIds.has(fileId) || expiresAt < Date.now(),
      )
    ) {
      this.failWholeOutgoing(transfer, 'PROTOCOL_INVALID')
      return
    }
    for (const authorization of authorizations) {
      transfer.authorizations.set(authorization.fileId, authorization.uploadToken)
    }
    transfer.task = rebuildTask(transfer.task, transfer.task.files, 'accepted')
    this.emitTask(transfer.task)
    const queuePromise = this.runOutgoingQueue(transfer)
    transfer.queuePromise = queuePromise
    void queuePromise.finally(() => delete transfer.queuePromise)
  }

  private async runOutgoingQueue(transfer: OutgoingTransfer): Promise<void> {
    for (const source of transfer.sources) {
      const fileId = source.selection.fileId
      if (transfer.cancelAll) break
      if (transfer.cancelledFiles.has(fileId)) continue
      const uploadToken = transfer.authorizations.get(fileId)
      if (uploadToken === undefined) {
        this.failOutgoingFile(transfer, fileId, 'PROTOCOL_INVALID')
        break
      }
      const outcome = await this.uploadFile(transfer, source, uploadToken)
      if (outcome === 'failed') break
    }
    const status = calculateFinishedStatus(transfer.task.files)
    transfer.task = rebuildTask(transfer.task, transfer.task.files, status)
    this.emitTask(transfer.task)
    if (TERMINAL_TASK_STATUSES.includes(status)) this.recordHistory(transfer.task)
  }

  private async uploadFile(
    transfer: OutgoingTransfer,
    sourceFile: AuthorizedSourceFile,
    uploadToken: string,
  ): Promise<UploadOutcome> {
    const fileId = sourceFile.selection.fileId
    const startedAt = Date.now()
    transfer.activeFileId = fileId
    transfer.task = updateFile(transfer.task, fileId, 'transferring', 0, 0, 'transferring')
    this.emitTask(transfer.task)
    let sourceHandle: Awaited<ReturnType<typeof open>> | null = null
    try {
      if (transfer.cancelAll || transfer.cancelledFiles.has(fileId)) {
        throw new Error('TRANSFER_CANCELLED')
      }
      const pathMetadata = await lstat(sourceFile.path)
      if (!pathMetadata.isFile() || pathMetadata.isSymbolicLink()) {
        throw new Error('FILE_NOT_FOUND')
      }
      sourceHandle = await open(sourceFile.path, 'r')
      const sourceMetadata = await sourceHandle.stat()
      const identityChanged =
        sourceFile.identity !== undefined &&
        (sourceMetadata.dev !== sourceFile.identity.device ||
          sourceMetadata.ino !== sourceFile.identity.inode ||
          sourceMetadata.mtimeMs !== sourceFile.identity.modifiedAt)
      if (
        !sourceMetadata.isFile() ||
        sourceMetadata.dev !== pathMetadata.dev ||
        sourceMetadata.ino !== pathMetadata.ino ||
        sourceMetadata.size !== sourceFile.selection.size ||
        identityChanged
      ) {
        throw new Error('FILE_NOT_FOUND')
      }
      if (transfer.cancelAll || transfer.cancelledFiles.has(fileId)) {
        throw new Error('TRANSFER_CANCELLED')
      }
      const activeSourceHandle = sourceHandle
      await new Promise<void>((resolveResponse, rejectResponse) => {
        let uploadedBytes = 0
        let lastUpdateAt = 0
        const uploadRequest = createHttpRequest(
          {
            host: transfer.task.peer.ipAddress,
            port: transfer.task.peer.servicePort,
            path: `/v1/transfers/${transfer.task.transferId}/files/${fileId}`,
            method: 'POST',
            headers: {
              Authorization: `Bearer ${uploadToken}`,
              'Content-Length': sourceFile.selection.size,
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
        transfer.abortUpload = () => uploadRequest.destroy(new Error('Transfer interrupted'))
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
      if (transfer.cancelAll || transfer.cancelledFiles.has(fileId)) {
        this.markOutgoingFileCancelled(transfer, fileId)
        return 'cancelled'
      }
      const errorCode = mapFileError(error)
      this.failOutgoingFile(transfer, fileId, errorCode)
      await this.connectionManager.sendFileError(transfer.task.transferId, fileId, errorCode)
      return 'failed'
    } finally {
      await sourceHandle?.close().catch(() => undefined)
      delete transfer.activeFileId
      delete transfer.abortUpload
    }
  }

  private async receiveUpload(
    transfer: IncomingTransfer,
    file: IncomingFileState,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const directoryPath = transfer.directoryPath
    if (directoryPath === undefined) {
      this.writeResponse(response, 403)
      return
    }
    const fileId = file.metadata.fileId
    const startedAt = Date.now()
    const temporaryPath = join(directoryPath, `.lan-transfer-${randomUUID()}.part`)
    file.temporaryPath = temporaryPath
    transfer.task = updateFile(transfer.task, fileId, 'transferring', 0, 0, 'transferring')
    this.emitTask(transfer.task)
    try {
      const safeDirectoryPath = await assertSafeReceiveDirectory(directoryPath)
      await assertSufficientDiskSpace(safeDirectoryPath, file.metadata.size)
      const output = createWriteStream(temporaryPath, { flags: 'wx', mode: 0o600 })
      let receivedBytes = 0
      let lastUpdateAt = 0
      let lastProgressMessageAt = 0
      request.on('data', (chunk: Buffer) => {
        receivedBytes += chunk.byteLength
        if (receivedBytes > file.metadata.size) {
          file.failureOverride = 'PROTOCOL_INVALID'
          request.destroy(new Error('Received more bytes than offered'))
          return
        }
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
          void this.connectionManager.sendFileProgress(
            transfer.task.transferId,
            fileId,
            receivedBytes,
          )
        }
      })
      await pipeline(request, output)
      if (receivedBytes !== file.metadata.size) throw new Error('TRANSFER_FAILED')
      file.publishedPath = await publishTemporaryFile(
        temporaryPath,
        directoryPath,
        file.metadata.displayName,
      )
      delete file.temporaryPath
      transfer.task = updateFile(
        transfer.task,
        fileId,
        'completed',
        receivedBytes,
        0,
        calculateFinishedStatus(
          transfer.task.files.map((item) =>
            item.fileId === fileId
              ? { ...item, status: 'completed', transferredBytes: receivedBytes }
              : item,
          ),
        ),
      )
      this.emitTask(transfer.task)
      await this.connectionManager.sendFileComplete(transfer.task.transferId, fileId, receivedBytes)
      this.writeResponse(response, 200)
      if (TERMINAL_TASK_STATUSES.includes(transfer.task.status)) this.recordHistory(transfer.task)
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined)
      delete file.temporaryPath
      const errorCode = file.failureOverride ?? mapFileError(error)
      if (errorCode === 'TRANSFER_CANCELLED') {
        transfer.task = updateFile(
          transfer.task,
          fileId,
          'cancelled',
          transfer.task.files.find((item) => item.fileId === fileId)?.transferredBytes ?? 0,
          0,
          calculateFinishedStatus(
            transfer.task.files.map((item) =>
              item.fileId === fileId ? { ...item, status: 'cancelled' } : item,
            ),
          ),
          errorCode,
        )
        this.writeResponse(response, 409)
      } else {
        this.failIncomingFile(transfer, fileId, errorCode)
        this.writeResponse(response, 500)
        await this.connectionManager.sendFileError(transfer.task.transferId, fileId, errorCode)
      }
      delete file.failureOverride
    }
  }

  private completeOutgoingFile(transfer: OutgoingTransfer, fileId: FileId): void {
    const current = transfer.task.files.find((file) => file.fileId === fileId)
    if (current === undefined || current.status === 'completed') return
    transfer.task = updateFile(
      transfer.task,
      fileId,
      'completed',
      current.size,
      0,
      calculateFinishedStatus(
        transfer.task.files.map((file) =>
          file.fileId === fileId
            ? { ...file, status: 'completed', transferredBytes: file.size }
            : file,
        ),
      ),
    )
    this.emitTask(transfer.task)
  }

  private failOutgoingFile(
    transfer: OutgoingTransfer,
    fileId: FileId | undefined,
    errorCode: ErrorCode,
  ): void {
    const target =
      transfer.task.files.find(
        (file) =>
          file.fileId === fileId &&
          !['completed', 'failed', 'cancelled', 'rejected'].includes(file.status),
      ) ?? transfer.task.files.find((file) => file.status === 'transferring')
    if (target === undefined && !TERMINAL_TASK_STATUSES.includes(transfer.task.status)) {
      this.failWholeOutgoing(transfer, errorCode)
      return
    }
    if (target === undefined) return
    transfer.task = updateFile(
      transfer.task,
      target.fileId,
      'failed',
      target.transferredBytes,
      0,
      'failed',
      errorCode,
    )
    transfer.abortUpload?.()
    this.finishTask(transfer.task)
  }

  private failWholeOutgoing(transfer: OutgoingTransfer, errorCode: ErrorCode): void {
    transfer.cancelAll = true
    transfer.abortUpload?.()
    transfer.task = updateAllNonTerminalFiles(transfer.task, 'failed', 'failed', errorCode)
    this.finishTask(transfer.task)
  }

  private failIncomingFile(
    transfer: IncomingTransfer,
    fileId: FileId | undefined,
    errorCode: ErrorCode,
  ): void {
    const target =
      transfer.task.files.find(
        (file) =>
          file.fileId === fileId &&
          !['completed', 'failed', 'cancelled', 'rejected'].includes(file.status),
      ) ?? transfer.task.files.find((file) => file.status === 'transferring')
    if (target === undefined) return
    const state = transfer.files.get(target.fileId)
    if (state?.abortUpload !== undefined) {
      state.failureOverride = errorCode
      state.abortUpload()
      return
    }
    transfer.task = updateFile(
      transfer.task,
      target.fileId,
      'failed',
      target.transferredBytes,
      0,
      'failed',
      errorCode,
    )
    this.finishTask(transfer.task)
  }

  private cancelOutgoing(transfer: OutgoingTransfer, fileId?: FileId): void {
    if (fileId === undefined) {
      transfer.cancelAll = true
      transfer.task = updateAllNonTerminalFiles(
        transfer.task,
        'cancelled',
        'cancelled',
        'TRANSFER_CANCELLED',
      )
      transfer.abortUpload?.()
      this.finishTask(transfer.task)
      return
    }
    const file = transfer.task.files.find((item) => item.fileId === fileId)
    if (
      file === undefined ||
      ['completed', 'failed', 'cancelled', 'rejected'].includes(file.status)
    ) {
      return
    }
    transfer.cancelledFiles.add(fileId)
    this.markOutgoingFileCancelled(transfer, fileId)
    if (transfer.activeFileId === fileId) transfer.abortUpload?.()
  }

  private markOutgoingFileCancelled(transfer: OutgoingTransfer, fileId: FileId): void {
    const file = transfer.task.files.find((item) => item.fileId === fileId)
    if (file === undefined || file.status === 'cancelled') return
    const projectedFiles = transfer.task.files.map((item) =>
      item.fileId === fileId ? { ...item, status: 'cancelled' as const, bytesPerSecond: 0 } : item,
    )
    const projectedTaskStatus = projectedFiles.every((item) =>
      ['completed', 'failed', 'cancelled', 'rejected'].includes(item.status),
    )
      ? calculateFinishedStatus(projectedFiles)
      : transfer.task.status === 'awaitingAcceptance' || transfer.task.status === 'accepted'
        ? transfer.task.status
        : calculateFinishedStatus(projectedFiles)
    transfer.task = updateFile(
      transfer.task,
      fileId,
      'cancelled',
      file.transferredBytes,
      0,
      projectedTaskStatus,
      'TRANSFER_CANCELLED',
    )
    this.emitTask(transfer.task)
    if (TERMINAL_TASK_STATUSES.includes(transfer.task.status)) this.recordHistory(transfer.task)
  }

  private cancelIncoming(transfer: IncomingTransfer, fileId?: FileId): void {
    if (fileId === undefined) {
      transfer.cancelAll = true
      transfer.task = updateAllNonTerminalFiles(
        transfer.task,
        'cancelled',
        'cancelled',
        'TRANSFER_CANCELLED',
      )
      for (const file of transfer.files.values()) {
        file.failureOverride = 'TRANSFER_CANCELLED'
        file.abortUpload?.()
      }
      this.finishTask(transfer.task)
      return
    }
    const item = transfer.task.files.find((file) => file.fileId === fileId)
    if (
      item === undefined ||
      ['completed', 'failed', 'cancelled', 'rejected'].includes(item.status)
    ) {
      return
    }
    const file = transfer.files.get(fileId)
    if (file !== undefined) {
      file.failureOverride = 'TRANSFER_CANCELLED'
      file.abortUpload?.()
    }
    const projectedFiles = transfer.task.files.map((candidate) =>
      candidate.fileId === fileId
        ? { ...candidate, status: 'cancelled' as const, bytesPerSecond: 0 }
        : candidate,
    )
    const projectedTaskStatus = projectedFiles.every((candidate) =>
      ['completed', 'failed', 'cancelled', 'rejected'].includes(candidate.status),
    )
      ? calculateFinishedStatus(projectedFiles)
      : transfer.task.status === 'awaitingAcceptance' || transfer.task.status === 'accepted'
        ? transfer.task.status
        : calculateFinishedStatus(projectedFiles)
    transfer.task = updateFile(
      transfer.task,
      fileId,
      'cancelled',
      item.transferredBytes,
      0,
      projectedTaskStatus,
      'TRANSFER_CANCELLED',
    )
    this.emitTask(transfer.task)
    if (TERMINAL_TASK_STATUSES.includes(transfer.task.status)) this.recordHistory(transfer.task)
  }

  private async failActiveTransfers(errorCode: ErrorCode): Promise<void> {
    for (const transfer of this.outgoing.values()) {
      if (!TERMINAL_TASK_STATUSES.includes(transfer.task.status)) {
        this.failWholeOutgoing(transfer, errorCode)
        await transfer.queuePromise
      }
    }
    for (const transfer of this.incoming.values()) {
      if (TERMINAL_TASK_STATUSES.includes(transfer.task.status)) continue
      for (const file of transfer.files.values()) {
        file.failureOverride = errorCode
        file.abortUpload?.()
        await file.uploadPromise
        if (file.temporaryPath !== undefined) {
          await unlink(file.temporaryPath).catch(() => undefined)
          delete file.temporaryPath
        }
      }
      transfer.task = updateAllNonTerminalFiles(
        transfer.task,
        errorCode === 'TRANSFER_CANCELLED' ? 'cancelled' : 'failed',
        errorCode === 'TRANSFER_CANCELLED' ? 'cancelled' : 'failed',
        errorCode,
      )
      this.finishTask(transfer.task)
    }
  }

  private finishTask(task: TransferTaskDto): void {
    const transfer = this.outgoing.get(task.transferId) ?? this.incoming.get(task.transferId)
    if (transfer !== undefined) this.clearOfferTimeout(transfer)
    this.emitTask(task)
    this.recordHistory(task)
    this.pruneTransfers()
  }

  private emitTask(task: TransferTaskDto): void {
    for (const listener of this.taskListeners) listener(task)
  }

  private recordHistory(task: TransferTaskDto): void {
    this.pruneRecordedTransfers()
    if (this.recordedTransfers.has(task.transferId)) return
    const firstFile = task.files[0]
    if (firstFile === undefined) return
    const displayName =
      task.files.length === 1
        ? firstFile.displayName
        : `${firstFile.displayName} 等 ${String(task.files.length)} 个文件`
    const entry: Omit<HistoryEntryDto, 'id'> = {
      transferId: task.transferId,
      direction: task.direction,
      kind: 'file',
      peer: task.peer,
      status: task.status,
      displayName,
      size: task.totalBytes,
      createdAt: task.createdAt,
      ...(task.errorCode === undefined ? {} : { errorCode: task.errorCode }),
    }
    this.history.add(entry)
    this.recordedTransfers.set(task.transferId, Date.now())
    this.pruneTransfers()
  }

  private createOfferTimeout(onTimeout: () => void): ReturnType<typeof setTimeout> {
    const timeout = setTimeout(onTimeout, TRANSFER_TIMEOUT_MS)
    timeout.unref()
    return timeout
  }

  private clearOfferTimeout(transfer: OutgoingTransfer | IncomingTransfer): void {
    if (transfer.offerTimeout !== undefined) clearTimeout(transfer.offerTimeout)
    delete transfer.offerTimeout
  }

  private pruneRecordedTransfers(now = Date.now()): void {
    for (const [transferId, recordedAt] of this.recordedTransfers) {
      if (now - recordedAt > TRANSFER_ID_RETENTION_MS) this.recordedTransfers.delete(transferId)
    }
    while (this.recordedTransfers.size > MAX_IN_MEMORY_TRANSFER_TASKS * 2) {
      const oldest = this.recordedTransfers.keys().next().value
      if (oldest === undefined) return
      this.recordedTransfers.delete(oldest)
    }
  }

  private pruneTransfers(): void {
    const prune = <T extends { task: TransferTaskDto }>(transfers: Map<TransferId, T>): void => {
      const terminal = [...transfers.entries()]
        .filter(([, transfer]) => TERMINAL_TASK_STATUSES.includes(transfer.task.status))
        .sort((left, right) => left[1].task.updatedAt - right[1].task.updatedAt)
      while (transfers.size > MAX_IN_MEMORY_TRANSFER_TASKS) {
        const oldest = terminal.shift()
        if (oldest === undefined) return
        transfers.delete(oldest[0])
      }
    }
    prune(this.outgoing)
    prune(this.incoming)
  }

  private writeResponse(response: ServerResponse, statusCode: number): void {
    if (response.headersSent || response.writableEnded) return
    response.writeHead(statusCode, {
      'Cache-Control': 'no-store',
      Connection: 'close',
      'Content-Length': 0,
      'X-Content-Type-Options': 'nosniff',
    })
    response.end()
  }
}

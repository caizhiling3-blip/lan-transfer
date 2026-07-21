import { randomBytes, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { link, stat, unlink } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { request as createHttpRequest } from 'node:http'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'

import {
  TRANSFER_PROGRESS_MESSAGE_INTERVAL_MS,
  TRANSFER_PROGRESS_UPDATE_INTERVAL_MS,
  UPLOAD_TOKEN_TTL_MS,
} from '@shared/constants'
import type { ErrorCode } from '@shared/errors'
import type { FileOfferReceivedDto } from '@shared/ipc'
import type { FileAcceptMessage } from '@shared/protocols'
import { fileIdSchema, transferIdSchema } from '@shared/types'
import type {
  ConnectionId,
  FileMetadata,
  FileTransferItemDto,
  HistoryEntryDto,
  TransferId,
  TransferTaskDto,
} from '@shared/types'

import type { SessionHistory } from '../storage'
import type { ConnectionManager, FileControlMessage } from '../websocket'
import type { AuthorizedSourceFile } from './file-access-registry'

type TaskListener = (task: TransferTaskDto) => void
type OfferListener = (offer: FileOfferReceivedDto) => void

export interface FileAccessAdapter {
  consumeSource(selectionToken: string): AuthorizedSourceFile | null
  resolveReceiveDirectory(directoryToken?: string): Promise<string>
}

interface OutgoingTransfer {
  task: TransferTaskDto
  readonly source: AuthorizedSourceFile
  abortUpload?: () => void
  uploadPromise?: Promise<void>
}

interface IncomingTransfer {
  task: TransferTaskDto
  readonly file: FileMetadata
  directoryPath?: string
  uploadToken?: string
  tokenExpiresAt?: number
  tokenUsed: boolean
  temporaryPath?: string
  abortUpload?: () => void
  uploadPromise?: Promise<void>
  failureOverride?: ErrorCode
  readonly connectionId: ConnectionId
}

const UPLOAD_ROUTE = /^\/v1\/transfers\/([^/]+)\/files\/([^/?]+)$/u

const normalizeRemoteAddress = (address: string | undefined): string => {
  if (address === undefined) return ''
  return address.startsWith('::ffff:') ? address.slice(7) : address
}

const isNodeError = (error: unknown): error is NodeJS.ErrnoException =>
  error instanceof Error && 'code' in error

const mapFileError = (error: unknown): ErrorCode => {
  if (error instanceof Error) {
    if (error.message === 'FILE_NOT_FOUND') return 'FILE_NOT_FOUND'
    if (error.message === 'FILE_TOO_LARGE') return 'FILE_TOO_LARGE'
    if (error.message === 'SAVE_DIRECTORY_INVALID') return 'SAVE_DIRECTORY_INVALID'
  }
  if (isNodeError(error)) {
    if (error.code === 'ENOENT') return 'FILE_NOT_FOUND'
    if (error.code === 'ENOSPC') return 'DISK_SPACE_INSUFFICIENT'
    if (error.code === 'EACCES' || error.code === 'EPERM' || error.code === 'EROFS') {
      return 'SAVE_DIRECTORY_INVALID'
    }
  }
  return 'TRANSFER_FAILED'
}

const createFileItem = (
  file: FileMetadata,
  status: FileTransferItemDto['status'],
): FileTransferItemDto => ({
  ...file,
  transferredBytes: 0,
  bytesPerSecond: 0,
  status,
})

const createTask = (
  transferId: TransferId,
  direction: 'send' | 'receive',
  peer: TransferTaskDto['peer'],
  file: FileMetadata,
): TransferTaskDto => {
  const now = Date.now()
  return {
    transferId,
    direction,
    kind: 'file',
    peer,
    status: 'awaitingAcceptance',
    files: [createFileItem(file, 'pending')],
    totalBytes: file.size,
    transferredBytes: 0,
    bytesPerSecond: 0,
    createdAt: now,
    updatedAt: now,
  }
}

const updateTask = (
  task: TransferTaskDto,
  status: TransferTaskDto['status'],
  transferredBytes: number,
  bytesPerSecond: number,
  errorCode?: ErrorCode,
): TransferTaskDto => {
  const file = task.files[0]
  if (file === undefined) return task
  const fileStatus: FileTransferItemDto['status'] =
    status === 'awaitingAcceptance' || status === 'accepted'
      ? 'pending'
      : status === 'transferring'
        ? 'transferring'
        : status
  return {
    ...task,
    status,
    files: [
      {
        ...file,
        transferredBytes,
        bytesPerSecond,
        status: fileStatus,
        ...(errorCode === undefined ? {} : { errorCode }),
      },
    ],
    transferredBytes,
    bytesPerSecond,
    updatedAt: Date.now(),
    ...(errorCode === undefined ? {} : { errorCode }),
  }
}

const createConflictName = (fileName: string, attempt: number): string => {
  if (attempt === 0) return fileName
  const extension = extname(fileName)
  const stem = fileName.slice(0, fileName.length - extension.length)
  return `${stem} (${String(attempt)})${extension}`
}

const publishTemporaryFile = async (
  temporaryPath: string,
  directoryPath: string,
  fileName: string,
) => {
  const resolvedDirectory = resolve(directoryPath)
  for (let attempt = 0; attempt < 10_000; attempt += 1) {
    const targetPath = resolve(directoryPath, createConflictName(fileName, attempt))
    if (dirname(targetPath) !== resolvedDirectory || basename(targetPath) === '') {
      throw new Error('SAVE_DIRECTORY_INVALID')
    }
    try {
      await link(temporaryPath, targetPath)
      await unlink(temporaryPath)
      return
    } catch (error) {
      if (isNodeError(error) && error.code === 'EEXIST') continue
      throw error
    }
  }
  throw new Error('TRANSFER_FAILED')
}

export class FileTransferCoordinator {
  private readonly outgoing = new Map<TransferId, OutgoingTransfer>()
  private readonly incoming = new Map<TransferId, IncomingTransfer>()
  private readonly taskListeners = new Set<TaskListener>()
  private readonly offerListeners = new Set<OfferListener>()
  private readonly recordedTransfers = new Set<TransferId>()
  private readonly unsubscribeFromMessages: () => void
  private readonly unsubscribeFromConnection: () => void

  public constructor(
    private readonly connectionManager: ConnectionManager,
    private readonly fileAccess: FileAccessAdapter,
    private readonly history: SessionHistory,
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
      files: [transfer.file],
      receivedAt: transfer.task.createdAt,
    }
  }

  public async offerFile(selectionToken: string): Promise<TransferTaskDto | null> {
    const source = this.fileAccess.consumeSource(selectionToken)
    const peer = this.connectionManager.getPeer()
    if (source === null || peer === null) return null
    const transferId = transferIdSchema.parse(randomUUID())
    const file: FileMetadata = {
      fileId: source.selection.fileId,
      displayName: source.selection.displayName,
      size: source.selection.size,
      mimeType: source.selection.mimeType,
    }
    const transfer: OutgoingTransfer = {
      source,
      task: createTask(transferId, 'send', peer, file),
    }
    this.outgoing.set(transferId, transfer)
    if (!(await this.connectionManager.sendFileOffer(transferId, [file]))) {
      transfer.task = updateTask(transfer.task, 'failed', 0, 0, 'CONNECTION_CLOSED')
      this.emitTask(transfer.task)
      this.recordHistory(transfer.task)
    }
    return transfer.task
  }

  public async respondToOffer(
    transferId: TransferId,
    decision: 'accept' | 'reject',
    directoryToken?: string,
  ): Promise<TransferTaskDto | null> {
    const transfer = this.incoming.get(transferId)
    if (transfer === undefined || transfer.task.status !== 'awaitingAcceptance') return null
    if (decision === 'reject') {
      transfer.task = updateTask(transfer.task, 'rejected', 0, 0, 'FILE_REJECTED')
      await this.connectionManager.sendFileReject(transferId)
      this.emitTask(transfer.task)
      this.recordHistory(transfer.task)
      return transfer.task
    }

    try {
      transfer.directoryPath = await this.fileAccess.resolveReceiveDirectory(directoryToken)
      transfer.uploadToken = randomBytes(32).toString('base64url')
      transfer.tokenExpiresAt = Date.now() + UPLOAD_TOKEN_TTL_MS
      transfer.task = updateTask(transfer.task, 'accepted', 0, 0)
      const authorizations: FileAcceptMessage['payload']['files'] = [
        {
          fileId: transfer.file.fileId,
          uploadToken: transfer.uploadToken,
          expiresAt: transfer.tokenExpiresAt,
        },
      ]
      if (!(await this.connectionManager.sendFileAccept(transferId, authorizations))) {
        transfer.task = updateTask(transfer.task, 'failed', 0, 0, 'CONNECTION_CLOSED')
      }
    } catch (error) {
      transfer.task = updateTask(transfer.task, 'failed', 0, 0, mapFileError(error))
      await this.connectionManager.sendFileError(
        transferId,
        transfer.file.fileId,
        transfer.task.errorCode ?? 'TRANSFER_FAILED',
      )
    }
    this.emitTask(transfer.task)
    if (transfer.task.status === 'failed') this.recordHistory(transfer.task)
    return transfer.task
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
    const authorization = request.headers.authorization
    const contentLength = Number(request.headers['content-length'])
    const remoteAddress = normalizeRemoteAddress(request.socket.remoteAddress)
    const connectionStatus = this.connectionManager.getStatus()
    if (
      transfer === undefined ||
      transfer.task.status !== 'accepted' ||
      transfer.file.fileId !== parsedFileId.data ||
      transfer.uploadToken === undefined ||
      authorization !== `Bearer ${transfer.uploadToken}` ||
      transfer.tokenUsed ||
      transfer.tokenExpiresAt === undefined ||
      transfer.tokenExpiresAt < Date.now() ||
      !Number.isSafeInteger(contentLength) ||
      contentLength !== transfer.file.size ||
      remoteAddress !== transfer.task.peer.ipAddress ||
      connectionStatus.state !== 'connected' ||
      connectionStatus.connectionId !== transfer.connectionId
    ) {
      this.writeResponse(response, 403)
      return true
    }
    transfer.tokenUsed = true
    transfer.abortUpload = () => request.destroy(new Error('Transfer interrupted'))
    const uploadPromise = this.receiveUpload(transfer, request, response)
    transfer.uploadPromise = uploadPromise
    void uploadPromise.finally(() => {
      delete transfer.abortUpload
      delete transfer.uploadPromise
    })
    return true
  }

  public async shutdown(): Promise<void> {
    this.unsubscribeFromMessages()
    this.unsubscribeFromConnection()
    await this.failActiveTransfers('TRANSFER_CANCELLED')
  }

  private handleControlMessage(message: FileControlMessage): void {
    if (message.type === 'file:offer') {
      const peer = this.connectionManager.getPeer()
      const file = message.payload.files[0]
      const connectionId = this.connectionManager.getStatus().connectionId
      if (peer === null || file === undefined || connectionId === undefined) return
      if (message.payload.files.length !== 1) {
        void this.connectionManager.sendFileReject(
          message.payload.transferId,
          'file_limit_exceeded',
        )
        return
      }
      if (this.incoming.has(message.payload.transferId)) {
        void this.connectionManager.sendFileError(
          message.payload.transferId,
          file.fileId,
          'PROTOCOL_INVALID',
        )
        return
      }
      const transfer: IncomingTransfer = {
        task: createTask(message.payload.transferId, 'receive', peer, file),
        file,
        tokenUsed: false,
        connectionId,
      }
      this.incoming.set(message.payload.transferId, transfer)
      const offer = {
        transferId: message.payload.transferId,
        peer,
        files: [file],
        receivedAt: Date.now(),
      }
      this.emitTask(transfer.task)
      for (const listener of this.offerListeners) listener(offer)
      return
    }

    const incoming = this.incoming.get(message.payload.transferId)
    if (message.type === 'file:error' && incoming !== undefined) {
      incoming.failureOverride = message.payload.errorCode
      if (incoming.abortUpload !== undefined) {
        incoming.abortUpload()
      } else {
        incoming.task = updateTask(
          incoming.task,
          'failed',
          incoming.task.transferredBytes,
          0,
          message.payload.errorCode,
        )
        this.emitTask(incoming.task)
        this.recordHistory(incoming.task)
      }
      return
    }

    const outgoing = this.outgoing.get(message.payload.transferId)
    if (outgoing === undefined) return
    if (message.type === 'file:accept') {
      const authorization = message.payload.files[0]
      if (
        outgoing.task.status !== 'awaitingAcceptance' ||
        authorization === undefined ||
        message.payload.files.length !== 1 ||
        authorization.fileId !== outgoing.source.selection.fileId ||
        authorization.expiresAt < Date.now()
      ) {
        this.failOutgoing(outgoing, 'PROTOCOL_INVALID')
        return
      }
      outgoing.task = updateTask(outgoing.task, 'accepted', 0, 0)
      this.emitTask(outgoing.task)
      const uploadPromise = this.uploadFile(outgoing, authorization.uploadToken)
      outgoing.uploadPromise = uploadPromise
      void uploadPromise.finally(() => {
        delete outgoing.abortUpload
        delete outgoing.uploadPromise
      })
    } else if (message.type === 'file:reject') {
      if (outgoing.task.status !== 'awaitingAcceptance') {
        this.failOutgoing(outgoing, 'PROTOCOL_INVALID')
        return
      }
      outgoing.task = updateTask(outgoing.task, 'rejected', 0, 0, 'FILE_REJECTED')
      this.emitTask(outgoing.task)
      this.recordHistory(outgoing.task)
    } else if (message.type === 'file:progress') {
      if (
        outgoing.task.status !== 'transferring' ||
        message.payload.fileId !== outgoing.source.selection.fileId ||
        message.payload.transferredBytes > outgoing.task.totalBytes
      ) {
        this.failOutgoing(outgoing, 'PROTOCOL_INVALID')
        return
      }
      const transferred = message.payload.transferredBytes
      outgoing.task = updateTask(
        outgoing.task,
        'transferring',
        transferred,
        outgoing.task.bytesPerSecond,
      )
      this.emitTask(outgoing.task)
    } else if (message.type === 'file:complete') {
      if (
        outgoing.task.status !== 'transferring' ||
        message.payload.fileId !== outgoing.source.selection.fileId ||
        message.payload.size !== outgoing.task.totalBytes
      ) {
        this.failOutgoing(outgoing, 'PROTOCOL_INVALID')
        return
      }
      outgoing.task = updateTask(outgoing.task, 'completed', outgoing.task.totalBytes, 0)
      this.emitTask(outgoing.task)
      this.recordHistory(outgoing.task)
    } else if (message.type === 'file:error') {
      this.failOutgoing(outgoing, message.payload.errorCode)
    }
  }

  private async uploadFile(transfer: OutgoingTransfer, uploadToken: string): Promise<void> {
    const startedAt = Date.now()
    transfer.task = updateTask(transfer.task, 'transferring', 0, 0)
    this.emitTask(transfer.task)
    const path = `/v1/transfers/${transfer.task.transferId}/files/${transfer.source.selection.fileId}`
    try {
      const sourceMetadata = await stat(transfer.source.path)
      if (!sourceMetadata.isFile() || sourceMetadata.size !== transfer.source.selection.size) {
        throw new Error('FILE_NOT_FOUND')
      }
      const responsePromise = new Promise<void>((resolveResponse, rejectResponse) => {
        let uploadedBytes = 0
        let lastUpdateAt = 0
        const uploadRequest = createHttpRequest(
          {
            host: transfer.task.peer.ipAddress,
            port: transfer.task.peer.servicePort,
            path,
            method: 'POST',
            headers: {
              Authorization: `Bearer ${uploadToken}`,
              'Content-Length': transfer.source.selection.size,
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
        uploadRequest.once('error', rejectResponse)
        const source = createReadStream(transfer.source.path)
        source.on('data', (chunk) => {
          uploadedBytes += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.byteLength
          const transferred = Math.min(uploadedBytes, transfer.task.totalBytes)
          const elapsedSeconds = Math.max((Date.now() - startedAt) / 1_000, 0.001)
          transfer.task = updateTask(
            transfer.task,
            'transferring',
            transferred,
            Math.round(transferred / elapsedSeconds),
          )
          if (Date.now() - lastUpdateAt >= TRANSFER_PROGRESS_UPDATE_INTERVAL_MS) {
            lastUpdateAt = Date.now()
            this.emitTask(transfer.task)
          }
        })
        void pipeline(source, uploadRequest).catch(rejectResponse)
      })
      await responsePromise
    } catch (error) {
      this.failOutgoing(transfer, mapFileError(error))
      await this.connectionManager.sendFileError(
        transfer.task.transferId,
        transfer.source.selection.fileId,
        transfer.task.errorCode ?? 'TRANSFER_FAILED',
      )
    }
  }

  private async receiveUpload(
    transfer: IncomingTransfer,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const directoryPath = transfer.directoryPath
    if (directoryPath === undefined) {
      this.writeResponse(response, 403)
      return
    }
    const startedAt = Date.now()
    const temporaryPath = join(directoryPath, `.lan-transfer-${randomUUID()}.part`)
    transfer.temporaryPath = temporaryPath
    transfer.task = updateTask(transfer.task, 'transferring', 0, 0)
    this.emitTask(transfer.task)
    try {
      const output = createWriteStream(temporaryPath, { flags: 'wx' })
      let receivedBytes = 0
      let lastUpdateAt = 0
      let lastProgressMessageAt = 0
      request.on('data', (chunk: Buffer) => {
        receivedBytes += chunk.byteLength
        const elapsedSeconds = Math.max((Date.now() - startedAt) / 1_000, 0.001)
        transfer.task = updateTask(
          transfer.task,
          'transferring',
          receivedBytes,
          Math.round(receivedBytes / elapsedSeconds),
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
            transfer.file.fileId,
            receivedBytes,
          )
        }
      })
      await pipeline(request, output)
      if (receivedBytes !== transfer.file.size) throw new Error('TRANSFER_FAILED')
      await publishTemporaryFile(temporaryPath, directoryPath, transfer.file.displayName)
      delete transfer.temporaryPath
      transfer.task = updateTask(transfer.task, 'completed', receivedBytes, 0)
      this.emitTask(transfer.task)
      this.recordHistory(transfer.task)
      this.writeResponse(response, 200)
      await this.connectionManager.sendFileComplete(
        transfer.task.transferId,
        transfer.file.fileId,
        receivedBytes,
      )
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined)
      delete transfer.temporaryPath
      const errorCode = transfer.failureOverride ?? mapFileError(error)
      transfer.task = updateTask(
        transfer.task,
        'failed',
        transfer.task.transferredBytes,
        0,
        errorCode,
      )
      this.emitTask(transfer.task)
      this.recordHistory(transfer.task)
      this.writeResponse(response, 500)
      await this.connectionManager.sendFileError(
        transfer.task.transferId,
        transfer.file.fileId,
        errorCode,
      )
      delete transfer.failureOverride
    }
  }

  private failOutgoing(transfer: OutgoingTransfer, errorCode: ErrorCode): void {
    transfer.task = updateTask(
      transfer.task,
      'failed',
      transfer.task.transferredBytes,
      0,
      errorCode,
    )
    this.emitTask(transfer.task)
    this.recordHistory(transfer.task)
  }

  private async failActiveTransfers(errorCode: ErrorCode): Promise<void> {
    for (const transfer of this.outgoing.values()) {
      if (!['completed', 'failed', 'rejected', 'cancelled'].includes(transfer.task.status)) {
        transfer.abortUpload?.()
        this.failOutgoing(transfer, errorCode)
        await transfer.uploadPromise
      }
    }
    for (const transfer of this.incoming.values()) {
      if (!['completed', 'failed', 'rejected', 'cancelled'].includes(transfer.task.status)) {
        transfer.failureOverride = errorCode
        transfer.abortUpload?.()
        await transfer.uploadPromise
        if (transfer.temporaryPath !== undefined) {
          await unlink(transfer.temporaryPath).catch(() => undefined)
          delete transfer.temporaryPath
        }
        transfer.task = updateTask(
          transfer.task,
          errorCode === 'TRANSFER_CANCELLED' ? 'cancelled' : 'failed',
          transfer.task.transferredBytes,
          0,
          errorCode,
        )
        this.emitTask(transfer.task)
        this.recordHistory(transfer.task)
      }
    }
  }

  private emitTask(task: TransferTaskDto): void {
    for (const listener of this.taskListeners) listener(task)
  }

  private recordHistory(task: TransferTaskDto): void {
    if (this.recordedTransfers.has(task.transferId)) return
    const file = task.files[0]
    if (file === undefined) return
    const entry: Omit<HistoryEntryDto, 'id'> = {
      transferId: task.transferId,
      direction: task.direction,
      kind: 'file',
      peer: task.peer,
      status: task.status,
      displayName: file.displayName,
      size: file.size,
      createdAt: task.createdAt,
      ...(task.errorCode === undefined ? {} : { errorCode: task.errorCode }),
    }
    this.history.add(entry)
    this.recordedTransfers.add(task.transferId)
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

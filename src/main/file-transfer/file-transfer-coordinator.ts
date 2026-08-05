import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { lstat, open, unlink } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { request as createHttpRequest } from 'node:http'
import { basename, isAbsolute, relative, resolve, sep, join } from 'node:path'

import { z } from 'zod'

import {
  DEFAULT_FILE_CHUNK_SIZE_BYTES,
  MAX_FILES_PER_TRANSFER,
  MAX_IN_MEMORY_TRANSFER_TASKS,
  TRANSFER_IDLE_TIMEOUT_MS,
  TRANSFER_ID_RETENTION_MS,
  TRANSFER_TIMEOUT_MS,
} from '@shared/constants'
import { errorCodeSchema } from '@shared/errors'
import type { ErrorCode } from '@shared/errors'
import type { FileOfferReceivedDto } from '@shared/ipc'
import type {
  EncryptedChunkDescriptor,
  FileAcceptMessage,
  SecureFileMetadata,
  TransferResumeStateMessage,
} from '@shared/protocols'
import { deviceInfoSchema, secureFileMetadataSchema } from '@shared/protocols'
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

import type {
  LoadedRecoverableTransfer,
  RecoverableTransfersStore,
  SessionHistory,
} from '../storage'
import { assertSafeReceiveDirectory, assertSufficientDiskSpace } from '../security'
import type { ConnectionManager, FileControlMessage, TransferControlMessage } from '../websocket'
import type { AuthorizedSourceFile } from './file-access-registry'
import {
  createChunkDescriptor,
  deriveChunkUploadToken,
  readEncryptedRequest,
  readFileChunk,
  writePlaintextChunk,
} from './chunk-transfer'
import { calculateAuthorizedFileSha256, calculateFileSha256 } from './file-hash'
import { mapFileError, publishTemporaryFile } from './file-system'
import {
  calculateFinishedStatus,
  createTask,
  rebuildTask,
  updateAllNonTerminalFiles,
  updateFile,
} from './task-state'
import { createVerifiedChunkRanges, expandVerifiedChunkRanges } from './verified-chunk-ranges'

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
  readonly expectedDigests: Map<FileId, string>
  readonly verifiedChunks: Map<FileId, Set<number>>
  readonly cancelledFiles: Set<FileId>
  cancelAll: boolean
  activeFileId?: FileId
  abortUpload?: () => void
  queuePromise?: Promise<void>
  offerTimeout?: ReturnType<typeof setTimeout>
}

interface IncomingFileState {
  readonly metadata: SecureFileMetadata
  uploadToken?: string
  tokenExpiresAt?: number
  readonly verifiedChunks: Map<number, string>
  temporaryPath?: string
  publishedPath?: string
  abortUpload?: () => void
  uploadPromise?: Promise<void>
  failureOverride?: ErrorCode
}

interface IncomingTransfer {
  task: TransferTaskDto
  readonly files: Map<FileId, IncomingFileState>
  connectionId?: ConnectionId
  directoryPath?: string
  cancelAll: boolean
  preserveInterruption: boolean
  offerTimeout?: ReturnType<typeof setTimeout>
}

type UploadOutcome = 'completed' | 'cancelled' | 'failed' | 'paused'

const UPLOAD_ROUTE = /^\/v3\/transfers\/([^/]+)\/files\/([^/]+)\/chunks\/(\d+)$/u
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

const isWithinDirectory = (root: string, candidate: string): boolean => {
  const relativePath = relative(resolve(root), resolve(candidate))
  return (
    relativePath === '' ||
    (!isAbsolute(relativePath) && relativePath !== '..' && !relativePath.startsWith(`..${sep}`))
  )
}

const toFileMetadata = (file: SecureFileMetadata): FileMetadata => ({
  fileId: file.fileId,
  displayName: file.displayName,
  size: file.size,
  mimeType: file.mimeType,
})

const recoveredFileItemSchema = z
  .object({
    fileId: fileIdSchema,
    displayName: z.string().min(1).max(512),
    size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    mimeType: z.string().min(1).max(255),
    transferredBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    bytesPerSecond: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    status: z.enum([
      'pending',
      'transferring',
      'paused',
      'completed',
      'failed',
      'cancelled',
      'rejected',
    ]),
    errorCode: errorCodeSchema.optional(),
  })
  .strict()

const recoveredTaskSchema = z
  .object({
    transferId: transferIdSchema,
    direction: z.enum(['send', 'receive']),
    kind: z.literal('file'),
    peer: deviceInfoSchema,
    status: z.enum([
      'pending',
      'awaitingAcceptance',
      'accepted',
      'transferring',
      'paused',
      'reconnecting',
      'verifying',
      'recoverable',
      'publishing',
      'completed',
      'failed',
      'cancelled',
      'rejected',
    ]),
    files: z.array(recoveredFileItemSchema).min(1).max(MAX_FILES_PER_TRANSFER),
    totalBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    transferredBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    bytesPerSecond: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    createdAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    updatedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    errorCode: errorCodeSchema.optional(),
  })
  .strict()

const recoveredSourceSchema = z
  .object({
    path: z.string().min(1).max(32_768),
    selection: z
      .object({
        selectionToken: z.string().min(1).max(256),
        fileId: fileIdSchema,
        displayName: z.string().min(1).max(512),
        size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        mimeType: z.string().min(1).max(255),
      })
      .strict(),
    identity: z
      .object({
        device: z.number().int(),
        inode: z.number().int(),
        modifiedAt: z.number().nonnegative(),
      })
      .strict()
      .optional(),
  })
  .strict()

const recoveredIncomingFileSchema = z
  .object({
    metadata: secureFileMetadataSchema,
    verifiedChunks: z.array(z.tuple([z.number().int().nonnegative(), z.string().min(1).max(128)])),
    temporaryPath: z.string().min(1).max(32_768).optional(),
  })
  .strict()

const fileRecoveryPayloadSchema = z
  .object({
    format: z.literal('file-v1'),
    direction: z.enum(['send', 'receive']),
    task: recoveredTaskSchema,
    sources: z.array(recoveredSourceSchema).max(MAX_FILES_PER_TRANSFER).optional(),
    expectedDigests: z
      .array(z.tuple([fileIdSchema, z.string().regex(/^[a-f0-9]{64}$/u)]))
      .optional(),
    files: z.array(recoveredIncomingFileSchema).max(MAX_FILES_PER_TRANSFER).optional(),
    directoryPath: z.string().min(1).max(32_768).optional(),
  })
  .strict()

export class FileTransferCoordinator {
  private readonly outgoing = new Map<TransferId, OutgoingTransfer>()
  private readonly incoming = new Map<TransferId, IncomingTransfer>()
  private readonly restorationFailures: TransferTaskDto[] = []
  private readonly taskListeners = new Set<TaskListener>()
  private readonly offerListeners = new Set<OfferListener>()
  private readonly recordedTransfers = new Map<TransferId, number>()
  private readonly unsubscribeFromMessages: () => void
  private readonly unsubscribeFromConnection: () => void
  private readonly unsubscribeFromTransferMessages: () => void

  public constructor(
    private readonly connectionManager: ConnectionManager,
    private readonly fileAccess: FileAccessAdapter,
    private readonly history: SessionHistory,
    private readonly getMaximumFileSize: () => number = () => Number.MAX_SAFE_INTEGER,
    private readonly canStartTransfer: () => boolean = () => true,
    private readonly recoveryStore?: RecoverableTransfersStore,
  ) {
    this.unsubscribeFromMessages = connectionManager.subscribeFileMessages((message) => {
      this.handleControlMessage(message)
    })
    this.unsubscribeFromTransferMessages = connectionManager.subscribeTransferMessages((message) =>
      this.handleTransferControlMessage(message),
    )
    this.unsubscribeFromConnection = connectionManager.subscribeStatus((status) => {
      if (status.state === 'disconnected') {
        if (status.errorCode === 'RESUME_EXPIRED') {
          this.markRecoverableTransfers()
        } else if (this.hasActiveTransfers() && connectionManager.shouldResumeTransfers()) {
          this.markTransfersReconnecting()
        } else if (this.hasActiveTransfers() && connectionManager.allowsTransferRecovery()) {
          const peer = this.getTasks().find(
            (task) => !TERMINAL_TASK_STATUSES.includes(task.status),
          )?.peer
          if (peer !== undefined) {
            connectionManager.expectTransferReconnect(peer.deviceId)
            this.markTransfersReconnecting()
          } else void this.failActiveTransfers('CONNECTION_CLOSED')
        } else if (this.hasActiveTransfers()) {
          void this.failActiveTransfers('CONNECTION_CLOSED')
        }
      } else if (status.state === 'connected' && status.peer !== undefined) {
        for (const transfer of this.outgoing.values()) {
          if (
            transfer.task.status === 'reconnecting' &&
            status.peer.deviceId === transfer.task.peer.deviceId
          ) {
            void this.resume(transfer.task.transferId)
          }
        }
      }
    })
  }

  public async restoreRecoverableTransfers(
    records: readonly LoadedRecoverableTransfer[],
  ): Promise<void> {
    for (const record of records) {
      if (
        record.kind !== 'file' ||
        this.outgoing.has(record.transferId) ||
        this.incoming.has(record.transferId)
      ) {
        continue
      }
      const parsed = fileRecoveryPayloadSchema.safeParse(record.payload)
      if (!parsed.success) {
        this.recoveryStore?.remove(record.transferId)
        continue
      }
      const task = this.parseRecoveredTask(parsed.data.task, record)
      if (task === null) continue
      if (parsed.data.direction === 'send') {
        await this.restoreOutgoingTransfer(record, task, parsed.data)
      } else {
        await this.restoreIncomingTransfer(record, task, parsed.data)
      }
    }
  }

  private parseRecoveredTask(
    task: z.infer<typeof recoveredTaskSchema>,
    record: LoadedRecoverableTransfer,
  ): TransferTaskDto | null {
    if (
      task.transferId !== record.transferId ||
      task.peer.deviceId !== record.peerDeviceId ||
      task.direction !== record.direction ||
      TERMINAL_TASK_STATUSES.includes(task.status)
    ) {
      this.recoveryStore?.remove(record.transferId)
      return null
    }
    const normalizedTask: TransferTaskDto = {
      transferId: task.transferId,
      direction: task.direction,
      kind: task.kind,
      peer: task.peer,
      status: task.status,
      files: task.files.map(({ errorCode, ...file }) => ({
        ...file,
        ...(errorCode === undefined ? {} : { errorCode }),
      })),
      totalBytes: task.totalBytes,
      transferredBytes: task.transferredBytes,
      bytesPerSecond: task.bytesPerSecond,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      ...(task.errorCode === undefined ? {} : { errorCode: task.errorCode }),
    }
    return rebuildTask(
      normalizedTask,
      normalizedTask.files.map((file) =>
        file.status === 'completed'
          ? file
          : { ...file, status: 'paused' as const, bytesPerSecond: 0 },
      ),
      'recoverable',
    )
  }

  private async restoreOutgoingTransfer(
    record: LoadedRecoverableTransfer,
    task: TransferTaskDto,
    payload: z.infer<typeof fileRecoveryPayloadSchema>,
  ): Promise<void> {
    if (payload.sources === undefined || payload.expectedDigests === undefined) {
      this.recoveryStore?.remove(record.transferId)
      return
    }
    const expectedDigests = new Map(payload.expectedDigests)
    try {
      if (
        payload.sources.length !== task.files.length ||
        expectedDigests.size !== task.files.length ||
        payload.sources.some(
          (source) =>
            !isAbsolute(source.path) ||
            !task.files.some((file) => file.fileId === source.selection.fileId),
        )
      ) {
        throw new Error('SOURCE_FILE_CHANGED')
      }
      for (const source of payload.sources) {
        const expectedDigest = expectedDigests.get(source.selection.fileId)
        if (
          expectedDigest === undefined ||
          (await calculateAuthorizedFileSha256({
            path: source.path,
            size: source.selection.size,
            ...(source.identity === undefined ? {} : { identity: source.identity }),
          })) !== expectedDigest
        ) {
          throw new Error('SOURCE_FILE_CHANGED')
        }
      }
      const sources: AuthorizedSourceFile[] = payload.sources.map(({ identity, ...source }) => ({
        ...source,
        ...(identity === undefined ? {} : { identity }),
      }))
      this.outgoing.set(record.transferId, {
        task,
        sources,
        authorizations: new Map(),
        remoteProgress: new Map(),
        expectedDigests,
        verifiedChunks: new Map(),
        cancelledFiles: new Set(),
        cancelAll: false,
      })
    } catch (error) {
      this.recoveryStore?.remove(record.transferId)
      this.registerRestorationFailure(task, mapFileError(error))
    }
  }

  private async restoreIncomingTransfer(
    record: LoadedRecoverableTransfer,
    task: TransferTaskDto,
    payload: z.infer<typeof fileRecoveryPayloadSchema>,
  ): Promise<void> {
    if (payload.files === undefined || payload.directoryPath === undefined) {
      this.recoveryStore?.remove(record.transferId)
      return
    }
    try {
      const directoryPath = await assertSafeReceiveDirectory(payload.directoryPath)
      if (payload.files.length !== task.files.length) throw new Error('RESUME_STATE_INVALID')
      const files = new Map<FileId, IncomingFileState>()
      for (const recovered of payload.files) {
        const verifiedChunks = new Map(recovered.verifiedChunks)
        if (
          !task.files.some((file) => file.fileId === recovered.metadata.fileId) ||
          [...verifiedChunks.keys()].some((index) => index >= recovered.metadata.chunkCount)
        ) {
          throw new Error('RESUME_STATE_INVALID')
        }
        if (recovered.temporaryPath !== undefined) {
          if (
            !isWithinDirectory(directoryPath, recovered.temporaryPath) ||
            !basename(recovered.temporaryPath).startsWith(`.lan-transfer-${record.transferId}-`)
          ) {
            throw new Error('SAVE_DIRECTORY_INVALID')
          }
          const metadata = await lstat(recovered.temporaryPath)
          if (
            !metadata.isFile() ||
            metadata.isSymbolicLink() ||
            metadata.size !== recovered.metadata.size
          ) {
            throw new Error('RESUME_STATE_INVALID')
          }
        } else if (verifiedChunks.size > 0) {
          throw new Error('RESUME_STATE_INVALID')
        }
        files.set(recovered.metadata.fileId, {
          metadata: recovered.metadata,
          verifiedChunks,
          ...(recovered.temporaryPath === undefined
            ? {}
            : { temporaryPath: recovered.temporaryPath }),
        })
      }
      this.incoming.set(record.transferId, {
        task,
        files,
        directoryPath,
        cancelAll: false,
        preserveInterruption: true,
      })
    } catch (error) {
      this.recoveryStore?.remove(record.transferId)
      this.registerRestorationFailure(task, mapFileError(error))
    }
  }

  private registerRestorationFailure(task: TransferTaskDto, errorCode: ErrorCode): void {
    const failedTask = updateAllNonTerminalFiles(task, 'failed', 'failed', errorCode)
    this.restorationFailures.push(failedTask)
    this.recordHistory(failedTask)
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
      ...this.restorationFailures,
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
      files: [...transfer.files.values()].map(({ metadata }) => toFileMetadata(metadata)),
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

  public offerAuthorizedFiles(
    sources: readonly AuthorizedSourceFile[],
  ): Promise<TransferTaskDto | null> {
    return this.createAndSendOffer(sources)
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
      transfer.directoryPath = await assertSafeReceiveDirectory(
        await this.fileAccess.resolveReceiveDirectory(directoryToken),
      )
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
      } else {
        for (const file of transfer.files.values()) {
          if (file.metadata.chunkCount === 0) await this.finalizeIncomingFile(transfer, file)
        }
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

  public async pause(transferId: TransferId): Promise<TransferTaskDto | null> {
    const transfer = this.outgoing.get(transferId)
    if (
      transfer === undefined ||
      transfer.task.direction !== 'send' ||
      !['accepted', 'transferring', 'verifying'].includes(transfer.task.status)
    ) {
      return null
    }
    if (!(await this.connectionManager.sendTransferPause(transferId))) return null
    transfer.task = this.createPausedTask(transfer.task)
    transfer.abortUpload?.()
    this.emitTask(transfer.task)
    return transfer.task
  }

  public async resume(transferId: TransferId): Promise<TransferTaskDto | null> {
    const transfer = this.outgoing.get(transferId)
    if (
      transfer === undefined ||
      transfer.task.direction !== 'send' ||
      !['paused', 'reconnecting', 'recoverable'].includes(transfer.task.status)
    ) {
      return null
    }
    transfer.task = rebuildTask(transfer.task, transfer.task.files, 'verifying')
    this.emitTask(transfer.task)
    if (!(await this.connectionManager.sendTransferResumeRequest(transferId))) {
      transfer.task = rebuildTask(transfer.task, transfer.task.files, 'reconnecting')
      this.emitTask(transfer.task)
    }
    return transfer.task
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
    const chunkIndex = Number(match[3])
    if (
      !parsedTransferId.success ||
      !parsedFileId.success ||
      !Number.isSafeInteger(chunkIndex) ||
      request.method !== 'PUT'
    ) {
      this.writeResponse(response, 400)
      return true
    }
    const transfer = this.incoming.get(parsedTransferId.data)
    if (transfer === undefined) return false
    const file = transfer?.files.get(parsedFileId.data)
    const expectedFile = transfer.task.files.find((item) =>
      ['pending', 'transferring'].includes(item.status),
    )
    const authorization = request.headers.authorization
    const contentLength = Number(request.headers['content-length'])
    const remoteAddress = normalizeRemoteAddress(request.socket.remoteAddress)
    const connectionStatus = this.connectionManager.getStatus()
    if (file?.uploadPromise !== undefined) {
      this.writeResponse(response, 409)
      return true
    }
    let descriptor: EncryptedChunkDescriptor
    try {
      if (file === undefined) throw new Error('CHUNK_INVALID')
      descriptor = createChunkDescriptor(parsedTransferId.data, file.metadata, chunkIndex)
    } catch {
      this.writeResponse(response, 400)
      return true
    }
    const expectedToken =
      file?.uploadToken === undefined
        ? null
        : deriveChunkUploadToken(
            file.uploadToken,
            parsedTransferId.data,
            parsedFileId.data,
            chunkIndex,
          )
    const nextMissingChunk = file === undefined ? -1 : this.getNextMissingChunk(file)
    const isVerifiedDuplicate = file?.verifiedChunks.has(chunkIndex) === true
    if (
      file === undefined ||
      (!isVerifiedDuplicate && expectedFile?.fileId !== parsedFileId.data) ||
      (!isVerifiedDuplicate && nextMissingChunk !== chunkIndex) ||
      (!isVerifiedDuplicate && !['accepted', 'transferring'].includes(transfer.task.status)) ||
      expectedToken === null ||
      typeof authorization !== 'string' ||
      authorization !== `Bearer ${expectedToken}` ||
      file.tokenExpiresAt === undefined ||
      file.tokenExpiresAt < Date.now() ||
      !Number.isSafeInteger(contentLength) ||
      contentLength !== descriptor.ciphertextLength ||
      remoteAddress !== transfer.task.peer.ipAddress ||
      connectionStatus.state !== 'connected' ||
      connectionStatus.connectionId !== transfer.connectionId ||
      request.headers['transfer-encoding'] !== undefined ||
      request.headers['content-type'] !== 'application/octet-stream'
    ) {
      this.writeResponse(response, 403)
      return true
    }
    request.setTimeout(TRANSFER_IDLE_TIMEOUT_MS, () => {
      file.failureOverride = 'TRANSFER_TIMEOUT'
      request.destroy(new Error('TRANSFER_TIMEOUT'))
    })
    file.abortUpload = () => request.destroy(new Error('Transfer interrupted'))
    const uploadPromise = this.receiveChunkUpload(transfer, file, descriptor, request, response)
    file.uploadPromise = uploadPromise
    void uploadPromise.finally(() => {
      delete file.abortUpload
      delete file.uploadPromise
    })
    return true
  }

  public async shutdown(preserveRecoverable = false): Promise<void> {
    this.unsubscribeFromMessages()
    this.unsubscribeFromTransferMessages()
    this.unsubscribeFromConnection()
    if (preserveRecoverable) {
      this.markRecoverableTransfers()
      for (const transfer of this.outgoing.values()) transfer.abortUpload?.()
      for (const transfer of this.incoming.values()) {
        transfer.preserveInterruption = true
        for (const file of transfer.files.values()) file.abortUpload?.()
      }
      return
    }
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
    if (hasActiveOutgoing || !this.canStartTransfer()) return null
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
      expectedDigests: new Map(),
      verifiedChunks: new Map(),
      cancelledFiles: new Set(),
      cancelAll: false,
    }
    this.outgoing.set(transferId, transfer)
    const secureFiles: SecureFileMetadata[] = []
    try {
      for (const source of sources) {
        const sha256 = await calculateAuthorizedFileSha256({
          path: source.path,
          size: source.selection.size,
          ...(source.identity === undefined ? {} : { identity: source.identity }),
        })
        const secureFile: SecureFileMetadata = {
          fileId: source.selection.fileId,
          displayName: source.selection.displayName,
          size: source.selection.size,
          mimeType: source.selection.mimeType,
          sha256,
          chunkSize: DEFAULT_FILE_CHUNK_SIZE_BYTES,
          chunkCount: Math.ceil(source.selection.size / DEFAULT_FILE_CHUNK_SIZE_BYTES),
        }
        secureFiles.push(secureFile)
        transfer.expectedDigests.set(secureFile.fileId, sha256)
      }
    } catch (error) {
      transfer.task = updateAllNonTerminalFiles(
        transfer.task,
        'failed',
        'failed',
        mapFileError(error),
      )
      this.finishTask(transfer.task)
      return transfer.task
    }
    transfer.offerTimeout = this.createOfferTimeout(() => {
      this.failWholeOutgoing(transfer, 'TRANSFER_TIMEOUT')
      const firstFile = transfer.task.files[0]
      if (firstFile !== undefined) {
        void this.connectionManager.sendFileError(transferId, firstFile.fileId, 'TRANSFER_TIMEOUT')
      }
    })
    if (!(await this.connectionManager.sendFileOffer(transferId, secureFiles))) {
      transfer.task = updateAllNonTerminalFiles(
        transfer.task,
        'failed',
        'failed',
        'CONNECTION_CLOSED',
      )
      this.finishTask(transfer.task)
    } else {
      this.emitTask(transfer.task)
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

  private handleTransferControlMessage(message: TransferControlMessage): void {
    const transferId = message.payload.transferId
    if (message.type === 'transfer:pause') {
      const outgoing = this.outgoing.get(transferId)
      if (outgoing !== undefined && !TERMINAL_TASK_STATUSES.includes(outgoing.task.status)) {
        outgoing.task = this.createPausedTask(outgoing.task)
        outgoing.abortUpload?.()
        this.emitTask(outgoing.task)
      }
      const incoming = this.incoming.get(transferId)
      if (incoming !== undefined && !TERMINAL_TASK_STATUSES.includes(incoming.task.status)) {
        incoming.preserveInterruption = true
        incoming.task = this.createPausedTask(incoming.task)
        for (const file of incoming.files.values()) file.abortUpload?.()
        this.emitTask(incoming.task)
      }
      return
    }
    if (message.type === 'transfer:resume-request') {
      const incoming = this.incoming.get(transferId)
      if (incoming !== undefined) void this.sendIncomingResumeState(incoming)
      return
    }
    const outgoing = this.outgoing.get(transferId)
    if (outgoing !== undefined) this.applyOutgoingResumeState(outgoing, message)
  }

  private async sendIncomingResumeState(transfer: IncomingTransfer): Promise<void> {
    if (TERMINAL_TASK_STATUSES.includes(transfer.task.status)) return
    const connectionStatus = this.connectionManager.getStatus()
    if (connectionStatus.state !== 'connected' || connectionStatus.connectionId === undefined)
      return
    transfer.connectionId = connectionStatus.connectionId
    transfer.preserveInterruption = false
    const authorizationStartedAt = Date.now()
    const authorizations: FileAcceptMessage['payload']['files'] = []
    let authorizationIndex = 0
    for (const file of transfer.files.values()) {
      const taskFile = transfer.task.files.find(
        (candidate) => candidate.fileId === file.metadata.fileId,
      )
      if (taskFile === undefined || taskFile.status === 'completed') continue
      authorizationIndex += 1
      file.uploadToken = randomBytes(32).toString('base64url')
      file.tokenExpiresAt = authorizationStartedAt + TRANSFER_TIMEOUT_MS * authorizationIndex
      authorizations.push({
        fileId: file.metadata.fileId,
        uploadToken: file.uploadToken,
        expiresAt: file.tokenExpiresAt,
      })
    }
    if (
      authorizations.length > 0 &&
      !(await this.connectionManager.sendFileAccept(transfer.task.transferId, authorizations))
    ) {
      return
    }
    const files: TransferResumeStateMessage['payload']['files'] = [...transfer.files.values()].map(
      (file) => ({
        fileId: file.metadata.fileId,
        size: file.metadata.size,
        sha256: file.metadata.sha256,
        chunkSize: file.metadata.chunkSize,
        chunkCount: file.metadata.chunkCount,
        verifiedRanges: createVerifiedChunkRanges(file.verifiedChunks, file.metadata.chunkCount),
      }),
    )
    transfer.task = rebuildTask(
      transfer.task,
      transfer.task.files.map((file) =>
        file.status === 'completed'
          ? file
          : { ...file, status: 'pending' as const, bytesPerSecond: 0 },
      ),
      'transferring',
    )
    this.emitTask(transfer.task)
    await this.connectionManager.sendTransferResumeState({
      transferId: transfer.task.transferId,
      files,
    })
  }

  private applyOutgoingResumeState(
    transfer: OutgoingTransfer,
    message: TransferResumeStateMessage,
  ): void {
    if (!['verifying', 'reconnecting', 'paused', 'recoverable'].includes(transfer.task.status))
      return
    const expectedIds = new Set(transfer.sources.map((source) => source.selection.fileId))
    if (
      message.payload.files.length !== expectedIds.size ||
      new Set(message.payload.files.map((file) => file.fileId)).size !== expectedIds.size
    ) {
      this.failWholeOutgoing(transfer, 'RESUME_STATE_INVALID')
      return
    }
    try {
      const nextFiles = transfer.task.files.map((taskFile) => {
        const state = message.payload.files.find((file) => file.fileId === taskFile.fileId)
        const expectedDigest = transfer.expectedDigests.get(taskFile.fileId)
        if (
          state === undefined ||
          !expectedIds.has(state.fileId) ||
          state.size !== taskFile.size ||
          state.sha256 !== expectedDigest ||
          state.chunkSize !== DEFAULT_FILE_CHUNK_SIZE_BYTES ||
          state.chunkCount !== Math.ceil(taskFile.size / DEFAULT_FILE_CHUNK_SIZE_BYTES)
        ) {
          throw new Error('RESUME_STATE_INVALID')
        }
        const verified = expandVerifiedChunkRanges(state.verifiedRanges, state.chunkCount)
        transfer.verifiedChunks.set(taskFile.fileId, verified)
        const transferredBytes = [...verified].reduce(
          (total, chunkIndex) =>
            total +
            createChunkDescriptor(transfer.task.transferId, state, chunkIndex).plaintextLength,
          0,
        )
        return {
          ...taskFile,
          status:
            verified.size === state.chunkCount ? ('completed' as const) : ('pending' as const),
          transferredBytes,
          bytesPerSecond: 0,
        }
      })
      transfer.task = rebuildTask(transfer.task, nextFiles, 'accepted')
      this.emitTask(transfer.task)
      this.startOutgoingQueue(transfer)
    } catch {
      this.failWholeOutgoing(transfer, 'RESUME_STATE_INVALID')
    }
  }

  private createPausedTask(task: TransferTaskDto): TransferTaskDto {
    return rebuildTask(
      task,
      task.files.map((file) =>
        ['completed', 'failed', 'cancelled', 'rejected'].includes(file.status)
          ? file
          : { ...file, status: 'paused' as const, bytesPerSecond: 0 },
      ),
      'paused',
    )
  }

  private handleOffer(transferId: TransferId, files: readonly SecureFileMetadata[]): void {
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
        createTask(transferId, 'receive', peer, files.map(toFileMetadata)),
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
    if (hasActiveIncoming || !this.canStartTransfer()) {
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
      task: createTask(transferId, 'receive', peer, files.map(toFileMetadata)),
      files: new Map(
        files.map(
          (metadata) => [metadata.fileId, { metadata, verifiedChunks: new Map() }] as const,
        ),
      ),
      connectionId,
      cancelAll: false,
      preserveInterruption: false,
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
    const offer = {
      transferId,
      peer,
      files: files.map(toFileMetadata),
      receivedAt: Date.now(),
    }
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
            !['cancelled', 'completed'].includes(
              transfer.task.files.find((file) => file.fileId === fileId)?.status ?? 'cancelled',
            ),
        ),
    )
    const receivedIds = new Set(authorizations.map(({ fileId }) => fileId))
    if (
      !['awaitingAcceptance', 'verifying', 'reconnecting', 'paused'].includes(
        transfer.task.status,
      ) ||
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
    if (transfer.task.status === 'awaitingAcceptance') {
      transfer.task = rebuildTask(transfer.task, transfer.task.files, 'accepted')
      this.emitTask(transfer.task)
      this.startOutgoingQueue(transfer)
    }
  }

  private async runOutgoingQueue(transfer: OutgoingTransfer): Promise<void> {
    for (const source of transfer.sources) {
      const fileId = source.selection.fileId
      if (transfer.cancelAll) break
      if (transfer.cancelledFiles.has(fileId)) continue
      if (transfer.task.files.find((file) => file.fileId === fileId)?.status === 'completed')
        continue
      const uploadToken = transfer.authorizations.get(fileId)
      if (uploadToken === undefined) {
        this.failOutgoingFile(transfer, fileId, 'PROTOCOL_INVALID')
        break
      }
      const outcome = await this.uploadFile(transfer, source, uploadToken)
      if (outcome === 'failed' || outcome === 'paused') break
    }
    if (['paused', 'reconnecting', 'verifying', 'recoverable'].includes(transfer.task.status))
      return
    const status = calculateFinishedStatus(transfer.task.files)
    transfer.task = rebuildTask(transfer.task, transfer.task.files, status)
    this.emitTask(transfer.task)
    if (TERMINAL_TASK_STATUSES.includes(status)) this.recordHistory(transfer.task)
  }

  private startOutgoingQueue(transfer: OutgoingTransfer): void {
    if (transfer.queuePromise !== undefined) {
      void transfer.queuePromise.finally(() => {
        if (transfer.task.status === 'accepted') this.startOutgoingQueue(transfer)
      })
      return
    }
    const queuePromise = this.runOutgoingQueue(transfer)
    transfer.queuePromise = queuePromise
    void queuePromise.finally(() => delete transfer.queuePromise)
  }

  private async uploadFile(
    transfer: OutgoingTransfer,
    sourceFile: AuthorizedSourceFile,
    uploadToken: string,
  ): Promise<UploadOutcome> {
    const fileId = sourceFile.selection.fileId
    const startedAt = Date.now()
    const secureMetadata = {
      fileId,
      size: sourceFile.selection.size,
      chunkSize: DEFAULT_FILE_CHUNK_SIZE_BYTES,
      chunkCount: Math.ceil(sourceFile.selection.size / DEFAULT_FILE_CHUNK_SIZE_BYTES),
    }
    const verifiedChunks = transfer.verifiedChunks.get(fileId) ?? new Set<number>()
    transfer.verifiedChunks.set(fileId, verifiedChunks)
    const resumedBytes = [...verifiedChunks].reduce(
      (total, chunkIndex) =>
        total +
        createChunkDescriptor(transfer.task.transferId, secureMetadata, chunkIndex).plaintextLength,
      0,
    )
    transfer.activeFileId = fileId
    transfer.task = updateFile(
      transfer.task,
      fileId,
      'transferring',
      resumedBytes,
      0,
      'transferring',
    )
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
      const expectedDigest = transfer.expectedDigests.get(fileId)
      if (expectedDigest === undefined) throw new Error('PROTOCOL_INVALID')
      if (
        (await calculateAuthorizedFileSha256({
          path: sourceFile.path,
          size: sourceFile.selection.size,
          ...(sourceFile.identity === undefined ? {} : { identity: sourceFile.identity }),
        })) !== expectedDigest
      ) {
        throw new Error('SOURCE_FILE_CHANGED')
      }
      for (let chunkIndex = 0; chunkIndex < secureMetadata.chunkCount; chunkIndex += 1) {
        if (verifiedChunks.has(chunkIndex)) continue
        if (['paused', 'reconnecting', 'recoverable'].includes(transfer.task.status)) {
          throw new Error('TRANSFER_CANCELLED')
        }
        if (transfer.cancelAll || transfer.cancelledFiles.has(fileId)) {
          throw new Error('TRANSFER_CANCELLED')
        }
        const descriptor = createChunkDescriptor(
          transfer.task.transferId,
          secureMetadata,
          chunkIndex,
        )
        const plaintext = await readFileChunk(sourceHandle, descriptor)
        const encrypted = this.connectionManager.encryptFileChunk(descriptor, plaintext)
        plaintext.fill(0)
        if (encrypted === null) throw new Error('CONNECTION_CLOSED')
        try {
          await this.uploadEncryptedChunk(transfer, descriptor, encrypted, uploadToken)
        } finally {
          encrypted.fill(0)
        }
        verifiedChunks.add(chunkIndex)
        const transferredBytes = descriptor.plaintextOffset + descriptor.plaintextLength
        const elapsedSeconds = Math.max((Date.now() - startedAt) / 1_000, 0.001)
        transfer.task = updateFile(
          transfer.task,
          fileId,
          'transferring',
          transferredBytes,
          Math.round(transferredBytes / elapsedSeconds),
          'transferring',
        )
        this.emitTask(transfer.task)
      }
      if (secureMetadata.chunkCount === 0) return 'completed'
      this.completeOutgoingFile(transfer, fileId)
      return 'completed'
    } catch (error) {
      if (['paused', 'reconnecting', 'recoverable'].includes(transfer.task.status)) return 'paused'
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

  private uploadEncryptedChunk(
    transfer: OutgoingTransfer,
    descriptor: EncryptedChunkDescriptor,
    encrypted: Buffer,
    uploadToken: string,
  ): Promise<void> {
    return new Promise((resolveResponse, rejectResponse) => {
      const uploadRequest = createHttpRequest(
        {
          host: transfer.task.peer.ipAddress,
          port: transfer.task.peer.servicePort,
          path: `/v3/transfers/${descriptor.transferId}/files/${descriptor.fileId}/chunks/${String(descriptor.chunkIndex)}`,
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${deriveChunkUploadToken(
              uploadToken,
              descriptor.transferId,
              descriptor.fileId,
              descriptor.chunkIndex,
            )}`,
            'Content-Length': descriptor.ciphertextLength,
            'Content-Type': 'application/octet-stream',
          },
        },
        (response) => {
          response.resume()
          response.once('end', () => {
            if (response.statusCode === 200) resolveResponse()
            else
              rejectResponse(
                new Error(response.statusCode === 422 ? 'CHUNK_INVALID' : 'TRANSFER_FAILED'),
              )
          })
        },
      )
      transfer.abortUpload = () => uploadRequest.destroy(new Error('TRANSFER_CANCELLED'))
      uploadRequest.setTimeout(TRANSFER_IDLE_TIMEOUT_MS, () => {
        uploadRequest.destroy(new Error('TRANSFER_TIMEOUT'))
      })
      uploadRequest.once('error', rejectResponse)
      uploadRequest.end(encrypted)
    })
  }

  private async receiveChunkUpload(
    transfer: IncomingTransfer,
    file: IncomingFileState,
    descriptor: EncryptedChunkDescriptor,
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
    try {
      const safeDirectoryPath = await assertSafeReceiveDirectory(directoryPath)
      if (file.temporaryPath === undefined) {
        await assertSufficientDiskSpace(safeDirectoryPath, file.metadata.size)
        file.temporaryPath = join(
          directoryPath,
          `.lan-transfer-${transfer.task.transferId}-${randomUUID()}.part`,
        )
        const temporaryHandle = await open(file.temporaryPath, 'wx+', 0o600)
        try {
          await temporaryHandle.truncate(file.metadata.size)
        } finally {
          await temporaryHandle.close().catch(() => undefined)
        }
      }
      const encrypted = await readEncryptedRequest(request, descriptor.ciphertextLength)
      const encryptedDigest = createHash('sha256').update(encrypted).digest('hex')
      const verifiedDigest = file.verifiedChunks.get(descriptor.chunkIndex)
      if (verifiedDigest !== undefined) {
        if (verifiedDigest !== encryptedDigest) throw new Error('CHUNK_INVALID')
        this.writeResponse(response, 200)
        return
      }
      let plaintext: Buffer
      try {
        plaintext = this.connectionManager.decryptFileChunk(descriptor, encrypted)
      } finally {
        encrypted.fill(0)
      }
      try {
        await writePlaintextChunk(file.temporaryPath, descriptor, plaintext)
      } finally {
        plaintext.fill(0)
      }
      file.verifiedChunks.set(descriptor.chunkIndex, encryptedDigest)
      const receivedBytes = [...file.verifiedChunks.keys()].reduce(
        (total, chunkIndex) =>
          total +
          createChunkDescriptor(transfer.task.transferId, file.metadata, chunkIndex)
            .plaintextLength,
        0,
      )
      const elapsedSeconds = Math.max((Date.now() - startedAt) / 1_000, 0.001)
      transfer.task = updateFile(
        transfer.task,
        fileId,
        'transferring',
        receivedBytes,
        Math.round(descriptor.plaintextLength / elapsedSeconds),
        'transferring',
      )
      this.emitTask(transfer.task)
      await this.connectionManager.sendFileProgress(transfer.task.transferId, fileId, receivedBytes)
      if (file.verifiedChunks.size === file.metadata.chunkCount) {
        await this.finalizeIncomingFile(transfer, file)
      }
      this.writeResponse(response, 200)
    } catch (error) {
      if (
        transfer.preserveInterruption ||
        ['paused', 'reconnecting'].includes(transfer.task.status)
      ) {
        delete file.abortUpload
        delete file.failureOverride
        if (!response.writableEnded) this.writeResponse(response, 409)
        return
      }
      if (file.temporaryPath !== undefined) await unlink(file.temporaryPath).catch(() => undefined)
      delete file.temporaryPath
      delete file.abortUpload
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
        this.writeResponse(response, errorCode === 'CHUNK_INVALID' ? 422 : 500)
        await this.connectionManager.sendFileError(transfer.task.transferId, fileId, errorCode)
      }
      delete file.failureOverride
    }
  }

  private getNextMissingChunk(file: IncomingFileState): number {
    for (let chunkIndex = 0; chunkIndex < file.metadata.chunkCount; chunkIndex += 1) {
      if (!file.verifiedChunks.has(chunkIndex)) return chunkIndex
    }
    return file.metadata.chunkCount
  }

  private async finalizeIncomingFile(
    transfer: IncomingTransfer,
    file: IncomingFileState,
  ): Promise<void> {
    const directoryPath = transfer.directoryPath
    if (directoryPath === undefined) throw new Error('SAVE_DIRECTORY_INVALID')
    if (file.temporaryPath === undefined) {
      file.temporaryPath = join(
        directoryPath,
        `.lan-transfer-${transfer.task.transferId}-${randomUUID()}.part`,
      )
      const emptyHandle = await open(file.temporaryPath, 'wx', 0o600)
      await emptyHandle.close()
    }
    if ((await calculateFileSha256(file.temporaryPath)) !== file.metadata.sha256) {
      throw new Error('FILE_INTEGRITY_FAILED')
    }
    file.publishedPath = await publishTemporaryFile(
      file.temporaryPath,
      directoryPath,
      file.metadata.displayName,
    )
    delete file.temporaryPath
    transfer.task = updateFile(
      transfer.task,
      file.metadata.fileId,
      'completed',
      file.metadata.size,
      0,
      calculateFinishedStatus(
        transfer.task.files.map((item) =>
          item.fileId === file.metadata.fileId
            ? { ...item, status: 'completed', transferredBytes: item.size }
            : item,
        ),
      ),
    )
    this.emitTask(transfer.task)
    await this.connectionManager.sendFileComplete(
      transfer.task.transferId,
      file.metadata.fileId,
      file.metadata.size,
    )
    if (TERMINAL_TASK_STATUSES.includes(transfer.task.status)) this.recordHistory(transfer.task)
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

  private markTransfersReconnecting(): void {
    for (const transfer of this.outgoing.values()) {
      if (TERMINAL_TASK_STATUSES.includes(transfer.task.status)) continue
      const pausedTask = this.createPausedTask(transfer.task)
      transfer.task = rebuildTask(pausedTask, pausedTask.files, 'reconnecting')
      transfer.abortUpload?.()
      this.emitTask(transfer.task)
    }
    for (const transfer of this.incoming.values()) {
      if (TERMINAL_TASK_STATUSES.includes(transfer.task.status)) continue
      transfer.preserveInterruption = true
      const pausedTask = this.createPausedTask(transfer.task)
      transfer.task = rebuildTask(pausedTask, pausedTask.files, 'reconnecting')
      for (const file of transfer.files.values()) file.abortUpload?.()
      this.emitTask(transfer.task)
    }
  }

  private markRecoverableTransfers(): void {
    for (const transfer of [...this.outgoing.values(), ...this.incoming.values()]) {
      if (TERMINAL_TASK_STATUSES.includes(transfer.task.status)) continue
      const pausedTask = this.createPausedTask(transfer.task)
      transfer.task = rebuildTask(pausedTask, pausedTask.files, 'recoverable')
      this.emitTask(transfer.task)
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
    this.persistRecoverableTask(task)
    for (const listener of this.taskListeners) listener(task)
  }

  private persistRecoverableTask(task: TransferTaskDto): void {
    if (this.recoveryStore === undefined) return
    if (TERMINAL_TASK_STATUSES.includes(task.status)) {
      this.recoveryStore.remove(task.transferId)
      return
    }
    const outgoing = this.outgoing.get(task.transferId)
    if (outgoing !== undefined) {
      if (outgoing.expectedDigests.size !== outgoing.sources.length) return
      this.recoveryStore.save({
        transferId: task.transferId,
        peerDeviceId: task.peer.deviceId,
        kind: 'file',
        direction: 'send',
        payload: {
          format: 'file-v1',
          direction: 'send',
          task,
          sources: outgoing.sources,
          expectedDigests: [...outgoing.expectedDigests],
        },
      })
      return
    }
    const incoming = this.incoming.get(task.transferId)
    if (incoming === undefined || incoming.directoryPath === undefined) return
    const files = [...incoming.files.values()].map((file) => ({
      metadata: file.metadata,
      verifiedChunks: [...file.verifiedChunks],
      ...(file.temporaryPath === undefined ? {} : { temporaryPath: file.temporaryPath }),
    }))
    const stagingPaths = files.flatMap((file) =>
      file.temporaryPath === undefined ? [] : [file.temporaryPath],
    )
    this.recoveryStore.save({
      transferId: task.transferId,
      peerDeviceId: task.peer.deviceId,
      kind: 'file',
      direction: 'receive',
      payload: {
        format: 'file-v1',
        direction: 'receive',
        task,
        files,
        directoryPath: incoming.directoryPath,
      },
      ...(stagingPaths.length === 0 ? {} : { stagingPaths }),
    })
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

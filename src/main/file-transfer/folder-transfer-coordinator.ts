import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { link, lstat, mkdir, open, rm, unlink } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { request as createHttpRequest } from 'node:http'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

import { z } from 'zod'

import {
  DEFAULT_FILE_CHUNK_SIZE_BYTES,
  FOLDER_TRANSFER_TIMEOUT_MS,
  MAX_FOLDER_MANIFEST_CHUNK_BYTES,
  MAX_FOLDER_MANIFEST_CHUNKS,
  MAX_IN_MEMORY_TRANSFER_TASKS,
  MAX_RETIRED_TRANSFER_IDS,
  TRANSFER_IDLE_TIMEOUT_MS,
  TRANSFER_ID_RETENTION_MS,
} from '@shared/constants'
import { errorCodeSchema } from '@shared/errors'
import type { ErrorCode } from '@shared/errors'
import type { FolderOfferReceivedDto } from '@shared/ipc'
import type {
  EncryptedChunkDescriptor,
  FolderManifestMessage,
  TransferResumeStateMessage,
} from '@shared/protocols'
import {
  deviceInfoSchema,
  folderManifestFileSchema,
  secureFolderManifestFileSchema,
} from '@shared/protocols'
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
import { parsePortableRelativePath } from '@shared/utils'

import { assertSafeReceiveDirectory, assertSufficientDiskSpace } from '../security'
import type {
  LoadedRecoverableTransfer,
  RecoverableTransfersStore,
  SessionHistory,
} from '../storage'
import type { ConnectionManager, FolderControlMessage, TransferControlMessage } from '../websocket'
import type { AuthorizedSourceFolder } from './file-access-registry'
import type { AuthorizedFolderFile } from './folder-scanner'
import {
  createChunkDescriptor,
  deriveChunkUploadToken,
  readEncryptedRequest,
  readFileChunk,
  writePlaintextChunk,
} from './chunk-transfer'
import { calculateAuthorizedFileSha256, calculateFileSha256 } from './file-hash'
import { mapFileError } from './file-system'
import {
  assertFolderManifestChunkAllowed,
  hashFolderManifest,
  validateFolderManifest,
} from './folder-manifest-validation'
import { publishFolderStaging } from './folder-publish'
import { rebuildTask, updateAllNonTerminalFiles, updateFile } from './task-state'

type TaskListener = (task: TransferTaskDto) => void
type OfferListener = (offer: FolderOfferReceivedDto) => void

export interface FolderAccessAdapter {
  consumeFolder(selectionToken: string): AuthorizedSourceFolder | null
  resolveReceiveDirectory(directoryToken?: string): Promise<string>
}

type SecureFolderManifestFile = FolderManifestMessage['payload']['files'][number]

interface SecureFolderManifestContents extends Omit<FolderManifestContents, 'files'> {
  readonly files: readonly SecureFolderManifestFile[]
}

interface ManifestChunk {
  readonly files: SecureFolderManifestContents['files']
  readonly emptyDirectories: readonly string[]
}

interface OutgoingFolderTransfer {
  task: TransferTaskDto
  readonly source: AuthorizedSourceFolder
  readonly manifest: SecureFolderManifestContents
  readonly manifestId: ManifestId
  readonly manifestSha256: string
  readonly chunks: readonly ManifestChunk[]
  uploadKey?: string
  tokenExpiresAt?: number
  activeFileId?: FileId
  abortUpload?: () => void
  queuePromise?: Promise<void>
  readonly remoteProgress: Map<FileId, number>
  readonly verifiedChunks: Map<FileId, Set<number>>
  remoteFolderComplete: boolean
  timeout?: ReturnType<typeof setTimeout>
}

interface IncomingFolderFile {
  readonly manifest: SecureFolderManifestFile
  readonly verifiedChunks: Map<number, string>
  temporaryPath?: string
  abortUpload?: () => void
  uploadPromise?: Promise<void>
  failureOverride?: ErrorCode
}

interface IncomingFolderTransfer {
  task?: TransferTaskDto
  readonly peer: DeviceInfo
  connectionId?: ConnectionId
  readonly offer: Extract<FolderControlMessage, { type: 'folder:offer' }>['payload']
  readonly chunks: Map<number, ManifestChunk>
  readonly files: Map<FileId, IncomingFolderFile>
  manifest?: SecureFolderManifestContents
  receiveDirectory?: string
  stagingRoot?: string
  uploadKey?: string
  tokenExpiresAt?: number
  activeFileId?: FileId
  publishedPath?: string
  publishPromise?: Promise<void>
  timeout?: ReturnType<typeof setTimeout>
  preserveInterruption: boolean
}

type UploadOutcome = 'completed' | 'cancelled' | 'failed' | 'paused'

const FOLDER_UPLOAD_ROUTE = /^\/v3\/transfers\/([^/]+)\/files\/([^/]+)\/chunks\/(\d+)$/u
const TERMINAL_TASK_STATUSES: readonly TransferStatus[] = [
  'completed',
  'failed',
  'cancelled',
  'rejected',
]

const recoveredFolderTaskSchema = z
  .object({
    transferId: transferIdSchema,
    direction: z.enum(['send', 'receive']),
    kind: z.literal('folder'),
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
    files: z.array(
      z
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
        .strict(),
    ),
    folder: z
      .object({
        displayName: z.string().min(1).max(512),
        fileCount: z.number().int().nonnegative(),
        emptyDirectoryCount: z.number().int().nonnegative(),
      })
      .strict(),
    totalBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    transferredBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    bytesPerSecond: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    createdAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    updatedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    errorCode: errorCodeSchema.optional(),
  })
  .strict()

const fileIdentitySchema = z
  .object({
    device: z.number().int(),
    inode: z.number().int(),
    modifiedAt: z.number().nonnegative(),
  })
  .strict()
const recoveredAuthorizedFolderFileSchema = z
  .object({
    path: z.string().min(1).max(32_768),
    manifest: folderManifestFileSchema,
    identity: fileIdentitySchema,
  })
  .strict()
const recoveredSourceFolderSchema = z
  .object({
    rootPath: z.string().min(1).max(32_768),
    selection: z
      .object({
        selectionToken: z.string().min(1).max(256),
        displayName: z.string().min(1).max(512),
        fileCount: z.number().int().nonnegative(),
        emptyDirectoryCount: z.number().int().nonnegative(),
        totalSize: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      })
      .strict(),
    manifest: z
      .object({
        displayName: z.string().min(1).max(512),
        totalSize: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        files: z.array(folderManifestFileSchema),
        emptyDirectories: z.array(z.string()),
      })
      .strict(),
    files: z.array(recoveredAuthorizedFolderFileSchema),
  })
  .strict()

const recoveredSecureManifestSchema = z
  .object({
    displayName: z.string().min(1).max(512),
    totalSize: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    files: z.array(secureFolderManifestFileSchema),
    emptyDirectories: z.array(z.string()),
  })
  .strict()

const recoveredFolderOfferSchema = z
  .object({
    transferId: transferIdSchema,
    manifestId: manifestIdSchema,
    displayName: z.string().min(1).max(512),
    fileCount: z.number().int().nonnegative(),
    emptyDirectoryCount: z.number().int().nonnegative(),
    totalSize: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    manifestChunkCount: z.number().int().positive(),
    manifestSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict()

const recoveredFolderPayloadSchema = z
  .object({
    format: z.literal('folder-v1'),
    direction: z.enum(['send', 'receive']),
    task: recoveredFolderTaskSchema,
    source: recoveredSourceFolderSchema.optional(),
    manifest: recoveredSecureManifestSchema,
    manifestId: manifestIdSchema.optional(),
    manifestSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .optional(),
    chunks: z
      .array(
        z
          .object({
            files: z.array(secureFolderManifestFileSchema),
            emptyDirectories: z.array(z.string()),
          })
          .strict(),
      )
      .optional(),
    offer: recoveredFolderOfferSchema.optional(),
    files: z
      .array(
        z
          .object({
            manifest: secureFolderManifestFileSchema,
            verifiedChunks: z.array(
              z.tuple([z.number().int().nonnegative(), z.string().min(1).max(128)]),
            ),
            temporaryPath: z.string().min(1).max(32_768).optional(),
          })
          .strict(),
      )
      .optional(),
    receiveDirectory: z.string().min(1).max(32_768).optional(),
    stagingRoot: z.string().min(1).max(32_768).optional(),
  })
  .strict()

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

const buildManifestChunks = (manifest: SecureFolderManifestContents): readonly ManifestChunk[] => {
  const chunks: ManifestChunk[] = []
  let files: SecureFolderManifestFile[] = []
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
  private readonly restorationFailures: TransferTaskDto[] = []
  private readonly taskListeners = new Set<TaskListener>()
  private readonly offerListeners = new Set<OfferListener>()
  private readonly recordedTransfers = new Map<TransferId, number>()
  private readonly retiredTransferIds = new Map<TransferId, number>()
  private readonly unsubscribeMessages: () => void
  private readonly unsubscribeConnection: () => void
  private readonly unsubscribeTransferMessages: () => void

  public constructor(
    private readonly connectionManager: ConnectionManager,
    private readonly fileAccess: FolderAccessAdapter,
    private readonly canStartTransfer: () => boolean = () => true,
    private readonly history?: SessionHistory,
    private readonly recoveryStore?: RecoverableTransfersStore,
  ) {
    this.unsubscribeMessages = connectionManager.subscribeFolderMessages((message) =>
      this.handleMessage(message),
    )
    this.unsubscribeTransferMessages = connectionManager.subscribeTransferMessages((message) =>
      this.handleTransferControlMessage(message),
    )
    this.unsubscribeConnection = connectionManager.subscribeStatus((status) => {
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
        record.kind !== 'folder' ||
        this.outgoing.has(record.transferId) ||
        this.incoming.has(record.transferId)
      )
        continue
      const parsed = recoveredFolderPayloadSchema.safeParse(record.payload)
      if (!parsed.success) {
        this.recoveryStore?.remove(record.transferId)
        continue
      }
      const task = this.normalizeRecoveredTask(parsed.data.task, record)
      if (task === null) continue
      if (parsed.data.direction === 'send') {
        await this.restoreOutgoingFolder(record, task, parsed.data)
      } else {
        await this.restoreIncomingFolder(record, task, parsed.data)
      }
    }
  }

  private normalizeRecoveredTask(
    task: z.infer<typeof recoveredFolderTaskSchema>,
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
    const normalized: TransferTaskDto = {
      transferId: task.transferId,
      direction: task.direction,
      kind: 'folder',
      peer: task.peer,
      status: task.status,
      files: task.files.map(({ errorCode, ...file }) => ({
        ...file,
        ...(errorCode === undefined ? {} : { errorCode }),
      })),
      folder: task.folder,
      totalBytes: task.totalBytes,
      transferredBytes: task.transferredBytes,
      bytesPerSecond: task.bytesPerSecond,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      ...(task.errorCode === undefined ? {} : { errorCode: task.errorCode }),
    }
    return rebuildTask(
      normalized,
      normalized.files.map((file) =>
        file.status === 'completed'
          ? file
          : { ...file, status: 'paused' as const, bytesPerSecond: 0 },
      ),
      'recoverable',
    )
  }

  private async restoreOutgoingFolder(
    record: LoadedRecoverableTransfer,
    task: TransferTaskDto,
    payload: z.infer<typeof recoveredFolderPayloadSchema>,
  ): Promise<void> {
    if (
      payload.source === undefined ||
      payload.manifestId === undefined ||
      payload.manifestSha256 === undefined ||
      payload.chunks === undefined
    ) {
      this.recoveryStore?.remove(record.transferId)
      return
    }
    try {
      if (
        !isAbsolute(payload.source.rootPath) ||
        hashFolderManifest(payload.manifest) !== payload.manifestSha256
      ) {
        throw new Error('SOURCE_FILE_CHANGED')
      }
      for (const sourceFile of payload.source.files) {
        const secureFile = payload.manifest.files.find(
          (file) => file.fileId === sourceFile.manifest.fileId,
        )
        if (
          secureFile === undefined ||
          (await calculateAuthorizedFileSha256({
            path: sourceFile.path,
            size: sourceFile.manifest.size,
            identity: sourceFile.identity,
          })) !== secureFile.sha256
        ) {
          throw new Error('SOURCE_FILE_CHANGED')
        }
      }
      this.outgoing.set(record.transferId, {
        task,
        source: payload.source,
        manifest: payload.manifest,
        manifestId: payload.manifestId,
        manifestSha256: payload.manifestSha256,
        chunks: payload.chunks,
        remoteProgress: new Map(),
        verifiedChunks: new Map(),
        remoteFolderComplete: false,
      })
    } catch (error) {
      this.recoveryStore?.remove(record.transferId)
      this.registerRestorationFailure(task, mapFileError(error))
    }
  }

  private async restoreIncomingFolder(
    record: LoadedRecoverableTransfer,
    task: TransferTaskDto,
    payload: z.infer<typeof recoveredFolderPayloadSchema>,
  ): Promise<void> {
    if (
      payload.offer === undefined ||
      payload.files === undefined ||
      payload.receiveDirectory === undefined ||
      payload.stagingRoot === undefined
    ) {
      this.recoveryStore?.remove(record.transferId)
      return
    }
    try {
      const receiveDirectory = await assertSafeReceiveDirectory(payload.receiveDirectory)
      if (
        payload.stagingRoot !==
          resolve(receiveDirectory, `.lindu-folder-${record.transferId}.part`) ||
        payload.files.length !== payload.manifest.files.length
      ) {
        throw new Error('RESUME_STATE_INVALID')
      }
      const stagingMetadata = await lstat(payload.stagingRoot)
      if (!stagingMetadata.isDirectory() || stagingMetadata.isSymbolicLink()) {
        throw new Error('RESUME_STATE_INVALID')
      }
      const files = new Map<FileId, IncomingFolderFile>()
      for (const recovered of payload.files) {
        const verifiedChunks = new Map(recovered.verifiedChunks)
        if (
          !payload.manifest.files.some((file) => file.fileId === recovered.manifest.fileId) ||
          [...verifiedChunks.keys()].some((index) => index >= recovered.manifest.chunkCount)
        ) {
          throw new Error('RESUME_STATE_INVALID')
        }
        if (recovered.temporaryPath !== undefined) {
          if (!isWithinDirectory(payload.stagingRoot, recovered.temporaryPath)) {
            throw new Error('RESUME_STATE_INVALID')
          }
          const metadata = await lstat(recovered.temporaryPath)
          if (
            !metadata.isFile() ||
            metadata.isSymbolicLink() ||
            metadata.size !== recovered.manifest.size
          ) {
            throw new Error('RESUME_STATE_INVALID')
          }
        } else if (verifiedChunks.size > 0) {
          throw new Error('RESUME_STATE_INVALID')
        }
        files.set(recovered.manifest.fileId, {
          manifest: recovered.manifest,
          verifiedChunks,
          ...(recovered.temporaryPath === undefined
            ? {}
            : { temporaryPath: recovered.temporaryPath }),
        })
      }
      this.incoming.set(record.transferId, {
        task,
        peer: task.peer,
        offer: payload.offer,
        chunks: new Map(),
        files,
        manifest: payload.manifest,
        receiveDirectory,
        stagingRoot: payload.stagingRoot,
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
      ...[...this.outgoing.values()].map(({ task }) => task),
      ...[...this.incoming.values()].flatMap(({ task }) => (task === undefined ? [] : [task])),
      ...this.restorationFailures,
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
    let manifest: SecureFolderManifestContents
    try {
      const sourceByFileId = new Map(source.files.map((file) => [file.manifest.fileId, file]))
      const files: SecureFolderManifestFile[] = []
      for (const manifestFile of source.manifest.files) {
        const sourceFile = sourceByFileId.get(manifestFile.fileId)
        if (sourceFile === undefined) throw new Error('FILE_NOT_FOUND')
        const sha256 = await calculateAuthorizedFileSha256({
          path: sourceFile.path,
          size: manifestFile.size,
          identity: sourceFile.identity,
        })
        files.push({
          ...manifestFile,
          sha256,
          chunkSize: DEFAULT_FILE_CHUNK_SIZE_BYTES,
          chunkCount: Math.ceil(manifestFile.size / DEFAULT_FILE_CHUNK_SIZE_BYTES),
        })
      }
      manifest = { ...source.manifest, files }
    } catch (error) {
      const failedTask = updateAllNonTerminalFiles(
        createFolderTask(transferId, 'send', peer, source.manifest),
        'failed',
        'failed',
        mapFileError(error),
      )
      this.emitTask(failedTask)
      this.recordHistory(failedTask)
      return failedTask
    }
    const manifestSha256 = hashFolderManifest(manifest)
    const chunks = buildManifestChunks(manifest)
    const transfer: OutgoingFolderTransfer = {
      task: createFolderTask(transferId, 'send', peer, manifest),
      source,
      manifest,
      manifestId,
      manifestSha256,
      chunks,
      remoteProgress: new Map(),
      verifiedChunks: new Map(),
      remoteFolderComplete: false,
    }
    this.outgoing.set(transferId, transfer)
    transfer.timeout = this.createTimeout(() => {
      void this.failOutgoing(transfer, 'TRANSFER_TIMEOUT', true)
    })
    const offered = await this.connectionManager.sendFolderOffer({
      transferId,
      manifestId,
      displayName: manifest.displayName,
      totalSize: manifest.totalSize,
      fileCount: manifest.files.length,
      emptyDirectoryCount: manifest.emptyDirectories.length,
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
      if (transfer.task.files.length === 0) {
        await this.finishIncomingContent(transfer)
      } else {
        for (const file of transfer.files.values()) {
          if (file.manifest.chunkCount === 0) await this.finalizeIncomingFile(transfer, file)
        }
      }
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

  public async pause(transferId: TransferId): Promise<TransferTaskDto | null> {
    const transfer = this.outgoing.get(transferId)
    if (
      transfer === undefined ||
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

  public handleHttpRequest(request: IncomingMessage, response: ServerResponse): boolean {
    const match = FOLDER_UPLOAD_ROUTE.exec(request.url ?? '')
    if (match === null) return false
    const transferId = transferIdSchema.safeParse(match[1])
    const fileId = fileIdSchema.safeParse(match[2])
    const chunkIndex = Number(match[3])
    if (
      !transferId.success ||
      !fileId.success ||
      !Number.isSafeInteger(chunkIndex) ||
      request.method !== 'PUT'
    ) {
      this.writeResponse(response, 400)
      return true
    }
    const transfer = this.incoming.get(transferId.data)
    if (transfer === undefined) return false
    const file = transfer?.files.get(fileId.data)
    const expectedFile = transfer?.task?.files.find((candidate) =>
      ['pending', 'transferring'].includes(candidate.status),
    )
    const authorization = request.headers.authorization
    const contentLength = Number(request.headers['content-length'])
    const connectionStatus = this.connectionManager.getStatus()
    if (file?.uploadPromise !== undefined) {
      this.writeResponse(response, 409)
      return true
    }
    let descriptor: EncryptedChunkDescriptor
    try {
      if (file === undefined) throw new Error('CHUNK_INVALID')
      descriptor = createChunkDescriptor(transferId.data, file.manifest, chunkIndex)
    } catch {
      this.writeResponse(response, 400)
      return true
    }
    const expectedToken =
      transfer.uploadKey === undefined
        ? null
        : deriveChunkUploadToken(transfer.uploadKey, transferId.data, fileId.data, chunkIndex)
    const nextMissingChunk = file === undefined ? -1 : this.getNextMissingChunk(file)
    const isVerifiedDuplicate = file?.verifiedChunks.has(chunkIndex) === true
    if (
      transfer.task === undefined ||
      file === undefined ||
      (!isVerifiedDuplicate && expectedFile?.fileId !== fileId.data) ||
      (!isVerifiedDuplicate && nextMissingChunk !== chunkIndex) ||
      (!isVerifiedDuplicate && !['accepted', 'transferring'].includes(transfer.task.status)) ||
      expectedToken === null ||
      typeof authorization !== 'string' ||
      !authorization.startsWith('Bearer ') ||
      !tokensMatch(authorization.slice(7), expectedToken) ||
      transfer.tokenExpiresAt === undefined ||
      transfer.tokenExpiresAt < Date.now() ||
      !Number.isSafeInteger(contentLength) ||
      contentLength !== descriptor.ciphertextLength ||
      normalizeRemoteAddress(request.socket.remoteAddress) !== transfer.peer.ipAddress ||
      connectionStatus.state !== 'connected' ||
      connectionStatus.connectionId !== transfer.connectionId ||
      request.headers['transfer-encoding'] !== undefined ||
      request.headers['content-type'] !== 'application/octet-stream'
    ) {
      this.writeResponse(response, 403)
      return true
    }
    transfer.activeFileId = fileId.data
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
      delete transfer.activeFileId
    })
    return true
  }

  public async shutdown(preserveRecoverable = false): Promise<void> {
    this.unsubscribeMessages()
    this.unsubscribeTransferMessages()
    this.unsubscribeConnection()
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
      if (incoming?.task !== undefined && !TERMINAL_TASK_STATUSES.includes(incoming.task.status)) {
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

  private async sendIncomingResumeState(transfer: IncomingFolderTransfer): Promise<void> {
    if (
      transfer.task === undefined ||
      transfer.manifest === undefined ||
      TERMINAL_TASK_STATUSES.includes(transfer.task.status)
    ) {
      return
    }
    const connectionStatus = this.connectionManager.getStatus()
    if (connectionStatus.state !== 'connected' || connectionStatus.connectionId === undefined)
      return
    transfer.connectionId = connectionStatus.connectionId
    transfer.preserveInterruption = false
    transfer.uploadKey = randomBytes(32).toString('base64url')
    transfer.tokenExpiresAt = Date.now() + FOLDER_TRANSFER_TIMEOUT_MS
    if (
      !(await this.connectionManager.sendFolderAccept({
        transferId: transfer.offer.transferId,
        uploadKey: transfer.uploadKey,
        expiresAt: transfer.tokenExpiresAt,
      }))
    ) {
      return
    }
    const files: TransferResumeStateMessage['payload']['files'] = transfer.manifest.files.map(
      (manifestFile) => ({
        fileId: manifestFile.fileId,
        size: manifestFile.size,
        sha256: manifestFile.sha256,
        chunkSize: manifestFile.chunkSize,
        chunkCount: manifestFile.chunkCount,
        verifiedRanges: this.createVerifiedRanges(
          transfer.files.get(manifestFile.fileId)?.verifiedChunks ?? new Map(),
          manifestFile.chunkCount,
        ),
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
      transferId: transfer.offer.transferId,
      files,
    })
  }

  private applyOutgoingResumeState(
    transfer: OutgoingFolderTransfer,
    message: TransferResumeStateMessage,
  ): void {
    if (!['verifying', 'reconnecting', 'paused', 'recoverable'].includes(transfer.task.status))
      return
    if (
      message.payload.files.length !== transfer.manifest.files.length ||
      new Set(message.payload.files.map((file) => file.fileId)).size !==
        transfer.manifest.files.length
    ) {
      void this.failOutgoing(transfer, 'RESUME_STATE_INVALID', true)
      return
    }
    try {
      const nextFiles = transfer.task.files.map((taskFile) => {
        const manifestFile = transfer.manifest.files.find((file) => file.fileId === taskFile.fileId)
        const state = message.payload.files.find((file) => file.fileId === taskFile.fileId)
        if (
          manifestFile === undefined ||
          state === undefined ||
          state.size !== manifestFile.size ||
          state.sha256 !== manifestFile.sha256 ||
          state.chunkSize !== manifestFile.chunkSize ||
          state.chunkCount !== manifestFile.chunkCount
        ) {
          throw new Error('RESUME_STATE_INVALID')
        }
        const verified = this.expandVerifiedRanges(state.verifiedRanges, state.chunkCount)
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
      void this.failOutgoing(transfer, 'RESUME_STATE_INVALID', true)
    }
  }

  private createVerifiedRanges(
    verifiedChunks: ReadonlyMap<number, string>,
    chunkCount: number,
  ): TransferResumeStateMessage['payload']['files'][number]['verifiedRanges'] {
    const indexes = [...verifiedChunks.keys()]
      .filter((index) => index < chunkCount)
      .sort((a, b) => a - b)
    const ranges: { start: number; end: number }[] = []
    for (const index of indexes) {
      const previous = ranges.at(-1)
      if (previous !== undefined && previous.end === index) previous.end += 1
      else ranges.push({ start: index, end: index + 1 })
    }
    return ranges
  }

  private expandVerifiedRanges(
    ranges: TransferResumeStateMessage['payload']['files'][number]['verifiedRanges'],
    chunkCount: number,
  ): Set<number> {
    const verified = new Set<number>()
    let previousEnd = 0
    for (const range of ranges) {
      if (range.start < previousEnd || range.end > chunkCount)
        throw new Error('RESUME_STATE_INVALID')
      for (let index = range.start; index < range.end; index += 1) verified.add(index)
      previousEnd = range.end
    }
    return verified
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
      this.isRetiredTransfer(offer.transferId) ||
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
      preserveInterruption: false,
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
    const candidateChunk: ManifestChunk = {
      files: chunk.files,
      emptyDirectories: chunk.emptyDirectories,
    }
    try {
      assertFolderManifestChunkAllowed(transfer.offer, [
        ...transfer.chunks.values(),
        candidateChunk,
      ])
    } catch {
      void this.failIncoming(transfer, 'PROTOCOL_INVALID', true)
      return
    }
    transfer.chunks.set(chunk.chunkIndex, candidateChunk)
    if (transfer.chunks.size !== transfer.offer.manifestChunkCount) return
    try {
      const ordered = [...transfer.chunks.entries()].sort((left, right) => left[0] - right[0])
      const manifest: SecureFolderManifestContents = {
        displayName: transfer.offer.displayName,
        totalSize: transfer.offer.totalSize,
        files: ordered.flatMap(([, value]) => value.files),
        emptyDirectories: ordered.flatMap(([, value]) => value.emptyDirectories),
      }
      validateFolderManifest(transfer.offer, manifest)
      transfer.manifest = manifest
      for (const file of manifest.files) {
        transfer.files.set(file.fileId, { manifest: file, verifiedChunks: new Map() })
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

  private handleAccept(
    accept: Extract<FolderControlMessage, { type: 'folder:accept' }>['payload'],
  ): void {
    const transfer = this.outgoing.get(accept.transferId)
    if (transfer === undefined) return
    if (
      !['awaitingAcceptance', 'paused', 'reconnecting', 'verifying'].includes(
        transfer.task.status,
      ) ||
      accept.expiresAt <= Date.now()
    ) {
      void this.failOutgoing(transfer, 'PROTOCOL_INVALID', true)
      return
    }
    transfer.uploadKey = accept.uploadKey
    transfer.tokenExpiresAt = accept.expiresAt
    if (transfer.task.status === 'awaitingAcceptance') {
      transfer.task = rebuildTask(transfer.task, transfer.task.files, 'accepted')
      this.emitTask(transfer.task)
      this.startOutgoingQueue(transfer)
    }
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
      if (
        transfer.task.files.find((file) => file.fileId === source.manifest.fileId)?.status ===
        'completed'
      )
        continue
      const outcome = await this.uploadFile(transfer, source, uploadKey)
      if (outcome !== 'completed') break
    }
    if (['paused', 'reconnecting', 'verifying', 'recoverable'].includes(transfer.task.status))
      return
    if (
      transfer.task.status !== 'completed' &&
      transfer.task.files.every((file) => file.status === 'completed')
    ) {
      transfer.task = rebuildTask(transfer.task, transfer.task.files, 'publishing')
      this.emitTask(transfer.task)
      if (transfer.remoteFolderComplete) this.completeOutgoingFolder(transfer)
    }
  }

  private startOutgoingQueue(transfer: OutgoingFolderTransfer): void {
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
    transfer: OutgoingFolderTransfer,
    sourceFile: AuthorizedFolderFile,
    uploadKey: string,
  ): Promise<UploadOutcome> {
    const fileId = sourceFile.manifest.fileId
    const startedAt = Date.now()
    const secureManifest = transfer.manifest.files.find((file) => file.fileId === fileId)
    if (secureManifest === undefined) return 'failed'
    const verifiedChunks = transfer.verifiedChunks.get(fileId) ?? new Set<number>()
    transfer.verifiedChunks.set(fileId, verifiedChunks)
    const resumedBytes = [...verifiedChunks].reduce(
      (total, chunkIndex) =>
        total +
        createChunkDescriptor(transfer.task.transferId, secureManifest, chunkIndex).plaintextLength,
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
      const expectedDigest = secureManifest.sha256
      if (
        (await calculateAuthorizedFileSha256({
          path: sourceFile.path,
          size: sourceFile.manifest.size,
          identity: sourceFile.identity,
        })) !== expectedDigest
      ) {
        throw new Error('SOURCE_FILE_CHANGED')
      }
      for (let chunkIndex = 0; chunkIndex < secureManifest.chunkCount; chunkIndex += 1) {
        if (verifiedChunks.has(chunkIndex)) continue
        if (['paused', 'reconnecting', 'recoverable'].includes(transfer.task.status)) {
          throw new Error('TRANSFER_CANCELLED')
        }
        const descriptor = createChunkDescriptor(
          transfer.task.transferId,
          secureManifest,
          chunkIndex,
        )
        const plaintext = await readFileChunk(sourceHandle, descriptor)
        const encrypted = this.connectionManager.encryptFileChunk(descriptor, plaintext)
        plaintext.fill(0)
        if (encrypted === null) throw new Error('CONNECTION_CLOSED')
        try {
          await this.uploadEncryptedChunk(transfer, descriptor, encrypted, uploadKey)
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
      if (secureManifest.chunkCount === 0) return 'completed'
      this.completeOutgoingFile(transfer, fileId)
      return 'completed'
    } catch (error) {
      if (['paused', 'reconnecting', 'recoverable'].includes(transfer.task.status)) return 'paused'
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

  private uploadEncryptedChunk(
    transfer: OutgoingFolderTransfer,
    descriptor: EncryptedChunkDescriptor,
    encrypted: Buffer,
    uploadKey: string,
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
              uploadKey,
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
    transfer: IncomingFolderTransfer,
    file: IncomingFolderFile,
    descriptor: EncryptedChunkDescriptor,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (transfer.task === undefined || transfer.stagingRoot === undefined) {
      this.writeResponse(response, 403)
      return
    }
    const fileId = file.manifest.fileId
    const startedAt = Date.now()
    try {
      if (file.temporaryPath === undefined) {
        file.temporaryPath = resolve(transfer.stagingRoot, `.lindu-file-${randomUUID()}.part`)
        const temporaryHandle = await open(file.temporaryPath, 'wx+', 0o600)
        try {
          await temporaryHandle.truncate(file.manifest.size)
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
          createChunkDescriptor(transfer.offer.transferId, file.manifest, chunkIndex)
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
      await this.connectionManager.sendFolderProgress({
        transferId: transfer.offer.transferId,
        fileId,
        transferredBytes: receivedBytes,
        totalTransferredBytes: transfer.task.transferredBytes,
      })
      if (file.verifiedChunks.size === file.manifest.chunkCount) {
        await this.finalizeIncomingFile(transfer, file)
      }
      this.writeResponse(response, 200)
    } catch (error) {
      if (
        transfer.preserveInterruption ||
        transfer.task === undefined ||
        ['paused', 'reconnecting'].includes(transfer.task.status)
      ) {
        delete file.abortUpload
        delete file.failureOverride
        if (!response.writableEnded) this.writeResponse(response, 409)
        return
      }
      if (file.temporaryPath !== undefined) await unlink(file.temporaryPath).catch(() => undefined)
      delete file.temporaryPath
      const errorCode = file.failureOverride ?? mapFileError(error)
      if (errorCode === 'TRANSFER_CANCELLED') {
        await this.failIncoming(transfer, 'TRANSFER_CANCELLED')
        this.writeResponse(response, 409)
      } else {
        await this.failIncoming(transfer, errorCode)
        this.writeResponse(response, errorCode === 'CHUNK_INVALID' ? 422 : 500)
        await this.connectionManager.sendFolderError({
          transferId: transfer.offer.transferId,
          fileId,
          errorCode,
        })
      }
      delete file.failureOverride
    }
  }

  private getNextMissingChunk(file: IncomingFolderFile): number {
    for (let chunkIndex = 0; chunkIndex < file.manifest.chunkCount; chunkIndex += 1) {
      if (!file.verifiedChunks.has(chunkIndex)) return chunkIndex
    }
    return file.manifest.chunkCount
  }

  private async finalizeIncomingFile(
    transfer: IncomingFolderTransfer,
    file: IncomingFolderFile,
  ): Promise<void> {
    if (transfer.task === undefined || transfer.stagingRoot === undefined) {
      throw new Error('PROTOCOL_INVALID')
    }
    if (file.temporaryPath === undefined) {
      file.temporaryPath = resolve(transfer.stagingRoot, `.lindu-file-${randomUUID()}.part`)
      const emptyHandle = await open(file.temporaryPath, 'wx', 0o600)
      await emptyHandle.close()
    }
    if ((await calculateFileSha256(file.temporaryPath)) !== file.manifest.sha256) {
      throw new Error('FILE_INTEGRITY_FAILED')
    }
    const targetPath = resolveManifestPath(transfer.stagingRoot, file.manifest.relativePath)
    await mkdir(dirname(targetPath), { recursive: true, mode: 0o700 })
    await link(file.temporaryPath, targetPath)
    await unlink(file.temporaryPath)
    delete file.temporaryPath
    transfer.task = updateFile(
      transfer.task,
      file.manifest.fileId,
      'completed',
      file.manifest.size,
      0,
      transfer.task.files.every(
        (item) => item.fileId === file.manifest.fileId || item.status === 'completed',
      )
        ? 'publishing'
        : 'transferring',
    )
    this.emitTask(transfer.task)
    await this.connectionManager.sendFolderComplete({
      scope: 'file',
      transferId: transfer.offer.transferId,
      fileId: file.manifest.fileId,
      size: file.manifest.size,
    })
    if (transfer.task.files.every((item) => item.status === 'completed')) {
      await this.finishIncomingContent(transfer)
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

  private markTransfersReconnecting(): void {
    for (const transfer of this.outgoing.values()) {
      if (TERMINAL_TASK_STATUSES.includes(transfer.task.status)) continue
      const pausedTask = this.createPausedTask(transfer.task)
      transfer.task = rebuildTask(pausedTask, pausedTask.files, 'reconnecting')
      transfer.abortUpload?.()
      this.emitTask(transfer.task)
    }
    for (const transfer of this.incoming.values()) {
      if (transfer.task === undefined || TERMINAL_TASK_STATUSES.includes(transfer.task.status)) {
        continue
      }
      transfer.preserveInterruption = true
      const pausedTask = this.createPausedTask(transfer.task)
      transfer.task = rebuildTask(pausedTask, pausedTask.files, 'reconnecting')
      for (const file of transfer.files.values()) file.abortUpload?.()
      this.emitTask(transfer.task)
    }
  }

  private markRecoverableTransfers(): void {
    for (const transfer of this.outgoing.values()) {
      if (TERMINAL_TASK_STATUSES.includes(transfer.task.status)) continue
      const pausedTask = this.createPausedTask(transfer.task)
      transfer.task = rebuildTask(pausedTask, pausedTask.files, 'recoverable')
      this.emitTask(transfer.task)
    }
    for (const transfer of this.incoming.values()) {
      if (transfer.task === undefined || TERMINAL_TASK_STATUSES.includes(transfer.task.status)) {
        continue
      }
      const pausedTask = this.createPausedTask(transfer.task)
      transfer.task = rebuildTask(pausedTask, pausedTask.files, 'recoverable')
      this.emitTask(transfer.task)
    }
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
    if (transfer.task === undefined) {
      this.retireTransfer(transfer.offer.transferId)
      this.incoming.delete(transfer.offer.transferId)
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

  private recordHistory(task: TransferTaskDto): void {
    this.retireTransfer(task.transferId)
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
    this.recordedTransfers.set(task.transferId, Date.now())
    this.pruneIdentifierMap(this.recordedTransfers, MAX_RETIRED_TRANSFER_IDS)
  }

  private isRetiredTransfer(transferId: TransferId): boolean {
    this.pruneIdentifierMap(this.retiredTransferIds, MAX_RETIRED_TRANSFER_IDS)
    return this.retiredTransferIds.has(transferId)
  }

  private retireTransfer(transferId: TransferId): void {
    this.retiredTransferIds.set(transferId, Date.now())
    this.pruneIdentifierMap(this.retiredTransferIds, MAX_RETIRED_TRANSFER_IDS)
    this.pruneTransfers()
  }

  private pruneIdentifierMap(
    identifiers: Map<TransferId, number>,
    maximumEntries: number,
    now = Date.now(),
  ): void {
    for (const [transferId, retiredAt] of identifiers) {
      if (now - retiredAt > TRANSFER_ID_RETENTION_MS) identifiers.delete(transferId)
    }
    while (identifiers.size > maximumEntries) {
      const oldest = identifiers.keys().next().value
      if (oldest === undefined) return
      identifiers.delete(oldest)
    }
  }

  private pruneTransfers(): void {
    const prune = <T extends { task?: TransferTaskDto }>(transfers: Map<TransferId, T>): void => {
      const terminal = [...transfers.entries()]
        .filter(([, transfer]) => {
          const status = transfer.task?.status
          return status !== undefined && TERMINAL_TASK_STATUSES.includes(status)
        })
        .sort((left, right) => (left[1].task?.updatedAt ?? 0) - (right[1].task?.updatedAt ?? 0))
      while (transfers.size > MAX_IN_MEMORY_TRANSFER_TASKS) {
        const oldest = terminal.shift()
        if (oldest === undefined) return
        transfers.delete(oldest[0])
      }
    }
    prune(this.outgoing)
    prune(this.incoming)
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
      this.recoveryStore.save({
        transferId: task.transferId,
        peerDeviceId: task.peer.deviceId,
        kind: 'folder',
        direction: 'send',
        payload: {
          format: 'folder-v1',
          direction: 'send',
          task,
          source: outgoing.source,
          manifest: outgoing.manifest,
          manifestId: outgoing.manifestId,
          manifestSha256: outgoing.manifestSha256,
          chunks: outgoing.chunks,
        },
      })
      return
    }
    const incoming = this.incoming.get(task.transferId)
    if (
      incoming?.manifest === undefined ||
      incoming.receiveDirectory === undefined ||
      incoming.stagingRoot === undefined
    ) {
      return
    }
    this.recoveryStore.save({
      transferId: task.transferId,
      peerDeviceId: task.peer.deviceId,
      kind: 'folder',
      direction: 'receive',
      payload: {
        format: 'folder-v1',
        direction: 'receive',
        task,
        offer: incoming.offer,
        manifest: incoming.manifest,
        files: [...incoming.files.values()].map((file) => ({
          manifest: file.manifest,
          verifiedChunks: [...file.verifiedChunks],
          ...(file.temporaryPath === undefined ? {} : { temporaryPath: file.temporaryPath }),
        })),
        receiveDirectory: incoming.receiveDirectory,
        stagingRoot: incoming.stagingRoot,
      },
      stagingPaths: [incoming.stagingRoot],
    })
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

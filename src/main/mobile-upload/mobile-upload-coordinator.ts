import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { open, unlink } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'

import {
  MAX_ENCRYPTED_ENVELOPE_BYTES,
  MAX_MOBILE_UPLOAD_NONCES,
  MOBILE_UPLOAD_SESSION_TTL_MS,
  DEFAULT_FILE_CHUNK_SIZE_BYTES,
  DEFAULT_SERVICE_PORT,
  TRANSFER_IDLE_TIMEOUT_MS,
} from '@shared/constants'
import {
  isMobileUploadRequestTimestampCurrent,
  mobileUploadOfferRequestSchema,
} from '@shared/protocols'
import { mobileUploadBatchIdSchema, mobileUploadSessionIdSchema } from '@shared/types'
import type {
  DeviceId,
  MobileUploadBatchId,
  MobileDownloadBatchDto,
  MobileUploadOfferDto,
  MobileUploadSessionDto,
  MobileUploadSessionId,
  MobileUploadTaskDto,
} from '@shared/types'

import { publishTemporaryFile } from '../file-transfer'
import type { AuthorizedSourceFile } from '../file-transfer'
import { mapFileError } from '../file-transfer/file-system'

export interface MobileUploadSessionCredentials {
  readonly session: MobileUploadSessionDto
  readonly secret: string
}

type SessionListener = (session: MobileUploadSessionDto | null) => void
type OfferListener = (offer: MobileUploadOfferDto | null) => void
type TaskListener = (task: MobileUploadTaskDto) => void
type DownloadsListener = (batch: MobileDownloadBatchDto | null) => void

interface ActiveMobileUploadSession {
  readonly sessionId: MobileUploadSessionId
  readonly secret: string
  readonly origins: readonly string[]
  readonly createdAt: number
  readonly expiresAt: number
  timeout: ReturnType<typeof setTimeout>
  readonly usedNonces: Map<string, number>
}

export interface MobileUploadFileAccess {
  resolveReceiveDirectory(directoryToken?: string): Promise<string>
  consumeTransferSelections?(
    fileSelectionTokens: readonly string[],
    folderSelectionTokens: readonly string[],
  ): { readonly files: readonly AuthorizedSourceFile[] } | null
}

export interface MobileUploadHistory {
  add(
    entry: {
      readonly direction: 'send' | 'receive'
      readonly kind: 'file'
      readonly peer: {
        readonly deviceId: DeviceId
        readonly deviceName: string
        readonly operatingSystem: 'macos'
        readonly ipAddress: string
        readonly servicePort: number
      }
      readonly status: 'completed'
      readonly displayName: string
      readonly size: number
      readonly createdAt: number
    },
    receivedPath?: string,
  ): unknown
}

interface ReceivingMobileFile {
  readonly fileId: MobileUploadTaskDto['files'][number]['fileId']
  readonly displayName: string
  readonly size: number
  readonly temporaryPath: string
  readonly handle: FileHandle
  receivedBytes: number
  nextChunkIndex: number
  published: boolean
}

interface ReceivingMobileBatch {
  readonly directoryPath: string
  readonly files: ReceivingMobileFile[]
  activeRequest: boolean
  cancelled: boolean
}

interface PublishedMobileDownloadFile {
  readonly source: AuthorizedSourceFile
  readonly token: string
  downloaded: boolean
}

interface PublishedMobileDownloadBatch {
  readonly files: PublishedMobileDownloadFile[]
  readonly createdAt: number
  updatedAt: number
  sourceAddress: string | null
}

const MOBILE_PAGE_PATTERN = /^\/mobile\/([^/?]+)$/u
const MOBILE_OFFER_PATTERN = /^\/mobile\/([^/?]+)\/offers$/u
const MOBILE_STATUS_PATTERN = /^\/mobile\/([^/?]+)\/offers\/([^/?]+)$/u
const MOBILE_CHUNK_PATTERN =
  /^\/mobile\/([^/?]+)\/batches\/([^/?]+)\/files\/([^/?]+)\/chunks\/(\d+)$/u
const MOBILE_CANCEL_PATTERN = /^\/mobile\/([^/?]+)\/batches\/([^/?]+)\/cancel$/u
const MOBILE_DOWNLOADS_PATTERN = /^\/mobile\/([^/?]+)\/downloads$/u
const MOBILE_DOWNLOAD_FILE_PATTERN =
  /^\/mobile\/([^/?]+)\/downloads\/([^/?]+)\/([a-zA-Z0-9_-]{43})$/u
const MOBILE_BROWSER_DEVICE_ID = '00000000-0000-4000-8000-000000000006' as DeviceId

const buildSessionDto = (
  session: ActiveMobileUploadSession,
  state: MobileUploadSessionDto['state'] = 'active',
): MobileUploadSessionDto => ({
  sessionId: session.sessionId,
  state,
  urls: session.origins.map(
    (origin) => `${origin}/mobile/${session.sessionId}#key=${session.secret}`,
  ),
  createdAt: session.createdAt,
  expiresAt: session.expiresAt,
})

export class MobileUploadCoordinator {
  private activeSession: ActiveMobileUploadSession | null = null
  private readonly listeners = new Set<SessionListener>()
  private readonly offerListeners = new Set<OfferListener>()
  private readonly taskListeners = new Set<TaskListener>()
  private readonly downloadsListeners = new Set<DownloadsListener>()
  private pendingTask: MobileUploadTaskDto | null = null
  private receivingBatch: ReceivingMobileBatch | null = null
  private readonly receivedPaths = new Map<MobileUploadBatchId, string>()
  private publishedDownloads: PublishedMobileDownloadBatch | null = null

  public constructor(
    private readonly getOrigins: () => readonly string[],
    private readonly fileAccess?: MobileUploadFileAccess,
    private readonly history?: MobileUploadHistory,
    private readonly now: () => number = Date.now,
  ) {}

  public createSession(): MobileUploadSessionCredentials {
    this.closeSession()
    const createdAt = this.now()
    const session: ActiveMobileUploadSession = {
      sessionId: mobileUploadSessionIdSchema.parse(randomUUID()),
      secret: randomBytes(32).toString('base64url'),
      origins: [...new Set(this.getOrigins())],
      createdAt,
      expiresAt: createdAt + MOBILE_UPLOAD_SESSION_TTL_MS,
      timeout: setTimeout(() => this.expireSession(), MOBILE_UPLOAD_SESSION_TTL_MS),
      usedNonces: new Map(),
    }
    session.timeout.unref()
    this.activeSession = session
    const dto = buildSessionDto(session)
    this.emit(dto)
    return { session: dto, secret: session.secret }
  }

  public getSession(): MobileUploadSessionDto | null {
    const session = this.getActiveSession()
    return session === null ? null : buildSessionDto(session)
  }

  public getSecret(sessionId: MobileUploadSessionId): string | null {
    const session = this.getActiveSession()
    return session?.sessionId === sessionId ? session.secret : null
  }

  public closeSession(): MobileUploadSessionDto | null {
    const session = this.activeSession
    if (session === null) return null
    clearTimeout(session.timeout)
    this.activeSession = null
    if (this.pendingTask !== null && !isTerminal(this.pendingTask.status)) {
      this.pendingTask = this.updateTask(this.pendingTask, 'cancelled', 'MOBILE_SESSION_EXPIRED')
    }
    void this.cleanupReceivingBatch()
    this.pendingTask = null
    this.clearDownloads()
    const dto = buildSessionDto(session, 'closed')
    this.emit(null)
    return dto
  }

  public subscribe(listener: SessionListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  public subscribeOffers(listener: OfferListener): () => void {
    this.offerListeners.add(listener)
    return () => this.offerListeners.delete(listener)
  }

  public subscribeTasks(listener: TaskListener): () => void {
    this.taskListeners.add(listener)
    return () => this.taskListeners.delete(listener)
  }

  public subscribeDownloads(listener: DownloadsListener): () => void {
    this.downloadsListeners.add(listener)
    return () => this.downloadsListeners.delete(listener)
  }

  public publishDownloads(selectionTokens: readonly string[]): MobileDownloadBatchDto | null {
    if (
      this.getActiveSession() === null ||
      this.fileAccess?.consumeTransferSelections === undefined
    ) {
      return null
    }
    const selections = this.fileAccess.consumeTransferSelections(selectionTokens, [])
    if (selections === null || selections.files.length !== selectionTokens.length) return null
    const timestamp = this.now()
    this.publishedDownloads = {
      files: selections.files.map((source) => ({
        source,
        token: randomBytes(32).toString('base64url'),
        downloaded: false,
      })),
      createdAt: timestamp,
      updatedAt: timestamp,
      sourceAddress: null,
    }
    const dto = this.getDownloads()
    for (const listener of this.downloadsListeners) listener(dto)
    return dto
  }

  public getDownloads(): MobileDownloadBatchDto | null {
    const batch = this.publishedDownloads
    if (batch === null) return null
    return {
      files: batch.files.map(({ source, downloaded }) => ({
        fileId: source.selection.fileId,
        displayName: source.selection.displayName,
        size: source.selection.size,
        mimeType: source.selection.mimeType,
        status: downloaded ? 'downloaded' : 'available',
      })),
      createdAt: batch.createdAt,
      updatedAt: batch.updatedAt,
    }
  }

  public clearDownloads(): void {
    if (this.publishedDownloads === null) return
    this.publishedDownloads = null
    for (const listener of this.downloadsListeners) listener(null)
  }

  public getPendingOffer(): MobileUploadOfferDto | null {
    return this.pendingTask?.status === 'awaitingAcceptance' ? this.pendingTask : null
  }

  public async respondToOffer(
    batchId: MobileUploadBatchId,
    decision: 'accept' | 'reject',
    directoryToken?: string,
  ): Promise<MobileUploadTaskDto | null> {
    const task = this.pendingTask
    if (task === null || task.batchId !== batchId || task.status !== 'awaitingAcceptance') {
      return null
    }
    if (decision === 'accept') {
      if (this.fileAccess === undefined) return null
      try {
        const directoryPath = await this.fileAccess.resolveReceiveDirectory(directoryToken)
        const files: ReceivingMobileFile[] = []
        for (const file of task.files) {
          const temporaryPath = join(
            directoryPath,
            `.lan-transfer-mobile-${task.batchId}-${file.fileId}.part`,
          )
          const handle = await open(temporaryPath, 'wx', 0o600)
          await handle.truncate(file.size)
          files.push({
            fileId: file.fileId,
            displayName: file.displayName,
            size: file.size,
            temporaryPath,
            handle,
            receivedBytes: 0,
            nextChunkIndex: 0,
            published: false,
          })
        }
        this.receivingBatch = { directoryPath, files, activeRequest: false, cancelled: false }
        this.pendingTask = this.updateTask(task, 'accepted')
      } catch (error) {
        await this.cleanupReceivingBatch()
        this.pendingTask = this.updateTask(task, 'failed', mapFileError(error))
      }
    } else {
      this.pendingTask = this.updateTask(task, 'rejected')
    }
    this.emitOffer(null)
    return this.pendingTask
  }

  public async cancel(batchId: MobileUploadBatchId): Promise<MobileUploadTaskDto | null> {
    const task = this.pendingTask
    if (task === null || task.batchId !== batchId || isTerminal(task.status)) return null
    await this.cleanupReceivingBatch()
    this.pendingTask = this.updateTask(task, 'cancelled', 'TRANSFER_CANCELLED')
    this.emitOffer(null)
    return this.pendingTask
  }

  public getReceivedPath(batchId: MobileUploadBatchId): string | null {
    return this.receivedPaths.get(batchId) ?? null
  }

  public handleHttpRequest(request: IncomingMessage, response: ServerResponse): boolean {
    const path = request.url ?? ''
    const pageMatch = request.method === 'GET' ? MOBILE_PAGE_PATTERN.exec(path) : null
    if (pageMatch !== null) {
      this.servePage(pageMatch[1] ?? '', response)
      return true
    }
    const offerMatch = request.method === 'POST' ? MOBILE_OFFER_PATTERN.exec(path) : null
    if (offerMatch !== null) {
      void this.receiveOffer(offerMatch[1] ?? '', request, response)
      return true
    }
    const statusMatch = request.method === 'GET' ? MOBILE_STATUS_PATTERN.exec(path) : null
    if (statusMatch !== null) {
      void this.serveStatus(statusMatch[1] ?? '', statusMatch[2] ?? '', request, response)
      return true
    }
    const chunkMatch = request.method === 'PUT' ? MOBILE_CHUNK_PATTERN.exec(path) : null
    if (chunkMatch !== null) {
      void this.receiveChunk(chunkMatch, request, response)
      return true
    }
    const cancelMatch = request.method === 'POST' ? MOBILE_CANCEL_PATTERN.exec(path) : null
    if (cancelMatch !== null) {
      void this.receiveCancellation(cancelMatch, request, response)
      return true
    }
    const downloadsMatch = request.method === 'GET' ? MOBILE_DOWNLOADS_PATTERN.exec(path) : null
    if (downloadsMatch !== null) {
      void this.serveDownloads(downloadsMatch[1] ?? '', request, response)
      return true
    }
    const downloadFileMatch =
      request.method === 'GET' ? MOBILE_DOWNLOAD_FILE_PATTERN.exec(path) : null
    if (downloadFileMatch !== null) {
      void this.serveDownloadFile(downloadFileMatch, request, response)
      return true
    }
    return false
  }

  public shutdown(): void {
    void this.cleanupReceivingBatch()
    this.closeSession()
    this.listeners.clear()
    this.offerListeners.clear()
    this.taskListeners.clear()
    this.downloadsListeners.clear()
  }

  private getActiveSession(): ActiveMobileUploadSession | null {
    const session = this.activeSession
    if (session !== null && session.expiresAt <= this.now()) {
      this.expireSession()
      return null
    }
    return session
  }

  private expireSession(): void {
    const session = this.activeSession
    if (session === null) return
    clearTimeout(session.timeout)
    this.activeSession = null
    if (this.pendingTask?.status === 'awaitingAcceptance') {
      this.pendingTask = this.updateTask(this.pendingTask, 'failed', 'MOBILE_SESSION_EXPIRED')
    }
    this.pendingTask = null
    this.clearDownloads()
    this.emit(null)
  }

  private emit(session: MobileUploadSessionDto | null): void {
    for (const listener of this.listeners) listener(session)
  }

  private emitOffer(offer: MobileUploadOfferDto | null): void {
    for (const listener of this.offerListeners) listener(offer)
  }

  private updateTask(
    task: MobileUploadTaskDto,
    status: MobileUploadTaskDto['status'],
    errorCode?: MobileUploadTaskDto['errorCode'],
  ): MobileUploadTaskDto {
    const updated: MobileUploadTaskDto = {
      ...task,
      status,
      fileItems: task.fileItems.map((file) => ({
        ...file,
        status:
          status === 'completed'
            ? 'completed'
            : status === 'failed'
              ? file.status === 'completed'
                ? 'completed'
                : 'failed'
              : status === 'cancelled'
                ? file.status === 'completed'
                  ? 'completed'
                  : 'cancelled'
                : status === 'rejected'
                  ? 'rejected'
                  : file.status,
        ...(errorCode === undefined || file.status === 'completed' ? {} : { errorCode }),
      })),
      updatedAt: this.now(),
      ...(errorCode === undefined ? {} : { errorCode }),
    }
    for (const listener of this.taskListeners) listener(updated)
    return updated
  }

  private servePage(sessionIdInput: string, response: ServerResponse): void {
    const sessionId = mobileUploadSessionIdSchema.safeParse(sessionIdInput)
    const session = this.getActiveSession()
    if (!sessionId.success || session?.sessionId !== sessionId.data) {
      this.writeJson(response, 404, { error: 'MOBILE_SESSION_EXPIRED' })
      return
    }
    const html = createMobileUploadPage(session.sessionId)
    response.writeHead(200, this.securityHeaders('text/html; charset=utf-8', html))
    response.end(html)
  }

  private async receiveOffer(
    sessionIdInput: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const session = this.authorizeSession(sessionIdInput, request)
    if (session === null) {
      this.writeJson(response, 401, { error: 'MOBILE_REQUEST_UNAUTHORIZED' })
      return
    }
    const body = await this.readJsonBody(request, response)
    if (body === null) return
    if (!this.verifyRequest(session, request, body.raw)) {
      this.writeJson(response, 401, { error: 'MOBILE_REQUEST_UNAUTHORIZED' })
      return
    }
    const parsed = mobileUploadOfferRequestSchema.safeParse(body.value)
    if (!parsed.success) {
      this.writeJson(response, 400, { error: 'MESSAGE_INVALID' })
      return
    }
    if (this.pendingTask !== null && !isTerminal(this.pendingTask.status)) {
      this.writeJson(response, 409, { error: 'MOBILE_OFFER_CONFLICT' })
      return
    }
    const now = this.now()
    const sourceAddress = normalizeAddress(request.socket.remoteAddress)
    const totalBytes = parsed.data.files.reduce((total, file) => total + file.size, 0)
    const task: MobileUploadTaskDto = {
      sessionId: session.sessionId,
      batchId: parsed.data.batchId,
      sourceAddress,
      files: parsed.data.files,
      totalBytes,
      receivedAt: now,
      status: 'awaitingAcceptance',
      fileItems: parsed.data.files.map((file) => ({
        ...file,
        status: 'pending',
        transferredBytes: 0,
      })),
      transferredBytes: 0,
      updatedAt: now,
    }
    this.pendingTask = task
    this.emitOffer(task)
    for (const listener of this.taskListeners) listener(task)
    this.writeJson(response, 202, publicTaskStatus(task))
  }

  private async serveStatus(
    sessionIdInput: string,
    batchIdInput: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const session = this.authorizeSession(sessionIdInput, request)
    const batchId = mobileUploadBatchIdSchema.safeParse(batchIdInput)
    if (session === null || !batchId.success || !this.verifyRequest(session, request, '')) {
      this.writeJson(response, 401, { error: 'MOBILE_REQUEST_UNAUTHORIZED' })
      return
    }
    const task = this.pendingTask
    if (
      task === null ||
      task.batchId !== batchId.data ||
      task.sourceAddress !== normalizeAddress(request.socket.remoteAddress)
    ) {
      this.writeJson(response, 404, { error: 'MESSAGE_INVALID' })
      return
    }
    this.writeJson(response, 200, publicTaskStatus(task))
  }

  private authorizeSession(
    sessionIdInput: string,
    request: IncomingMessage,
  ): ActiveMobileUploadSession | null {
    const sessionId = mobileUploadSessionIdSchema.safeParse(sessionIdInput)
    const session = this.getActiveSession()
    if (!sessionId.success || session?.sessionId !== sessionId.data) return null
    const origin = request.headers.origin
    if (typeof origin === 'string' && !session.origins.includes(origin)) return null
    return session
  }

  private verifyRequest(
    session: ActiveMobileUploadSession,
    request: IncomingMessage,
    _rawBody: string | Buffer,
  ): boolean {
    void _rawBody
    const timestamp = Number(request.headers['x-lindu-timestamp'])
    const nonce = request.headers['x-lindu-nonce']
    const sessionKey = request.headers['x-lindu-session-key']
    if (
      !Number.isSafeInteger(timestamp) ||
      !isMobileUploadRequestTimestampCurrent(timestamp, this.now()) ||
      typeof nonce !== 'string' ||
      !/^[a-zA-Z0-9_-]{16,128}$/u.test(nonce) ||
      typeof sessionKey !== 'string' ||
      !/^[a-zA-Z0-9_-]{43}$/u.test(sessionKey) ||
      session.usedNonces.has(nonce)
    ) {
      return false
    }
    const expectedBuffer = Buffer.from(session.secret)
    const actualBuffer = Buffer.from(sessionKey)
    if (
      expectedBuffer.length !== actualBuffer.length ||
      !timingSafeEqual(expectedBuffer, actualBuffer)
    ) {
      return false
    }
    session.usedNonces.set(nonce, timestamp)
    while (session.usedNonces.size > MAX_MOBILE_UPLOAD_NONCES) {
      const oldest = session.usedNonces.keys().next().value
      if (oldest === undefined) break
      session.usedNonces.delete(oldest)
    }
    return true
  }

  private async readJsonBody(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<{ readonly raw: string; readonly value: unknown } | null> {
    const contentLength = Number(request.headers['content-length'])
    if (
      request.headers['content-type'] !== 'application/json' ||
      !Number.isSafeInteger(contentLength) ||
      contentLength <= 0 ||
      contentLength > MAX_ENCRYPTED_ENVELOPE_BYTES ||
      request.headers['transfer-encoding'] !== undefined
    ) {
      this.writeJson(response, 400, { error: 'MESSAGE_INVALID' })
      return null
    }
    const chunks: Buffer[] = []
    let received = 0
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      received += buffer.length
      if (received > contentLength) {
        this.writeJson(response, 400, { error: 'MESSAGE_INVALID' })
        request.destroy()
        return null
      }
      chunks.push(buffer)
    }
    if (received !== contentLength) {
      this.writeJson(response, 400, { error: 'MESSAGE_INVALID' })
      return null
    }
    const raw = Buffer.concat(chunks).toString('utf8')
    try {
      return { raw, value: JSON.parse(raw) as unknown }
    } catch {
      this.writeJson(response, 400, { error: 'MESSAGE_INVALID' })
      return null
    }
  }

  private async receiveChunk(
    match: RegExpExecArray,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const session = this.authorizeSession(match[1] ?? '', request)
    const batchId = mobileUploadBatchIdSchema.safeParse(match[2] ?? '')
    const fileId = this.pendingTask?.files.find(({ fileId: id }) => id === match[3])?.fileId
    const chunkIndex = Number(match[4])
    const task = this.pendingTask
    const batch = this.receivingBatch
    if (
      session === null ||
      !batchId.success ||
      task === null ||
      batch === null ||
      task.batchId !== batchId.data ||
      task.sourceAddress !== normalizeAddress(request.socket.remoteAddress) ||
      fileId === undefined ||
      !Number.isSafeInteger(chunkIndex) ||
      chunkIndex < 0 ||
      !['accepted', 'transferring'].includes(task.status) ||
      batch.activeRequest
    ) {
      this.writeJson(response, 409, { error: 'CHUNK_INVALID' })
      return
    }
    const fileIndex = batch.files.findIndex((file) => file.fileId === fileId)
    const firstIncompleteIndex = batch.files.findIndex((file) => !file.published)
    const file = batch.files[fileIndex]
    if (
      file === undefined ||
      (firstIncompleteIndex >= 0 && fileIndex !== firstIncompleteIndex) ||
      file.nextChunkIndex !== chunkIndex
    ) {
      this.writeJson(response, 409, { error: 'CHUNK_INVALID' })
      return
    }
    const expectedLength = Math.min(DEFAULT_FILE_CHUNK_SIZE_BYTES, file.size - file.receivedBytes)
    batch.activeRequest = true
    try {
      const body = await this.readBinaryBody(request, response, expectedLength)
      if (body === null) return
      if (!this.verifyRequest(session, request, body)) {
        this.writeJson(response, 401, { error: 'MOBILE_REQUEST_UNAUTHORIZED' })
        return
      }
      if (batch.cancelled || this.receivingBatch !== batch) {
        throw new Error('TRANSFER_CANCELLED')
      }
      if (task.status === 'accepted') this.pendingTask = this.updateTask(task, 'transferring')
      if (body.length > 0) await file.handle.write(body, 0, body.length, file.receivedBytes)
      file.receivedBytes += body.length
      file.nextChunkIndex += 1
      const currentTask = this.pendingTask
      if (currentTask === null) throw new Error('TRANSFER_CANCELLED')
      this.pendingTask = {
        ...currentTask,
        fileItems: currentTask.fileItems.map((item) =>
          item.fileId === file.fileId
            ? {
                ...item,
                status: file.receivedBytes === file.size ? 'completed' : 'transferring',
                transferredBytes: file.receivedBytes,
              }
            : item,
        ),
        transferredBytes: batch.files.reduce((total, item) => total + item.receivedBytes, 0),
        updatedAt: this.now(),
      }
      for (const listener of this.taskListeners) listener(this.pendingTask)
      if (file.receivedBytes === file.size) {
        await file.handle.sync()
        await file.handle.close()
        const publishedPath = await publishTemporaryFile(
          file.temporaryPath,
          batch.directoryPath,
          file.displayName,
        )
        this.history?.add(
          {
            direction: 'receive',
            kind: 'file',
            peer: {
              deviceId: MOBILE_BROWSER_DEVICE_ID,
              deviceName: '手机浏览器',
              operatingSystem: 'macos',
              ipAddress: task.sourceAddress,
              servicePort: DEFAULT_SERVICE_PORT,
            },
            status: 'completed',
            displayName: file.displayName,
            size: file.size,
            createdAt: this.now(),
          },
          publishedPath,
        )
        file.published = true
        this.receivedPaths.set(task.batchId, publishedPath)
        while (this.receivedPaths.size > 100) {
          const oldestBatchId = this.receivedPaths.keys().next().value
          if (oldestBatchId === undefined) break
          this.receivedPaths.delete(oldestBatchId)
        }
      }
      const complete = batch.files.every((item) => item.published)
      if (complete) {
        this.receivingBatch = null
        this.pendingTask = this.updateTask(this.pendingTask, 'completed')
      }
      this.writeJson(response, 200, publicTaskStatus(this.pendingTask))
    } catch (error) {
      await this.cleanupReceivingBatch()
      const failedTask = this.pendingTask ?? task
      this.pendingTask = this.updateTask(failedTask, 'failed', mapFileError(error))
      this.writeJson(response, 500, publicTaskStatus(this.pendingTask))
    } finally {
      if (this.receivingBatch !== null) this.receivingBatch.activeRequest = false
    }
  }

  private async receiveCancellation(
    match: RegExpExecArray,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const session = this.authorizeSession(match[1] ?? '', request)
    const batchId = mobileUploadBatchIdSchema.safeParse(match[2] ?? '')
    if (session === null || !batchId.success || !this.verifyRequest(session, request, '')) {
      this.writeJson(response, 401, { error: 'MOBILE_REQUEST_UNAUTHORIZED' })
      return
    }
    const task = await this.cancel(batchId.data)
    if (task === null) {
      this.writeJson(response, 409, { error: 'MESSAGE_INVALID' })
      return
    }
    this.writeJson(response, 200, publicTaskStatus(task))
  }

  private async serveDownloads(
    sessionIdInput: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const session = this.authorizeSession(sessionIdInput, request)
    if (session === null || !this.verifyRequest(session, request, '')) {
      this.writeJson(response, 401, { error: 'MOBILE_REQUEST_UNAUTHORIZED' })
      return
    }
    const batch = this.publishedDownloads
    if (batch === null) {
      this.writeJson(response, 200, { files: [] })
      return
    }
    const sourceAddress = normalizeAddress(request.socket.remoteAddress)
    if (batch.sourceAddress !== null && batch.sourceAddress !== sourceAddress) {
      this.writeJson(response, 403, { error: 'MOBILE_REQUEST_UNAUTHORIZED' })
      return
    }
    batch.sourceAddress = sourceAddress
    this.writeJson(response, 200, {
      files: batch.files.map(({ source, token, downloaded }) => ({
        fileId: source.selection.fileId,
        displayName: source.selection.displayName,
        size: source.selection.size,
        mimeType: source.selection.mimeType,
        status: downloaded ? 'downloaded' : 'available',
        downloadUrl: `/mobile/${session.sessionId}/downloads/${source.selection.fileId}/${token}`,
      })),
      createdAt: batch.createdAt,
      updatedAt: batch.updatedAt,
    })
  }

  private async serveDownloadFile(
    match: RegExpExecArray,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const sessionId = mobileUploadSessionIdSchema.safeParse(match[1] ?? '')
    const fileId = match[2] ?? ''
    const token = match[3] ?? ''
    const session = this.getActiveSession()
    const batch = this.publishedDownloads
    const sourceAddress = normalizeAddress(request.socket.remoteAddress)
    const file = batch?.files.find(
      ({ source, token: expectedToken }) =>
        source.selection.fileId === fileId && expectedToken === token,
    )
    if (
      !sessionId.success ||
      session?.sessionId !== sessionId.data ||
      batch === null ||
      batch.sourceAddress === null ||
      batch.sourceAddress !== sourceAddress ||
      file === undefined
    ) {
      this.writeJson(response, 404, { error: 'FILE_NOT_FOUND' })
      return
    }
    let handle: FileHandle | null = null
    try {
      handle = await open(file.source.path, 'r')
      const metadata = await handle.stat()
      const identity = file.source.identity
      if (
        !metadata.isFile() ||
        metadata.size !== file.source.selection.size ||
        identity === undefined ||
        metadata.dev !== identity.device ||
        metadata.ino !== identity.inode ||
        metadata.mtimeMs !== identity.modifiedAt
      ) {
        throw new Error('FILE_NOT_FOUND')
      }
      const displayName = file.source.selection.displayName
      const encodedName = encodeURIComponent(displayName).replace(
        /[!'()*]/gu,
        (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
      )
      response.writeHead(200, {
        'Cache-Control': 'no-store',
        'Content-Disposition': `attachment; filename="download"; filename*=UTF-8''${encodedName}`,
        'Content-Length': metadata.size,
        'Content-Type': file.source.selection.mimeType,
        'Cross-Origin-Resource-Policy': 'same-origin',
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
      })
      const firstDownload = !file.downloaded
      await pipeline(handle.createReadStream({ autoClose: false }), response)
      file.downloaded = true
      batch.updatedAt = this.now()
      const dto = this.getDownloads()
      for (const listener of this.downloadsListeners) listener(dto)
      if (firstDownload) {
        this.history?.add({
          direction: 'send',
          kind: 'file',
          peer: {
            deviceId: MOBILE_BROWSER_DEVICE_ID,
            deviceName: '手机浏览器',
            operatingSystem: 'macos',
            ipAddress: sourceAddress,
            servicePort: DEFAULT_SERVICE_PORT,
          },
          status: 'completed',
          displayName,
          size: metadata.size,
          createdAt: this.now(),
        })
      }
    } catch {
      if (!response.headersSent) this.writeJson(response, 404, { error: 'FILE_NOT_FOUND' })
      else response.destroy()
    } finally {
      await handle?.close().catch(() => undefined)
    }
  }

  private async readBinaryBody(
    request: IncomingMessage,
    response: ServerResponse,
    expectedLength: number,
  ): Promise<Buffer | null> {
    const contentLength = Number(request.headers['content-length'])
    if (
      request.headers['content-type'] !== 'application/octet-stream' ||
      !Number.isSafeInteger(contentLength) ||
      contentLength !== expectedLength ||
      contentLength < 0 ||
      contentLength > DEFAULT_FILE_CHUNK_SIZE_BYTES ||
      request.headers['transfer-encoding'] !== undefined
    ) {
      this.writeJson(response, 400, { error: 'CHUNK_INVALID' })
      return null
    }
    const chunks: Buffer[] = []
    let received = 0
    request.setTimeout(TRANSFER_IDLE_TIMEOUT_MS, () => request.destroy())
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      received += buffer.length
      if (received > expectedLength) {
        request.destroy()
        return null
      }
      chunks.push(buffer)
    }
    if (received !== expectedLength) {
      this.writeJson(response, 400, { error: 'CHUNK_INVALID' })
      return null
    }
    return Buffer.concat(chunks)
  }

  private async cleanupReceivingBatch(): Promise<void> {
    const batch = this.receivingBatch
    this.receivingBatch = null
    if (batch === null) return
    batch.cancelled = true
    await Promise.all(
      batch.files.map(async (file) => {
        await file.handle.close().catch(() => undefined)
        await unlink(file.temporaryPath).catch(() => undefined)
      }),
    )
  }

  private securityHeaders(contentType: string, content: string): Record<string, string | number> {
    return {
      'Cache-Control': 'no-store',
      'Content-Length': Buffer.byteLength(content),
      'Content-Security-Policy':
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
      'Content-Type': contentType,
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
    }
  }

  private writeJson(response: ServerResponse, statusCode: number, body: unknown): void {
    const content = JSON.stringify(body)
    response.writeHead(statusCode, this.securityHeaders('application/json; charset=utf-8', content))
    response.end(content)
  }
}

const normalizeAddress = (address: string | undefined): string => {
  const value = address ?? 'unknown'
  return value.startsWith('::ffff:') ? value.slice(7) : value
}

const isTerminal = (status: MobileUploadTaskDto['status']): boolean =>
  ['completed', 'failed', 'cancelled', 'rejected'].includes(status)

const publicTaskStatus = (task: MobileUploadTaskDto): object => ({
  batchId: task.batchId,
  status: task.status,
  transferredBytes: task.transferredBytes,
  totalBytes: task.totalBytes,
  ...(task.errorCode === undefined ? {} : { errorCode: task.errorCode }),
})

const createMobileUploadPage = (sessionId: MobileUploadSessionId): string => `<!doctype html>
<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>邻渡 · 手机传输</title><style>
:root{color-scheme:light dark;font-family:system-ui,-apple-system,sans-serif;--bg:#f3f6fb;--card:#fff;--surface:#f7f9fc;--text:#18212f;--muted:#687386;--line:#dfe5ee;--primary:#1677ff;--danger:#d64545}*{box-sizing:border-box}body{margin:0;padding:18px;background:linear-gradient(145deg,#edf4ff,var(--bg));color:var(--text)}.card{max-width:620px;margin:0 auto;padding:24px;border:1px solid #ffffff80;border-radius:24px;background:var(--card);box-shadow:0 16px 50px #10204018}.brand{display:flex;align-items:center;gap:12px}.mark{display:grid;width:44px;height:44px;place-items:center;border-radius:14px;background:#1677ff;color:#fff;font-size:22px;font-weight:800}h1{margin:0;font-size:24px}.hint{margin:4px 0 0;color:var(--muted);line-height:1.55}.warning{margin:18px 0;padding:12px 14px;border-radius:12px;background:#fff5df;color:#7c5200;font-size:13px;line-height:1.5}.section{padding-top:20px}.section+.section{margin-top:22px;border-top:1px solid var(--line)}.section-title{margin:0 0 5px;font-size:18px}.picker{display:block;margin-top:14px;padding:24px;border:1.5px dashed #91bfff;border-radius:16px;background:#f5f9ff;text-align:center;cursor:pointer}.picker strong{display:block;margin-bottom:5px}.picker input{position:absolute;width:1px;height:1px;opacity:0}.summary{display:flex;justify-content:space-between;margin:18px 0 10px;color:var(--muted);font-size:13px}.list{display:grid;gap:10px;max-height:330px;overflow:auto}.file{padding:12px;border:1px solid var(--line);border-radius:12px;background:var(--surface)}.file-head{display:grid;grid-template-columns:minmax(0,1fr) auto;grid-template-rows:auto auto;column-gap:10px;align-items:center}.file-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}.file-size{grid-column:1;grid-row:2;margin-top:3px;color:var(--muted);font-size:12px}.remove{grid-column:2;grid-row:1/3;width:auto;min-height:32px;padding:4px 8px;border:0;background:transparent;color:var(--danger);white-space:nowrap}.download{grid-column:2;grid-row:1/3;display:grid;min-height:36px;padding:8px 13px;border-radius:10px;background:var(--primary);color:#fff;text-decoration:none;place-items:center;white-space:nowrap;font-size:13px;font-weight:700}.download.done{background:#dfe8f4;color:#536274}.download-empty{padding:18px;border-radius:12px;background:var(--surface);color:var(--muted);text-align:center;font-size:13px}.bar{height:6px;margin-top:9px;overflow:hidden;border-radius:6px;background:#dce5f1}.bar>i{display:block;width:0;height:100%;background:var(--primary);transition:width .2s}.file-state{display:block;margin-top:6px;color:var(--muted);font-size:11px}.actions{display:grid;grid-template-columns:1fr 2fr;gap:10px;margin-top:18px}button{min-height:46px;padding:12px;border:0;border-radius:12px;font-weight:700}button:disabled{opacity:.5}.secondary{background:#eaf2ff;color:#145cbd}.primary{background:var(--primary);color:#fff}.status{min-height:24px;margin:14px 0 0;text-align:center;color:var(--muted);font-size:13px}@media(max-width:420px){body{padding:10px}.card{padding:18px;border-radius:18px}.file{padding:10px}.remove{padding-inline:6px}}@media(prefers-color-scheme:dark){:root{--bg:#101620;--card:#19212e;--surface:#222c3b;--text:#edf3fb;--muted:#a9b5c5;--line:#344153}body{background:linear-gradient(145deg,#14233a,var(--bg))}.warning{background:#3b2f18;color:#ffd887}.picker{background:#1a2b44;border-color:#3979c8}.secondary{background:#243b59;color:#9ec8ff}.download.done{background:#344153;color:#b8c4d4}}
</style></head><body><main class="card"><div class="brand"><div class="mark">邻</div><div><h1>手机传输</h1><p class="hint">在手机与电脑之间安全传输文件。</p></div></div><p class="warning">仅在你信任的局域网中使用。传输期间请保持此页面开启。</p><section class="section"><h2 class="section-title">从电脑接收</h2><p class="hint">电脑选择文件后会自动显示在这里，请逐个下载。</p><div id="downloads" class="list"><div class="download-empty">等待电脑选择文件…</div></div><p id="download-status" class="status"></p></section><section class="section"><h2 class="section-title">发送到电脑</h2><p class="hint">可一次选择最多 20 个文件，电脑确认后自动串行上传。</p><label class="picker"><strong>选择照片或文件</strong><span class="hint">可以多选，也可以分几次继续添加</span><input id="files" type="file" multiple></label><div class="summary"><span id="count">尚未选择文件</span><span id="total"></span></div><div id="list" class="list"></div><div class="actions"><button id="clear" class="secondary" disabled>清空</button><button id="send" class="primary" disabled>请求上传</button></div><p id="status" class="status"></p></section></main>
<script>
const sessionId=${JSON.stringify(sessionId)};const key=new URLSearchParams(location.hash.slice(1)).get('key');history.replaceState(null,'',location.pathname);const input=document.querySelector('#files'),button=document.querySelector('#send'),clear=document.querySelector('#clear'),status=document.querySelector('#status'),list=document.querySelector('#list'),count=document.querySelector('#count'),totalLabel=document.querySelector('#total'),downloads=document.querySelector('#downloads'),downloadStatus=document.querySelector('#download-status');let selected=[],busy=false,sessionEnded=false;
const randomBytes=n=>{const value=new Uint8Array(n);if(globalThis.crypto?.getRandomValues)crypto.getRandomValues(value);else for(let i=0;i<n;i++)value[i]=Math.floor(Math.random()*256);return value};const b64url=b=>btoa(String.fromCharCode(...b)).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');const uuid=()=>{const b=randomBytes(16);b[6]=(b[6]&15)|64;b[8]=(b[8]&63)|128;const h=[...b].map(v=>v.toString(16).padStart(2,'0')).join('');return h.slice(0,8)+'-'+h.slice(8,12)+'-'+h.slice(12,16)+'-'+h.slice(16,20)+'-'+h.slice(20)};
async function signedFetch(path,options={}){if(!key)throw new Error('二维码无效');const timestamp=Date.now().toString(),nonce=b64url(randomBytes(18));return fetch(path,{...options,headers:{...(options.headers??{}),'X-Lindu-Timestamp':timestamp,'X-Lindu-Nonce':nonce,'X-Lindu-Session-Key':key}})}
const size=n=>n<1024?n+' B':n<1048576?(n/1024).toFixed(1)+' KB':(n/1048576).toFixed(1)+' MB';const identity=f=>f.name+'|'+f.size+'|'+f.lastModified;function render(){list.textContent='';selected.forEach((file,index)=>{const row=document.createElement('div');row.className='file';const head=document.createElement('div');head.className='file-head';const name=document.createElement('span');name.className='file-name';name.textContent=file.name;const info=document.createElement('span');info.className='file-size';info.textContent=size(file.size);const remove=document.createElement('button');remove.className='remove';remove.textContent='移除';remove.disabled=busy||sessionEnded;remove.onclick=()=>{selected.splice(index,1);render()};head.append(name,info,remove);const bar=document.createElement('div');bar.className='bar';bar.innerHTML='<i></i>';const state=document.createElement('small');state.className='file-state';state.textContent='等待上传';row.append(head,bar,state);list.append(row)});count.textContent=selected.length?selected.length+' 个文件':'尚未选择文件';totalLabel.textContent=selected.length?'共 '+size(selected.reduce((n,f)=>n+f.size,0)):'';input.disabled=sessionEnded;button.disabled=sessionEnded||busy||!selected.length;clear.disabled=sessionEnded||busy||!selected.length}function endSession(){if(sessionEnded)return;sessionEnded=true;busy=false;selected=[];render();renderDownloads([]);status.textContent='本次会话已结束，请在电脑上重新创建二维码后扫码。';downloadStatus.textContent='本次会话已结束，请重新扫码。'}function ensureSession(response){if(response.status===401||response.status===404){endSession();throw new Error('SESSION_ENDED')}return response}input.onchange=()=>{if(sessionEnded)return;for(const file of [...input.files])if(selected.length<20&&!selected.some(item=>identity(item)===identity(file)))selected.push(file);input.value='';render()};clear.onclick=()=>{selected=[];render()};
async function upload(files,metadata,batchId){let sent=0,total=files.reduce((n,f)=>n+f.size,0);for(let i=0;i<files.length;i++){const file=files[i],meta=metadata[i],row=list.children[i],fill=row.querySelector('i'),state=row.querySelector('.file-state');state.textContent='上传中';const chunks=Math.max(1,Math.ceil(file.size/4194304));for(let chunk=0;chunk<chunks;chunk++){const data=file.slice(chunk*4194304,Math.min(file.size,(chunk+1)*4194304));const path='/mobile/'+sessionId+'/batches/'+batchId+'/files/'+meta.fileId+'/chunks/'+chunk;const response=ensureSession(await signedFetch(path,{method:'PUT',body:data,headers:{'Content-Type':'application/octet-stream'}}));if(!response.ok)throw new Error();sent+=data.size;fill.style.width=(file.size===0?100:Math.round(Math.min(file.size,(chunk+1)*4194304)/file.size*100))+'%';status.textContent='正在上传第 '+(i+1)+' / '+files.length+' 个 · 总进度 '+(total===0?100:Math.round(sent/total*100))+'%'}state.textContent='已完成';fill.style.width='100%'}status.textContent='全部 '+files.length+' 个文件已上传完成。'}
button.onclick=async()=>{const files=[...selected];if(!files.length||busy||sessionEnded)return;busy=true;render();try{const batchId=uuid(),metadata=files.map(f=>({fileId:uuid(),displayName:f.name,size:f.size,mimeType:f.type||'application/octet-stream'}));const body=JSON.stringify({batchId,files:metadata});const res=ensureSession(await signedFetch('/mobile/'+sessionId+'/offers',{method:'POST',body,headers:{'Content-Type':'application/json'}}));if(!res.ok)throw new Error();status.textContent='请求已发送，等待电脑确认…';const poll=async()=>{if(sessionEnded)return;const current=ensureSession(await signedFetch('/mobile/'+sessionId+'/offers/'+batchId));if(!current.ok)throw new Error();const state=await current.json();if(state.status==='accepted'){await upload(files,metadata,batchId);selected=[];busy=false;render();return}if(state.status==='rejected'||state.status==='cancelled'||state.status==='failed'){status.textContent='电脑未接受或已取消本次上传。';busy=false;render();return}setTimeout(()=>void poll().catch(fail),900)};const fail=()=>{if(sessionEnded)return;status.textContent='上传失败，请检查网络或重新扫码。';busy=false;render()};setTimeout(()=>void poll().catch(fail),500)}catch{if(sessionEnded)return;status.textContent='请求失败，请检查二维码是否过期。';busy=false;render()}};render();
function renderDownloads(files){downloads.textContent='';if(!files.length){const empty=document.createElement('div');empty.className='download-empty';empty.textContent='等待电脑选择文件…';downloads.append(empty);downloadStatus.textContent='';return}for(const file of files){const row=document.createElement('div');row.className='file';const head=document.createElement('div');head.className='file-head';const name=document.createElement('span');name.className='file-name';name.textContent=file.displayName;name.title=file.displayName;const info=document.createElement('span');info.className='file-size';info.textContent=size(file.size);const link=document.createElement('a');link.className='download'+(file.status==='downloaded'?' done':'');link.href=file.downloadUrl;link.download=file.displayName;link.target='_blank';link.rel='noopener';link.textContent=file.status==='downloaded'?'再次下载':'下载';link.onclick=()=>setTimeout(pollDownloads,1200);head.append(name,info,link);row.append(head);downloads.append(row)}downloadStatus.textContent=files.length+' 个文件可下载'}
async function pollDownloads(){if(sessionEnded)return;try{const response=ensureSession(await signedFetch('/mobile/'+sessionId+'/downloads'));if(!response.ok)throw new Error();const data=await response.json();renderDownloads(data.files)}catch{if(!sessionEnded)downloadStatus.textContent='无法刷新电脑文件，请检查二维码是否过期。'}}render();void pollDownloads();setInterval(()=>void pollDownloads(),2000);
</script></body></html>`

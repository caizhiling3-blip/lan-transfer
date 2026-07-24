import { randomUUID } from 'node:crypto'

import { MAX_QUEUED_TRANSFER_ITEMS } from '@shared/constants'
import type { ErrorCode } from '@shared/errors'
import { queueItemIdSchema } from '@shared/types'
import type {
  ConnectionStatusDto,
  DeviceInfo,
  DeviceId,
  HistoryEntryDto,
  QueueItemId,
  TextTransferTaskDto,
  TransferQueueItemDto,
  TransferTaskDto,
} from '@shared/types'

import type {
  AuthorizedSourceFile,
  AuthorizedSourceFolder,
  AuthorizedTransferSelections,
  FileAccessRegistry,
} from './file-access-registry'

type QueueListener = (items: readonly TransferQueueItemDto[]) => void
type TextTaskListener = (task: TextTransferTaskDto) => void

interface QueueItemBase {
  dto: Omit<TransferQueueItemDto, 'position'>
  readonly peerDeviceId: DeviceId
}

interface TextQueueItem extends QueueItemBase {
  readonly type: 'text'
  readonly content: string
  readonly contentType: 'text' | 'link'
}

interface FileQueueItem extends QueueItemBase {
  readonly type: 'files'
  readonly sources: readonly AuthorizedSourceFile[]
}

interface FolderQueueItem extends QueueItemBase {
  readonly type: 'folder'
  readonly source: AuthorizedSourceFolder
}

type QueueItem = TextQueueItem | FileQueueItem | FolderQueueItem

export interface EnqueueTransferRequest {
  readonly text?: {
    readonly content: string
    readonly contentType: 'text' | 'link'
  }
  readonly fileSelectionTokens: readonly string[]
  readonly folderSelectionTokens: readonly string[]
}

export type EnqueueTransferResult =
  | { readonly ok: true; readonly items: readonly TransferQueueItemDto[] }
  | { readonly ok: false; readonly errorCode: ErrorCode }

export interface QueueConnectionAdapter {
  getPeer(): DeviceInfo | null
  sendText(content: string, contentType: 'text' | 'link'): Promise<TransferTaskDto | null>
  subscribeStatus(listener: (status: ConnectionStatusDto) => void): () => void
}

export interface QueuedFileTransferAdapter {
  hasActiveTransfers(): boolean
  offerAuthorizedFiles(sources: readonly AuthorizedSourceFile[]): Promise<TransferTaskDto | null>
  subscribeTasks(listener: (task: TransferTaskDto) => void): () => void
}

export interface QueuedFolderTransferAdapter {
  hasActiveTransfers(): boolean
  offerAuthorizedFolder(source: AuthorizedSourceFolder): Promise<TransferTaskDto | null>
  subscribeTasks(listener: (task: TransferTaskDto) => void): () => void
}

export interface QueueHistoryAdapter {
  add(entry: Omit<HistoryEntryDto, 'id'>): HistoryEntryDto
}

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'rejected'])

const totalFileSize = (sources: readonly AuthorizedSourceFile[]): number =>
  sources.reduce((total, source) => total + source.selection.size, 0)

export class TransferQueueCoordinator {
  private items: QueueItem[] = []
  private readonly listeners = new Set<QueueListener>()
  private readonly textTaskListeners = new Set<TextTaskListener>()
  private processing = false
  private readonly unsubscribers: readonly (() => void)[]

  public constructor(
    private readonly connectionManager: QueueConnectionAdapter,
    private readonly fileAccess: Pick<FileAccessRegistry, 'consumeTransferSelections'>,
    private readonly fileCoordinator: QueuedFileTransferAdapter,
    private readonly folderCoordinator: QueuedFolderTransferAdapter,
    private readonly history: QueueHistoryAdapter,
  ) {
    this.unsubscribers = [
      fileCoordinator.subscribeTasks((task) => this.handleTaskChanged(task)),
      folderCoordinator.subscribeTasks((task) => this.handleTaskChanged(task)),
      connectionManager.subscribeStatus((status) => {
        if (status.state === 'disconnected') this.discardWaitingItems()
      }),
    ]
  }

  public subscribe(listener: QueueListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  public subscribeTextTasks(listener: TextTaskListener): () => void {
    this.textTaskListeners.add(listener)
    return () => this.textTaskListeners.delete(listener)
  }

  public getItems(): readonly TransferQueueItemDto[] {
    return this.items.map((item, index) => ({ ...item.dto, position: index + 1 }))
  }

  public hasPendingItems(): boolean {
    return this.items.some((item) => item.dto.status !== 'failed')
  }

  public enqueue(request: EnqueueTransferRequest): EnqueueTransferResult {
    const peer = this.connectionManager.getPeer()
    if (peer === null) return { ok: false, errorCode: 'CONNECTION_CLOSED' }
    this.items = this.items.filter((item) => item.dto.status !== 'failed')
    const requestedItemCount =
      (request.text === undefined ? 0 : 1) +
      (request.fileSelectionTokens.length === 0 ? 0 : 1) +
      request.folderSelectionTokens.length
    if (this.items.length + requestedItemCount > MAX_QUEUED_TRANSFER_ITEMS) {
      return { ok: false, errorCode: 'FILE_COUNT_EXCEEDED' }
    }
    const selections = this.fileAccess.consumeTransferSelections(
      request.fileSelectionTokens,
      request.folderSelectionTokens,
    )
    if (selections === null) return { ok: false, errorCode: 'FILE_NOT_FOUND' }
    this.appendItems(peer.deviceId, request, selections)
    this.emit()
    this.schedulePump()
    return { ok: true, items: this.getItems() }
  }

  public cancelQueued(queueItemId: QueueItemId): boolean {
    const item = this.items.find((candidate) => candidate.dto.queueItemId === queueItemId)
    if (item === undefined || item.dto.status === 'active') return false
    this.items = this.items.filter((candidate) => candidate !== item)
    this.emit()
    return true
  }

  public shutdown(): void {
    for (const unsubscribe of this.unsubscribers) unsubscribe()
    this.items = []
    this.emit()
  }

  private appendItems(
    peerDeviceId: DeviceId,
    request: EnqueueTransferRequest,
    selections: AuthorizedTransferSelections,
  ): void {
    if (request.text !== undefined) {
      this.items.push({
        type: 'text',
        peerDeviceId,
        content: request.text.content,
        contentType: request.text.contentType,
        dto: this.createDto(
          request.text.contentType,
          request.text.contentType === 'link' ? '链接' : '文字消息',
          1,
          0,
        ),
      })
    }
    if (selections.files.length > 0) {
      const firstName = selections.files[0]?.selection.displayName ?? '文件'
      this.items.push({
        type: 'files',
        peerDeviceId,
        sources: selections.files,
        dto: this.createDto(
          'file',
          selections.files.length === 1
            ? firstName
            : `${firstName} 等 ${String(selections.files.length)} 个文件`,
          selections.files.length,
          totalFileSize(selections.files),
        ),
      })
    }
    for (const source of selections.folders) {
      this.items.push({
        type: 'folder',
        peerDeviceId,
        source,
        dto: this.createDto(
          'folder',
          source.selection.displayName,
          source.selection.fileCount,
          source.selection.totalSize,
        ),
      })
    }
  }

  private createDto(
    kind: TransferQueueItemDto['kind'],
    displayName: string,
    itemCount: number,
    totalBytes: number,
  ): QueueItemBase['dto'] {
    return {
      queueItemId: queueItemIdSchema.parse(randomUUID()),
      kind,
      displayName,
      itemCount,
      totalBytes,
      status: 'queued',
      createdAt: Date.now(),
    }
  }

  private schedulePump(): void {
    if (this.processing) return
    this.processing = true
    queueMicrotask(() => void this.pump())
  }

  private async pump(): Promise<void> {
    const item = this.items.find((candidate) => candidate.dto.status === 'queued')
    if (item === undefined) {
      this.processing = false
      return
    }
    if (this.fileCoordinator.hasActiveTransfers() || this.folderCoordinator.hasActiveTransfers()) {
      this.processing = false
      return
    }
    const peer = this.connectionManager.getPeer()
    if (peer?.deviceId !== item.peerDeviceId) {
      this.failItem(item, 'CONNECTION_CLOSED')
      this.processing = false
      this.schedulePump()
      return
    }
    item.dto = { ...item.dto, status: 'active' }
    this.emit()
    if (item.type === 'text') {
      await this.processText(item)
      return
    }
    const task =
      item.type === 'files'
        ? await this.fileCoordinator.offerAuthorizedFiles(item.sources)
        : await this.folderCoordinator.offerAuthorizedFolder(item.source)
    if (task === null) {
      this.failItem(item, 'TRANSFER_FAILED')
      this.processing = false
      this.schedulePump()
      return
    }
    item.dto = { ...item.dto, transferId: task.transferId }
    this.emit()
    if (TERMINAL_STATUSES.has(task.status)) this.completeActiveItem(item)
  }

  private async processText(item: TextQueueItem): Promise<void> {
    const task = await this.connectionManager.sendText(item.content, item.contentType)
    if (task === null) {
      this.failItem(item, 'CONNECTION_CLOSED')
      this.processing = false
      this.schedulePump()
    } else {
      this.history.add({
        transferId: task.transferId,
        direction: 'send',
        kind: item.contentType,
        peer: task.peer,
        status: task.status,
        textPreview: item.content,
        createdAt: task.createdAt,
        ...(task.errorCode === undefined ? {} : { errorCode: task.errorCode }),
      })
      for (const listener of this.textTaskListeners) listener({ task, content: item.content })
      this.completeActiveItem(item)
    }
  }

  private handleTaskChanged(task: TransferTaskDto): void {
    if (!TERMINAL_STATUSES.has(task.status)) return
    const item = this.items.find(
      (candidate) =>
        candidate.dto.status === 'active' && candidate.dto.transferId === task.transferId,
    )
    if (item !== undefined) {
      this.completeActiveItem(item)
    } else {
      this.schedulePump()
    }
  }

  private completeActiveItem(item: QueueItem): void {
    this.items = this.items.filter((candidate) => candidate !== item)
    this.emit()
    this.processing = false
    this.schedulePump()
  }

  private failItem(item: QueueItem, errorCode: ErrorCode): void {
    item.dto = { ...item.dto, status: 'failed', errorCode }
    this.emit()
  }

  private discardWaitingItems(): void {
    const remaining = this.items.filter((item) => item.dto.status === 'active')
    if (remaining.length === this.items.length) return
    this.items = remaining
    this.emit()
  }

  private emit(): void {
    const items = this.getItems()
    for (const listener of this.listeners) listener(items)
  }
}

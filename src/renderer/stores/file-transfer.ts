import { defineStore } from 'pinia'

import { MAX_FILES_PER_TRANSFER, MAX_TOP_LEVEL_TRANSFER_ITEMS } from '@shared/constants'
import { ERROR_MESSAGES_ZH_CN } from '@shared/errors'
import type { TransferOfferReceivedDto } from '@shared/ipc'
import type {
  SelectedFileDto,
  SelectedFolderDto,
  TransferQueueItemDto,
  TransferTaskDto,
} from '@shared/types'

const upsertTask = (tasks: TransferTaskDto[], task: TransferTaskDto): TransferTaskDto[] => {
  const index = tasks.findIndex((candidate) => candidate.transferId === task.transferId)
  if (index < 0) return [task, ...tasks]
  return tasks.map((candidate, candidateIndex) => (candidateIndex === index ? task : candidate))
}

export const useFileTransferStore = defineStore('fileTransfer', {
  state: () => ({
    tasks: [] as TransferTaskDto[],
    queueItems: [] as TransferQueueItemDto[],
    pendingFiles: [] as SelectedFileDto[],
    pendingFolders: [] as SelectedFolderDto[],
    incomingOffer: null as TransferOfferReceivedDto | null,
    selecting: false,
    offering: false,
    responding: false,
    errorMessage: '',
    unsubscribers: [] as (() => void)[],
  }),
  actions: {
    initialize(): void {
      this.dispose()
      this.unsubscribers = [
        window.lanTransfer.transfer.onTaskChanged((task) => {
          this.tasks = upsertTask(this.tasks, task)
          if (
            this.incomingOffer?.transferId === task.transferId &&
            ['completed', 'failed', 'cancelled', 'rejected'].includes(task.status)
          ) {
            this.incomingOffer = null
          }
        }),
        window.lanTransfer.transfer.onOfferReceived((offer) => {
          this.incomingOffer = offer
        }),
        window.lanTransfer.transfer.onQueueChanged((items) => {
          this.queueItems = [...items]
        }),
      ]
    },
    async selectFiles(): Promise<void> {
      this.selecting = true
      this.errorMessage = ''
      const selectionResult = await window.lanTransfer.transfer.selectFiles(true)
      this.selecting = false
      if (!selectionResult.ok) {
        this.errorMessage = ERROR_MESSAGES_ZH_CN[selectionResult.error.code]
        return
      }
      this.addPendingFiles(selectionResult.data)
    },
    async selectFolder(): Promise<void> {
      if (this.pendingFolders.length > 0) {
        this.errorMessage = ERROR_MESSAGES_ZH_CN.FILE_COUNT_EXCEEDED
        return
      }
      if (this.pendingFiles.length + this.pendingFolders.length >= MAX_TOP_LEVEL_TRANSFER_ITEMS) {
        this.errorMessage = ERROR_MESSAGES_ZH_CN.FILE_COUNT_EXCEEDED
        return
      }
      this.selecting = true
      this.errorMessage = ''
      const selectionResult = await window.lanTransfer.transfer.selectFolder()
      this.selecting = false
      if (!selectionResult.ok) {
        this.errorMessage = ERROR_MESSAGES_ZH_CN[selectionResult.error.code]
        return
      }
      if (selectionResult.data !== null) {
        this.addPendingFolders([selectionResult.data])
      }
    },
    async registerDroppedFiles(files: readonly File[]): Promise<void> {
      this.selecting = true
      this.errorMessage = ''
      const selectionResult = await window.lanTransfer.transfer.registerDroppedFiles(files)
      this.selecting = false
      if (!selectionResult.ok) {
        this.errorMessage = ERROR_MESSAGES_ZH_CN[selectionResult.error.code]
        return
      }
      this.addPendingFiles(selectionResult.data)
    },
    async registerDroppedItems(items: readonly File[]): Promise<void> {
      this.selecting = true
      this.errorMessage = ''
      const selectionResult = await window.lanTransfer.transfer.registerDroppedItems(items)
      this.selecting = false
      if (!selectionResult.ok) {
        this.errorMessage = ERROR_MESSAGES_ZH_CN[selectionResult.error.code]
        return
      }
      const files = selectionResult.data.flatMap((item) =>
        item.kind === 'file' ? [item.file] : [],
      )
      const folders = selectionResult.data.flatMap((item) =>
        item.kind === 'folder' ? [item.folder] : [],
      )
      if (folders.length + this.pendingFolders.length > 1) {
        this.errorMessage = ERROR_MESSAGES_ZH_CN.FILE_COUNT_EXCEEDED
        return
      }
      if (
        folders.length > 0 &&
        this.pendingFiles.length + this.pendingFolders.length + files.length + folders.length >
          MAX_TOP_LEVEL_TRANSFER_ITEMS
      ) {
        this.errorMessage = ERROR_MESSAGES_ZH_CN.FILE_COUNT_EXCEEDED
        return
      }
      this.addPendingFiles(files)
      this.addPendingFolders(folders)
    },
    addPendingFiles(selections: readonly SelectedFileDto[]): void {
      const maximumItems =
        this.pendingFolders.length > 0 ? MAX_TOP_LEVEL_TRANSFER_ITEMS : MAX_FILES_PER_TRANSFER
      if (
        this.pendingFiles.length + this.pendingFolders.length + selections.length >
        maximumItems
      ) {
        this.errorMessage = ERROR_MESSAGES_ZH_CN.FILE_COUNT_EXCEEDED
        return
      }
      this.pendingFiles = [...this.pendingFiles, ...selections]
    },
    addPendingFolders(selections: readonly SelectedFolderDto[]): void {
      if (this.pendingFolders.length + selections.length > 1) {
        this.errorMessage = ERROR_MESSAGES_ZH_CN.FILE_COUNT_EXCEEDED
        return
      }
      if (
        this.pendingFiles.length + this.pendingFolders.length + selections.length >
        MAX_TOP_LEVEL_TRANSFER_ITEMS
      ) {
        this.errorMessage = ERROR_MESSAGES_ZH_CN.FILE_COUNT_EXCEEDED
        return
      }
      this.pendingFolders = [...this.pendingFolders, ...selections]
    },
    removePendingFile(fileId: SelectedFileDto['fileId']): void {
      this.pendingFiles = this.pendingFiles.filter((file) => file.fileId !== fileId)
    },
    removePendingFolder(selectionToken: string): void {
      this.pendingFolders = this.pendingFolders.filter(
        (folder) => folder.selectionToken !== selectionToken,
      )
    },
    clearPendingFiles(): void {
      this.pendingFiles = []
    },
    clearPendingItems(): void {
      this.pendingFiles = []
      this.pendingFolders = []
    },
    async enqueuePendingItems(text?: {
      readonly content: string
      readonly contentType: 'text' | 'link'
    }): Promise<boolean> {
      if (
        (text === undefined &&
          this.pendingFiles.length === 0 &&
          this.pendingFolders.length === 0) ||
        this.offering
      ) {
        return false
      }
      this.offering = true
      this.errorMessage = ''
      const result = await window.lanTransfer.transfer.enqueue({
        ...(text === undefined ? {} : { text }),
        fileSelectionTokens: this.pendingFiles.map(({ selectionToken }) => selectionToken),
        folderSelectionTokens: this.pendingFolders.map(({ selectionToken }) => selectionToken),
      })
      this.offering = false
      if (!result.ok) {
        this.errorMessage = ERROR_MESSAGES_ZH_CN[result.error.code]
        return false
      }
      this.queueItems = [...result.data]
      this.clearPendingItems()
      return true
    },
    async cancelQueued(queueItemId: TransferQueueItemDto['queueItemId']): Promise<void> {
      const result = await window.lanTransfer.transfer.cancelQueued(queueItemId)
      if (!result.ok) {
        this.errorMessage = ERROR_MESSAGES_ZH_CN[result.error.code]
        return
      }
      this.queueItems = [...result.data]
    },
    async respond(decision: 'accept' | 'reject', chooseDirectory = false): Promise<void> {
      const offer = this.incomingOffer
      if (offer === null) return
      this.responding = true
      this.errorMessage = ''
      let directoryToken: string | undefined
      if (decision === 'accept' && chooseDirectory) {
        const directoryResult = await window.lanTransfer.settings.selectReceiveDirectory()
        if (!directoryResult.ok) {
          this.errorMessage = ERROR_MESSAGES_ZH_CN[directoryResult.error.code]
          this.responding = false
          return
        }
        directoryToken = directoryResult.data.directoryToken
      }
      const result = await window.lanTransfer.transfer.respondToOffer(
        offer.transferId,
        decision,
        directoryToken,
      )
      this.responding = false
      if (!result.ok) {
        this.errorMessage = ERROR_MESSAGES_ZH_CN[result.error.code]
        return
      }
      this.tasks = upsertTask(this.tasks, result.data)
      this.incomingOffer = null
    },
    async cancel(
      transferId: TransferTaskDto['transferId'],
      fileId?: TransferTaskDto['files'][number]['fileId'],
    ): Promise<void> {
      const result = await window.lanTransfer.transfer.cancel(transferId, fileId)
      if (!result.ok) {
        this.errorMessage = ERROR_MESSAGES_ZH_CN[result.error.code]
        return
      }
      this.tasks = upsertTask(this.tasks, result.data)
    },
    async retry(transferId: TransferTaskDto['transferId']): Promise<void> {
      const result = await window.lanTransfer.transfer.retry(transferId)
      if (!result.ok) {
        this.errorMessage = ERROR_MESSAGES_ZH_CN[result.error.code]
        return
      }
      this.tasks = upsertTask(this.tasks, result.data)
    },
    dispose(): void {
      for (const unsubscribe of this.unsubscribers) unsubscribe()
      this.unsubscribers = []
    },
  },
})

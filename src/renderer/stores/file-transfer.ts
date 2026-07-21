import { defineStore } from 'pinia'

import { MAX_FILES_PER_TRANSFER } from '@shared/constants'
import { ERROR_MESSAGES_ZH_CN } from '@shared/errors'
import type { FileOfferReceivedDto } from '@shared/ipc'
import type { SelectedFileDto, TransferTaskDto } from '@shared/types'

const upsertTask = (tasks: TransferTaskDto[], task: TransferTaskDto): TransferTaskDto[] => {
  const index = tasks.findIndex((candidate) => candidate.transferId === task.transferId)
  if (index < 0) return [task, ...tasks]
  return tasks.map((candidate, candidateIndex) => (candidateIndex === index ? task : candidate))
}

export const useFileTransferStore = defineStore('fileTransfer', {
  state: () => ({
    tasks: [] as TransferTaskDto[],
    pendingFiles: [] as SelectedFileDto[],
    incomingOffer: null as FileOfferReceivedDto | null,
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
    addPendingFiles(selections: readonly SelectedFileDto[]): void {
      if (this.pendingFiles.length + selections.length > MAX_FILES_PER_TRANSFER) {
        this.errorMessage = ERROR_MESSAGES_ZH_CN.FILE_COUNT_EXCEEDED
        return
      }
      this.pendingFiles = [...this.pendingFiles, ...selections]
    },
    removePendingFile(fileId: SelectedFileDto['fileId']): void {
      this.pendingFiles = this.pendingFiles.filter((file) => file.fileId !== fileId)
    },
    clearPendingFiles(): void {
      this.pendingFiles = []
    },
    async sendPendingFiles(): Promise<boolean> {
      if (this.pendingFiles.length === 0 || this.offering) return false
      this.offering = true
      this.errorMessage = ''
      const selectionTokens = this.pendingFiles.map(({ selectionToken }) => selectionToken)
      const offerResult = await window.lanTransfer.transfer.offerFiles(selectionTokens)
      this.offering = false
      if (!offerResult.ok) {
        this.errorMessage = ERROR_MESSAGES_ZH_CN[offerResult.error.code]
        return false
      }
      this.tasks = upsertTask(this.tasks, offerResult.data)
      this.pendingFiles = []
      return true
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

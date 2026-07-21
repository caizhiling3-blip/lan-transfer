import { defineStore } from 'pinia'

import { ERROR_MESSAGES_ZH_CN } from '@shared/errors'
import type { FileOfferReceivedDto } from '@shared/ipc'
import type { TransferTaskDto } from '@shared/types'

const upsertTask = (tasks: TransferTaskDto[], task: TransferTaskDto): TransferTaskDto[] => {
  const index = tasks.findIndex((candidate) => candidate.transferId === task.transferId)
  if (index < 0) return [task, ...tasks]
  return tasks.map((candidate, candidateIndex) => (candidateIndex === index ? task : candidate))
}

export const useFileTransferStore = defineStore('fileTransfer', {
  state: () => ({
    tasks: [] as TransferTaskDto[],
    incomingOffer: null as FileOfferReceivedDto | null,
    selecting: false,
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
    async selectAndOffer(multiple: boolean): Promise<void> {
      this.selecting = true
      this.errorMessage = ''
      const selectionResult = await window.lanTransfer.transfer.selectFiles(multiple)
      if (!selectionResult.ok) {
        this.errorMessage = ERROR_MESSAGES_ZH_CN[selectionResult.error.code]
        this.selecting = false
        return
      }
      if (selectionResult.data.length === 0) {
        this.selecting = false
        return
      }
      await this.offerSelections(selectionResult.data.map(({ selectionToken }) => selectionToken))
    },
    async registerDroppedFiles(files: readonly File[]): Promise<void> {
      this.selecting = true
      this.errorMessage = ''
      const selectionResult = await window.lanTransfer.transfer.registerDroppedFiles(files)
      if (!selectionResult.ok) {
        this.errorMessage = ERROR_MESSAGES_ZH_CN[selectionResult.error.code]
        this.selecting = false
        return
      }
      await this.offerSelections(selectionResult.data.map(({ selectionToken }) => selectionToken))
    },
    async offerSelections(selectionTokens: readonly string[]): Promise<void> {
      const offerResult = await window.lanTransfer.transfer.offerFiles(selectionTokens)
      this.selecting = false
      if (!offerResult.ok) {
        this.errorMessage = ERROR_MESSAGES_ZH_CN[offerResult.error.code]
        return
      }
      this.tasks = upsertTask(this.tasks, offerResult.data)
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

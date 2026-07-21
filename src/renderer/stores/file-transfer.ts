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
        }),
        window.lanTransfer.transfer.onOfferReceived((offer) => {
          this.incomingOffer = offer
        }),
      ]
    },
    async selectAndOffer(): Promise<void> {
      this.selecting = true
      this.errorMessage = ''
      const selectionResult = await window.lanTransfer.transfer.selectFiles(false)
      if (!selectionResult.ok) {
        this.errorMessage = ERROR_MESSAGES_ZH_CN[selectionResult.error.code]
        this.selecting = false
        return
      }
      const selected = selectionResult.data[0]
      if (selected === undefined) {
        this.selecting = false
        return
      }
      const offerResult = await window.lanTransfer.transfer.offerFiles([selected.selectionToken])
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
    dispose(): void {
      for (const unsubscribe of this.unsubscribers) unsubscribe()
      this.unsubscribers = []
    },
  },
})

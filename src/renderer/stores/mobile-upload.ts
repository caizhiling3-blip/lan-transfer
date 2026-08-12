import { defineStore } from 'pinia'

import type {
  MobileUploadOfferDto,
  MobileUploadSessionDto,
  MobileUploadTaskDto,
  MobileDownloadBatchDto,
} from '@shared/types'

const upsertTask = (
  tasks: readonly MobileUploadTaskDto[],
  task: MobileUploadTaskDto,
): MobileUploadTaskDto[] => {
  const index = tasks.findIndex(({ batchId }) => batchId === task.batchId)
  if (index < 0) return [task, ...tasks]
  return tasks.map((existing, candidateIndex) => (candidateIndex === index ? task : existing))
}

export const useMobileUploadStore = defineStore('mobileUpload', {
  state: () => ({
    session: null as MobileUploadSessionDto | null,
    offer: null as MobileUploadOfferDto | null,
    tasks: [] as MobileUploadTaskDto[],
    downloads: null as MobileDownloadBatchDto | null,
    initialized: false,
    unsubscribers: [] as (() => void)[],
  }),
  actions: {
    initialize(): void {
      if (this.initialized) return
      this.initialized = true
      this.unsubscribers = [
        window.lanTransfer.mobileUpload.onSessionChanged((session) => {
          this.session = session
          if (session === null) {
            this.offer = null
            this.downloads = null
          }
        }),
        window.lanTransfer.mobileUpload.onOfferReceived((offer) => {
          this.offer = offer
        }),
        window.lanTransfer.mobileUpload.onTaskChanged((task) => {
          this.tasks = upsertTask(this.tasks, task)
          if (this.offer?.batchId === task.batchId && task.status !== 'awaitingAcceptance') {
            this.offer = null
          }
        }),
        window.lanTransfer.mobileUpload.onDownloadsChanged((downloads) => {
          this.downloads = downloads
        }),
      ]
      void window.lanTransfer.mobileUpload.getSession().then((result) => {
        if (result.ok) this.session = result.data
      })
      void window.lanTransfer.mobileUpload.getDownloads().then((result) => {
        if (result.ok) this.downloads = result.data
      })
    },
    dispose(): void {
      for (const unsubscribe of this.unsubscribers) unsubscribe()
      this.unsubscribers = []
      this.initialized = false
    },
  },
})

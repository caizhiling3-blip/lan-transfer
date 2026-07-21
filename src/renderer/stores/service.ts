import { defineStore } from 'pinia'

import { DEFAULT_SERVICE_PORT } from '@shared/constants'
import { ERROR_MESSAGES_ZH_CN } from '@shared/errors'
import type { ServiceStatusDto } from '@shared/types'

const initialStatus: ServiceStatusDto = {
  state: 'stopped',
  ipAddresses: [],
  port: DEFAULT_SERVICE_PORT,
}

export const useServiceStore = defineStore('service', {
  state: () => ({
    status: initialStatus,
    loading: false,
    errorMessage: '',
    unsubscribe: null as (() => void) | null,
  }),
  actions: {
    async initialize(): Promise<void> {
      this.unsubscribe?.()
      this.unsubscribe = window.lanTransfer.service.onStatusChanged((status) => {
        this.applyStatus(status)
      })

      this.loading = true
      const result = await window.lanTransfer.service.getStatus()
      this.loading = false
      if (result.ok) {
        this.applyStatus(result.data)
      } else {
        this.errorMessage = ERROR_MESSAGES_ZH_CN[result.error.code]
      }
    },
    dispose(): void {
      this.unsubscribe?.()
      this.unsubscribe = null
    },
    applyStatus(status: ServiceStatusDto): void {
      this.status = status
      this.errorMessage = status.errorCode ? ERROR_MESSAGES_ZH_CN[status.errorCode] : ''
    },
  },
})

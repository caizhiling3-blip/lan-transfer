import { defineStore } from 'pinia'

import { ERROR_MESSAGES_ZH_CN } from '@shared/errors'
import type { UpdateSettingsDto, UpdateStatusDto } from '@shared/types'

export const useUpdatesStore = defineStore('updates', {
  state: () => ({
    settings: null as UpdateSettingsDto | null,
    status: null as UpdateStatusDto | null,
    loading: false,
    errorMessage: '',
    unsubscribe: null as (() => void) | null,
  }),
  actions: {
    async initialize(): Promise<void> {
      this.dispose()
      this.unsubscribe = window.lanTransfer.updates.onStatusChanged((status) => {
        this.status = status
        this.errorMessage = status.state === 'error' ? ERROR_MESSAGES_ZH_CN[status.errorCode] : ''
      })
      this.loading = true
      const [settings, status] = await Promise.all([
        window.lanTransfer.updates.getSettings(),
        window.lanTransfer.updates.getStatus(),
      ])
      this.loading = false
      if (settings.ok) this.settings = settings.data
      else this.errorMessage = ERROR_MESSAGES_ZH_CN[settings.error.code]
      if (status.ok) this.status = status.data
      else this.errorMessage = ERROR_MESSAGES_ZH_CN[status.error.code]
    },
    async setAutomaticChecksEnabled(enabled: boolean): Promise<void> {
      const result = await window.lanTransfer.updates.updateSettings(enabled)
      if (result.ok) this.settings = result.data
      else this.errorMessage = ERROR_MESSAGES_ZH_CN[result.error.code]
    },
    async check(): Promise<void> {
      await this.run(() => window.lanTransfer.updates.check())
    },
    async download(): Promise<void> {
      await this.run(() => window.lanTransfer.updates.download())
    },
    async cancelDownload(): Promise<void> {
      await this.run(() => window.lanTransfer.updates.cancelDownload())
    },
    async install(): Promise<void> {
      const result = await window.lanTransfer.updates.install()
      if (!result.ok) this.errorMessage = ERROR_MESSAGES_ZH_CN[result.error.code]
    },
    async run(operation: () => ReturnType<typeof window.lanTransfer.updates.check>): Promise<void> {
      this.errorMessage = ''
      const result = await operation()
      if (result.ok) {
        this.status = result.data
        if (result.data.state === 'error') {
          this.errorMessage = ERROR_MESSAGES_ZH_CN[result.data.errorCode]
        }
      } else this.errorMessage = ERROR_MESSAGES_ZH_CN[result.error.code]
    },
    dispose(): void {
      this.unsubscribe?.()
      this.unsubscribe = null
    },
  },
})

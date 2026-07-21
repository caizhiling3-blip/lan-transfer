import { defineStore } from 'pinia'

import { ERROR_MESSAGES_ZH_CN } from '@shared/errors'
import type { AppSettingsDto } from '@shared/types'

export const useSettingsStore = defineStore('settings', {
  state: () => ({
    settings: null as AppSettingsDto | null,
    loading: false,
    saving: false,
    errorMessage: '',
    unsubscribe: null as (() => void) | null,
  }),
  actions: {
    async initialize(): Promise<void> {
      this.dispose()
      this.unsubscribe = window.lanTransfer.settings.onChanged((settings) => {
        this.settings = settings
      })
      this.loading = true
      const result = await window.lanTransfer.settings.get()
      this.loading = false
      if (result.ok) this.settings = result.data
      else this.errorMessage = ERROR_MESSAGES_ZH_CN[result.error.code]
    },
    async save(patch: Parameters<typeof window.lanTransfer.settings.update>[0]): Promise<boolean> {
      this.saving = true
      this.errorMessage = ''
      const result = await window.lanTransfer.settings.update(patch)
      this.saving = false
      if (!result.ok) {
        this.errorMessage = ERROR_MESSAGES_ZH_CN[result.error.code]
        return false
      }
      this.settings = result.data
      return true
    },
    async chooseReceiveDirectory(): Promise<string | null> {
      const selection = await window.lanTransfer.settings.selectReceiveDirectory()
      if (!selection.ok) {
        this.errorMessage = ERROR_MESSAGES_ZH_CN[selection.error.code]
        return null
      }
      const saved = await this.save({ receiveDirectoryToken: selection.data.directoryToken })
      return saved ? selection.data.displayPath : null
    },
    dispose(): void {
      this.unsubscribe?.()
      this.unsubscribe = null
    },
  },
})

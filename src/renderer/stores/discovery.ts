import { defineStore } from 'pinia'

import { ERROR_MESSAGES_ZH_CN } from '@shared/errors'
import type { DiscoveredDeviceDto } from '@shared/types'

export const useDiscoveryStore = defineStore('discovery', {
  state: () => ({
    devices: [] as readonly DiscoveredDeviceDto[],
    errorMessage: '',
    unsubscribe: null as (() => void) | null,
  }),
  actions: {
    async initialize(): Promise<void> {
      this.dispose()
      this.unsubscribe = window.lanTransfer.discovery.onDevicesChanged((devices) => {
        this.devices = devices
      })
      const result = await window.lanTransfer.discovery.getDevices()
      if (result.ok) this.devices = result.data
      else this.errorMessage = ERROR_MESSAGES_ZH_CN[result.error.code]
    },
    dispose(): void {
      this.unsubscribe?.()
      this.unsubscribe = null
    },
  },
})

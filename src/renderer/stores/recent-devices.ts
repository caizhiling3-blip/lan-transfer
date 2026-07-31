import { defineStore } from 'pinia'

import { ERROR_MESSAGES_ZH_CN } from '@shared/errors'
import type { DeviceId, RecentDeviceDto } from '@shared/types'

export const useRecentDevicesStore = defineStore('recentDevices', {
  state: () => ({
    devices: [] as RecentDeviceDto[],
    loading: false,
    errorMessage: '',
  }),
  actions: {
    async load(): Promise<void> {
      this.loading = true
      this.errorMessage = ''
      const result = await window.lanTransfer.recentDevices.list()
      this.loading = false
      if (result.ok) this.devices = [...result.data]
      else this.errorMessage = ERROR_MESSAGES_ZH_CN[result.error.code]
    },
    async updateAlias(deviceId: DeviceId, alias: string | null): Promise<boolean> {
      const result = await window.lanTransfer.recentDevices.updateAlias(deviceId, alias)
      if (!result.ok) {
        this.errorMessage = ERROR_MESSAGES_ZH_CN[result.error.code]
        return false
      }
      this.devices = [...result.data]
      return true
    },
    async remove(deviceId: DeviceId): Promise<boolean> {
      const result = await window.lanTransfer.recentDevices.remove(deviceId)
      if (!result.ok) {
        this.errorMessage = ERROR_MESSAGES_ZH_CN[result.error.code]
        return false
      }
      this.devices = [...result.data]
      return true
    },
    async clear(): Promise<boolean> {
      const result = await window.lanTransfer.recentDevices.clear()
      if (!result.ok) {
        this.errorMessage = ERROR_MESSAGES_ZH_CN[result.error.code]
        return false
      }
      this.devices = []
      return true
    },
  },
})

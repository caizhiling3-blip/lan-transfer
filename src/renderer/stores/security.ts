import { defineStore } from 'pinia'

import { ERROR_MESSAGES_ZH_CN } from '@shared/errors'
import type { DeviceId, PairingRequestDto, RequestId, TrustedDeviceSummaryDto } from '@shared/types'

export const useSecurityStore = defineStore('security', {
  state: () => ({
    pendingPairing: null as PairingRequestDto | null,
    trustedDevices: [] as readonly TrustedDeviceSummaryDto[],
    loading: false,
    errorMessage: '',
    unsubscribers: [] as (() => void)[],
  }),
  actions: {
    async initialize(): Promise<void> {
      this.dispose()
      this.loading = true
      this.errorMessage = ''
      let pairingChangedAfterSubscribe = false
      let trustedDevicesChangedAfterSubscribe = false
      this.unsubscribers = [
        window.lanTransfer.pairing.onChanged((request) => {
          pairingChangedAfterSubscribe = true
          this.pendingPairing = request
        }),
        window.lanTransfer.trustedDevices.onChanged((devices) => {
          trustedDevicesChangedAfterSubscribe = true
          this.trustedDevices = devices
        }),
      ]
      const [pairingResult, trustedResult] = await Promise.all([
        window.lanTransfer.pairing.getPending(),
        window.lanTransfer.trustedDevices.list(),
      ])
      this.loading = false
      if (pairingResult.ok) {
        if (!pairingChangedAfterSubscribe) this.pendingPairing = pairingResult.data
      } else {
        this.errorMessage = ERROR_MESSAGES_ZH_CN[pairingResult.error.code]
      }
      if (trustedResult.ok) {
        if (!trustedDevicesChangedAfterSubscribe) this.trustedDevices = trustedResult.data
      } else {
        this.errorMessage = ERROR_MESSAGES_ZH_CN[trustedResult.error.code]
      }
    },
    async verifyCode(requestId: RequestId, verificationCode: string): Promise<boolean> {
      const result = await window.lanTransfer.pairing.respond(requestId, {
        decision: 'verify',
        verificationCode,
      })
      if (result.ok) return true
      this.errorMessage = ERROR_MESSAGES_ZH_CN[result.error.code]
      return false
    },
    async rejectPairing(requestId: RequestId): Promise<boolean> {
      const result = await window.lanTransfer.pairing.respond(requestId, { decision: 'reject' })
      if (result.ok) return true
      this.errorMessage = ERROR_MESSAGES_ZH_CN[result.error.code]
      return false
    },
    async revoke(deviceId: DeviceId): Promise<boolean> {
      const result = await window.lanTransfer.trustedDevices.revoke(deviceId)
      if (result.ok) {
        this.trustedDevices = result.data
        return true
      }
      this.errorMessage = ERROR_MESSAGES_ZH_CN[result.error.code]
      return false
    },
    async clearTrustedDevices(): Promise<boolean> {
      const result = await window.lanTransfer.trustedDevices.clear()
      if (result.ok) {
        this.trustedDevices = []
        return true
      }
      this.errorMessage = ERROR_MESSAGES_ZH_CN[result.error.code]
      return false
    },
    dispose(): void {
      for (const unsubscribe of this.unsubscribers) unsubscribe()
      this.unsubscribers = []
    },
  },
})

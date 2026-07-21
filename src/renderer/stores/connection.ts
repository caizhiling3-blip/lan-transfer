import { defineStore } from 'pinia'

import { ERROR_MESSAGES_ZH_CN } from '@shared/errors'
import type { ConnectionStatusDto, IncomingConnectionRequestDto } from '@shared/types'

export const useConnectionStore = defineStore('connection', {
  state: () => ({
    status: { state: 'disconnected' } as ConnectionStatusDto,
    incomingRequest: null as IncomingConnectionRequestDto | null,
    loading: false,
    errorMessage: '',
    unsubscribers: [] as (() => void)[],
  }),
  actions: {
    async initialize(): Promise<void> {
      this.dispose()
      this.unsubscribers = [
        window.lanTransfer.connection.onStateChanged((status) => this.applyStatus(status)),
        window.lanTransfer.connection.onIncomingRequest((request) => {
          if (this.incomingRequest?.requestId !== request.requestId) {
            this.incomingRequest = request
          }
        }),
      ]
      const result = await window.lanTransfer.connection.getStatus()
      if (result.ok) this.applyStatus(result.data)
      else this.errorMessage = ERROR_MESSAGES_ZH_CN[result.error.code]
    },
    async connect(host: string, port: number): Promise<void> {
      this.loading = true
      this.errorMessage = ''
      const result = await window.lanTransfer.connection.connect(host, port)
      this.loading = false
      if (result.ok) this.applyStatus(result.data)
      else this.errorMessage = ERROR_MESSAGES_ZH_CN[result.error.code]
    },
    async disconnect(): Promise<void> {
      const result = await window.lanTransfer.connection.disconnect()
      if (!result.ok) this.errorMessage = ERROR_MESSAGES_ZH_CN[result.error.code]
    },
    async respondToIncoming(
      requestId: IncomingConnectionRequestDto['requestId'],
      decision: 'accept' | 'reject',
    ): Promise<void> {
      const request = this.incomingRequest
      if (request === null || request.requestId !== requestId) return
      const result = await window.lanTransfer.connection.respondToRequest(requestId, decision)
      if (result.ok) this.applyStatus(result.data)
      else this.errorMessage = ERROR_MESSAGES_ZH_CN[result.error.code]
    },
    applyStatus(status: ConnectionStatusDto): void {
      this.status = status
      const pendingRequest = status.pendingRequest ?? null
      if (this.incomingRequest?.requestId !== pendingRequest?.requestId) {
        this.incomingRequest = pendingRequest
      }
      this.errorMessage = status.errorCode ? ERROR_MESSAGES_ZH_CN[status.errorCode] : ''
    },
    dispose(): void {
      for (const unsubscribe of this.unsubscribers) unsubscribe()
      this.unsubscribers = []
    },
  },
})

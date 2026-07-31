import { defineStore } from 'pinia'

import { ERROR_MESSAGES_ZH_CN } from '@shared/errors'
import type { DiagnosticsSummaryDto, LogStatsDto } from '@shared/types'

export const useDiagnosticsStore = defineStore('diagnostics', {
  state: () => ({
    summary: null as DiagnosticsSummaryDto | null,
    logStats: null as LogStatsDto | null,
    loading: false,
    errorMessage: '',
  }),
  actions: {
    async load(): Promise<void> {
      this.loading = true
      this.errorMessage = ''
      const [summary, logs] = await Promise.all([
        window.lanTransfer.diagnostics.getSummary(),
        window.lanTransfer.diagnostics.getLogStats(),
      ])
      this.loading = false
      if (!summary.ok) {
        this.errorMessage = ERROR_MESSAGES_ZH_CN[summary.error.code]
        return
      }
      if (!logs.ok) {
        this.errorMessage = ERROR_MESSAGES_ZH_CN[logs.error.code]
        return
      }
      this.summary = summary.data
      this.logStats = logs.data
    },
    async exportReport(): Promise<'saved' | 'cancelled' | 'failed'> {
      const result = await window.lanTransfer.diagnostics.exportReport()
      if (!result.ok) {
        this.errorMessage = ERROR_MESSAGES_ZH_CN[result.error.code]
        return 'failed'
      }
      return result.data ? 'saved' : 'cancelled'
    },
    async openDirectory(kind: 'data' | 'logs'): Promise<boolean> {
      const result =
        kind === 'data'
          ? await window.lanTransfer.diagnostics.openDataDirectory()
          : await window.lanTransfer.diagnostics.openLogDirectory()
      if (!result.ok) {
        this.errorMessage = ERROR_MESSAGES_ZH_CN[result.error.code]
        return false
      }
      return true
    },
    async clearLogs(): Promise<number | null> {
      const result = await window.lanTransfer.diagnostics.clearLogs()
      if (!result.ok) {
        this.errorMessage = ERROR_MESSAGES_ZH_CN[result.error.code]
        return null
      }
      await this.load()
      return result.data
    },
  },
})

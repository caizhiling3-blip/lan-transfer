import { defineStore } from 'pinia'

import { MAX_HISTORY_SEARCH_LENGTH } from '@shared/constants'
import { ERROR_MESSAGES_ZH_CN } from '@shared/errors'
import type {
  HistoryEntryDto,
  HistoryCleanupCriteriaDto,
  HistoryFilterDto,
  HistoryStatsDto,
  TransferDirection,
  TransferKind,
  TransferStatus,
} from '@shared/types'

const PAGE_SIZE = 50

export interface HistoryFilters {
  direction: 'all' | TransferDirection
  kind: 'all' | TransferKind
  status: 'all' | TransferStatus
  query: string
}

export const useHistoryStore = defineStore('history', {
  state: () => ({
    entries: [] as HistoryEntryDto[],
    filters: { direction: 'all', kind: 'all', status: 'all', query: '' } as HistoryFilters,
    page: 1,
    hasNextPage: false,
    loading: false,
    stats: { totalEntries: 0, matchingEntries: 0, storageBytes: 0 } as HistoryStatsDto,
    errorMessage: '',
  }),
  actions: {
    async load(resetPage = false): Promise<void> {
      if (resetPage) this.page = 1
      this.loading = true
      this.errorMessage = ''
      const filter: HistoryFilterDto = {
        offset: (this.page - 1) * PAGE_SIZE,
        limit: PAGE_SIZE,
        ...(this.filters.direction === 'all' ? {} : { direction: this.filters.direction }),
        ...(this.filters.kind === 'all' ? {} : { kind: this.filters.kind }),
        ...(this.filters.status === 'all' ? {} : { status: this.filters.status }),
        ...(this.filters.query.trim() === ''
          ? {}
          : { query: this.filters.query.trim().slice(0, MAX_HISTORY_SEARCH_LENGTH) }),
      }
      const result = await window.lanTransfer.history.list(filter)
      this.loading = false
      if (!result.ok) {
        this.errorMessage = ERROR_MESSAGES_ZH_CN[result.error.code]
        return
      }
      this.entries = [...result.data]
      this.hasNextPage = result.data.length === PAGE_SIZE
      await this.loadStats()
    },
    getCleanupCriteria(): HistoryCleanupCriteriaDto {
      return {
        ...(this.filters.direction === 'all' ? {} : { direction: this.filters.direction }),
        ...(this.filters.kind === 'all' ? {} : { kind: this.filters.kind }),
        ...(this.filters.status === 'all' ? {} : { statuses: [this.filters.status] }),
        ...(this.filters.query.trim() === ''
          ? {}
          : { query: this.filters.query.trim().slice(0, MAX_HISTORY_SEARCH_LENGTH) }),
      }
    },
    async loadStats(): Promise<void> {
      const criteria = this.getCleanupCriteria()
      const result = await window.lanTransfer.history.getStats(
        Object.keys(criteria).length === 0 ? undefined : criteria,
      )
      if (result.ok) this.stats = result.data
      else this.errorMessage = ERROR_MESSAGES_ZH_CN[result.error.code]
    },
    async delete(historyIds: readonly string[]): Promise<number> {
      const result = await window.lanTransfer.history.delete(historyIds)
      if (!result.ok) {
        this.errorMessage = ERROR_MESSAGES_ZH_CN[result.error.code]
        return 0
      }
      await this.load()
      return result.data
    },
    async previewCleanup(criteria: HistoryCleanupCriteriaDto): Promise<number | null> {
      const result = await window.lanTransfer.history.previewCleanup(criteria)
      if (!result.ok) {
        this.errorMessage = ERROR_MESSAGES_ZH_CN[result.error.code]
        return null
      }
      return result.data
    },
    async cleanup(criteria: HistoryCleanupCriteriaDto): Promise<number> {
      const result = await window.lanTransfer.history.cleanup(criteria)
      if (!result.ok) {
        this.errorMessage = ERROR_MESSAGES_ZH_CN[result.error.code]
        return 0
      }
      await this.load(true)
      return result.data
    },
    async clear(): Promise<boolean> {
      const result = await window.lanTransfer.history.clear()
      if (!result.ok) {
        this.errorMessage = ERROR_MESSAGES_ZH_CN[result.error.code]
        return false
      }
      this.entries = []
      this.page = 1
      this.hasNextPage = false
      await this.loadStats()
      return true
    },
    async previousPage(): Promise<void> {
      if (this.page <= 1) return
      this.page -= 1
      await this.load()
    },
    async nextPage(): Promise<void> {
      if (!this.hasNextPage) return
      this.page += 1
      await this.load()
    },
  },
})

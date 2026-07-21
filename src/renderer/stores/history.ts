import { defineStore } from 'pinia'

import { MAX_HISTORY_SEARCH_LENGTH } from '@shared/constants'
import { ERROR_MESSAGES_ZH_CN } from '@shared/errors'
import type {
  HistoryEntryDto,
  HistoryFilterDto,
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

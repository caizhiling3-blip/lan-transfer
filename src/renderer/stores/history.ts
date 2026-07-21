import { defineStore } from 'pinia'

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
  direction: '' | TransferDirection
  kind: '' | TransferKind
  status: '' | TransferStatus
}

export const useHistoryStore = defineStore('history', {
  state: () => ({
    entries: [] as HistoryEntryDto[],
    filters: { direction: '', kind: '', status: '' } as HistoryFilters,
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
        ...(this.filters.direction === '' ? {} : { direction: this.filters.direction }),
        ...(this.filters.kind === '' ? {} : { kind: this.filters.kind }),
        ...(this.filters.status === '' ? {} : { status: this.filters.status }),
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

import { randomUUID } from 'node:crypto'

import { DEFAULT_HISTORY_LIMIT } from '@shared/constants'
import type { HistoryEntryDto, HistoryFilterDto } from '@shared/types'

export class SessionHistory {
  private entries: HistoryEntryDto[] = []

  public constructor(private readonly maximumEntries = DEFAULT_HISTORY_LIMIT) {}

  public add(entry: Omit<HistoryEntryDto, 'id'>): HistoryEntryDto {
    const stored = { ...entry, id: randomUUID() }
    this.entries.unshift(stored)
    if (this.entries.length > this.maximumEntries) {
      this.entries.length = this.maximumEntries
    }
    return stored
  }

  public list(filter: HistoryFilterDto): readonly HistoryEntryDto[] {
    const filtered = this.entries.filter(
      (entry) =>
        (filter.direction === undefined || entry.direction === filter.direction) &&
        (filter.kind === undefined || entry.kind === filter.kind) &&
        (filter.status === undefined || entry.status === filter.status),
    )
    return filtered.slice(filter.offset, filter.offset + filter.limit)
  }

  public clear(): void {
    this.entries = []
  }
}

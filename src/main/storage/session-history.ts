import { randomUUID } from 'node:crypto'

import { DEFAULT_HISTORY_LIMIT, MAX_HISTORY_TEXT_PREVIEW_LENGTH } from '@shared/constants'
import type { HistoryEntryDto, HistoryFilterDto } from '@shared/types'

export class SessionHistory {
  private entries: HistoryEntryDto[] = []

  public constructor(
    private readonly maximumEntries: number | (() => number) = DEFAULT_HISTORY_LIMIT,
    initialEntries: readonly HistoryEntryDto[] = [],
    private readonly persist: (entries: readonly HistoryEntryDto[]) => void = () => undefined,
  ) {
    this.entries = [...initialEntries]
    const initialLength = this.entries.length
    this.enforceLimit()
    if (this.entries.length !== initialLength) this.persist(this.entries)
  }

  public add(entry: Omit<HistoryEntryDto, 'id'>): HistoryEntryDto {
    const stored = {
      ...entry,
      id: randomUUID(),
      ...(entry.textPreview === undefined
        ? {}
        : { textPreview: entry.textPreview.slice(0, MAX_HISTORY_TEXT_PREVIEW_LENGTH) }),
    }
    this.entries.unshift(stored)
    this.enforceLimit()
    this.persist(this.entries)
    return stored
  }

  public list(filter: HistoryFilterDto): readonly HistoryEntryDto[] {
    const normalizedQuery = filter.query?.normalize('NFKC').toLocaleLowerCase()
    const filtered = this.entries.filter(
      (entry) =>
        (filter.direction === undefined || entry.direction === filter.direction) &&
        (filter.kind === undefined || entry.kind === filter.kind) &&
        (filter.status === undefined || entry.status === filter.status) &&
        (normalizedQuery === undefined ||
          [entry.textPreview, entry.displayName, entry.peer.deviceName, entry.peer.ipAddress].some(
            (value) => value?.normalize('NFKC').toLocaleLowerCase().includes(normalizedQuery),
          )),
    )
    return filtered.slice(filter.offset, filter.offset + filter.limit)
  }

  public clear(): void {
    this.entries = []
    this.persist(this.entries)
  }

  public trimToLimit(): void {
    this.enforceLimit()
    this.persist(this.entries)
  }

  private enforceLimit(): void {
    const limit =
      typeof this.maximumEntries === 'function' ? this.maximumEntries() : this.maximumEntries
    if (this.entries.length > limit) this.entries.length = limit
  }
}

import { randomUUID } from 'node:crypto'

import { DEFAULT_HISTORY_LIMIT, MAX_HISTORY_TEXT_PREVIEW_LENGTH } from '@shared/constants'
import type {
  HistoryCleanupCriteriaDto,
  HistoryEntryDto,
  HistoryFilterDto,
  HistoryStatsDto,
} from '@shared/types'

export interface HistoryLocatorRegistry {
  get(historyId: string): string | null
  set(historyId: string, path: string): void
  delete(historyIds: readonly string[]): void
  clear(): void
}

const MILLISECONDS_PER_DAY = 86_400_000

const normalizeSearchValue = (value: string): string => value.normalize('NFKC').toLocaleLowerCase()

const matchesCriteria = (entry: HistoryEntryDto, criteria: HistoryCleanupCriteriaDto): boolean => {
  const normalizedQuery =
    criteria.query === undefined ? undefined : normalizeSearchValue(criteria.query)
  return (
    (criteria.direction === undefined || entry.direction === criteria.direction) &&
    (criteria.kind === undefined || entry.kind === criteria.kind) &&
    (criteria.statuses === undefined || criteria.statuses.includes(entry.status)) &&
    (criteria.before === undefined || entry.createdAt < criteria.before) &&
    (normalizedQuery === undefined ||
      [entry.textPreview, entry.displayName, entry.peer.deviceName, entry.peer.ipAddress].some(
        (value) => value !== undefined && normalizeSearchValue(value).includes(normalizedQuery),
      ))
  )
}

export class SessionHistory {
  private entries: HistoryEntryDto[] = []

  public constructor(
    private readonly maximumEntries: number | (() => number) = DEFAULT_HISTORY_LIMIT,
    initialEntries: readonly HistoryEntryDto[] = [],
    private readonly persist: (entries: readonly HistoryEntryDto[]) => void = () => undefined,
    private readonly retentionDays: number | null | (() => number | null) = null,
    private readonly locators?: HistoryLocatorRegistry,
  ) {
    this.entries = [...initialEntries]
    const initialLength = this.entries.length
    this.enforceLimit()
    if (this.entries.length !== initialLength) this.persist(this.entries)
  }

  public add(entry: Omit<HistoryEntryDto, 'id'>, receivedPath?: string): HistoryEntryDto {
    const stored = {
      ...entry,
      id: randomUUID(),
      ...(entry.textPreview === undefined
        ? {}
        : { textPreview: entry.textPreview.slice(0, MAX_HISTORY_TEXT_PREVIEW_LENGTH) }),
    }
    this.entries.unshift(stored)
    if (receivedPath !== undefined) this.locators?.set(stored.id, receivedPath)
    this.enforceLimit()
    this.persist(this.entries)
    return stored
  }

  public list(filter: HistoryFilterDto): readonly HistoryEntryDto[] {
    const criteria: HistoryCleanupCriteriaDto = {
      ...(filter.direction === undefined ? {} : { direction: filter.direction }),
      ...(filter.kind === undefined ? {} : { kind: filter.kind }),
      ...(filter.status === undefined ? {} : { statuses: [filter.status] }),
      ...(filter.query === undefined ? {} : { query: filter.query }),
    }
    const filtered = this.entries.filter((entry) => matchesCriteria(entry, criteria))
    return filtered
      .slice(filter.offset, filter.offset + filter.limit)
      .map((entry) =>
        entry.direction === 'receive' &&
        (entry.kind === 'file' || entry.kind === 'folder') &&
        entry.status === 'completed'
          ? { ...entry, locationAvailable: (this.locators?.get(entry.id) ?? null) !== null }
          : entry,
      )
  }

  public getStats(criteria: HistoryCleanupCriteriaDto = {}, storageBytes = 0): HistoryStatsDto {
    return {
      totalEntries: this.entries.length,
      matchingEntries: this.entries.filter((entry) => matchesCriteria(entry, criteria)).length,
      storageBytes,
    }
  }

  public delete(historyIds: readonly string[]): number {
    const ids = new Set(historyIds)
    const initialLength = this.entries.length
    this.entries = this.entries.filter((entry) => !ids.has(entry.id))
    const removed = initialLength - this.entries.length
    if (removed > 0) {
      this.locators?.delete(historyIds)
      this.persist(this.entries)
    }
    return removed
  }

  public previewCleanup(criteria: HistoryCleanupCriteriaDto): number {
    return this.entries.filter((entry) => matchesCriteria(entry, criteria)).length
  }

  public cleanup(criteria: HistoryCleanupCriteriaDto): number {
    const removedIds = this.entries
      .filter((entry) => matchesCriteria(entry, criteria))
      .map(({ id }) => id)
    const initialLength = this.entries.length
    this.entries = this.entries.filter((entry) => !matchesCriteria(entry, criteria))
    const removed = initialLength - this.entries.length
    if (removed > 0) {
      this.locators?.delete(removedIds)
      this.persist(this.entries)
    }
    return removed
  }

  public clear(): void {
    this.entries = []
    this.locators?.clear()
    this.persist(this.entries)
  }

  public getReceivedPath(historyId: string): string | null {
    const entry = this.entries.find(({ id }) => id === historyId)
    if (
      entry === undefined ||
      entry.direction !== 'receive' ||
      (entry.kind !== 'file' && entry.kind !== 'folder') ||
      entry.status !== 'completed'
    ) {
      return null
    }
    return this.locators?.get(historyId) ?? null
  }

  public trimToLimit(): void {
    this.enforceLimit()
    this.persist(this.entries)
  }

  private enforceLimit(): void {
    const previousIds = new Set(this.entries.map(({ id }) => id))
    const retentionDays =
      typeof this.retentionDays === 'function' ? this.retentionDays() : this.retentionDays
    if (retentionDays !== null) {
      const cutoff = Date.now() - retentionDays * MILLISECONDS_PER_DAY
      this.entries = this.entries.filter((entry) => entry.createdAt >= cutoff)
    }
    const limit =
      typeof this.maximumEntries === 'function' ? this.maximumEntries() : this.maximumEntries
    if (this.entries.length > limit) this.entries.length = limit
    const retainedIds = new Set(this.entries.map(({ id }) => id))
    this.locators?.delete([...previousIds].filter((id) => !retainedIds.has(id)))
  }
}

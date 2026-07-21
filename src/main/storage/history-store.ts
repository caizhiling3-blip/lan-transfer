import ElectronStore from 'electron-store'

import type { HistoryEntryDto } from '@shared/types'

import { backupInvalidStoreFile, historyStoreSchema } from './store-schemas'

type HistoryStoreData = {
  schemaVersion: 1
  entries: HistoryEntryDto[]
}

export class HistoryStore {
  private readonly store: ElectronStore<HistoryStoreData>

  public constructor(directory: string) {
    backupInvalidStoreFile(directory, 'history', historyStoreSchema)
    this.store = new ElectronStore<HistoryStoreData>({
      cwd: directory,
      name: 'history',
      defaults: { schemaVersion: 1, entries: [] },
    })
    historyStoreSchema.parse(this.store.store)
  }

  public load(): readonly HistoryEntryDto[] {
    return this.store.get('entries')
  }

  public save(entries: readonly HistoryEntryDto[]): void {
    const data = historyStoreSchema.parse({ schemaVersion: 1, entries })
    this.store.set('entries', data.entries)
  }
}

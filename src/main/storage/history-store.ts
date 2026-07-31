import ElectronStore from 'electron-store'
import { statSync } from 'node:fs'
import { join } from 'node:path'

import type { HistoryEntryDto } from '@shared/types'

import { backupInvalidStoreFile, historyStoreSchema } from './store-schemas'

type HistoryStoreData = {
  schemaVersion: 1
  entries: HistoryEntryDto[]
}

export class HistoryStore {
  private readonly store: ElectronStore<HistoryStoreData>
  private readonly filePath: string

  public constructor(directory: string) {
    this.filePath = join(directory, 'history.json')
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

  public getStorageBytes(): number {
    try {
      return statSync(this.filePath).size
    } catch {
      return 0
    }
  }
}

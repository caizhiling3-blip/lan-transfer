import ElectronStore from 'electron-store'

import { backupInvalidStoreFile, historyLocatorsStoreSchema } from './store-schemas'

type HistoryLocatorsStoreData = {
  schemaVersion: 1
  locators: Record<string, string>
}

export class HistoryLocatorsStore {
  private readonly store: ElectronStore<HistoryLocatorsStoreData>

  public constructor(directory: string) {
    backupInvalidStoreFile(directory, 'history-locators', historyLocatorsStoreSchema)
    this.store = new ElectronStore<HistoryLocatorsStoreData>({
      cwd: directory,
      name: 'history-locators',
      defaults: { schemaVersion: 1, locators: {} },
    })
    historyLocatorsStoreSchema.parse(this.store.store)
  }

  public get(historyId: string): string | null {
    return this.store.get('locators')[historyId] ?? null
  }

  public set(historyId: string, path: string): void {
    const locators = { ...this.store.get('locators'), [historyId]: path }
    const data = historyLocatorsStoreSchema.parse({ schemaVersion: 1, locators })
    this.store.set('locators', data.locators)
  }

  public delete(historyIds: readonly string[]): void {
    if (historyIds.length === 0) return
    const ids = new Set(historyIds)
    const locators = Object.fromEntries(
      Object.entries(this.store.get('locators')).filter(([historyId]) => !ids.has(historyId)),
    )
    this.store.set('locators', locators)
  }

  public clear(): void {
    this.store.set('locators', {})
  }
}

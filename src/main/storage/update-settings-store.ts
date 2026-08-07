import ElectronStore from 'electron-store'

import type { UpdateSettingsDto } from '@shared/types'

import { backupInvalidStoreFile, updateSettingsStoreSchema } from './store-schemas'

type UpdateSettingsStoreData = {
  schemaVersion: 1
  automaticChecksEnabled: boolean
  lastAutomaticCheckAt: number | null
}

type UpdateSettingsListener = (settings: UpdateSettingsDto) => void

export class UpdateSettingsStore {
  private readonly store: ElectronStore<UpdateSettingsStoreData>
  private readonly listeners = new Set<UpdateSettingsListener>()

  public constructor(directory: string) {
    backupInvalidStoreFile(directory, 'updates', updateSettingsStoreSchema)
    this.store = new ElectronStore<UpdateSettingsStoreData>({
      cwd: directory,
      name: 'updates',
      defaults: {
        schemaVersion: 1,
        automaticChecksEnabled: true,
        lastAutomaticCheckAt: null,
      },
    })
    updateSettingsStoreSchema.parse(this.store.store)
  }

  public getSettings(): UpdateSettingsDto {
    return { automaticChecksEnabled: this.store.get('automaticChecksEnabled') }
  }

  public getLastAutomaticCheckAt(): number | null {
    return this.store.get('lastAutomaticCheckAt')
  }

  public update(settings: UpdateSettingsDto): UpdateSettingsDto {
    const next = updateSettingsStoreSchema.parse({ ...this.store.store, ...settings })
    this.store.store = next
    const current = this.getSettings()
    for (const listener of this.listeners) listener(current)
    return current
  }

  public recordAutomaticCheck(timestamp: number): void {
    const next = updateSettingsStoreSchema.parse({
      ...this.store.store,
      lastAutomaticCheckAt: timestamp,
    })
    this.store.store = next
  }

  public subscribe(listener: UpdateSettingsListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}

import { randomUUID } from 'node:crypto'

import ElectronStore from 'electron-store'

import { DEFAULT_HISTORY_LIMIT, DEFAULT_SERVICE_PORT, MAX_FILE_SIZE_BYTES } from '@shared/constants'
import { deviceIdSchema } from '@shared/types'
import type { AppSettingsDto, DeviceId } from '@shared/types'

import { backupInvalidStoreFile, settingsStoreSchema } from './store-schemas'

type SettingsStoreData = {
  schemaVersion: 1
  deviceId: DeviceId
  deviceName: string
  receiveDirectory: string
  servicePort: number
  maxFileSizeBytes: number
  historyLimit: number
}

export interface SettingsPatch {
  deviceName?: string
  receiveDirectory?: string
  servicePort?: number
  maxFileSizeBytes?: number
  historyLimit?: number
}

type SettingsListener = (settings: AppSettingsDto) => void

export class SettingsStore {
  private readonly store: ElectronStore<SettingsStoreData>
  private readonly listeners = new Set<SettingsListener>()

  public constructor(
    directory: string,
    defaultDeviceName: string,
    defaultReceiveDirectory: string,
  ) {
    backupInvalidStoreFile(directory, 'settings', settingsStoreSchema)
    const defaults: SettingsStoreData = {
      schemaVersion: 1,
      deviceId: deviceIdSchema.parse(randomUUID()),
      deviceName: defaultDeviceName.trim().slice(0, 128) || 'LAN Transfer Device',
      receiveDirectory: defaultReceiveDirectory,
      servicePort: DEFAULT_SERVICE_PORT,
      maxFileSizeBytes: MAX_FILE_SIZE_BYTES,
      historyLimit: DEFAULT_HISTORY_LIMIT,
    }
    this.store = new ElectronStore<SettingsStoreData>({
      cwd: directory,
      name: 'settings',
      defaults,
    })
    settingsStoreSchema.parse(this.store.store)
  }

  public getDeviceId(): DeviceId {
    return this.store.get('deviceId')
  }

  public getReceiveDirectory(): string {
    return this.store.get('receiveDirectory')
  }

  public getSettings(): AppSettingsDto {
    return {
      deviceName: this.store.get('deviceName'),
      receiveDirectoryDisplayPath: this.store.get('receiveDirectory'),
      servicePort: this.store.get('servicePort'),
      maxFileSizeBytes: this.store.get('maxFileSizeBytes'),
      historyLimit: this.store.get('historyLimit'),
    }
  }

  public update(patch: SettingsPatch): AppSettingsDto {
    const next = settingsStoreSchema.parse({ ...this.store.store, ...patch })
    this.store.store = next
    const settings = this.getSettings()
    for (const listener of this.listeners) listener(settings)
    return settings
  }

  public subscribe(listener: SettingsListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}

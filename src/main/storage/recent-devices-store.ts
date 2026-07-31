import ElectronStore from 'electron-store'

import { MAX_RECENT_DEVICES } from '@shared/constants'
import type { DeviceInfo, RecentDeviceDto } from '@shared/types'

import {
  backupInvalidStoreFile,
  migrateRecentDevicesStoreData,
  recentDevicesStoreSchema,
} from './store-schemas'

type RecentDevicesStoreData = {
  schemaVersion: 2
  devices: RecentDeviceDto[]
}

export class RecentDevicesStore {
  private readonly store: ElectronStore<RecentDevicesStoreData>

  public constructor(directory: string) {
    backupInvalidStoreFile(
      directory,
      'recent-devices',
      recentDevicesStoreSchema,
      migrateRecentDevicesStoreData,
    )
    this.store = new ElectronStore<RecentDevicesStoreData>({
      cwd: directory,
      name: 'recent-devices',
      defaults: { schemaVersion: 2, devices: [] },
    })
    recentDevicesStoreSchema.parse(this.store.store)
  }

  public add(device: DeviceInfo): void {
    const current = this.list()
    const existing = current.find((entry) => entry.device.deviceId === device.deviceId)
    const devices = current.filter((entry) => entry.device.deviceId !== device.deviceId)
    devices.unshift({
      device,
      lastConnectedAt: Date.now(),
      ...(existing?.alias === undefined ? {} : { alias: existing.alias }),
    })
    this.store.set('devices', devices.slice(0, MAX_RECENT_DEVICES))
  }

  public list(): RecentDeviceDto[] {
    return [...this.store.get('devices')]
  }
}

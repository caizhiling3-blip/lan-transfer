import ElectronStore from 'electron-store'

import { MAX_RECENT_DEVICES } from '@shared/constants'
import type { DeviceId, DeviceInfo, RecentDeviceDto } from '@shared/types'

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

  public updateAlias(deviceId: DeviceId, alias: string | null): RecentDeviceDto[] {
    const devices = this.list().map((entry) => {
      if (entry.device.deviceId !== deviceId) return entry
      const entryWithoutAlias: RecentDeviceDto = {
        device: entry.device,
        lastConnectedAt: entry.lastConnectedAt,
      }
      return alias === null ? entryWithoutAlias : { ...entryWithoutAlias, alias }
    })
    this.store.set('devices', devices)
    return devices
  }

  public remove(deviceId: DeviceId): RecentDeviceDto[] {
    const devices = this.list().filter((entry) => entry.device.deviceId !== deviceId)
    this.store.set('devices', devices)
    return devices
  }

  public clear(): void {
    this.store.set('devices', [])
  }
}

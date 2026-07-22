import { isIP } from 'node:net'

import {
  DISCOVERY_DEVICE_EXPIRY_MS,
  MAX_DISCOVERED_DEVICES,
  MESSAGE_CLOCK_SKEW_MS,
} from '@shared/constants'
import { discoveryAnnouncementSchema } from '@shared/protocols'
import type { DeviceId, DiscoveredDeviceDto } from '@shared/types'

export class DiscoveryRegistry {
  private readonly devices = new Map<DeviceId, DiscoveredDeviceDto>()

  public constructor(private readonly localDeviceId: DeviceId) {}

  public accept(input: unknown, sourceAddress: string, now = Date.now()): boolean {
    const parsed = discoveryAnnouncementSchema.safeParse(input)
    if (
      !parsed.success ||
      parsed.data.deviceId === this.localDeviceId ||
      isIP(sourceAddress) !== 4 ||
      Math.abs(now - parsed.data.timestamp) > MESSAGE_CLOCK_SKEW_MS
    ) {
      return false
    }

    const existing = this.devices.get(parsed.data.deviceId)
    const discovered: DiscoveredDeviceDto = {
      device: {
        deviceId: parsed.data.deviceId,
        deviceName: parsed.data.deviceName,
        operatingSystem: parsed.data.operatingSystem,
        ipAddress: sourceAddress,
        servicePort: parsed.data.servicePort,
      },
      lastSeenAt: now,
    }
    this.devices.delete(parsed.data.deviceId)
    this.devices.set(parsed.data.deviceId, discovered)
    while (this.devices.size > MAX_DISCOVERED_DEVICES) {
      const oldestDeviceId = this.devices.keys().next().value
      if (oldestDeviceId === undefined) break
      this.devices.delete(oldestDeviceId)
    }
    return existing?.device.ipAddress !== discovered.device.ipAddress ||
      existing?.device.servicePort !== discovered.device.servicePort ||
      existing?.device.deviceName !== discovered.device.deviceName ||
      existing?.device.operatingSystem !== discovered.device.operatingSystem
      ? true
      : existing === undefined
  }

  public removeExpired(now = Date.now()): boolean {
    let changed = false
    for (const [deviceId, discovered] of this.devices) {
      if (now - discovered.lastSeenAt > DISCOVERY_DEVICE_EXPIRY_MS) {
        this.devices.delete(deviceId)
        changed = true
      }
    }
    return changed
  }

  public list(): readonly DiscoveredDeviceDto[] {
    return [...this.devices.values()].sort(
      (left, right) =>
        right.lastSeenAt - left.lastSeenAt ||
        left.device.deviceName.localeCompare(right.device.deviceName),
    )
  }
}

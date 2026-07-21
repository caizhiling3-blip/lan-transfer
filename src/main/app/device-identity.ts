import type { DeviceInfo, OperatingSystem, ServiceStatusDto } from '@shared/types'

import type { SettingsStore } from '../storage'

const getOperatingSystem = (): OperatingSystem => {
  if (process.platform === 'win32') return 'windows'
  if (process.platform === 'darwin') return 'macos'
  throw new Error(`Unsupported platform: ${process.platform}`)
}

export class DeviceIdentity {
  private readonly operatingSystem = getOperatingSystem()

  public constructor(private readonly settings: SettingsStore) {}

  public getDeviceInfo(serviceStatus: ServiceStatusDto): DeviceInfo {
    return {
      deviceId: this.settings.getDeviceId(),
      deviceName: this.settings.getSettings().deviceName,
      operatingSystem: this.operatingSystem,
      ipAddress: serviceStatus.ipAddresses[0] ?? '127.0.0.1',
      servicePort: serviceStatus.port,
    }
  }

  public getPlatform(): OperatingSystem {
    return this.operatingSystem
  }
}

import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'

import { deviceIdSchema } from '@shared/types'
import type { DeviceId, DeviceInfo, OperatingSystem, ServiceStatusDto } from '@shared/types'

const getOperatingSystem = (): OperatingSystem => {
  if (process.platform === 'win32') return 'windows'
  if (process.platform === 'darwin') return 'macos'
  throw new Error(`Unsupported platform: ${process.platform}`)
}

export class DeviceIdentity {
  private readonly deviceId: DeviceId = deviceIdSchema.parse(randomUUID())
  private readonly deviceName = hostname().trim().slice(0, 128) || 'LAN Transfer Device'
  private readonly operatingSystem = getOperatingSystem()

  public getDeviceInfo(serviceStatus: ServiceStatusDto): DeviceInfo {
    return {
      deviceId: this.deviceId,
      deviceName: this.deviceName,
      operatingSystem: this.operatingSystem,
      ipAddress: serviceStatus.ipAddresses[0] ?? '127.0.0.1',
      servicePort: serviceStatus.port,
    }
  }

  public getPlatform(): OperatingSystem {
    return this.operatingSystem
  }
}

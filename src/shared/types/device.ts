import type { DeviceId } from './identifiers'

export type OperatingSystem = 'windows' | 'macos'

export interface DeviceInfo {
  readonly deviceId: DeviceId
  readonly deviceName: string
  readonly operatingSystem: OperatingSystem
  readonly ipAddress: string
  readonly servicePort: number
}

export interface DiscoveredDeviceDto {
  readonly device: DeviceInfo
  readonly lastSeenAt: number
}

export type ServiceState = 'stopped' | 'starting' | 'running' | 'error'

export type ConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'awaitingApproval'
  | 'authenticating'
  | 'pairingRequired'
  | 'connected'
  | 'disconnecting'
  | 'error'

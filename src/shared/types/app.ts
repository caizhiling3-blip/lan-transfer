import type { ErrorCode } from '../errors'
import type { ConnectionState, DeviceInfo, OperatingSystem, ServiceState } from './device'
import type { ConnectionId, FileId, RequestId, TransferId } from './identifiers'
import type { TransferDirection, TransferKind, TransferStatus } from './transfer'

export interface RuntimeInfoDto {
  readonly appVersion: string
  readonly platform: OperatingSystem
  readonly localDevice: DeviceInfo
}

export interface ServiceStatusDto {
  readonly state: ServiceState
  readonly ipAddresses: readonly string[]
  readonly port: number
  readonly errorCode?: ErrorCode
}

export interface ConnectionStatusDto {
  readonly state: ConnectionState
  readonly connectionId?: ConnectionId
  readonly peer?: DeviceInfo
  readonly pendingRequest?: IncomingConnectionRequestDto
  readonly errorCode?: ErrorCode
}

export interface IncomingConnectionRequestDto {
  readonly requestId: RequestId
  readonly peer: DeviceInfo
  readonly receivedAt: number
}

export interface SelectedFileDto {
  readonly selectionToken: string
  readonly fileId: FileId
  readonly displayName: string
  readonly size: number
  readonly mimeType: string
}

export interface SelectedDirectoryDto {
  readonly directoryToken: string
  readonly displayPath: string
}

export interface AppSettingsDto {
  readonly deviceName: string
  readonly receiveDirectoryDisplayPath: string
  readonly servicePort: number
  readonly maxFileSizeBytes: number
  readonly historyLimit: number
}

export interface HistoryEntryDto {
  readonly id: string
  readonly transferId?: TransferId
  readonly direction: TransferDirection
  readonly kind: TransferKind
  readonly peer: DeviceInfo
  readonly status: TransferStatus
  readonly displayName?: string
  readonly size?: number
  readonly textPreview?: string
  readonly createdAt: number
  readonly errorCode?: ErrorCode
}

export interface HistoryFilterDto {
  readonly direction?: TransferDirection
  readonly kind?: TransferKind
  readonly status?: TransferStatus
  readonly offset: number
  readonly limit: number
}

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
  readonly historyRetentionDays: number | null
  readonly logRetentionDays: number
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
  readonly locationAvailable?: boolean
}

export interface HistoryFilterDto {
  readonly direction?: TransferDirection
  readonly kind?: TransferKind
  readonly status?: TransferStatus
  readonly query?: string
  readonly offset: number
  readonly limit: number
}

export interface RecentDeviceDto {
  readonly device: DeviceInfo
  readonly lastConnectedAt: number
  readonly alias?: string
}

export interface HistoryCleanupCriteriaDto {
  readonly direction?: TransferDirection
  readonly kind?: TransferKind
  readonly statuses?: readonly TransferStatus[]
  readonly query?: string
  readonly before?: number
}

export interface HistoryStatsDto {
  readonly totalEntries: number
  readonly matchingEntries: number
  readonly storageBytes: number
}

export interface LogStatsDto {
  readonly fileCount: number
  readonly storageBytes: number
  readonly oldestEntryAt?: number
}

export interface DiagnosticsSummaryDto {
  readonly appVersion: string
  readonly platform: OperatingSystem
  readonly architecture: string
  readonly service: ServiceStatusDto
  readonly connectionState: ConnectionState
  readonly discoveryRunning: boolean
  readonly activeTransferCount: number
  readonly recoverableTransferCount: number
  readonly historyEntries: number
  readonly historyStorageBytes: number
  readonly logFiles: number
  readonly logStorageBytes: number
}

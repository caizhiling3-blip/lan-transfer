import type { ErrorCode } from '../errors'
import type { DeviceInfo } from './device'
import type { FileId, TransferId } from './identifiers'

export type TransferDirection = 'send' | 'receive'
export type TransferKind = 'text' | 'link' | 'file'

export type TransferStatus =
  | 'pending'
  | 'awaitingAcceptance'
  | 'accepted'
  | 'transferring'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'rejected'

export type FileTransferStatus =
  'pending' | 'transferring' | 'completed' | 'failed' | 'cancelled' | 'rejected'

export interface FileMetadata {
  readonly fileId: FileId
  readonly displayName: string
  readonly size: number
  readonly mimeType: string
}

export interface FileTransferItemDto extends FileMetadata {
  readonly transferredBytes: number
  readonly bytesPerSecond: number
  readonly status: FileTransferStatus
  readonly errorCode?: ErrorCode
}

export interface TransferTaskDto {
  readonly transferId: TransferId
  readonly direction: TransferDirection
  readonly kind: TransferKind
  readonly peer: DeviceInfo
  readonly status: TransferStatus
  readonly files: readonly FileTransferItemDto[]
  readonly totalBytes: number
  readonly transferredBytes: number
  readonly bytesPerSecond: number
  readonly createdAt: number
  readonly updatedAt: number
  readonly errorCode?: ErrorCode
}

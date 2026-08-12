import type { ErrorCode } from '../errors'
import type { FileMetadata } from './transfer'
import type { MobileUploadBatchId, MobileUploadSessionId } from './identifiers'

export type MobileUploadSessionState = 'active' | 'closed' | 'expired'

export interface MobileUploadSessionDto {
  readonly sessionId: MobileUploadSessionId
  readonly state: MobileUploadSessionState
  readonly urls: readonly string[]
  readonly createdAt: number
  readonly expiresAt: number
}

export type MobileUploadBatchStatus =
  | 'awaitingAcceptance'
  | 'accepted'
  | 'transferring'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'rejected'

export interface MobileUploadOfferDto {
  readonly sessionId: MobileUploadSessionId
  readonly batchId: MobileUploadBatchId
  readonly sourceAddress: string
  readonly files: readonly FileMetadata[]
  readonly totalBytes: number
  readonly receivedAt: number
}

export interface MobileUploadTaskDto extends MobileUploadOfferDto {
  readonly status: MobileUploadBatchStatus
  readonly fileItems: readonly MobileUploadFileItemDto[]
  readonly transferredBytes: number
  readonly updatedAt: number
  readonly errorCode?: ErrorCode
}

export interface MobileUploadFileItemDto extends FileMetadata {
  readonly status: 'pending' | 'transferring' | 'completed' | 'failed' | 'cancelled' | 'rejected'
  readonly transferredBytes: number
  readonly errorCode?: ErrorCode
}

export interface MobileDownloadFileItemDto extends FileMetadata {
  readonly status: 'available' | 'downloaded'
}

export interface MobileDownloadBatchDto {
  readonly files: readonly MobileDownloadFileItemDto[]
  readonly createdAt: number
  readonly updatedAt: number
}

import type { DeviceInfo } from './device'
import type { DeviceId, RequestId, TransferId } from './identifiers'
import type { TransferStatus } from './transfer'

export type IdentityKeyAlgorithm = 'Ed25519'
export type KeyAgreementAlgorithm = 'X25519'
export type ContentEncryptionAlgorithm = 'AES-256-GCM'

export interface PublicIdentityDto {
  readonly algorithm: IdentityKeyAlgorithm
  readonly publicKey: string
  readonly fingerprint: string
}

export interface PairingRequestDto {
  readonly requestId: RequestId
  readonly peer: DeviceInfo
  readonly peerIdentity: PublicIdentityDto
  readonly verificationCode: string
  readonly expiresAt: number
}

export interface TrustedDeviceDto {
  readonly deviceId: DeviceId
  readonly identity: PublicIdentityDto
  readonly firstPairedAt: number
  readonly lastVerifiedAt: number
}

export type SecureSessionState =
  | 'handshaking'
  | 'pairingRequired'
  | 'awaitingPairingConfirmation'
  | 'authenticated'
  | 'closed'
  | 'error'

export type RecoverableTransferStatus =
  TransferStatus | 'paused' | 'reconnecting' | 'verifying' | 'recoverable'

export interface RecoverableTransferSummaryDto {
  readonly transferId: TransferId
  readonly peerDeviceId: DeviceId
  readonly status: RecoverableTransferStatus
  readonly verifiedBytes: number
  readonly totalBytes: number
  readonly missingChunkCount: number
  readonly expiresAt: number
}

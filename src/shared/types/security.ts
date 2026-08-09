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

interface PairingRequestBaseDto {
  readonly requestId: RequestId
  readonly peer: DeviceInfo
  readonly peerFingerprint: string
  readonly expiresAt: number
}

export type PairingRequestDto = PairingRequestBaseDto &
  (
    | { readonly verificationMode: 'display'; readonly verificationCode: string }
    | { readonly verificationMode: 'input' }
  )

export interface TrustedDeviceDto {
  readonly deviceId: DeviceId
  readonly identity: PublicIdentityDto
  readonly firstPairedAt: number
  readonly lastVerifiedAt: number
}

export interface TrustedDeviceSummaryDto {
  readonly deviceId: DeviceId
  readonly fingerprint: string
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

export type RecoverableTransferStatus = TransferStatus

export interface RecoverableTransferSummaryDto {
  readonly transferId: TransferId
  readonly peerDeviceId: DeviceId
  readonly status: RecoverableTransferStatus
  readonly verifiedBytes: number
  readonly totalBytes: number
  readonly missingChunkCount: number
  readonly expiresAt: number
}

import {
  createHash,
  createHmac,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  type KeyObject,
} from 'node:crypto'

import { SECURE_PROTOCOL_VERSION } from '@shared/constants'
import { ephemeralPublicKeySchema, handshakeNonceSchema } from '@shared/protocols'
import type { DeviceId, PublicIdentityDto } from '@shared/types'

const CONFIRMATION_KEY_CONTEXT = 'lindu/v3/transcript-confirmation'
const VERIFICATION_CODE_CONTEXT = 'lindu/v3/pairing-verification-code'
const CONFIRMATION_KEY_BYTES = 32
const VERIFICATION_CODE_MODULUS = 1_000_000

export interface EphemeralKeyPair {
  readonly publicKey: string
  readonly privateKey: KeyObject
}

export interface SecureHandshakeTranscriptInput {
  readonly initiatorDeviceId: DeviceId
  readonly responderDeviceId: DeviceId
  readonly initiatorNonce: string
  readonly responderNonce: string
  readonly initiatorEphemeralPublicKey: string
  readonly responderEphemeralPublicKey: string
  readonly initiatorIdentity: PublicIdentityDto
  readonly responderIdentity: PublicIdentityDto
}

export const generateHandshakeNonce = (): string => randomBytes(32).toString('base64')

export const generateEphemeralKeyPair = (): EphemeralKeyPair => {
  const { publicKey, privateKey } = generateKeyPairSync('x25519')
  return {
    publicKey: ephemeralPublicKeySchema.parse(
      publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    ),
    privateKey,
  }
}

export const serializeSecureHandshakeTranscript = (
  input: SecureHandshakeTranscriptInput,
): Buffer => {
  handshakeNonceSchema.parse(input.initiatorNonce)
  handshakeNonceSchema.parse(input.responderNonce)
  ephemeralPublicKeySchema.parse(input.initiatorEphemeralPublicKey)
  ephemeralPublicKeySchema.parse(input.responderEphemeralPublicKey)
  return Buffer.from(
    JSON.stringify([
      'lindu-secure-handshake',
      SECURE_PROTOCOL_VERSION,
      input.initiatorDeviceId,
      input.responderDeviceId,
      input.initiatorNonce,
      input.responderNonce,
      input.initiatorEphemeralPublicKey,
      input.responderEphemeralPublicKey,
      input.initiatorIdentity.publicKey,
      input.responderIdentity.publicKey,
    ]),
    'utf8',
  )
}

export const deriveSharedSecret = (privateKey: KeyObject, remotePublicKey: string): Buffer => {
  if (privateKey.asymmetricKeyType !== 'x25519') throw new Error('Private key must be X25519')
  const publicKey = createPublicKey({
    key: Buffer.from(ephemeralPublicKeySchema.parse(remotePublicKey), 'base64'),
    format: 'der',
    type: 'spki',
  })
  if (publicKey.asymmetricKeyType !== 'x25519') throw new Error('Public key must be X25519')
  return diffieHellman({ privateKey, publicKey })
}

export const deriveTranscriptConfirmationKey = (
  sharedSecret: Uint8Array,
  transcript: Uint8Array,
): Buffer => {
  if (sharedSecret.byteLength !== 32) throw new Error('X25519 shared secret must be 32 bytes')
  const transcriptHash = createHash('sha256').update(transcript).digest()
  return Buffer.from(
    hkdfSync(
      'sha256',
      Buffer.from(sharedSecret),
      transcriptHash,
      Buffer.from(CONFIRMATION_KEY_CONTEXT, 'utf8'),
      CONFIRMATION_KEY_BYTES,
    ),
  )
}

export const createPairingVerificationCode = (confirmationKey: Uint8Array): string => {
  if (confirmationKey.byteLength !== CONFIRMATION_KEY_BYTES) {
    throw new Error('Pairing confirmation key must be 32 bytes')
  }
  const digest = createHmac('sha256', Buffer.from(confirmationKey))
    .update(VERIFICATION_CODE_CONTEXT, 'utf8')
    .digest()
  return String(digest.readUInt32BE(0) % VERIFICATION_CODE_MODULUS).padStart(6, '0')
}

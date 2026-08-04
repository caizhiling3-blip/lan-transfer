import { describe, expect, it } from 'vitest'

import {
  DEFAULT_FILE_CHUNK_SIZE_BYTES,
  MAX_FILE_CHUNKS,
  SECURE_PROTOCOL_VERSION,
} from '@shared/constants'
import {
  encryptedChunkDescriptorSchema,
  encryptedEnvelopeSchema,
  pairingDecisionMessageSchema,
  pairingVerificationCodeSchema,
  parseSecureControlMessage,
  parseSecureHandshakeMessage,
  publicIdentitySchema,
  secureFileMetadataSchema,
  transferResumeStateMessageSchema,
} from '@shared/protocols'

const DEVICE_ID = '11111111-1111-4111-8111-111111111111'
const PEER_DEVICE_ID = '22222222-2222-4222-8222-222222222222'
const MESSAGE_ID = '33333333-3333-4333-8333-333333333333'
const CONNECTION_ID = '44444444-4444-4444-8444-444444444444'
const REQUEST_ID = '55555555-5555-4555-8555-555555555555'
const TRANSFER_ID = '66666666-6666-4666-8666-666666666666'
const FILE_ID = '77777777-7777-4777-8777-777777777777'

const publicKey = `${'A'.repeat(59)}=`
const nonce = `${'A'.repeat(43)}=`
const signature = `${'A'.repeat(86)}==`
const authenticationTag = `${'A'.repeat(22)}==`
const sha256 = 'a'.repeat(64)
const baseMessage = { messageId: MESSAGE_ID, senderId: DEVICE_ID, timestamp: 1_700_000_000_000 }
const device = {
  deviceId: DEVICE_ID,
  deviceName: 'Secure Mac',
  operatingSystem: 'macos',
  ipAddress: '192.168.1.20',
  servicePort: 53_317,
}
const identity = { algorithm: 'Ed25519', publicKey, fingerprint: sha256 }

describe('secure handshake schemas', () => {
  const hello = {
    type: 'secure:hello',
    ...baseMessage,
    payload: {
      protocolVersion: SECURE_PROTOCOL_VERSION,
      device,
      identity,
      keyAgreement: 'X25519',
      ephemeralPublicKey: publicKey,
      nonce,
    },
  }
  const challenge = {
    type: 'secure:challenge',
    ...baseMessage,
    senderId: PEER_DEVICE_ID,
    payload: {
      ...hello.payload,
      device: { ...device, deviceId: PEER_DEVICE_ID },
      connectionId: CONNECTION_ID,
      signature,
    },
  }
  const proof = {
    type: 'secure:proof',
    ...baseMessage,
    payload: {
      protocolVersion: SECURE_PROTOCOL_VERSION,
      connectionId: CONNECTION_ID,
      signature,
    },
  }

  it.each([hello, challenge, proof])('parses $type', (message) => {
    expect(parseSecureHandshakeMessage(message).type).toBe(message.type)
  })

  it.each([
    { ...hello, payload: { ...hello.payload, protocolVersion: 2 } },
    { ...hello, payload: { ...hello.payload, ephemeralPublicKey: 'short' } },
    { ...hello, payload: { ...hello.payload, nonce: `${'A'.repeat(44)}` } },
    { ...challenge, payload: { ...challenge.payload, signature: `${'A'.repeat(88)}` } },
    { ...proof, extra: true },
  ])('rejects malformed or downgrade handshake input', (message) => {
    expect(() => parseSecureHandshakeMessage(message)).toThrow()
  })

  it('validates public identities and pairing codes', () => {
    expect(publicIdentitySchema.safeParse(identity).success).toBe(true)
    expect(pairingVerificationCodeSchema.safeParse('012345').success).toBe(true)
    expect(pairingVerificationCodeSchema.safeParse('12345').success).toBe(false)
    expect(
      publicIdentitySchema.safeParse({ ...identity, fingerprint: 'A'.repeat(64) }).success,
    ).toBe(false)
  })
})

describe('encrypted envelope schema', () => {
  const envelope = {
    version: SECURE_PROTOCOL_VERSION,
    connectionId: CONNECTION_ID,
    sequence: 0,
    ciphertext: 'AAAA',
    authenticationTag,
  }

  it('accepts a strict bounded envelope', () => {
    expect(encryptedEnvelopeSchema.safeParse(envelope).success).toBe(true)
  })

  it.each([
    { ...envelope, version: 2 },
    { ...envelope, sequence: -1 },
    { ...envelope, sequence: Number.MAX_SAFE_INTEGER + 1 },
    { ...envelope, ciphertext: 'not base64' },
    { ...envelope, authenticationTag: `${'A'.repeat(24)}` },
    { ...envelope, nonce: nonce },
  ])('rejects invalid encrypted envelope input', (input) => {
    expect(encryptedEnvelopeSchema.safeParse(input).success).toBe(false)
  })
})

describe('secure transfer contracts', () => {
  const metadata = {
    fileId: FILE_ID,
    displayName: 'report.bin',
    size: DEFAULT_FILE_CHUNK_SIZE_BYTES,
    mimeType: 'application/octet-stream',
    sha256,
    chunkSize: DEFAULT_FILE_CHUNK_SIZE_BYTES,
    chunkCount: 1,
  }

  it('accepts secure metadata and chunk descriptor boundaries', () => {
    expect(secureFileMetadataSchema.safeParse(metadata).success).toBe(true)
    expect(
      encryptedChunkDescriptorSchema.safeParse({
        transferId: TRANSFER_ID,
        fileId: FILE_ID,
        chunkIndex: 0,
        plaintextOffset: 0,
        plaintextLength: DEFAULT_FILE_CHUNK_SIZE_BYTES,
        ciphertextLength: DEFAULT_FILE_CHUNK_SIZE_BYTES + 16,
      }).success,
    ).toBe(true)
  })

  it.each([
    { ...metadata, sha256: 'invalid' },
    { ...metadata, chunkSize: 1_024 },
    { ...metadata, chunkCount: MAX_FILE_CHUNKS + 1 },
  ])('rejects malformed secure file metadata', (input) => {
    expect(secureFileMetadataSchema.safeParse(input).success).toBe(false)
  })

  it('parses pairing, pause, resume request, and bounded resume state messages', () => {
    expect(
      pairingDecisionMessageSchema.safeParse({
        type: 'pairing:decision',
        ...baseMessage,
        payload: { requestId: REQUEST_ID, connectionId: CONNECTION_ID, decision: 'accept' },
      }).success,
    ).toBe(true)
    expect(() =>
      parseSecureControlMessage({
        type: 'transfer:pause',
        ...baseMessage,
        payload: { transferId: TRANSFER_ID },
      }),
    ).not.toThrow()
    expect(() =>
      parseSecureControlMessage({
        type: 'transfer:resume-request',
        ...baseMessage,
        payload: { transferId: TRANSFER_ID },
      }),
    ).not.toThrow()
    expect(
      transferResumeStateMessageSchema.safeParse({
        type: 'transfer:resume-state',
        ...baseMessage,
        payload: {
          transferId: TRANSFER_ID,
          files: [
            {
              fileId: FILE_ID,
              size: DEFAULT_FILE_CHUNK_SIZE_BYTES,
              sha256,
              chunkSize: DEFAULT_FILE_CHUNK_SIZE_BYTES,
              chunkCount: 1,
              verifiedRanges: [{ start: 0, end: 1 }],
            },
          ],
        },
      }).success,
    ).toBe(true)
  })

  it.each([
    [{ start: 1, end: 1 }],
    [{ start: 2, end: 1 }],
    [{ start: 0, end: MAX_FILE_CHUNKS + 1 }],
  ])('rejects invalid verified ranges', (verifiedRanges) => {
    const message = {
      type: 'transfer:resume-state',
      ...baseMessage,
      payload: {
        transferId: TRANSFER_ID,
        files: [{ ...metadata, verifiedRanges }],
      },
    }
    expect(transferResumeStateMessageSchema.safeParse(message).success).toBe(false)
  })
})

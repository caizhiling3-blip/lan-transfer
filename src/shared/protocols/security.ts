import { z } from 'zod'

import {
  DEFAULT_FILE_CHUNK_SIZE_BYTES,
  FILE_CHUNK_AUTH_TAG_BYTES,
  MAX_ENCRYPTED_ENVELOPE_BYTES,
  MAX_FILE_CHUNKS,
  MAX_FILE_SIZE_BYTES,
  MAX_FILES_PER_TRANSFER,
  MAX_VERIFIED_CHUNK_RANGES,
  SECURE_PROTOCOL_VERSION,
} from '../constants'
import {
  connectionIdSchema,
  deviceIdSchema,
  fileIdSchema,
  messageIdSchema,
  requestIdSchema,
  transferIdSchema,
} from '../types'
import {
  deviceInfoSchema,
  fileMetadataSchema,
  sha256DigestSchema,
  timestampSchema,
} from './schemas'
import type { secureFolderManifestFileSchema } from './schemas'

const safeIntegerSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const base64Pattern = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u
const getDecodedBase64Length = (value: string): number =>
  (value.length / 4) * 3 - (value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0)
const fixedBase64Schema = (encodedLength: number, decodedLength: number) =>
  z
    .string()
    .length(encodedLength)
    .regex(base64Pattern)
    .refine((value) => getDecodedBase64Length(value) === decodedLength, 'Invalid binary length')

export const identityPublicKeySchema = fixedBase64Schema(60, 44)
export const ephemeralPublicKeySchema = fixedBase64Schema(60, 44)
export const handshakeNonceSchema = fixedBase64Schema(44, 32)
export const handshakeSignatureSchema = fixedBase64Schema(88, 64)
export const authenticationTagSchema = fixedBase64Schema(24, 16)
export const identityFingerprintSchema = sha256DigestSchema
export const pairingVerificationCodeSchema = z.string().regex(/^\d{6}$/u)

export const publicIdentitySchema = z
  .object({
    algorithm: z.literal('Ed25519'),
    publicKey: identityPublicKeySchema,
    fingerprint: identityFingerprintSchema,
  })
  .strict()

const handshakeBaseFields = {
  messageId: messageIdSchema,
  senderId: deviceIdSchema,
  timestamp: timestampSchema,
}

export const secureHelloMessageSchema = z
  .object({
    type: z.literal('secure:hello'),
    ...handshakeBaseFields,
    payload: z
      .object({
        protocolVersion: z.literal(SECURE_PROTOCOL_VERSION),
        device: deviceInfoSchema,
        identity: publicIdentitySchema,
        keyAgreement: z.literal('X25519'),
        ephemeralPublicKey: ephemeralPublicKeySchema,
        nonce: handshakeNonceSchema,
      })
      .strict(),
  })
  .strict()

export const secureChallengeMessageSchema = z
  .object({
    type: z.literal('secure:challenge'),
    ...handshakeBaseFields,
    payload: z
      .object({
        protocolVersion: z.literal(SECURE_PROTOCOL_VERSION),
        connectionId: connectionIdSchema,
        device: deviceInfoSchema,
        identity: publicIdentitySchema,
        keyAgreement: z.literal('X25519'),
        ephemeralPublicKey: ephemeralPublicKeySchema,
        nonce: handshakeNonceSchema,
        signature: handshakeSignatureSchema,
      })
      .strict(),
  })
  .strict()

export const secureProofMessageSchema = z
  .object({
    type: z.literal('secure:proof'),
    ...handshakeBaseFields,
    payload: z
      .object({
        protocolVersion: z.literal(SECURE_PROTOCOL_VERSION),
        connectionId: connectionIdSchema,
        signature: handshakeSignatureSchema,
      })
      .strict(),
  })
  .strict()

export const secureHandshakeMessageSchema = z.discriminatedUnion('type', [
  secureHelloMessageSchema,
  secureChallengeMessageSchema,
  secureProofMessageSchema,
])

export const encryptedEnvelopeSchema = z
  .object({
    version: z.literal(SECURE_PROTOCOL_VERSION),
    connectionId: connectionIdSchema,
    sequence: safeIntegerSchema,
    ciphertext: z
      .string()
      .min(4)
      .max(Math.ceil((MAX_ENCRYPTED_ENVELOPE_BYTES * 4) / 3))
      .regex(base64Pattern),
    authenticationTag: authenticationTagSchema,
  })
  .strict()

export const secureFileMetadataSchema = fileMetadataSchema
  .extend({
    sha256: sha256DigestSchema,
    chunkSize: z.literal(DEFAULT_FILE_CHUNK_SIZE_BYTES),
    chunkCount: z.number().int().nonnegative().max(MAX_FILE_CHUNKS),
  })
  .strict()
  .refine(
    ({ size, chunkSize, chunkCount }) => chunkCount === Math.ceil(size / chunkSize),
    'Chunk count does not match file size',
  )

export const encryptedChunkDescriptorSchema = z
  .object({
    transferId: transferIdSchema,
    fileId: fileIdSchema,
    chunkIndex: z
      .number()
      .int()
      .nonnegative()
      .max(MAX_FILE_CHUNKS - 1),
    plaintextOffset: safeIntegerSchema.max(MAX_FILE_SIZE_BYTES),
    plaintextLength: z.number().int().nonnegative().max(DEFAULT_FILE_CHUNK_SIZE_BYTES),
    ciphertextLength: z
      .number()
      .int()
      .min(FILE_CHUNK_AUTH_TAG_BYTES)
      .max(DEFAULT_FILE_CHUNK_SIZE_BYTES + FILE_CHUNK_AUTH_TAG_BYTES),
  })
  .strict()

const secureMessageBaseFields = {
  messageId: messageIdSchema,
  senderId: deviceIdSchema,
  timestamp: timestampSchema,
}

const createSecureControlMessageSchema = <TType extends string, TPayload extends z.ZodType>(
  type: TType,
  payload: TPayload,
) =>
  z
    .object({
      type: z.literal(type),
      ...secureMessageBaseFields,
      payload,
    })
    .strict()

export const pairingDecisionMessageSchema = createSecureControlMessageSchema(
  'pairing:decision',
  z
    .object({
      requestId: requestIdSchema,
      connectionId: connectionIdSchema,
      decision: z.enum(['accept', 'reject']),
    })
    .strict(),
)

export const secureFileOfferMessageSchema = createSecureControlMessageSchema(
  'file:offer',
  z
    .object({
      transferId: transferIdSchema,
      files: z.array(secureFileMetadataSchema).min(1).max(MAX_FILES_PER_TRANSFER),
    })
    .strict(),
)

export const transferPauseMessageSchema = createSecureControlMessageSchema(
  'transfer:pause',
  z.object({ transferId: transferIdSchema }).strict(),
)

export const transferResumeRequestMessageSchema = createSecureControlMessageSchema(
  'transfer:resume-request',
  z.object({ transferId: transferIdSchema }).strict(),
)

export const verifiedChunkRangeSchema = z
  .object({
    start: z
      .number()
      .int()
      .nonnegative()
      .max(MAX_FILE_CHUNKS - 1),
    end: z.number().int().positive().max(MAX_FILE_CHUNKS),
  })
  .strict()
  .refine(({ start, end }) => start < end, 'Chunk range must be non-empty')

export const resumableFileStateSchema = z
  .object({
    fileId: fileIdSchema,
    size: safeIntegerSchema.max(MAX_FILE_SIZE_BYTES),
    sha256: sha256DigestSchema,
    chunkSize: z.literal(DEFAULT_FILE_CHUNK_SIZE_BYTES),
    chunkCount: z.number().int().nonnegative().max(MAX_FILE_CHUNKS),
    verifiedRanges: z.array(verifiedChunkRangeSchema).max(MAX_VERIFIED_CHUNK_RANGES),
  })
  .strict()

export const transferResumeStateMessageSchema = createSecureControlMessageSchema(
  'transfer:resume-state',
  z
    .object({
      transferId: transferIdSchema,
      files: z.array(resumableFileStateSchema).min(1).max(MAX_FILES_PER_TRANSFER),
    })
    .strict(),
)

export const secureControlMessageSchema = z.discriminatedUnion('type', [
  pairingDecisionMessageSchema,
  secureFileOfferMessageSchema,
  transferPauseMessageSchema,
  transferResumeRequestMessageSchema,
  transferResumeStateMessageSchema,
])

export type SecureHelloMessage = z.infer<typeof secureHelloMessageSchema>
export type SecureChallengeMessage = z.infer<typeof secureChallengeMessageSchema>
export type SecureProofMessage = z.infer<typeof secureProofMessageSchema>
export type SecureHandshakeMessage = z.infer<typeof secureHandshakeMessageSchema>
export type EncryptedEnvelope = z.infer<typeof encryptedEnvelopeSchema>
export type SecureFileMetadata = z.infer<typeof secureFileMetadataSchema>
export type SecureFolderManifestFile = z.infer<typeof secureFolderManifestFileSchema>
export type EncryptedChunkDescriptor = z.infer<typeof encryptedChunkDescriptorSchema>
export type PairingDecisionMessage = z.infer<typeof pairingDecisionMessageSchema>
export type SecureFileOfferMessage = z.infer<typeof secureFileOfferMessageSchema>
export type TransferPauseMessage = z.infer<typeof transferPauseMessageSchema>
export type TransferResumeRequestMessage = z.infer<typeof transferResumeRequestMessageSchema>
export type TransferResumeStateMessage = z.infer<typeof transferResumeStateMessageSchema>
export type SecureControlMessage = z.infer<typeof secureControlMessageSchema>

export const parseSecureHandshakeMessage = (input: unknown): SecureHandshakeMessage =>
  secureHandshakeMessageSchema.parse(input)

export const parseEncryptedEnvelope = (input: unknown): EncryptedEnvelope =>
  encryptedEnvelopeSchema.parse(input)

export const parseSecureControlMessage = (input: unknown): SecureControlMessage =>
  secureControlMessageSchema.parse(input)

import { z } from 'zod'

import {
  DEFAULT_FILE_CHUNK_SIZE_BYTES,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  MAX_FILE_SIZE_BYTES,
  MAX_FILE_CHUNKS,
  MAX_FILES_PER_TRANSFER,
  MAX_FOLDER_DEPTH,
  MAX_FOLDER_EMPTY_DIRECTORIES,
  MAX_FOLDER_FILES,
  MAX_FOLDER_MANIFEST_CHUNKS,
  MAX_FOLDER_RELATIVE_PATH_BYTES,
  MAX_FOLDER_TOTAL_SIZE_BYTES,
  MAX_SERVICE_PORT,
  MAX_TEXT_BYTES,
  MIN_SERVICE_PORT,
  PROTOCOL_VERSION,
} from '../constants'
import { errorCodeSchema } from '../errors'
import {
  connectionIdSchema,
  deviceIdSchema,
  fileIdSchema,
  messageIdSchema,
  manifestIdSchema,
  transferIdSchema,
} from '../types'
import { getUtf8ByteLength, parsePortableRelativePath } from '../utils'

const safeIntegerSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
export const timestampSchema = safeIntegerSchema

export const deviceInfoSchema = z
  .object({
    deviceId: deviceIdSchema,
    deviceName: z.string().trim().min(1).max(128),
    operatingSystem: z.enum(['windows', 'macos']),
    ipAddress: z.union([z.ipv4(), z.ipv6()]),
    servicePort: z.number().int().min(MIN_SERVICE_PORT).max(MAX_SERVICE_PORT),
  })
  .strict()

const windowsReservedFileNamePattern = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu
const invalidPortableFileNameCharacterPattern = /[<>:"/\\|?*]/u
const hasControlCharacter = (value: string): boolean =>
  [...value].some((character) => {
    const codePoint = character.codePointAt(0)
    return codePoint !== undefined && (codePoint <= 31 || codePoint === 127)
  })

const isSafeDisplayName = (value: string): boolean =>
  value !== '.' &&
  value !== '..' &&
  !value.endsWith('.') &&
  !value.endsWith(' ') &&
  !windowsReservedFileNamePattern.test(value) &&
  !invalidPortableFileNameCharacterPattern.test(value) &&
  !hasControlCharacter(value) &&
  getUtf8ByteLength(value) <= 255

export const fileMetadataSchema = z
  .object({
    fileId: fileIdSchema,
    displayName: z.string().min(1).max(255).refine(isSafeDisplayName, 'Invalid file name'),
    size: safeIntegerSchema.max(MAX_FILE_SIZE_BYTES),
    mimeType: z
      .string()
      .min(3)
      .max(127)
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9!#$&^_.+-]*\/[a-zA-Z0-9][a-zA-Z0-9!#$&^_.+-]*$/u),
  })
  .strict()

const baseFields = {
  messageId: messageIdSchema,
  senderId: deviceIdSchema,
  timestamp: timestampSchema,
}

const createMessageSchema = <TType extends string, TPayload extends z.ZodType>(
  type: TType,
  payload: TPayload,
) =>
  z
    .object({
      type: z.literal(type),
      ...baseFields,
      payload,
    })
    .strict()

export const deviceHelloMessageSchema = createMessageSchema(
  'device:hello',
  z
    .object({
      protocolVersion: z.literal(PROTOCOL_VERSION),
      device: deviceInfoSchema,
      connectionNonce: z.string().min(32).max(128),
    })
    .strict(),
)

export const deviceWelcomeMessageSchema = createMessageSchema(
  'device:welcome',
  z
    .object({
      protocolVersion: z.literal(PROTOCOL_VERSION),
      device: deviceInfoSchema,
      connectionNonce: z.string().min(32).max(128),
      connectionId: connectionIdSchema,
      heartbeatIntervalMs: z.literal(HEARTBEAT_INTERVAL_MS),
      heartbeatTimeoutMs: z.literal(HEARTBEAT_TIMEOUT_MS),
    })
    .strict(),
)

export const deviceHeartbeatMessageSchema = createMessageSchema(
  'device:heartbeat',
  z
    .object({
      connectionId: connectionIdSchema,
      sequence: safeIntegerSchema,
    })
    .strict(),
)

export const deviceDisconnectMessageSchema = createMessageSchema(
  'device:disconnect',
  z
    .object({
      connectionId: connectionIdSchema,
      reason: z.enum(['user_requested', 'connection_replaced', 'app_shutdown', 'protocol_error']),
    })
    .strict(),
)

export const textSendMessageSchema = createMessageSchema(
  'text:send',
  z
    .object({
      content: z
        .string()
        .min(1)
        .refine((value) => getUtf8ByteLength(value) <= MAX_TEXT_BYTES, 'Text is too large'),
      contentType: z.enum(['text', 'link']),
    })
    .strict(),
)

export const textAcknowledgementMessageSchema = createMessageSchema(
  'text:ack',
  z
    .object({
      messageId: messageIdSchema,
    })
    .strict(),
)

export const fileOfferMessageSchema = createMessageSchema(
  'file:offer',
  z
    .object({
      transferId: transferIdSchema,
      files: z.array(fileMetadataSchema).min(1).max(MAX_FILES_PER_TRANSFER),
    })
    .strict(),
)

const uploadAuthorizationSchema = z
  .object({
    fileId: fileIdSchema,
    uploadToken: z.string().min(32).max(512),
    expiresAt: timestampSchema,
  })
  .strict()

export const fileAcceptMessageSchema = createMessageSchema(
  'file:accept',
  z
    .object({
      transferId: transferIdSchema,
      files: z.array(uploadAuthorizationSchema).min(1).max(MAX_FILES_PER_TRANSFER),
    })
    .strict(),
)

export const fileRejectMessageSchema = createMessageSchema(
  'file:reject',
  z
    .object({
      transferId: transferIdSchema,
      reason: z.enum(['user_rejected', 'file_limit_exceeded', 'save_directory_invalid']),
    })
    .strict(),
)

export const fileCancelMessageSchema = createMessageSchema(
  'file:cancel',
  z
    .object({
      transferId: transferIdSchema,
      fileId: fileIdSchema.optional(),
      reason: z.enum(['user_cancelled', 'connection_closed', 'transfer_timeout']),
    })
    .strict(),
)

export const fileProgressMessageSchema = createMessageSchema(
  'file:progress',
  z
    .object({
      transferId: transferIdSchema,
      fileId: fileIdSchema,
      transferredBytes: safeIntegerSchema,
    })
    .strict(),
)

export const fileCompleteMessageSchema = createMessageSchema(
  'file:complete',
  z
    .object({
      transferId: transferIdSchema,
      fileId: fileIdSchema,
      size: safeIntegerSchema.max(MAX_FILE_SIZE_BYTES),
    })
    .strict(),
)

export const fileErrorMessageSchema = createMessageSchema(
  'file:error',
  z
    .object({
      transferId: transferIdSchema,
      fileId: fileIdSchema.optional(),
      errorCode: errorCodeSchema,
      detail: z.string().max(256).optional(),
    })
    .strict(),
)

const portableRelativePathSchema = z
  .string()
  .min(1)
  .refine((value) => getUtf8ByteLength(value) <= MAX_FOLDER_RELATIVE_PATH_BYTES)
  .refine((value) => {
    try {
      return parsePortableRelativePath(value).length <= MAX_FOLDER_DEPTH
    } catch {
      return false
    }
  }, 'Invalid portable relative path')

export const folderManifestFileSchema = z
  .object({
    fileId: fileIdSchema,
    relativePath: portableRelativePathSchema,
    size: safeIntegerSchema.max(MAX_FILE_SIZE_BYTES),
    mimeType: fileMetadataSchema.shape.mimeType,
  })
  .strict()

export const sha256DigestSchema = z.string().regex(/^[0-9a-f]{64}$/u)

export const secureFolderManifestFileSchema = folderManifestFileSchema
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

export const folderOfferMessageSchema = createMessageSchema(
  'folder:offer',
  z
    .object({
      transferId: transferIdSchema,
      manifestId: manifestIdSchema,
      displayName: z.string().min(1).max(255).refine(isSafeDisplayName, 'Invalid folder name'),
      totalSize: safeIntegerSchema.max(MAX_FOLDER_TOTAL_SIZE_BYTES),
      fileCount: z.number().int().min(0).max(MAX_FOLDER_FILES),
      emptyDirectoryCount: z.number().int().min(0).max(MAX_FOLDER_EMPTY_DIRECTORIES),
      manifestChunkCount: z.number().int().min(1).max(MAX_FOLDER_MANIFEST_CHUNKS),
      manifestSha256: z.string().regex(/^[0-9a-f]{64}$/u),
    })
    .strict(),
)

export const folderManifestMessageSchema = createMessageSchema(
  'folder:manifest',
  z
    .object({
      transferId: transferIdSchema,
      manifestId: manifestIdSchema,
      chunkIndex: z
        .number()
        .int()
        .min(0)
        .max(MAX_FOLDER_MANIFEST_CHUNKS - 1),
      files: z.array(secureFolderManifestFileSchema).max(MAX_FOLDER_FILES),
      emptyDirectories: z.array(portableRelativePathSchema).max(MAX_FOLDER_EMPTY_DIRECTORIES),
    })
    .strict(),
)

export const folderAcceptMessageSchema = createMessageSchema(
  'folder:accept',
  z
    .object({
      transferId: transferIdSchema,
      uploadKey: z
        .string()
        .min(32)
        .max(128)
        .regex(/^[a-zA-Z0-9_-]+$/u),
      expiresAt: timestampSchema,
    })
    .strict(),
)

export const folderRejectMessageSchema = createMessageSchema(
  'folder:reject',
  z.object({ transferId: transferIdSchema, reason: z.literal('user_rejected') }).strict(),
)

export const folderCancelMessageSchema = createMessageSchema(
  'folder:cancel',
  z
    .object({
      transferId: transferIdSchema,
      reason: z.enum(['user_cancelled', 'connection_closed', 'transfer_timeout']),
    })
    .strict(),
)

export const folderProgressMessageSchema = createMessageSchema(
  'folder:progress',
  z
    .object({
      transferId: transferIdSchema,
      fileId: fileIdSchema,
      transferredBytes: safeIntegerSchema.max(MAX_FILE_SIZE_BYTES),
      totalTransferredBytes: safeIntegerSchema.max(MAX_FOLDER_TOTAL_SIZE_BYTES),
    })
    .strict(),
)

export const folderCompleteMessageSchema = createMessageSchema(
  'folder:complete',
  z.discriminatedUnion('scope', [
    z
      .object({
        scope: z.literal('file'),
        transferId: transferIdSchema,
        fileId: fileIdSchema,
        size: safeIntegerSchema.max(MAX_FILE_SIZE_BYTES),
      })
      .strict(),
    z.object({ scope: z.literal('folder'), transferId: transferIdSchema }).strict(),
  ]),
)

export const folderErrorMessageSchema = createMessageSchema(
  'folder:error',
  z
    .object({
      transferId: transferIdSchema,
      fileId: fileIdSchema.optional(),
      errorCode: errorCodeSchema,
    })
    .strict(),
)

export const protocolMessageSchema = z.discriminatedUnion('type', [
  deviceHelloMessageSchema,
  deviceWelcomeMessageSchema,
  deviceHeartbeatMessageSchema,
  deviceDisconnectMessageSchema,
  textSendMessageSchema,
  textAcknowledgementMessageSchema,
  fileOfferMessageSchema,
  fileAcceptMessageSchema,
  fileRejectMessageSchema,
  fileCancelMessageSchema,
  fileProgressMessageSchema,
  fileCompleteMessageSchema,
  fileErrorMessageSchema,
  folderOfferMessageSchema,
  folderManifestMessageSchema,
  folderAcceptMessageSchema,
  folderRejectMessageSchema,
  folderCancelMessageSchema,
  folderProgressMessageSchema,
  folderCompleteMessageSchema,
  folderErrorMessageSchema,
])

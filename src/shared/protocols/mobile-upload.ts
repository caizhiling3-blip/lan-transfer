import { z } from 'zod'

import {
  MAX_FILE_SIZE_BYTES,
  MAX_FILES_PER_TRANSFER,
  MOBILE_UPLOAD_REQUEST_CLOCK_SKEW_MS,
} from '../constants'
import { fileIdSchema, mobileUploadBatchIdSchema, mobileUploadSessionIdSchema } from '../types'
import { fileMetadataSchema, timestampSchema } from './schemas'

const base64UrlSchema = z
  .string()
  .min(16)
  .max(128)
  .regex(/^[a-zA-Z0-9_-]+$/u)
export const mobileUploadSessionSecretSchema = z
  .string()
  .length(43)
  .regex(/^[a-zA-Z0-9_-]+$/u)

export const mobileUploadRequestAuthenticationSchema = z
  .object({
    timestamp: timestampSchema,
    nonce: base64UrlSchema,
    sessionKey: mobileUploadSessionSecretSchema,
  })
  .strict()

export const mobileUploadOfferRequestSchema = z
  .object({
    batchId: mobileUploadBatchIdSchema,
    files: z.array(fileMetadataSchema).min(1).max(MAX_FILES_PER_TRANSFER),
  })
  .strict()
  .refine(({ files }) => new Set(files.map(({ fileId }) => fileId)).size === files.length, {
    message: 'File IDs must be unique',
    path: ['files'],
  })
  .refine(
    ({ files }) => files.reduce((total, file) => total + file.size, 0) <= MAX_FILE_SIZE_BYTES * 20,
    { message: 'Batch is too large', path: ['files'] },
  )

export const mobileUploadStatusRequestSchema = z
  .object({
    sessionId: mobileUploadSessionIdSchema,
    batchId: mobileUploadBatchIdSchema,
  })
  .strict()

export const mobileUploadChunkRouteSchema = z
  .object({
    sessionId: mobileUploadSessionIdSchema,
    batchId: mobileUploadBatchIdSchema,
    fileId: fileIdSchema,
    chunkIndex: z.number().int().nonnegative(),
  })
  .strict()

export const isMobileUploadRequestTimestampCurrent = (
  timestamp: number,
  now = Date.now(),
): boolean => Math.abs(now - timestamp) <= MOBILE_UPLOAD_REQUEST_CLOCK_SKEW_MS

export type MobileUploadOfferRequest = z.infer<typeof mobileUploadOfferRequestSchema>
export type MobileUploadRequestAuthentication = z.infer<
  typeof mobileUploadRequestAuthenticationSchema
>

import { z } from 'zod'

import {
  MAX_FILE_SIZE_BYTES,
  MAX_FILES_PER_TRANSFER,
  MAX_HISTORY_LIMIT,
  MAX_SERVICE_PORT,
  MAX_TEXT_BYTES,
  MIN_HISTORY_LIMIT,
  MIN_SERVICE_PORT,
} from '../constants'
import { fileIdSchema, requestIdSchema, transferIdSchema } from '../types'
import { getUtf8ByteLength } from '../utils'
import type { IpcInvokeChannel } from './channels'
import type { IpcInvokeRequest } from './contracts'

const noRequestSchema = z.undefined()
const portSchema = z.number().int().min(MIN_SERVICE_PORT).max(MAX_SERVICE_PORT)
const tokenSchema = z
  .string()
  .min(32)
  .max(128)
  .regex(/^[a-zA-Z0-9_-]+$/u)
const textSchema = z
  .string()
  .min(1)
  .refine((value) => getUtf8ByteLength(value) <= MAX_TEXT_BYTES, 'Text is too large')

const externalUrlSchema = z
  .string()
  .max(2_048)
  .refine((value) => {
    try {
      const protocol = new URL(value).protocol
      return protocol === 'http:' || protocol === 'https:'
    } catch {
      return false
    }
  }, 'Only HTTP and HTTPS URLs are allowed')

const connectRequestSchema = z
  .object({
    host: z.ipv4(),
    port: portSchema,
  })
  .strict()

const respondToConnectionRequestSchema = z
  .object({
    requestId: requestIdSchema,
    decision: z.enum(['accept', 'reject']),
  })
  .strict()

const selectFilesRequestSchema = z.object({ multiple: z.boolean() }).strict()

const offerFilesRequestSchema = z
  .object({
    selectionTokens: z.array(tokenSchema).min(1).max(MAX_FILES_PER_TRANSFER),
  })
  .strict()
  .refine(
    ({ selectionTokens }) => new Set(selectionTokens).size === selectionTokens.length,
    'Selection tokens must be unique',
  )

const respondToOfferRequestSchema = z.discriminatedUnion('decision', [
  z
    .object({
      transferId: transferIdSchema,
      decision: z.literal('accept'),
      directoryToken: tokenSchema.optional(),
    })
    .strict(),
  z
    .object({
      transferId: transferIdSchema,
      decision: z.literal('reject'),
    })
    .strict(),
])

const updateSettingsRequestSchema = z
  .object({
    deviceName: z.string().trim().min(1).max(128).optional(),
    receiveDirectoryToken: tokenSchema.optional(),
    servicePort: portSchema.optional(),
    maxFileSizeBytes: z.number().int().positive().max(MAX_FILE_SIZE_BYTES).optional(),
    historyLimit: z.number().int().min(MIN_HISTORY_LIMIT).max(MAX_HISTORY_LIMIT).optional(),
  })
  .strict()
  .refine((request) => Object.keys(request).length > 0, 'At least one setting is required')

export const ipcInvokeRequestSchemas = {
  'app:get-runtime-info': noRequestSchema,
  'app:open-external-url': z.object({ url: externalUrlSchema }).strict(),
  'service:get-status': noRequestSchema,
  'service:restart': z.object({ port: portSchema }).strict(),
  'connection:get-status': noRequestSchema,
  'connection:connect': connectRequestSchema,
  'connection:disconnect': noRequestSchema,
  'connection:respond-to-request': respondToConnectionRequestSchema,
  'clipboard:read-text': noRequestSchema,
  'clipboard:write-text': z.object({ text: textSchema }).strict(),
  'transfer:select-files': selectFilesRequestSchema,
  'transfer:register-dropped-files': z
    .object({ paths: z.array(z.string().min(1).max(32_768)).min(1).max(MAX_FILES_PER_TRANSFER) })
    .strict()
    .refine(({ paths }) => new Set(paths).size === paths.length, 'Paths must be unique'),
  'transfer:send-text': z
    .object({ content: textSchema, contentType: z.enum(['text', 'link']) })
    .strict(),
  'transfer:offer-files': offerFilesRequestSchema,
  'transfer:respond-to-offer': respondToOfferRequestSchema,
  'transfer:cancel': z
    .object({ transferId: transferIdSchema, fileId: fileIdSchema.optional() })
    .strict(),
  'transfer:retry': z.object({ transferId: transferIdSchema }).strict(),
  'history:list': z
    .object({
      direction: z.enum(['send', 'receive']).optional(),
      kind: z.enum(['text', 'link', 'file']).optional(),
      status: z
        .enum([
          'pending',
          'awaitingAcceptance',
          'accepted',
          'transferring',
          'completed',
          'failed',
          'cancelled',
          'rejected',
        ])
        .optional(),
      offset: z.number().int().nonnegative(),
      limit: z.number().int().min(1).max(100),
    })
    .strict(),
  'history:clear': noRequestSchema,
  'settings:get': noRequestSchema,
  'settings:update': updateSettingsRequestSchema,
  'settings:select-receive-directory': noRequestSchema,
} as const satisfies Readonly<Record<IpcInvokeChannel, z.ZodType>>

export const parseIpcInvokeRequest = <TChannel extends IpcInvokeChannel>(
  channel: TChannel,
  input: unknown,
): IpcInvokeRequest<TChannel> =>
  ipcInvokeRequestSchemas[channel].parse(input) as IpcInvokeRequest<TChannel>

import { z } from 'zod'

import {
  MAX_FILE_SIZE_BYTES,
  MAX_FILES_PER_TRANSFER,
  MAX_HISTORY_DELETE_BATCH,
  MAX_HISTORY_LIMIT,
  MAX_HISTORY_SEARCH_LENGTH,
  MAX_QUEUED_TRANSFER_ITEMS,
  MAX_RECENT_DEVICE_ALIAS_LENGTH,
  MAX_RETENTION_DAYS,
  MAX_SERVICE_PORT,
  MAX_TEXT_BYTES,
  MIN_HISTORY_LIMIT,
  MIN_RETENTION_DAYS,
  MIN_SERVICE_PORT,
} from '../constants'
import {
  deviceIdSchema,
  fileIdSchema,
  queueItemIdSchema,
  requestIdSchema,
  transferIdSchema,
} from '../types'
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
    historyRetentionDays: z
      .number()
      .int()
      .min(MIN_RETENTION_DAYS)
      .max(MAX_RETENTION_DAYS)
      .nullable()
      .optional(),
    logRetentionDays: z.number().int().min(MIN_RETENTION_DAYS).max(MAX_RETENTION_DAYS).optional(),
  })
  .strict()
  .refine((request) => Object.keys(request).length > 0, 'At least one setting is required')

export const recentDeviceAliasSchema = z.string().trim().min(1).max(MAX_RECENT_DEVICE_ALIAS_LENGTH)

export const historyDeleteRequestSchema = z
  .object({ historyIds: z.array(z.uuid()).min(1).max(MAX_HISTORY_DELETE_BATCH) })
  .strict()
  .refine(({ historyIds }) => new Set(historyIds).size === historyIds.length, 'IDs must be unique')

export const historyCleanupCriteriaSchema = z
  .object({
    direction: z.enum(['send', 'receive']).optional(),
    kind: z.enum(['text', 'link', 'file', 'folder']).optional(),
    statuses: z
      .array(
        z.enum([
          'pending',
          'awaitingAcceptance',
          'accepted',
          'transferring',
          'paused',
          'reconnecting',
          'verifying',
          'recoverable',
          'publishing',
          'completed',
          'failed',
          'cancelled',
          'rejected',
        ]),
      )
      .min(1)
      .max(13)
      .optional(),
    query: z.string().trim().min(1).max(MAX_HISTORY_SEARCH_LENGTH).optional(),
    before: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  })
  .strict()
  .refine((criteria) => Object.keys(criteria).length > 0, 'At least one criterion is required')
  .refine(
    ({ statuses }) => statuses === undefined || new Set(statuses).size === statuses.length,
    'Statuses must be unique',
  )

export const ipcInvokeRequestSchemas = {
  'app:get-runtime-info': noRequestSchema,
  'app:open-external-url': z.object({ url: externalUrlSchema }).strict(),
  'service:get-status': noRequestSchema,
  'service:restart': z.object({ port: portSchema }).strict(),
  'connection:get-status': noRequestSchema,
  'connection:connect': connectRequestSchema,
  'connection:disconnect': noRequestSchema,
  'connection:respond-to-request': respondToConnectionRequestSchema,
  'pairing:get-pending': noRequestSchema,
  'pairing:respond': z
    .object({ requestId: requestIdSchema, decision: z.enum(['accept', 'reject']) })
    .strict(),
  'trusted-devices:list': noRequestSchema,
  'trusted-devices:revoke': z.object({ deviceId: deviceIdSchema }).strict(),
  'trusted-devices:clear': noRequestSchema,
  'recent-devices:list': noRequestSchema,
  'recent-devices:update-alias': z
    .object({ deviceId: deviceIdSchema, alias: recentDeviceAliasSchema.nullable() })
    .strict(),
  'recent-devices:remove': z.object({ deviceId: deviceIdSchema }).strict(),
  'recent-devices:clear': noRequestSchema,
  'discovery:get-devices': noRequestSchema,
  'clipboard:read-text': noRequestSchema,
  'clipboard:write-text': z.object({ text: textSchema }).strict(),
  'transfer:select-files': selectFilesRequestSchema,
  'transfer:select-folder': noRequestSchema,
  'transfer:register-dropped-files': z
    .object({ paths: z.array(z.string().min(1).max(32_768)).min(1).max(MAX_FILES_PER_TRANSFER) })
    .strict()
    .refine(({ paths }) => new Set(paths).size === paths.length, 'Paths must be unique'),
  'transfer:register-dropped-items': z
    .object({
      paths: z.array(z.string().min(1).max(32_768)).min(1).max(MAX_FILES_PER_TRANSFER),
    })
    .strict()
    .refine(({ paths }) => new Set(paths).size === paths.length, 'Paths must be unique'),
  'transfer:send-text': z
    .object({ content: textSchema, contentType: z.enum(['text', 'link']) })
    .strict(),
  'transfer:offer-files': offerFilesRequestSchema,
  'transfer:offer-folder': z.object({ selectionToken: tokenSchema }).strict(),
  'transfer:enqueue': z
    .object({
      text: z
        .object({ content: textSchema, contentType: z.enum(['text', 'link']) })
        .strict()
        .optional(),
      fileSelectionTokens: z.array(tokenSchema).max(MAX_FILES_PER_TRANSFER),
      folderSelectionTokens: z.array(tokenSchema).max(MAX_QUEUED_TRANSFER_ITEMS),
    })
    .strict()
    .refine(
      ({ text, fileSelectionTokens, folderSelectionTokens }) =>
        text !== undefined || fileSelectionTokens.length > 0 || folderSelectionTokens.length > 0,
      'At least one transfer item is required',
    )
    .refine(
      ({ fileSelectionTokens, folderSelectionTokens }) =>
        new Set([...fileSelectionTokens, ...folderSelectionTokens]).size ===
        fileSelectionTokens.length + folderSelectionTokens.length,
      'Selection tokens must be unique',
    ),
  'transfer:cancel-queued': z.object({ queueItemId: queueItemIdSchema }).strict(),
  'transfer:get-tasks': z.undefined(),
  'transfer:respond-to-offer': respondToOfferRequestSchema,
  'transfer:cancel': z
    .object({ transferId: transferIdSchema, fileId: fileIdSchema.optional() })
    .strict(),
  'transfer:pause': z.object({ transferId: transferIdSchema }).strict(),
  'transfer:resume': z.object({ transferId: transferIdSchema }).strict(),
  'transfer:retry': z.object({ transferId: transferIdSchema }).strict(),
  'transfer:show-received-file': z
    .object({ transferId: transferIdSchema, fileId: fileIdSchema.optional() })
    .strict(),
  'history:list': z
    .object({
      direction: z.enum(['send', 'receive']).optional(),
      kind: z.enum(['text', 'link', 'file', 'folder']).optional(),
      status: z
        .enum([
          'pending',
          'awaitingAcceptance',
          'accepted',
          'transferring',
          'publishing',
          'completed',
          'failed',
          'cancelled',
          'rejected',
        ])
        .optional(),
      query: z.string().trim().min(1).max(MAX_HISTORY_SEARCH_LENGTH).optional(),
      offset: z.number().int().nonnegative(),
      limit: z.number().int().min(1).max(100),
    })
    .strict(),
  'history:get-stats': z.object({ criteria: historyCleanupCriteriaSchema.optional() }).strict(),
  'history:delete': historyDeleteRequestSchema,
  'history:preview-cleanup': historyCleanupCriteriaSchema,
  'history:cleanup': historyCleanupCriteriaSchema,
  'history:clear': noRequestSchema,
  'diagnostics:get-summary': noRequestSchema,
  'diagnostics:export-report': noRequestSchema,
  'diagnostics:open-data-directory': noRequestSchema,
  'diagnostics:open-log-directory': noRequestSchema,
  'diagnostics:get-log-stats': noRequestSchema,
  'diagnostics:clear-logs': noRequestSchema,
  'settings:get': noRequestSchema,
  'settings:update': updateSettingsRequestSchema,
  'settings:select-receive-directory': noRequestSchema,
} as const satisfies Readonly<Record<IpcInvokeChannel, z.ZodType>>

export const parseIpcInvokeRequest = <TChannel extends IpcInvokeChannel>(
  channel: TChannel,
  input: unknown,
): IpcInvokeRequest<TChannel> =>
  ipcInvokeRequestSchemas[channel].parse(input) as IpcInvokeRequest<TChannel>

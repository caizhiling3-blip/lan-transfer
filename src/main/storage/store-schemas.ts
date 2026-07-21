import { existsSync, readFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'

import { z } from 'zod'

import {
  MAX_FILE_SIZE_BYTES,
  MAX_HISTORY_LIMIT,
  MAX_HISTORY_TEXT_PREVIEW_LENGTH,
  MAX_RECENT_DEVICES,
  MAX_SERVICE_PORT,
  MIN_HISTORY_LIMIT,
  MIN_SERVICE_PORT,
} from '@shared/constants'
import { errorCodeSchema } from '@shared/errors'
import { deviceInfoSchema } from '@shared/protocols'
import { deviceIdSchema, transferIdSchema } from '@shared/types'

const timestampSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)

export const settingsStoreSchema = z
  .object({
    schemaVersion: z.literal(1),
    deviceId: deviceIdSchema,
    deviceName: z.string().trim().min(1).max(128),
    receiveDirectory: z.string().min(1).max(32_768),
    servicePort: z.number().int().min(MIN_SERVICE_PORT).max(MAX_SERVICE_PORT),
    maxFileSizeBytes: z.number().int().positive().max(MAX_FILE_SIZE_BYTES),
    historyLimit: z.number().int().min(MIN_HISTORY_LIMIT).max(MAX_HISTORY_LIMIT),
  })
  .strict()

export const historyEntrySchema = z
  .object({
    id: z.uuid(),
    transferId: transferIdSchema.optional(),
    direction: z.enum(['send', 'receive']),
    kind: z.enum(['text', 'link', 'file']),
    peer: deviceInfoSchema,
    status: z.enum([
      'pending',
      'awaitingAcceptance',
      'accepted',
      'transferring',
      'completed',
      'failed',
      'cancelled',
      'rejected',
    ]),
    displayName: z.string().min(1).max(512).optional(),
    size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    textPreview: z.string().max(MAX_HISTORY_TEXT_PREVIEW_LENGTH).optional(),
    createdAt: timestampSchema,
    errorCode: errorCodeSchema.optional(),
  })
  .strict()

export const historyStoreSchema = z
  .object({
    schemaVersion: z.literal(1),
    entries: z.array(historyEntrySchema).max(MAX_HISTORY_LIMIT),
  })
  .strict()

export const recentDevicesStoreSchema = z
  .object({
    schemaVersion: z.literal(1),
    devices: z
      .array(z.object({ device: deviceInfoSchema, lastConnectedAt: timestampSchema }).strict())
      .max(MAX_RECENT_DEVICES),
  })
  .strict()

export const backupInvalidStoreFile = (
  directory: string,
  name: string,
  schema: z.ZodType,
): string | null => {
  const filePath = join(directory, `${name}.json`)
  if (!existsSync(filePath)) return null
  try {
    schema.parse(JSON.parse(readFileSync(filePath, 'utf8')))
    return null
  } catch {
    const backupPath = `${filePath}.invalid-${String(Date.now())}`
    renameSync(filePath, backupPath)
    return backupPath
  }
}

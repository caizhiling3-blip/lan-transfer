import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { z } from 'zod'

import {
  DEFAULT_LOG_RETENTION_DAYS,
  MAX_FILE_SIZE_BYTES,
  MAX_HISTORY_LIMIT,
  MAX_HISTORY_TEXT_PREVIEW_LENGTH,
  MAX_RECENT_DEVICES,
  MAX_RECENT_DEVICE_ALIAS_LENGTH,
  MAX_RETENTION_DAYS,
  MAX_SERVICE_PORT,
  MIN_HISTORY_LIMIT,
  MIN_RETENTION_DAYS,
  MIN_SERVICE_PORT,
} from '@shared/constants'
import { errorCodeSchema } from '@shared/errors'
import { deviceInfoSchema } from '@shared/protocols'
import { deviceIdSchema, transferIdSchema } from '@shared/types'

const timestampSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)

const settingsStoreV1Schema = z
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

export const settingsStoreSchema = z
  .object({
    schemaVersion: z.literal(2),
    deviceId: deviceIdSchema,
    deviceName: z.string().trim().min(1).max(128),
    receiveDirectory: z.string().min(1).max(32_768),
    servicePort: z.number().int().min(MIN_SERVICE_PORT).max(MAX_SERVICE_PORT),
    maxFileSizeBytes: z.number().int().positive().max(MAX_FILE_SIZE_BYTES),
    historyLimit: z.number().int().min(MIN_HISTORY_LIMIT).max(MAX_HISTORY_LIMIT),
    historyRetentionDays: z
      .number()
      .int()
      .min(MIN_RETENTION_DAYS)
      .max(MAX_RETENTION_DAYS)
      .nullable(),
    logRetentionDays: z.number().int().min(MIN_RETENTION_DAYS).max(MAX_RETENTION_DAYS),
  })
  .strict()

export const historyEntrySchema = z
  .object({
    id: z.uuid(),
    transferId: transferIdSchema.optional(),
    direction: z.enum(['send', 'receive']),
    kind: z.enum(['text', 'link', 'file', 'folder']),
    peer: deviceInfoSchema,
    status: z.enum([
      'pending',
      'awaitingAcceptance',
      'accepted',
      'transferring',
      'publishing',
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

export const updateSettingsStoreSchema = z
  .object({
    schemaVersion: z.literal(1),
    automaticChecksEnabled: z.boolean(),
    lastAutomaticCheckAt: timestampSchema.nullable(),
  })
  .strict()

const recentDevicesStoreV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    devices: z
      .array(z.object({ device: deviceInfoSchema, lastConnectedAt: timestampSchema }).strict())
      .max(MAX_RECENT_DEVICES),
  })
  .strict()

export const recentDevicesStoreSchema = z
  .object({
    schemaVersion: z.literal(2),
    devices: z
      .array(
        z
          .object({
            device: deviceInfoSchema,
            lastConnectedAt: timestampSchema,
            alias: z.string().trim().min(1).max(MAX_RECENT_DEVICE_ALIAS_LENGTH).optional(),
          })
          .strict(),
      )
      .max(MAX_RECENT_DEVICES),
  })
  .strict()

export const migrateSettingsStoreData = (input: unknown): z.infer<typeof settingsStoreSchema> => {
  const current = settingsStoreSchema.safeParse(input)
  if (current.success) return current.data
  const legacy = settingsStoreV1Schema.parse(input)
  return settingsStoreSchema.parse({
    ...legacy,
    schemaVersion: 2,
    historyRetentionDays: null,
    logRetentionDays: DEFAULT_LOG_RETENTION_DAYS,
  })
}

export const migrateRecentDevicesStoreData = (
  input: unknown,
): z.infer<typeof recentDevicesStoreSchema> => {
  const current = recentDevicesStoreSchema.safeParse(input)
  if (current.success) return current.data
  const legacy = recentDevicesStoreV1Schema.parse(input)
  return recentDevicesStoreSchema.parse({ ...legacy, schemaVersion: 2 })
}

const replaceStoreFile = (filePath: string, contents: string): void => {
  const nonce = randomUUID()
  const temporaryPath = `${filePath}.migration-${nonce}.tmp`
  const backupPath = `${filePath}.migration-${nonce}.bak`
  writeFileSync(temporaryPath, contents, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  renameSync(filePath, backupPath)
  try {
    renameSync(temporaryPath, filePath)
    unlinkSync(backupPath)
  } catch (error) {
    if (!existsSync(filePath) && existsSync(backupPath)) renameSync(backupPath, filePath)
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath)
    throw error
  }
}

export const backupInvalidStoreFile = (
  directory: string,
  name: string,
  schema: z.ZodType,
  migrate: (input: unknown) => unknown = (input) => input,
): string | null => {
  const filePath = join(directory, `${name}.json`)
  if (!existsSync(filePath)) return null
  try {
    const original = JSON.parse(readFileSync(filePath, 'utf8')) as unknown
    const migrated = schema.parse(migrate(original))
    if (JSON.stringify(original) !== JSON.stringify(migrated)) {
      replaceStoreFile(filePath, `${JSON.stringify(migrated, null, 2)}\n`)
    }
    return null
  } catch {
    const backupPath = `${filePath}.invalid-${String(Date.now())}`
    renameSync(filePath, backupPath)
    return backupPath
  }
}

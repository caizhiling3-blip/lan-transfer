import { z } from 'zod'

export const UPDATE_STATES = [
  'idle',
  'checking',
  'available',
  'not-available',
  'downloading',
  'downloaded',
  'error',
] as const

export const UPDATE_ERROR_CODES = [
  'UPDATE_CHECK_FAILED',
  'UPDATE_METADATA_INVALID',
  'UPDATE_DOWNLOAD_FAILED',
  'UPDATE_SIGNATURE_INVALID',
  'UPDATE_INSTALL_BLOCKED',
  'UPDATE_INSTALL_FAILED',
  'UPDATE_PLATFORM_UNSUPPORTED',
] as const

export const stableVersionSchema = z
  .string()
  .max(64)
  .regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u)

const timestampSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)

export const updateReleaseInfoSchema = z
  .object({
    version: stableVersionSchema,
    releaseNotes: z.string().max(8_192).optional(),
    publishedAt: timestampSchema.optional(),
  })
  .strict()

const updateStatusBaseSchema = z.object({
  currentVersion: stableVersionSchema,
  checkedAt: timestampSchema.optional(),
})

export const updateStatusSchema = z.discriminatedUnion('state', [
  updateStatusBaseSchema
    .extend({ state: z.literal('idle'), canInstall: z.literal(false) })
    .strict(),
  updateStatusBaseSchema
    .extend({ state: z.literal('checking'), canInstall: z.literal(false) })
    .strict(),
  updateStatusBaseSchema
    .extend({
      state: z.literal('available'),
      availableUpdate: updateReleaseInfoSchema,
      canInstall: z.literal(false),
    })
    .strict(),
  updateStatusBaseSchema
    .extend({ state: z.literal('not-available'), canInstall: z.literal(false) })
    .strict(),
  updateStatusBaseSchema
    .extend({
      state: z.literal('downloading'),
      availableUpdate: updateReleaseInfoSchema,
      downloadProgress: z.number().min(0).max(100),
      canInstall: z.literal(false),
    })
    .strict(),
  updateStatusBaseSchema
    .extend({
      state: z.literal('downloaded'),
      availableUpdate: updateReleaseInfoSchema,
      downloadProgress: z.literal(100),
      canInstall: z.boolean(),
    })
    .strict(),
  updateStatusBaseSchema
    .extend({
      state: z.literal('error'),
      errorCode: z.enum(UPDATE_ERROR_CODES),
      canInstall: z.literal(false),
    })
    .strict(),
])

export interface UpdateSettingsDto {
  readonly automaticChecksEnabled: boolean
}

export type UpdateState = (typeof UPDATE_STATES)[number]
export type UpdateErrorCode = (typeof UPDATE_ERROR_CODES)[number]
export type UpdateReleaseInfoDto = z.infer<typeof updateReleaseInfoSchema>
export type UpdateStatusDto = z.infer<typeof updateStatusSchema>

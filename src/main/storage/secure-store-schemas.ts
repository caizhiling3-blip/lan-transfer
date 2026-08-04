import { z } from 'zod'

import { MAX_TRUSTED_DEVICES } from '@shared/constants'
import { publicIdentitySchema } from '@shared/protocols'
import { deviceIdSchema } from '@shared/types'

const encryptedPrivateKeySchema = z
  .string()
  .min(16)
  .max(16_384)
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u)

export const identityStoreSchema = z
  .object({
    schemaVersion: z.literal(1),
    identity: publicIdentitySchema,
    encryptedPrivateKey: encryptedPrivateKeySchema,
  })
  .strict()

export const trustedDeviceRecordSchema = z
  .object({
    deviceId: deviceIdSchema,
    identity: publicIdentitySchema,
    firstPairedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    lastVerifiedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict()

export const trustedDevicesStoreSchema = z
  .object({
    schemaVersion: z.literal(1),
    devices: z.array(trustedDeviceRecordSchema).max(MAX_TRUSTED_DEVICES),
  })
  .strict()

export type IdentityStoreData = z.infer<typeof identityStoreSchema>
export type TrustedDevicesStoreData = z.infer<typeof trustedDevicesStoreSchema>

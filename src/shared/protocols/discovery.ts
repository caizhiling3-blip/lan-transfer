import { z } from 'zod'

import {
  DISCOVERY_APP_ID,
  MAX_SERVICE_PORT,
  MIN_SERVICE_PORT,
  PROTOCOL_VERSION,
} from '../constants'
import { deviceIdSchema, messageIdSchema } from '../types'

export const discoveryAnnouncementSchema = z
  .object({
    appId: z.literal(DISCOVERY_APP_ID),
    protocolVersion: z.literal(PROTOCOL_VERSION),
    messageId: messageIdSchema,
    deviceId: deviceIdSchema,
    deviceName: z.string().trim().min(1).max(128),
    operatingSystem: z.enum(['windows', 'macos']),
    servicePort: z.number().int().min(MIN_SERVICE_PORT).max(MAX_SERVICE_PORT),
    timestamp: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict()

export type DiscoveryAnnouncement = z.infer<typeof discoveryAnnouncementSchema>

export const parseDiscoveryAnnouncement = (input: unknown): DiscoveryAnnouncement =>
  discoveryAnnouncementSchema.parse(input)

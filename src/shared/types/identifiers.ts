import { z } from 'zod'

export const deviceIdSchema = z.uuid().brand<'DeviceId'>()
export const messageIdSchema = z.uuid().brand<'MessageId'>()
export const connectionIdSchema = z.uuid().brand<'ConnectionId'>()
export const transferIdSchema = z.uuid().brand<'TransferId'>()
export const fileIdSchema = z.uuid().brand<'FileId'>()
export const requestIdSchema = z.uuid().brand<'RequestId'>()
export const manifestIdSchema = z.uuid().brand<'ManifestId'>()
export const queueItemIdSchema = z.uuid().brand<'QueueItemId'>()

export type DeviceId = z.infer<typeof deviceIdSchema>
export type MessageId = z.infer<typeof messageIdSchema>
export type ConnectionId = z.infer<typeof connectionIdSchema>
export type TransferId = z.infer<typeof transferIdSchema>
export type FileId = z.infer<typeof fileIdSchema>
export type RequestId = z.infer<typeof requestIdSchema>
export type ManifestId = z.infer<typeof manifestIdSchema>
export type QueueItemId = z.infer<typeof queueItemIdSchema>

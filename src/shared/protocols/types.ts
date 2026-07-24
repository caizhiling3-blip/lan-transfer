import type { z } from 'zod'

import type {
  deviceDisconnectMessageSchema,
  deviceHeartbeatMessageSchema,
  deviceHelloMessageSchema,
  deviceWelcomeMessageSchema,
  fileAcceptMessageSchema,
  fileCancelMessageSchema,
  fileCompleteMessageSchema,
  fileErrorMessageSchema,
  fileOfferMessageSchema,
  fileProgressMessageSchema,
  fileRejectMessageSchema,
  folderAcceptMessageSchema,
  folderCancelMessageSchema,
  folderCompleteMessageSchema,
  folderErrorMessageSchema,
  folderManifestMessageSchema,
  folderOfferMessageSchema,
  folderProgressMessageSchema,
  folderRejectMessageSchema,
  protocolMessageSchema,
  textAcknowledgementMessageSchema,
  textSendMessageSchema,
} from './schemas'

export interface BaseMessage<TType extends string, TPayload> {
  readonly type: TType
  readonly messageId: string
  readonly senderId: string
  readonly timestamp: number
  readonly payload: TPayload
}

export type DeviceHelloMessage = z.infer<typeof deviceHelloMessageSchema>
export type DeviceWelcomeMessage = z.infer<typeof deviceWelcomeMessageSchema>
export type DeviceHeartbeatMessage = z.infer<typeof deviceHeartbeatMessageSchema>
export type DeviceDisconnectMessage = z.infer<typeof deviceDisconnectMessageSchema>
export type TextSendMessage = z.infer<typeof textSendMessageSchema>
export type TextAcknowledgementMessage = z.infer<typeof textAcknowledgementMessageSchema>
export type FileOfferMessage = z.infer<typeof fileOfferMessageSchema>
export type FileAcceptMessage = z.infer<typeof fileAcceptMessageSchema>
export type FileRejectMessage = z.infer<typeof fileRejectMessageSchema>
export type FileCancelMessage = z.infer<typeof fileCancelMessageSchema>
export type FileProgressMessage = z.infer<typeof fileProgressMessageSchema>
export type FileCompleteMessage = z.infer<typeof fileCompleteMessageSchema>
export type FileErrorMessage = z.infer<typeof fileErrorMessageSchema>
export type FolderOfferMessage = z.infer<typeof folderOfferMessageSchema>
export type FolderManifestMessage = z.infer<typeof folderManifestMessageSchema>
export type FolderAcceptMessage = z.infer<typeof folderAcceptMessageSchema>
export type FolderRejectMessage = z.infer<typeof folderRejectMessageSchema>
export type FolderCancelMessage = z.infer<typeof folderCancelMessageSchema>
export type FolderProgressMessage = z.infer<typeof folderProgressMessageSchema>
export type FolderCompleteMessage = z.infer<typeof folderCompleteMessageSchema>
export type FolderErrorMessage = z.infer<typeof folderErrorMessageSchema>
export type ProtocolMessage = z.infer<typeof protocolMessageSchema>
export type MessageType = ProtocolMessage['type']

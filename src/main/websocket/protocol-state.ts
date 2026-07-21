import { MESSAGE_DEDUPLICATION_LIMIT, MESSAGE_DEDUPLICATION_TTL_MS } from '@shared/constants'
import type {
  DeviceDisconnectMessage,
  DeviceHeartbeatMessage,
  FileAcceptMessage,
  FileCancelMessage,
  FileCompleteMessage,
  FileErrorMessage,
  FileOfferMessage,
  FileProgressMessage,
  FileRejectMessage,
  ProtocolMessage,
  TextAcknowledgementMessage,
  TextSendMessage,
} from '@shared/protocols'
import type { MessageId } from '@shared/types'

export type ConnectedProtocolMessage =
  | DeviceHeartbeatMessage
  | DeviceDisconnectMessage
  | TextSendMessage
  | TextAcknowledgementMessage
  | FileOfferMessage
  | FileAcceptMessage
  | FileRejectMessage
  | FileCancelMessage
  | FileProgressMessage
  | FileCompleteMessage
  | FileErrorMessage

export const isConnectedProtocolMessage = (
  message: ProtocolMessage,
): message is ConnectedProtocolMessage => {
  switch (message.type) {
    case 'device:heartbeat':
    case 'device:disconnect':
    case 'text:send':
    case 'text:ack':
    case 'file:offer':
    case 'file:accept':
    case 'file:reject':
    case 'file:cancel':
    case 'file:progress':
    case 'file:complete':
    case 'file:error':
      return true
    default:
      return false
  }
}

export class MessageDeduplicator {
  private readonly seenAtByMessageId = new Map<MessageId, number>()

  public constructor(
    private readonly maximumEntries = MESSAGE_DEDUPLICATION_LIMIT,
    private readonly timeToLiveMs = MESSAGE_DEDUPLICATION_TTL_MS,
  ) {}

  public isDuplicate(messageId: MessageId, now = Date.now()): boolean {
    this.pruneExpired(now)
    if (this.seenAtByMessageId.has(messageId)) return true

    this.seenAtByMessageId.set(messageId, now)
    while (this.seenAtByMessageId.size > this.maximumEntries) {
      const oldestMessageId = this.seenAtByMessageId.keys().next().value
      if (oldestMessageId === undefined) break
      this.seenAtByMessageId.delete(oldestMessageId)
    }
    return false
  }

  private pruneExpired(now: number): void {
    for (const [messageId, seenAt] of this.seenAtByMessageId) {
      if (now - seenAt <= this.timeToLiveMs) break
      this.seenAtByMessageId.delete(messageId)
    }
  }
}

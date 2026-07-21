import { describe, expect, it } from 'vitest'

import {
  isConnectedProtocolMessage,
  MessageDeduplicator,
} from '../../src/main/websocket/protocol-state'
import { parseProtocolMessage } from '@shared/protocols'
import { messageIdSchema } from '@shared/types'

const DEVICE_ID = '11111111-1111-4111-8111-111111111111'
const MESSAGE_ID = '22222222-2222-4222-8222-222222222222'
const CONNECTION_ID = '33333333-3333-4333-8333-333333333333'
const TRANSFER_ID = '44444444-4444-4444-8444-444444444444'
const FILE_ID = '55555555-5555-4555-8555-555555555555'

describe('MessageDeduplicator', () => {
  it('detects messages during the TTL and accepts them after expiry', () => {
    const deduplicator = new MessageDeduplicator(10, 100)
    const messageId = messageIdSchema.parse(MESSAGE_ID)

    expect(deduplicator.isDuplicate(messageId, 0)).toBe(false)
    expect(deduplicator.isDuplicate(messageId, 100)).toBe(true)
    expect(deduplicator.isDuplicate(messageId, 101)).toBe(false)
  })

  it('evicts the oldest message when the capacity is exceeded', () => {
    const deduplicator = new MessageDeduplicator(2, 1_000)
    const first = messageIdSchema.parse('11111111-1111-4111-8111-111111111111')
    const second = messageIdSchema.parse('22222222-2222-4222-8222-222222222222')
    const third = messageIdSchema.parse('33333333-3333-4333-8333-333333333333')

    expect(deduplicator.isDuplicate(first, 0)).toBe(false)
    expect(deduplicator.isDuplicate(second, 1)).toBe(false)
    expect(deduplicator.isDuplicate(third, 2)).toBe(false)
    expect(deduplicator.isDuplicate(first, 3)).toBe(false)
  })
})

describe('connected message whitelist', () => {
  const baseMessage = {
    messageId: MESSAGE_ID,
    senderId: DEVICE_ID,
    timestamp: 1_700_000_000_000,
  }

  it('allows implemented connection and text messages', () => {
    const heartbeat = parseProtocolMessage({
      type: 'device:heartbeat',
      ...baseMessage,
      payload: { connectionId: CONNECTION_ID, sequence: 1 },
    })
    const acknowledgement = parseProtocolMessage({
      type: 'text:ack',
      ...baseMessage,
      payload: { messageId: MESSAGE_ID },
    })

    expect(isConnectedProtocolMessage(heartbeat)).toBe(true)
    expect(isConnectedProtocolMessage(acknowledgement)).toBe(true)
  })

  it('allows file control messages after the file-transfer stage is active', () => {
    const offer = parseProtocolMessage({
      type: 'file:offer',
      ...baseMessage,
      payload: {
        transferId: TRANSFER_ID,
        files: [{ fileId: FILE_ID, displayName: 'example.txt', size: 1, mimeType: 'text/plain' }],
      },
    })

    expect(isConnectedProtocolMessage(offer)).toBe(true)
  })
})

import { describe, expect, it } from 'vitest'

import { MAX_FILE_SIZE_BYTES, MAX_FILES_PER_TRANSFER, MAX_TEXT_BYTES } from '@shared/constants'
import {
  fileAcceptMessageSchema,
  fileCompleteMessageSchema,
  fileErrorMessageSchema,
  fileOfferMessageSchema,
  fileProgressMessageSchema,
  parseProtocolMessage,
  textSendMessageSchema,
} from '@shared/protocols'

const DEVICE_ID = '11111111-1111-4111-8111-111111111111'
const MESSAGE_ID = '22222222-2222-4222-8222-222222222222'
const CONNECTION_ID = '33333333-3333-4333-8333-333333333333'
const TRANSFER_ID = '44444444-4444-4444-8444-444444444444'
const FILE_ID = '55555555-5555-4555-8555-555555555555'

const baseMessage = {
  messageId: MESSAGE_ID,
  senderId: DEVICE_ID,
  timestamp: 1_700_000_000_000,
}

const device = {
  deviceId: DEVICE_ID,
  deviceName: 'MacBook',
  operatingSystem: 'macos',
  ipAddress: '192.168.1.20',
  servicePort: 53_317,
}

const file = {
  fileId: FILE_ID,
  displayName: '示例文件.txt',
  size: 1_024,
  mimeType: 'text/plain',
}

const validMessages: readonly Record<string, unknown>[] = [
  {
    type: 'device:hello',
    ...baseMessage,
    payload: { protocolVersion: 1, device, connectionNonce: 'n'.repeat(32) },
  },
  {
    type: 'device:welcome',
    ...baseMessage,
    payload: {
      protocolVersion: 1,
      device,
      connectionNonce: 'n'.repeat(32),
      connectionId: CONNECTION_ID,
      heartbeatIntervalMs: 10_000,
      heartbeatTimeoutMs: 30_000,
    },
  },
  {
    type: 'device:heartbeat',
    ...baseMessage,
    payload: { connectionId: CONNECTION_ID, sequence: 1 },
  },
  {
    type: 'device:disconnect',
    ...baseMessage,
    payload: { connectionId: CONNECTION_ID, reason: 'user_requested' },
  },
  {
    type: 'text:send',
    ...baseMessage,
    payload: { content: 'https://example.com', contentType: 'link' },
  },
  {
    type: 'text:ack',
    ...baseMessage,
    payload: { messageId: MESSAGE_ID },
  },
  {
    type: 'file:offer',
    ...baseMessage,
    payload: { transferId: TRANSFER_ID, files: [file] },
  },
  {
    type: 'file:accept',
    ...baseMessage,
    payload: {
      transferId: TRANSFER_ID,
      files: [{ fileId: FILE_ID, uploadToken: 't'.repeat(32), expiresAt: 1_700_000_060_000 }],
    },
  },
  {
    type: 'file:reject',
    ...baseMessage,
    payload: { transferId: TRANSFER_ID, reason: 'user_rejected' },
  },
  {
    type: 'file:cancel',
    ...baseMessage,
    payload: { transferId: TRANSFER_ID, fileId: FILE_ID, reason: 'user_cancelled' },
  },
  {
    type: 'file:progress',
    ...baseMessage,
    payload: { transferId: TRANSFER_ID, fileId: FILE_ID, transferredBytes: 512 },
  },
  {
    type: 'file:complete',
    ...baseMessage,
    payload: { transferId: TRANSFER_ID, fileId: FILE_ID, size: 1_024 },
  },
  {
    type: 'file:error',
    ...baseMessage,
    payload: { transferId: TRANSFER_ID, fileId: FILE_ID, errorCode: 'TRANSFER_FAILED' },
  },
]

describe('protocolMessageSchema', () => {
  it.each(validMessages)('parses $type', (message) => {
    expect(parseProtocolMessage(message).type).toBe(message.type)
  })

  it.each([
    { ...validMessages[0], messageId: 'not-a-uuid' },
    { ...validMessages[0], timestamp: -1 },
    { ...validMessages[0], unknownField: true },
    { type: 'unknown:message', ...baseMessage, payload: {} },
    { type: 'text:send', senderId: DEVICE_ID, timestamp: 1, payload: {} },
  ])('rejects an invalid base message', (message) => {
    expect(() => parseProtocolMessage(message)).toThrow()
  })
})

describe('text messages', () => {
  const createTextMessage = (content: string, contentType: string = 'text') => ({
    type: 'text:send',
    ...baseMessage,
    payload: { content, contentType },
  })

  it('accepts the exact UTF-8 byte limit', () => {
    expect(
      textSendMessageSchema.safeParse(createTextMessage('a'.repeat(MAX_TEXT_BYTES))).success,
    ).toBe(true)
  })

  it.each([
    createTextMessage(''),
    createTextMessage('a'.repeat(MAX_TEXT_BYTES + 1)),
    createTextMessage('你'.repeat(Math.floor(MAX_TEXT_BYTES / 3) + 1)),
    createTextMessage('hello', 'html'),
  ])('rejects invalid text payloads', (message) => {
    expect(textSendMessageSchema.safeParse(message).success).toBe(false)
  })
})

describe('file messages', () => {
  const createOffer = (files: readonly unknown[]) => ({
    type: 'file:offer',
    ...baseMessage,
    payload: { transferId: TRANSFER_ID, files },
  })

  it('accepts a zero-byte file and the maximum file size', () => {
    expect(fileOfferMessageSchema.safeParse(createOffer([{ ...file, size: 0 }])).success).toBe(true)
    expect(
      fileOfferMessageSchema.safeParse(createOffer([{ ...file, size: MAX_FILE_SIZE_BYTES }]))
        .success,
    ).toBe(true)
  })

  it.each([
    createOffer([]),
    createOffer(Array.from({ length: MAX_FILES_PER_TRANSFER + 1 }, () => file)),
    createOffer([{ ...file, size: -1 }]),
    createOffer([{ ...file, size: 1.5 }]),
    createOffer([{ ...file, size: MAX_FILE_SIZE_BYTES + 1 }]),
    createOffer([{ ...file, fileId: 'invalid' }]),
    createOffer([{ ...file, mimeType: 'invalid' }]),
    createOffer([{ ...file, displayName: '../unsafe.txt' }]),
    createOffer([{ ...file, displayName: 'report:final.txt' }]),
    createOffer([{ ...file, displayName: 'CON.txt' }]),
    createOffer([{ ...file, displayName: 'trailing.' }]),
    createOffer([{ ...file, displayName: 'trailing ' }]),
    createOffer([{ ...file, displayName: '你'.repeat(86) }]),
  ])('rejects invalid file offers', (message) => {
    expect(fileOfferMessageSchema.safeParse(message).success).toBe(false)
  })

  it('validates accept, progress, and complete boundaries', () => {
    const accept = validMessages.find((message) => message.type === 'file:accept')
    const progress = validMessages.find((message) => message.type === 'file:progress')
    const complete = validMessages.find((message) => message.type === 'file:complete')

    expect(fileAcceptMessageSchema.safeParse(accept).success).toBe(true)
    expect(fileProgressMessageSchema.safeParse(progress).success).toBe(true)
    expect(fileCompleteMessageSchema.safeParse(complete).success).toBe(true)
    expect(
      fileProgressMessageSchema.safeParse({
        ...progress,
        payload: { transferId: TRANSFER_ID, fileId: FILE_ID, transferredBytes: -1 },
      }).success,
    ).toBe(false)
    expect(
      fileCompleteMessageSchema.safeParse({
        ...complete,
        payload: { transferId: TRANSFER_ID, fileId: FILE_ID, size: MAX_FILE_SIZE_BYTES + 1 },
      }).success,
    ).toBe(false)
  })

  it('rejects invalid upload authorizations and error codes', () => {
    const invalidAccept = {
      type: 'file:accept',
      ...baseMessage,
      payload: {
        transferId: TRANSFER_ID,
        files: [{ fileId: FILE_ID, uploadToken: 'short', expiresAt: 1_700_000_060_000 }],
      },
    }
    const invalidError = {
      type: 'file:error',
      ...baseMessage,
      payload: { transferId: TRANSFER_ID, errorCode: 'UNKNOWN_ERROR' },
    }

    expect(fileAcceptMessageSchema.safeParse(invalidAccept).success).toBe(false)
    expect(fileErrorMessageSchema.safeParse(invalidError).success).toBe(false)
  })
})

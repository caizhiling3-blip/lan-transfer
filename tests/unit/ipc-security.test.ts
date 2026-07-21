import { describe, expect, it } from 'vitest'

import { createWindowOptions } from '../../src/main/app/window-options'
import { isTrustedIpcSenderContext } from '../../src/main/ipc/sender-validation'
import { MAX_FILES_PER_TRANSFER, MAX_TEXT_BYTES } from '@shared/constants'
import { IPC_INVOKE_CHANNELS, ipcInvokeRequestSchemas, parseIpcInvokeRequest } from '@shared/ipc'

const REQUEST_ID = '11111111-1111-4111-8111-111111111111'
const TRANSFER_ID = '22222222-2222-4222-8222-222222222222'

describe('secure window options', () => {
  it('keeps renderer isolation enabled', () => {
    const options = createWindowOptions('/trusted/preload.mjs')

    expect(options.webPreferences).toMatchObject({
      preload: '/trusted/preload.mjs',
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
    })
  })
})

describe('IPC sender validation', () => {
  const mainFrame = {}
  const trustedWindow = { destroyed: false, webContentsId: 7 }

  it('accepts only the current main frame', () => {
    expect(
      isTrustedIpcSenderContext({ senderId: 7, senderFrame: mainFrame, mainFrame }, trustedWindow),
    ).toBe(true)
  })

  it.each([
    { senderId: 8, senderFrame: mainFrame, mainFrame, window: trustedWindow },
    { senderId: 7, senderFrame: {}, mainFrame, window: trustedWindow },
    {
      senderId: 7,
      senderFrame: mainFrame,
      mainFrame,
      window: { ...trustedWindow, destroyed: true },
    },
    { senderId: 7, senderFrame: mainFrame, mainFrame, window: null },
  ])('rejects untrusted sender contexts', ({ window, ...sender }) => {
    expect(isTrustedIpcSenderContext(sender, window)).toBe(false)
  })
})

describe('IPC request schemas', () => {
  it('provides exactly one schema for every invoke channel', () => {
    expect(Object.keys(ipcInvokeRequestSchemas).sort()).toEqual([...IPC_INVOKE_CHANNELS].sort())
  })

  it('allows only HTTP and HTTPS external URLs', () => {
    expect(() =>
      parseIpcInvokeRequest('app:open-external-url', { url: 'https://example.com/path' }),
    ).not.toThrow()
    expect(() =>
      parseIpcInvokeRequest('app:open-external-url', { url: 'file:///etc/passwd' }),
    ).toThrow()
    expect(() =>
      parseIpcInvokeRequest('app:open-external-url', { url: 'javascript:alert(1)' }),
    ).toThrow()
  })

  it('validates connection requests and rejects extra fields', () => {
    expect(() =>
      parseIpcInvokeRequest('connection:connect', { host: '192.168.1.20', port: 53_317 }),
    ).not.toThrow()
    expect(() =>
      parseIpcInvokeRequest('connection:connect', {
        host: 'example.com',
        port: 53_317,
      }),
    ).toThrow()
    expect(() =>
      parseIpcInvokeRequest('connection:respond-to-request', {
        requestId: REQUEST_ID,
        decision: 'accept',
        extra: true,
      }),
    ).toThrow()
  })

  it('validates clipboard text by UTF-8 byte length', () => {
    expect(() =>
      parseIpcInvokeRequest('clipboard:write-text', { text: 'a'.repeat(MAX_TEXT_BYTES) }),
    ).not.toThrow()
    expect(() =>
      parseIpcInvokeRequest('clipboard:write-text', { text: '你'.repeat(MAX_TEXT_BYTES) }),
    ).toThrow()
  })

  it('rejects duplicate and excessive selection tokens', () => {
    const token = 'a'.repeat(32)
    expect(() =>
      parseIpcInvokeRequest('transfer:offer-files', { selectionTokens: [token, token] }),
    ).toThrow()
    expect(() =>
      parseIpcInvokeRequest('transfer:offer-files', {
        selectionTokens: Array.from(
          { length: MAX_FILES_PER_TRANSFER + 1 },
          (_, index) => `${String(index).padStart(32, 'a')}`,
        ),
      }),
    ).toThrow()
  })

  it('does not allow a directory token on rejection', () => {
    expect(() =>
      parseIpcInvokeRequest('transfer:respond-to-offer', {
        transferId: TRANSFER_ID,
        decision: 'reject',
        directoryToken: 'a'.repeat(32),
      }),
    ).toThrow()
  })

  it('requires a non-empty settings patch', () => {
    expect(() => parseIpcInvokeRequest('settings:update', {})).toThrow()
    expect(() => parseIpcInvokeRequest('settings:update', { servicePort: 53_317 })).not.toThrow()
  })
})

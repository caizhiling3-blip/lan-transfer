import { describe, expect, it } from 'vitest'

import { createWindowOptions } from '../../src/main/app/window-options'
import { isTrustedIpcSenderContext } from '../../src/main/ipc/sender-validation'
import {
  MAX_FILES_PER_TRANSFER,
  MAX_HISTORY_SEARCH_LENGTH,
  MAX_TEXT_BYTES,
} from '@shared/constants'
import {
  historyCleanupCriteriaSchema,
  historyDeleteRequestSchema,
  IPC_INVOKE_CHANNELS,
  ipcInvokeRequestSchemas,
  parseIpcInvokeRequest,
  recentDeviceAliasSchema,
} from '@shared/ipc'

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

  it('validates unified queue batches and queue item identifiers', () => {
    const fileToken = 'a'.repeat(32)
    const folderToken = 'b'.repeat(32)
    expect(() =>
      parseIpcInvokeRequest('transfer:enqueue', {
        text: { content: 'hello', contentType: 'text' },
        fileSelectionTokens: [fileToken],
        folderSelectionTokens: [folderToken],
      }),
    ).not.toThrow()
    expect(() =>
      parseIpcInvokeRequest('transfer:enqueue', {
        fileSelectionTokens: [],
        folderSelectionTokens: [],
      }),
    ).toThrow()
    expect(() =>
      parseIpcInvokeRequest('transfer:enqueue', {
        fileSelectionTokens: [fileToken],
        folderSelectionTokens: [fileToken],
      }),
    ).toThrow()
    expect(() =>
      parseIpcInvokeRequest('transfer:cancel-queued', { queueItemId: REQUEST_ID }),
    ).not.toThrow()
    expect(() =>
      parseIpcInvokeRequest('transfer:cancel-queued', { queueItemId: 'not-a-uuid' }),
    ).toThrow()
  })

  it('bounds and deduplicates preload-only dropped file paths', () => {
    expect(() =>
      parseIpcInvokeRequest('transfer:register-dropped-files', {
        paths: ['/tmp/one.txt', '/tmp/two.txt'],
      }),
    ).not.toThrow()
    expect(() =>
      parseIpcInvokeRequest('transfer:register-dropped-files', {
        paths: ['/tmp/one.txt', '/tmp/one.txt'],
      }),
    ).toThrow()
    expect(() =>
      parseIpcInvokeRequest('transfer:register-dropped-files', {
        paths: Array.from(
          { length: MAX_FILES_PER_TRANSFER + 1 },
          (_, index) => `/tmp/${String(index)}.txt`,
        ),
      }),
    ).toThrow()
  })

  it('allows only bounded unique dropped file and folder items', () => {
    expect(() =>
      parseIpcInvokeRequest('transfer:register-dropped-items', {
        paths: ['/tmp/report.txt', '/tmp/project'],
      }),
    ).not.toThrow()
    expect(() =>
      parseIpcInvokeRequest('transfer:register-dropped-items', {
        paths: ['/tmp/project', '/tmp/project'],
      }),
    ).toThrow()
    expect(() => parseIpcInvokeRequest('transfer:select-folder', undefined)).not.toThrow()
    expect(() => parseIpcInvokeRequest('transfer:select-folder', {})).toThrow()
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
    expect(() =>
      parseIpcInvokeRequest('settings:update', {
        historyRetentionDays: null,
        logRetentionDays: 30,
      }),
    ).not.toThrow()
    expect(() => parseIpcInvokeRequest('settings:update', { logRetentionDays: 0 })).toThrow()
  })

  it('validates recent device management requests', () => {
    const deviceId = '22222222-2222-4222-8222-222222222222'
    expect(() => parseIpcInvokeRequest('recent-devices:list', undefined)).not.toThrow()
    expect(() => parseIpcInvokeRequest('recent-devices:list', {})).toThrow()
    expect(() =>
      parseIpcInvokeRequest('recent-devices:update-alias', { deviceId, alias: 'Office PC' }),
    ).not.toThrow()
    expect(() =>
      parseIpcInvokeRequest('recent-devices:update-alias', { deviceId, alias: null }),
    ).not.toThrow()
    expect(() =>
      parseIpcInvokeRequest('recent-devices:update-alias', { deviceId, alias: '' }),
    ).toThrow()
    expect(() => parseIpcInvokeRequest('recent-devices:remove', { deviceId })).not.toThrow()
  })

  it('does not accept paths or parameters for diagnostics operations', () => {
    for (const channel of [
      'diagnostics:get-summary',
      'diagnostics:export-report',
      'diagnostics:open-data-directory',
      'diagnostics:open-log-directory',
      'diagnostics:get-log-stats',
      'diagnostics:clear-logs',
    ] as const) {
      expect(() => parseIpcInvokeRequest(channel, undefined)).not.toThrow()
      expect(() => parseIpcInvokeRequest(channel, { path: '/tmp/unsafe' })).toThrow()
    }
  })

  it('bounds history search input', () => {
    expect(() =>
      parseIpcInvokeRequest('history:list', {
        query: 'report',
        offset: 0,
        limit: 50,
      }),
    ).not.toThrow()
    expect(() =>
      parseIpcInvokeRequest('history:list', {
        query: 'x'.repeat(MAX_HISTORY_SEARCH_LENGTH + 1),
        offset: 0,
        limit: 50,
      }),
    ).toThrow()
    expect(() =>
      parseIpcInvokeRequest('history:list', { query: '   ', offset: 0, limit: 50 }),
    ).toThrow()
  })

  it('bounds future history cleanup and recent device alias inputs', () => {
    const historyId = '33333333-3333-4333-8333-333333333333'
    expect(() => historyDeleteRequestSchema.parse({ historyIds: [historyId] })).not.toThrow()
    expect(() => historyDeleteRequestSchema.parse({ historyIds: [historyId, historyId] })).toThrow()
    expect(() =>
      historyCleanupCriteriaSchema.parse({
        statuses: ['failed', 'cancelled'],
        before: Date.now(),
      }),
    ).not.toThrow()
    expect(() => historyCleanupCriteriaSchema.parse({})).toThrow()
    expect(() =>
      parseIpcInvokeRequest('history:get-stats', { criteria: { statuses: ['failed'] } }),
    ).not.toThrow()
    expect(() => parseIpcInvokeRequest('history:get-stats', {})).not.toThrow()
    expect(() => parseIpcInvokeRequest('history:delete', { historyIds: [historyId] })).not.toThrow()
    expect(() => parseIpcInvokeRequest('history:cleanup', { before: Date.now() })).not.toThrow()
    expect(() => parseIpcInvokeRequest('history:cleanup', {})).toThrow()
    expect(recentDeviceAliasSchema.parse('  Office PC  ')).toBe('Office PC')
    expect(() => recentDeviceAliasSchema.parse('')).toThrow()
  })
})

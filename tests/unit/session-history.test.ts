import { describe, expect, it } from 'vitest'

import { SessionHistory } from '../../src/main/storage/session-history'
import { deviceIdSchema } from '@shared/types'
import type { DeviceInfo, HistoryEntryDto } from '@shared/types'

const peer: DeviceInfo = {
  deviceId: deviceIdSchema.parse('22222222-2222-4222-8222-222222222222'),
  deviceName: 'Peer',
  operatingSystem: 'windows',
  ipAddress: '192.168.1.2',
  servicePort: 53_317,
}

const addEntry = (history: SessionHistory, text: string, direction: 'send' | 'receive') =>
  history.add({
    direction,
    kind: 'text',
    peer,
    status: 'completed',
    textPreview: text,
    createdAt: Date.now(),
  })

describe('SessionHistory', () => {
  it('stores newest entries first and enforces its limit', () => {
    const history = new SessionHistory(2)
    addEntry(history, 'first', 'send')
    addEntry(history, 'second', 'receive')
    addEntry(history, 'third', 'send')

    expect(history.list({ offset: 0, limit: 100 }).map((entry) => entry.textPreview)).toEqual([
      'third',
      'second',
    ])
  })

  it('filters and paginates entries', () => {
    const history = new SessionHistory()
    addEntry(history, 'one', 'send')
    addEntry(history, 'two', 'receive')
    addEntry(history, 'three', 'send')

    expect(history.list({ direction: 'send', offset: 1, limit: 1 })[0]?.textPreview).toBe('one')
  })

  it('searches text, file names, device names, and addresses before pagination', () => {
    const history = new SessionHistory()
    addEntry(history, 'Quarterly Report', 'send')
    history.add({
      direction: 'receive',
      kind: 'file',
      peer: { ...peer, deviceName: 'Design Mac', ipAddress: '192.168.1.88' },
      status: 'completed',
      displayName: '品牌方案.pdf',
      size: 42,
      createdAt: Date.now(),
    })

    expect(history.list({ query: 'quarterly', offset: 0, limit: 100 })).toHaveLength(1)
    expect(history.list({ query: '品牌', offset: 0, limit: 100 })).toHaveLength(1)
    expect(history.list({ query: 'design mac', offset: 0, limit: 100 })).toHaveLength(1)
    expect(history.list({ query: '1.88', offset: 0, limit: 100 })).toHaveLength(1)
  })

  it('clears all entries', () => {
    const history = new SessionHistory()
    addEntry(history, 'one', 'send')
    history.clear()

    expect(history.list({ offset: 0, limit: 100 })).toEqual([])
  })

  it('reports matching statistics and deletes selected entries', () => {
    const history = new SessionHistory()
    const first = addEntry(history, 'first report', 'send')
    addEntry(history, 'second', 'receive')

    expect(history.getStats({ query: 'report' }, 128)).toEqual({
      totalEntries: 2,
      matchingEntries: 1,
      storageBytes: 128,
    })
    expect(history.delete([first.id])).toBe(1)
    expect(history.delete([first.id])).toBe(0)
    expect(history.getStats()).toMatchObject({ totalEntries: 1 })
  })

  it('previews and applies compound cleanup criteria', () => {
    const history = new SessionHistory()
    addEntry(history, 'keep', 'send')
    history.add({
      direction: 'receive',
      kind: 'file',
      peer,
      status: 'failed',
      displayName: 'old-report.pdf',
      createdAt: Date.now() - 10_000,
    })

    const criteria = {
      direction: 'receive' as const,
      statuses: ['failed' as const],
      query: 'report',
    }
    expect(history.previewCleanup(criteria)).toBe(1)
    expect(history.cleanup(criteria)).toBe(1)
    expect(history.list({ offset: 0, limit: 100 })).toHaveLength(1)
  })

  it('removes expired entries at startup without deleting current entries', () => {
    const now = Date.now()
    const persisted: HistoryEntryDto[] = [
      {
        id: '33333333-3333-4333-8333-333333333333',
        direction: 'send',
        kind: 'text',
        peer,
        status: 'completed',
        createdAt: now - 3 * 86_400_000,
      },
      {
        id: '44444444-4444-4444-8444-444444444444',
        direction: 'receive',
        kind: 'text',
        peer,
        status: 'completed',
        createdAt: now,
      },
    ]
    const history = new SessionHistory(100, persisted, () => undefined, 1)

    expect(history.list({ offset: 0, limit: 100 }).map((entry) => entry.id)).toEqual([
      '44444444-4444-4444-8444-444444444444',
    ])
  })
})

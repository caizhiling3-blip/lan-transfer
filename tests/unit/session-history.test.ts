import { describe, expect, it } from 'vitest'

import { SessionHistory } from '../../src/main/storage/session-history'
import { deviceIdSchema } from '@shared/types'
import type { DeviceInfo } from '@shared/types'

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

  it('clears all entries', () => {
    const history = new SessionHistory()
    addEntry(history, 'one', 'send')
    history.clear()

    expect(history.list({ offset: 0, limit: 100 })).toEqual([])
  })
})

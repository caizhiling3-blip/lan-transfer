import { describe, expect, it } from 'vitest'

import { DISCOVERY_APP_ID, PROTOCOL_VERSION } from '@shared/constants'
import { discoveryAnnouncementSchema } from '@shared/protocols'
import { deviceIdSchema } from '@shared/types'

import { DiscoveryRegistry } from '../../src/main/discovery/discovery-registry'

const LOCAL_DEVICE_ID = deviceIdSchema.parse('10000000-0000-4000-8000-000000000001')
const PEER_DEVICE_ID = '20000000-0000-4000-8000-000000000002'
const MESSAGE_ID = '30000000-0000-4000-8000-000000000003'

const announcement = (timestamp: number): Record<string, unknown> => ({
  appId: DISCOVERY_APP_ID,
  protocolVersion: PROTOCOL_VERSION,
  messageId: MESSAGE_ID,
  deviceId: PEER_DEVICE_ID,
  deviceName: '客厅 Mac',
  operatingSystem: 'macos',
  servicePort: 53_317,
  timestamp,
})

describe('discovery announcement', () => {
  it('accepts the strict minimum advertisement', () => {
    expect(discoveryAnnouncementSchema.parse(announcement(1_000)).deviceName).toBe('客厅 Mac')
    expect(() =>
      discoveryAnnouncementSchema.parse({ ...announcement(1_000), uploadToken: 'secret' }),
    ).toThrow()
  })

  it('uses the datagram source IP and removes expired peers', () => {
    const registry = new DiscoveryRegistry(LOCAL_DEVICE_ID)
    expect(registry.accept(announcement(10_000), '192.168.1.25', 10_000)).toBe(true)
    expect(registry.list()[0]?.device.ipAddress).toBe('192.168.1.25')
    expect(registry.removeExpired(27_000)).toBe(true)
    expect(registry.list()).toEqual([])
  })

  it('ignores self advertisements, invalid sources, and stale packets', () => {
    const registry = new DiscoveryRegistry(LOCAL_DEVICE_ID)
    expect(
      registry.accept(
        { ...announcement(10_000), deviceId: LOCAL_DEVICE_ID },
        '192.168.1.2',
        10_000,
      ),
    ).toBe(false)
    expect(registry.accept(announcement(10_000), 'not-an-ip', 10_000)).toBe(false)
    expect(registry.accept(announcement(10_000), '192.168.1.25', 1_000_000)).toBe(false)
  })
})

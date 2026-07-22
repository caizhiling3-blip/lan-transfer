import { describe, expect, it } from 'vitest'

import { calculateBroadcastAddress } from '../../src/main/discovery/network-interfaces'

describe('discovery network interfaces', () => {
  it('calculates directed IPv4 broadcast addresses', () => {
    expect(calculateBroadcastAddress('192.168.10.25', '255.255.255.0')).toBe('192.168.10.255')
    expect(calculateBroadcastAddress('172.21.66.15', '255.255.240.0')).toBe('172.21.79.255')
  })

  it('rejects malformed IPv4 input', () => {
    expect(calculateBroadcastAddress('192.168.1', '255.255.255.0')).toBeNull()
    expect(calculateBroadcastAddress('192.168.1.2', '255.255.999.0')).toBeNull()
  })
})

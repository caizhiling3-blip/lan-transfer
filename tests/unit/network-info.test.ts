import type { NetworkInterfaceInfo } from 'node:os'

import { describe, expect, it } from 'vitest'

import { collectLanIpv4Addresses } from '../../src/main/server/network-info'

const createIpv4 = (address: string, internal = false): NetworkInterfaceInfo => ({
  address,
  netmask: '255.255.255.0',
  family: 'IPv4',
  mac: '00:00:00:00:00:00',
  internal,
  cidr: `${address}/24`,
})

describe('collectLanIpv4Addresses', () => {
  it('returns unique external IPv4 addresses in stable order', () => {
    expect(
      collectLanIpv4Addresses({
        en0: [createIpv4('192.168.1.20'), createIpv4('127.0.0.1', true)],
        bridge0: [createIpv4('10.0.0.5'), createIpv4('192.168.1.20')],
        empty: undefined,
      }),
    ).toEqual(['10.0.0.5', '192.168.1.20'])
  })

  it('excludes IPv6 addresses', () => {
    expect(
      collectLanIpv4Addresses({
        en0: [
          {
            address: 'fe80::1',
            netmask: 'ffff:ffff:ffff:ffff::',
            family: 'IPv6',
            mac: '00:00:00:00:00:00',
            internal: false,
            cidr: 'fe80::1/64',
            scopeid: 1,
          },
        ],
      }),
    ).toEqual([])
  })
})

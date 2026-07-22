import { networkInterfaces } from 'node:os'

export interface DiscoveryNetworkInterface {
  readonly address: string
  readonly broadcastAddress: string
}

const ipv4ToNumber = (address: string): number | null => {
  const octets = address.split('.').map(Number)
  if (
    octets.length !== 4 ||
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) {
    return null
  }
  return octets.reduce((value, octet) => (value << 8) | octet, 0) >>> 0
}

const numberToIpv4 = (value: number): string =>
  [24, 16, 8, 0].map((shift) => String((value >>> shift) & 0xff)).join('.')

export const calculateBroadcastAddress = (address: string, netmask: string): string | null => {
  const addressValue = ipv4ToNumber(address)
  const netmaskValue = ipv4ToNumber(netmask)
  if (addressValue === null || netmaskValue === null) return null
  return numberToIpv4(((addressValue & netmaskValue) | ~netmaskValue) >>> 0)
}

export const getDiscoveryNetworkInterfaces = (): readonly DiscoveryNetworkInterface[] => {
  const interfaces: DiscoveryNetworkInterface[] = []
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.internal || entry.family !== 'IPv4') continue
      const broadcastAddress = calculateBroadcastAddress(entry.address, entry.netmask)
      if (broadcastAddress === null) continue
      interfaces.push({ address: entry.address, broadcastAddress })
    }
  }
  return interfaces
}

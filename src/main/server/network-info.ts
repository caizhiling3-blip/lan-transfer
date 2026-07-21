import { networkInterfaces } from 'node:os'
import type { NetworkInterfaceInfo } from 'node:os'

export type NetworkInterfaceMap = Readonly<
  Record<string, readonly NetworkInterfaceInfo[] | undefined>
>

export const collectLanIpv4Addresses = (interfaces: NetworkInterfaceMap): readonly string[] => {
  const addresses = new Set<string>()

  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) {
        addresses.add(entry.address)
      }
    }
  }

  return [...addresses].sort()
}

export const getLanIpv4Addresses = (): readonly string[] =>
  collectLanIpv4Addresses(networkInterfaces())

import ElectronStore from 'electron-store'

import { MAX_TRUSTED_DEVICES } from '@shared/constants'
import { publicIdentitySchema } from '@shared/protocols'
import type { DeviceId, PublicIdentityDto, TrustedDeviceDto } from '@shared/types'

import { calculateIdentityFingerprint } from './identity-store'
import { trustedDevicesStoreSchema, type TrustedDevicesStoreData } from './secure-store-schemas'

export type TrustDeviceResult =
  | { readonly ok: true; readonly device: TrustedDeviceDto }
  | { readonly ok: false; readonly errorCode: 'IDENTITY_MISMATCH' | 'SIGNATURE_INVALID' }

export class TrustedDevicesStore {
  private readonly store: ElectronStore<TrustedDevicesStoreData>

  public constructor(directory: string) {
    this.store = new ElectronStore<TrustedDevicesStoreData>({
      cwd: directory,
      name: 'trusted-devices',
    })
    if (this.store.size === 0) {
      this.store.store = { schemaVersion: 1, devices: [] }
    }
    const data = trustedDevicesStoreSchema.parse(this.store.store)
    for (const record of data.devices) {
      if (calculateIdentityFingerprint(record.identity.publicKey) !== record.identity.fingerprint) {
        throw new Error('Trusted device fingerprint does not match its public key')
      }
    }
  }

  public list(): readonly TrustedDeviceDto[] {
    return [...this.store.get('devices')]
  }

  public get(deviceId: DeviceId): TrustedDeviceDto | null {
    return this.list().find((record) => record.deviceId === deviceId) ?? null
  }

  public trust(
    deviceId: DeviceId,
    identity: PublicIdentityDto,
    verifiedAt = Date.now(),
  ): TrustDeviceResult {
    const parsedIdentity = publicIdentitySchema.safeParse(identity)
    if (
      !parsedIdentity.success ||
      calculateIdentityFingerprint(parsedIdentity.data.publicKey) !==
        parsedIdentity.data.fingerprint
    ) {
      return { ok: false, errorCode: 'SIGNATURE_INVALID' }
    }
    const current = this.list()
    const existing = current.find((record) => record.deviceId === deviceId)
    if (existing !== undefined && existing.identity.publicKey !== parsedIdentity.data.publicKey) {
      return { ok: false, errorCode: 'IDENTITY_MISMATCH' }
    }
    const device: TrustedDeviceDto = {
      deviceId,
      identity: parsedIdentity.data,
      firstPairedAt: existing?.firstPairedAt ?? verifiedAt,
      lastVerifiedAt: verifiedAt,
    }
    const devices = [device, ...current.filter((record) => record.deviceId !== deviceId)].slice(
      0,
      MAX_TRUSTED_DEVICES,
    )
    this.store.set('devices', trustedDevicesStoreSchema.shape.devices.parse(devices))
    return { ok: true, device }
  }

  public revoke(deviceId: DeviceId): boolean {
    const current = this.list()
    const devices = current.filter((record) => record.deviceId !== deviceId)
    if (devices.length === current.length) return false
    this.store.set('devices', devices)
    return true
  }

  public clear(): void {
    this.store.set('devices', [])
  }
}

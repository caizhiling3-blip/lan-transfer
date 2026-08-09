import { createHash, generateKeyPairSync, sign } from 'node:crypto'

import { publicIdentitySchema } from '@shared/protocols'
import type { DeviceId, DeviceInfo, PublicIdentityDto, TrustedDeviceDto } from '@shared/types'

import { PairingCoordinator, type TrustedDeviceRegistry } from '../../src/main/pairing'
import type { TrustDeviceResult } from '../../src/main/storage'
import {
  ConnectionManager,
  type DeviceIdentitySigner,
} from '../../src/main/websocket/connection-manager'

const displayedPairingCodes = new Map<string, string>()
const pendingPairingVerifiers = new Map<string, (verificationCode: string) => void>()

export class MemoryTrustedDevices implements TrustedDeviceRegistry {
  private readonly devices = new Map<DeviceId, TrustedDeviceDto>()

  public get(deviceId: DeviceId): TrustedDeviceDto | null {
    return this.devices.get(deviceId) ?? null
  }

  public trust(
    deviceId: DeviceId,
    identity: PublicIdentityDto,
    verifiedAt = Date.now(),
  ): TrustDeviceResult {
    const existing = this.devices.get(deviceId)
    if (existing !== undefined && existing.identity.publicKey !== identity.publicKey) {
      return { ok: false, errorCode: 'IDENTITY_MISMATCH' }
    }
    const device = {
      deviceId,
      identity,
      firstPairedAt: existing?.firstPairedAt ?? verifiedAt,
      lastVerifiedAt: verifiedAt,
    }
    this.devices.set(deviceId, device)
    return { ok: true, device }
  }
}

export const createMemoryIdentitySigner = (): DeviceIdentitySigner => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const encodedPublicKey = publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
  const identity = publicIdentitySchema.parse({
    algorithm: 'Ed25519',
    publicKey: encodedPublicKey,
    fingerprint: createHash('sha256').update(Buffer.from(encodedPublicKey, 'base64')).digest('hex'),
  })
  return {
    getPublicIdentity: () => identity,
    sign: (data) => sign(null, Buffer.from(data), privateKey).toString('base64'),
  }
}

export const createAutoPairingConnectionManager = (
  getLocalDevice: () => DeviceInfo,
): ConnectionManager => {
  const { manager, pairingCoordinator } = createSecureConnectionEndpoint(getLocalDevice)
  pairingCoordinator.subscribeRequests((request) => {
    if (request.verificationMode === 'display') {
      const verifier = pendingPairingVerifiers.get(request.requestId)
      if (verifier !== undefined) {
        pendingPairingVerifiers.delete(request.requestId)
        verifier(request.verificationCode)
      } else {
        displayedPairingCodes.set(request.requestId, request.verificationCode)
      }
      return
    }
    const verify = (verificationCode: string): void => {
      displayedPairingCodes.delete(request.requestId)
      pairingCoordinator.respond(request.requestId, { decision: 'verify', verificationCode })
    }
    const verificationCode = displayedPairingCodes.get(request.requestId)
    if (verificationCode === undefined) pendingPairingVerifiers.set(request.requestId, verify)
    else verify(verificationCode)
  })
  return manager
}

export const createSecureConnectionEndpoint = (getLocalDevice: () => DeviceInfo) => {
  const trustedDevices = new MemoryTrustedDevices()
  const pairingCoordinator = new PairingCoordinator(trustedDevices)
  const manager = new ConnectionManager(
    getLocalDevice,
    createMemoryIdentitySigner(),
    pairingCoordinator,
  )
  return { manager, pairingCoordinator, trustedDevices }
}

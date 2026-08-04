import { generateKeyPairSync } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { publicIdentitySchema } from '@shared/protocols'
import { deviceIdSchema } from '@shared/types'
import type { DeviceInfo, PublicIdentityDto } from '@shared/types'

import { PairingCoordinator } from '../../src/main/pairing'
import {
  createPairingVerificationCode,
  deriveSharedSecret,
  deriveTranscriptConfirmationKey,
  generateEphemeralKeyPair,
  generateHandshakeNonce,
  serializeSecureHandshakeTranscript,
} from '../../src/main/security'
import { calculateIdentityFingerprint, TrustedDevicesStore } from '../../src/main/storage'

const temporaryDirectories: string[] = []
const initiatorDeviceId = deviceIdSchema.parse('11111111-1111-4111-8111-111111111111')
const responderDeviceId = deviceIdSchema.parse('22222222-2222-4222-8222-222222222222')
const peer: DeviceInfo = {
  deviceId: responderDeviceId,
  deviceName: 'Secure peer',
  operatingSystem: 'macos',
  ipAddress: '192.168.1.20',
  servicePort: 53_317,
}

const createDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'lindu-pairing-'))
  temporaryDirectories.push(directory)
  return directory
}

const createIdentity = (): PublicIdentityDto => {
  const { publicKey } = generateKeyPairSync('ed25519')
  const encodedPublicKey = publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
  return publicIdentitySchema.parse({
    algorithm: 'Ed25519',
    publicKey: encodedPublicKey,
    fingerprint: calculateIdentityFingerprint(encodedPublicKey),
  })
}

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  )
})

describe('secure key agreement', () => {
  it('derives the same confirmation key and verification code on both peers', () => {
    const initiatorKeys = generateEphemeralKeyPair()
    const responderKeys = generateEphemeralKeyPair()
    const transcript = serializeSecureHandshakeTranscript({
      initiatorDeviceId,
      responderDeviceId,
      initiatorNonce: generateHandshakeNonce(),
      responderNonce: generateHandshakeNonce(),
      initiatorEphemeralPublicKey: initiatorKeys.publicKey,
      responderEphemeralPublicKey: responderKeys.publicKey,
      initiatorIdentity: createIdentity(),
      responderIdentity: createIdentity(),
    })
    const initiatorSharedSecret = deriveSharedSecret(
      initiatorKeys.privateKey,
      responderKeys.publicKey,
    )
    const responderSharedSecret = deriveSharedSecret(
      responderKeys.privateKey,
      initiatorKeys.publicKey,
    )
    const initiatorConfirmationKey = deriveTranscriptConfirmationKey(
      initiatorSharedSecret,
      transcript,
    )
    const responderConfirmationKey = deriveTranscriptConfirmationKey(
      responderSharedSecret,
      transcript,
    )

    expect(initiatorSharedSecret).toEqual(responderSharedSecret)
    expect(initiatorConfirmationKey).toEqual(responderConfirmationKey)
    expect(createPairingVerificationCode(initiatorConfirmationKey)).toMatch(/^\d{6}$/u)
    expect(createPairingVerificationCode(initiatorConfirmationKey)).toBe(
      createPairingVerificationCode(responderConfirmationKey),
    )
  })

  it('binds confirmation keys to the canonical transcript', () => {
    const keys = generateEphemeralKeyPair()
    const remoteKeys = generateEphemeralKeyPair()
    const identity = createIdentity()
    const remoteIdentity = createIdentity()
    const nonce = generateHandshakeNonce()
    const remoteNonce = generateHandshakeNonce()
    const sharedSecret = deriveSharedSecret(keys.privateKey, remoteKeys.publicKey)
    const base = {
      initiatorDeviceId,
      responderDeviceId,
      initiatorEphemeralPublicKey: keys.publicKey,
      responderEphemeralPublicKey: remoteKeys.publicKey,
      initiatorIdentity: identity,
      responderIdentity: remoteIdentity,
    }
    const first = serializeSecureHandshakeTranscript({
      ...base,
      initiatorNonce: nonce,
      responderNonce: remoteNonce,
    })
    const changed = serializeSecureHandshakeTranscript({
      ...base,
      initiatorNonce: remoteNonce,
      responderNonce: nonce,
    })

    expect(deriveTranscriptConfirmationKey(sharedSecret, first)).not.toEqual(
      deriveTranscriptConfirmationKey(sharedSecret, changed),
    )
  })
})

describe('pairing coordinator', () => {
  it('stores trust only after both peers accept the same pending request', async () => {
    const trustedDevices = new TrustedDevicesStore(await createDirectory())
    const coordinator = new PairingCoordinator(trustedDevices)
    const identity = createIdentity()
    const requests: string[] = []
    const decisions: string[] = []
    const completions: string[] = []
    coordinator.subscribeRequests((request) => requests.push(request.requestId))
    coordinator.subscribeLocalDecisions(({ decision }) => decisions.push(decision))
    coordinator.subscribeCompletions(({ outcome }) => completions.push(outcome))

    const result = coordinator.begin(peer, identity, Buffer.alloc(32, 7))
    expect(result.state).toBe('pairingRequired')
    if (result.state !== 'pairingRequired') throw new Error('Expected a pairing request')
    expect(result.request).not.toHaveProperty('peerIdentity')
    expect(result.request.peerFingerprint).toBe(identity.fingerprint)
    expect(requests).toEqual([result.request.requestId])
    expect(coordinator.respond(result.request.requestId, 'accept')).toBe(true)
    expect(trustedDevices.list()).toEqual([])
    expect(coordinator.confirmPeer(result.request.requestId, 'accept')).toBe(true)

    expect(decisions).toEqual(['accept'])
    expect(completions).toEqual(['paired'])
    expect(coordinator.getPending()).toBeNull()
    expect(trustedDevices.get(peer.deviceId)?.identity).toEqual(identity)
  })

  it('rejects, times out, and never trusts incomplete pairings', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_700_000_000_000)
    const trustedDevices = new TrustedDevicesStore(await createDirectory())
    const coordinator = new PairingCoordinator(trustedDevices)
    const identity = createIdentity()
    const completions: string[] = []
    coordinator.subscribeCompletions(({ outcome }) => completions.push(outcome))

    const rejected = coordinator.begin(peer, identity, Buffer.alloc(32, 1))
    if (rejected.state !== 'pairingRequired') throw new Error('Expected a pairing request')
    coordinator.confirmPeer(rejected.request.requestId, 'reject')
    const expired = coordinator.begin(peer, identity, Buffer.alloc(32, 2))
    expect(expired.state).toBe('pairingRequired')
    await vi.runAllTimersAsync()

    expect(completions).toEqual(['rejected', 'timeout'])
    expect(trustedDevices.list()).toEqual([])
  })

  it('bypasses pairing for the same trusted key and rejects identity replacement', async () => {
    const trustedDevices = new TrustedDevicesStore(await createDirectory())
    const identity = createIdentity()
    trustedDevices.trust(peer.deviceId, identity, 100)
    const coordinator = new PairingCoordinator(trustedDevices)

    expect(coordinator.begin(peer, identity, Buffer.alloc(32, 3)).state).toBe('trusted')
    expect(coordinator.begin(peer, createIdentity(), Buffer.alloc(32, 4))).toEqual({
      state: 'rejected',
      errorCode: 'IDENTITY_MISMATCH',
    })
  })
})

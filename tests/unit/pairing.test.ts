import { generateKeyPairSync } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { publicIdentitySchema } from '@shared/protocols'
import { connectionIdSchema, deviceIdSchema } from '@shared/types'
import type { DeviceInfo, PublicIdentityDto } from '@shared/types'

import { PairingCoordinator } from '../../src/main/pairing'
import {
  createPairingVerificationCode,
  deriveSharedSecret,
  deriveSecureSessionSecrets,
  deriveTranscriptConfirmationKey,
  generateEphemeralKeyPair,
  generateHandshakeNonce,
  serializeSecureHandshakeTranscript,
  SecureSessionCipher,
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

  it('encrypts each direction and rejects tampering and sequence replay', () => {
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
    const initiatorSecrets = deriveSecureSessionSecrets(
      deriveSharedSecret(initiatorKeys.privateKey, responderKeys.publicKey),
      transcript,
      'initiator',
    )
    const responderSecrets = deriveSecureSessionSecrets(
      deriveSharedSecret(responderKeys.privateKey, initiatorKeys.publicKey),
      transcript,
      'responder',
    )
    const connectionId = connectionIdSchema.parse('33333333-3333-4333-8333-333333333333')
    const initiatorCipher = new SecureSessionCipher(connectionId, initiatorSecrets)
    const responderCipher = new SecureSessionCipher(connectionId, responderSecrets)

    const firstEnvelope = initiatorCipher.encrypt({ type: 'example', value: 'secret' })
    expect(responderCipher.decrypt(firstEnvelope)).toEqual({ type: 'example', value: 'secret' })
    expect(() => responderCipher.decrypt(firstEnvelope)).toThrow(/sequence/u)
    const secondEnvelope = initiatorCipher.encrypt({ type: 'second' })
    const tamperedTag = `${secondEnvelope.authenticationTag.startsWith('A') ? 'B' : 'A'}${secondEnvelope.authenticationTag.slice(1)}`
    expect(() =>
      responderCipher.decrypt({ ...secondEnvelope, authenticationTag: tamperedTag }),
    ).toThrow()
    expect(responderCipher.decrypt(secondEnvelope)).toEqual({ type: 'second' })

    const response = responderCipher.encrypt({ type: 'response' })
    expect(initiatorCipher.decrypt(response)).toEqual({ type: 'response' })
    initiatorCipher.destroy()
    responderCipher.destroy()
    expect(() => initiatorCipher.encrypt({ type: 'closed' })).toThrow(/closed/u)
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

    const result = coordinator.begin(peer, identity, Buffer.alloc(32, 7), 'input')
    expect(result.state).toBe('pairingRequired')
    if (result.state !== 'pairingRequired') throw new Error('Expected a pairing request')
    expect(result.request).not.toHaveProperty('peerIdentity')
    expect(result.request.peerFingerprint).toBe(identity.fingerprint)
    expect(requests).toEqual([result.request.requestId])
    expect(
      coordinator.respond(result.request.requestId, {
        decision: 'verify',
        verificationCode: createPairingVerificationCode(Buffer.alloc(32, 7)),
      }),
    ).toBe('accepted')
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

    const rejected = coordinator.begin(peer, identity, Buffer.alloc(32, 1), 'input')
    if (rejected.state !== 'pairingRequired') throw new Error('Expected a pairing request')
    coordinator.confirmPeer(rejected.request.requestId, 'reject')
    const expired = coordinator.begin(peer, identity, Buffer.alloc(32, 2), 'input')
    expect(expired.state).toBe('pairingRequired')
    await vi.runAllTimersAsync()

    expect(completions).toEqual(['rejected', 'timeout'])
    expect(trustedDevices.list()).toEqual([])
  })

  it('keeps an input pairing pending after a typo and rejects repeated invalid codes', async () => {
    const trustedDevices = new TrustedDevicesStore(await createDirectory())
    const coordinator = new PairingCoordinator(trustedDevices)
    const result = coordinator.begin(peer, createIdentity(), Buffer.alloc(32, 8), 'input')
    if (result.state !== 'pairingRequired') throw new Error('Expected a pairing request')
    const expectedCode = createPairingVerificationCode(Buffer.alloc(32, 8))
    const wrongCode = expectedCode === '000000' ? '111111' : '000000'

    expect(
      coordinator.respond(result.request.requestId, {
        decision: 'verify',
        verificationCode: wrongCode,
      }),
    ).toBe('codeInvalid')
    expect(coordinator.getPending()).not.toBeNull()
    for (let attempt = 1; attempt < 5; attempt += 1) {
      coordinator.respond(result.request.requestId, {
        decision: 'verify',
        verificationCode: wrongCode,
      })
    }

    expect(coordinator.getPending()).toBeNull()
    expect(trustedDevices.list()).toEqual([])
  })

  it('does not expose the code to an input renderer and pre-approves the display side', async () => {
    const trustedDevices = new TrustedDevicesStore(await createDirectory())
    const coordinator = new PairingCoordinator(trustedDevices)
    const identity = createIdentity()
    const input = coordinator.begin(peer, identity, Buffer.alloc(32, 9), 'input')
    if (input.state !== 'pairingRequired') throw new Error('Expected an input request')
    expect(input.request).not.toHaveProperty('verificationCode')
    coordinator.cancel()

    const display = coordinator.begin(peer, identity, Buffer.alloc(32, 9), 'display')
    if (display.state !== 'pairingRequired') throw new Error('Expected a display request')
    expect(display.request.verificationMode).toBe('display')
    expect(coordinator.confirmPeer(display.request.requestId, 'accept')).toBe(true)
    expect(trustedDevices.get(peer.deviceId)).not.toBeNull()
  })

  it('bypasses pairing for the same trusted key and rejects identity replacement', async () => {
    const trustedDevices = new TrustedDevicesStore(await createDirectory())
    const identity = createIdentity()
    trustedDevices.trust(peer.deviceId, identity, 100)
    const coordinator = new PairingCoordinator(trustedDevices)

    expect(coordinator.begin(peer, identity, Buffer.alloc(32, 3), 'input').state).toBe('trusted')
    expect(coordinator.begin(peer, createIdentity(), Buffer.alloc(32, 4), 'input')).toEqual({
      state: 'rejected',
      errorCode: 'IDENTITY_MISMATCH',
    })
  })
})

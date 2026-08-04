import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { deviceIdSchema } from '@shared/types'

import {
  IdentityStore,
  SecureStorageUnavailableError,
  TrustedDevicesStore,
  verifyIdentitySignature,
  type SecretProtector,
} from '../../src/main/storage'

class TestSecretProtector implements SecretProtector {
  public constructor(private readonly available = true) {}

  public isEncryptionAvailable(): boolean {
    return this.available
  }

  public encryptString(value: string): Buffer {
    return Buffer.from(`test-protected:${value}`, 'utf8')
  }

  public decryptString(value: Buffer): string {
    const protectedValue = value.toString('utf8')
    if (!protectedValue.startsWith('test-protected:')) throw new Error('Invalid protected value')
    return protectedValue.slice('test-protected:'.length)
  }
}

const temporaryDirectories: string[] = []
const firstDeviceId = deviceIdSchema.parse('11111111-1111-4111-8111-111111111111')
const secondDeviceId = deviceIdSchema.parse('22222222-2222-4222-8222-222222222222')

const createDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'lindu-secure-identity-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  )
})

describe('protected device identity', () => {
  it('keeps one identity and signs verifiable challenges across restarts', async () => {
    const directory = await createDirectory()
    const protector = new TestSecretProtector()
    const first = new IdentityStore(directory, protector)
    const identity = first.getPublicIdentity()
    const challenge = Buffer.from('pairing transcript', 'utf8')
    const signature = first.sign(challenge)
    first.shutdown()

    const second = new IdentityStore(directory, protector)
    expect(second.getPublicIdentity()).toEqual(identity)
    expect(verifyIdentitySignature(identity, challenge, signature)).toBe(true)
    expect(verifyIdentitySignature(identity, Buffer.from('changed'), signature)).toBe(false)
  })

  it('does not create an identity when operating-system protection is unavailable', async () => {
    const directory = await createDirectory()

    expect(() => new IdentityStore(directory, new TestSecretProtector(false))).toThrow(
      SecureStorageUnavailableError,
    )
    await expect(readFile(join(directory, 'identity.json'), 'utf8')).rejects.toThrow()
  })

  it('fails closed when the stored public fingerprint is changed', async () => {
    const directory = await createDirectory()
    const protector = new TestSecretProtector()
    new IdentityStore(directory, protector).shutdown()
    const storePath = join(directory, 'identity.json')
    const stored = JSON.parse(await readFile(storePath, 'utf8')) as {
      identity: { fingerprint: string }
    }
    stored.identity.fingerprint = '0'.repeat(64)
    await writeFile(storePath, JSON.stringify(stored), 'utf8')

    expect(() => new IdentityStore(directory, protector)).toThrow(/fingerprint/u)
  })

  it('fails closed instead of accepting a mismatched private key', async () => {
    const firstDirectory = await createDirectory()
    const secondDirectory = await createDirectory()
    const protector = new TestSecretProtector()
    new IdentityStore(firstDirectory, protector).shutdown()
    new IdentityStore(secondDirectory, protector).shutdown()
    const firstPath = join(firstDirectory, 'identity.json')
    const firstData = JSON.parse(await readFile(firstPath, 'utf8')) as {
      encryptedPrivateKey: string
    }
    const secondData = JSON.parse(
      await readFile(join(secondDirectory, 'identity.json'), 'utf8'),
    ) as {
      encryptedPrivateKey: string
    }
    firstData.encryptedPrivateKey = secondData.encryptedPrivateKey
    await writeFile(firstPath, JSON.stringify(firstData), 'utf8')

    expect(() => new IdentityStore(firstDirectory, protector)).toThrow(/does not match/u)
  })
})

describe('trusted device storage', () => {
  it('persists trust, preserves first-paired time, and updates verification time', async () => {
    const directory = await createDirectory()
    const identityDirectory = await createDirectory()
    const identity = new IdentityStore(
      identityDirectory,
      new TestSecretProtector(),
    ).getPublicIdentity()
    const trustedDevices = new TrustedDevicesStore(directory)

    expect(trustedDevices.trust(firstDeviceId, identity, 100)).toMatchObject({ ok: true })
    expect(trustedDevices.trust(firstDeviceId, identity, 200)).toMatchObject({ ok: true })
    expect(new TrustedDevicesStore(directory).get(firstDeviceId)).toMatchObject({
      firstPairedAt: 100,
      lastVerifiedAt: 200,
      identity,
    })
    expect(new TrustedDevicesStore(directory).listSummaries()[0]).toEqual({
      deviceId: firstDeviceId,
      fingerprint: identity.fingerprint,
      firstPairedAt: 100,
      lastVerifiedAt: 200,
    })
    expect(new TrustedDevicesStore(directory).listSummaries()[0]).not.toHaveProperty('identity')
  })

  it('refuses an identity change without replacing the trusted record', async () => {
    const directory = await createDirectory()
    const firstIdentityDirectory = await createDirectory()
    const secondIdentityDirectory = await createDirectory()
    const protector = new TestSecretProtector()
    const firstIdentity = new IdentityStore(firstIdentityDirectory, protector).getPublicIdentity()
    const secondIdentity = new IdentityStore(secondIdentityDirectory, protector).getPublicIdentity()
    const trustedDevices = new TrustedDevicesStore(directory)
    trustedDevices.trust(firstDeviceId, firstIdentity, 100)

    expect(trustedDevices.trust(firstDeviceId, secondIdentity, 200)).toEqual({
      ok: false,
      errorCode: 'IDENTITY_MISMATCH',
    })
    expect(trustedDevices.get(firstDeviceId)?.identity).toEqual(firstIdentity)
  })

  it('rejects forged fingerprints and supports explicit revocation', async () => {
    const directory = await createDirectory()
    const identityDirectory = await createDirectory()
    const identity = new IdentityStore(
      identityDirectory,
      new TestSecretProtector(),
    ).getPublicIdentity()
    const trustedDevices = new TrustedDevicesStore(directory)

    expect(
      trustedDevices.trust(secondDeviceId, { ...identity, fingerprint: 'f'.repeat(64) }, 100),
    ).toEqual({ ok: false, errorCode: 'SIGNATURE_INVALID' })
    expect(trustedDevices.list()).toEqual([])
    trustedDevices.trust(secondDeviceId, identity, 100)
    expect(trustedDevices.revoke(secondDeviceId)).toBe(true)
    expect(trustedDevices.revoke(secondDeviceId)).toBe(false)
    expect(trustedDevices.list()).toEqual([])
  })
})

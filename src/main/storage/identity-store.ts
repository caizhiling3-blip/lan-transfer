import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  type KeyObject,
  verify,
} from 'node:crypto'

import ElectronStore from 'electron-store'

import { publicIdentitySchema } from '@shared/protocols'
import type { PublicIdentityDto } from '@shared/types'

import { identityStoreSchema, type IdentityStoreData } from './secure-store-schemas'

const privateKeyBase64Pattern = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u

export interface SecretProtector {
  isEncryptionAvailable(): boolean
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}

export class SecureStorageUnavailableError extends Error {
  public constructor() {
    super('Operating system secure storage is unavailable')
    this.name = 'SecureStorageUnavailableError'
  }
}

export const calculateIdentityFingerprint = (publicKey: string): string =>
  createHash('sha256').update(Buffer.from(publicKey, 'base64')).digest('hex')

export const verifyIdentitySignature = (
  identity: PublicIdentityDto,
  data: Uint8Array,
  signature: string,
): boolean => {
  try {
    const key = createPublicKey({
      key: Buffer.from(identity.publicKey, 'base64'),
      format: 'der',
      type: 'spki',
    })
    return key.type === 'public' && key.asymmetricKeyType === 'ed25519'
      ? verify(null, Buffer.from(data), key, Buffer.from(signature, 'base64'))
      : false
  } catch {
    return false
  }
}

export class IdentityStore {
  private readonly store: ElectronStore<IdentityStoreData>
  private privateKey: KeyObject | null = null
  private readonly identity: PublicIdentityDto

  public constructor(
    directory: string,
    private readonly protector: SecretProtector,
  ) {
    if (!protector.isEncryptionAvailable()) throw new SecureStorageUnavailableError()
    this.store = new ElectronStore<IdentityStoreData>({ cwd: directory, name: 'identity' })
    if (this.store.size === 0) this.store.store = this.createIdentityData()
    const data = identityStoreSchema.parse(this.store.store)
    this.identity = publicIdentitySchema.parse(data.identity)
    if (calculateIdentityFingerprint(this.identity.publicKey) !== this.identity.fingerprint) {
      throw new Error('Stored identity fingerprint does not match its public key')
    }
    this.privateKey = this.decryptPrivateKey(data.encryptedPrivateKey)
    const derivedPublicKey = createPublicKey(this.privateKey)
      .export({ format: 'der', type: 'spki' })
      .toString('base64')
    if (derivedPublicKey !== this.identity.publicKey) {
      this.privateKey = null
      throw new Error('Stored identity private key does not match its public key')
    }
  }

  public getPublicIdentity(): PublicIdentityDto {
    return this.identity
  }

  public sign(data: Uint8Array): string {
    if (this.privateKey === null) throw new Error('Identity store has been shut down')
    return sign(null, Buffer.from(data), this.privateKey).toString('base64')
  }

  public shutdown(): void {
    this.privateKey = null
  }

  private createIdentityData(): IdentityStoreData {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    const publicKeyBase64 = publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
    const privateKeyBase64 = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64')
    return identityStoreSchema.parse({
      schemaVersion: 1,
      identity: {
        algorithm: 'Ed25519',
        publicKey: publicKeyBase64,
        fingerprint: calculateIdentityFingerprint(publicKeyBase64),
      },
      encryptedPrivateKey: this.protector.encryptString(privateKeyBase64).toString('base64'),
    })
  }

  private decryptPrivateKey(encryptedPrivateKey: string): KeyObject {
    const privateKeyBase64 = this.protector.decryptString(
      Buffer.from(encryptedPrivateKey, 'base64'),
    )
    if (
      privateKeyBase64.length < 64 ||
      privateKeyBase64.length > 4_096 ||
      !privateKeyBase64Pattern.test(privateKeyBase64)
    ) {
      throw new Error('Decrypted identity private key is invalid')
    }
    const privateKey = createPrivateKey({
      key: Buffer.from(privateKeyBase64, 'base64'),
      format: 'der',
      type: 'pkcs8',
    })
    if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('Identity key must be Ed25519')
    return privateKey
  }
}

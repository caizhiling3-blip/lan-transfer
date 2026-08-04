import { createCipheriv, createDecipheriv } from 'node:crypto'

import { MAX_ENCRYPTED_ENVELOPE_BYTES, SECURE_PROTOCOL_VERSION } from '@shared/constants'
import { encryptedEnvelopeSchema } from '@shared/protocols'
import type { EncryptedEnvelope } from '@shared/protocols'
import type { ConnectionId } from '@shared/types'

import type { SecureSessionSecrets } from './secure-key-agreement'

const AUTHENTICATION_TAG_BYTES = 16
const NONCE_BYTES = 12

export class SecureSequenceError extends Error {
  public constructor() {
    super('Secure message sequence is not the next expected value')
    this.name = 'SecureSequenceError'
  }
}

const createNonce = (prefix: Buffer, sequence: number): Buffer => {
  if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error('Invalid secure sequence')
  const nonce = Buffer.alloc(NONCE_BYTES)
  prefix.copy(nonce, 0)
  nonce.writeBigUInt64BE(BigInt(sequence), 4)
  return nonce
}

const createAdditionalData = (connectionId: ConnectionId, sequence: number): Buffer =>
  Buffer.from(JSON.stringify([SECURE_PROTOCOL_VERSION, connectionId, sequence]), 'utf8')

export class SecureSessionCipher {
  private sendSequence = 0
  private receiveSequence = 0
  private sendKey: Buffer | null
  private receiveKey: Buffer | null
  private readonly sendNoncePrefix: Buffer
  private readonly receiveNoncePrefix: Buffer

  public constructor(
    private readonly connectionId: ConnectionId,
    secrets: SecureSessionSecrets,
  ) {
    this.sendKey = Buffer.from(secrets.sendKey)
    this.receiveKey = Buffer.from(secrets.receiveKey)
    this.sendNoncePrefix = Buffer.from(secrets.sendNoncePrefix)
    this.receiveNoncePrefix = Buffer.from(secrets.receiveNoncePrefix)
  }

  public encrypt(message: unknown): EncryptedEnvelope {
    if (this.sendKey === null) throw new Error('Secure session is closed')
    const plaintext = Buffer.from(JSON.stringify(message), 'utf8')
    if (plaintext.byteLength > MAX_ENCRYPTED_ENVELOPE_BYTES) {
      throw new Error('Secure message is too large')
    }
    const sequence = this.sendSequence
    const cipher = createCipheriv(
      'aes-256-gcm',
      this.sendKey,
      createNonce(this.sendNoncePrefix, sequence),
      { authTagLength: AUTHENTICATION_TAG_BYTES },
    )
    cipher.setAAD(createAdditionalData(this.connectionId, sequence))
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
    const envelope = encryptedEnvelopeSchema.parse({
      version: SECURE_PROTOCOL_VERSION,
      connectionId: this.connectionId,
      sequence,
      ciphertext: ciphertext.toString('base64'),
      authenticationTag: cipher.getAuthTag().toString('base64'),
    })
    this.sendSequence += 1
    return envelope
  }

  public decrypt(input: unknown): unknown {
    if (this.receiveKey === null) throw new Error('Secure session is closed')
    const envelope = encryptedEnvelopeSchema.parse(input)
    if (envelope.connectionId !== this.connectionId) throw new Error('Wrong secure connection')
    if (envelope.sequence !== this.receiveSequence) throw new SecureSequenceError()
    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.receiveKey,
      createNonce(this.receiveNoncePrefix, envelope.sequence),
      { authTagLength: AUTHENTICATION_TAG_BYTES },
    )
    decipher.setAAD(createAdditionalData(this.connectionId, envelope.sequence))
    decipher.setAuthTag(Buffer.from(envelope.authenticationTag, 'base64'))
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
      decipher.final(),
    ])
    this.receiveSequence += 1
    return JSON.parse(plaintext.toString('utf8')) as unknown
  }

  public destroy(): void {
    this.sendKey?.fill(0)
    this.receiveKey?.fill(0)
    this.sendKey = null
    this.receiveKey = null
    this.sendNoncePrefix.fill(0)
    this.receiveNoncePrefix.fill(0)
  }
}

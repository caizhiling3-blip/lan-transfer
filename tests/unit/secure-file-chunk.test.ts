import { describe, expect, it } from 'vitest'

import { FILE_CHUNK_AUTH_TAG_BYTES } from '@shared/constants'
import type { EncryptedChunkDescriptor } from '@shared/protocols'
import { connectionIdSchema, fileIdSchema, transferIdSchema } from '@shared/types'

import { decryptFileChunk, encryptFileChunk } from '../../src/main/security/secure-file-chunk'

const connectionId = connectionIdSchema.parse('11111111-1111-4111-8111-111111111111')
const transferId = transferIdSchema.parse('22222222-2222-4222-8222-222222222222')
const fileId = fileIdSchema.parse('33333333-3333-4333-8333-333333333333')
const fileRootKey = Buffer.alloc(32, 7)
const plaintext = Buffer.from('encrypted file chunk')
const descriptor: EncryptedChunkDescriptor = {
  transferId,
  fileId,
  chunkIndex: 0,
  plaintextOffset: 0,
  plaintextLength: plaintext.byteLength,
  ciphertextLength: plaintext.byteLength + FILE_CHUNK_AUTH_TAG_BYTES,
}

describe('secure file chunks', () => {
  it('encrypts and authenticates a chunk with bound metadata', () => {
    const encrypted = encryptFileChunk(fileRootKey, connectionId, descriptor, plaintext)

    expect(encrypted.includes(plaintext)).toBe(false)
    expect(encrypted).toHaveLength(descriptor.ciphertextLength)
    expect(decryptFileChunk(fileRootKey, connectionId, descriptor, encrypted)).toEqual(plaintext)
  })

  it('rejects ciphertext tampering and cross-index replay', () => {
    const encrypted = encryptFileChunk(fileRootKey, connectionId, descriptor, plaintext)
    const tampered = Buffer.from(encrypted)
    tampered[0] = tampered[0]! ^ 1
    const differentIndex = {
      ...descriptor,
      chunkIndex: 1,
      plaintextOffset: descriptor.plaintextLength,
    }

    expect(() => decryptFileChunk(fileRootKey, connectionId, descriptor, tampered)).toThrow(
      'CHUNK_INVALID',
    )
    expect(() => decryptFileChunk(fileRootKey, connectionId, differentIndex, encrypted)).toThrow(
      'CHUNK_INVALID',
    )
  })

  it('rejects descriptor length mismatches before encryption', () => {
    expect(() =>
      encryptFileChunk(
        fileRootKey,
        connectionId,
        { ...descriptor, ciphertextLength: descriptor.ciphertextLength + 1 },
        plaintext,
      ),
    ).toThrow('CHUNK_INVALID')
  })
})

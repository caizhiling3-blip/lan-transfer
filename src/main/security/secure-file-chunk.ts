import { createCipheriv, createDecipheriv, createHash, hkdfSync } from 'node:crypto'

import { FILE_CHUNK_AUTH_TAG_BYTES, SECURE_PROTOCOL_VERSION } from '@shared/constants'
import { encryptedChunkDescriptorSchema } from '@shared/protocols'
import type { EncryptedChunkDescriptor } from '@shared/protocols'
import type { ConnectionId } from '@shared/types'

const FILE_CHUNK_CONTEXT = 'lindu/v3/file-chunk'
const FILE_CHUNK_KEY_BYTES = 32
const FILE_CHUNK_NONCE_BYTES = 12

const deriveChunkMaterial = (
  fileRootKey: Buffer,
  connectionId: ConnectionId,
  descriptor: EncryptedChunkDescriptor,
): Buffer => {
  if (fileRootKey.byteLength !== 32) throw new Error('Invalid file root key')
  const salt = createHash('sha256')
    .update(JSON.stringify([SECURE_PROTOCOL_VERSION, connectionId]))
    .digest()
  const info = Buffer.from(
    JSON.stringify([
      FILE_CHUNK_CONTEXT,
      descriptor.transferId,
      descriptor.fileId,
      descriptor.chunkIndex,
    ]),
    'utf8',
  )
  return Buffer.from(
    hkdfSync('sha256', fileRootKey, salt, info, FILE_CHUNK_KEY_BYTES + FILE_CHUNK_NONCE_BYTES),
  )
}

const createAdditionalData = (
  connectionId: ConnectionId,
  descriptor: EncryptedChunkDescriptor,
): Buffer =>
  Buffer.from(
    JSON.stringify([
      SECURE_PROTOCOL_VERSION,
      connectionId,
      descriptor.transferId,
      descriptor.fileId,
      descriptor.chunkIndex,
      descriptor.plaintextOffset,
      descriptor.plaintextLength,
    ]),
    'utf8',
  )

export const encryptFileChunk = (
  fileRootKey: Buffer,
  connectionId: ConnectionId,
  inputDescriptor: EncryptedChunkDescriptor,
  plaintext: Buffer,
): Buffer => {
  const descriptor = encryptedChunkDescriptorSchema.parse(inputDescriptor)
  if (
    plaintext.byteLength !== descriptor.plaintextLength ||
    descriptor.ciphertextLength !== plaintext.byteLength + FILE_CHUNK_AUTH_TAG_BYTES
  ) {
    throw new Error('CHUNK_INVALID')
  }
  const material = deriveChunkMaterial(fileRootKey, connectionId, descriptor)
  const key = material.subarray(0, FILE_CHUNK_KEY_BYTES)
  const nonce = material.subarray(FILE_CHUNK_KEY_BYTES)
  try {
    const cipher = createCipheriv('aes-256-gcm', key, nonce, {
      authTagLength: FILE_CHUNK_AUTH_TAG_BYTES,
    })
    cipher.setAAD(createAdditionalData(connectionId, descriptor))
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
    return Buffer.concat([ciphertext, cipher.getAuthTag()])
  } finally {
    material.fill(0)
  }
}

export const decryptFileChunk = (
  fileRootKey: Buffer,
  connectionId: ConnectionId,
  inputDescriptor: EncryptedChunkDescriptor,
  encrypted: Buffer,
): Buffer => {
  const descriptor = encryptedChunkDescriptorSchema.parse(inputDescriptor)
  if (
    encrypted.byteLength !== descriptor.ciphertextLength ||
    encrypted.byteLength !== descriptor.plaintextLength + FILE_CHUNK_AUTH_TAG_BYTES
  ) {
    throw new Error('CHUNK_INVALID')
  }
  const material = deriveChunkMaterial(fileRootKey, connectionId, descriptor)
  const key = material.subarray(0, FILE_CHUNK_KEY_BYTES)
  const nonce = material.subarray(FILE_CHUNK_KEY_BYTES)
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, nonce, {
      authTagLength: FILE_CHUNK_AUTH_TAG_BYTES,
    })
    decipher.setAAD(createAdditionalData(connectionId, descriptor))
    decipher.setAuthTag(encrypted.subarray(-FILE_CHUNK_AUTH_TAG_BYTES))
    return Buffer.concat([
      decipher.update(encrypted.subarray(0, -FILE_CHUNK_AUTH_TAG_BYTES)),
      decipher.final(),
    ])
  } catch {
    throw new Error('CHUNK_INVALID')
  } finally {
    material.fill(0)
  }
}

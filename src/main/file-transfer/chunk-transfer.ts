import { createHmac } from 'node:crypto'
import type { FileHandle } from 'node:fs/promises'
import { open } from 'node:fs/promises'
import type { IncomingMessage } from 'node:http'

import { FILE_CHUNK_AUTH_TAG_BYTES } from '@shared/constants'
import { encryptedChunkDescriptorSchema } from '@shared/protocols'
import type { EncryptedChunkDescriptor } from '@shared/protocols'
import type { FileId, TransferId } from '@shared/types'

interface ChunkedFileMetadata {
  readonly fileId: FileId
  readonly size: number
  readonly chunkSize: number
  readonly chunkCount: number
}

export const createChunkDescriptor = (
  transferId: TransferId,
  file: ChunkedFileMetadata,
  chunkIndex: number,
): EncryptedChunkDescriptor => {
  const plaintextOffset = chunkIndex * file.chunkSize
  const plaintextLength = Math.min(file.chunkSize, file.size - plaintextOffset)
  return encryptedChunkDescriptorSchema.parse({
    transferId,
    fileId: file.fileId,
    chunkIndex,
    plaintextOffset,
    plaintextLength,
    ciphertextLength: plaintextLength + FILE_CHUNK_AUTH_TAG_BYTES,
  })
}

export const deriveChunkUploadToken = (
  authorizationSecret: string,
  transferId: TransferId,
  fileId: FileId,
  chunkIndex: number,
): string =>
  createHmac('sha256', authorizationSecret)
    .update(`${transferId}:${fileId}:${String(chunkIndex)}`)
    .digest('base64url')

export const readFileChunk = async (
  fileHandle: FileHandle,
  descriptor: EncryptedChunkDescriptor,
): Promise<Buffer> => {
  const buffer = Buffer.allocUnsafe(descriptor.plaintextLength)
  let bytesRead = 0
  while (bytesRead < buffer.byteLength) {
    const result = await fileHandle.read(
      buffer,
      bytesRead,
      buffer.byteLength - bytesRead,
      descriptor.plaintextOffset + bytesRead,
    )
    if (result.bytesRead === 0) throw new Error('SOURCE_FILE_CHANGED')
    bytesRead += result.bytesRead
  }
  return buffer
}

export const readEncryptedRequest = (
  request: IncomingMessage,
  expectedLength: number,
): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let receivedBytes = 0
    request.on('data', (chunk: Buffer) => {
      receivedBytes += chunk.byteLength
      if (receivedBytes > expectedLength) {
        request.destroy(new Error('CHUNK_INVALID'))
        return
      }
      chunks.push(chunk)
    })
    request.once('end', () => {
      if (receivedBytes !== expectedLength) reject(new Error('CHUNK_INVALID'))
      else resolve(Buffer.concat(chunks, receivedBytes))
    })
    request.once('aborted', () => reject(new Error('TRANSFER_CANCELLED')))
    request.once('error', reject)
  })

export const writePlaintextChunk = async (
  temporaryPath: string,
  descriptor: EncryptedChunkDescriptor,
  plaintext: Buffer,
): Promise<void> => {
  if (plaintext.byteLength !== descriptor.plaintextLength) throw new Error('CHUNK_INVALID')
  const fileHandle = await open(temporaryPath, 'r+')
  try {
    let writtenBytes = 0
    while (writtenBytes < plaintext.byteLength) {
      const result = await fileHandle.write(
        plaintext,
        writtenBytes,
        plaintext.byteLength - writtenBytes,
        descriptor.plaintextOffset + writtenBytes,
      )
      if (result.bytesWritten === 0) throw new Error('TRANSFER_FAILED')
      writtenBytes += result.bytesWritten
    }
    await fileHandle.sync()
  } finally {
    await fileHandle.close().catch(() => undefined)
  }
}

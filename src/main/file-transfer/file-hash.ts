import { createHash } from 'node:crypto'
import type { Stats } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'

export interface HashableFileSource {
  readonly path: string
  readonly size: number
  readonly identity?: {
    readonly device: number
    readonly inode: number
    readonly modifiedAt: number
  }
}

export const calculateFileSha256 = async (filePath: string): Promise<string> => {
  const fileHandle = await open(filePath, 'r')
  try {
    const hash = createHash('sha256')
    await pipeline(fileHandle.createReadStream({ autoClose: false }), hash)
    return hash.digest('hex')
  } finally {
    await fileHandle.close().catch(() => undefined)
  }
}

const matchesIdentity = (metadata: Stats, source: HashableFileSource): boolean =>
  source.identity === undefined ||
  (metadata.dev === source.identity.device &&
    metadata.ino === source.identity.inode &&
    metadata.mtimeMs === source.identity.modifiedAt)

export const calculateAuthorizedFileSha256 = async (
  source: HashableFileSource,
): Promise<string> => {
  const pathMetadata = await lstat(source.path).catch(() => null)
  if (pathMetadata === null || !pathMetadata.isFile() || pathMetadata.isSymbolicLink()) {
    throw new Error('FILE_NOT_FOUND')
  }

  const fileHandle = await open(source.path, 'r').catch(() => null)
  if (fileHandle === null) throw new Error('FILE_NOT_FOUND')
  try {
    const before = await fileHandle.stat()
    if (
      !before.isFile() ||
      before.dev !== pathMetadata.dev ||
      before.ino !== pathMetadata.ino ||
      before.size !== source.size ||
      !matchesIdentity(before, source)
    ) {
      throw new Error('SOURCE_FILE_CHANGED')
    }

    const hash = createHash('sha256')
    try {
      await pipeline(fileHandle.createReadStream({ autoClose: false }), hash)
    } catch {
      throw new Error('FILE_HASH_FAILED')
    }
    const digest = hash.digest('hex')
    const [after, currentPathMetadata] = await Promise.all([
      fileHandle.stat(),
      lstat(source.path).catch(() => null),
    ])
    if (
      currentPathMetadata === null ||
      currentPathMetadata.isSymbolicLink() ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      currentPathMetadata.dev !== after.dev ||
      currentPathMetadata.ino !== after.ino ||
      currentPathMetadata.size !== after.size ||
      currentPathMetadata.mtimeMs !== after.mtimeMs
    ) {
      throw new Error('SOURCE_FILE_CHANGED')
    }
    return digest
  } finally {
    await fileHandle.close().catch(() => undefined)
  }
}

import { createHash } from 'node:crypto'

import {
  MAX_FOLDER_EMPTY_DIRECTORIES,
  MAX_FOLDER_FILES,
  MAX_FOLDER_MANIFEST_BYTES,
  MAX_FOLDER_MANIFEST_CHUNK_BYTES,
} from '@shared/constants'
import type { FolderManifestContents } from '@shared/types'
import { createPortablePathCollisionKey, parsePortableRelativePath } from '@shared/utils'

export interface FolderManifestOffer {
  readonly displayName: string
  readonly totalSize: number
  readonly fileCount: number
  readonly emptyDirectoryCount: number
  readonly manifestChunkCount: number
  readonly manifestSha256: string
}

export interface FolderManifestChunk {
  readonly files: FolderManifestContents['files']
  readonly emptyDirectories: readonly string[]
}

export const hashFolderManifest = (manifest: FolderManifestContents): string =>
  createHash('sha256').update(JSON.stringify(manifest)).digest('hex')

const assertSorted = (paths: readonly string[]): void => {
  for (let index = 1; index < paths.length; index += 1) {
    const previous = paths[index - 1]
    const current = paths[index]
    if (previous === undefined || current === undefined || previous >= current) {
      throw new Error('PROTOCOL_INVALID')
    }
  }
}

export const assertFolderManifestChunkAllowed = (
  offer: FolderManifestOffer,
  chunks: readonly FolderManifestChunk[],
): void => {
  const latest = chunks.at(-1)
  if (latest === undefined) throw new Error('PROTOCOL_INVALID')
  if (
    Buffer.byteLength(JSON.stringify(latest), 'utf8') > MAX_FOLDER_MANIFEST_CHUNK_BYTES ||
    (latest.files.length === 0 &&
      latest.emptyDirectories.length === 0 &&
      (offer.manifestChunkCount !== 1 || offer.fileCount + offer.emptyDirectoryCount !== 0))
  ) {
    throw new Error('PROTOCOL_INVALID')
  }
  const files = chunks.flatMap((chunk) => chunk.files)
  const emptyDirectories = chunks.flatMap((chunk) => chunk.emptyDirectories)
  const partialManifest: FolderManifestContents = {
    displayName: offer.displayName,
    totalSize: offer.totalSize,
    files,
    emptyDirectories,
  }
  const partialSize = files.reduce((total, file) => total + file.size, 0)
  if (
    files.length > offer.fileCount ||
    files.length > MAX_FOLDER_FILES ||
    emptyDirectories.length > offer.emptyDirectoryCount ||
    emptyDirectories.length > MAX_FOLDER_EMPTY_DIRECTORIES ||
    partialSize > offer.totalSize ||
    Buffer.byteLength(JSON.stringify(partialManifest), 'utf8') > MAX_FOLDER_MANIFEST_BYTES
  ) {
    throw new Error('PROTOCOL_INVALID')
  }
}

export const validateFolderManifest = (
  offer: FolderManifestOffer,
  manifest: FolderManifestContents,
): void => {
  if (
    manifest.files.length !== offer.fileCount ||
    manifest.emptyDirectories.length !== offer.emptyDirectoryCount ||
    manifest.files.reduce((total, file) => total + file.size, 0) !== offer.totalSize ||
    hashFolderManifest(manifest) !== offer.manifestSha256 ||
    Buffer.byteLength(JSON.stringify(manifest), 'utf8') > MAX_FOLDER_MANIFEST_BYTES
  ) {
    throw new Error('PROTOCOL_INVALID')
  }

  assertSorted(manifest.files.map(({ relativePath }) => relativePath))
  assertSorted(manifest.emptyDirectories)
  const pathKeys = new Set<string>()
  const terminalPathKeys = new Set<string>()
  const fileIds = new Set<string>()
  for (const file of manifest.files) {
    if (fileIds.has(file.fileId)) throw new Error('PROTOCOL_INVALID')
    fileIds.add(file.fileId)
    const key = createPortablePathCollisionKey(parsePortableRelativePath(file.relativePath))
    if (pathKeys.has(key)) throw new Error('PROTOCOL_INVALID')
    pathKeys.add(key)
    terminalPathKeys.add(key)
  }
  for (const directory of manifest.emptyDirectories) {
    const key = createPortablePathCollisionKey(parsePortableRelativePath(directory))
    if (pathKeys.has(key)) throw new Error('PROTOCOL_INVALID')
    pathKeys.add(key)
    terminalPathKeys.add(key)
  }
  for (const path of [
    ...manifest.files.map(({ relativePath }) => relativePath),
    ...manifest.emptyDirectories,
  ]) {
    const segments = parsePortableRelativePath(path)
    for (let depth = 1; depth < segments.length; depth += 1) {
      if (terminalPathKeys.has(createPortablePathCollisionKey(segments.slice(0, depth)))) {
        throw new Error('PROTOCOL_INVALID')
      }
    }
  }
}

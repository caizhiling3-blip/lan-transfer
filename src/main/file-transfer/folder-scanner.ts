import { randomUUID } from 'node:crypto'
import { lstat, readdir, realpath } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, sep } from 'node:path'

import {
  FOLDER_SCAN_TIMEOUT_MS,
  MAX_FILE_SIZE_BYTES,
  MAX_FOLDER_DEPTH,
  MAX_FOLDER_EMPTY_DIRECTORIES,
  MAX_FOLDER_FILES,
  MAX_FOLDER_MANIFEST_BYTES,
  MAX_FOLDER_RELATIVE_PATH_BYTES,
  MAX_FOLDER_TOTAL_SIZE_BYTES,
} from '@shared/constants'
import { fileIdSchema } from '@shared/types'
import type { FolderManifestContents, FolderManifestFile } from '@shared/types'
import {
  createPortablePathCollisionKey,
  getUtf8ByteLength,
  normalizePortablePathSegment,
} from '@shared/utils'
import { getMimeType } from './mime-type'

export interface AuthorizedFolderFile {
  readonly path: string
  readonly manifest: FolderManifestFile
  readonly identity: {
    readonly device: number
    readonly inode: number
    readonly modifiedAt: number
  }
}

export interface ScannedFolder {
  readonly rootPath: string
  readonly manifest: FolderManifestContents
  readonly files: readonly AuthorizedFolderFile[]
}

interface ScanFolderOptions {
  readonly maximumFileSize?: number
  readonly now?: () => number
}

const isWithinRoot = (rootPath: string, candidatePath: string): boolean => {
  const relativePath = relative(rootPath, candidatePath)
  return (
    relativePath === '' ||
    (!isAbsolute(relativePath) && relativePath !== '..' && !relativePath.startsWith(`..${sep}`))
  )
}

export const scanFolder = async (
  folderPath: string,
  options: ScanFolderOptions = {},
): Promise<ScannedFolder> => {
  if (!isAbsolute(folderPath)) throw new Error('FOLDER_NOT_FOUND')
  const rootMetadata = await lstat(folderPath).catch(() => null)
  if (rootMetadata === null) throw new Error('FOLDER_NOT_FOUND')
  if (rootMetadata.isSymbolicLink()) throw new Error('FOLDER_SYMLINK_UNSUPPORTED')
  if (!rootMetadata.isDirectory()) throw new Error('FOLDER_NOT_FOUND')

  const rootPath = await realpath(folderPath)
  const currentRootMetadata = await lstat(folderPath)
  const canonicalRootMetadata = await lstat(rootPath)
  if (
    currentRootMetadata.isSymbolicLink() ||
    !currentRootMetadata.isDirectory() ||
    currentRootMetadata.dev !== rootMetadata.dev ||
    currentRootMetadata.ino !== rootMetadata.ino ||
    !canonicalRootMetadata.isDirectory() ||
    canonicalRootMetadata.isSymbolicLink() ||
    canonicalRootMetadata.dev !== currentRootMetadata.dev ||
    canonicalRootMetadata.ino !== currentRootMetadata.ino
  ) {
    throw new Error('FOLDER_SYMLINK_UNSUPPORTED')
  }

  const displayName = normalizePortablePathSegment(basename(rootPath))
  const maximumFileSize = options.maximumFileSize ?? MAX_FILE_SIZE_BYTES
  const now = options.now ?? Date.now
  const startedAt = now()
  const files: AuthorizedFolderFile[] = []
  const emptyDirectories: string[] = []
  const collisionKeys = new Set<string>()
  let totalSize = 0

  const assertWithinTime = (): void => {
    if (now() - startedAt > FOLDER_SCAN_TIMEOUT_MS) throw new Error('FOLDER_SCAN_TIMEOUT')
  }

  const registerPath = (segments: readonly string[]): string => {
    if (segments.length > MAX_FOLDER_DEPTH) throw new Error('FOLDER_DEPTH_EXCEEDED')
    const relativePath = segments.join('/')
    if (getUtf8ByteLength(relativePath) > MAX_FOLDER_RELATIVE_PATH_BYTES) {
      throw new Error('FOLDER_PATH_INVALID')
    }
    const collisionKey = createPortablePathCollisionKey(segments)
    if (collisionKeys.has(collisionKey)) throw new Error('FOLDER_PATH_CONFLICT')
    collisionKeys.add(collisionKey)
    return relativePath
  }

  const walk = async (directoryPath: string, parentSegments: readonly string[]): Promise<void> => {
    assertWithinTime()
    const entries = (await readdir(directoryPath, { withFileTypes: true }))
      .map((entry) => ({ entry, normalizedName: normalizePortablePathSegment(entry.name) }))
      .sort((left, right) =>
        left.normalizedName < right.normalizedName
          ? -1
          : left.normalizedName > right.normalizedName
            ? 1
            : 0,
      )
    if (entries.length === 0 && parentSegments.length > 0) {
      const relativePath = parentSegments.join('/')
      emptyDirectories.push(relativePath)
      if (emptyDirectories.length > MAX_FOLDER_EMPTY_DIRECTORIES) {
        throw new Error('FOLDER_FILE_COUNT_EXCEEDED')
      }
    }

    for (const { entry, normalizedName } of entries) {
      assertWithinTime()
      const segments = [...parentSegments, normalizedName]
      const relativePath = registerPath(segments)
      const entryPath = join(directoryPath, entry.name)
      const metadata = await lstat(entryPath)
      if (metadata.isSymbolicLink()) throw new Error('FOLDER_SYMLINK_UNSUPPORTED')
      const canonicalPath = await realpath(entryPath)
      if (!isWithinRoot(rootPath, canonicalPath)) throw new Error('FOLDER_PATH_INVALID')
      const currentMetadata = await lstat(entryPath)
      if (
        currentMetadata.isSymbolicLink() ||
        currentMetadata.dev !== metadata.dev ||
        currentMetadata.ino !== metadata.ino
      ) {
        throw new Error('FOLDER_SYMLINK_UNSUPPORTED')
      }

      if (metadata.isDirectory()) {
        const canonicalMetadata = await lstat(canonicalPath)
        if (
          !currentMetadata.isDirectory() ||
          !canonicalMetadata.isDirectory() ||
          canonicalMetadata.isSymbolicLink() ||
          canonicalMetadata.dev !== currentMetadata.dev ||
          canonicalMetadata.ino !== currentMetadata.ino
        ) {
          throw new Error('FOLDER_SYMLINK_UNSUPPORTED')
        }
        await walk(canonicalPath, segments)
        continue
      }
      if (!metadata.isFile() || !currentMetadata.isFile()) throw new Error('FOLDER_PATH_INVALID')
      const canonicalMetadata = await lstat(canonicalPath)
      if (
        !canonicalMetadata.isFile() ||
        canonicalMetadata.isSymbolicLink() ||
        canonicalMetadata.dev !== currentMetadata.dev ||
        canonicalMetadata.ino !== currentMetadata.ino
      ) {
        throw new Error('FOLDER_SYMLINK_UNSUPPORTED')
      }
      if (canonicalMetadata.size > maximumFileSize) throw new Error('FILE_TOO_LARGE')
      files.push({
        path: canonicalPath,
        manifest: {
          fileId: fileIdSchema.parse(randomUUID()),
          relativePath,
          size: canonicalMetadata.size,
          mimeType: getMimeType(canonicalPath),
        },
        identity: {
          device: canonicalMetadata.dev,
          inode: canonicalMetadata.ino,
          modifiedAt: canonicalMetadata.mtimeMs,
        },
      })
      if (files.length > MAX_FOLDER_FILES) throw new Error('FOLDER_FILE_COUNT_EXCEEDED')
      totalSize += canonicalMetadata.size
      if (!Number.isSafeInteger(totalSize) || totalSize > MAX_FOLDER_TOTAL_SIZE_BYTES) {
        throw new Error('FOLDER_TOTAL_SIZE_EXCEEDED')
      }
    }
  }

  await walk(rootPath, [])
  files.sort((left, right) =>
    left.manifest.relativePath < right.manifest.relativePath
      ? -1
      : left.manifest.relativePath > right.manifest.relativePath
        ? 1
        : 0,
  )
  emptyDirectories.sort()
  const manifest: FolderManifestContents = {
    displayName,
    totalSize,
    files: files.map((file) => file.manifest),
    emptyDirectories,
  }
  if (Buffer.byteLength(JSON.stringify(manifest), 'utf8') > MAX_FOLDER_MANIFEST_BYTES) {
    throw new Error('FOLDER_MANIFEST_TOO_LARGE')
  }
  return { rootPath, manifest, files }
}

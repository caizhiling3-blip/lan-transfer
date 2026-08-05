import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

import { TEMPORARY_FILE_MAX_AGE_MS } from '@shared/constants'
import type { TransferId } from '@shared/types'

const STAGING_DIRECTORY_PATTERN =
  /^\.lindu-folder-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.part$/iu
const OWNER_MARKER_PATTERN =
  /^\.lindu-transfer-owner-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/iu

export interface FolderArtifactCleanupResult {
  readonly stagingDirectories: number
  readonly incompleteDirectories: number
}

const isNodeError = (error: unknown): error is NodeJS.ErrnoException =>
  error instanceof Error && 'code' in error

const createOwnerMarkerName = (transferId: TransferId): string =>
  `.lindu-transfer-owner-${transferId}`

const createConflictName = (displayName: string, attempt: number): string =>
  attempt === 0 ? displayName : `${displayName} (${String(attempt)})`

const createExclusiveTargetDirectory = async (
  receiveDirectory: string,
  displayName: string,
): Promise<string> => {
  const root = resolve(receiveDirectory)
  for (let attempt = 0; attempt < 10_000; attempt += 1) {
    const target = resolve(root, createConflictName(displayName, attempt))
    if (dirname(target) !== root) throw new Error('FOLDER_PUBLISH_FAILED')
    try {
      await mkdir(target, { mode: 0o700 })
      return target
    } catch (error) {
      if (isNodeError(error) && error.code === 'EEXIST') continue
      throw error
    }
  }
  throw new Error('FOLDER_PUBLISH_FAILED')
}

const cleanupOwnedDirectory = async (
  directoryPath: string,
  transferId: TransferId,
): Promise<void> => {
  const markerPath = resolve(directoryPath, createOwnerMarkerName(transferId))
  const marker = await readFile(markerPath, 'utf8').catch(() => null)
  if (marker !== transferId) return
  await rm(directoryPath, { recursive: true, force: true })
}

export const publishFolderStaging = async (
  stagingRoot: string,
  receiveDirectory: string,
  displayName: string,
  transferId: TransferId,
): Promise<string> => {
  let targetDirectory: string | null = null
  try {
    const entries = await readdir(stagingRoot)
    if (entries.includes(createOwnerMarkerName(transferId))) {
      throw new Error('FOLDER_PUBLISH_FAILED')
    }
    targetDirectory = await createExclusiveTargetDirectory(receiveDirectory, displayName)
    const markerPath = resolve(targetDirectory, createOwnerMarkerName(transferId))
    await writeFile(markerPath, transferId, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    for (const entry of entries) {
      await rename(resolve(stagingRoot, entry), resolve(targetDirectory, entry))
    }
    await rmdir(stagingRoot)
    await unlink(markerPath)
    return targetDirectory
  } catch {
    if (targetDirectory !== null) {
      await cleanupOwnedDirectory(targetDirectory, transferId).catch(() => undefined)
      await rmdir(targetDirectory).catch(() => undefined)
    }
    await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined)
    throw new Error('FOLDER_PUBLISH_FAILED')
  }
}

export const cleanupStaleFolderArtifacts = async (
  receiveDirectory: string,
  now = Date.now(),
  protectedPaths: ReadonlySet<string> = new Set(),
): Promise<FolderArtifactCleanupResult> => {
  let stagingDirectories = 0
  let incompleteDirectories = 0
  const entries = await readdir(receiveDirectory, { withFileTypes: true })
  for (const entry of entries) {
    try {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue
      const directoryPath = resolve(receiveDirectory, entry.name)
      if (protectedPaths.has(directoryPath)) continue
      const metadata = await lstat(directoryPath)
      if (
        metadata.isSymbolicLink() ||
        !metadata.isDirectory() ||
        now - metadata.mtimeMs < TEMPORARY_FILE_MAX_AGE_MS
      ) {
        continue
      }
      if (STAGING_DIRECTORY_PATTERN.test(entry.name)) {
        await rm(directoryPath, { recursive: true, force: true })
        stagingDirectories += 1
        continue
      }
      const markerNames = (await readdir(directoryPath)).filter((name) =>
        OWNER_MARKER_PATTERN.test(name),
      )
      if (markerNames.length !== 1) continue
      const markerName = markerNames[0]
      if (markerName === undefined) continue
      const transferId = OWNER_MARKER_PATTERN.exec(markerName)?.[1]
      if (transferId === undefined) continue
      const markerPath = resolve(directoryPath, markerName)
      const markerMetadata = await lstat(markerPath)
      if (
        markerMetadata.isSymbolicLink() ||
        !markerMetadata.isFile() ||
        now - markerMetadata.mtimeMs < TEMPORARY_FILE_MAX_AGE_MS
      ) {
        continue
      }
      const markerContent = await readFile(markerPath, 'utf8').catch(() => null)
      if (markerContent !== transferId) continue
      await rm(directoryPath, { recursive: true, force: true })
      incompleteDirectories += 1
    } catch {
      continue
    }
  }
  return { stagingDirectories, incompleteDirectories }
}

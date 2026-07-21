import { lstat, link, readdir, unlink } from 'node:fs/promises'
import { basename, dirname, extname, resolve } from 'node:path'

import type { ErrorCode } from '@shared/errors'
import {
  FILE_OPERATION_RETRY_COUNT,
  FILE_OPERATION_RETRY_DELAY_MS,
  TEMPORARY_FILE_MAX_AGE_MS,
} from '@shared/constants'

const isNodeError = (error: unknown): error is NodeJS.ErrnoException =>
  error instanceof Error && 'code' in error

export const mapFileError = (error: unknown): ErrorCode => {
  if (error instanceof Error) {
    if (error.message === 'FILE_NOT_FOUND') return 'FILE_NOT_FOUND'
    if (error.message === 'FILE_TOO_LARGE') return 'FILE_TOO_LARGE'
    if (error.message === 'SAVE_DIRECTORY_INVALID') return 'SAVE_DIRECTORY_INVALID'
    if (error.message === 'DISK_SPACE_INSUFFICIENT') return 'DISK_SPACE_INSUFFICIENT'
    if (error.message === 'TRANSFER_TIMEOUT') return 'TRANSFER_TIMEOUT'
    if (error.message === 'TRANSFER_CANCELLED') return 'TRANSFER_CANCELLED'
  }
  if (isNodeError(error)) {
    if (error.code === 'ENOENT') return 'FILE_NOT_FOUND'
    if (error.code === 'ENOSPC') return 'DISK_SPACE_INSUFFICIENT'
    if (error.code === 'EACCES' || error.code === 'EPERM' || error.code === 'EROFS') {
      return 'SAVE_DIRECTORY_INVALID'
    }
  }
  return 'TRANSFER_FAILED'
}

const createConflictName = (fileName: string, attempt: number): string => {
  if (attempt === 0) return fileName
  const extension = extname(fileName)
  const stem = fileName.slice(0, fileName.length - extension.length)
  return `${stem} (${String(attempt)})${extension}`
}

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))

const isTransientFileLockError = (error: unknown): boolean =>
  isNodeError(error) && ['EBUSY', 'EMFILE', 'ENFILE', 'EPERM'].includes(error.code ?? '')

const TEMPORARY_FILE_PATTERN = /^\.lan-transfer-[0-9a-f-]{36}\.part$/iu

export const cleanupStaleTemporaryFiles = async (
  directoryPath: string,
  now = Date.now(),
): Promise<number> => {
  let removed = 0
  const entries = await readdir(directoryPath, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isFile() || !TEMPORARY_FILE_PATTERN.test(entry.name)) continue
    const filePath = resolve(directoryPath, entry.name)
    const metadata = await lstat(filePath)
    if (metadata.isSymbolicLink() || now - metadata.mtimeMs < TEMPORARY_FILE_MAX_AGE_MS) continue
    await unlink(filePath)
    removed += 1
  }
  return removed
}

export const publishTemporaryFile = async (
  temporaryPath: string,
  directoryPath: string,
  fileName: string,
): Promise<void> => {
  const resolvedDirectory = resolve(directoryPath)
  for (let attempt = 0; attempt < 10_000; attempt += 1) {
    const targetPath = resolve(directoryPath, createConflictName(fileName, attempt))
    if (dirname(targetPath) !== resolvedDirectory || basename(targetPath) === '') {
      throw new Error('SAVE_DIRECTORY_INVALID')
    }
    for (let retry = 0; retry <= FILE_OPERATION_RETRY_COUNT; retry += 1) {
      try {
        await link(temporaryPath, targetPath)
        await unlink(temporaryPath).catch(() => undefined)
        return
      } catch (error) {
        if (isNodeError(error) && error.code === 'EEXIST') break
        if (retry < FILE_OPERATION_RETRY_COUNT && isTransientFileLockError(error)) {
          await delay(FILE_OPERATION_RETRY_DELAY_MS * (retry + 1))
          continue
        }
        throw error
      }
    }
  }
  throw new Error('TRANSFER_FAILED')
}

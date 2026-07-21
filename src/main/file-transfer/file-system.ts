import { link, unlink } from 'node:fs/promises'
import { basename, dirname, extname, resolve } from 'node:path'

import type { ErrorCode } from '@shared/errors'

const isNodeError = (error: unknown): error is NodeJS.ErrnoException =>
  error instanceof Error && 'code' in error

export const mapFileError = (error: unknown): ErrorCode => {
  if (error instanceof Error) {
    if (error.message === 'FILE_NOT_FOUND') return 'FILE_NOT_FOUND'
    if (error.message === 'FILE_TOO_LARGE') return 'FILE_TOO_LARGE'
    if (error.message === 'SAVE_DIRECTORY_INVALID') return 'SAVE_DIRECTORY_INVALID'
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
    try {
      await link(temporaryPath, targetPath)
      await unlink(temporaryPath)
      return
    } catch (error) {
      if (isNodeError(error) && error.code === 'EEXIST') continue
      throw error
    }
  }
  throw new Error('TRANSFER_FAILED')
}

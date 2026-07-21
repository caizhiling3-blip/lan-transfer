import { constants } from 'node:fs'
import { access, lstat, realpath, statfs } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'

import { DISK_SPACE_RESERVE_BYTES } from '@shared/constants'

const isWithin = (parent: string, candidate: string): boolean => {
  const child = relative(parent, candidate)
  return child === '' || (!child.startsWith('..') && !isAbsolute(child))
}

const normalizeForComparison = (path: string): string =>
  process.platform === 'win32' ? path.toLowerCase() : path

const getSystemDirectories = (): readonly string[] => {
  if (process.platform === 'win32') {
    return [process.env.SystemRoot, process.env.ProgramFiles, process.env['ProgramFiles(x86)']]
      .filter((path): path is string => path !== undefined && path !== '')
      .map((path) => resolve(path))
  }
  return [
    '/Applications',
    '/Library',
    '/System',
    '/bin',
    '/etc',
    '/private/etc',
    '/private/var/db',
    '/private/var/root',
    '/private/var/run',
    '/private/var/vm',
    '/sbin',
    '/usr',
  ]
}

export const assertSafeReceiveDirectory = async (
  directoryPath: string,
  protectedDirectories: readonly string[] = [],
): Promise<string> => {
  if (!isAbsolute(directoryPath)) throw new Error('SAVE_DIRECTORY_INVALID')
  const metadata = await lstat(directoryPath)
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error('SAVE_DIRECTORY_INVALID')
  }
  const canonicalPath = await realpath(directoryPath)
  if (dirname(canonicalPath) === canonicalPath) throw new Error('SAVE_DIRECTORY_INVALID')

  const normalizedCandidate = normalizeForComparison(canonicalPath)
  const forbiddenExactDirectories = ['/private', '/var'].map(normalizeForComparison)
  if (forbiddenExactDirectories.includes(normalizedCandidate)) {
    throw new Error('SAVE_DIRECTORY_INVALID')
  }
  const forbidden = await Promise.all(
    [...getSystemDirectories(), ...protectedDirectories].map(async (path) =>
      normalizeForComparison(await realpath(path).catch(() => resolve(path))),
    ),
  )
  if (forbidden.some((path) => isWithin(path, normalizedCandidate))) {
    throw new Error('SAVE_DIRECTORY_INVALID')
  }
  await access(canonicalPath, constants.W_OK)
  return canonicalPath
}

export const assertSufficientDiskSpace = async (
  directoryPath: string,
  requiredBytes: number,
): Promise<void> => {
  if (requiredBytes <= 0) return
  const statistics = await statfs(directoryPath)
  const availableBytes = statistics.bavail * statistics.bsize
  if (availableBytes < requiredBytes + DISK_SPACE_RESERVE_BYTES) {
    throw new Error('DISK_SPACE_INSUFFICIENT')
  }
}

import { mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { TEMPORARY_FILE_MAX_AGE_MS } from '@shared/constants'

import {
  cleanupStaleTemporaryFiles,
  publishTemporaryFile,
} from '../../src/main/file-transfer/file-system'
import {
  assertSafeReceiveDirectory,
  assertSufficientDiskSpace,
} from '../../src/main/security/path-policy'
import { FixedWindowRateLimiter } from '../../src/main/security/rate-limiter'

const temporaryDirectories: string[] = []

const createDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'lan-transfer-security-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  )
})

describe('fixed-window rate limiter', () => {
  it('limits each identity, resets windows and bounds identity storage', () => {
    const limiter = new FixedWindowRateLimiter(2, 100, 2)
    expect(limiter.allow('first', 0)).toBe(true)
    expect(limiter.allow('first', 1)).toBe(true)
    expect(limiter.allow('first', 2)).toBe(false)
    expect(limiter.allow('first', 100)).toBe(true)
    expect(limiter.allow('second', 101)).toBe(true)
    expect(limiter.allow('third', 102)).toBe(true)
    expect(limiter.allow('first', 103)).toBe(true)
  })
})

describe('receive path policy', () => {
  it('accepts a writable real directory and rejects symlinked or protected directories', async () => {
    const parent = await createDirectory()
    const receiveDirectory = join(parent, 'receive')
    const protectedDirectory = join(parent, 'protected')
    const linkedDirectory = join(parent, 'linked')
    await Promise.all([mkdir(receiveDirectory), mkdir(protectedDirectory)])
    await symlink(receiveDirectory, linkedDirectory)

    await expect(assertSafeReceiveDirectory(receiveDirectory)).resolves.toContain('receive')
    await expect(assertSafeReceiveDirectory(linkedDirectory)).rejects.toThrow(
      'SAVE_DIRECTORY_INVALID',
    )
    await expect(
      assertSafeReceiveDirectory(protectedDirectory, [protectedDirectory]),
    ).rejects.toThrow('SAVE_DIRECTORY_INVALID')
  })

  it('rejects a transfer when the requested size cannot fit', async () => {
    const directory = await createDirectory()
    await expect(assertSufficientDiskSpace(directory, Number.MAX_SAFE_INTEGER)).rejects.toThrow(
      'DISK_SPACE_INSUFFICIENT',
    )
  })
})

describe('temporary file lifecycle', () => {
  it('removes only expired transfer part files', async () => {
    const directory = await createDirectory()
    const now = Date.now()
    const stale = join(directory, '.lan-transfer-11111111-1111-4111-8111-111111111111.part')
    const recent = join(directory, '.lan-transfer-22222222-2222-4222-8222-222222222222.part')
    const unrelated = join(directory, 'notes.part')
    await Promise.all([
      writeFile(stale, 'stale'),
      writeFile(recent, 'recent'),
      writeFile(unrelated, 'keep'),
    ])
    const oldDate = new Date(now - TEMPORARY_FILE_MAX_AGE_MS - 1)
    await utimes(stale, oldDate, oldDate)

    await expect(cleanupStaleTemporaryFiles(directory, now)).resolves.toBe(1)
    await expect(readFile(recent, 'utf8')).resolves.toBe('recent')
    await expect(readFile(unrelated, 'utf8')).resolves.toBe('keep')
  })

  it('does not allow a published file to escape the receive directory', async () => {
    const directory = await createDirectory()
    const temporaryPath = join(directory, '.lan-transfer-33333333-3333-4333-8333-333333333333.part')
    await writeFile(temporaryPath, 'safe')

    await expect(publishTemporaryFile(temporaryPath, directory, '../escape.txt')).rejects.toThrow(
      'SAVE_DIRECTORY_INVALID',
    )
  })
})

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { calculateAuthorizedFileSha256 } from '../../src/main/file-transfer/file-hash'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  )
})

describe('authorized file hashing', () => {
  it('calculates a deterministic SHA-256 digest without loading the file into memory', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'lindu-hash-'))
    temporaryDirectories.push(directory)
    const filePath = join(directory, 'content.txt')
    await writeFile(filePath, 'abc')

    await expect(calculateAuthorizedFileSha256({ path: filePath, size: 3 })).resolves.toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })

  it('accepts an empty file and rejects a stale source size', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'lindu-hash-'))
    temporaryDirectories.push(directory)
    const filePath = join(directory, 'empty.bin')
    await writeFile(filePath, '')

    await expect(calculateAuthorizedFileSha256({ path: filePath, size: 0 })).resolves.toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    )
    await expect(calculateAuthorizedFileSha256({ path: filePath, size: 1 })).rejects.toThrow(
      'SOURCE_FILE_CHANGED',
    )
  })
})

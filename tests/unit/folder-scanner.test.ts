import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { scanFolder } from '../../src/main/file-transfer/folder-scanner'
import {
  createPortablePathCollisionKey,
  normalizePortablePathSegment,
} from '../../src/main/security/portable-path'

const temporaryDirectories: string[] = []

const createTemporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'lindu-folder-scan-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  )
})

describe('folder scanner', () => {
  it('creates a deterministic manifest with nested files and empty directories', async () => {
    const root = await createTemporaryDirectory()
    await mkdir(join(root, '资料'))
    await mkdir(join(root, '空目录'))
    await writeFile(join(root, '资料', '说明.txt'), 'hello')
    await writeFile(join(root, 'image.png'), 'png')

    const scanned = await scanFolder(root)

    expect(scanned.manifest.totalSize).toBe(8)
    expect(scanned.manifest.files.map(({ relativePath }) => relativePath)).toEqual([
      'image.png',
      '资料/说明.txt',
    ])
    expect(scanned.manifest.emptyDirectories).toEqual(['空目录'])
    const canonicalRoot = await realpath(root)
    expect(scanned.files.every(({ path }) => path.startsWith(canonicalRoot))).toBe(true)
  })

  it('rejects symbolic links instead of following them', async () => {
    const root = await createTemporaryDirectory()
    const outside = await createTemporaryDirectory()
    await writeFile(join(outside, 'secret.txt'), 'secret')
    await symlink(outside, join(root, 'linked'))

    await expect(scanFolder(root)).rejects.toThrow('FOLDER_SYMLINK_UNSUPPORTED')
  })

  it('rejects paths deeper than the portable limit', async () => {
    const root = await createTemporaryDirectory()
    let current = root
    for (let depth = 0; depth < 21; depth += 1) {
      current = join(current, `d${String(depth)}`)
      await mkdir(current)
    }

    await expect(scanFolder(root)).rejects.toThrow('FOLDER_DEPTH_EXCEEDED')
  })

  it('rejects an encoded relative path longer than the portable limit', async () => {
    const root = await createTemporaryDirectory()
    const first = 'a'.repeat(180)
    const second = 'b'.repeat(180)
    const third = 'c'.repeat(180)
    await mkdir(join(root, first))
    await mkdir(join(root, first, second))
    await writeFile(join(root, first, second, third), 'content')

    await expect(scanFolder(root)).rejects.toThrow('FOLDER_PATH_INVALID')
  })

  it('stops scanning when the bounded deadline expires', async () => {
    const root = await createTemporaryDirectory()
    await writeFile(join(root, 'file.txt'), 'content')
    let callCount = 0
    const now = (): number => (callCount++ === 0 ? 0 : 30_001)

    await expect(scanFolder(root, { now })).rejects.toThrow('FOLDER_SCAN_TIMEOUT')
  })
})

describe('portable folder paths', () => {
  it('normalizes Unicode and creates case-insensitive collision keys', () => {
    expect(normalizePortablePathSegment('e\u0301.txt')).toBe('é.txt')
    expect(createPortablePathCollisionKey(['Folder', 'Report.TXT'])).toBe('folder/report.txt')
  })

  it.each(['..', 'CON', 'name.', 'name ', 'a/b', 'a\\b'])('rejects unsafe segment %s', (name) => {
    expect(() => normalizePortablePathSegment(name)).toThrow('FOLDER_PATH_INVALID')
  })
})

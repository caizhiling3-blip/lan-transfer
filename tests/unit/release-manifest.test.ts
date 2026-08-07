import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { createReleaseManifest } from '../../scripts/create-release-manifest.mjs'
import { verifyReleaseVersion } from '../../scripts/verify-release-version.mjs'

const directories: string[] = []

const createDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'lindu-release-manifest-'))
  directories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })))
})

describe('release audit manifest', () => {
  it('records deterministic artifact hashes without credential material', async () => {
    const root = await createDirectory()
    const input = join(root, 'input')
    const output = join(root, 'output')
    await mkdir(input)
    await mkdir(output)
    await writeFile(join(input, 'Lindu-0.5.0-arm64.dmg'), 'mac artifact')
    await writeFile(join(input, 'Lindu-0.5.0-arm64.zip'), 'mac update artifact')
    await writeFile(join(input, 'latest-mac.yml'), 'version: 0.5.0')
    await writeFile(join(input, 'ignored.txt'), 'secret')

    const manifest = createReleaseManifest(input, output, {
      version: '0.5.0',
      gitCommit: 'a'.repeat(40),
      createdAt: '2026-08-08T00:00:00.000Z',
    })
    expect(manifest.artifacts.map(({ name }) => name)).toEqual([
      'latest-mac.yml',
      'Lindu-0.5.0-arm64.dmg',
      'Lindu-0.5.0-arm64.zip',
    ])
    expect(manifest.artifacts.every(({ sha256 }) => /^[a-f0-9]{64}$/u.test(sha256))).toBe(true)
    const serialized = await readFile(join(output, 'release-manifest.json'), 'utf8')
    expect(serialized).not.toContain('ignored.txt')
    expect(await readFile(join(output, 'SHA256SUMS'), 'utf8')).toContain('Lindu-0.5.0-arm64.dmg')
  })

  it('rejects symlinks anywhere in release input', async () => {
    const root = await createDirectory()
    const input = join(root, 'input')
    const output = join(root, 'output')
    await mkdir(input)
    await mkdir(output)
    await writeFile(join(root, 'outside.exe'), 'outside')
    await symlink(join(root, 'outside.exe'), join(input, 'Lindu.exe'))
    expect(() =>
      createReleaseManifest(input, output, {
        version: '0.5.0',
        gitCommit: 'a'.repeat(40),
        createdAt: '2026-08-08T00:00:00.000Z',
      }),
    ).toThrow('symlinks')
  })

  it('requires the release tag to match package version exactly', () => {
    expect(() => verifyReleaseVersion('v0.5.0', '0.5.0')).not.toThrow()
    expect(() => verifyReleaseVersion('v0.5.1', '0.5.0')).toThrow()
    expect(() => verifyReleaseVersion('0.5.0', '0.5.0')).toThrow()
  })
})

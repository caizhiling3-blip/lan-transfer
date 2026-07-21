import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { FileAccessRegistry } from '../../src/main/file-transfer/file-access-registry'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  )
})

describe('FileAccessRegistry dropped files', () => {
  it('registers real files and replaces their paths with one-time tokens', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'lan-transfer-drop-'))
    temporaryDirectories.push(directory)
    const firstPath = join(directory, 'first.txt')
    const secondPath = join(directory, '第二个.txt')
    await writeFile(firstPath, 'first')
    await writeFile(secondPath, 'second')
    const registry = new FileAccessRegistry(() => directory)

    const selections = await registry.registerDroppedFiles([firstPath, secondPath])

    expect(selections).toHaveLength(2)
    expect(selections.map(({ displayName }) => displayName)).toEqual(['first.txt', '第二个.txt'])
    expect(registry.consumeSource(selections[0]!.selectionToken)?.path).toBe(firstPath)
    expect(registry.consumeSource(selections[0]!.selectionToken)).toBeNull()
  })

  it('rejects a dropped directory', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'lan-transfer-drop-'))
    temporaryDirectories.push(directory)
    const registry = new FileAccessRegistry(() => directory)

    await expect(registry.registerDroppedFiles([directory])).rejects.toThrow('FILE_NOT_FOUND')
  })
})

import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
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
    expect(registry.consumeSource(selections[0]!.selectionToken)?.path).toBe(
      await realpath(firstPath),
    )
    expect(registry.consumeSource(selections[0]!.selectionToken)).toBeNull()
  })

  it('rejects a dropped directory', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'lan-transfer-drop-'))
    temporaryDirectories.push(directory)
    const registry = new FileAccessRegistry(() => directory)

    await expect(registry.registerDroppedFiles([directory])).rejects.toThrow('FILE_NOT_FOUND')
  })

  it('rejects symbolic links instead of following them', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'lan-transfer-drop-'))
    temporaryDirectories.push(directory)
    const targetPath = join(directory, 'target.txt')
    const linkPath = join(directory, 'link.txt')
    await writeFile(targetPath, 'content')
    await symlink(targetPath, linkPath)
    const registry = new FileAccessRegistry(() => directory)

    await expect(registry.registerDroppedFiles([linkPath])).rejects.toThrow('FILE_NOT_FOUND')
  })
})

describe('FileAccessRegistry folders', () => {
  it('claims mixed selections atomically for a long-running queue', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'lan-transfer-folder-queue-'))
    temporaryDirectories.push(directory)
    const filePath = join(directory, 'single.txt')
    const folderPath = join(directory, '资料')
    await writeFile(filePath, 'single')
    await mkdir(folderPath)
    const registry = new FileAccessRegistry(() => directory)
    const selections = await registry.registerDroppedItems([filePath, folderPath])
    const file = selections.find((item) => item.kind === 'file')
    const folder = selections.find((item) => item.kind === 'folder')
    if (file?.kind !== 'file' || folder?.kind !== 'folder') {
      throw new Error('Expected mixed selections')
    }

    expect(
      registry.consumeTransferSelections(
        [file.file.selectionToken],
        [folder.folder.selectionToken],
      ),
    ).toMatchObject({ files: [{ selection: { displayName: 'single.txt' } }], folders: [{}] })
    expect(registry.consumeSource(file.file.selectionToken)).toBeNull()
    expect(registry.consumeFolder(folder.folder.selectionToken)).toBeNull()
  })

  it('does not consume valid selections when a queue token is invalid', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'lan-transfer-folder-queue-'))
    temporaryDirectories.push(directory)
    const filePath = join(directory, 'single.txt')
    await writeFile(filePath, 'single')
    const registry = new FileAccessRegistry(() => directory)
    const [selection] = await registry.registerDroppedFiles([filePath])
    if (selection === undefined) throw new Error('Expected file selection')

    expect(
      registry.consumeTransferSelections([selection.selectionToken], ['missing-token']),
    ).toBeNull()
    expect(registry.consumeSource(selection.selectionToken)).not.toBeNull()
  })

  it('registers a mixed drop without exposing source paths', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'lan-transfer-folder-drop-'))
    temporaryDirectories.push(directory)
    const filePath = join(directory, 'single.txt')
    const folderPath = join(directory, '项目资料')
    await writeFile(filePath, 'single')
    await mkdir(folderPath)
    await writeFile(join(folderPath, 'readme.txt'), 'folder')
    const registry = new FileAccessRegistry(() => directory)

    const selections = await registry.registerDroppedItems([filePath, folderPath])

    expect(selections.map(({ kind }) => kind)).toEqual(['file', 'folder'])
    const folderSelection = selections[1]
    expect(folderSelection?.kind).toBe('folder')
    if (folderSelection?.kind !== 'folder') throw new Error('Expected folder selection')
    expect(folderSelection.folder).toMatchObject({
      displayName: '项目资料',
      fileCount: 1,
      emptyDirectoryCount: 0,
      totalSize: 6,
    })
    expect(JSON.stringify(folderSelection.folder)).not.toContain(folderPath)
    expect(registry.consumeFolder(folderSelection.folder.selectionToken)?.rootPath).toBe(
      await realpath(folderPath),
    )
    expect(registry.consumeFolder(folderSelection.folder.selectionToken)).toBeNull()
  })

  it('does not retain partial authorizations when a mixed drop is invalid', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'lan-transfer-folder-drop-'))
    temporaryDirectories.push(directory)
    const filePath = join(directory, 'single.txt')
    const linkPath = join(directory, 'link')
    await writeFile(filePath, 'single')
    await symlink(filePath, linkPath)
    const registry = new FileAccessRegistry(() => directory)

    await expect(registry.registerDroppedItems([filePath, linkPath])).rejects.toThrow(
      'FOLDER_SYMLINK_UNSUPPORTED',
    )
  })
})

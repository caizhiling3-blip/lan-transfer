import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  cleanupStaleFolderArtifacts,
  publishFolderStaging,
} from '../../src/main/file-transfer/folder-publish'
import { TEMPORARY_FILE_MAX_AGE_MS } from '@shared/constants'
import { transferIdSchema } from '@shared/types'

const temporaryDirectories: string[] = []
const TRANSFER_ID = transferIdSchema.parse('11111111-1111-4111-8111-111111111111')
const OTHER_TRANSFER_ID = transferIdSchema.parse('22222222-2222-4222-8222-222222222222')

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  )
})

describe('folder publishing', () => {
  it('publishes into a conflict-safe directory without changing existing content', async () => {
    const receiveDirectory = await mkdtemp(join(tmpdir(), 'lindu-publish-'))
    temporaryDirectories.push(receiveDirectory)
    const stagingRoot = join(receiveDirectory, `.lindu-folder-${TRANSFER_ID}.part`)
    await mkdir(join(stagingRoot, 'nested'), { recursive: true })
    await writeFile(join(stagingRoot, 'nested', 'file.txt'), 'received')
    await mkdir(join(receiveDirectory, 'Project'))
    await writeFile(join(receiveDirectory, 'Project', 'existing.txt'), 'existing')

    const publishedPath = await publishFolderStaging(
      stagingRoot,
      receiveDirectory,
      'Project',
      TRANSFER_ID,
    )

    expect(publishedPath).toBe(join(receiveDirectory, 'Project (1)'))
    await expect(readFile(join(receiveDirectory, 'Project', 'existing.txt'), 'utf8')).resolves.toBe(
      'existing',
    )
    await expect(readFile(join(publishedPath, 'nested', 'file.txt'), 'utf8')).resolves.toBe(
      'received',
    )
    await expect(stat(stagingRoot)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(
      stat(join(publishedPath, `.lindu-transfer-owner-${TRANSFER_ID}`)),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('removes only stale artifacts with strict names and matching markers', async () => {
    const receiveDirectory = await mkdtemp(join(tmpdir(), 'lindu-cleanup-'))
    temporaryDirectories.push(receiveDirectory)
    const now = Date.now()
    const oldTime = new Date(now - TEMPORARY_FILE_MAX_AGE_MS - 1_000)
    const staleStaging = join(receiveDirectory, `.lindu-folder-${TRANSFER_ID}.part`)
    const recentStaging = join(receiveDirectory, `.lindu-folder-${OTHER_TRANSFER_ID}.part`)
    const invalidStaging = join(receiveDirectory, '.lindu-folder-invalid.part')
    const ownedDirectory = join(receiveDirectory, 'Incomplete')
    const mismatchedDirectory = join(receiveDirectory, 'Keep me')
    await Promise.all([
      mkdir(staleStaging),
      mkdir(recentStaging),
      mkdir(invalidStaging),
      mkdir(ownedDirectory),
      mkdir(mismatchedDirectory),
    ])
    const ownedMarker = join(ownedDirectory, `.lindu-transfer-owner-${TRANSFER_ID}`)
    const mismatchedMarker = join(mismatchedDirectory, `.lindu-transfer-owner-${OTHER_TRANSFER_ID}`)
    await writeFile(ownedMarker, TRANSFER_ID)
    await writeFile(mismatchedMarker, TRANSFER_ID)
    await Promise.all([
      utimes(staleStaging, oldTime, oldTime),
      utimes(invalidStaging, oldTime, oldTime),
      utimes(ownedMarker, oldTime, oldTime),
      utimes(ownedDirectory, oldTime, oldTime),
      utimes(mismatchedMarker, oldTime, oldTime),
      utimes(mismatchedDirectory, oldTime, oldTime),
    ])

    await expect(cleanupStaleFolderArtifacts(receiveDirectory, now)).resolves.toEqual({
      stagingDirectories: 1,
      incompleteDirectories: 1,
    })
    await expect(stat(staleStaging)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(ownedDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(recentStaging)).resolves.toBeDefined()
    await expect(stat(invalidStaging)).resolves.toBeDefined()
    await expect(stat(mismatchedDirectory)).resolves.toBeDefined()
  })

  it('cleans its owned target and staging when publishing fails', async () => {
    const receiveDirectory = await mkdtemp(join(tmpdir(), 'lindu-publish-failure-'))
    temporaryDirectories.push(receiveDirectory)
    const stagingRoot = join(receiveDirectory, `.lindu-folder-${TRANSFER_ID}.part`)
    await mkdir(stagingRoot)
    await writeFile(join(stagingRoot, `.lindu-transfer-owner-${TRANSFER_ID}`), 'conflict')

    await expect(
      publishFolderStaging(stagingRoot, receiveDirectory, 'Project', TRANSFER_ID),
    ).rejects.toThrow('FOLDER_PUBLISH_FAILED')
    await expect(stat(stagingRoot)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(join(receiveDirectory, 'Project'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })
})

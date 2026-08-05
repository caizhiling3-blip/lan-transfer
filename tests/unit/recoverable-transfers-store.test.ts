import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { RESUMABLE_TRANSFER_RETENTION_MS } from '@shared/constants'
import { deviceIdSchema, transferIdSchema } from '@shared/types'

import { RecoverableTransfersStore, type SecretProtector } from '../../src/main/storage'

class TestSecretProtector implements SecretProtector {
  public isEncryptionAvailable(): boolean {
    return true
  }

  public encryptString(value: string): Buffer {
    return Buffer.from(`protected:${value}`, 'utf8')
  }

  public decryptString(value: Buffer): string {
    const protectedValue = value.toString('utf8')
    if (!protectedValue.startsWith('protected:')) throw new Error('Invalid ciphertext')
    return protectedValue.slice('protected:'.length)
  }
}

const directories: string[] = []
const transferId = transferIdSchema.parse('11111111-1111-4111-8111-111111111111')
const peerDeviceId = deviceIdSchema.parse('22222222-2222-4222-8222-222222222222')

const createDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'lindu-recovery-store-'))
  directories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })))
})

describe('recoverable transfer storage', () => {
  it('encrypts sensitive state and restores it across store instances', async () => {
    const directory = await createDirectory()
    const protector = new TestSecretProtector()
    const sourcePath = join(directory, 'private-source.txt')
    const store = new RecoverableTransfersStore(directory, protector)
    store.save(
      {
        transferId,
        peerDeviceId,
        kind: 'file',
        direction: 'send',
        payload: { sourcePath, verifiedChunks: [0, 2] },
      },
      1_000,
    )

    const rawStore = await readFile(join(directory, 'recoverable-transfers.json'), 'utf8')
    expect(rawStore).not.toContain(sourcePath)
    expect(new RecoverableTransfersStore(directory, protector).load(2_000)).toEqual([
      expect.objectContaining({
        transferId,
        peerDeviceId,
        payload: { sourcePath, verifiedChunks: [0, 2] },
        expiresAt: 1_000 + RESUMABLE_TRANSFER_RETENTION_MS,
      }),
    ])
  })

  it('drops a record whose protected payload cannot be decrypted', async () => {
    const directory = await createDirectory()
    const protector = new TestSecretProtector()
    const store = new RecoverableTransfersStore(directory, protector)
    store.save({ transferId, peerDeviceId, kind: 'file', direction: 'send', payload: {} }, 1_000)
    const path = join(directory, 'recoverable-transfers.json')
    const data = JSON.parse(await readFile(path, 'utf8')) as {
      records: { encryptedPayload: string }[]
    }
    data.records[0]!.encryptedPayload = Buffer.alloc(32, 0x7f).toString('base64')
    await writeFile(path, JSON.stringify(data), 'utf8')

    const restored = new RecoverableTransfersStore(directory, protector)
    expect(restored.load(2_000)).toEqual([])
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ records: [] })
  })

  it('removes only an expired staging path bearing the matching ownership name', async () => {
    const directory = await createDirectory()
    const ownedPath = join(directory, `.lindu-folder-${transferId}.part`)
    const unrelatedPath = join(directory, 'important-folder')
    await mkdir(ownedPath)
    await mkdir(unrelatedPath)
    const store = new RecoverableTransfersStore(directory, new TestSecretProtector())
    store.save(
      {
        transferId,
        peerDeviceId,
        kind: 'folder',
        direction: 'receive',
        payload: {},
        stagingPaths: [ownedPath],
      },
      1_000,
    )
    const otherTransferId = transferIdSchema.parse('33333333-3333-4333-8333-333333333333')
    store.save(
      {
        transferId: otherTransferId,
        peerDeviceId,
        kind: 'folder',
        direction: 'receive',
        payload: {},
        stagingPaths: [unrelatedPath],
      },
      1_000,
    )

    await expect(store.pruneExpired(1_001 + RESUMABLE_TRANSFER_RETENTION_MS)).resolves.toBe(2)
    await expect(stat(ownedPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(unrelatedPath)).resolves.toBeDefined()
  })
})

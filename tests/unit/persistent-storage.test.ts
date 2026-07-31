import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { MAX_HISTORY_TEXT_PREVIEW_LENGTH } from '@shared/constants'
import { deviceIdSchema } from '@shared/types'
import type { DeviceInfo } from '@shared/types'

import {
  HistoryStore,
  RecentDevicesStore,
  SessionHistory,
  SettingsStore,
} from '../../src/main/storage'

const temporaryDirectories: string[] = []
const peer: DeviceInfo = {
  deviceId: deviceIdSchema.parse('22222222-2222-4222-8222-222222222222'),
  deviceName: 'Peer',
  operatingSystem: 'windows',
  ipAddress: '192.168.1.2',
  servicePort: 53_317,
}

const createDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'lan-transfer-storage-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  )
})

describe('persistent application storage', () => {
  it('keeps the device ID and settings stable across store instances', async () => {
    const directory = await createDirectory()
    const first = new SettingsStore(directory, 'First name', '/downloads')
    const deviceId = first.getDeviceId()
    first.update({ deviceName: 'My device', servicePort: 54_321, historyLimit: 200 })

    const second = new SettingsStore(directory, 'Ignored name', '/ignored')
    expect(second.getDeviceId()).toBe(deviceId)
    expect(second.getSettings()).toMatchObject({
      deviceName: 'My device',
      receiveDirectoryDisplayPath: '/downloads',
      servicePort: 54_321,
      historyLimit: 200,
      historyRetentionDays: null,
      logRetentionDays: 30,
    })
  })

  it('migrates version 1 settings without deleting existing values', async () => {
    const directory = await createDirectory()
    await writeFile(
      join(directory, 'settings.json'),
      JSON.stringify({
        schemaVersion: 1,
        deviceId: '11111111-1111-4111-8111-111111111111',
        deviceName: 'Legacy device',
        receiveDirectory: '/legacy-downloads',
        servicePort: 54_321,
        maxFileSizeBytes: 1_024,
        historyLimit: 250,
      }),
      'utf8',
    )

    const settings = new SettingsStore(directory, 'Ignored', '/ignored').getSettings()
    expect(settings).toMatchObject({
      deviceName: 'Legacy device',
      receiveDirectoryDisplayPath: '/legacy-downloads',
      historyRetentionDays: null,
      logRetentionDays: 30,
    })
    const stored = JSON.parse(await readFile(join(directory, 'settings.json'), 'utf8')) as {
      schemaVersion: number
    }
    expect(stored.schemaVersion).toBe(2)
    expect((await readdir(directory)).some((file) => file.includes('.invalid-'))).toBe(false)
  })

  it('persists bounded history and stores only a short text preview', async () => {
    const directory = await createDirectory()
    const persistentStore = new HistoryStore(directory)
    let limit = 2
    const history = new SessionHistory(
      () => limit,
      persistentStore.load(),
      (entries) => persistentStore.save(entries),
    )
    for (const content of ['first', 'second', 'x'.repeat(1_000)]) {
      history.add({
        direction: 'send',
        kind: 'text',
        peer,
        status: 'completed',
        textPreview: content,
        createdAt: Date.now(),
      })
    }

    const reloaded = new SessionHistory(limit, new HistoryStore(directory).load())
    expect(reloaded.list({ offset: 0, limit: 100 })).toHaveLength(2)
    expect(reloaded.list({ offset: 0, limit: 1 })[0]?.textPreview).toHaveLength(
      MAX_HISTORY_TEXT_PREVIEW_LENGTH,
    )

    limit = 1
    history.trimToLimit()
    expect(new HistoryStore(directory).load()).toHaveLength(1)
  })

  it('deduplicates recent peers and keeps the latest address', async () => {
    const directory = await createDirectory()
    const recentDevices = new RecentDevicesStore(directory)
    recentDevices.add(peer)
    recentDevices.add({ ...peer, ipAddress: '192.168.1.9' })

    expect(new RecentDevicesStore(directory).list()).toHaveLength(1)
    expect(new RecentDevicesStore(directory).list()[0]?.device.ipAddress).toBe('192.168.1.9')
  })

  it('updates aliases and removes recent devices without changing trust state', async () => {
    const directory = await createDirectory()
    const recentDevices = new RecentDevicesStore(directory)
    recentDevices.add(peer)

    expect(recentDevices.updateAlias(peer.deviceId, 'Office PC')[0]?.alias).toBe('Office PC')
    expect(recentDevices.updateAlias(peer.deviceId, null)[0]?.alias).toBeUndefined()
    expect(recentDevices.remove(peer.deviceId)).toEqual([])
    recentDevices.add(peer)
    recentDevices.clear()
    expect(recentDevices.list()).toEqual([])
  })

  it('migrates version 1 recent devices and preserves a local alias on address updates', async () => {
    const directory = await createDirectory()
    await writeFile(
      join(directory, 'recent-devices.json'),
      JSON.stringify({ schemaVersion: 1, devices: [{ device: peer, lastConnectedAt: 1 }] }),
      'utf8',
    )
    new RecentDevicesStore(directory)
    const migrated = JSON.parse(await readFile(join(directory, 'recent-devices.json'), 'utf8')) as {
      schemaVersion: number
      devices: Array<{ device: DeviceInfo; lastConnectedAt: number; alias?: string }>
    }
    migrated.devices[0] = { ...migrated.devices[0]!, alias: 'Office PC' }
    await writeFile(join(directory, 'recent-devices.json'), JSON.stringify(migrated), 'utf8')

    const recentDevices = new RecentDevicesStore(directory)
    recentDevices.add({ ...peer, ipAddress: '192.168.1.10' })
    expect(recentDevices.list()[0]).toMatchObject({
      alias: 'Office PC',
      device: { ipAddress: '192.168.1.10' },
    })
    expect(migrated.schemaVersion).toBe(2)
  })

  it('backs up invalid settings before restoring safe defaults', async () => {
    const directory = await createDirectory()
    await writeFile(join(directory, 'settings.json'), '{"servicePort":"invalid"}', 'utf8')

    const store = new SettingsStore(directory, 'Recovered', '/downloads')
    expect(store.getSettings().deviceName).toBe('Recovered')
    const files = await readdir(directory)
    const backupName = files.find((file) => file.startsWith('settings.json.invalid-'))
    expect(backupName).toBeDefined()
    await expect(readFile(join(directory, backupName ?? ''), 'utf8')).resolves.toContain('invalid')
  })
})

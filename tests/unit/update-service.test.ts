import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { AppUpdater, UpdateCheckResult, UpdateInfo } from 'electron-updater'
import { afterEach, describe, expect, it } from 'vitest'

import { UpdateSettingsStore } from '../../src/main/storage'
import {
  AUTOMATIC_UPDATE_CHECK_INTERVAL_MS,
  INITIAL_UPDATE_CHECK_DELAY_MS,
  UpdateService,
} from '../../src/main/update'

const directories: string[] = []

const createDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'lindu-update-'))
  directories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })))
})

const createUpdateInfo = (version = '0.5.0'): UpdateInfo => ({
  version,
  files: [{ url: 'https://github.com/private-artifact', sha512: 'secret-hash' }],
  path: 'private-installer.exe',
  sha512: 'secret-hash',
  releaseNotes: 'Changes: https://github.com/private-release',
  releaseDate: '2026-08-08T00:00:00.000Z',
})

class FakeUpdater extends EventEmitter {
  public autoDownload = true
  public autoInstallOnAppQuit = true
  public allowPrerelease = true
  public allowDowngrade = true
  public disableWebInstaller = false
  public requestHeaders: Record<string, string> | null = { Authorization: 'secret' }
  public logger: object | null = {}
  public feed: unknown = null
  public checkResult: UpdateCheckResult | null = null

  public setFeedURL(feed: unknown): void {
    this.feed = feed
  }

  public async checkForUpdates(): Promise<UpdateCheckResult | null> {
    return this.checkResult
  }

  public async downloadUpdate(): Promise<string[]> {
    const info = this.checkResult?.updateInfo ?? createUpdateInfo()
    this.emit('download-progress', { percent: 50 })
    this.emit('update-downloaded', info)
    return ['/private/installer']
  }
}

const asUpdater = (updater: FakeUpdater): AppUpdater => updater as unknown as AppUpdater

describe('UpdateService', () => {
  it('locks updater behavior to the public stable GitHub provider', async () => {
    const updater = new FakeUpdater()
    const service = new UpdateService(
      asUpdater(updater),
      '0.4.0',
      new UpdateSettingsStore(await createDirectory()),
    )

    expect(service.getStatus()).toMatchObject({ state: 'idle', currentVersion: '0.4.0' })
    expect(updater.feed).toEqual({
      provider: 'github',
      owner: 'caizhiling3-blip',
      repo: 'lan-transfer',
      private: false,
    })
    expect(updater).toMatchObject({
      autoDownload: false,
      autoInstallOnAppQuit: false,
      allowPrerelease: false,
      allowDowngrade: false,
      disableWebInstaller: true,
      requestHeaders: null,
      logger: null,
    })
  })

  it('projects only bounded public update metadata and hides links', async () => {
    const updater = new FakeUpdater()
    updater.checkResult = {
      isUpdateAvailable: true,
      updateInfo: createUpdateInfo(),
      versionInfo: createUpdateInfo(),
    }
    const service = new UpdateService(
      asUpdater(updater),
      '0.4.0',
      new UpdateSettingsStore(await createDirectory()),
      () => 123_456,
    )

    const available = await service.checkForUpdates()
    expect(available).toMatchObject({
      state: 'available',
      checkedAt: 123_456,
      availableUpdate: { version: '0.5.0', releaseNotes: 'Changes: [链接已隐藏]' },
    })
    expect(JSON.stringify(available)).not.toContain('private-artifact')
    expect(JSON.stringify(available)).not.toContain('secret-hash')

    const downloaded = await service.downloadUpdate()
    expect(downloaded).toMatchObject({
      state: 'downloaded',
      downloadProgress: 100,
      canInstall: false,
    })
  })

  it('fails closed on non-stable or malformed provider metadata', async () => {
    const updater = new FakeUpdater()
    updater.checkResult = {
      isUpdateAvailable: true,
      updateInfo: createUpdateInfo('0.5.0-beta.1'),
      versionInfo: createUpdateInfo('0.5.0-beta.1'),
    }
    const service = new UpdateService(
      asUpdater(updater),
      '0.4.0',
      new UpdateSettingsStore(await createDirectory()),
    )
    await expect(service.checkForUpdates()).resolves.toMatchObject({
      state: 'error',
      errorCode: 'UPDATE_METADATA_INVALID',
    })
  })

  it('schedules automatic checks no more than once per day', async () => {
    const settings = new UpdateSettingsStore(await createDirectory())
    settings.recordAutomaticCheck(1_000)
    const delays: number[] = []
    const service = new UpdateService(
      asUpdater(new FakeUpdater()),
      '0.4.0',
      settings,
      () => 2_000,
      {
        setTimeout: (_callback, delay) => {
          delays.push(delay)
          return {} as ReturnType<typeof setTimeout>
        },
        clearTimeout: () => undefined,
      },
    )
    service.startAutomaticChecks()
    expect(delays).toEqual([AUTOMATIC_UPDATE_CHECK_INTERVAL_MS - 1_000])

    settings.recordAutomaticCheck(0)
    const immediate: number[] = []
    const second = new UpdateService(
      asUpdater(new FakeUpdater()),
      '0.4.0',
      settings,
      () => AUTOMATIC_UPDATE_CHECK_INTERVAL_MS + 1,
      {
        setTimeout: (_callback, delay) => {
          immediate.push(delay)
          return {} as ReturnType<typeof setTimeout>
        },
        clearTimeout: () => undefined,
      },
    )
    second.startAutomaticChecks()
    expect(immediate).toEqual([INITIAL_UPDATE_CHECK_DELAY_MS])
  })
})

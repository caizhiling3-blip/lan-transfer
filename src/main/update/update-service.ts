import { CancellationToken } from 'electron-updater'
import type { AppUpdater, ProgressInfo, UpdateInfo } from 'electron-updater'

import { updateReleaseInfoSchema, updateStatusSchema } from '@shared/types'
import type { UpdateReleaseInfoDto, UpdateStatusDto } from '@shared/types'

import type { UpdateSettingsStore } from '../storage'

export const AUTOMATIC_UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1_000
export const INITIAL_UPDATE_CHECK_DELAY_MS = 30_000

const FIXED_GITHUB_PROVIDER = {
  provider: 'github' as const,
  owner: 'caizhiling3-blip',
  repo: 'lan-transfer',
  private: false,
}

type UpdateListener = (status: UpdateStatusDto) => void
type TimerHandle = ReturnType<typeof setTimeout>

export interface UpdateScheduler {
  setTimeout(callback: () => void, delay: number): TimerHandle
  clearTimeout(handle: TimerHandle): void
}

const defaultScheduler: UpdateScheduler = {
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: (handle) => clearTimeout(handle),
}

const sanitizeReleaseNotes = (notes: UpdateInfo['releaseNotes']): string | undefined => {
  if (notes === null || notes === undefined) return undefined
  const raw = Array.isArray(notes)
    ? notes.map(({ version, note }) => `${version}: ${note ?? ''}`).join('\n')
    : notes
  const sanitized = raw
    .replace(/https?:\/\/\S+/giu, '[链接已隐藏]')
    .split('')
    .filter((character) => {
      const code = character.charCodeAt(0)
      return (code >= 32 && code !== 127) || code === 9 || code === 10 || code === 13
    })
    .join('')
    .trim()
    .slice(0, 8_192)
  return sanitized === '' ? undefined : sanitized
}

export const projectUpdateInfo = (info: UpdateInfo): UpdateReleaseInfoDto => {
  const releaseNotes = sanitizeReleaseNotes(info.releaseNotes)
  const publishedAt = Date.parse(info.releaseDate)
  return updateReleaseInfoSchema.parse({
    version: info.version,
    ...(releaseNotes === undefined ? {} : { releaseNotes }),
    ...(Number.isFinite(publishedAt) && publishedAt >= 0 ? { publishedAt } : {}),
  })
}

export class UpdateService {
  private status: UpdateStatusDto
  private readonly listeners = new Set<UpdateListener>()
  private timer: TimerHandle | null = null
  private cancellationToken: CancellationToken | null = null

  public constructor(
    private readonly updater: AppUpdater,
    currentVersion: string,
    private readonly settings: UpdateSettingsStore,
    private readonly now: () => number = Date.now,
    private readonly scheduler: UpdateScheduler = defaultScheduler,
  ) {
    this.status = updateStatusSchema.parse({
      state: 'idle',
      currentVersion,
      canInstall: false,
    })
    updater.autoDownload = false
    updater.autoInstallOnAppQuit = false
    updater.allowPrerelease = false
    updater.allowDowngrade = false
    updater.disableWebInstaller = true
    updater.requestHeaders = null
    updater.logger = null
    updater.setFeedURL(FIXED_GITHUB_PROVIDER)
    updater.on('download-progress', (progress) => this.onDownloadProgress(progress))
    updater.on('update-downloaded', (info) => this.onUpdateDownloaded(info))
    updater.on('error', () => this.onUpdaterError())
  }

  public getStatus(): UpdateStatusDto {
    return this.status
  }

  public subscribe(listener: UpdateListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  public startAutomaticChecks(): void {
    this.stopAutomaticChecks()
    if (!this.settings.getSettings().automaticChecksEnabled) return
    const lastCheck = this.settings.getLastAutomaticCheckAt()
    const elapsed = lastCheck === null ? Number.POSITIVE_INFINITY : this.now() - lastCheck
    const delay =
      elapsed >= AUTOMATIC_UPDATE_CHECK_INTERVAL_MS
        ? INITIAL_UPDATE_CHECK_DELAY_MS
        : AUTOMATIC_UPDATE_CHECK_INTERVAL_MS - elapsed
    this.timer = this.scheduler.setTimeout(() => void this.runAutomaticCheck(), delay)
  }

  public stopAutomaticChecks(): void {
    if (this.timer !== null) this.scheduler.clearTimeout(this.timer)
    this.timer = null
  }

  public async checkForUpdates(): Promise<UpdateStatusDto> {
    return this.check(true)
  }

  public async downloadUpdate(): Promise<UpdateStatusDto> {
    if (this.status.state !== 'available') return this.status
    const availableUpdate = this.status.availableUpdate
    this.setStatus({
      state: 'downloading',
      currentVersion: this.status.currentVersion,
      checkedAt: this.status.checkedAt,
      availableUpdate,
      downloadProgress: 0,
      canInstall: false,
    })
    const cancellationToken = new CancellationToken()
    this.cancellationToken = cancellationToken
    try {
      await this.updater.downloadUpdate(cancellationToken)
    } catch {
      if (cancellationToken.cancelled) {
        this.setStatus({
          state: 'available',
          currentVersion: this.status.currentVersion,
          checkedAt: this.status.checkedAt,
          availableUpdate,
          canInstall: false,
        })
      } else {
        this.setError('UPDATE_DOWNLOAD_FAILED')
      }
    } finally {
      if (this.cancellationToken === cancellationToken) this.cancellationToken = null
    }
    return this.status
  }

  public cancelDownload(): UpdateStatusDto {
    this.cancellationToken?.cancel()
    return this.status
  }

  private async runAutomaticCheck(): Promise<void> {
    this.timer = null
    await this.check(false)
    this.startAutomaticChecks()
  }

  private async check(manual: boolean): Promise<UpdateStatusDto> {
    if (this.status.state === 'checking' || this.status.state === 'downloading') return this.status
    const currentVersion = this.status.currentVersion
    this.setStatus({ state: 'checking', currentVersion, canInstall: false })
    const checkedAt = this.now()
    if (!manual) this.settings.recordAutomaticCheck(checkedAt)
    try {
      const result = await this.updater.checkForUpdates()
      if (result === null || !result.isUpdateAvailable) {
        this.setStatus({
          state: 'not-available',
          currentVersion,
          checkedAt,
          canInstall: false,
        })
      } else {
        this.setStatus({
          state: 'available',
          currentVersion,
          checkedAt,
          availableUpdate: projectUpdateInfo(result.updateInfo),
          canInstall: false,
        })
      }
    } catch (error) {
      this.setError(
        error instanceof Error && error.name === 'ZodError'
          ? 'UPDATE_METADATA_INVALID'
          : 'UPDATE_CHECK_FAILED',
      )
    }
    return this.status
  }

  private onDownloadProgress(progress: ProgressInfo): void {
    if (this.status.state !== 'downloading') return
    this.setStatus({
      ...this.status,
      downloadProgress: Math.max(0, Math.min(100, progress.percent)),
    })
  }

  private onUpdateDownloaded(info: UpdateInfo): void {
    if (this.status.state !== 'downloading') return
    try {
      this.setStatus({
        state: 'downloaded',
        currentVersion: this.status.currentVersion,
        checkedAt: this.status.checkedAt,
        availableUpdate: projectUpdateInfo(info),
        downloadProgress: 100,
        canInstall: false,
      })
    } catch {
      this.setError('UPDATE_METADATA_INVALID')
    }
  }

  private onUpdaterError(): void {
    this.setError(
      this.status.state === 'downloading' ? 'UPDATE_DOWNLOAD_FAILED' : 'UPDATE_CHECK_FAILED',
    )
  }

  private setError(errorCode: Extract<UpdateStatusDto, { state: 'error' }>['errorCode']): void {
    this.setStatus({
      state: 'error',
      currentVersion: this.status.currentVersion,
      checkedAt: this.status.checkedAt,
      errorCode,
      canInstall: false,
    })
  }

  private setStatus(status: UpdateStatusDto): void {
    this.status = updateStatusSchema.parse(status)
    for (const listener of this.listeners) listener(this.status)
  }
}

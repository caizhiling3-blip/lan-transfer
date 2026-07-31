import { lstat, readdir, unlink } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'

import type { LogStatsDto } from '@shared/types'

const MILLISECONDS_PER_DAY = 86_400_000
const KNOWN_LOG_FILE_NAME = /^main(?:\.(?:old|\d+))?\.log$/u

interface KnownLogFile {
  readonly path: string
  readonly size: number
  readonly modifiedAt: number
}

export class LogLifecycle {
  public constructor(
    private readonly logDirectory: string,
    private readonly getActiveLogPath: () => string,
  ) {}

  public async getStats(): Promise<LogStatsDto> {
    const files = await this.listKnownLogFiles()
    const oldest = files.reduce<number | undefined>(
      (value, file) => (value === undefined ? file.modifiedAt : Math.min(value, file.modifiedAt)),
      undefined,
    )
    return {
      fileCount: files.length,
      storageBytes: files.reduce((total, file) => total + file.size, 0),
      ...(oldest === undefined ? {} : { oldestEntryAt: oldest }),
    }
  }

  public async clearInactiveLogs(): Promise<number> {
    const activePath = resolve(this.getActiveLogPath())
    return this.removeFiles((file) => resolve(file.path) !== activePath)
  }

  public async cleanupExpired(retentionDays: number): Promise<number> {
    const activePath = resolve(this.getActiveLogPath())
    const cutoff = Date.now() - retentionDays * MILLISECONDS_PER_DAY
    return this.removeFiles((file) => resolve(file.path) !== activePath && file.modifiedAt < cutoff)
  }

  private async removeFiles(predicate: (file: KnownLogFile) => boolean): Promise<number> {
    const files = await this.listKnownLogFiles()
    let removed = 0
    for (const file of files) {
      if (!predicate(file)) continue
      try {
        await unlink(file.path)
        removed += 1
      } catch {
        // A locked or concurrently rotated file remains available for a later cleanup.
      }
    }
    return removed
  }

  private async listKnownLogFiles(): Promise<KnownLogFile[]> {
    let names: string[]
    try {
      names = await readdir(this.logDirectory)
    } catch {
      return []
    }
    const files: KnownLogFile[] = []
    for (const name of names) {
      if (basename(name) !== name || !KNOWN_LOG_FILE_NAME.test(name)) continue
      const path = join(this.logDirectory, name)
      try {
        const stats = await lstat(path)
        if (!stats.isFile() || stats.isSymbolicLink()) continue
        files.push({ path, size: stats.size, modifiedAt: stats.mtimeMs })
      } catch {
        // Files may rotate while stats are collected.
      }
    }
    return files
  }
}

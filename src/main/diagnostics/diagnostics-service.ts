import { randomUUID } from 'node:crypto'
import { open, rename, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

import { dialog, shell } from 'electron'

import type { DiagnosticsSummaryDto, LogStatsDto, OperatingSystem } from '@shared/types'

import type { LogLifecycle } from '../logger'

const getOperatingSystem = (): OperatingSystem =>
  process.platform === 'win32' ? 'windows' : 'macos'

export const maskIpAddressForDiagnostics = (address: string): string => {
  const parts = address.split('.')
  return parts.length === 4 ? `${parts[0]}.${parts[1]}.${parts[2]}.x` : 'hidden'
}

const replaceFile = async (temporaryPath: string, targetPath: string): Promise<void> => {
  try {
    await rename(temporaryPath, targetPath)
    return
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined
    if (code !== 'EEXIST' && code !== 'EPERM') throw error
  }
  const backupPath = `${targetPath}.${randomUUID()}.backup`
  await rename(targetPath, backupPath)
  try {
    await rename(temporaryPath, targetPath)
    await unlink(backupPath).catch(() => undefined)
  } catch (error) {
    await rename(backupPath, targetPath).catch(() => undefined)
    throw error
  }
}

export class DiagnosticsService {
  public constructor(
    private readonly getSummary: () => Promise<DiagnosticsSummaryDto>,
    private readonly logLifecycle: LogLifecycle,
    private readonly dataDirectory: string,
    private readonly logDirectory: string,
  ) {}

  public async getDiagnosticsSummary(): Promise<DiagnosticsSummaryDto> {
    return this.getSummary()
  }

  public async exportReport(): Promise<boolean> {
    const result = await dialog.showSaveDialog({
      title: '导出诊断报告',
      defaultPath: `lindu-diagnostics-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    })
    if (result.canceled || result.filePath === undefined) return false
    const summary = await this.getSummary()
    const report = {
      reportVersion: 1,
      generatedAt: Date.now(),
      appVersion: summary.appVersion,
      platform: summary.platform,
      architecture: summary.architecture,
      service: {
        state: summary.service.state,
        port: summary.service.port,
        ipNetworks: summary.service.ipAddresses.map(maskIpAddressForDiagnostics),
        ...(summary.service.errorCode === undefined
          ? {}
          : { errorCode: summary.service.errorCode }),
      },
      connectionState: summary.connectionState,
      discoveryRunning: summary.discoveryRunning,
      activeTransferCount: summary.activeTransferCount,
      historyEntries: summary.historyEntries,
      historyStorageBytes: summary.historyStorageBytes,
      logFiles: summary.logFiles,
      logStorageBytes: summary.logStorageBytes,
    }
    const temporaryPath = join(
      dirname(result.filePath),
      `.${basename(result.filePath)}.${randomUUID()}.tmp`,
    )
    const handle = await open(temporaryPath, 'wx', 0o600)
    try {
      await handle.writeFile(`${JSON.stringify(report, null, 2)}\n`, 'utf8')
      await handle.sync()
      await handle.close()
      await replaceFile(temporaryPath, result.filePath)
      return true
    } catch (error) {
      await handle.close().catch(() => undefined)
      await unlink(temporaryPath).catch(() => undefined)
      throw error
    }
  }

  public async openDataDirectory(): Promise<void> {
    const errorMessage = await shell.openPath(this.dataDirectory)
    if (errorMessage !== '') throw new Error(errorMessage)
  }

  public async openLogDirectory(): Promise<void> {
    const errorMessage = await shell.openPath(this.logDirectory)
    if (errorMessage !== '') throw new Error(errorMessage)
  }

  public getLogStats(): Promise<LogStatsDto> {
    return this.logLifecycle.getStats()
  }

  public clearLogs(): Promise<number> {
    return this.logLifecycle.clearInactiveLogs()
  }
}

export const getDiagnosticsPlatform = getOperatingSystem

import type { BrowserWindow } from 'electron'

import type { DiagnosticsService } from '../diagnostics'
import { registerIpcHandler } from './register-handler'

type WindowProvider = () => BrowserWindow | null

export const registerDiagnosticsIpcHandlers = (
  getWindow: WindowProvider,
  diagnostics: DiagnosticsService,
): void => {
  registerIpcHandler('diagnostics:get-summary', getWindow, async () => ({
    ok: true,
    data: await diagnostics.getDiagnosticsSummary(),
  }))
  registerIpcHandler('diagnostics:export-report', getWindow, async () => ({
    ok: true,
    data: await diagnostics.exportReport(),
  }))
  registerIpcHandler('diagnostics:open-data-directory', getWindow, async () => {
    await diagnostics.openDataDirectory()
    return { ok: true, data: undefined }
  })
  registerIpcHandler('diagnostics:open-log-directory', getWindow, async () => {
    await diagnostics.openLogDirectory()
    return { ok: true, data: undefined }
  })
  registerIpcHandler('diagnostics:get-log-stats', getWindow, async () => ({
    ok: true,
    data: await diagnostics.getLogStats(),
  }))
  registerIpcHandler('diagnostics:clear-logs', getWindow, async () => ({
    ok: true,
    data: await diagnostics.clearLogs(),
  }))
}

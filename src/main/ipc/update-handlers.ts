import type { BrowserWindow } from 'electron'

import type { UpdateSettingsStore } from '../storage'
import type { UpdateService } from '../update'
import { registerIpcHandler } from './register-handler'

type WindowProvider = () => BrowserWindow | null

export const registerUpdateIpcHandlers = (
  getWindow: WindowProvider,
  updateService: UpdateService,
  settings: UpdateSettingsStore,
): void => {
  registerIpcHandler('update:get-settings', getWindow, () => ({
    ok: true,
    data: settings.getSettings(),
  }))
  registerIpcHandler('update:update-settings', getWindow, ({ automaticChecksEnabled }) => {
    const updated = settings.update({ automaticChecksEnabled })
    if (automaticChecksEnabled) updateService.startAutomaticChecks()
    else updateService.stopAutomaticChecks()
    return { ok: true, data: updated }
  })
  registerIpcHandler('update:get-status', getWindow, () => ({
    ok: true,
    data: updateService.getStatus(),
  }))
  registerIpcHandler('update:check', getWindow, async () => ({
    ok: true,
    data: await updateService.checkForUpdates(),
  }))
  registerIpcHandler('update:download', getWindow, async () => ({
    ok: true,
    data: await updateService.downloadUpdate(),
  }))
  registerIpcHandler('update:cancel-download', getWindow, () => ({
    ok: true,
    data: updateService.cancelDownload(),
  }))
  registerIpcHandler('update:install', getWindow, () => ({
    ok: false,
    error: { code: 'UPDATE_INSTALL_BLOCKED' },
  }))
}

import type { BrowserWindow } from 'electron'

import type { ErrorCode } from '@shared/errors'

import type { FileAccessRegistry } from '../file-transfer'
import type { ServiceManager } from '../server'
import type { SessionHistory, SettingsPatch, SettingsStore } from '../storage'
import { registerIpcHandler } from './register-handler'

type WindowProvider = () => BrowserWindow | null

export const registerSettingsIpcHandlers = (
  getWindow: WindowProvider,
  settingsStore: SettingsStore,
  serviceManager: ServiceManager,
  fileAccess: FileAccessRegistry,
  history: SessionHistory,
): void => {
  registerIpcHandler('settings:get', getWindow, () => ({
    ok: true,
    data: settingsStore.getSettings(),
  }))

  registerIpcHandler('settings:update', getWindow, async (request) => {
    const current = settingsStore.getSettings()
    const patch: SettingsPatch = {
      ...(request.deviceName === undefined ? {} : { deviceName: request.deviceName }),
      ...(request.maxFileSizeBytes === undefined
        ? {}
        : { maxFileSizeBytes: request.maxFileSizeBytes }),
      ...(request.historyLimit === undefined ? {} : { historyLimit: request.historyLimit }),
    }
    if (request.receiveDirectoryToken !== undefined) {
      try {
        patch.receiveDirectory = await fileAccess.consumeDirectoryToken(
          request.receiveDirectoryToken,
        )
      } catch {
        return { ok: false, error: { code: 'SAVE_DIRECTORY_INVALID' } }
      }
    }
    try {
      if (request.servicePort !== undefined && request.servicePort !== current.servicePort) {
        const status = await serviceManager.restart(request.servicePort)
        if (status.state !== 'running') {
          await serviceManager.restart(current.servicePort)
          const code: ErrorCode = status.errorCode ?? 'NETWORK_UNREACHABLE'
          return { ok: false, error: { code } }
        }
        patch.servicePort = request.servicePort
      }
      const settings = settingsStore.update(patch)
      history.trimToLimit()
      return { ok: true, data: settings }
    } catch {
      return { ok: false, error: { code: 'NETWORK_UNREACHABLE' } }
    }
  })
}

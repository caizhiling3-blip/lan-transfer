import type { BrowserWindow } from 'electron'

import type { ServiceManager } from '../server'
import type { SettingsStore } from '../storage'
import { registerIpcHandler } from './register-handler'

type WindowProvider = () => BrowserWindow | null

export const registerServiceIpcHandlers = (
  getWindow: WindowProvider,
  serviceManager: ServiceManager,
  settingsStore: SettingsStore,
): void => {
  registerIpcHandler('service:get-status', getWindow, () => ({
    ok: true,
    data: serviceManager.getStatus(),
  }))

  registerIpcHandler('service:restart', getWindow, async ({ port }) => {
    const status = await serviceManager.restart(port)
    if (status.state === 'running') settingsStore.update({ servicePort: port })
    return { ok: true, data: status }
  })
}

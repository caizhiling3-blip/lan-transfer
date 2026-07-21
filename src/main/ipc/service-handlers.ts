import type { BrowserWindow } from 'electron'

import type { ServiceManager } from '../server'
import { registerIpcHandler } from './register-handler'

type WindowProvider = () => BrowserWindow | null

export const registerServiceIpcHandlers = (
  getWindow: WindowProvider,
  serviceManager: ServiceManager,
): void => {
  registerIpcHandler('service:get-status', getWindow, () => ({
    ok: true,
    data: serviceManager.getStatus(),
  }))

  registerIpcHandler('service:restart', getWindow, async ({ port }) => ({
    ok: true,
    data: await serviceManager.restart(port),
  }))
}

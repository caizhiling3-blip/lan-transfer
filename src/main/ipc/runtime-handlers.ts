import { app } from 'electron'
import type { BrowserWindow } from 'electron'

import type { DeviceIdentity } from '../app'
import type { ServiceManager } from '../server'
import { registerIpcHandler } from './register-handler'

type WindowProvider = () => BrowserWindow | null

export const registerRuntimeIpcHandlers = (
  getWindow: WindowProvider,
  identity: DeviceIdentity,
  serviceManager: ServiceManager,
): void => {
  registerIpcHandler('app:get-runtime-info', getWindow, () => ({
    ok: true,
    data: {
      appVersion: app.getVersion(),
      platform: identity.getPlatform(),
      localDevice: identity.getDeviceInfo(serviceManager.getStatus()),
    },
  }))
}

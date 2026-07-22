import type { BrowserWindow } from 'electron'

import type { DiscoveryManager } from '../discovery'
import { registerIpcHandler } from './register-handler'

type WindowProvider = () => BrowserWindow | null

export const registerDiscoveryIpcHandlers = (
  getWindow: WindowProvider,
  discoveryManager: DiscoveryManager,
): void => {
  registerIpcHandler('discovery:get-devices', getWindow, () => ({
    ok: true,
    data: discoveryManager.getDevices(),
  }))
}

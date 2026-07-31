import type { BrowserWindow } from 'electron'

import type { ConnectionManager } from '../websocket'
import type { RecentDevicesStore } from '../storage'
import { registerIpcHandler } from './register-handler'

type WindowProvider = () => BrowserWindow | null

export const registerConnectionIpcHandlers = (
  getWindow: WindowProvider,
  connectionManager: ConnectionManager,
  recentDevices: RecentDevicesStore,
): void => {
  registerIpcHandler('connection:get-status', getWindow, () => ({
    ok: true,
    data: connectionManager.getStatus(),
  }))
  registerIpcHandler('connection:connect', getWindow, async ({ host, port }) => ({
    ok: true,
    data: await connectionManager.connect(host, port),
  }))
  registerIpcHandler('connection:disconnect', getWindow, () => {
    connectionManager.disconnect()
    return { ok: true, data: undefined }
  })
  registerIpcHandler('connection:respond-to-request', getWindow, ({ requestId, decision }) => ({
    ok: true,
    data: connectionManager.respondToRequest(requestId, decision),
  }))
  registerIpcHandler('recent-devices:list', getWindow, () => ({
    ok: true,
    data: recentDevices.list(),
  }))
  registerIpcHandler('recent-devices:update-alias', getWindow, ({ deviceId, alias }) => ({
    ok: true,
    data: recentDevices.updateAlias(deviceId, alias),
  }))
  registerIpcHandler('recent-devices:remove', getWindow, ({ deviceId }) => ({
    ok: true,
    data: recentDevices.remove(deviceId),
  }))
  registerIpcHandler('recent-devices:clear', getWindow, () => {
    recentDevices.clear()
    return { ok: true, data: undefined }
  })
}

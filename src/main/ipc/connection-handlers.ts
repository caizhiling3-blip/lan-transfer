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
  registerIpcHandler('connection:list-recent-devices', getWindow, () => ({
    ok: true,
    data: recentDevices.list(),
  }))
}

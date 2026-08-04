import type { BrowserWindow } from 'electron'

import type { PairingCoordinator } from '../pairing'
import type { TrustedDevicesStore } from '../storage'
import { registerIpcHandler } from './register-handler'

type WindowProvider = () => BrowserWindow | null

export const registerPairingIpcHandlers = (
  getWindow: WindowProvider,
  pairingCoordinator: PairingCoordinator,
  trustedDevices: TrustedDevicesStore,
  onTrustedDevicesChanged: () => void,
): void => {
  registerIpcHandler('pairing:get-pending', getWindow, () => ({
    ok: true,
    data: pairingCoordinator.getPending(),
  }))
  registerIpcHandler('pairing:respond', getWindow, ({ requestId, decision }) =>
    pairingCoordinator.respond(requestId, decision)
      ? { ok: true, data: undefined }
      : { ok: false, error: { code: 'MESSAGE_INVALID' } },
  )
  registerIpcHandler('trusted-devices:list', getWindow, () => ({
    ok: true,
    data: trustedDevices.listSummaries(),
  }))
  registerIpcHandler('trusted-devices:revoke', getWindow, ({ deviceId }) => {
    trustedDevices.revoke(deviceId)
    onTrustedDevicesChanged()
    return { ok: true, data: trustedDevices.listSummaries() }
  })
  registerIpcHandler('trusted-devices:clear', getWindow, () => {
    trustedDevices.clear()
    onTrustedDevicesChanged()
    return { ok: true, data: undefined }
  })
}

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
  onTrustRevoked: (
    deviceId?: Parameters<TrustedDevicesStore['revoke']>[0],
  ) => Promise<void> = async () => undefined,
): void => {
  registerIpcHandler('pairing:get-pending', getWindow, () => ({
    ok: true,
    data: pairingCoordinator.getPending(),
  }))
  registerIpcHandler('pairing:respond', getWindow, ({ requestId, ...response }) => {
    const result = pairingCoordinator.respond(requestId, response)
    if (result === 'accepted' || result === 'rejected') return { ok: true, data: undefined }
    return {
      ok: false,
      error: { code: result === 'codeInvalid' ? 'PAIRING_CODE_INVALID' : 'MESSAGE_INVALID' },
    }
  })
  registerIpcHandler('trusted-devices:list', getWindow, () => ({
    ok: true,
    data: trustedDevices.listSummaries(),
  }))
  registerIpcHandler('trusted-devices:revoke', getWindow, async ({ deviceId }) => {
    trustedDevices.revoke(deviceId)
    await onTrustRevoked(deviceId)
    onTrustedDevicesChanged()
    return { ok: true, data: trustedDevices.listSummaries() }
  })
  registerIpcHandler('trusted-devices:clear', getWindow, async () => {
    trustedDevices.clear()
    await onTrustRevoked()
    onTrustedDevicesChanged()
    return { ok: true, data: undefined }
  })
}

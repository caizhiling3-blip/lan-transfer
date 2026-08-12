import { shell } from 'electron'
import type { BrowserWindow } from 'electron'
import { stat } from 'node:fs/promises'

import type { MobileUploadCoordinator } from '../mobile-upload'
import type { ServiceManager } from '../server'
import { registerIpcHandler } from './register-handler'

type WindowProvider = () => BrowserWindow | null

export const registerMobileUploadIpcHandlers = (
  getWindow: WindowProvider,
  coordinator: MobileUploadCoordinator,
  serviceManager: ServiceManager,
): void => {
  registerIpcHandler('mobile-upload:create-session', getWindow, () => {
    const status = serviceManager.getStatus()
    if (status.state !== 'running' || status.ipAddresses.length === 0) {
      return { ok: false, error: { code: 'MOBILE_UPLOAD_UNAVAILABLE' } }
    }
    return { ok: true, data: coordinator.createSession().session }
  })

  registerIpcHandler('mobile-upload:get-session', getWindow, () => ({
    ok: true,
    data: coordinator.getSession(),
  }))

  registerIpcHandler('mobile-upload:close-session', getWindow, () => {
    coordinator.closeSession()
    return { ok: true, data: undefined }
  })

  registerIpcHandler('mobile-upload:respond-to-offer', getWindow, async ({ batchId, decision }) => {
    const task = await coordinator.respondToOffer(batchId, decision)
    return task === null
      ? { ok: false, error: { code: 'MESSAGE_INVALID' } }
      : { ok: true, data: task }
  })

  registerIpcHandler('mobile-upload:cancel', getWindow, async ({ batchId }) => {
    const task = await coordinator.cancel(batchId)
    return task === null
      ? { ok: false, error: { code: 'MESSAGE_INVALID' } }
      : { ok: true, data: task }
  })

  registerIpcHandler('mobile-upload:show-received', getWindow, async ({ batchId }) => {
    const receivedPath = coordinator.getReceivedPath(batchId)
    if (receivedPath === null) return { ok: false, error: { code: 'FILE_NOT_FOUND' } }
    try {
      const metadata = await stat(receivedPath)
      if (!metadata.isFile()) return { ok: false, error: { code: 'FILE_NOT_FOUND' } }
      shell.showItemInFolder(receivedPath)
      return { ok: true, data: undefined }
    } catch {
      return { ok: false, error: { code: 'FILE_NOT_FOUND' } }
    }
  })

  registerIpcHandler('mobile-upload:publish-downloads', getWindow, ({ selectionTokens }) => {
    const batch = coordinator.publishDownloads(selectionTokens)
    return batch === null
      ? { ok: false, error: { code: 'FILE_NOT_FOUND' } }
      : { ok: true, data: batch }
  })

  registerIpcHandler('mobile-upload:get-downloads', getWindow, () => ({
    ok: true,
    data: coordinator.getDownloads(),
  }))

  registerIpcHandler('mobile-upload:clear-downloads', getWindow, () => {
    coordinator.clearDownloads()
    return { ok: true, data: undefined }
  })
}

import type { BrowserWindow } from 'electron'

import type { SessionHistory } from '../storage'
import type { ConnectionManager } from '../websocket'
import { registerIpcHandler } from './register-handler'

type WindowProvider = () => BrowserWindow | null

export const registerTextIpcHandlers = (
  getWindow: WindowProvider,
  connectionManager: ConnectionManager,
  history: SessionHistory,
): void => {
  registerIpcHandler('transfer:send-text', getWindow, async ({ content, contentType }) => {
    const task = await connectionManager.sendText(content, contentType)
    if (task === null) {
      return { ok: false, error: { code: 'CONNECTION_CLOSED' } }
    }
    history.add({
      transferId: task.transferId,
      direction: 'send',
      kind: contentType,
      peer: task.peer,
      status: task.status,
      textPreview: content,
      createdAt: task.createdAt,
      ...(task.errorCode === undefined ? {} : { errorCode: task.errorCode }),
    })
    return { ok: true, data: task }
  })

  registerIpcHandler('history:list', getWindow, (filter) => ({
    ok: true,
    data: history.list(filter),
  }))
  registerIpcHandler('history:clear', getWindow, () => {
    history.clear()
    return { ok: true, data: undefined }
  })
}

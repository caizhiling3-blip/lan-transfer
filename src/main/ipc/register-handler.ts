import { ipcMain } from 'electron'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'

import {
  ipcInvokeRequestSchemas,
  type IpcInvokeChannel,
  type IpcInvokeRequest,
  type IpcInvokeResponse,
} from '@shared/ipc'

import { isTrustedIpcSenderContext } from './sender-validation'

type WindowProvider = () => BrowserWindow | null

type IpcHandler<TChannel extends IpcInvokeChannel> = (
  request: IpcInvokeRequest<TChannel>,
) => Promise<IpcInvokeResponse<TChannel>> | IpcInvokeResponse<TChannel>

export const isTrustedIpcSender = (
  event: Pick<IpcMainInvokeEvent, 'sender' | 'senderFrame'>,
  window: BrowserWindow | null,
): boolean =>
  isTrustedIpcSenderContext(
    {
      senderId: event.sender.id,
      senderFrame: event.senderFrame,
      mainFrame: event.sender.mainFrame,
    },
    window === null
      ? null
      : {
          destroyed: window.isDestroyed(),
          webContentsId: window.webContents.id,
        },
  )

export const registerIpcHandler = <TChannel extends IpcInvokeChannel>(
  channel: TChannel,
  getWindow: WindowProvider,
  handler: IpcHandler<TChannel>,
): void => {
  ipcMain.handle(channel, async (event, input: unknown): Promise<IpcInvokeResponse<TChannel>> => {
    if (!isTrustedIpcSender(event, getWindow())) {
      return { ok: false, error: { code: 'MESSAGE_INVALID' } }
    }

    const parsed = ipcInvokeRequestSchemas[channel].safeParse(input)
    if (!parsed.success) {
      return { ok: false, error: { code: 'MESSAGE_INVALID' } }
    }

    try {
      return await handler(parsed.data as IpcInvokeRequest<TChannel>)
    } catch {
      return { ok: false, error: { code: 'MESSAGE_INVALID' } }
    }
  })
}

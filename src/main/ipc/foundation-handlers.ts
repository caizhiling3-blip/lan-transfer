import { clipboard, shell } from 'electron'
import type { BrowserWindow } from 'electron'

import { MAX_TEXT_BYTES } from '@shared/constants'
import type { OperationResult } from '@shared/types'
import { getUtf8ByteLength } from '@shared/utils'

import { registerIpcHandler } from './register-handler'

type WindowProvider = () => BrowserWindow | null

const success = <T>(data: T): { readonly ok: true; readonly data: T } => ({ ok: true, data })

const invalidMessage = <T>(): OperationResult<T> => ({
  ok: false,
  error: { code: 'MESSAGE_INVALID' },
})

export const registerFoundationIpcHandlers = (getWindow: WindowProvider): void => {
  registerIpcHandler('app:open-external-url', getWindow, async ({ url }) => {
    await shell.openExternal(url)
    return success(undefined)
  })

  registerIpcHandler('clipboard:read-text', getWindow, () => {
    const text = clipboard.readText()
    if (getUtf8ByteLength(text) > MAX_TEXT_BYTES) {
      return invalidMessage<string>()
    }
    return success(text)
  })

  registerIpcHandler('clipboard:write-text', getWindow, ({ text }) => {
    clipboard.writeText(text)
    return success(undefined)
  })
}

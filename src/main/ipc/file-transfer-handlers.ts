import type { BrowserWindow } from 'electron'

import type { ErrorCode } from '@shared/errors'
import type { OperationResult, SelectedDirectoryDto, SelectedFileDto } from '@shared/types'

import type { FileAccessRegistry, FileTransferCoordinator } from '../file-transfer'
import { registerIpcHandler } from './register-handler'

type WindowProvider = () => BrowserWindow | null

const mapError = (error: unknown): ErrorCode => {
  if (error instanceof Error) {
    if (error.message === 'FILE_NOT_FOUND') return 'FILE_NOT_FOUND'
    if (error.message === 'FILE_TOO_LARGE') return 'FILE_TOO_LARGE'
    if (error.message === 'FILE_COUNT_EXCEEDED') return 'FILE_COUNT_EXCEEDED'
    if (error.message === 'SAVE_DIRECTORY_INVALID') return 'SAVE_DIRECTORY_INVALID'
  }
  return 'TRANSFER_FAILED'
}

export const registerFileTransferIpcHandlers = (
  getWindow: WindowProvider,
  fileAccess: FileAccessRegistry,
  coordinator: FileTransferCoordinator,
): void => {
  registerIpcHandler('transfer:select-files', getWindow, async ({ multiple }) => {
    const window = getWindow()
    if (window === null || window.isDestroyed()) {
      return { ok: false, error: { code: 'MESSAGE_INVALID' } }
    }
    try {
      return { ok: true, data: await fileAccess.selectFiles(window, multiple) }
    } catch (error) {
      return { ok: false, error: { code: mapError(error) } } satisfies OperationResult<
        readonly SelectedFileDto[]
      >
    }
  })

  registerIpcHandler('transfer:register-dropped-files', getWindow, async ({ paths }) => {
    try {
      return { ok: true, data: await fileAccess.registerDroppedFiles(paths) }
    } catch (error) {
      return { ok: false, error: { code: mapError(error) } } satisfies OperationResult<
        readonly SelectedFileDto[]
      >
    }
  })

  registerIpcHandler('transfer:offer-files', getWindow, async ({ selectionTokens }) => {
    const task = await coordinator.offerFiles(selectionTokens)
    return task === null
      ? { ok: false, error: { code: 'FILE_NOT_FOUND' } }
      : { ok: true, data: task }
  })

  registerIpcHandler(
    'transfer:respond-to-offer',
    getWindow,
    async ({ transferId, decision, directoryToken }) => {
      const task = await coordinator.respondToOffer(transferId, decision, directoryToken)
      return task === null
        ? { ok: false, error: { code: 'MESSAGE_INVALID' } }
        : { ok: true, data: task }
    },
  )

  registerIpcHandler('transfer:cancel', getWindow, async ({ transferId, fileId }) => {
    const task = await coordinator.cancel(transferId, fileId)
    return task === null
      ? { ok: false, error: { code: 'MESSAGE_INVALID' } }
      : { ok: true, data: task }
  })

  registerIpcHandler('transfer:retry', getWindow, async ({ transferId }) => {
    const task = await coordinator.retry(transferId)
    return task === null
      ? { ok: false, error: { code: 'MESSAGE_INVALID' } }
      : { ok: true, data: task }
  })

  registerIpcHandler('settings:select-receive-directory', getWindow, async () => {
    const window = getWindow()
    if (window === null || window.isDestroyed()) {
      return { ok: false, error: { code: 'MESSAGE_INVALID' } }
    }
    try {
      const selected = await fileAccess.selectReceiveDirectory(window)
      return selected === null
        ? { ok: false, error: { code: 'SAVE_DIRECTORY_INVALID' } }
        : { ok: true, data: selected }
    } catch (error) {
      return {
        ok: false,
        error: { code: mapError(error) },
      } satisfies OperationResult<SelectedDirectoryDto>
    }
  })
}

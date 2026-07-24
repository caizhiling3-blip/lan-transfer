import { shell } from 'electron'
import type { BrowserWindow } from 'electron'

import type { ErrorCode } from '@shared/errors'
import type {
  OperationResult,
  SelectedDirectoryDto,
  SelectedFileDto,
  SelectedFolderDto,
  SelectedTransferItemDto,
} from '@shared/types'

import type {
  FileAccessRegistry,
  FileTransferCoordinator,
  FolderTransferCoordinator,
} from '../file-transfer'
import { registerIpcHandler } from './register-handler'

type WindowProvider = () => BrowserWindow | null

const mapError = (error: unknown): ErrorCode => {
  if (error instanceof Error) {
    if (error.message === 'FILE_NOT_FOUND') return 'FILE_NOT_FOUND'
    if (error.message === 'FILE_TOO_LARGE') return 'FILE_TOO_LARGE'
    if (error.message === 'FILE_COUNT_EXCEEDED') return 'FILE_COUNT_EXCEEDED'
    if (error.message === 'SAVE_DIRECTORY_INVALID') return 'SAVE_DIRECTORY_INVALID'
    if (error.message === 'FOLDER_NOT_FOUND') return 'FOLDER_NOT_FOUND'
    if (error.message === 'FOLDER_SCAN_TIMEOUT') return 'FOLDER_SCAN_TIMEOUT'
    if (error.message === 'FOLDER_FILE_COUNT_EXCEEDED') return 'FOLDER_FILE_COUNT_EXCEEDED'
    if (error.message === 'FOLDER_TOTAL_SIZE_EXCEEDED') return 'FOLDER_TOTAL_SIZE_EXCEEDED'
    if (error.message === 'FOLDER_DEPTH_EXCEEDED') return 'FOLDER_DEPTH_EXCEEDED'
    if (error.message === 'FOLDER_PATH_INVALID') return 'FOLDER_PATH_INVALID'
    if (error.message === 'FOLDER_PATH_CONFLICT') return 'FOLDER_PATH_CONFLICT'
    if (error.message === 'FOLDER_MANIFEST_TOO_LARGE') return 'FOLDER_MANIFEST_TOO_LARGE'
    if (error.message === 'FOLDER_SYMLINK_UNSUPPORTED') return 'FOLDER_SYMLINK_UNSUPPORTED'
  }
  return 'TRANSFER_FAILED'
}

export const registerFileTransferIpcHandlers = (
  getWindow: WindowProvider,
  fileAccess: FileAccessRegistry,
  coordinator: FileTransferCoordinator,
  folderCoordinator: FolderTransferCoordinator,
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

  registerIpcHandler('transfer:select-folder', getWindow, async () => {
    const window = getWindow()
    if (window === null || window.isDestroyed()) {
      return { ok: false, error: { code: 'MESSAGE_INVALID' } }
    }
    try {
      return { ok: true, data: await fileAccess.selectFolder(window) }
    } catch (error) {
      return {
        ok: false,
        error: { code: mapError(error) },
      } satisfies OperationResult<SelectedFolderDto | null>
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

  registerIpcHandler('transfer:register-dropped-items', getWindow, async ({ paths }) => {
    try {
      return { ok: true, data: await fileAccess.registerDroppedItems(paths) }
    } catch (error) {
      return { ok: false, error: { code: mapError(error) } } satisfies OperationResult<
        readonly SelectedTransferItemDto[]
      >
    }
  })

  registerIpcHandler('transfer:offer-files', getWindow, async ({ selectionTokens }) => {
    const task = await coordinator.offerFiles(selectionTokens)
    return task === null
      ? { ok: false, error: { code: 'FILE_NOT_FOUND' } }
      : { ok: true, data: task }
  })

  registerIpcHandler('transfer:offer-folder', getWindow, async ({ selectionToken }) => {
    const task = await folderCoordinator.offerFolder(selectionToken)
    return task === null
      ? { ok: false, error: { code: 'FOLDER_NOT_FOUND' } }
      : { ok: true, data: task }
  })

  registerIpcHandler(
    'transfer:respond-to-offer',
    getWindow,
    async ({ transferId, decision, directoryToken }) => {
      const task = folderCoordinator.ownsTransfer(transferId)
        ? await folderCoordinator.respondToOffer(transferId, decision, directoryToken)
        : await coordinator.respondToOffer(transferId, decision, directoryToken)
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

  registerIpcHandler('transfer:show-received-file', getWindow, ({ transferId, fileId }) => {
    const filePath = coordinator.getReceivedFilePath(transferId, fileId)
    if (filePath === null) return { ok: false, error: { code: 'FILE_NOT_FOUND' } }
    shell.showItemInFolder(filePath)
    return { ok: true, data: undefined }
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

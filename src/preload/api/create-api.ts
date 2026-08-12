import { ipcRenderer, webUtils } from 'electron'
import type { IpcRendererEvent } from 'electron'

import type {
  IpcEventChannel,
  IpcEventPayload,
  IpcInvokeChannel,
  IpcInvokeRequest,
  IpcInvokeResponse,
  OperatingSystem,
} from '@shared/index'

import type { LanTransferApi, Unsubscribe } from '../types'

const invoke = <TChannel extends IpcInvokeChannel>(
  channel: TChannel,
  request: IpcInvokeRequest<TChannel>,
): Promise<IpcInvokeResponse<TChannel>> =>
  ipcRenderer.invoke(channel, request) as Promise<IpcInvokeResponse<TChannel>>

const subscribe = <TChannel extends IpcEventChannel>(
  channel: TChannel,
  listener: (payload: IpcEventPayload<TChannel>) => void,
): Unsubscribe => {
  const wrappedListener = (_event: IpcRendererEvent, payload: unknown): void => {
    listener(payload as IpcEventPayload<TChannel>)
  }

  ipcRenderer.on(channel, wrappedListener)
  return () => {
    ipcRenderer.removeListener(channel, wrappedListener)
  }
}

const getOperatingSystem = (): OperatingSystem => {
  if (process.platform === 'win32') {
    return 'windows'
  }
  if (process.platform === 'darwin') {
    return 'macos'
  }
  throw new Error(`Unsupported platform: ${process.platform}`)
}

export const createLanTransferApi = (): LanTransferApi => {
  const api = {
    platform: getOperatingSystem(),
    app: Object.freeze({
      getRuntimeInfo: () => invoke('app:get-runtime-info', undefined),
      openExternalUrl: (url: string) => invoke('app:open-external-url', { url }),
    }),
    service: Object.freeze({
      getStatus: () => invoke('service:get-status', undefined),
      restart: (port: number) => invoke('service:restart', { port }),
      onStatusChanged: (listener) => subscribe('service:status-changed', listener),
    }),
    connection: Object.freeze({
      getStatus: () => invoke('connection:get-status', undefined),
      connect: (host: string, port: number) => invoke('connection:connect', { host, port }),
      disconnect: () => invoke('connection:disconnect', undefined),
      respondToRequest: (requestId, decision) =>
        invoke('connection:respond-to-request', { requestId, decision }),
      onStateChanged: (listener) => subscribe('connection:state-changed', listener),
      onIncomingRequest: (listener) => subscribe('connection:incoming-request', listener),
    }),
    pairing: Object.freeze({
      getPending: () => invoke('pairing:get-pending', undefined),
      respond: (requestId, response) => invoke('pairing:respond', { requestId, ...response }),
      onChanged: (listener) => subscribe('pairing:changed', listener),
    }),
    trustedDevices: Object.freeze({
      list: () => invoke('trusted-devices:list', undefined),
      revoke: (deviceId) => invoke('trusted-devices:revoke', { deviceId }),
      clear: () => invoke('trusted-devices:clear', undefined),
      onChanged: (listener) => subscribe('trusted-devices:changed', listener),
    }),
    recentDevices: Object.freeze({
      list: () => invoke('recent-devices:list', undefined),
      updateAlias: (deviceId, alias) => invoke('recent-devices:update-alias', { deviceId, alias }),
      remove: (deviceId) => invoke('recent-devices:remove', { deviceId }),
      clear: () => invoke('recent-devices:clear', undefined),
    }),
    discovery: Object.freeze({
      getDevices: () => invoke('discovery:get-devices', undefined),
      onDevicesChanged: (listener) => subscribe('discovery:devices-changed', listener),
    }),
    clipboard: Object.freeze({
      readText: () => invoke('clipboard:read-text', undefined),
      writeText: (text: string) => invoke('clipboard:write-text', { text }),
    }),
    transfer: Object.freeze({
      selectFiles: (multiple: boolean) => invoke('transfer:select-files', { multiple }),
      selectFolder: () => invoke('transfer:select-folder', undefined),
      registerDroppedFiles: (files: readonly File[]) =>
        invoke('transfer:register-dropped-files', {
          paths: files.map((file) => webUtils.getPathForFile(file)).filter((path) => path !== ''),
        }),
      registerDroppedItems: (files: readonly File[]) =>
        invoke('transfer:register-dropped-items', {
          paths: files.map((file) => webUtils.getPathForFile(file)).filter((path) => path !== ''),
        }),
      sendText: (content, contentType) => invoke('transfer:send-text', { content, contentType }),
      offerFiles: (selectionTokens) => invoke('transfer:offer-files', { selectionTokens }),
      offerFolder: (selectionToken) => invoke('transfer:offer-folder', { selectionToken }),
      enqueue: (request) => invoke('transfer:enqueue', request),
      cancelQueued: (queueItemId) => invoke('transfer:cancel-queued', { queueItemId }),
      respondToOffer: (transferId, decision, directoryToken) =>
        decision === 'accept'
          ? invoke(
              'transfer:respond-to-offer',
              directoryToken === undefined
                ? { transferId, decision }
                : { transferId, decision, directoryToken },
            )
          : invoke('transfer:respond-to-offer', { transferId, decision }),
      cancel: (transferId, fileId) =>
        invoke('transfer:cancel', fileId === undefined ? { transferId } : { transferId, fileId }),
      getTasks: () => invoke('transfer:get-tasks', undefined),
      pause: (transferId) => invoke('transfer:pause', { transferId }),
      resume: (transferId) => invoke('transfer:resume', { transferId }),
      retry: (transferId) => invoke('transfer:retry', { transferId }),
      showReceivedFile: (transferId, fileId) =>
        invoke(
          'transfer:show-received-file',
          fileId === undefined ? { transferId } : { transferId, fileId },
        ),
      onTaskChanged: (listener) => subscribe('transfer:task-changed', listener),
      onQueueChanged: (listener) => subscribe('transfer:queue-changed', listener),
      onTextTaskChanged: (listener) => subscribe('transfer:text-task-changed', listener),
      onTextReceived: (listener) => subscribe('transfer:text-received', listener),
      onOfferReceived: (listener) => subscribe('transfer:offer-received', listener),
    }),
    history: Object.freeze({
      list: (filter) => invoke('history:list', filter),
      locateReceived: (historyId) => invoke('history:locate-received', { historyId }),
      getStats: (criteria) =>
        invoke('history:get-stats', criteria === undefined ? {} : { criteria }),
      delete: (historyIds) => invoke('history:delete', { historyIds }),
      previewCleanup: (criteria) => invoke('history:preview-cleanup', criteria),
      cleanup: (criteria) => invoke('history:cleanup', criteria),
      clear: () => invoke('history:clear', undefined),
    }),
    mobileUpload: Object.freeze({
      createSession: () => invoke('mobile-upload:create-session', undefined),
      getSession: () => invoke('mobile-upload:get-session', undefined),
      closeSession: () => invoke('mobile-upload:close-session', undefined),
      respondToOffer: (batchId, decision) =>
        invoke('mobile-upload:respond-to-offer', { batchId, decision }),
      cancel: (batchId) => invoke('mobile-upload:cancel', { batchId }),
      showReceived: (batchId) => invoke('mobile-upload:show-received', { batchId }),
      publishDownloads: (selectionTokens) =>
        invoke('mobile-upload:publish-downloads', { selectionTokens }),
      getDownloads: () => invoke('mobile-upload:get-downloads', undefined),
      clearDownloads: () => invoke('mobile-upload:clear-downloads', undefined),
      onSessionChanged: (listener) => subscribe('mobile-upload:session-changed', listener),
      onOfferReceived: (listener) => subscribe('mobile-upload:offer-received', listener),
      onTaskChanged: (listener) => subscribe('mobile-upload:task-changed', listener),
      onDownloadsChanged: (listener) => subscribe('mobile-upload:downloads-changed', listener),
    }),
    diagnostics: Object.freeze({
      getSummary: () => invoke('diagnostics:get-summary', undefined),
      exportReport: () => invoke('diagnostics:export-report', undefined),
      openDataDirectory: () => invoke('diagnostics:open-data-directory', undefined),
      openLogDirectory: () => invoke('diagnostics:open-log-directory', undefined),
      getLogStats: () => invoke('diagnostics:get-log-stats', undefined),
      clearLogs: () => invoke('diagnostics:clear-logs', undefined),
    }),
    settings: Object.freeze({
      get: () => invoke('settings:get', undefined),
      update: (patch) => invoke('settings:update', patch),
      selectReceiveDirectory: () => invoke('settings:select-receive-directory', undefined),
      onChanged: (listener) => subscribe('settings:changed', listener),
    }),
  } satisfies LanTransferApi

  return Object.freeze(api)
}

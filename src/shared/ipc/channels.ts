export const IPC_INVOKE_CHANNELS = [
  'app:get-runtime-info',
  'app:open-external-url',
  'service:get-status',
  'service:restart',
  'connection:connect',
  'connection:disconnect',
  'connection:respond-to-request',
  'clipboard:read-text',
  'clipboard:write-text',
  'transfer:select-files',
  'transfer:send-text',
  'transfer:offer-files',
  'transfer:respond-to-offer',
  'transfer:cancel',
  'transfer:retry',
  'history:list',
  'history:clear',
  'settings:get',
  'settings:update',
  'settings:select-receive-directory',
] as const

export const SERVICE_STATUS_CHANGED_EVENT_CHANNEL = 'service:status-changed' as const

export const IPC_EVENT_CHANNELS = [
  SERVICE_STATUS_CHANGED_EVENT_CHANNEL,
  'connection:state-changed',
  'connection:incoming-request',
  'transfer:task-changed',
  'transfer:text-received',
  'transfer:offer-received',
  'settings:changed',
] as const

export type IpcInvokeChannel = (typeof IPC_INVOKE_CHANNELS)[number]
export type IpcEventChannel = (typeof IPC_EVENT_CHANNELS)[number]

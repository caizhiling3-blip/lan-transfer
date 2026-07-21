export const IPC_INVOKE_CHANNELS = [
  'app:get-runtime-info',
  'app:open-external-url',
  'service:get-status',
  'service:restart',
  'connection:get-status',
  'connection:connect',
  'connection:disconnect',
  'connection:respond-to-request',
  'connection:list-recent-devices',
  'clipboard:read-text',
  'clipboard:write-text',
  'transfer:select-files',
  'transfer:register-dropped-files',
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
export const CONNECTION_STATE_CHANGED_EVENT_CHANNEL = 'connection:state-changed' as const
export const CONNECTION_INCOMING_REQUEST_EVENT_CHANNEL = 'connection:incoming-request' as const
export const TEXT_RECEIVED_EVENT_CHANNEL = 'transfer:text-received' as const
export const TRANSFER_TASK_CHANGED_EVENT_CHANNEL = 'transfer:task-changed' as const
export const FILE_OFFER_RECEIVED_EVENT_CHANNEL = 'transfer:offer-received' as const
export const SETTINGS_CHANGED_EVENT_CHANNEL = 'settings:changed' as const

export const IPC_EVENT_CHANNELS = [
  SERVICE_STATUS_CHANGED_EVENT_CHANNEL,
  CONNECTION_STATE_CHANGED_EVENT_CHANNEL,
  CONNECTION_INCOMING_REQUEST_EVENT_CHANNEL,
  TRANSFER_TASK_CHANGED_EVENT_CHANNEL,
  TEXT_RECEIVED_EVENT_CHANNEL,
  FILE_OFFER_RECEIVED_EVENT_CHANNEL,
  SETTINGS_CHANGED_EVENT_CHANNEL,
] as const

export type IpcInvokeChannel = (typeof IPC_INVOKE_CHANNELS)[number]
export type IpcEventChannel = (typeof IPC_EVENT_CHANNELS)[number]

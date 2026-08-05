export const IPC_INVOKE_CHANNELS = [
  'app:get-runtime-info',
  'app:open-external-url',
  'service:get-status',
  'service:restart',
  'connection:get-status',
  'connection:connect',
  'connection:disconnect',
  'connection:respond-to-request',
  'pairing:get-pending',
  'pairing:respond',
  'trusted-devices:list',
  'trusted-devices:revoke',
  'trusted-devices:clear',
  'recent-devices:list',
  'recent-devices:update-alias',
  'recent-devices:remove',
  'recent-devices:clear',
  'discovery:get-devices',
  'clipboard:read-text',
  'clipboard:write-text',
  'transfer:select-files',
  'transfer:select-folder',
  'transfer:register-dropped-files',
  'transfer:register-dropped-items',
  'transfer:get-tasks',
  'transfer:send-text',
  'transfer:offer-files',
  'transfer:offer-folder',
  'transfer:enqueue',
  'transfer:cancel-queued',
  'transfer:respond-to-offer',
  'transfer:cancel',
  'transfer:pause',
  'transfer:resume',
  'transfer:retry',
  'transfer:show-received-file',
  'history:list',
  'history:get-stats',
  'history:delete',
  'history:preview-cleanup',
  'history:cleanup',
  'history:clear',
  'diagnostics:get-summary',
  'diagnostics:export-report',
  'diagnostics:open-data-directory',
  'diagnostics:open-log-directory',
  'diagnostics:get-log-stats',
  'diagnostics:clear-logs',
  'settings:get',
  'settings:update',
  'settings:select-receive-directory',
] as const

export const SERVICE_STATUS_CHANGED_EVENT_CHANNEL = 'service:status-changed' as const
export const CONNECTION_STATE_CHANGED_EVENT_CHANNEL = 'connection:state-changed' as const
export const CONNECTION_INCOMING_REQUEST_EVENT_CHANNEL = 'connection:incoming-request' as const
export const PAIRING_CHANGED_EVENT_CHANNEL = 'pairing:changed' as const
export const TRUSTED_DEVICES_CHANGED_EVENT_CHANNEL = 'trusted-devices:changed' as const
export const TEXT_RECEIVED_EVENT_CHANNEL = 'transfer:text-received' as const
export const TRANSFER_TASK_CHANGED_EVENT_CHANNEL = 'transfer:task-changed' as const
export const TRANSFER_QUEUE_CHANGED_EVENT_CHANNEL = 'transfer:queue-changed' as const
export const TEXT_TASK_CHANGED_EVENT_CHANNEL = 'transfer:text-task-changed' as const
export const FILE_OFFER_RECEIVED_EVENT_CHANNEL = 'transfer:offer-received' as const
export const SETTINGS_CHANGED_EVENT_CHANNEL = 'settings:changed' as const
export const DISCOVERY_DEVICES_CHANGED_EVENT_CHANNEL = 'discovery:devices-changed' as const

export const IPC_EVENT_CHANNELS = [
  SERVICE_STATUS_CHANGED_EVENT_CHANNEL,
  CONNECTION_STATE_CHANGED_EVENT_CHANNEL,
  CONNECTION_INCOMING_REQUEST_EVENT_CHANNEL,
  PAIRING_CHANGED_EVENT_CHANNEL,
  TRUSTED_DEVICES_CHANGED_EVENT_CHANNEL,
  TRANSFER_TASK_CHANGED_EVENT_CHANNEL,
  TRANSFER_QUEUE_CHANGED_EVENT_CHANNEL,
  TEXT_TASK_CHANGED_EVENT_CHANNEL,
  TEXT_RECEIVED_EVENT_CHANNEL,
  FILE_OFFER_RECEIVED_EVENT_CHANNEL,
  SETTINGS_CHANGED_EVENT_CHANNEL,
  DISCOVERY_DEVICES_CHANGED_EVENT_CHANNEL,
] as const

export type IpcInvokeChannel = (typeof IPC_INVOKE_CHANNELS)[number]
export type IpcEventChannel = (typeof IPC_EVENT_CHANNELS)[number]

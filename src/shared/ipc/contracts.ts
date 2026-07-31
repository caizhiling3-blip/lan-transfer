import type {
  AppSettingsDto,
  ConnectionStatusDto,
  DeviceInfo,
  DiagnosticsSummaryDto,
  DeviceId,
  DiscoveredDeviceDto,
  FileId,
  FileMetadata,
  HistoryEntryDto,
  HistoryCleanupCriteriaDto,
  HistoryFilterDto,
  HistoryStatsDto,
  IncomingConnectionRequestDto,
  MessageId,
  LogStatsDto,
  OperationResult,
  QueueItemId,
  RequestId,
  RecentDeviceDto,
  RuntimeInfoDto,
  SelectedDirectoryDto,
  SelectedFileDto,
  SelectedFolderDto,
  SelectedTransferItemDto,
  ServiceStatusDto,
  TransferId,
  TransferTaskDto,
  TransferQueueItemDto,
  TextTransferTaskDto,
} from '../types'

interface InvokeContract<TRequest, TResponse> {
  readonly request: TRequest
  readonly response: OperationResult<TResponse>
}

export interface IpcInvokeMap {
  readonly 'app:get-runtime-info': InvokeContract<undefined, RuntimeInfoDto>
  readonly 'app:open-external-url': InvokeContract<{ readonly url: string }, undefined>
  readonly 'service:get-status': InvokeContract<undefined, ServiceStatusDto>
  readonly 'service:restart': InvokeContract<{ readonly port: number }, ServiceStatusDto>
  readonly 'connection:get-status': InvokeContract<undefined, ConnectionStatusDto>
  readonly 'connection:connect': InvokeContract<
    { readonly host: string; readonly port: number },
    ConnectionStatusDto
  >
  readonly 'connection:disconnect': InvokeContract<undefined, undefined>
  readonly 'connection:respond-to-request': InvokeContract<
    { readonly requestId: RequestId; readonly decision: 'accept' | 'reject' },
    ConnectionStatusDto
  >
  readonly 'recent-devices:list': InvokeContract<undefined, readonly RecentDeviceDto[]>
  readonly 'recent-devices:update-alias': InvokeContract<
    { readonly deviceId: DeviceId; readonly alias: string | null },
    readonly RecentDeviceDto[]
  >
  readonly 'recent-devices:remove': InvokeContract<
    { readonly deviceId: DeviceId },
    readonly RecentDeviceDto[]
  >
  readonly 'recent-devices:clear': InvokeContract<undefined, undefined>
  readonly 'discovery:get-devices': InvokeContract<undefined, readonly DiscoveredDeviceDto[]>
  readonly 'clipboard:read-text': InvokeContract<undefined, string>
  readonly 'clipboard:write-text': InvokeContract<{ readonly text: string }, undefined>
  readonly 'transfer:select-files': InvokeContract<
    { readonly multiple: boolean },
    readonly SelectedFileDto[]
  >
  readonly 'transfer:select-folder': InvokeContract<undefined, SelectedFolderDto | null>
  readonly 'transfer:register-dropped-files': InvokeContract<
    { readonly paths: readonly string[] },
    readonly SelectedFileDto[]
  >
  readonly 'transfer:register-dropped-items': InvokeContract<
    { readonly paths: readonly string[] },
    readonly SelectedTransferItemDto[]
  >
  readonly 'transfer:send-text': InvokeContract<
    { readonly content: string; readonly contentType: 'text' | 'link' },
    TransferTaskDto
  >
  readonly 'transfer:offer-files': InvokeContract<
    { readonly selectionTokens: readonly string[] },
    TransferTaskDto
  >
  readonly 'transfer:offer-folder': InvokeContract<
    { readonly selectionToken: string },
    TransferTaskDto
  >
  readonly 'transfer:enqueue': InvokeContract<
    {
      readonly text?: {
        readonly content: string
        readonly contentType: 'text' | 'link'
      }
      readonly fileSelectionTokens: readonly string[]
      readonly folderSelectionTokens: readonly string[]
    },
    readonly TransferQueueItemDto[]
  >
  readonly 'transfer:cancel-queued': InvokeContract<
    { readonly queueItemId: QueueItemId },
    readonly TransferQueueItemDto[]
  >
  readonly 'transfer:respond-to-offer': InvokeContract<
    {
      readonly transferId: TransferId
      readonly decision: 'accept' | 'reject'
      readonly directoryToken?: string
    },
    TransferTaskDto
  >
  readonly 'transfer:cancel': InvokeContract<
    { readonly transferId: TransferId; readonly fileId?: FileId },
    TransferTaskDto
  >
  readonly 'transfer:retry': InvokeContract<{ readonly transferId: TransferId }, TransferTaskDto>
  readonly 'transfer:show-received-file': InvokeContract<
    { readonly transferId: TransferId; readonly fileId?: FileId },
    undefined
  >
  readonly 'history:list': InvokeContract<HistoryFilterDto, readonly HistoryEntryDto[]>
  readonly 'history:get-stats': InvokeContract<
    { readonly criteria?: HistoryCleanupCriteriaDto },
    HistoryStatsDto
  >
  readonly 'history:delete': InvokeContract<{ readonly historyIds: readonly string[] }, number>
  readonly 'history:preview-cleanup': InvokeContract<HistoryCleanupCriteriaDto, number>
  readonly 'history:cleanup': InvokeContract<HistoryCleanupCriteriaDto, number>
  readonly 'history:clear': InvokeContract<undefined, undefined>
  readonly 'diagnostics:get-summary': InvokeContract<undefined, DiagnosticsSummaryDto>
  readonly 'diagnostics:export-report': InvokeContract<undefined, boolean>
  readonly 'diagnostics:open-data-directory': InvokeContract<undefined, undefined>
  readonly 'diagnostics:open-log-directory': InvokeContract<undefined, undefined>
  readonly 'diagnostics:get-log-stats': InvokeContract<undefined, LogStatsDto>
  readonly 'diagnostics:clear-logs': InvokeContract<undefined, number>
  readonly 'settings:get': InvokeContract<undefined, AppSettingsDto>
  readonly 'settings:update': InvokeContract<
    {
      readonly deviceName?: string
      readonly receiveDirectoryToken?: string
      readonly servicePort?: number
      readonly maxFileSizeBytes?: number
      readonly historyLimit?: number
      readonly historyRetentionDays?: number | null
      readonly logRetentionDays?: number
    },
    AppSettingsDto
  >
  readonly 'settings:select-receive-directory': InvokeContract<undefined, SelectedDirectoryDto>
}

export interface TextReceivedDto {
  readonly messageId: MessageId
  readonly peer: DeviceInfo
  readonly content: string
  readonly contentType: 'text' | 'link'
  readonly receivedAt: number
}

export interface FileOfferReceivedDto {
  readonly transferId: TransferId
  readonly peer: DeviceInfo
  readonly files: readonly FileMetadata[]
  readonly receivedAt: number
}

export interface FolderOfferReceivedDto {
  readonly transferId: TransferId
  readonly peer: DeviceInfo
  readonly displayName: string
  readonly fileCount: number
  readonly emptyDirectoryCount: number
  readonly totalSize: number
  readonly receivedAt: number
}

export type TransferOfferReceivedDto = FileOfferReceivedDto | FolderOfferReceivedDto

export interface IpcEventMap {
  readonly 'service:status-changed': ServiceStatusDto
  readonly 'connection:state-changed': ConnectionStatusDto
  readonly 'connection:incoming-request': IncomingConnectionRequestDto
  readonly 'transfer:task-changed': TransferTaskDto
  readonly 'transfer:queue-changed': readonly TransferQueueItemDto[]
  readonly 'transfer:text-task-changed': TextTransferTaskDto
  readonly 'transfer:text-received': TextReceivedDto
  readonly 'transfer:offer-received': TransferOfferReceivedDto
  readonly 'settings:changed': AppSettingsDto
  readonly 'discovery:devices-changed': readonly DiscoveredDeviceDto[]
}

export type IpcInvokeRequest<TChannel extends keyof IpcInvokeMap> =
  IpcInvokeMap[TChannel]['request']

export type IpcInvokeResponse<TChannel extends keyof IpcInvokeMap> =
  IpcInvokeMap[TChannel]['response']

export type IpcEventPayload<TChannel extends keyof IpcEventMap> = IpcEventMap[TChannel]

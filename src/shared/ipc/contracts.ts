import type {
  AppSettingsDto,
  ConnectionStatusDto,
  DeviceInfo,
  DiscoveredDeviceDto,
  FileId,
  FileMetadata,
  HistoryEntryDto,
  HistoryFilterDto,
  IncomingConnectionRequestDto,
  MessageId,
  OperationResult,
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
  readonly 'connection:list-recent-devices': InvokeContract<undefined, readonly RecentDeviceDto[]>
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
  readonly 'history:clear': InvokeContract<undefined, undefined>
  readonly 'settings:get': InvokeContract<undefined, AppSettingsDto>
  readonly 'settings:update': InvokeContract<
    {
      readonly deviceName?: string
      readonly receiveDirectoryToken?: string
      readonly servicePort?: number
      readonly maxFileSizeBytes?: number
      readonly historyLimit?: number
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

export interface IpcEventMap {
  readonly 'service:status-changed': ServiceStatusDto
  readonly 'connection:state-changed': ConnectionStatusDto
  readonly 'connection:incoming-request': IncomingConnectionRequestDto
  readonly 'transfer:task-changed': TransferTaskDto
  readonly 'transfer:text-received': TextReceivedDto
  readonly 'transfer:offer-received': FileOfferReceivedDto
  readonly 'settings:changed': AppSettingsDto
  readonly 'discovery:devices-changed': readonly DiscoveredDeviceDto[]
}

export type IpcInvokeRequest<TChannel extends keyof IpcInvokeMap> =
  IpcInvokeMap[TChannel]['request']

export type IpcInvokeResponse<TChannel extends keyof IpcInvokeMap> =
  IpcInvokeMap[TChannel]['response']

export type IpcEventPayload<TChannel extends keyof IpcEventMap> = IpcEventMap[TChannel]

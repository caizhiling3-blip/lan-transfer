import type {
  AppSettingsDto,
  DiscoveredDeviceDto,
  HistoryFilterDto,
  IpcEventMap,
  IpcInvokeResponse,
  OperatingSystem,
  RequestId,
  TransferId,
} from '@shared/index'
import type { FileId } from '@shared/types'

export type Unsubscribe = () => void

type EventListener<TChannel extends keyof IpcEventMap> = (payload: IpcEventMap[TChannel]) => void

export interface LanTransferApi {
  readonly platform: OperatingSystem
  readonly app: {
    getRuntimeInfo(): Promise<IpcInvokeResponse<'app:get-runtime-info'>>
    openExternalUrl(url: string): Promise<IpcInvokeResponse<'app:open-external-url'>>
  }
  readonly service: {
    getStatus(): Promise<IpcInvokeResponse<'service:get-status'>>
    restart(port: number): Promise<IpcInvokeResponse<'service:restart'>>
    onStatusChanged(listener: EventListener<'service:status-changed'>): Unsubscribe
  }
  readonly connection: {
    getStatus(): Promise<IpcInvokeResponse<'connection:get-status'>>
    connect(host: string, port: number): Promise<IpcInvokeResponse<'connection:connect'>>
    disconnect(): Promise<IpcInvokeResponse<'connection:disconnect'>>
    respondToRequest(
      requestId: RequestId,
      decision: 'accept' | 'reject',
    ): Promise<IpcInvokeResponse<'connection:respond-to-request'>>
    listRecentDevices(): Promise<IpcInvokeResponse<'connection:list-recent-devices'>>
    onStateChanged(listener: EventListener<'connection:state-changed'>): Unsubscribe
    onIncomingRequest(listener: EventListener<'connection:incoming-request'>): Unsubscribe
  }
  readonly discovery: {
    getDevices(): Promise<IpcInvokeResponse<'discovery:get-devices'>>
    onDevicesChanged(listener: (devices: readonly DiscoveredDeviceDto[]) => void): Unsubscribe
  }
  readonly clipboard: {
    readText(): Promise<IpcInvokeResponse<'clipboard:read-text'>>
    writeText(text: string): Promise<IpcInvokeResponse<'clipboard:write-text'>>
  }
  readonly transfer: {
    selectFiles(multiple: boolean): Promise<IpcInvokeResponse<'transfer:select-files'>>
    selectFolder(): Promise<IpcInvokeResponse<'transfer:select-folder'>>
    registerDroppedFiles(
      files: readonly File[],
    ): Promise<IpcInvokeResponse<'transfer:register-dropped-files'>>
    registerDroppedItems(
      files: readonly File[],
    ): Promise<IpcInvokeResponse<'transfer:register-dropped-items'>>
    sendText(
      content: string,
      contentType: 'text' | 'link',
    ): Promise<IpcInvokeResponse<'transfer:send-text'>>
    offerFiles(
      selectionTokens: readonly string[],
    ): Promise<IpcInvokeResponse<'transfer:offer-files'>>
    respondToOffer(
      transferId: TransferId,
      decision: 'accept' | 'reject',
      directoryToken?: string,
    ): Promise<IpcInvokeResponse<'transfer:respond-to-offer'>>
    cancel(transferId: TransferId, fileId?: FileId): Promise<IpcInvokeResponse<'transfer:cancel'>>
    retry(transferId: TransferId): Promise<IpcInvokeResponse<'transfer:retry'>>
    showReceivedFile(
      transferId: TransferId,
      fileId?: FileId,
    ): Promise<IpcInvokeResponse<'transfer:show-received-file'>>
    onTaskChanged(listener: EventListener<'transfer:task-changed'>): Unsubscribe
    onTextReceived(listener: EventListener<'transfer:text-received'>): Unsubscribe
    onOfferReceived(listener: EventListener<'transfer:offer-received'>): Unsubscribe
  }
  readonly history: {
    list(filter: HistoryFilterDto): Promise<IpcInvokeResponse<'history:list'>>
    clear(): Promise<IpcInvokeResponse<'history:clear'>>
  }
  readonly settings: {
    get(): Promise<IpcInvokeResponse<'settings:get'>>
    update(
      patch: Partial<
        Pick<AppSettingsDto, 'deviceName' | 'servicePort' | 'maxFileSizeBytes' | 'historyLimit'>
      > & { readonly receiveDirectoryToken?: string },
    ): Promise<IpcInvokeResponse<'settings:update'>>
    selectReceiveDirectory(): Promise<IpcInvokeResponse<'settings:select-receive-directory'>>
    onChanged(listener: EventListener<'settings:changed'>): Unsubscribe
  }
}

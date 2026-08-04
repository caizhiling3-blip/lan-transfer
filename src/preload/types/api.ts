import type {
  AppSettingsDto,
  DiscoveredDeviceDto,
  HistoryFilterDto,
  HistoryCleanupCriteriaDto,
  IpcEventMap,
  IpcInvokeResponse,
  OperatingSystem,
  DeviceId,
  QueueItemId,
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
    onStateChanged(listener: EventListener<'connection:state-changed'>): Unsubscribe
    onIncomingRequest(listener: EventListener<'connection:incoming-request'>): Unsubscribe
  }
  readonly pairing: {
    getPending(): Promise<IpcInvokeResponse<'pairing:get-pending'>>
    respond(
      requestId: RequestId,
      decision: 'accept' | 'reject',
    ): Promise<IpcInvokeResponse<'pairing:respond'>>
    onChanged(listener: EventListener<'pairing:changed'>): Unsubscribe
  }
  readonly trustedDevices: {
    list(): Promise<IpcInvokeResponse<'trusted-devices:list'>>
    revoke(deviceId: DeviceId): Promise<IpcInvokeResponse<'trusted-devices:revoke'>>
    clear(): Promise<IpcInvokeResponse<'trusted-devices:clear'>>
    onChanged(listener: EventListener<'trusted-devices:changed'>): Unsubscribe
  }
  readonly recentDevices: {
    list(): Promise<IpcInvokeResponse<'recent-devices:list'>>
    updateAlias(
      deviceId: DeviceId,
      alias: string | null,
    ): Promise<IpcInvokeResponse<'recent-devices:update-alias'>>
    remove(deviceId: DeviceId): Promise<IpcInvokeResponse<'recent-devices:remove'>>
    clear(): Promise<IpcInvokeResponse<'recent-devices:clear'>>
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
    offerFolder(selectionToken: string): Promise<IpcInvokeResponse<'transfer:offer-folder'>>
    enqueue(request: {
      readonly text?: {
        readonly content: string
        readonly contentType: 'text' | 'link'
      }
      readonly fileSelectionTokens: readonly string[]
      readonly folderSelectionTokens: readonly string[]
    }): Promise<IpcInvokeResponse<'transfer:enqueue'>>
    cancelQueued(queueItemId: QueueItemId): Promise<IpcInvokeResponse<'transfer:cancel-queued'>>
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
    onQueueChanged(listener: EventListener<'transfer:queue-changed'>): Unsubscribe
    onTextTaskChanged(listener: EventListener<'transfer:text-task-changed'>): Unsubscribe
    onTextReceived(listener: EventListener<'transfer:text-received'>): Unsubscribe
    onOfferReceived(listener: EventListener<'transfer:offer-received'>): Unsubscribe
  }
  readonly history: {
    list(filter: HistoryFilterDto): Promise<IpcInvokeResponse<'history:list'>>
    getStats(criteria?: HistoryCleanupCriteriaDto): Promise<IpcInvokeResponse<'history:get-stats'>>
    delete(historyIds: readonly string[]): Promise<IpcInvokeResponse<'history:delete'>>
    previewCleanup(
      criteria: HistoryCleanupCriteriaDto,
    ): Promise<IpcInvokeResponse<'history:preview-cleanup'>>
    cleanup(criteria: HistoryCleanupCriteriaDto): Promise<IpcInvokeResponse<'history:cleanup'>>
    clear(): Promise<IpcInvokeResponse<'history:clear'>>
  }
  readonly diagnostics: {
    getSummary(): Promise<IpcInvokeResponse<'diagnostics:get-summary'>>
    exportReport(): Promise<IpcInvokeResponse<'diagnostics:export-report'>>
    openDataDirectory(): Promise<IpcInvokeResponse<'diagnostics:open-data-directory'>>
    openLogDirectory(): Promise<IpcInvokeResponse<'diagnostics:open-log-directory'>>
    getLogStats(): Promise<IpcInvokeResponse<'diagnostics:get-log-stats'>>
    clearLogs(): Promise<IpcInvokeResponse<'diagnostics:clear-logs'>>
  }
  readonly settings: {
    get(): Promise<IpcInvokeResponse<'settings:get'>>
    update(
      patch: Partial<
        Pick<
          AppSettingsDto,
          | 'deviceName'
          | 'servicePort'
          | 'maxFileSizeBytes'
          | 'historyLimit'
          | 'historyRetentionDays'
          | 'logRetentionDays'
        >
      > & { readonly receiveDirectoryToken?: string },
    ): Promise<IpcInvokeResponse<'settings:update'>>
    selectReceiveDirectory(): Promise<IpcInvokeResponse<'settings:select-receive-directory'>>
    onChanged(listener: EventListener<'settings:changed'>): Unsubscribe
  }
}

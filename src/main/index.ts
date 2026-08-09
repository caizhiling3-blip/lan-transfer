import { hostname } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { app, BrowserWindow, dialog, Notification, safeStorage } from 'electron'
import electronUpdater from 'electron-updater'

import {
  CONNECTION_INCOMING_REQUEST_EVENT_CHANNEL,
  CONNECTION_STATE_CHANGED_EVENT_CHANNEL,
  DISCOVERY_DEVICES_CHANGED_EVENT_CHANNEL,
  FILE_OFFER_RECEIVED_EVENT_CHANNEL,
  PAIRING_CHANGED_EVENT_CHANNEL,
  SERVICE_STATUS_CHANGED_EVENT_CHANNEL,
  SETTINGS_CHANGED_EVENT_CHANNEL,
  TEXT_RECEIVED_EVENT_CHANNEL,
  TEXT_TASK_CHANGED_EVENT_CHANNEL,
  TRANSFER_QUEUE_CHANGED_EVENT_CHANNEL,
  TRANSFER_TASK_CHANGED_EVENT_CHANNEL,
  TRUSTED_DEVICES_CHANGED_EVENT_CHANNEL,
  UPDATE_STATUS_CHANGED_EVENT_CHANNEL,
} from '@shared/ipc'

import { createMainWindow, DeviceIdentity, TransferNotificationCoordinator } from './app'
import { DiscoveryManager } from './discovery'
import {
  cleanupStaleTemporaryFiles,
  cleanupStaleFolderArtifacts,
  FileAccessRegistry,
  FileTransferCoordinator,
  FolderTransferCoordinator,
  TransferPowerSaveController,
  TransferQueueCoordinator,
} from './file-transfer'
import {
  registerConnectionIpcHandlers,
  registerDiscoveryIpcHandlers,
  registerDiagnosticsIpcHandlers,
  registerFoundationIpcHandlers,
  registerPairingIpcHandlers,
  registerFileTransferIpcHandlers,
  registerRuntimeIpcHandlers,
  registerServiceIpcHandlers,
  registerSettingsIpcHandlers,
  registerTextIpcHandlers,
  registerUpdateIpcHandlers,
  setIpcAvailabilityProvider,
} from './ipc'
import { ServiceManager } from './server'
import { DiagnosticsService, getDiagnosticsPlatform } from './diagnostics'
import { getActiveLogFilePath, initializeLogger, logger, LogLifecycle } from './logger'
import { PairingCoordinator } from './pairing'
import {
  HistoryStore,
  IdentityStore,
  RecentDevicesStore,
  RecoverableTransfersStore,
  SessionHistory,
  SettingsStore,
  TrustedDevicesStore,
  UpdateSettingsStore,
} from './storage'
import { UpdateService } from './update'
import { ConnectionManager } from './websocket'

const { autoUpdater } = electronUpdater
const currentDirectory = dirname(fileURLToPath(import.meta.url))
let mainWindow: BrowserWindow | null = null
let serviceManager: ServiceManager | null = null
let connectionManager: ConnectionManager | null = null
let fileTransferCoordinator: FileTransferCoordinator | null = null
let folderTransferCoordinator: FolderTransferCoordinator | null = null
let discoveryManager: DiscoveryManager | null = null
let transferPowerSaveController: TransferPowerSaveController | null = null
let transferQueueCoordinator: TransferQueueCoordinator | null = null
let unsubscribeFromService: (() => void) | null = null
let applicationUnsubscribers: readonly (() => void)[] = []
let isQuitting = false
let updateInstallRequested = false
let installPreparedUpdate: (() => boolean) | null = null

setIpcAvailabilityProvider(() => !isQuitting)

const sendToRenderer = (channel: string, payload: unknown): void => {
  if (mainWindow !== null && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload)
  }
}

const openMainWindow = (): void => {
  mainWindow = createMainWindow({
    preloadPath: join(currentDirectory, 'index.mjs'),
    rendererFilePath: join(currentDirectory, '../dist/index.html'),
    ...(process.env.VITE_DEV_SERVER_URL === undefined
      ? {}
      : { rendererUrl: process.env.VITE_DEV_SERVER_URL }),
  })

  mainWindow.once('closed', () => {
    mainWindow = null
  })
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    logger.error('renderer_process_gone', new Error(details.reason), {
      exitCode: details.exitCode,
    })
  })
  mainWindow.webContents.once('did-finish-load', () => {
    if (fileTransferCoordinator === null || folderTransferCoordinator === null) return
    for (const task of fileTransferCoordinator.getTasks()) {
      sendToRenderer(TRANSFER_TASK_CHANGED_EVENT_CHANNEL, task)
    }
    const pendingOffer = fileTransferCoordinator.getPendingOffer()
    if (pendingOffer !== null) sendToRenderer(FILE_OFFER_RECEIVED_EVENT_CHANNEL, pendingOffer)
    for (const task of folderTransferCoordinator.getTasks()) {
      sendToRenderer(TRANSFER_TASK_CHANGED_EVENT_CHANNEL, task)
    }
    const pendingFolderOffer = folderTransferCoordinator.getPendingOffer()
    if (pendingFolderOffer !== null) {
      sendToRenderer(FILE_OFFER_RECEIVED_EVENT_CHANNEL, pendingFolderOffer)
    }
    if (discoveryManager !== null) {
      sendToRenderer(DISCOVERY_DEVICES_CHANGED_EVENT_CHANNEL, discoveryManager.getDevices())
    }
    if (transferQueueCoordinator !== null) {
      sendToRenderer(TRANSFER_QUEUE_CHANGED_EVENT_CHANNEL, transferQueueCoordinator.getItems())
    }
  })
}

void app.whenReady().then(async () => {
  initializeLogger()
  logger.info('application_started', {
    appVersion: app.getVersion(),
    operatingSystem: process.platform,
  })
  process.on('uncaughtException', (error) => logger.error('uncaught_exception', error))
  process.on('unhandledRejection', (error) => logger.error('unhandled_rejection', error))
  const settingsStore = new SettingsStore(
    app.getPath('userData'),
    hostname(),
    app.getPath('downloads'),
  )
  const updateSettingsStore = new UpdateSettingsStore(app.getPath('userData'))
  const historyStore = new HistoryStore(app.getPath('userData'))
  const recentDevices = new RecentDevicesStore(app.getPath('userData'))
  const identityStore = new IdentityStore(app.getPath('userData'), safeStorage)
  const trustedDevices = new TrustedDevicesStore(app.getPath('userData'))
  const recoverableTransfers = new RecoverableTransfersStore(app.getPath('userData'), safeStorage)
  await recoverableTransfers.pruneExpired()
  const loadedRecoveryRecords = recoverableTransfers.load()
  const recoveryRecords = loadedRecoveryRecords.filter(
    (record) => trustedDevices.get(record.peerDeviceId) !== null,
  )
  await Promise.all(
    loadedRecoveryRecords
      .filter((record) => trustedDevices.get(record.peerDeviceId) === null)
      .map((record) => recoverableTransfers.discard(record.transferId)),
  )
  const protectedRecoveryPaths = new Set(recoveryRecords.flatMap((record) => record.stagingPaths))
  const pairingCoordinator = new PairingCoordinator(trustedDevices)
  logger.info('secure_identity_ready', { trustedDeviceCount: trustedDevices.list().length })
  const logLifecycle = new LogLifecycle(app.getPath('logs'), getActiveLogFilePath)
  const sessionHistory = new SessionHistory(
    () => settingsStore.getSettings().historyLimit,
    historyStore.load(),
    (entries) => historyStore.save(entries),
    () => settingsStore.getSettings().historyRetentionDays,
  )
  const deviceIdentity = new DeviceIdentity(settingsStore)
  const activeServiceManager = new ServiceManager(settingsStore.getSettings().servicePort)
  const activeConnectionManager = new ConnectionManager(
    () => deviceIdentity.getDeviceInfo(activeServiceManager.getStatus()),
    identityStore,
    pairingCoordinator,
  )
  const fileAccessRegistry = new FileAccessRegistry(
    () => settingsStore.getReceiveDirectory(),
    () => settingsStore.getSettings().maxFileSizeBytes,
    [app.getPath('userData'), app.getAppPath()],
  )
  const activeFileTransferCoordinator = new FileTransferCoordinator(
    activeConnectionManager,
    fileAccessRegistry,
    sessionHistory,
    () => settingsStore.getSettings().maxFileSizeBytes,
    () => folderTransferCoordinator?.hasActiveTransfers() !== true,
    recoverableTransfers,
  )
  const activeFolderTransferCoordinator = new FolderTransferCoordinator(
    activeConnectionManager,
    fileAccessRegistry,
    () => !activeFileTransferCoordinator.hasActiveTransfers(),
    sessionHistory,
    recoverableTransfers,
  )
  await activeFileTransferCoordinator.restoreRecoverableTransfers(recoveryRecords)
  await activeFolderTransferCoordinator.restoreRecoverableTransfers(recoveryRecords)
  const activeDiscoveryManager = new DiscoveryManager(
    () => deviceIdentity.getDeviceInfo(activeServiceManager.getStatus()),
    (error) => logger.warn('device_discovery_error', { error: String(error) }),
  )
  const activeTransferPowerSaveController = new TransferPowerSaveController()
  const activeTransferQueueCoordinator = new TransferQueueCoordinator(
    activeConnectionManager,
    fileAccessRegistry,
    activeFileTransferCoordinator,
    activeFolderTransferCoordinator,
    sessionHistory,
  )
  const diagnosticsService = new DiagnosticsService(
    async () => {
      const historyStats = sessionHistory.getStats({}, historyStore.getStorageBytes())
      const logStats = await logLifecycle.getStats()
      const activeTasks = [
        ...activeFileTransferCoordinator.getTasks(),
        ...activeFolderTransferCoordinator.getTasks(),
      ].filter((task) => !['completed', 'failed', 'cancelled', 'rejected'].includes(task.status))
      const activeTaskIds = new Set(activeTasks.map((task) => task.transferId))
      const queuedTaskCount = activeTransferQueueCoordinator
        .getItems()
        .filter(
          (item) =>
            item.status !== 'failed' &&
            (item.transferId === undefined || !activeTaskIds.has(item.transferId)),
        ).length
      return {
        appVersion: app.getVersion(),
        platform: getDiagnosticsPlatform(),
        architecture: process.arch,
        service: activeServiceManager.getStatus(),
        connectionState: activeConnectionManager.getStatus().state,
        discoveryRunning: activeDiscoveryManager.isRunning(),
        activeTransferCount: activeTasks.length + queuedTaskCount,
        recoverableTransferCount: recoverableTransfers.load().length,
        historyEntries: historyStats.totalEntries,
        historyStorageBytes: historyStats.storageBytes,
        logFiles: logStats.fileCount,
        logStorageBytes: logStats.storageBytes,
      }
    },
    logLifecycle,
    app.getPath('userData'),
    app.getPath('logs'),
  )
  const notificationCoordinator = new TransferNotificationCoordinator(
    () => mainWindow === null || mainWindow.isDestroyed() || !mainWindow.isFocused(),
    ({ title, body }) => {
      if (!Notification.isSupported()) return
      try {
        const notification = new Notification({ title, body })
        notification.on('click', () => {
          if (mainWindow === null || mainWindow.isDestroyed()) openMainWindow()
          if (mainWindow === null || mainWindow.isDestroyed()) return
          if (mainWindow.isMinimized()) mainWindow.restore()
          mainWindow.show()
          mainWindow.focus()
        })
        notification.show()
      } catch (error) {
        logger.warn('notification_failed', { error: String(error) })
      }
    },
  )
  const updateService = new UpdateService(autoUpdater, app.getVersion(), updateSettingsStore)
  const transitionalConnectionStates = new Set([
    'connecting',
    'awaitingApproval',
    'authenticating',
    'pairingRequired',
    'disconnecting',
  ])
  updateService.setInstallSafetyProvider(
    () =>
      !isQuitting &&
      pairingCoordinator.getPending() === null &&
      !transitionalConnectionStates.has(activeConnectionManager.getStatus().state) &&
      !activeFileTransferCoordinator.hasActiveTransfers() &&
      !activeFolderTransferCoordinator.hasActiveTransfers() &&
      !activeTransferQueueCoordinator.hasPendingItems(),
  )
  installPreparedUpdate = () => updateService.installPreparedUpdate()
  if (app.isPackaged && (process.platform === 'darwin' || process.platform === 'win32')) {
    updateService.startAutomaticChecks()
  }
  serviceManager = activeServiceManager
  connectionManager = activeConnectionManager
  fileTransferCoordinator = activeFileTransferCoordinator
  folderTransferCoordinator = activeFolderTransferCoordinator
  discoveryManager = activeDiscoveryManager
  transferPowerSaveController = activeTransferPowerSaveController
  transferQueueCoordinator = activeTransferQueueCoordinator

  registerFoundationIpcHandlers(() => mainWindow)
  registerServiceIpcHandlers(() => mainWindow, activeServiceManager, settingsStore)
  registerRuntimeIpcHandlers(() => mainWindow, deviceIdentity, activeServiceManager)
  registerConnectionIpcHandlers(() => mainWindow, activeConnectionManager, recentDevices)
  registerPairingIpcHandlers(
    () => mainWindow,
    pairingCoordinator,
    trustedDevices,
    () => sendToRenderer(TRUSTED_DEVICES_CHANGED_EVENT_CHANNEL, trustedDevices.listSummaries()),
    async (deviceId) => {
      const connectedPeer = activeConnectionManager.getPeer()
      if (
        connectedPeer !== null &&
        (deviceId === undefined || connectedPeer.deviceId === deviceId)
      ) {
        activeConnectionManager.disconnect('user_requested')
      }
      const records = recoverableTransfers
        .load()
        .filter((record) => deviceId === undefined || record.peerDeviceId === deviceId)
      await Promise.all(records.map((record) => recoverableTransfers.discard(record.transferId)))
    },
  )
  registerDiscoveryIpcHandlers(() => mainWindow, activeDiscoveryManager)
  registerDiagnosticsIpcHandlers(() => mainWindow, diagnosticsService)
  registerTextIpcHandlers(
    () => mainWindow,
    activeConnectionManager,
    sessionHistory,
    () => historyStore.getStorageBytes(),
  )
  registerFileTransferIpcHandlers(
    () => mainWindow,
    fileAccessRegistry,
    activeFileTransferCoordinator,
    activeFolderTransferCoordinator,
    activeTransferQueueCoordinator,
  )
  registerSettingsIpcHandlers(
    () => mainWindow,
    settingsStore,
    activeServiceManager,
    fileAccessRegistry,
    sessionHistory,
  )
  registerUpdateIpcHandlers(
    () => mainWindow,
    updateService,
    updateSettingsStore,
    () => {
      if (!updateService.prepareInstall()) return false
      updateInstallRequested = true
      app.quit()
      return true
    },
  )
  openMainWindow()

  void logLifecycle
    .cleanupExpired(settingsStore.getSettings().logRetentionDays)
    .then((removed) => {
      if (removed > 0) logger.info('expired_logs_removed', { removed })
    })
    .catch((error: unknown) => logger.error('log_cleanup_failed', error))

  void fileAccessRegistry
    .resolveReceiveDirectory()
    .then(async (directoryPath) => {
      const [removedFiles, removedFolders] = await Promise.all([
        cleanupStaleTemporaryFiles(directoryPath, Date.now(), protectedRecoveryPaths),
        cleanupStaleFolderArtifacts(directoryPath, Date.now(), protectedRecoveryPaths),
      ])
      return { removedFiles, removedFolders }
    })
    .then(({ removedFiles, removedFolders }) => {
      if (
        removedFiles > 0 ||
        removedFolders.stagingDirectories > 0 ||
        removedFolders.incompleteDirectories > 0
      ) {
        logger.info('stale_temporary_artifacts_removed', {
          removedFiles,
          ...removedFolders,
        })
      }
    })
    .catch((error: unknown) => logger.error('temporary_file_cleanup_failed', error))

  unsubscribeFromService = activeServiceManager.subscribe((status) => {
    if (status.state === 'running') {
      logger.info('service_started', {
        port: status.port,
        listeningAddresses: status.ipAddresses,
      })
      activeDiscoveryManager.start()
    } else if (status.state === 'error') {
      logger.warn('service_failed', { port: status.port, errorCode: status.errorCode })
    }
    if (status.state !== 'running') activeDiscoveryManager.stop()
    sendToRenderer(SERVICE_STATUS_CHANGED_EVENT_CHANNEL, status)
  })
  const loggedTaskStatuses = new Map<string, string>()
  applicationUnsubscribers = [
    () => identityStore.shutdown(),
    () => pairingCoordinator.shutdown(),
    updateService.subscribe((status) => {
      sendToRenderer(UPDATE_STATUS_CHANGED_EVENT_CHANNEL, status)
    }),
    pairingCoordinator.subscribeRequests((request) => {
      updateService.refreshInstallReadiness()
      logger.info('device_pairing_requested', {
        requestId: request.requestId,
        peerDeviceId: request.peer.deviceId,
      })
      sendToRenderer(PAIRING_CHANGED_EVENT_CHANNEL, request)
    }),
    pairingCoordinator.subscribeCompletions((completion) => {
      updateService.refreshInstallReadiness()
      logger.info('device_pairing_completed', {
        requestId: completion.requestId,
        outcome: completion.outcome,
        errorCode: completion.errorCode,
      })
      sendToRenderer(PAIRING_CHANGED_EVENT_CHANNEL, null)
      if (completion.outcome === 'paired') {
        sendToRenderer(TRUSTED_DEVICES_CHANGED_EVENT_CHANNEL, trustedDevices.listSummaries())
      }
    }),
    settingsStore.subscribe((settings) => {
      sendToRenderer(SETTINGS_CHANGED_EVENT_CHANNEL, settings)
      void logLifecycle.cleanupExpired(settings.logRetentionDays).catch((error: unknown) => {
        logger.error('log_cleanup_failed', error)
      })
    }),
    activeConnectionManager.subscribeStatus((status) => {
      updateService.refreshInstallReadiness()
      if (status.state === 'connected' && status.peer !== undefined) recentDevices.add(status.peer)
      if (status.state === 'connected' && status.peer !== undefined) {
        logger.info('device_connected', {
          peerDeviceId: status.peer.deviceId,
          peerAddress: status.peer.ipAddress,
        })
      } else if (status.state === 'disconnected') {
        logger.info('device_disconnected', { errorCode: status.errorCode })
      }
      sendToRenderer(CONNECTION_STATE_CHANGED_EVENT_CHANNEL, status)
    }),
    activeConnectionManager.subscribeRequests((request) => {
      logger.info('device_connection_requested', {
        peerDeviceId: request.peer.deviceId,
        peerAddress: request.peer.ipAddress,
      })
      sendToRenderer(CONNECTION_INCOMING_REQUEST_EVENT_CHANNEL, request)
    }),
    activeConnectionManager.subscribeText((message) => {
      sessionHistory.add({
        direction: 'receive',
        kind: message.contentType,
        peer: message.peer,
        status: 'completed',
        textPreview: message.content,
        createdAt: message.receivedAt,
      })
      sendToRenderer(TEXT_RECEIVED_EVENT_CHANNEL, message)
      notificationCoordinator.notifyText(message)
    }),
    activeTransferQueueCoordinator.subscribe((items) => {
      updateService.refreshInstallReadiness()
      sendToRenderer(TRANSFER_QUEUE_CHANGED_EVENT_CHANNEL, items)
    }),
    activeTransferQueueCoordinator.subscribeTextTasks((task) => {
      sendToRenderer(TEXT_TASK_CHANGED_EVENT_CHANNEL, task)
    }),
    activeFileTransferCoordinator.subscribeTasks((task) => {
      updateService.refreshInstallReadiness()
      notificationCoordinator.notifyTask(task)
      if (loggedTaskStatuses.get(task.transferId) !== task.status) {
        loggedTaskStatuses.set(task.transferId, task.status)
        logger.info('transfer_status_changed', {
          transferId: task.transferId,
          direction: task.direction,
          kind: task.kind,
          status: task.status,
          totalBytes: task.totalBytes,
          fileCount: task.files.length,
          errorCode: task.errorCode,
        })
      }
      activeTransferPowerSaveController.sync(activeFileTransferCoordinator.getTasks())
      sendToRenderer(TRANSFER_TASK_CHANGED_EVENT_CHANNEL, task)
    }),
    activeFolderTransferCoordinator.subscribeTasks((task) => {
      updateService.refreshInstallReadiness()
      notificationCoordinator.notifyTask(task)
      if (loggedTaskStatuses.get(task.transferId) !== task.status) {
        loggedTaskStatuses.set(task.transferId, task.status)
        logger.info('transfer_status_changed', {
          transferId: task.transferId,
          direction: task.direction,
          kind: task.kind,
          status: task.status,
          totalBytes: task.totalBytes,
          fileCount: task.files.length,
          errorCode: task.errorCode,
        })
      }
      activeTransferPowerSaveController.sync([
        ...activeFileTransferCoordinator.getTasks(),
        ...activeFolderTransferCoordinator.getTasks(),
      ])
      sendToRenderer(TRANSFER_TASK_CHANGED_EVENT_CHANNEL, task)
    }),
    activeDiscoveryManager.subscribe((devices) => {
      sendToRenderer(DISCOVERY_DEVICES_CHANGED_EVENT_CHANNEL, devices)
    }),
    activeFileTransferCoordinator.subscribeOffers((offer) => {
      logger.info('file_offer_received', {
        transferId: offer.transferId,
        peerDeviceId: offer.peer.deviceId,
        fileCount: offer.files.length,
        totalBytes: offer.files.reduce((total, file) => total + file.size, 0),
      })
      sendToRenderer(FILE_OFFER_RECEIVED_EVENT_CHANNEL, offer)
      notificationCoordinator.notifyOffer(offer)
    }),
    activeFolderTransferCoordinator.subscribeOffers((offer) => {
      logger.info('folder_offer_received', {
        transferId: offer.transferId,
        peerDeviceId: offer.peer.deviceId,
        fileCount: offer.fileCount,
        totalBytes: offer.totalSize,
      })
      sendToRenderer(FILE_OFFER_RECEIVED_EVENT_CHANNEL, offer)
      notificationCoordinator.notifyOffer(offer)
    }),
  ]
  activeServiceManager.setConnectionHandler((webSocket, request) => {
    activeConnectionManager.acceptIncoming(webSocket, request)
  })
  activeServiceManager.setRequestHandler(
    (request, response) =>
      activeFolderTransferCoordinator.handleHttpRequest(request, response) ||
      activeFileTransferCoordinator.handleHttpRequest(request, response),
  )
  void activeServiceManager.start()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) openMainWindow()
  })
})

app.on('before-quit', (event) => {
  if (serviceManager === null || fileTransferCoordinator === null || connectionManager === null) {
    return
  }
  if (serviceManager.getStatus().state === 'stopped') {
    unsubscribeFromService?.()
    for (const unsubscribe of applicationUnsubscribers) unsubscribe()
    return
  }
  if (isQuitting) return

  if (
    fileTransferCoordinator.hasActiveTransfers() ||
    folderTransferCoordinator?.hasActiveTransfers() === true ||
    transferQueueCoordinator?.hasPendingItems() === true
  ) {
    const options = {
      type: 'warning' as const,
      title: '传输尚未完成',
      message: '仍有文件正在等待或传输中，退出后可在下次启动时继续。',
      detail: '恢复前会重新校验源文件和临时内容；也可以留在应用内等待完成。',
      buttons: ['继续传输', '保存状态并退出'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    }
    const choice =
      mainWindow === null || mainWindow.isDestroyed()
        ? dialog.showMessageBoxSync(options)
        : dialog.showMessageBoxSync(mainWindow, options)
    if (choice === 0) {
      event.preventDefault()
      return
    }
  }

  event.preventDefault()
  isQuitting = true
  logger.info('application_stopping')
  discoveryManager?.stop()
  transferPowerSaveController?.stop()
  transferQueueCoordinator?.shutdown()
  void fileTransferCoordinator
    .shutdown(true)
    .then(() => folderTransferCoordinator?.shutdown(true))
    .then(() => connectionManager?.disconnect('app_shutdown'))
    .then(() => serviceManager?.stop())
    .finally(() => {
      unsubscribeFromService?.()
      for (const unsubscribe of applicationUnsubscribers) unsubscribe()
      if (!updateInstallRequested || installPreparedUpdate?.() !== true) app.quit()
    })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

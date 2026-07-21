import { hostname } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { app, BrowserWindow } from 'electron'

import {
  CONNECTION_INCOMING_REQUEST_EVENT_CHANNEL,
  CONNECTION_STATE_CHANGED_EVENT_CHANNEL,
  FILE_OFFER_RECEIVED_EVENT_CHANNEL,
  SERVICE_STATUS_CHANGED_EVENT_CHANNEL,
  SETTINGS_CHANGED_EVENT_CHANNEL,
  TEXT_RECEIVED_EVENT_CHANNEL,
  TRANSFER_TASK_CHANGED_EVENT_CHANNEL,
} from '@shared/ipc'

import { createMainWindow, DeviceIdentity } from './app'
import { FileAccessRegistry, FileTransferCoordinator } from './file-transfer'
import {
  registerConnectionIpcHandlers,
  registerFoundationIpcHandlers,
  registerFileTransferIpcHandlers,
  registerRuntimeIpcHandlers,
  registerServiceIpcHandlers,
  registerSettingsIpcHandlers,
  registerTextIpcHandlers,
} from './ipc'
import { ServiceManager } from './server'
import { HistoryStore, RecentDevicesStore, SessionHistory, SettingsStore } from './storage'
import { ConnectionManager } from './websocket'

const currentDirectory = dirname(fileURLToPath(import.meta.url))
let mainWindow: BrowserWindow | null = null
let serviceManager: ServiceManager | null = null
let connectionManager: ConnectionManager | null = null
let fileTransferCoordinator: FileTransferCoordinator | null = null
let unsubscribeFromService: (() => void) | null = null
let applicationUnsubscribers: readonly (() => void)[] = []
let isQuitting = false

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
  mainWindow.webContents.once('did-finish-load', () => {
    if (fileTransferCoordinator === null) return
    for (const task of fileTransferCoordinator.getTasks()) {
      sendToRenderer(TRANSFER_TASK_CHANGED_EVENT_CHANNEL, task)
    }
    const pendingOffer = fileTransferCoordinator.getPendingOffer()
    if (pendingOffer !== null) sendToRenderer(FILE_OFFER_RECEIVED_EVENT_CHANNEL, pendingOffer)
  })
}

void app.whenReady().then(() => {
  const settingsStore = new SettingsStore(
    app.getPath('userData'),
    hostname(),
    app.getPath('downloads'),
  )
  const historyStore = new HistoryStore(app.getPath('userData'))
  const recentDevices = new RecentDevicesStore(app.getPath('userData'))
  const sessionHistory = new SessionHistory(
    () => settingsStore.getSettings().historyLimit,
    historyStore.load(),
    (entries) => historyStore.save(entries),
  )
  const deviceIdentity = new DeviceIdentity(settingsStore)
  const activeServiceManager = new ServiceManager(settingsStore.getSettings().servicePort)
  const activeConnectionManager = new ConnectionManager(() =>
    deviceIdentity.getDeviceInfo(activeServiceManager.getStatus()),
  )
  const fileAccessRegistry = new FileAccessRegistry(
    () => settingsStore.getReceiveDirectory(),
    () => settingsStore.getSettings().maxFileSizeBytes,
  )
  const activeFileTransferCoordinator = new FileTransferCoordinator(
    activeConnectionManager,
    fileAccessRegistry,
    sessionHistory,
    () => settingsStore.getSettings().maxFileSizeBytes,
  )
  serviceManager = activeServiceManager
  connectionManager = activeConnectionManager
  fileTransferCoordinator = activeFileTransferCoordinator

  registerFoundationIpcHandlers(() => mainWindow)
  registerServiceIpcHandlers(() => mainWindow, activeServiceManager, settingsStore)
  registerRuntimeIpcHandlers(() => mainWindow, deviceIdentity, activeServiceManager)
  registerConnectionIpcHandlers(() => mainWindow, activeConnectionManager, recentDevices)
  registerTextIpcHandlers(() => mainWindow, activeConnectionManager, sessionHistory)
  registerFileTransferIpcHandlers(
    () => mainWindow,
    fileAccessRegistry,
    activeFileTransferCoordinator,
  )
  registerSettingsIpcHandlers(
    () => mainWindow,
    settingsStore,
    activeServiceManager,
    fileAccessRegistry,
    sessionHistory,
  )
  openMainWindow()

  unsubscribeFromService = activeServiceManager.subscribe((status) => {
    sendToRenderer(SERVICE_STATUS_CHANGED_EVENT_CHANNEL, status)
  })
  applicationUnsubscribers = [
    settingsStore.subscribe((settings) => {
      sendToRenderer(SETTINGS_CHANGED_EVENT_CHANNEL, settings)
    }),
    activeConnectionManager.subscribeStatus((status) => {
      if (status.state === 'connected' && status.peer !== undefined) recentDevices.add(status.peer)
      sendToRenderer(CONNECTION_STATE_CHANGED_EVENT_CHANNEL, status)
    }),
    activeConnectionManager.subscribeRequests((request) => {
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
    }),
    activeFileTransferCoordinator.subscribeTasks((task) => {
      sendToRenderer(TRANSFER_TASK_CHANGED_EVENT_CHANNEL, task)
    }),
    activeFileTransferCoordinator.subscribeOffers((offer) => {
      sendToRenderer(FILE_OFFER_RECEIVED_EVENT_CHANNEL, offer)
    }),
  ]
  activeServiceManager.setConnectionHandler((webSocket, request) => {
    activeConnectionManager.acceptIncoming(webSocket, request)
  })
  activeServiceManager.setRequestHandler((request, response) =>
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

  event.preventDefault()
  isQuitting = true
  connectionManager.disconnect('app_shutdown')
  void fileTransferCoordinator
    .shutdown()
    .then(() => serviceManager?.stop())
    .finally(() => {
      unsubscribeFromService?.()
      for (const unsubscribe of applicationUnsubscribers) unsubscribe()
      app.quit()
    })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

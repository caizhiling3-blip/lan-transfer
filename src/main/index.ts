import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { app, BrowserWindow } from 'electron'

import { DEFAULT_SERVICE_PORT } from '@shared/constants'
import {
  CONNECTION_INCOMING_REQUEST_EVENT_CHANNEL,
  CONNECTION_STATE_CHANGED_EVENT_CHANNEL,
  FILE_OFFER_RECEIVED_EVENT_CHANNEL,
  SERVICE_STATUS_CHANGED_EVENT_CHANNEL,
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
  registerTextIpcHandlers,
} from './ipc'
import { ServiceManager } from './server'
import { SessionHistory } from './storage'
import { ConnectionManager } from './websocket'

const currentDirectory = dirname(fileURLToPath(import.meta.url))
let mainWindow: BrowserWindow | null = null
const serviceManager = new ServiceManager(DEFAULT_SERVICE_PORT)
const deviceIdentity = new DeviceIdentity()
const connectionManager = new ConnectionManager(() =>
  deviceIdentity.getDeviceInfo(serviceManager.getStatus()),
)
const sessionHistory = new SessionHistory()
const fileAccessRegistry = new FileAccessRegistry(() => app.getPath('downloads'))
const fileTransferCoordinator = new FileTransferCoordinator(
  connectionManager,
  fileAccessRegistry,
  sessionHistory,
)
let unsubscribeFromService: (() => void) | null = null
let connectionUnsubscribers: readonly (() => void)[] = []
let isQuitting = false

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
    if (mainWindow === null || mainWindow.isDestroyed()) return
    for (const task of fileTransferCoordinator.getTasks()) {
      mainWindow.webContents.send(TRANSFER_TASK_CHANGED_EVENT_CHANNEL, task)
    }
    const pendingOffer = fileTransferCoordinator.getPendingOffer()
    if (pendingOffer !== null) {
      mainWindow.webContents.send(FILE_OFFER_RECEIVED_EVENT_CHANNEL, pendingOffer)
    }
  })
}

void app.whenReady().then(() => {
  registerFoundationIpcHandlers(() => mainWindow)
  registerServiceIpcHandlers(() => mainWindow, serviceManager)
  registerRuntimeIpcHandlers(() => mainWindow, deviceIdentity, serviceManager)
  registerConnectionIpcHandlers(() => mainWindow, connectionManager)
  registerTextIpcHandlers(() => mainWindow, connectionManager, sessionHistory)
  registerFileTransferIpcHandlers(() => mainWindow, fileAccessRegistry, fileTransferCoordinator)
  openMainWindow()

  unsubscribeFromService = serviceManager.subscribe((status) => {
    if (mainWindow !== null && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(SERVICE_STATUS_CHANGED_EVENT_CHANNEL, status)
    }
  })
  connectionUnsubscribers = [
    connectionManager.subscribeStatus((status) => {
      if (mainWindow !== null && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(CONNECTION_STATE_CHANGED_EVENT_CHANNEL, status)
      }
    }),
    connectionManager.subscribeRequests((request) => {
      if (mainWindow !== null && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(CONNECTION_INCOMING_REQUEST_EVENT_CHANNEL, request)
      }
    }),
    connectionManager.subscribeText((message) => {
      sessionHistory.add({
        direction: 'receive',
        kind: message.contentType,
        peer: message.peer,
        status: 'completed',
        textPreview: message.content,
        createdAt: message.receivedAt,
      })
      if (mainWindow !== null && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(TEXT_RECEIVED_EVENT_CHANNEL, message)
      }
    }),
    fileTransferCoordinator.subscribeTasks((task) => {
      if (mainWindow !== null && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(TRANSFER_TASK_CHANGED_EVENT_CHANNEL, task)
      }
    }),
    fileTransferCoordinator.subscribeOffers((offer) => {
      if (mainWindow !== null && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(FILE_OFFER_RECEIVED_EVENT_CHANNEL, offer)
      }
    }),
  ]
  serviceManager.setConnectionHandler((webSocket, request) => {
    connectionManager.acceptIncoming(webSocket, request)
  })
  serviceManager.setRequestHandler((request, response) =>
    fileTransferCoordinator.handleHttpRequest(request, response),
  )
  void serviceManager.start()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      openMainWindow()
    }
  })
})

app.on('before-quit', (event) => {
  if (serviceManager.getStatus().state === 'stopped') {
    unsubscribeFromService?.()
    for (const unsubscribe of connectionUnsubscribers) unsubscribe()
    return
  }
  if (isQuitting) {
    return
  }

  event.preventDefault()
  isQuitting = true
  connectionManager.disconnect('app_shutdown')
  void fileTransferCoordinator
    .shutdown()
    .then(() => serviceManager.stop())
    .finally(() => {
      unsubscribeFromService?.()
      for (const unsubscribe of connectionUnsubscribers) unsubscribe()
      app.quit()
    })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

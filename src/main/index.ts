import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { app, BrowserWindow } from 'electron'

import { DEFAULT_SERVICE_PORT } from '@shared/constants'
import { SERVICE_STATUS_CHANGED_EVENT_CHANNEL } from '@shared/ipc'

import { createMainWindow } from './app'
import { registerFoundationIpcHandlers, registerServiceIpcHandlers } from './ipc'
import { ServiceManager } from './server'

const currentDirectory = dirname(fileURLToPath(import.meta.url))
let mainWindow: BrowserWindow | null = null
const serviceManager = new ServiceManager(DEFAULT_SERVICE_PORT)
let unsubscribeFromService: (() => void) | null = null
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
}

void app.whenReady().then(() => {
  registerFoundationIpcHandlers(() => mainWindow)
  registerServiceIpcHandlers(() => mainWindow, serviceManager)
  openMainWindow()

  unsubscribeFromService = serviceManager.subscribe((status) => {
    if (mainWindow !== null && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(SERVICE_STATUS_CHANGED_EVENT_CHANNEL, status)
    }
  })
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
    return
  }
  if (isQuitting) {
    return
  }

  event.preventDefault()
  isQuitting = true
  void serviceManager.stop().finally(() => {
    unsubscribeFromService?.()
    app.quit()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

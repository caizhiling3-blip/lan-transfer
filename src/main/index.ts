import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { app, BrowserWindow } from 'electron'

import { createMainWindow } from './app'
import { registerFoundationIpcHandlers } from './ipc'

const currentDirectory = dirname(fileURLToPath(import.meta.url))
let mainWindow: BrowserWindow | null = null

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
  openMainWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      openMainWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

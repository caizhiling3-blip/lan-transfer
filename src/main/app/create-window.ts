import { BrowserWindow } from 'electron'

import { createWindowOptions } from './window-options'

export interface CreateMainWindowOptions {
  readonly preloadPath: string
  readonly rendererFilePath: string
  readonly rendererUrl?: string
}

export const createMainWindow = (options: CreateMainWindowOptions): BrowserWindow => {
  const window = new BrowserWindow(createWindowOptions(options.preloadPath))

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => {
    event.preventDefault()
  })
  window.webContents.on('will-attach-webview', (event) => {
    event.preventDefault()
  })
  window.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false)
  })

  window.once('ready-to-show', () => {
    window.show()
  })

  if (options.rendererUrl !== undefined) {
    void window.loadURL(options.rendererUrl)
  } else {
    void window.loadFile(options.rendererFilePath)
  }

  return window
}

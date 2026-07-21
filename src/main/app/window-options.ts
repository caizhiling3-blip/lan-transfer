import type { BrowserWindowConstructorOptions } from 'electron'

export const createWindowOptions = (preloadPath: string): BrowserWindowConstructorOptions => ({
  width: 1120,
  height: 760,
  minWidth: 900,
  minHeight: 620,
  show: false,
  webPreferences: {
    preload: preloadPath,
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
  },
})

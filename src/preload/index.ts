import { contextBridge } from 'electron'

import type { OperatingSystem } from '@shared/types'

export interface LanTransferApi {
  readonly platform: OperatingSystem
}

const getOperatingSystem = (): OperatingSystem => {
  if (process.platform === 'win32') {
    return 'windows'
  }
  if (process.platform === 'darwin') {
    return 'macos'
  }
  throw new Error(`Unsupported platform: ${process.platform}`)
}

const api: LanTransferApi = Object.freeze({
  platform: getOperatingSystem(),
})

contextBridge.exposeInMainWorld('lanTransfer', api)

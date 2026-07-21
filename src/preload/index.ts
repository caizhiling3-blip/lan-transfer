import { contextBridge } from 'electron'

export interface LanTransferApi {
  readonly platform: string
}

const api: LanTransferApi = Object.freeze({
  platform: process.platform,
})

contextBridge.exposeInMainWorld('lanTransfer', api)

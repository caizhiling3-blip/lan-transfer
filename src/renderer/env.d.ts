import type { LanTransferApi } from '../preload'

declare global {
  interface Window {
    readonly lanTransfer: LanTransferApi
  }
}

export {}

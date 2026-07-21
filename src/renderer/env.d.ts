import type { LanTransferApi } from '../preload/types'

declare global {
  interface Window {
    readonly lanTransfer: LanTransferApi
  }
}

export {}

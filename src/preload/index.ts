import { contextBridge } from 'electron'

import { createLanTransferApi } from './api'

contextBridge.exposeInMainWorld('lanTransfer', createLanTransferApi())

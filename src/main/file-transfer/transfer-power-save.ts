import { powerSaveBlocker } from 'electron'

import type { TransferTaskDto } from '@shared/types'

export class TransferPowerSaveController {
  private blockerId: number | null = null

  public sync(tasks: readonly TransferTaskDto[]): void {
    const isTransferringFile = tasks.some(
      (task) => task.kind === 'file' && task.status === 'transferring',
    )
    if (isTransferringFile && this.blockerId === null) {
      this.blockerId = powerSaveBlocker.start('prevent-app-suspension')
    } else if (!isTransferringFile) {
      this.stop()
    }
  }

  public stop(): void {
    if (this.blockerId !== null && powerSaveBlocker.isStarted(this.blockerId)) {
      powerSaveBlocker.stop(this.blockerId)
    }
    this.blockerId = null
  }
}

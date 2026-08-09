import type { ErrorCode } from '@shared/errors'
import type { DeviceInfo, TransferDirection, TransferTaskDto } from '@shared/types'

export interface TextMessageItem {
  readonly id: string
  readonly direction: TransferDirection
  readonly peer: DeviceInfo
  readonly content: string
  readonly contentType: 'text' | 'link'
  readonly createdAt: number
  readonly status: 'completed' | 'failed'
  readonly errorCode?: ErrorCode
  readonly isHistorySummary?: boolean
}

export type TransferActivity =
  | {
      readonly kind: 'text'
      readonly id: string
      readonly createdAt: number
      readonly message: TextMessageItem
    }
  | {
      readonly kind: 'file'
      readonly id: string
      readonly createdAt: number
      readonly task: TransferTaskDto
    }

import type { TransferTaskDto } from '@shared/types'

import type { TextMessageItem, TransferActivity } from '../types/transfer-activity'

export const createTransferActivities = (
  messages: readonly TextMessageItem[],
  tasks: readonly TransferTaskDto[],
): readonly TransferActivity[] =>
  [
    ...messages.map((message): TransferActivity => ({
      kind: 'text',
      id: `text:${message.id}`,
      createdAt: message.createdAt,
      message,
    })),
    ...tasks.map((task): TransferActivity => ({
      kind: 'file',
      id: `file:${task.transferId}`,
      createdAt: task.createdAt,
      task,
    })),
  ].sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))

export const formatBytes = (bytes: number): string => {
  if (bytes < 1_024) return `${String(bytes)} B`
  if (bytes < 1_024 * 1_024) return `${(bytes / 1_024).toFixed(1)} KiB`
  if (bytes < 1_024 * 1_024 * 1_024) return `${(bytes / (1_024 * 1_024)).toFixed(1)} MiB`
  return `${(bytes / (1_024 * 1_024 * 1_024)).toFixed(2)} GiB`
}

export const getTransferPercentage = (
  transferredBytes: number,
  totalBytes: number,
  completed: boolean,
): number =>
  totalBytes === 0
    ? completed
      ? 100
      : 0
    : Math.min(100, Math.round((transferredBytes / totalBytes) * 100))

export const getEstimatedRemainingSeconds = (
  transferredBytes: number,
  totalBytes: number,
  bytesPerSecond: number,
): number | null => {
  const remainingBytes = Math.max(0, totalBytes - transferredBytes)
  if (remainingBytes === 0 || bytesPerSecond <= 0) return null
  return Math.ceil(remainingBytes / bytesPerSecond)
}

export const formatRemainingTime = (seconds: number): string => {
  if (seconds < 60) return `${String(seconds)} 秒`
  if (seconds < 60 * 60) return `${String(Math.ceil(seconds / 60))} 分钟`
  const hours = Math.floor(seconds / (60 * 60))
  const minutes = Math.ceil((seconds % (60 * 60)) / 60)
  return minutes === 0 ? `${String(hours)} 小时` : `${String(hours)} 小时 ${String(minutes)} 分钟`
}

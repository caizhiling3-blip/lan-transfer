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

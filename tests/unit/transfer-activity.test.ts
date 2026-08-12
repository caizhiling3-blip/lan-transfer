import { describe, expect, it } from 'vitest'

import type { TextMessageItem } from '../../src/renderer/types/transfer-activity'
import {
  createTransferActivities,
  formatBytes,
  formatRemainingTime,
  getEstimatedRemainingSeconds,
  getTransferCompletionSummary,
  getTransferPercentage,
} from '../../src/renderer/utils/transfer-activity'
import type { DeviceInfo, MobileUploadTaskDto, TransferTaskDto } from '../../src/shared/types'
import {
  deviceIdSchema,
  fileIdSchema,
  mobileUploadBatchIdSchema,
  mobileUploadSessionIdSchema,
  transferIdSchema,
} from '../../src/shared/types'

const peer: DeviceInfo = {
  deviceId: deviceIdSchema.parse('10000000-0000-4000-8000-000000000001'),
  deviceName: '测试设备',
  operatingSystem: 'macos',
  ipAddress: '192.168.1.8',
  servicePort: 53_317,
}

describe('transfer activity view model', () => {
  it('combines text and file records in chronological order', () => {
    const message: TextMessageItem = {
      id: 'message-1',
      direction: 'send',
      peer,
      content: 'hello',
      contentType: 'text',
      createdAt: 200,
      status: 'completed',
    }
    const task: TransferTaskDto = {
      transferId: transferIdSchema.parse('20000000-0000-4000-8000-000000000002'),
      direction: 'receive',
      kind: 'file',
      peer,
      status: 'awaitingAcceptance',
      files: [
        {
          fileId: fileIdSchema.parse('30000000-0000-4000-8000-000000000003'),
          displayName: 'report.pdf',
          size: 10,
          mimeType: 'application/pdf',
          transferredBytes: 0,
          bytesPerSecond: 0,
          status: 'pending',
        },
      ],
      totalBytes: 10,
      transferredBytes: 0,
      bytesPerSecond: 0,
      createdAt: 100,
      updatedAt: 100,
    }

    const activities = createTransferActivities([message], [task])

    expect(activities.map(({ kind }) => kind)).toEqual(['file', 'text'])
    expect(activities.map(({ id }) => id)).toEqual([`file:${task.transferId}`, 'text:message-1'])
  })

  it('places mobile browser batches in the same chronological timeline', () => {
    const file = {
      fileId: fileIdSchema.parse('30000000-0000-4000-8000-000000000003'),
      displayName: 'phone.jpg',
      size: 10,
      mimeType: 'image/jpeg',
    }
    const mobileTask: MobileUploadTaskDto = {
      sessionId: mobileUploadSessionIdSchema.parse('60000000-0000-4000-8000-000000000006'),
      batchId: mobileUploadBatchIdSchema.parse('70000000-0000-4000-8000-000000000007'),
      sourceAddress: '192.168.1.9',
      files: [file],
      fileItems: [{ ...file, status: 'transferring', transferredBytes: 5 }],
      totalBytes: 10,
      transferredBytes: 5,
      receivedAt: 150,
      updatedAt: 160,
      status: 'transferring',
    }

    const activities = createTransferActivities([], [], [mobileTask])

    expect(activities).toMatchObject([
      { kind: 'mobile', id: `mobile:${mobileTask.batchId}`, createdAt: 150 },
    ])
  })

  it('formats byte values and handles zero-byte progress', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(1_536)).toBe('1.5 KiB')
    expect(getTransferPercentage(0, 0, false)).toBe(0)
    expect(getTransferPercentage(0, 0, true)).toBe(100)
    expect(getTransferPercentage(75, 100, false)).toBe(75)
  })

  it('estimates and formats remaining transfer time', () => {
    expect(getEstimatedRemainingSeconds(200, 1_000, 200)).toBe(4)
    expect(getEstimatedRemainingSeconds(1_000, 1_000, 200)).toBeNull()
    expect(getEstimatedRemainingSeconds(200, 1_000, 0)).toBeNull()
    expect(formatRemainingTime(45)).toBe('45 秒')
    expect(formatRemainingTime(61)).toBe('2 分钟')
    expect(formatRemainingTime(3_660)).toBe('1 小时 1 分钟')
  })

  it('summarizes completed and unfinished file items', () => {
    const task: TransferTaskDto = {
      transferId: transferIdSchema.parse('20000000-0000-4000-8000-000000000002'),
      direction: 'send',
      kind: 'file',
      peer,
      status: 'failed',
      files: [
        {
          fileId: fileIdSchema.parse('30000000-0000-4000-8000-000000000003'),
          displayName: 'done.txt',
          size: 1,
          mimeType: 'text/plain',
          transferredBytes: 1,
          bytesPerSecond: 0,
          status: 'completed',
        },
        {
          fileId: fileIdSchema.parse('40000000-0000-4000-8000-000000000004'),
          displayName: 'failed.txt',
          size: 1,
          mimeType: 'text/plain',
          transferredBytes: 0,
          bytesPerSecond: 0,
          status: 'failed',
          errorCode: 'TRANSFER_FAILED',
        },
        {
          fileId: fileIdSchema.parse('50000000-0000-4000-8000-000000000005'),
          displayName: 'cancelled.txt',
          size: 1,
          mimeType: 'text/plain',
          transferredBytes: 0,
          bytesPerSecond: 0,
          status: 'cancelled',
        },
      ],
      totalBytes: 3,
      transferredBytes: 1,
      bytesPerSecond: 0,
      createdAt: 100,
      updatedAt: 200,
    }

    expect(getTransferCompletionSummary(task)).toEqual({
      completed: 1,
      failed: 1,
      cancelled: 1,
      rejected: 0,
      unfinished: 2,
      total: 3,
    })
  })
})

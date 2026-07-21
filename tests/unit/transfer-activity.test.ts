import { describe, expect, it } from 'vitest'

import type { TextMessageItem } from '../../src/renderer/types/transfer-activity'
import {
  createTransferActivities,
  formatBytes,
  getTransferPercentage,
} from '../../src/renderer/utils/transfer-activity'
import type { DeviceInfo, TransferTaskDto } from '../../src/shared/types'
import { deviceIdSchema, fileIdSchema, transferIdSchema } from '../../src/shared/types'

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

  it('formats byte values and handles zero-byte progress', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(1_536)).toBe('1.5 KiB')
    expect(getTransferPercentage(0, 0, false)).toBe(0)
    expect(getTransferPercentage(0, 0, true)).toBe(100)
    expect(getTransferPercentage(75, 100, false)).toBe(75)
  })
})

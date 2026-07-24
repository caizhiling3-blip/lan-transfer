import { describe, expect, it, vi } from 'vitest'

import type { TextReceivedDto, TransferOfferReceivedDto } from '@shared/ipc'
import { deviceIdSchema, fileIdSchema, messageIdSchema, transferIdSchema } from '@shared/types'
import type { DeviceInfo, TransferTaskDto } from '@shared/types'

import { TransferNotificationCoordinator } from '../../src/main/app/transfer-notifications'

const peer: DeviceInfo = {
  deviceId: deviceIdSchema.parse('10000000-0000-4000-8000-000000000001'),
  deviceName: '书房电脑',
  operatingSystem: 'windows',
  ipAddress: '192.168.1.9',
  servicePort: 53_317,
}

const createTask = (status: TransferTaskDto['status']): TransferTaskDto => ({
  transferId: transferIdSchema.parse('20000000-0000-4000-8000-000000000002'),
  direction: 'receive',
  kind: 'folder',
  peer,
  status,
  files: [],
  folder: {
    displayName: '项目资料',
    fileCount: 4,
    emptyDirectoryCount: 1,
  },
  totalBytes: 20,
  transferredBytes: status === 'completed' ? 20 : 0,
  bytesPerSecond: 0,
  createdAt: 100,
  updatedAt: 200,
})

describe('TransferNotificationCoordinator', () => {
  it('shows privacy-safe background notifications for text and offers', () => {
    const present = vi.fn()
    const coordinator = new TransferNotificationCoordinator(() => true, present)
    const text: TextReceivedDto = {
      messageId: messageIdSchema.parse('30000000-0000-4000-8000-000000000003'),
      peer,
      content: 'private message body',
      contentType: 'text',
      receivedAt: 100,
    }
    const offer: TransferOfferReceivedDto = {
      transferId: transferIdSchema.parse('40000000-0000-4000-8000-000000000004'),
      peer,
      files: [
        {
          fileId: fileIdSchema.parse('50000000-0000-4000-8000-000000000005'),
          displayName: 'secret.txt',
          size: 10,
          mimeType: 'text/plain',
        },
      ],
      receivedAt: 100,
    }

    coordinator.notifyText(text)
    coordinator.notifyOffer(offer)

    expect(present).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(present.mock.calls)).not.toContain(text.content)
    expect(JSON.stringify(present.mock.calls)).not.toContain('secret.txt')
    expect(present).toHaveBeenLastCalledWith({
      title: '收到传输请求',
      body: '书房电脑 想发送1 个文件',
    })
  })

  it('notifies a terminal task at most once and stays quiet in the foreground', () => {
    let background = false
    const present = vi.fn()
    const coordinator = new TransferNotificationCoordinator(() => background, present)
    const completed = createTask('completed')

    coordinator.notifyTask(completed)
    background = true
    coordinator.notifyTask(completed)
    expect(present).not.toHaveBeenCalled()

    const failed = { ...completed, status: 'failed' as const }
    coordinator.notifyTask(failed)
    coordinator.notifyTask(failed)
    expect(present).toHaveBeenCalledOnce()
    expect(present).toHaveBeenCalledWith({
      title: '接收失败',
      body: '文件夹（4 个文件）未能完成',
    })
  })
})

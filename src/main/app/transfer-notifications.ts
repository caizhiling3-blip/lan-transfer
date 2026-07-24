import type { TextReceivedDto, TransferOfferReceivedDto } from '@shared/ipc'
import type { TransferTaskDto } from '@shared/types'

export interface TransferNotificationContent {
  readonly title: string
  readonly body: string
}

type NotificationPresenter = (content: TransferNotificationContent) => void

const TERMINAL_NOTIFICATION_STATUSES = new Set(['completed', 'failed'])
const MAX_OBSERVED_TASKS = 500

const describeOffer = (offer: TransferOfferReceivedDto): string => {
  if ('files' in offer) {
    return offer.files.length === 1 ? '1 个文件' : `${String(offer.files.length)} 个文件`
  }
  return `文件夹，包含 ${String(offer.fileCount)} 个文件`
}

const describeTask = (task: TransferTaskDto): string => {
  if (task.kind === 'folder') {
    const fileCount = task.folder?.fileCount ?? task.files.length
    return `文件夹（${String(fileCount)} 个文件）`
  }
  return task.files.length === 1 ? '1 个文件' : `${String(task.files.length)} 个文件`
}

export class TransferNotificationCoordinator {
  private readonly observedTerminalTasks = new Set<string>()

  public constructor(
    private readonly isApplicationInBackground: () => boolean,
    private readonly present: NotificationPresenter,
  ) {}

  public notifyText(message: TextReceivedDto): void {
    if (!this.isApplicationInBackground()) return
    this.present({
      title: message.contentType === 'link' ? '收到一条链接' : '收到一条文字消息',
      body: `来自 ${message.peer.deviceName}`,
    })
  }

  public notifyOffer(offer: TransferOfferReceivedDto): void {
    if (!this.isApplicationInBackground()) return
    this.present({
      title: '收到传输请求',
      body: `${offer.peer.deviceName} 想发送${describeOffer(offer)}`,
    })
  }

  public notifyTask(task: TransferTaskDto): void {
    if (
      (task.kind !== 'file' && task.kind !== 'folder') ||
      !TERMINAL_NOTIFICATION_STATUSES.has(task.status)
    ) {
      return
    }
    const key = `${task.transferId}:${task.status}`
    if (this.observedTerminalTasks.has(key)) return
    this.observedTerminalTasks.add(key)
    this.pruneObservedTasks()
    if (!this.isApplicationInBackground()) return
    const action = task.direction === 'receive' ? '接收' : '发送'
    this.present({
      title: task.status === 'completed' ? `${action}完成` : `${action}失败`,
      body:
        task.status === 'completed'
          ? `${describeTask(task)}已完成`
          : `${describeTask(task)}未能完成`,
    })
  }

  private pruneObservedTasks(): void {
    while (this.observedTerminalTasks.size > MAX_OBSERVED_TASKS) {
      const oldest = this.observedTerminalTasks.values().next().value
      if (oldest === undefined) return
      this.observedTerminalTasks.delete(oldest)
    }
  }
}

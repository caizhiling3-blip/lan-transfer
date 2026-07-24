import { defineStore } from 'pinia'

import { ERROR_MESSAGES_ZH_CN } from '@shared/errors'
import type { TextReceivedDto } from '@shared/ipc'
import type { HistoryEntryDto } from '@shared/types'
import { classifyTextContent } from '@shared/utils'

import type { TextMessageItem } from '../types/transfer-activity'

const isTextHistoryEntry = (
  entry: HistoryEntryDto,
): entry is HistoryEntryDto & { readonly kind: 'text' | 'link'; readonly textPreview: string } =>
  (entry.kind === 'text' || entry.kind === 'link') && entry.textPreview !== undefined

const fromHistoryEntry = (
  entry: HistoryEntryDto & { readonly kind: 'text' | 'link'; readonly textPreview: string },
): TextMessageItem => ({
  id: entry.id,
  direction: entry.direction,
  peer: entry.peer,
  content: entry.textPreview,
  contentType: entry.kind,
  createdAt: entry.createdAt,
  status: entry.status === 'completed' ? 'completed' : 'failed',
})

const fromReceivedMessage = (message: TextReceivedDto): TextMessageItem => ({
  id: message.messageId,
  direction: 'receive',
  peer: message.peer,
  content: message.content,
  contentType: message.contentType,
  createdAt: message.receivedAt,
  status: 'completed',
})

export const useTextTransferStore = defineStore('textTransfer', {
  state: () => ({
    messages: [] as TextMessageItem[],
    sending: false,
    errorMessage: '',
    unsubscribers: [] as (() => void)[],
  }),
  actions: {
    async initialize(): Promise<void> {
      this.dispose()
      this.unsubscribers = [
        window.lanTransfer.transfer.onTextReceived((message) => {
          this.messages.push(fromReceivedMessage(message))
        }),
        window.lanTransfer.transfer.onTextTaskChanged(({ task, content }) => {
          this.messages.push({
            id: task.transferId,
            direction: 'send',
            peer: task.peer,
            content,
            contentType: task.kind === 'link' ? 'link' : 'text',
            createdAt: task.createdAt,
            status: task.status === 'completed' ? 'completed' : 'failed',
          })
          if (task.errorCode !== undefined) {
            this.errorMessage = ERROR_MESSAGES_ZH_CN[task.errorCode]
          }
        }),
      ]
      const result = await window.lanTransfer.history.list({ offset: 0, limit: 100 })
      if (result.ok) {
        this.messages = result.data.filter(isTextHistoryEntry).map(fromHistoryEntry).reverse()
      } else {
        this.errorMessage = ERROR_MESSAGES_ZH_CN[result.error.code]
      }
    },
    async send(content: string): Promise<boolean> {
      this.sending = true
      this.errorMessage = ''
      const contentType = classifyTextContent(content)
      const result = await window.lanTransfer.transfer.sendText(content, contentType)
      this.sending = false
      if (!result.ok) {
        this.errorMessage = ERROR_MESSAGES_ZH_CN[result.error.code]
        return false
      }
      this.messages.push({
        id: result.data.transferId,
        direction: 'send',
        peer: result.data.peer,
        content,
        contentType,
        createdAt: result.data.createdAt,
        status: result.data.status === 'completed' ? 'completed' : 'failed',
      })
      if (result.data.errorCode !== undefined) {
        this.errorMessage = ERROR_MESSAGES_ZH_CN[result.data.errorCode]
      }
      return result.data.status === 'completed'
    },
    dispose(): void {
      for (const unsubscribe of this.unsubscribers) unsubscribe()
      this.unsubscribers = []
    },
  },
})

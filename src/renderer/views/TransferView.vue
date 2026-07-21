<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'

import { MAX_TEXT_BYTES } from '@shared/constants'
import { getUtf8ByteLength } from '@shared/utils'

import { useConnectionStore } from '../stores/connection'
import { useFileTransferStore } from '../stores/file-transfer'
import { useTextTransferStore } from '../stores/text-transfer'

const connectionStore = useConnectionStore()
const textTransferStore = useTextTransferStore()
const fileTransferStore = useFileTransferStore()
const content = ref('')
const messageList = ref<HTMLElement | null>(null)

const contentBytes = computed(() => getUtf8ByteLength(content.value))
const isConnected = computed(() => connectionStore.status.state === 'connected')
const canSend = computed(
  () =>
    isConnected.value &&
    content.value.length > 0 &&
    contentBytes.value <= MAX_TEXT_BYTES &&
    !textTransferStore.sending,
)

const scrollToLatest = (): void => {
  void nextTick(() => {
    const element = messageList.value
    if (element !== null) element.scrollTop = element.scrollHeight
  })
}

watch(() => textTransferStore.messages.length, scrollToLatest)

const sendText = async (): Promise<void> => {
  if (!canSend.value) return
  const value = content.value
  if (await textTransferStore.send(value)) content.value = ''
}

const readClipboard = async (): Promise<void> => {
  const result = await window.lanTransfer.clipboard.readText()
  if (result.ok) content.value = result.data
  else ElMessage.error('读取剪贴板失败')
}

const copyText = async (value: string): Promise<void> => {
  const result = await window.lanTransfer.clipboard.writeText(value)
  if (result.ok) ElMessage.success('已复制')
  else ElMessage.error('复制失败')
}

const openLink = async (url: string): Promise<void> => {
  const result = await window.lanTransfer.app.openExternalUrl(url)
  if (!result.ok) ElMessage.error('无法打开该链接')
}

const formatTime = (timestamp: number): string => new Date(timestamp).toLocaleString()
const formatBytes = (bytes: number): string => {
  if (bytes < 1_024) return `${String(bytes)} B`
  if (bytes < 1_024 * 1_024) return `${(bytes / 1_024).toFixed(1)} KiB`
  if (bytes < 1_024 * 1_024 * 1_024) return `${(bytes / (1_024 * 1_024)).toFixed(1)} MiB`
  return `${(bytes / (1_024 * 1_024 * 1_024)).toFixed(2)} GiB`
}
const statusLabels: Readonly<Record<string, string>> = {
  awaitingAcceptance: '等待接收方确认',
  accepted: '已接受',
  transferring: '传输中',
  completed: '已完成',
  failed: '失败',
  rejected: '已拒绝',
  cancelled: '已取消',
  pending: '等待中',
}

onMounted(() => {
  void textTransferStore.initialize()
})

onBeforeUnmount(() => {
  textTransferStore.dispose()
})
</script>

<template>
  <div class="transfer-layout">
    <el-alert
      v-if="!isConnected"
      title="尚未连接设备，请先在首页建立连接"
      type="warning"
      :closable="false"
    />
    <el-card shadow="never">
      <template #header>
        <div class="transfer-header">
          <span>文字与链接</span>
          <el-tag :type="isConnected ? 'success' : 'info'">
            {{ isConnected ? `已连接 ${connectionStore.status.peer?.deviceName ?? ''}` : '未连接' }}
          </el-tag>
        </div>
      </template>

      <div ref="messageList" class="message-list">
        <el-empty v-if="textTransferStore.messages.length === 0" description="暂无文字记录" />
        <article
          v-for="message in textTransferStore.messages"
          :key="message.id"
          class="message-item"
          :class="message.direction"
        >
          <div class="message-meta">
            <span
              >{{ message.direction === 'send' ? '发送给' : '来自' }}
              {{ message.peer.deviceName }}</span
            >
            <span>{{ formatTime(message.createdAt) }}</span>
          </div>
          <p class="message-content">{{ message.content }}</p>
          <div class="message-actions">
            <el-tag v-if="message.contentType === 'link'" size="small" effect="plain">链接</el-tag>
            <el-tag v-if="message.status === 'failed'" size="small" type="danger">失败</el-tag>
            <el-button text size="small" @click="copyText(message.content)">复制</el-button>
            <el-button
              v-if="message.contentType === 'link'"
              text
              size="small"
              type="primary"
              @click="openLink(message.content)"
            >
              打开链接
            </el-button>
          </div>
        </article>
      </div>

      <el-input
        v-model="content"
        class="text-composer"
        type="textarea"
        :rows="5"
        resize="vertical"
        placeholder="输入文字或完整的 HTTP/HTTPS 链接"
      />
      <div class="composer-footer">
        <span :class="{ 'limit-exceeded': contentBytes > MAX_TEXT_BYTES }">
          {{ contentBytes }} / {{ MAX_TEXT_BYTES }} 字节
        </span>
        <div>
          <el-button @click="readClipboard">读取剪贴板</el-button>
          <el-button
            type="primary"
            :loading="textTransferStore.sending"
            :disabled="!canSend"
            @click="sendText"
          >
            发送文字
          </el-button>
        </div>
      </div>
      <el-alert
        v-if="textTransferStore.errorMessage"
        class="transfer-error"
        :title="textTransferStore.errorMessage"
        type="error"
        :closable="false"
      />
    </el-card>

    <el-card shadow="never">
      <template #header>
        <div class="transfer-header">
          <span>单文件传输</span>
          <el-button
            type="primary"
            :loading="fileTransferStore.selecting"
            :disabled="!isConnected"
            @click="fileTransferStore.selectAndOffer()"
          >
            选择文件发送
          </el-button>
        </div>
      </template>

      <el-alert
        v-if="fileTransferStore.incomingOffer"
        class="incoming-offer"
        type="warning"
        :closable="false"
      >
        <template #title>
          {{ fileTransferStore.incomingOffer.peer.deviceName }} 请求发送文件
        </template>
        <div v-for="file in fileTransferStore.incomingOffer.files" :key="file.fileId">
          <strong>{{ file.displayName }}</strong>
          <span class="file-detail">{{ formatBytes(file.size) }} · {{ file.mimeType }}</span>
        </div>
        <div class="offer-actions">
          <el-button
            type="primary"
            :loading="fileTransferStore.responding"
            @click="fileTransferStore.respond('accept')"
          >
            接受到默认目录
          </el-button>
          <el-button
            :loading="fileTransferStore.responding"
            @click="fileTransferStore.respond('accept', true)"
          >
            选择目录并接受
          </el-button>
          <el-button
            type="danger"
            plain
            :loading="fileTransferStore.responding"
            @click="fileTransferStore.respond('reject')"
          >
            拒绝
          </el-button>
        </div>
      </el-alert>

      <el-empty v-if="fileTransferStore.tasks.length === 0" description="暂无文件传输任务" />
      <div v-else class="file-task-list">
        <article v-for="task in fileTransferStore.tasks" :key="task.transferId" class="file-task">
          <div class="task-heading">
            <div>
              <strong>{{ task.files[0]?.displayName ?? '未知文件' }}</strong>
              <p>
                {{ task.direction === 'send' ? '发送给' : '接收自' }} {{ task.peer.deviceName }}
              </p>
            </div>
            <el-tag
              :type="
                task.status === 'completed'
                  ? 'success'
                  : task.status === 'failed' || task.status === 'rejected'
                    ? 'danger'
                    : 'info'
              "
            >
              {{ statusLabels[task.status] ?? task.status }}
            </el-tag>
          </div>
          <el-progress
            :percentage="
              task.totalBytes === 0
                ? task.status === 'completed'
                  ? 100
                  : 0
                : Math.min(100, Math.round((task.transferredBytes / task.totalBytes) * 100))
            "
            :status="
              task.status === 'completed'
                ? 'success'
                : task.status === 'failed'
                  ? 'exception'
                  : undefined
            "
          />
          <div class="task-stats">
            <span
              >{{ formatBytes(task.transferredBytes) }} / {{ formatBytes(task.totalBytes) }}</span
            >
            <span>{{ formatBytes(task.bytesPerSecond) }}/s</span>
          </div>
        </article>
      </div>
      <el-alert
        v-if="fileTransferStore.errorMessage"
        class="transfer-error"
        :title="fileTransferStore.errorMessage"
        type="error"
        :closable="false"
      />
    </el-card>
  </div>
</template>

<style scoped>
.transfer-layout {
  display: grid;
  gap: 20px;
}

.transfer-header,
.composer-footer,
.message-meta,
.message-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.message-list {
  height: 360px;
  overflow-y: auto;
  padding: 4px 8px 16px;
}

.message-item {
  width: min(78%, 720px);
  margin: 12px 0;
  padding: 14px 16px;
  border: 1px solid #dbe3ec;
  border-radius: 12px;
  background: #f8fafc;
}

.message-item.send {
  margin-left: auto;
  border-color: #b6d4fe;
  background: #eff6ff;
}

.message-meta {
  color: #64748b;
  font-size: 12px;
}

.message-content {
  margin: 10px 0;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}

.message-actions {
  justify-content: flex-end;
}

.text-composer {
  margin-top: 8px;
}

.composer-footer {
  margin-top: 12px;
  color: #64748b;
  font-size: 13px;
}

.limit-exceeded {
  color: #f56c6c;
}

.transfer-error {
  margin-top: 16px;
}

.incoming-offer {
  margin-bottom: 20px;
}

.file-detail {
  margin-left: 12px;
  color: #64748b;
}

.offer-actions {
  margin-top: 14px;
}

.file-task-list {
  display: grid;
  gap: 12px;
}

.file-task {
  padding: 16px;
  border: 1px solid #dbe3ec;
  border-radius: 10px;
}

.task-heading,
.task-stats {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.task-heading p {
  margin: 5px 0 12px;
  color: #64748b;
  font-size: 13px;
}

.task-stats {
  margin-top: 8px;
  color: #64748b;
  font-size: 12px;
}
</style>

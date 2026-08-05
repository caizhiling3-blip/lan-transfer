<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'

import { MAX_TEXT_BYTES } from '@shared/constants'
import type { FileId } from '@shared/types'
import { classifyTextContent, getUtf8ByteLength } from '@shared/utils'

import FileActivityCard from '../components/transfer/FileActivityCard.vue'
import TextActivityCard from '../components/transfer/TextActivityCard.vue'
import TransferComposer from '../components/transfer/TransferComposer.vue'
import { useConnectionStore } from '../stores/connection'
import { useFileTransferStore } from '../stores/file-transfer'
import { useTextTransferStore } from '../stores/text-transfer'
import { createTransferActivities } from '../utils/transfer-activity'

const connectionStore = useConnectionStore()
const textTransferStore = useTextTransferStore()
const fileTransferStore = useFileTransferStore()
const content = ref('')
const activityList = ref<HTMLElement | null>(null)

const emit = defineEmits<{ navigate: [page: 'home' | 'settings'] }>()

const activities = computed(() =>
  createTransferActivities(textTransferStore.messages, fileTransferStore.tasks),
)
const contentBytes = computed(() => getUtf8ByteLength(content.value))
const hasText = computed(() => content.value.trim().length > 0)
const hasPendingFiles = computed(() => fileTransferStore.pendingFiles.length > 0)
const hasPendingFolders = computed(() => fileTransferStore.pendingFolders.length > 0)
const isConnected = computed(() => connectionStore.status.state === 'connected')
const isSending = computed(() => fileTransferStore.offering)
const canSend = computed(
  () =>
    isConnected.value &&
    !isSending.value &&
    contentBytes.value <= MAX_TEXT_BYTES &&
    (hasText.value || hasPendingFiles.value || hasPendingFolders.value),
)
const errorMessages = computed(() =>
  [...new Set([textTransferStore.errorMessage, fileTransferStore.errorMessage])].filter(Boolean),
)

const scrollToLatest = (): void => {
  void nextTick(() => {
    const element = activityList.value
    if (element !== null) element.scrollTop = element.scrollHeight
  })
}

watch(() => activities.value.at(-1)?.id, scrollToLatest)
watch(isConnected, (connected, wasConnected) => {
  if (
    !connected &&
    wasConnected &&
    (fileTransferStore.pendingFiles.length > 0 || fileTransferStore.pendingFolders.length > 0)
  ) {
    fileTransferStore.clearPendingItems()
    ElMessage.info('连接已断开，待发送内容已清空，请重新选择')
  }
})

const send = async (): Promise<void> => {
  if (!canSend.value) return
  const text = hasText.value
    ? { content: content.value, contentType: classifyTextContent(content.value) }
    : undefined
  if (await fileTransferStore.enqueuePendingItems(text)) content.value = ''
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

const showReceivedFile = async (
  transferId: Parameters<typeof window.lanTransfer.transfer.showReceivedFile>[0],
): Promise<void> => {
  const result = await window.lanTransfer.transfer.showReceivedFile(transferId)
  if (!result.ok) ElMessage.error('文件已被移动或删除，无法在文件夹中显示')
}

const addDroppedItems = (items: readonly File[]): void => {
  if (!isConnected.value) {
    ElMessage.warning('请先连接设备')
    return
  }
  void fileTransferStore.registerDroppedItems(items)
}

const respondToOffer = (decision: 'accept' | 'reject', chooseDirectory = false): void => {
  void fileTransferStore.respond(decision, chooseDirectory)
}

const cancelFile = (
  transferId: Parameters<typeof fileTransferStore.cancel>[0],
  fileId: FileId,
): void => {
  void fileTransferStore.cancel(transferId, fileId)
}

const retryTransfer = async (
  transferId: Parameters<typeof fileTransferStore.retry>[0],
): Promise<void> => {
  try {
    await ElMessageBox.confirm(
      '重试会创建新任务并从头发送全部未完成内容，不会从中断位置继续。',
      '从头重新发送',
      { type: 'warning', confirmButtonText: '重新发送', cancelButtonText: '取消' },
    )
    await fileTransferStore.retry(transferId)
  } catch {
    // 用户取消确认时无需提示错误。
  }
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
    >
      <template #default>
        <el-button link type="primary" @click="emit('navigate', 'home')">前往首页连接</el-button>
      </template>
    </el-alert>

    <el-card class="transfer-workspace" shadow="never" body-class="workspace-body">
      <template #header>
        <div class="transfer-header">
          <div class="transfer-title">
            <strong>与设备互传</strong>
            <span>文字、链接和文件按时间排列</span>
          </div>
          <el-tag :type="isConnected ? 'success' : 'info'">
            {{ isConnected ? `已连接 ${connectionStore.status.peer?.deviceName ?? ''}` : '未连接' }}
          </el-tag>
        </div>
      </template>

      <div ref="activityList" class="activity-list" aria-live="polite">
        <el-empty
          v-if="activities.length === 0"
          description="还没有传输记录，发送一段文字或添加文件吧"
        />
        <template v-for="activity in activities" :key="activity.id">
          <TextActivityCard
            v-if="activity.kind === 'text'"
            :message="activity.message"
            @copy="copyText"
            @open="openLink"
          />
          <FileActivityCard
            v-else
            :task="activity.task"
            :incoming-offer="fileTransferStore.incomingOffer"
            :responding="fileTransferStore.responding"
            @respond="respondToOffer"
            @cancel-task="fileTransferStore.cancel(activity.task.transferId)"
            @cancel-file="cancelFile(activity.task.transferId, $event)"
            @pause="fileTransferStore.pause(activity.task.transferId)"
            @resume="fileTransferStore.resume(activity.task.transferId)"
            @retry="retryTransfer(activity.task.transferId)"
            @show-received-file="showReceivedFile(activity.task.transferId)"
            @navigate="emit('navigate', $event)"
          />
        </template>
      </div>

      <TransferComposer
        v-model="content"
        :pending-files="fileTransferStore.pendingFiles"
        :pending-folders="fileTransferStore.pendingFolders"
        :queue-items="fileTransferStore.queueItems"
        :content-bytes="contentBytes"
        :connected="isConnected"
        :selecting="fileTransferStore.selecting"
        :sending="isSending"
        :can-send="canSend"
        @add-files="fileTransferStore.selectFiles"
        @add-folder="fileTransferStore.selectFolder"
        @drop-items="addDroppedItems"
        @remove-file="fileTransferStore.removePendingFile"
        @remove-folder="fileTransferStore.removePendingFolder"
        @clear-items="fileTransferStore.clearPendingItems"
        @cancel-queued="fileTransferStore.cancelQueued"
        @read-clipboard="readClipboard"
        @send="send"
      />
    </el-card>

    <el-alert
      v-for="errorMessage in errorMessages"
      :key="errorMessage"
      :title="errorMessage"
      type="error"
      :closable="false"
    />
  </div>
</template>

<style scoped>
.transfer-layout {
  display: flex;
  height: 100%;
  min-height: 0;
  flex-direction: column;
  gap: 14px;
}

.transfer-workspace {
  display: flex;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  overflow: hidden;
}

.transfer-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.transfer-title {
  display: flex;
  min-width: 0;
  align-items: baseline;
  gap: 10px;
}

.transfer-title span {
  overflow: hidden;
  color: var(--app-text-muted);
  font-size: 13px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.activity-list {
  display: grid;
  align-content: start;
  gap: 12px;
  min-height: 0;
  flex: 1;
  overflow-y: auto;
  padding: 14px 16px 20px;
  background: var(--app-surface-muted);
}

:deep(.workspace-body) {
  display: flex;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  padding: 0;
}

:deep(.el-card__header) {
  padding: 10px 16px;
}

@media (max-width: 720px) {
  .transfer-title span {
    display: none;
  }

  .activity-list {
    padding-inline: 10px;
  }
}
</style>

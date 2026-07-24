<script setup lang="ts">
import { computed, ref } from 'vue'

import {
  MAX_FILES_PER_TRANSFER,
  MAX_TEXT_BYTES,
  MAX_TOP_LEVEL_TRANSFER_ITEMS,
} from '@shared/constants'
import type {
  FileId,
  QueueItemId,
  SelectedFileDto,
  SelectedFolderDto,
  TransferQueueItemDto,
} from '@shared/types'

import { formatBytes } from '../../utils/transfer-activity'

const content = defineModel<string>({ required: true })
const props = defineProps<{
  readonly pendingFiles: readonly SelectedFileDto[]
  readonly pendingFolders: readonly SelectedFolderDto[]
  readonly queueItems: readonly TransferQueueItemDto[]
  readonly contentBytes: number
  readonly connected: boolean
  readonly selecting: boolean
  readonly sending: boolean
  readonly canSend: boolean
}>()

const emit = defineEmits<{
  addFiles: []
  addFolder: []
  dropItems: [items: readonly File[]]
  removeFile: [fileId: FileId]
  removeFolder: [selectionToken: string]
  clearItems: []
  cancelQueued: [queueItemId: QueueItemId]
  readClipboard: []
  send: []
}>()

const dragDepth = ref(0)
const isDraggingFiles = ref(false)
const totalPendingBytes = computed(() =>
  props.pendingFiles.reduce((total, file) => total + file.size, 0),
)

const handleDragEnter = (event: DragEvent): void => {
  if (!event.dataTransfer?.types.includes('Files')) return
  dragDepth.value += 1
  isDraggingFiles.value = true
}

const handleDragLeave = (): void => {
  dragDepth.value = Math.max(0, dragDepth.value - 1)
  if (dragDepth.value === 0) isDraggingFiles.value = false
}

const handleDrop = (event: DragEvent): void => {
  dragDepth.value = 0
  isDraggingFiles.value = false
  const files = event.dataTransfer?.files
  if (files === undefined || files.length === 0) return
  emit('dropItems', Array.from(files))
}

const handleComposerKeydown = (event: KeyboardEvent): void => {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return

  event.preventDefault()
  if (props.canSend) emit('send')
}
</script>

<template>
  <section
    class="composer"
    @dragenter.prevent="handleDragEnter"
    @dragover.prevent
    @dragleave.prevent="handleDragLeave"
    @drop.prevent="handleDrop"
  >
    <details v-if="queueItems.length > 0" class="transfer-queue">
      <summary class="compact-summary">
        <span>发送队列 · {{ queueItems.length }} 项</span>
        <small>点击查看队列</small>
      </summary>
      <div class="queue-items">
        <div v-for="item in queueItems" :key="item.queueItemId" class="queue-item">
          <el-tag
            :type="
              item.status === 'failed' ? 'danger' : item.status === 'active' ? 'primary' : 'info'
            "
            size="small"
          >
            {{
              item.status === 'active'
                ? '发送中'
                : item.status === 'failed'
                  ? '失败'
                  : `排队 ${item.position}`
            }}
          </el-tag>
          <span :title="item.displayName">{{ item.displayName }}</span>
          <el-button
            v-if="item.status !== 'active'"
            text
            type="danger"
            size="small"
            @click="$emit('cancelQueued', item.queueItemId)"
          >
            移除
          </el-button>
        </div>
      </div>
      <small>文字、文件和文件夹将严格串行发送</small>
    </details>

    <details v-if="pendingFiles.length > 0 || pendingFolders.length > 0" class="pending-tray">
      <summary class="compact-summary">
        <span>
          待发送 {{ pendingFiles.length }} 个文件、{{ pendingFolders.length }} 个文件夹 ·
          {{
            formatBytes(
              totalPendingBytes + pendingFolders.reduce((sum, item) => sum + item.totalSize, 0),
            )
          }}
        </span>
        <small>点击查看附件</small>
      </summary>
      <div class="pending-files">
        <div v-for="file in pendingFiles" :key="file.fileId" class="pending-file">
          <div>
            <strong>{{ file.displayName }}</strong>
            <span>{{ formatBytes(file.size) }} · {{ file.mimeType }}</span>
          </div>
          <el-button text type="danger" size="small" @click="$emit('removeFile', file.fileId)">
            移除
          </el-button>
        </div>
        <div
          v-for="folder in pendingFolders"
          :key="folder.selectionToken"
          class="pending-file pending-folder"
        >
          <div>
            <strong>{{ folder.displayName }}</strong>
            <span>
              文件夹 · {{ folder.fileCount }} 个文件 · {{ formatBytes(folder.totalSize) }}
            </span>
          </div>
          <el-button
            text
            type="danger"
            size="small"
            @click="$emit('removeFolder', folder.selectionToken)"
          >
            移除
          </el-button>
        </div>
      </div>
      <div class="pending-note">
        <small>选择授权保留 10 分钟；发送时仍需对方确认接收。</small>
        <el-button text size="small" @click="$emit('clearItems')">清空</el-button>
      </div>
    </details>

    <el-input
      v-model="content"
      type="textarea"
      :rows="2"
      resize="vertical"
      placeholder="输入文字或链接，也可以添加或拖入文件"
      @keydown="handleComposerKeydown"
    />

    <div class="composer-footer">
      <div class="composer-tools">
        <el-button
          :loading="selecting"
          :disabled="
            !connected ||
            (pendingFolders.length > 0
              ? pendingFiles.length + pendingFolders.length >= MAX_TOP_LEVEL_TRANSFER_ITEMS
              : pendingFiles.length >= MAX_FILES_PER_TRANSFER)
          "
          @click="$emit('addFiles')"
        >
          添加文件
        </el-button>
        <el-button
          :loading="selecting"
          :disabled="
            !connected ||
            pendingFolders.length > 0 ||
            pendingFiles.length + pendingFolders.length >= MAX_TOP_LEVEL_TRANSFER_ITEMS
          "
          @click="$emit('addFolder')"
        >
          添加文件夹
        </el-button>
        <el-button @click="$emit('readClipboard')">读取剪贴板</el-button>
      </div>
      <div class="send-area">
        <span class="send-hint">Enter 发送 · Shift+Enter 换行</span>
        <span :class="{ 'limit-exceeded': contentBytes > MAX_TEXT_BYTES }">
          {{ contentBytes }} / {{ MAX_TEXT_BYTES }} 字节
        </span>
        <el-button type="primary" :loading="sending" :disabled="!canSend" @click="$emit('send')">
          发送
        </el-button>
      </div>
    </div>

    <div v-if="isDraggingFiles" class="drop-overlay">
      <strong>松开即可扫描并添加</strong>
      <span>支持普通文件和文件夹；符号链接会被拒绝</span>
    </div>
  </section>
</template>

<style scoped>
.composer {
  position: relative;
  padding: 10px 12px 12px;
  border-top: 1px solid var(--app-border);
  background: var(--app-surface);
}

.pending-tray {
  margin-bottom: 8px;
  padding: 8px 10px;
  border: 1px solid var(--app-primary-border);
  border-radius: 10px;
  background: var(--app-primary-soft);
}

.transfer-queue {
  margin-bottom: 8px;
  padding: 8px 10px;
  border: 1px solid var(--app-border);
  border-radius: 10px;
  background: var(--app-surface-muted);
}

.transfer-queue[open],
.pending-tray[open] {
  display: grid;
  gap: 8px;
}

.transfer-queue small {
  color: var(--app-text-muted);
}

.compact-summary {
  display: flex;
  min-width: 0;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  color: var(--app-text);
  cursor: pointer;
  font-size: 13px;
  font-weight: 600;
  list-style: none;
}

.compact-summary::-webkit-details-marker {
  display: none;
}

.compact-summary::before {
  width: 6px;
  height: 6px;
  flex: 0 0 auto;
  border-right: 1.5px solid currentColor;
  border-bottom: 1.5px solid currentColor;
  content: '';
  transform: rotate(-45deg);
  transition: transform 0.16s ease;
}

details[open] > .compact-summary::before {
  transform: rotate(45deg);
}

.compact-summary > span {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.compact-summary small {
  flex: none;
  color: var(--app-text-muted);
  font-size: 12px;
  font-weight: 400;
}

.queue-items {
  display: flex;
  gap: 8px;
  overflow-x: auto;
}

.queue-item {
  display: flex;
  min-width: 220px;
  align-items: center;
  gap: 8px;
  padding: 7px 9px;
  border-radius: 8px;
  background: var(--app-surface-raised);
}

.queue-item > span {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pending-file,
.composer-footer,
.composer-tools,
.send-area,
.pending-note {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.pending-files {
  display: flex;
  gap: 8px;
  overflow-x: auto;
  padding-bottom: 2px;
}

.pending-file {
  min-width: 230px;
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--app-surface-raised);
}

.pending-file div {
  display: grid;
  min-width: 0;
}

.pending-file strong,
.pending-file span {
  max-width: 175px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pending-file span,
.pending-tray small,
.send-area > span {
  color: var(--app-text-muted);
  font-size: 12px;
}

.send-area .send-hint {
  color: var(--app-text-secondary);
}

.composer-footer {
  margin-top: 8px;
}

:deep(.el-textarea__inner) {
  min-height: 52px;
  max-height: min(280px, 40vh);
}

.send-area .limit-exceeded {
  color: #f56c6c;
}

.drop-overlay {
  position: absolute;
  z-index: 2;
  inset: 6px;
  display: grid;
  place-content: center;
  gap: 5px;
  border: 2px dashed #409eff;
  border-radius: 12px;
  background: color-mix(in srgb, var(--app-primary-soft) 96%, transparent);
  color: var(--app-primary-strong);
  text-align: center;
  pointer-events: none;
}

@media (max-width: 720px) {
  .composer {
    padding-inline: 10px;
  }

  .compact-summary small,
  .send-hint {
    display: none;
  }

  .composer-footer {
    align-items: stretch;
    flex-direction: column;
  }

  .send-area {
    justify-content: flex-end;
  }
}
</style>

<script setup lang="ts">
import { computed, ref } from 'vue'

import { MAX_FILES_PER_TRANSFER, MAX_TEXT_BYTES } from '@shared/constants'
import type { FileId, SelectedFileDto } from '@shared/types'

import { formatBytes } from '../../utils/transfer-activity'

const content = defineModel<string>({ required: true })
const props = defineProps<{
  readonly pendingFiles: readonly SelectedFileDto[]
  readonly contentBytes: number
  readonly connected: boolean
  readonly selecting: boolean
  readonly sending: boolean
  readonly canSend: boolean
}>()

const emit = defineEmits<{
  addFiles: []
  dropFiles: [files: readonly File[]]
  removeFile: [fileId: FileId]
  clearFiles: []
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
  emit('dropFiles', Array.from(files))
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
    <div v-if="pendingFiles.length > 0" class="pending-tray">
      <div class="pending-heading">
        <span>
          待发送 {{ pendingFiles.length }} 个文件 · {{ formatBytes(totalPendingBytes) }}
        </span>
        <el-button text size="small" @click="$emit('clearFiles')">清空</el-button>
      </div>
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
      </div>
      <small>文件选择授权保留 10 分钟；发送时仍需对方确认接收。</small>
    </div>

    <el-input
      v-model="content"
      type="textarea"
      :rows="4"
      resize="vertical"
      placeholder="输入文字或链接，也可以添加或拖入文件"
      @keydown="handleComposerKeydown"
    />

    <div class="composer-footer">
      <div class="composer-tools">
        <el-button
          :loading="selecting"
          :disabled="!connected || pendingFiles.length >= MAX_FILES_PER_TRANSFER"
          @click="$emit('addFiles')"
        >
          添加文件
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
      <strong>松开即可添加文件</strong>
      <span>最多 {{ MAX_FILES_PER_TRANSFER }} 个文件，不支持文件夹</span>
    </div>
  </section>
</template>

<style scoped>
.composer {
  position: relative;
  padding: 14px;
  border-top: 1px solid var(--app-border);
  background: var(--app-surface);
}

.pending-tray {
  display: grid;
  gap: 8px;
  margin-bottom: 12px;
  padding: 11px 12px;
  border: 1px solid var(--app-primary-border);
  border-radius: 10px;
  background: var(--app-primary-soft);
}

.pending-heading,
.pending-file,
.composer-footer,
.composer-tools,
.send-area {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.pending-heading {
  color: var(--app-text);
  font-size: 13px;
  font-weight: 600;
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
  margin-top: 11px;
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
  .composer-footer {
    align-items: stretch;
    flex-direction: column;
  }

  .send-area {
    justify-content: flex-end;
  }
}
</style>

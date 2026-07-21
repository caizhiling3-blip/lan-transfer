<script setup lang="ts">
import { computed } from 'vue'

import { ERROR_MESSAGES_ZH_CN } from '@shared/errors'
import type { FileOfferReceivedDto } from '@shared/ipc'
import type { FileId, TransferStatus, TransferTaskDto } from '@shared/types'

import { formatBytes, getTransferPercentage } from '../../utils/transfer-activity'

const props = defineProps<{
  readonly task: TransferTaskDto
  readonly incomingOffer: FileOfferReceivedDto | null
  readonly responding: boolean
}>()

defineEmits<{
  respond: [decision: 'accept' | 'reject', chooseDirectory?: boolean]
  cancelTask: []
  cancelFile: [fileId: FileId]
  retry: []
}>()

const statusLabels: Readonly<Record<TransferStatus, string>> = {
  pending: '等待中',
  awaitingAcceptance: '等待确认',
  accepted: '已接受',
  transferring: '传输中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
  rejected: '已拒绝',
}

const isIncomingOffer = computed(() => props.incomingOffer?.transferId === props.task.transferId)
const isTaskActive = computed(() =>
  ['awaitingAcceptance', 'accepted', 'transferring', 'pending'].includes(props.task.status),
)
const canRetry = computed(
  () =>
    props.task.direction === 'send' &&
    ['failed', 'cancelled', 'rejected'].includes(props.task.status),
)
const errorMessage = computed(() =>
  props.task.errorCode === undefined ? '' : ERROR_MESSAGES_ZH_CN[props.task.errorCode],
)
const tagType = computed(() => {
  if (props.task.status === 'completed') return 'success'
  if (['failed', 'rejected', 'cancelled'].includes(props.task.status)) return 'danger'
  if (props.task.status === 'transferring') return 'primary'
  return 'info'
})
</script>

<template>
  <article class="activity-card file-card" :class="task.direction">
    <div class="task-heading">
      <div>
        <strong>
          {{ task.files[0]?.displayName ?? '未知文件' }}
          <template v-if="task.files.length > 1">等 {{ task.files.length }} 个文件</template>
        </strong>
        <p :title="new Date(task.createdAt).toLocaleString()">
          {{
            task.direction === 'send'
              ? `发送给 ${task.peer.deviceName}`
              : `来自 ${task.peer.deviceName}`
          }}
          · {{ new Date(task.createdAt).toLocaleTimeString() }}
        </p>
      </div>
      <el-tag :type="tagType">{{ statusLabels[task.status] }}</el-tag>
    </div>

    <div v-if="isIncomingOffer" class="accept-panel">
      <strong>是否接收这些文件？</strong>
      <span>默认不会自动接收或打开文件。</span>
      <div class="offer-actions">
        <el-button type="primary" :loading="responding" @click="$emit('respond', 'accept')">
          接收到默认目录
        </el-button>
        <el-button :loading="responding" @click="$emit('respond', 'accept', true)">
          选择目录
        </el-button>
        <el-button type="danger" plain :loading="responding" @click="$emit('respond', 'reject')">
          拒绝
        </el-button>
      </div>
    </div>

    <template v-else>
      <el-progress
        :percentage="
          getTransferPercentage(task.transferredBytes, task.totalBytes, task.status === 'completed')
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
        <span>{{ formatBytes(task.transferredBytes) }} / {{ formatBytes(task.totalBytes) }}</span>
        <span v-if="task.status === 'transferring'">{{ formatBytes(task.bytesPerSecond) }}/s</span>
      </div>
    </template>

    <p v-if="errorMessage" class="task-error">{{ errorMessage }}</p>

    <div v-if="!isIncomingOffer" class="task-actions">
      <el-button v-if="isTaskActive" size="small" type="danger" plain @click="$emit('cancelTask')">
        取消任务
      </el-button>
      <el-button v-if="canRetry" size="small" type="primary" plain @click="$emit('retry')">
        重新发送
      </el-button>
    </div>

    <details class="task-files" :open="task.files.length === 1 || isIncomingOffer">
      <summary>文件明细（{{ task.files.length }}）</summary>
      <div v-for="file in task.files" :key="file.fileId" class="task-file-row">
        <div class="file-row-heading">
          <span>{{ file.displayName }}</span>
          <el-tag size="small" effect="plain">{{ statusLabels[file.status] }}</el-tag>
        </div>
        <div class="file-detail">{{ formatBytes(file.size) }} · {{ file.mimeType }}</div>
        <el-progress
          v-if="!isIncomingOffer"
          :stroke-width="5"
          :show-text="false"
          :percentage="
            getTransferPercentage(file.transferredBytes, file.size, file.status === 'completed')
          "
        />
        <div v-if="!isIncomingOffer" class="file-row-footer">
          <span>{{ formatBytes(file.transferredBytes) }} / {{ formatBytes(file.size) }}</span>
          <el-button
            v-if="file.status === 'pending' || file.status === 'transferring'"
            text
            type="danger"
            size="small"
            @click="$emit('cancelFile', file.fileId)"
          >
            取消此文件
          </el-button>
        </div>
      </div>
    </details>
  </article>
</template>

<style scoped>
.activity-card {
  width: min(88%, 820px);
  padding: 16px;
  border: 1px solid #dbe3ec;
  border-radius: 14px;
  background: #fff;
}

.activity-card.send {
  margin-left: auto;
  border-color: #b6d4fe;
  background: #f8fbff;
}

.task-heading,
.task-stats,
.file-row-heading,
.file-row-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.task-heading p {
  margin: 5px 0 12px;
  color: #64748b;
  font-size: 12px;
}

.task-stats,
.file-detail,
.file-row-footer {
  color: #64748b;
  font-size: 12px;
}

.task-stats {
  margin-top: 7px;
}

.accept-panel {
  display: grid;
  gap: 7px;
  padding: 12px;
  border-radius: 10px;
  background: #fff7e6;
  color: #7c5b16;
}

.offer-actions,
.task-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 6px;
}

.task-actions {
  justify-content: flex-end;
}

.task-error {
  margin: 10px 0 0;
  color: #f56c6c;
  font-size: 13px;
}

.task-files {
  margin-top: 13px;
  padding-top: 11px;
  border-top: 1px solid #e2e8f0;
}

.task-files summary {
  cursor: pointer;
  color: #475569;
  font-size: 13px;
}

.task-file-row {
  margin-top: 9px;
  padding: 10px 12px;
  border-radius: 8px;
  background: rgb(248 250 252 / 85%);
}

.file-row-heading {
  margin-bottom: 4px;
}

.file-detail {
  margin-bottom: 7px;
  overflow-wrap: anywhere;
}

.file-row-footer {
  margin-top: 3px;
}

@media (max-width: 720px) {
  .activity-card {
    width: 96%;
  }
}
</style>

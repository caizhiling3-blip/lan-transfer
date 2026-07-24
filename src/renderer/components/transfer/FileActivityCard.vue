<script setup lang="ts">
import { computed } from 'vue'

import { ERROR_MESSAGES_ZH_CN } from '@shared/errors'
import type { TransferOfferReceivedDto } from '@shared/ipc'
import type { FileId, TransferStatus, TransferTaskDto } from '@shared/types'

import {
  formatBytes,
  formatRemainingTime,
  getTransferCompletionSummary,
  getEstimatedRemainingSeconds,
  getTransferPercentage,
} from '../../utils/transfer-activity'

const props = defineProps<{
  readonly task: TransferTaskDto
  readonly incomingOffer: TransferOfferReceivedDto | null
  readonly responding: boolean
}>()

defineEmits<{
  respond: [decision: 'accept' | 'reject', chooseDirectory?: boolean]
  cancelTask: []
  cancelFile: [fileId: FileId]
  retry: []
  showReceivedFile: []
}>()

const statusLabels: Readonly<Record<TransferStatus, string>> = {
  pending: '等待中',
  awaitingAcceptance: '等待确认',
  accepted: '已接受',
  transferring: '传输中',
  publishing: '等待发布',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
  rejected: '已拒绝',
}

const isIncomingOffer = computed(() => props.incomingOffer?.transferId === props.task.transferId)
const isTaskActive = computed(() =>
  ['awaitingAcceptance', 'accepted', 'transferring', 'publishing', 'pending'].includes(
    props.task.status,
  ),
)
const canRetry = computed(
  () =>
    props.task.direction === 'send' &&
    ['failed', 'cancelled', 'rejected'].includes(props.task.status),
)
const errorMessage = computed(() =>
  props.task.errorCode === undefined ? '' : ERROR_MESSAGES_ZH_CN[props.task.errorCode],
)
const estimatedRemainingSeconds = computed(() =>
  getEstimatedRemainingSeconds(
    props.task.transferredBytes,
    props.task.totalBytes,
    props.task.bytesPerSecond,
  ),
)
const canShowReceivedFile = computed(
  () => props.task.direction === 'receive' && props.task.status === 'completed',
)
const tagType = computed(() => {
  if (props.task.status === 'completed') return 'success'
  if (['failed', 'rejected', 'cancelled'].includes(props.task.status)) return 'danger'
  if (['transferring', 'publishing'].includes(props.task.status)) return 'primary'
  return 'info'
})
const isTaskTerminal = computed(() =>
  ['completed', 'failed', 'cancelled', 'rejected'].includes(props.task.status),
)
const completionSummary = computed(() => getTransferCompletionSummary(props.task))
const unfinishedFiles = computed(() =>
  props.task.files.filter((file) => ['failed', 'cancelled', 'rejected'].includes(file.status)),
)
const visibleUnfinishedFiles = computed(() => unfinishedFiles.value.slice(0, 20))
const hiddenUnfinishedCount = computed(
  () => unfinishedFiles.value.length - visibleUnfinishedFiles.value.length,
)
const getUnfinishedReason = (file: TransferTaskDto['files'][number]): string => {
  if (file.errorCode !== undefined) return ERROR_MESSAGES_ZH_CN[file.errorCode]
  if (props.task.errorCode !== undefined) return ERROR_MESSAGES_ZH_CN[props.task.errorCode]
  if (file.status === 'cancelled') return '已取消'
  if (file.status === 'rejected') return '接收方已拒绝'
  return '传输失败'
}
</script>

<template>
  <article class="activity-card file-card" :class="task.direction">
    <div class="task-heading">
      <div>
        <strong>
          <template v-if="task.kind === 'folder'">{{
            task.folder?.displayName ?? '文件夹'
          }}</template>
          <template v-else>
            {{ task.files[0]?.displayName ?? '未知文件' }}
            <template v-if="task.files.length > 1">等 {{ task.files.length }} 个文件</template>
          </template>
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
      <span v-if="task.kind === 'folder'">
        文件夹包含 {{ task.folder?.fileCount ?? 0 }} 个文件和
        {{ task.folder?.emptyDirectoryCount ?? 0 }} 个空目录。
      </span>
      <span v-else>默认不会自动接收或打开文件。</span>
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
          getTransferPercentage(
            task.transferredBytes,
            task.totalBytes,
            task.status === 'completed' || task.status === 'publishing',
          )
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
        <span v-if="task.status === 'transferring'">
          {{ formatBytes(task.bytesPerSecond) }}/s
          <template v-if="estimatedRemainingSeconds !== null">
            · 预计剩余 {{ formatRemainingTime(estimatedRemainingSeconds) }}
          </template>
        </span>
      </div>
    </template>

    <p v-if="errorMessage" class="task-error">{{ errorMessage }}</p>

    <section
      v-if="isTaskTerminal"
      class="completion-summary"
      :class="{ 'has-unfinished': completionSummary.unfinished > 0 }"
    >
      <strong>
        {{
          task.status === 'completed'
            ? task.kind === 'folder'
              ? '文件夹已安全发布'
              : '传输已完成'
            : '传输未全部完成'
        }}
      </strong>
      <div v-if="completionSummary.total > 0" class="summary-counts">
        <span>成功 {{ completionSummary.completed }}</span>
        <span v-if="completionSummary.failed > 0">失败 {{ completionSummary.failed }}</span>
        <span v-if="completionSummary.cancelled > 0"> 取消 {{ completionSummary.cancelled }} </span>
        <span v-if="completionSummary.rejected > 0"> 拒绝 {{ completionSummary.rejected }} </span>
      </div>
      <ul v-if="visibleUnfinishedFiles.length > 0" class="unfinished-files">
        <li v-for="file in visibleUnfinishedFiles" :key="file.fileId">
          <span :title="file.displayName">{{ file.displayName }}</span>
          <small>{{ getUnfinishedReason(file) }}</small>
        </li>
      </ul>
      <small v-if="hiddenUnfinishedCount > 0" class="hidden-failure-count">
        另有 {{ hiddenUnfinishedCount }} 项未完成，可在文件明细中查看
      </small>
    </section>

    <div v-if="!isIncomingOffer" class="task-actions">
      <el-button v-if="isTaskActive" size="small" type="danger" plain @click="$emit('cancelTask')">
        取消任务
      </el-button>
      <el-button v-if="canRetry" size="small" type="primary" plain @click="$emit('retry')">
        重新发送
      </el-button>
      <el-button
        v-if="canShowReceivedFile"
        size="small"
        type="primary"
        plain
        @click="$emit('showReceivedFile')"
      >
        在文件夹中显示
      </el-button>
    </div>

    <details v-if="task.files.length > 0" class="task-files">
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
            v-if="
              task.kind === 'file' && (file.status === 'pending' || file.status === 'transferring')
            "
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
  border: 1px solid var(--app-border);
  border-radius: 14px;
  background: var(--app-surface-raised);
}

.activity-card.send {
  margin-left: auto;
  border-color: var(--app-primary-border);
  background: var(--app-primary-soft);
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
  color: var(--app-text-muted);
  font-size: 12px;
}

.task-stats,
.file-detail,
.file-row-footer {
  color: var(--app-text-muted);
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
  background: var(--app-warning-soft);
  color: var(--app-warning-text);
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

.completion-summary {
  display: grid;
  gap: 8px;
  margin-top: 11px;
  padding: 11px 12px;
  border: 1px solid var(--app-success-border, #95d475);
  border-radius: 10px;
  background: var(--app-success-soft, color-mix(in srgb, #67c23a 12%, transparent));
}

.completion-summary.has-unfinished {
  border-color: color-mix(in srgb, #f56c6c 55%, var(--app-border));
  background: color-mix(in srgb, #f56c6c 10%, var(--app-surface-raised));
}

.summary-counts {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 14px;
  color: var(--app-text-secondary);
  font-size: 12px;
}

.unfinished-files {
  display: grid;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.unfinished-files li {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}

.unfinished-files span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.unfinished-files small,
.hidden-failure-count {
  flex: none;
  color: var(--app-text-muted);
}

.task-files {
  margin-top: 13px;
  padding-top: 11px;
  border-top: 1px solid var(--app-border);
}

.task-files summary {
  cursor: pointer;
  color: var(--app-text-muted);
  font-size: 13px;
}

.task-file-row {
  margin-top: 9px;
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--app-surface-muted);
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

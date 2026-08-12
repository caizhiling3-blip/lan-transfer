<script setup lang="ts">
import { computed } from 'vue'

import { ERROR_MESSAGES_ZH_CN } from '@shared/errors'
import type { MobileUploadTaskDto } from '@shared/types'

import { formatBytes, getTransferPercentage } from '../../utils/transfer-activity'

const props = defineProps<{ readonly task: MobileUploadTaskDto }>()

defineEmits<{ cancel: []; showReceived: [] }>()

const statusLabel = computed(() => {
  const labels: Readonly<Record<MobileUploadTaskDto['status'], string>> = {
    awaitingAcceptance: '等待确认',
    accepted: '已接受',
    transferring: '传输中',
    completed: '已完成',
    failed: '失败',
    cancelled: '已取消',
    rejected: '已拒绝',
  }
  return labels[props.task.status]
})
const tagType = computed(() => {
  if (props.task.status === 'completed') return 'success'
  if (['failed', 'cancelled', 'rejected'].includes(props.task.status)) return 'danger'
  if (props.task.status === 'transferring') return 'primary'
  return 'warning'
})
</script>

<template>
  <article class="activity-card mobile-card receive">
    <div class="task-heading">
      <div>
        <strong>
          {{ task.files[0]?.displayName ?? '手机文件' }}
          <template v-if="task.files.length > 1">等 {{ task.files.length }} 个文件</template>
        </strong>
        <p>来自手机浏览器 · {{ new Date(task.receivedAt).toLocaleTimeString() }}</p>
      </div>
      <el-tag :type="tagType">{{ statusLabel }}</el-tag>
    </div>

    <el-progress
      :percentage="
        getTransferPercentage(task.transferredBytes, task.totalBytes, task.status === 'completed')
      "
      :status="
        task.status === 'completed' ? 'success' : task.status === 'failed' ? 'exception' : undefined
      "
    />
    <div class="task-stats">
      <span>{{ formatBytes(task.transferredBytes) }} / {{ formatBytes(task.totalBytes) }}</span>
      <span
        >{{ task.fileItems.filter((file) => file.status === 'completed').length }} /
        {{ task.fileItems.length }} 个文件</span
      >
    </div>

    <div v-if="task.errorCode" class="task-error">{{ ERROR_MESSAGES_ZH_CN[task.errorCode] }}</div>

    <details class="task-files" :open="task.fileItems.length <= 3">
      <summary>文件明细（{{ task.fileItems.length }}）</summary>
      <div v-for="file in task.fileItems" :key="file.fileId" class="task-file-row">
        <div class="file-row-heading">
          <span :title="file.displayName">{{ file.displayName }}</span>
          <small>{{
            file.status === 'completed'
              ? '已完成'
              : file.status === 'transferring'
                ? '上传中'
                : '等待中'
          }}</small>
        </div>
        <el-progress
          :stroke-width="5"
          :show-text="false"
          :percentage="
            getTransferPercentage(file.transferredBytes, file.size, file.status === 'completed')
          "
        />
      </div>
    </details>

    <div class="task-actions">
      <el-button
        v-if="['awaitingAcceptance', 'accepted', 'transferring'].includes(task.status)"
        size="small"
        type="danger"
        plain
        @click="$emit('cancel')"
        >取消任务</el-button
      >
      <el-button
        v-if="task.status === 'completed'"
        size="small"
        type="primary"
        plain
        @click="$emit('showReceived')"
      >
        在文件夹中显示
      </el-button>
    </div>
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
.task-heading,
.task-stats,
.file-row-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.task-heading p,
.task-stats {
  color: var(--app-text-muted);
  font-size: 12px;
}
.task-heading p {
  margin: 5px 0 12px;
}
.task-stats {
  margin-top: 7px;
}
.task-error {
  margin-top: 10px;
  color: #f56c6c;
}
.task-files {
  margin-top: 12px;
}
.task-files summary {
  cursor: pointer;
  color: var(--app-text-secondary);
}
.task-file-row {
  display: grid;
  gap: 6px;
  margin-top: 10px;
}
.file-row-heading span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.file-row-heading small {
  flex: none;
  color: var(--app-text-muted);
}
.task-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 12px;
}
</style>

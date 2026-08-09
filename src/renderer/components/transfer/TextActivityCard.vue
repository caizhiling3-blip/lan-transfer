<script setup lang="ts">
import { ERROR_MESSAGES_ZH_CN, ERROR_RECOVERY_ADVICE_ZH_CN } from '@shared/errors'

import type { TextMessageItem } from '../../types/transfer-activity'

defineProps<{ readonly message: TextMessageItem }>()

defineEmits<{
  copy: [content: string]
  open: [url: string]
}>()

const formatTime = (timestamp: number): string => new Date(timestamp).toLocaleTimeString()
</script>

<template>
  <article class="activity-card text-card" :class="message.direction">
    <div class="activity-meta" :title="new Date(message.createdAt).toLocaleString()">
      <span>{{ message.direction === 'send' ? '我' : message.peer.deviceName }}</span>
      <span>{{ formatTime(message.createdAt) }}</span>
    </div>
    <p class="message-content">{{ message.content }}</p>
    <div class="activity-actions">
      <el-tag v-if="message.contentType === 'link'" size="small" effect="plain">链接</el-tag>
      <el-tooltip
        v-if="message.isHistorySummary"
        content="历史记录只保留文字摘要，较长内容可能不完整"
      >
        <el-tag size="small" type="info" effect="plain">历史摘要</el-tag>
      </el-tooltip>
      <el-tag v-if="message.status === 'failed'" size="small" type="danger">发送失败</el-tag>
      <el-button text size="small" @click="$emit('copy', message.content)">复制</el-button>
      <el-button
        v-if="message.contentType === 'link'"
        text
        size="small"
        type="primary"
        @click="$emit('open', message.content)"
      >
        打开链接
      </el-button>
    </div>
    <div v-if="message.errorCode" class="text-error">
      <strong>{{ ERROR_MESSAGES_ZH_CN[message.errorCode] }}</strong>
      <span>{{ ERROR_RECOVERY_ADVICE_ZH_CN[message.errorCode].suggestion }}</span>
    </div>
  </article>
</template>

<style scoped>
.activity-card {
  width: min(78%, 720px);
  padding: 13px 15px;
  border: 1px solid var(--app-border);
  border-radius: 14px;
  background: var(--app-surface-raised);
}

.activity-card.send {
  margin-left: auto;
  border-color: var(--app-primary-border);
  background: var(--app-primary-soft);
}

.activity-meta,
.activity-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.text-error {
  display: grid;
  gap: 3px;
  margin-top: 8px;
  color: var(--app-danger-text, #f56c6c);
  font-size: 12px;
}

.activity-meta {
  color: var(--app-text-muted);
  font-size: 12px;
}

.message-content {
  margin: 9px 0;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}

.activity-actions {
  justify-content: flex-end;
}

@media (max-width: 720px) {
  .activity-card {
    width: 92%;
  }
}
</style>

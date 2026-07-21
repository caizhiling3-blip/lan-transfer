<script setup lang="ts">
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
  </article>
</template>

<style scoped>
.activity-card {
  width: min(78%, 720px);
  padding: 13px 15px;
  border: 1px solid #dbe3ec;
  border-radius: 14px;
  background: #f8fafc;
}

.activity-card.send {
  margin-left: auto;
  border-color: #b6d4fe;
  background: #eff6ff;
}

.activity-meta,
.activity-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.activity-meta {
  color: #64748b;
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

<script setup lang="ts">
import { ElMessage, ElMessageBox } from 'element-plus'
import { onMounted } from 'vue'

import { useDiagnosticsStore } from '../stores/diagnostics'

const store = useDiagnosticsStore()

const formatSize = (bytes: number): string => {
  if (bytes < 1_024) return `${String(bytes)} B`
  if (bytes < 1_024 * 1_024) return `${(bytes / 1_024).toFixed(1)} KiB`
  return `${(bytes / 1_024 / 1_024).toFixed(1)} MiB`
}

const exportReport = async (): Promise<void> => {
  const result = await store.exportReport()
  if (result === 'saved') ElMessage.success('诊断报告已导出')
}

const clearLogs = async (): Promise<void> => {
  try {
    await ElMessageBox.confirm(
      '只会清理已轮转的邻渡日志，当前日志、历史摘要和接收文件都会保留。',
      '清理旧日志',
      { type: 'warning', confirmButtonText: '清理', cancelButtonText: '取消' },
    )
    const removed = await store.clearLogs()
    if (removed !== null) ElMessage.success(`已清理 ${String(removed)} 个旧日志文件`)
  } catch {
    // 用户取消确认时无需提示错误。
  }
}

onMounted(() => void store.load())
</script>

<template>
  <div v-loading="store.loading" class="diagnostics-grid">
    <el-alert
      title="诊断报告只包含脱敏状态，不包含文字、文件名、设备名、备注、令牌、内部 ID、完整 IP 或日志正文。"
      type="info"
      :closable="false"
    />
    <el-card shadow="never">
      <template #header>
        <div class="card-header">
          <span>运行状态</span>
          <el-button @click="store.load">刷新</el-button>
        </div>
      </template>
      <el-descriptions v-if="store.summary" :column="2" border>
        <el-descriptions-item label="应用版本">{{ store.summary.appVersion }}</el-descriptions-item>
        <el-descriptions-item label="系统架构">
          {{ store.summary.platform === 'windows' ? 'Windows' : 'macOS' }} ·
          {{ store.summary.architecture }}
        </el-descriptions-item>
        <el-descriptions-item label="局域网服务">{{
          store.summary.service.state
        }}</el-descriptions-item>
        <el-descriptions-item label="监听端口">{{
          store.summary.service.port
        }}</el-descriptions-item>
        <el-descriptions-item label="连接状态">{{
          store.summary.connectionState
        }}</el-descriptions-item>
        <el-descriptions-item label="自动发现">{{
          store.summary.discoveryRunning ? '运行中' : '未运行'
        }}</el-descriptions-item>
        <el-descriptions-item label="活动任务">{{
          store.summary.activeTransferCount
        }}</el-descriptions-item>
        <el-descriptions-item label="可恢复任务">{{
          store.summary.recoverableTransferCount
        }}</el-descriptions-item>
        <el-descriptions-item label="历史摘要">
          {{ store.summary.historyEntries }} 条 ·
          {{ formatSize(store.summary.historyStorageBytes) }}
        </el-descriptions-item>
      </el-descriptions>
      <div class="action-row">
        <el-button type="primary" @click="exportReport">导出诊断报告</el-button>
        <el-button @click="store.openDirectory('data')">打开数据目录</el-button>
        <el-button @click="store.openDirectory('logs')">打开日志目录</el-button>
      </div>
    </el-card>

    <el-card shadow="never">
      <template #header><span>日志管理</span></template>
      <p v-if="store.logStats" class="log-summary">
        {{ store.logStats.fileCount }} 个日志文件，共 {{ formatSize(store.logStats.storageBytes) }}
        <template v-if="store.logStats.oldestEntryAt">
          · 最早更新于 {{ new Date(store.logStats.oldestEntryAt).toLocaleString() }}
        </template>
      </p>
      <el-button type="danger" plain @click="clearLogs">清理旧日志</el-button>
    </el-card>

    <el-alert
      v-if="store.errorMessage"
      :title="store.errorMessage"
      type="error"
      :closable="false"
    />
  </div>
</template>

<style scoped>
.diagnostics-grid {
  display: grid;
  gap: 20px;
}

.card-header,
.action-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.action-row {
  justify-content: flex-start;
  margin-top: 18px;
}

.log-summary {
  margin: 0 0 16px;
  color: var(--app-text-muted);
}
</style>

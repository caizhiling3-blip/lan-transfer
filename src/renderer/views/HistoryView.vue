<script setup lang="ts">
import { ElMessage, ElMessageBox } from 'element-plus'
import { onMounted, ref } from 'vue'

import { ERROR_MESSAGES_ZH_CN } from '@shared/errors'
import { MAX_HISTORY_SEARCH_LENGTH } from '@shared/constants'
import type { HistoryCleanupCriteriaDto, HistoryEntryDto, TransferStatus } from '@shared/types'

import HistoryStatusIcon from '../components/HistoryStatusIcon.vue'
import { useHistoryStore } from '../stores/history'

const store = useHistoryStore()
const selectedEntries = ref<HistoryEntryDto[]>([])
const MILLISECONDS_PER_DAY = 86_400_000

const statusLabels: Readonly<Record<TransferStatus, string>> = {
  pending: '等待中',
  awaitingAcceptance: '等待接受',
  accepted: '已接受',
  transferring: '传输中',
  paused: '已暂停',
  reconnecting: '正在重连',
  verifying: '校验续传状态',
  recoverable: '可继续',
  publishing: '等待发布',
  completed: '成功',
  failed: '失败',
  cancelled: '已取消',
  rejected: '已拒绝',
}

const formatSize = (size: number | undefined): string => {
  if (size === undefined) return '-'
  if (size < 1_024) return `${String(size)} B`
  if (size < 1_024 * 1_024) return `${(size / 1_024).toFixed(1)} KiB`
  return `${(size / 1_024 / 1_024).toFixed(1)} MiB`
}

const getSummary = (entry: HistoryEntryDto): string =>
  entry.kind === 'file' || entry.kind === 'folder'
    ? (entry.displayName ?? '-')
    : (entry.textPreview ?? '-')

const clearHistory = async (): Promise<void> => {
  try {
    await ElMessageBox.confirm('清空后无法恢复，确定清空全部传输历史吗？', '清空历史', {
      type: 'warning',
      confirmButtonText: '清空',
      cancelButtonText: '取消',
    })
    if (await store.clear()) ElMessage.success('历史记录已清空')
  } catch {
    // 用户取消确认时无需提示错误。
  }
}

const deleteEntries = async (entries: readonly HistoryEntryDto[]): Promise<void> => {
  if (entries.length === 0) return
  try {
    await ElMessageBox.confirm(
      `确定删除选中的 ${String(entries.length)} 条历史记录吗？`,
      '删除历史',
      {
        type: 'warning',
        confirmButtonText: '删除',
        cancelButtonText: '取消',
      },
    )
    const removed = await store.delete(entries.map((entry) => entry.id))
    if (removed > 0) ElMessage.success(`已删除 ${String(removed)} 条历史记录`)
  } catch {
    // 用户取消确认时无需提示错误。
  }
}

const cleanupByCriteria = async (
  criteria: HistoryCleanupCriteriaDto,
  title: string,
): Promise<void> => {
  const count = await store.previewCleanup(criteria)
  if (count === null) return
  if (count === 0) {
    ElMessage.info('没有符合条件的历史记录')
    return
  }
  try {
    await ElMessageBox.confirm(
      `将删除 ${String(count)} 条历史摘要，不会删除接收目录中的文件。是否继续？`,
      title,
      { type: 'warning', confirmButtonText: '清理', cancelButtonText: '取消' },
    )
    const removed = await store.cleanup(criteria)
    if (removed > 0) ElMessage.success(`已清理 ${String(removed)} 条历史记录`)
  } catch {
    // 用户取消确认时无需提示错误。
  }
}

const handleCleanupCommand = async (command: string): Promise<void> => {
  if (command === 'filtered') {
    const criteria = store.getCleanupCriteria()
    if (Object.keys(criteria).length === 0) {
      ElMessage.info('请先选择筛选条件，清空全部请使用“清空历史”')
      return
    }
    await cleanupByCriteria(criteria, '清理筛选结果')
    return
  }
  if (command === 'failed') {
    await cleanupByCriteria({ statuses: ['failed', 'cancelled', 'rejected'] }, '清理失败与取消记录')
    return
  }
  const days = Number(command)
  await cleanupByCriteria(
    { before: Date.now() - days * MILLISECONDS_PER_DAY },
    `清理 ${String(days)} 天前记录`,
  )
}

const formatStorageSize = (bytes: number): string =>
  bytes < 1_024 ? `${String(bytes)} B` : `${(bytes / 1_024).toFixed(1)} KiB`

onMounted(() => void store.load(true))
</script>

<template>
  <el-card class="history-card" shadow="never" body-class="history-card-body">
    <div class="history-toolbar">
      <div class="history-filters">
        <el-input
          v-model="store.filters.query"
          class="history-search"
          clearable
          :maxlength="MAX_HISTORY_SEARCH_LENGTH"
          placeholder="搜索内容、文件名或设备"
          aria-label="搜索历史记录"
          @keyup.enter="store.load(true)"
          @clear="store.load(true)"
        >
          <template #append>
            <el-button aria-label="搜索" @click="store.load(true)">搜索</el-button>
          </template>
        </el-input>
        <el-select v-model="store.filters.direction" aria-label="方向" @change="store.load(true)">
          <el-option label="全部方向" value="all" />
          <el-option label="发送" value="send" />
          <el-option label="接收" value="receive" />
        </el-select>
        <el-select v-model="store.filters.kind" aria-label="类型" @change="store.load(true)">
          <el-option label="全部类型" value="all" />
          <el-option label="文字" value="text" />
          <el-option label="链接" value="link" />
          <el-option label="文件" value="file" />
          <el-option label="文件夹" value="folder" />
        </el-select>
        <el-select v-model="store.filters.status" aria-label="状态" @change="store.load(true)">
          <el-option label="全部状态" value="all" />
          <el-option
            v-for="(label, status) in statusLabels"
            :key="status"
            :label="label"
            :value="status"
          />
        </el-select>
      </div>
      <div class="history-actions">
        <el-button :disabled="selectedEntries.length === 0" @click="deleteEntries(selectedEntries)">
          删除选中
        </el-button>
        <el-dropdown @command="handleCleanupCommand">
          <el-button>条件清理</el-button>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item command="filtered">清理当前筛选结果</el-dropdown-item>
              <el-dropdown-item command="failed">清理失败、取消和拒绝</el-dropdown-item>
              <el-dropdown-item command="30">清理 30 天前记录</el-dropdown-item>
              <el-dropdown-item command="90">清理 90 天前记录</el-dropdown-item>
              <el-dropdown-item command="180">清理 180 天前记录</el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
        <el-button
          type="danger"
          plain
          :disabled="store.stats.totalEntries === 0"
          @click="clearHistory"
        >
          清空历史
        </el-button>
      </div>
    </div>

    <el-alert
      v-if="store.errorMessage"
      class="history-error"
      :title="store.errorMessage"
      type="error"
      :closable="false"
    />

    <div class="history-table-area">
      <el-table
        v-loading="store.loading"
        height="100%"
        :data="store.entries"
        empty-text="暂无历史记录"
        @selection-change="(rows: HistoryEntryDto[]) => (selectedEntries = rows)"
      >
        <el-table-column type="selection" width="44" />
        <el-table-column label="方向" width="80">
          <template #default="{ row }: { row: HistoryEntryDto }">
            {{ row.direction === 'send' ? '发送' : '接收' }}
          </template>
        </el-table-column>
        <el-table-column label="类型" width="80">
          <template #default="{ row }: { row: HistoryEntryDto }">
            {{
              row.kind === 'folder'
                ? '文件夹'
                : row.kind === 'file'
                  ? '文件'
                  : row.kind === 'link'
                    ? '链接'
                    : '文字'
            }}
          </template>
        </el-table-column>
        <el-table-column label="内容" min-width="220" show-overflow-tooltip>
          <template #default="{ row }: { row: HistoryEntryDto }">{{ getSummary(row) }}</template>
        </el-table-column>
        <el-table-column label="对方设备" min-width="150">
          <template #default="{ row }: { row: HistoryEntryDto }">{{
            row.peer.deviceName
          }}</template>
        </el-table-column>
        <el-table-column label="大小" width="100">
          <template #default="{ row }: { row: HistoryEntryDto }">{{
            formatSize(row.size)
          }}</template>
        </el-table-column>
        <el-table-column label="状态" width="110">
          <template #default="{ row }: { row: HistoryEntryDto }">
            <el-tooltip
              :disabled="row.errorCode === undefined"
              :content="row.errorCode === undefined ? '' : ERROR_MESSAGES_ZH_CN[row.errorCode]"
            >
              <span class="status-cell">
                <HistoryStatusIcon :status="row.status" />
                {{ statusLabels[row.status] }}
              </span>
            </el-tooltip>
          </template>
        </el-table-column>
        <el-table-column label="时间" width="180">
          <template #default="{ row }: { row: HistoryEntryDto }">
            {{ new Date(row.createdAt).toLocaleString() }}
          </template>
        </el-table-column>
        <el-table-column label="操作" width="72" fixed="right">
          <template #default="{ row }: { row: HistoryEntryDto }">
            <el-button link type="danger" @click="deleteEntries([row])">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <div class="history-pagination">
      <span>
        共 {{ store.stats.totalEntries }} 条，当前筛选
        {{ store.stats.matchingEntries }} 条，数据占用
        {{ formatStorageSize(store.stats.storageBytes) }}
      </span>
      <el-button :disabled="store.page <= 1" @click="store.previousPage">上一页</el-button>
      <span>第 {{ store.page }} 页</span>
      <el-button :disabled="!store.hasNextPage" @click="store.nextPage">下一页</el-button>
    </div>
  </el-card>
</template>

<style scoped>
.history-card {
  display: flex;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  overflow: hidden;
}

:deep(.history-card-body) {
  display: flex;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  overflow: hidden;
}

.history-toolbar,
.history-filters,
.history-actions,
.history-pagination {
  display: flex;
  align-items: center;
  gap: 10px;
}

.history-toolbar {
  justify-content: space-between;
  margin-bottom: 18px;
}

.history-filters .el-select {
  width: 132px;
}

.history-search {
  width: min(320px, 30vw);
}

.history-error {
  margin-bottom: 16px;
}

.history-table-area {
  min-height: 0;
  flex: 1;
}

.status-cell {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  line-height: 18px;
}

.history-pagination {
  justify-content: flex-end;
  margin-top: 18px;
  color: var(--app-text-muted);
  font-size: 13px;
}

@media (max-width: 1200px) {
  .history-toolbar,
  .history-filters {
    align-items: stretch;
    flex-wrap: wrap;
  }

  .history-search {
    width: 100%;
  }
}
</style>

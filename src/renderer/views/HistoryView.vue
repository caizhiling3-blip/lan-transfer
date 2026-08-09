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
const emit = defineEmits<{ locateMessage: [entry: HistoryEntryDto] }>()

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

const getKindLabel = (kind: HistoryEntryDto['kind']): string =>
  kind === 'folder' ? '文件夹' : kind === 'file' ? '文件' : kind === 'link' ? '链接' : '文字'

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

const handleManagementCommand = async (command: string): Promise<void> => {
  if (command === 'delete-selected') {
    await deleteEntries(selectedEntries.value)
    return
  }
  if (command === 'clear-all') {
    await clearHistory()
    return
  }
  await handleCleanupCommand(command)
}

const handleRowCommand = async (command: string, entry: HistoryEntryDto): Promise<void> => {
  if (command === 'delete') await deleteEntries([entry])
}

const formatStorageSize = (bytes: number): string =>
  bytes < 1_024 ? `${String(bytes)} B` : `${(bytes / 1_024).toFixed(1)} KiB`

const isReceivedContent = (entry: HistoryEntryDto): boolean =>
  entry.direction === 'receive' &&
  (entry.kind === 'file' || entry.kind === 'folder') &&
  entry.status === 'completed'

const locateReceived = async (entry: HistoryEntryDto): Promise<void> => {
  const result = await window.lanTransfer.history.locateReceived(entry.id)
  if (!result.ok) ElMessage.error('文件或文件夹已被移动或删除，无法定位')
}

onMounted(() => void store.load(true))
</script>

<template>
  <el-card class="history-card" shadow="never" body-class="history-card-body">
    <div class="history-toolbar">
      <div class="history-query-row">
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
        <el-dropdown trigger="click" @command="handleManagementCommand">
          <el-button class="history-management-trigger">
            <span class="management-button-content">
              <span>数据管理</span>
              <svg class="management-chevron" viewBox="0 0 1024 1024" aria-hidden="true">
                <path
                  fill="currentColor"
                  d="M831.872 340.864 512 652.672 192.128 340.864a30.59 30.59 0 0 0-42.752 0 29.12 29.12 0 0 0 0 41.6L489.664 714.24a32 32 0 0 0 44.672 0l340.288-331.712a29.12 29.12 0 0 0 0-41.728 30.59 30.59 0 0 0-42.752 0z"
                />
              </svg>
            </span>
          </el-button>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item command="delete-selected" :disabled="selectedEntries.length === 0">
                删除选中记录
              </el-dropdown-item>
              <el-dropdown-item command="filtered">清理当前筛选结果</el-dropdown-item>
              <el-dropdown-item command="failed">清理失败、取消和拒绝</el-dropdown-item>
              <el-dropdown-item divided command="30">清理 30 天前记录</el-dropdown-item>
              <el-dropdown-item command="90">清理 90 天前记录</el-dropdown-item>
              <el-dropdown-item command="180">清理 180 天前记录</el-dropdown-item>
              <el-dropdown-item
                class="danger-menu-item"
                divided
                command="clear-all"
                :disabled="store.stats.totalEntries === 0"
              >
                清空全部历史
              </el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
      </div>
      <div class="history-filters" aria-label="历史筛选条件">
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
    </div>

    <el-alert
      v-if="store.errorMessage"
      class="history-error"
      :title="store.errorMessage"
      type="error"
      :closable="false"
    />

    <div
      class="history-table-area"
      :class="{ 'is-empty': !store.loading && store.entries.length === 0 }"
    >
      <el-table
        v-loading="store.loading"
        height="100%"
        :data="store.entries"
        empty-text="暂无历史记录"
        @selection-change="(rows: HistoryEntryDto[]) => (selectedEntries = rows)"
      >
        <el-table-column type="selection" width="44" />
        <el-table-column label="分类" width="126">
          <template #default="{ row }: { row: HistoryEntryDto }">
            <span class="history-category">
              <el-tag size="small" effect="plain">
                {{ row.direction === 'send' ? '发送' : '接收' }}
              </el-tag>
              <span>{{ getKindLabel(row.kind) }}</span>
            </span>
          </template>
        </el-table-column>
        <el-table-column label="内容" min-width="260" show-overflow-tooltip>
          <template #default="{ row }: { row: HistoryEntryDto }">
            <span class="history-content">
              <span>{{ getSummary(row) }}</span>
              <small>{{ row.peer.deviceName }}</small>
            </span>
          </template>
        </el-table-column>
        <el-table-column
          label="对方设备"
          min-width="150"
          class-name="history-peer-column"
          label-class-name="history-peer-column"
        >
          <template #default="{ row }: { row: HistoryEntryDto }">{{
            row.peer.deviceName
          }}</template>
        </el-table-column>
        <el-table-column
          label="大小"
          width="100"
          class-name="history-size-column"
          label-class-name="history-size-column"
        >
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
        <el-table-column label="操作" width="104" fixed="right" align="center">
          <template #default="{ row }: { row: HistoryEntryDto }">
            <span class="row-actions">
              <el-tooltip
                v-if="row.kind === 'text' || row.kind === 'link'"
                content="定位消息"
                placement="top"
              >
                <el-button
                  class="icon-action"
                  text
                  circle
                  type="primary"
                  aria-label="定位消息"
                  @click="emit('locateMessage', row)"
                >
                  <span aria-hidden="true">⌖</span>
                </el-button>
              </el-tooltip>
              <el-tooltip
                v-else-if="isReceivedContent(row)"
                :content="
                  row.locationAvailable === true
                    ? row.kind === 'folder'
                      ? '打开文件夹'
                      : '在文件夹中显示'
                    : '此记录没有保存位置信息，可能来自升级前的版本'
                "
                placement="top"
              >
                <span>
                  <el-button
                    class="icon-action"
                    text
                    circle
                    type="primary"
                    :aria-label="row.kind === 'folder' ? '打开文件夹' : '在文件夹中显示'"
                    :disabled="row.locationAvailable !== true"
                    @click="locateReceived(row)"
                  >
                    <span aria-hidden="true">↗</span>
                  </el-button>
                </span>
              </el-tooltip>
              <span v-else class="action-placeholder" aria-hidden="true"></span>
              <el-dropdown trigger="click" @command="handleRowCommand($event as string, row)">
                <el-button class="icon-action" text circle aria-label="更多操作">
                  <span aria-hidden="true">⋯</span>
                </el-button>
                <template #dropdown>
                  <el-dropdown-menu>
                    <el-dropdown-item class="danger-menu-item" command="delete">
                      删除记录
                    </el-dropdown-item>
                  </el-dropdown-menu>
                </template>
              </el-dropdown>
            </span>
          </template>
        </el-table-column>
      </el-table>
      <div v-if="!store.loading && store.entries.length === 0" class="history-empty" role="status">
        暂无历史记录
      </div>
    </div>

    <div class="history-pagination">
      <span class="history-stats">
        共 {{ store.stats.totalEntries }} 条，当前筛选
        {{ store.stats.matchingEntries }} 条，数据占用
        {{ formatStorageSize(store.stats.storageBytes) }}
      </span>
      <span class="pagination-controls">
        <el-button :disabled="store.page <= 1" @click="store.previousPage">上一页</el-button>
        <span>第 {{ store.page }} 页</span>
        <el-button :disabled="!store.hasNextPage" @click="store.nextPage">下一页</el-button>
      </span>
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

.history-query-row,
.history-filters,
.history-pagination,
.pagination-controls,
.history-category,
.row-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

.history-toolbar {
  display: grid;
  gap: 10px;
  margin-bottom: 18px;
}

.history-query-row {
  justify-content: space-between;
}

.management-button-content {
  display: inline-flex;
  width: 100%;
  align-items: center;
  justify-content: space-between;
  line-height: 24px;
}

.management-chevron {
  width: 14px;
  height: 14px;
  flex: 0 0 auto;
  color: var(--el-text-color-placeholder);
  transition: transform var(--el-transition-duration);
}

.history-management-trigger.el-button {
  width: 132px;
  height: 32px;
  padding: 4px 12px;
  border: 0;
  border-radius: 4px;
  color: var(--el-text-color-primary);
  background: var(--el-fill-color-blank);
  box-shadow: 0 0 0 1px var(--el-border-color) inset;
  font-weight: 400;
}

:deep(.history-management-trigger.el-button > span) {
  width: 100%;
}

.history-management-trigger.el-button:hover {
  color: var(--el-text-color-primary);
  background: var(--el-fill-color-blank);
  box-shadow: 0 0 0 1px var(--el-border-color-hover) inset;
}

.history-management-trigger.el-button:focus-visible {
  color: var(--el-text-color-primary);
  background: var(--el-fill-color-blank);
  outline: 0;
  box-shadow: 0 0 0 1px var(--el-color-primary) inset;
}

.history-filters .el-select {
  width: 132px;
}

.history-search {
  width: min(100%, 560px);
}

.history-error {
  margin-bottom: 16px;
}

.history-table-area {
  position: relative;
  min-height: 0;
  flex: 1;
}

.history-table-area.is-empty :deep(.el-table__empty-block) {
  display: none;
}

.history-empty {
  position: absolute;
  z-index: 2;
  inset: 0;
  display: grid;
  place-items: center;
  color: var(--app-text-subtle);
  pointer-events: none;
}

.history-category {
  gap: 7px;
  white-space: nowrap;
}

.history-content {
  display: grid;
  min-width: 0;
}

.history-content > span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.history-content small {
  display: none;
  overflow: hidden;
  margin-top: 2px;
  color: var(--app-text-subtle);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.status-cell {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  line-height: 18px;
}

.history-pagination {
  justify-content: space-between;
  margin-top: 18px;
  color: var(--app-text-muted);
  font-size: 13px;
}

.history-stats {
  min-width: 0;
}

.pagination-controls {
  flex: 0 0 auto;
}

.row-actions {
  justify-content: center;
  gap: 2px;
}

.icon-action {
  width: 32px;
  height: 32px;
  font-size: 18px;
}

.action-placeholder {
  width: 32px;
  height: 32px;
}

:global(.danger-menu-item) {
  color: var(--el-color-danger);
}

@media (max-width: 1200px) {
  .history-filters {
    flex-wrap: wrap;
  }
}

@media (max-width: 1050px) {
  :deep(.history-size-column) {
    display: none;
  }

  :deep(.history-card-body) {
    padding-inline: 14px;
  }
}

@media (max-width: 950px) {
  :deep(.history-peer-column) {
    display: none;
  }

  .history-content small {
    display: block;
  }

  .history-pagination {
    align-items: flex-start;
    flex-direction: column;
  }

  .pagination-controls {
    width: 100%;
    justify-content: space-between;
  }
}
</style>

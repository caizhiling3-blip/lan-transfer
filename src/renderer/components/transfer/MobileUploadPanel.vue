<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import QRCode from 'qrcode'

import type {
  MobileUploadOfferDto,
  MobileUploadSessionDto,
  MobileUploadTaskDto,
} from '@shared/types'
import { useMobileUploadStore } from '../../stores/mobile-upload'

const visible = ref(false)
const creating = ref(false)
const responding = ref(false)
const mobileStore = useMobileUploadStore()
const session = computed<MobileUploadSessionDto | null>(() => mobileStore.session)
const offer = computed<MobileUploadOfferDto | null>(() => mobileStore.offer)
const task = computed<MobileUploadTaskDto | null>(() => {
  const sessionId = session.value?.sessionId
  if (sessionId === undefined) return null
  return mobileStore.tasks.find((candidate) => candidate.sessionId === sessionId) ?? null
})
const downloads = computed(() => mobileStore.downloads)
const selectingDownloads = ref(false)
const qrCanvas = ref<HTMLCanvasElement | null>(null)
const selectedUrl = ref('')
const expiresIn = ref('')
const totalSize = computed(
  () => offer.value?.files.reduce((total, file) => total + file.size, 0) ?? 0,
)
const progress = computed(() => {
  if (task.value === null) return 0
  if (task.value.totalBytes === 0) return task.value.status === 'completed' ? 100 : 0
  return Math.round((task.value.transferredBytes / task.value.totalBytes) * 100)
})

const formatBytes = (bytes: number): string => {
  if (bytes < 1_024) return `${bytes} B`
  if (bytes < 1_024 ** 2) return `${(bytes / 1_024).toFixed(1)} KB`
  return `${(bytes / 1_024 ** 2).toFixed(1)} MB`
}
const formatHost = (url: string): string => new URL(url).host

watch(
  () => session.value?.urls,
  (urls) => {
    if (urls !== undefined && !urls.includes(selectedUrl.value)) selectedUrl.value = urls[0] ?? ''
  },
  { immediate: true },
)

watch(selectedUrl, async (url) => {
  await nextTick()
  if (url !== '' && qrCanvas.value !== null) {
    await QRCode.toCanvas(qrCanvas.value, url, { width: 256, margin: 1 })
  }
})

const updateExpiresIn = (): void => {
  if (session.value === null) {
    expiresIn.value = ''
    return
  }
  const seconds = Math.max(0, Math.ceil((session.value.expiresAt - Date.now()) / 1_000))
  if (seconds === 0) {
    expiresIn.value = '已过期'
    return
  }
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = String(seconds % 60).padStart(2, '0')
  expiresIn.value = `${minutes}:${remainingSeconds}`
}
const expiryTimer = setInterval(updateExpiresIn, 1_000)
watch(session, updateExpiresIn, { immediate: true })
onBeforeUnmount(() => clearInterval(expiryTimer))

const open = async (): Promise<void> => {
  visible.value = true
  updateExpiresIn()
  if (session.value !== null) return
  creating.value = true
  const result = await window.lanTransfer.mobileUpload.createSession()
  creating.value = false
  if (result.ok) mobileStore.session = result.data
  else ElMessage.error('无法创建手机传输会话，请确认本地服务正在运行')
}

const closeSession = async (): Promise<void> => {
  await window.lanTransfer.mobileUpload.closeSession()
  mobileStore.session = null
  mobileStore.offer = null
  visible.value = false
}

const respond = async (decision: 'accept' | 'reject'): Promise<void> => {
  if (offer.value === null) return
  responding.value = true
  const result = await window.lanTransfer.mobileUpload.respondToOffer(offer.value.batchId, decision)
  responding.value = false
  if (!result.ok) ElMessage.error('该上传请求已失效')
  mobileStore.offer = null
}

const copyUrl = async (): Promise<void> => {
  const result = await window.lanTransfer.clipboard.writeText(selectedUrl.value)
  if (result.ok) ElMessage.success('手机传输地址已复制')
}

const cancelTask = async (): Promise<void> => {
  if (task.value === null) return
  await window.lanTransfer.mobileUpload.cancel(task.value.batchId)
}

const showReceived = async (): Promise<void> => {
  if (task.value === null) return
  const result = await window.lanTransfer.mobileUpload.showReceived(task.value.batchId)
  if (!result.ok) ElMessage.error('文件已被移动或删除，无法定位')
}

const selectDownloads = async (): Promise<void> => {
  selectingDownloads.value = true
  const selected = await window.lanTransfer.transfer.selectFiles(true)
  if (!selected.ok) {
    selectingDownloads.value = false
    ElMessage.error('无法选择文件')
    return
  }
  if (selected.data.length === 0) {
    selectingDownloads.value = false
    return
  }
  const result = await window.lanTransfer.mobileUpload.publishDownloads(
    selected.data.map(({ selectionToken }) => selectionToken),
  )
  selectingDownloads.value = false
  if (!result.ok) ElMessage.error('文件授权已失效，请重新选择')
}

const clearDownloads = async (): Promise<void> => {
  await window.lanTransfer.mobileUpload.clearDownloads()
}

watch(offer, (value) => {
  if (value !== null) visible.value = true
})
</script>

<template>
  <el-button type="primary" plain @click="open">手机扫码传输</el-button>
  <el-dialog v-model="visible" title="手机与电脑互传" width="min(94vw, 820px)">
    <div v-loading="creating" class="mobile-upload-dialog">
      <el-alert
        title="仅在你信任的 Wi-Fi 中使用；局域网 HTTP 不具备 HTTPS 链路加密"
        type="warning"
        :closable="false"
        show-icon
      />
      <div v-if="session !== null" class="mobile-upload-grid">
        <section class="scan-pane">
          <span class="step-label">步骤 1 · 手机扫码</span>
          <canvas ref="qrCanvas" class="mobile-upload-qr" aria-label="手机传输二维码" />
          <strong>二维码剩余 {{ expiresIn }}</strong>
          <p>手机和电脑需处于同一局域网。切换 Wi-Fi 或热点后请重新创建二维码。</p>
          <el-select
            v-if="session.urls.length > 1"
            v-model="selectedUrl"
            aria-label="选择局域网地址"
          >
            <el-option
              v-for="url in session.urls"
              :key="url"
              :label="formatHost(url)"
              :value="url"
            />
          </el-select>
          <el-button link type="primary" @click="copyUrl">复制当前传输地址</el-button>
        </section>

        <section class="receive-pane">
          <span class="step-label">步骤 2 · 电脑确认</span>
          <div v-if="offer !== null" class="mobile-upload-offer">
            <strong>来自 {{ offer.sourceAddress }}</strong>
            <p>{{ offer.files.length }} 个文件，共 {{ formatBytes(totalSize) }}</p>
            <ul>
              <li v-for="file in offer.files" :key="file.fileId">
                <span :title="file.displayName">{{ file.displayName }}</span>
                <small>{{ formatBytes(file.size) }}</small>
              </li>
            </ul>
            <div class="offer-actions">
              <el-button :loading="responding" @click="respond('reject')">拒绝</el-button>
              <el-button type="primary" :loading="responding" @click="respond('accept')">
                接收到下载目录
              </el-button>
            </div>
          </div>
          <div v-else-if="task !== null" class="mobile-upload-offer task-state">
            <strong>手机上传 · {{ task.files.length }} 个文件</strong>
            <p>
              {{
                task.status === 'completed'
                  ? '全部文件已保存'
                  : task.status === 'rejected'
                    ? '已拒绝'
                    : task.status === 'cancelled'
                      ? '已取消'
                      : task.status === 'failed'
                        ? '上传失败'
                        : '正在接收，请保持手机页面开启'
              }}
            </p>
            <el-progress :percentage="progress" />
            <div class="task-buttons">
              <el-button
                v-if="['accepted', 'transferring'].includes(task.status)"
                type="danger"
                plain
                @click="cancelTask"
                >取消上传</el-button
              >
              <el-button
                v-if="task.status === 'completed'"
                type="primary"
                plain
                @click="showReceived"
                >在文件夹中显示</el-button
              >
            </div>
          </div>
          <el-empty v-else description="等待手机选择文件" :image-size="76" />
          <div class="pc-to-mobile">
            <div class="pc-to-mobile-title">
              <div>
                <span class="step-label">电脑发到手机</span>
                <p>选择后，手机扫码页面可逐个下载</p>
              </div>
              <el-button
                size="small"
                type="primary"
                plain
                :loading="selectingDownloads"
                @click="selectDownloads"
                >{{ downloads === null ? '选择文件' : '替换文件' }}</el-button
              >
            </div>
            <template v-if="downloads !== null">
              <ul class="download-list">
                <li v-for="file in downloads.files" :key="file.fileId">
                  <span :title="file.displayName">{{ file.displayName }}</span>
                  <small>{{
                    file.status === 'downloaded' ? '已下载' : formatBytes(file.size)
                  }}</small>
                </li>
              </ul>
              <el-button link type="danger" @click="clearDownloads">停止分享</el-button>
            </template>
            <p v-else class="empty-downloads">尚未选择供手机下载的文件</p>
          </div>
        </section>
      </div>
      <el-empty v-else-if="!creating" description="手机传输会话未开启" />
    </div>
    <template #footer>
      <el-button @click="visible = false">暂时收起</el-button>
      <el-button type="danger" plain @click="closeSession">关闭会话</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.mobile-upload-dialog {
  min-height: 360px;
}

.mobile-upload-grid {
  display: grid;
  grid-template-columns: minmax(270px, 0.85fr) minmax(320px, 1.15fr);
  gap: 18px;
  margin-top: 18px;
}
.scan-pane,
.receive-pane {
  min-height: 310px;
  padding: 18px;
  border: 1px solid var(--app-border);
  border-radius: 14px;
  background: var(--app-surface);
}
.scan-pane {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
}
.scan-pane p {
  margin: 8px 0;
  color: var(--app-text-muted);
  font-size: 12px;
  line-height: 1.6;
}
.step-label {
  align-self: flex-start;
  color: var(--app-text-muted);
  font-size: 12px;
  font-weight: 600;
}

.mobile-upload-qr {
  display: block;
  width: 256px;
  max-width: 80%;
  margin: 14px auto 10px;
  border-radius: 12px;
}

.mobile-upload-offer {
  margin-top: 14px;
}

.mobile-upload-offer ul,
.download-list {
  max-height: 190px;
  overflow: auto;
  padding: 0;
  list-style: none;
}
.mobile-upload-offer li,
.download-list li {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 4px 12px;
  padding: 8px 0;
  border-bottom: 1px solid var(--app-border);
}
.mobile-upload-offer li span,
.download-list li span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mobile-upload-offer li small,
.download-list li small {
  align-self: center;
  flex: none;
  color: var(--app-text-muted);
}

.offer-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.task-buttons {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  margin-top: 16px;
}
.pc-to-mobile {
  margin-top: 18px;
  padding-top: 16px;
  border-top: 1px solid var(--app-border);
}
.pc-to-mobile-title {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}
.pc-to-mobile-title p,
.empty-downloads {
  margin: 5px 0 0;
  color: var(--app-text-muted);
  font-size: 12px;
}
.download-list {
  max-height: 126px !important;
  margin: 10px 0 4px;
}
@media (max-width: 720px) {
  .mobile-upload-grid {
    grid-template-columns: 1fr;
  }
  .scan-pane,
  .receive-pane {
    min-height: auto;
  }
}
</style>

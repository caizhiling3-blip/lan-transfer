<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ElMessageBox } from 'element-plus'

import { DEFAULT_SERVICE_PORT } from '@shared/constants'
import type { ServiceState } from '@shared/types'

import { useConnectionStore } from '../stores/connection'
import { useServiceStore } from '../stores/service'

const serviceStore = useServiceStore()
const connectionStore = useConnectionStore()
const peerIp = ref('')
const peerPort = ref(DEFAULT_SERVICE_PORT)
const localDeviceName = ref('')
const localOperatingSystem = ref('')

const statusPresentations: Readonly<
  Record<
    ServiceState,
    { readonly label: string; readonly type: 'success' | 'warning' | 'danger' | 'info' }
  >
> = {
  running: { label: '运行中', type: 'success' },
  starting: { label: '启动中', type: 'warning' },
  error: { label: '异常', type: 'danger' },
  stopped: { label: '已停止', type: 'info' },
}

const statusPresentation = computed(() => statusPresentations[serviceStore.status.state])
const isConnected = computed(() => connectionStore.status.state === 'connected')

watch(
  () => connectionStore.incomingRequest,
  (request) => {
    if (request === null) return
    const description =
      request.peer.deviceName +
      '（' +
      request.peer.ipAddress +
      ':' +
      String(request.peer.servicePort) +
      '）请求连接'
    void ElMessageBox.confirm(description, '设备连接请求', {
      confirmButtonText: '允许',
      cancelButtonText: '拒绝',
      type: 'warning',
      distinguishCancelAndClose: true,
    })
      .then(() => connectionStore.respondToIncoming('accept'))
      .catch(() => connectionStore.respondToIncoming('reject'))
  },
)

onMounted(() => {
  void serviceStore.initialize()
  void connectionStore.initialize()
  void window.lanTransfer.app.getRuntimeInfo().then((result) => {
    if (result.ok) {
      localDeviceName.value = result.data.localDevice.deviceName
      localOperatingSystem.value = result.data.platform === 'windows' ? 'Windows' : 'macOS'
    }
  })
})

onBeforeUnmount(() => {
  serviceStore.dispose()
  connectionStore.dispose()
})
</script>

<template>
  <div v-loading="serviceStore.loading" class="home-grid">
    <el-card shadow="never">
      <template #header>
        <div class="card-header">
          <span>本机服务</span>
          <el-tag :type="statusPresentation.type">{{ statusPresentation.label }}</el-tag>
        </div>
      </template>

      <el-descriptions :column="1" border>
        <el-descriptions-item label="设备名称">{{ localDeviceName || '-' }}</el-descriptions-item>
        <el-descriptions-item label="操作系统">{{
          localOperatingSystem || '-'
        }}</el-descriptions-item>
        <el-descriptions-item label="本机 IP">
          <div v-if="serviceStore.status.ipAddresses.length > 0" class="ip-list">
            <el-tag
              v-for="ipAddress in serviceStore.status.ipAddresses"
              :key="ipAddress"
              effect="plain"
            >
              {{ ipAddress }}
            </el-tag>
          </div>
          <span v-else>未检测到可用的局域网 IPv4</span>
        </el-descriptions-item>
        <el-descriptions-item label="服务端口">{{ serviceStore.status.port }}</el-descriptions-item>
      </el-descriptions>
      <el-alert
        v-if="serviceStore.errorMessage"
        class="message-alert"
        :title="serviceStore.errorMessage"
        type="error"
        :closable="false"
      />
    </el-card>

    <el-card shadow="never">
      <template #header>连接设备</template>
      <template v-if="isConnected && connectionStore.status.peer">
        <el-descriptions :column="1" border>
          <el-descriptions-item label="连接状态"
            ><el-tag type="success">已连接</el-tag></el-descriptions-item
          >
          <el-descriptions-item label="对方设备">{{
            connectionStore.status.peer.deviceName
          }}</el-descriptions-item>
          <el-descriptions-item label="操作系统">
            {{ connectionStore.status.peer.operatingSystem === 'windows' ? 'Windows' : 'macOS' }}
          </el-descriptions-item>
          <el-descriptions-item label="地址">
            {{ connectionStore.status.peer.ipAddress }}:{{
              connectionStore.status.peer.servicePort
            }}
          </el-descriptions-item>
        </el-descriptions>
        <el-button class="connection-action" @click="connectionStore.disconnect()"
          >断开连接</el-button
        >
      </template>
      <el-form v-else label-position="top" @submit.prevent>
        <el-form-item label="对方 IP">
          <el-input v-model="peerIp" placeholder="例如 192.168.1.20" />
        </el-form-item>
        <el-form-item label="对方端口">
          <el-input-number v-model="peerPort" :min="1024" :max="65535" controls-position="right" />
        </el-form-item>
        <el-button
          type="primary"
          :loading="connectionStore.loading"
          :disabled="!peerIp || connectionStore.status.state !== 'disconnected'"
          @click="connectionStore.connect(peerIp, peerPort)"
        >
          连接
        </el-button>
        <el-tag class="connection-state" effect="plain">{{ connectionStore.status.state }}</el-tag>
      </el-form>
      <el-alert
        v-if="connectionStore.errorMessage"
        class="message-alert"
        :title="connectionStore.errorMessage"
        type="error"
        :closable="false"
      />
    </el-card>
  </div>
</template>

<style scoped>
.home-grid {
  display: grid;
  gap: 20px;
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.ip-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.message-alert,
.connection-action,
.connection-state {
  margin-top: 16px;
}
</style>

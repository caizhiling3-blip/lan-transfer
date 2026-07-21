<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

import { DEFAULT_SERVICE_PORT } from '@shared/constants'
import type { ConnectionState, ServiceState } from '@shared/types'

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
const connectionPresentations: Readonly<
  Record<
    ConnectionState,
    {
      readonly label: string
      readonly tone: 'neutral' | 'progress' | 'success' | 'danger'
      readonly description: string
    }
  >
> = {
  disconnected: {
    label: '未连接',
    tone: 'neutral',
    description: '当前没有连接其他设备，请填写同一局域网内的设备地址。',
  },
  connecting: {
    label: '正在连接',
    tone: 'progress',
    description: '正在联系对方设备，请稍候。',
  },
  awaitingApproval: {
    label: '等待对方确认',
    tone: 'progress',
    description: '连接请求已发送，等待对方允许连接。',
  },
  connected: {
    label: '已连接',
    tone: 'success',
    description: '设备连接正常，可以开始传输。',
  },
  disconnecting: {
    label: '正在断开',
    tone: 'progress',
    description: '正在安全断开设备连接。',
  },
  error: {
    label: '连接异常',
    tone: 'danger',
    description: '连接出现异常，请检查网络或重新连接。',
  },
}
const connectionPresentation = computed(() => connectionPresentations[connectionStore.status.state])
const isConnected = computed(() => connectionStore.status.state === 'connected')

onMounted(() => {
  void serviceStore.initialize()
  void window.lanTransfer.app.getRuntimeInfo().then((result) => {
    if (result.ok) {
      localDeviceName.value = result.data.localDevice.deviceName
      localOperatingSystem.value = result.data.platform === 'windows' ? 'Windows' : 'macOS'
    }
  })
  void window.lanTransfer.connection.listRecentDevices().then((result) => {
    const recent = result.ok ? result.data[0] : undefined
    if (recent !== undefined && peerIp.value === '') {
      peerIp.value = recent.device.ipAddress
      peerPort.value = recent.device.servicePort
    }
  })
})

onBeforeUnmount(() => {
  serviceStore.dispose()
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
      <template #header>
        <div class="card-header">
          <span>连接设备</span>
          <span
            class="connection-status"
            :class="`is-${connectionPresentation.tone}`"
            role="status"
          >
            <span class="connection-status-dot" aria-hidden="true"></span>
            {{ connectionPresentation.label }}
          </span>
        </div>
      </template>
      <template v-if="isConnected && connectionStore.status.peer">
        <el-descriptions :column="1" border>
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
        <el-button class="connection-action" plain @click="connectionStore.disconnect()"
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
        <div class="connection-form-footer">
          <el-button
            type="primary"
            :loading="connectionStore.loading"
            :disabled="!peerIp || connectionStore.status.state !== 'disconnected'"
            @click="connectionStore.connect(peerIp, peerPort)"
          >
            连接设备
          </el-button>
          <span>{{ connectionPresentation.description }}</span>
        </div>
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
.connection-action {
  margin-top: 16px;
}

.connection-status {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 5px 10px;
  border-radius: 999px;
  color: #64748b;
  background: #f1f5f9;
  font-size: 12px;
  font-weight: 600;
}

.connection-status-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: currentcolor;
}

.connection-status.is-progress {
  color: #d97706;
  background: #fffbeb;
}

.connection-status.is-success {
  color: #16a34a;
  background: #f0fdf4;
}

.connection-status.is-danger {
  color: #dc2626;
  background: #fef2f2;
}

.connection-form-footer {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-top: 4px;
}

.connection-form-footer span {
  color: #64748b;
  font-size: 12px;
  line-height: 1.5;
}
</style>

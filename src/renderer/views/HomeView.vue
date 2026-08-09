<script setup lang="ts">
import { ElMessage, ElMessageBox } from 'element-plus'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import { DEFAULT_SERVICE_PORT } from '@shared/constants'
import { ERROR_RECOVERY_ADVICE_ZH_CN } from '@shared/errors'
import type { ConnectionState, ServiceState } from '@shared/types'
import type { DeviceInfo, RecentDeviceDto } from '@shared/types'

import { useConnectionStore } from '../stores/connection'
import { useDiscoveryStore } from '../stores/discovery'
import { useServiceStore } from '../stores/service'
import { useRecentDevicesStore } from '../stores/recent-devices'

const serviceStore = useServiceStore()
const connectionStore = useConnectionStore()
const discoveryStore = useDiscoveryStore()
const recentDevicesStore = useRecentDevicesStore()
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
  authenticating: {
    label: '正在验证身份',
    tone: 'progress',
    description: '正在验证设备签名并建立加密会话。',
  },
  pairingRequired: {
    label: '等待安全配对',
    tone: 'progress',
    description: '请在发起连接的设备上输入对方显示的六位验证码。',
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
const canConnect = computed(() => ['disconnected', 'error'].includes(connectionStore.status.state))
const connectionRecoveryAdvice = computed(() =>
  connectionStore.status.errorCode === undefined
    ? null
    : ERROR_RECOVERY_ADVICE_ZH_CN[connectionStore.status.errorCode],
)

const connectDiscoveredDevice = (device: DeviceInfo): void => {
  peerIp.value = device.ipAddress
  peerPort.value = device.servicePort
  if (canConnect.value) {
    void connectionStore.connect(device.ipAddress, device.servicePort)
  }
}

const isRecentDeviceOnline = (recent: RecentDeviceDto): boolean =>
  discoveryStore.devices.some((discovered) => discovered.device.deviceId === recent.device.deviceId)

const getRecentConnectDevice = (recent: RecentDeviceDto): DeviceInfo =>
  discoveryStore.devices.find((discovered) => discovered.device.deviceId === recent.device.deviceId)
    ?.device ?? recent.device

watch(
  () => connectionStore.status.state,
  (state) => {
    if (state === 'connected') void recentDevicesStore.load()
  },
)

const editRecentAlias = async (recent: RecentDeviceDto): Promise<void> => {
  try {
    const result = await ElMessageBox.prompt('备注只保存在本机，不会发送给对方。', '设备备注', {
      inputValue: recent.alias ?? '',
      inputPlaceholder: '例如：书房 Mac',
      inputValidator: (value) => value.trim().length <= 64 || '备注不能超过 64 个字符',
      confirmButtonText: '保存',
      cancelButtonText: '取消',
    })
    const alias = result.value.trim()
    if (await recentDevicesStore.updateAlias(recent.device.deviceId, alias === '' ? null : alias)) {
      ElMessage.success('设备备注已更新')
    }
  } catch {
    // 用户取消输入时无需提示错误。
  }
}

const removeRecentDevice = async (recent: RecentDeviceDto): Promise<void> => {
  try {
    await ElMessageBox.confirm(
      `确定从最近设备中移除“${recent.alias ?? recent.device.deviceName}”吗？`,
      '移除设备',
      {
        type: 'warning',
        confirmButtonText: '移除',
        cancelButtonText: '取消',
      },
    )
    if (await recentDevicesStore.remove(recent.device.deviceId)) ElMessage.success('最近设备已移除')
  } catch {
    // 用户取消确认时无需提示错误。
  }
}

const clearRecentDevices = async (): Promise<void> => {
  try {
    await ElMessageBox.confirm('确定清空全部最近设备吗？这不会影响当前连接。', '清空最近设备', {
      type: 'warning',
      confirmButtonText: '清空',
      cancelButtonText: '取消',
    })
    if (await recentDevicesStore.clear()) ElMessage.success('最近设备已清空')
  } catch {
    // 用户取消确认时无需提示错误。
  }
}

onMounted(() => {
  void serviceStore.initialize()
  void discoveryStore.initialize()
  void recentDevicesStore.load()
  void window.lanTransfer.app.getRuntimeInfo().then((result) => {
    if (result.ok) {
      localDeviceName.value = result.data.localDevice.deviceName
      localOperatingSystem.value = result.data.platform === 'windows' ? 'Windows' : 'macOS'
    }
  })
  void window.lanTransfer.recentDevices.list().then((result) => {
    const recent = result.ok ? result.data[0] : undefined
    if (recent !== undefined && peerIp.value === '') {
      peerIp.value = recent.device.ipAddress
      peerPort.value = recent.device.servicePort
    }
  })
})

onBeforeUnmount(() => {
  serviceStore.dispose()
  discoveryStore.dispose()
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

    <el-card v-loading="recentDevicesStore.loading" shadow="never">
      <template #header>
        <div class="card-header">
          <span>最近设备</span>
          <el-button
            link
            type="danger"
            :disabled="recentDevicesStore.devices.length === 0"
            @click="clearRecentDevices"
          >
            清空
          </el-button>
        </div>
      </template>
      <el-empty
        v-if="recentDevicesStore.devices.length === 0"
        :image-size="56"
        description="连接成功的设备会出现在这里"
      />
      <div v-else class="nearby-list">
        <div
          v-for="recent in recentDevicesStore.devices"
          :key="recent.device.deviceId"
          class="nearby-device recent-device"
        >
          <div class="recent-device-info">
            <div class="recent-device-title">
              <strong>{{ recent.alias ?? recent.device.deviceName }}</strong>
              <el-tag :type="isRecentDeviceOnline(recent) ? 'success' : 'info'" size="small">
                {{ isRecentDeviceOnline(recent) ? '在线' : '未发现' }}
              </el-tag>
            </div>
            <p v-if="recent.alias">
              {{ recent.device.deviceName }} · {{ recent.device.ipAddress }}:{{
                recent.device.servicePort
              }}
            </p>
            <p v-else>{{ recent.device.ipAddress }}:{{ recent.device.servicePort }}</p>
            <small>上次连接：{{ new Date(recent.lastConnectedAt).toLocaleString() }}</small>
          </div>
          <div class="recent-device-actions">
            <el-button link @click="editRecentAlias(recent)">备注</el-button>
            <el-button link type="danger" @click="removeRecentDevice(recent)">移除</el-button>
            <el-button
              type="primary"
              plain
              :loading="connectionStore.loading"
              :disabled="!canConnect"
              @click="connectDiscoveredDevice(getRecentConnectDevice(recent))"
            >
              连接
            </el-button>
          </div>
        </div>
      </div>
      <el-alert
        v-if="recentDevicesStore.errorMessage"
        class="message-alert"
        :title="recentDevicesStore.errorMessage"
        type="error"
        :closable="false"
      />
    </el-card>

    <el-card shadow="never">
      <template #header>
        <div class="card-header">
          <span>附近设备</span>
          <el-tag type="info" effect="plain">{{ discoveryStore.devices.length }} 台在线</el-tag>
        </div>
      </template>
      <div v-if="discoveryStore.devices.length === 0" class="discovery-empty">
        <el-empty :image-size="64" description="正在查找同一局域网内的设备" />
        <p>
          列表不会显示本机。请在另一台设备启动邻渡并允许专用网络访问；仍未发现时可使用手动 IP 连接。
        </p>
      </div>
      <div v-else class="nearby-list">
        <div
          v-for="discovered in discoveryStore.devices"
          :key="discovered.device.deviceId"
          class="nearby-device"
        >
          <div>
            <strong>{{ discovered.device.deviceName }}</strong>
            <p>
              {{ discovered.device.operatingSystem === 'windows' ? 'Windows' : 'macOS' }} ·
              {{ discovered.device.ipAddress }}:{{ discovered.device.servicePort }}
            </p>
          </div>
          <el-button
            type="primary"
            plain
            :loading="connectionStore.loading"
            :disabled="!canConnect"
            @click="connectDiscoveredDevice(discovered.device)"
          >
            连接
          </el-button>
        </div>
      </div>
      <el-alert
        v-if="discoveryStore.errorMessage"
        class="message-alert"
        :title="discoveryStore.errorMessage"
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
            :disabled="!peerIp || !canConnect"
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
      >
        <template #default>
          <span v-if="connectionRecoveryAdvice">{{ connectionRecoveryAdvice.suggestion }}</span>
        </template>
      </el-alert>
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

.recent-device-info {
  min-width: 0;
}

.recent-device-title,
.recent-device-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.recent-device-info small {
  color: var(--app-text-subtle);
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
  color: var(--app-text-muted);
  background: var(--app-surface-muted);
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
  color: var(--app-warning-text);
  background: var(--app-warning-soft);
}

.connection-status.is-success {
  color: var(--app-success-text);
  background: var(--app-success-soft);
}

.connection-status.is-danger {
  color: var(--app-danger-text);
  background: var(--app-danger-soft);
}

.connection-form-footer {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-top: 4px;
}

.connection-form-footer span {
  color: var(--app-text-muted);
  font-size: 12px;
  line-height: 1.5;
}

.nearby-list {
  display: grid;
  gap: 10px;
}

.discovery-empty p {
  max-width: 520px;
  margin: -10px auto 16px;
  color: var(--app-text-muted);
  font-size: 12px;
  line-height: 1.6;
  text-align: center;
}

.nearby-device {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 12px 14px;
  border: 1px solid var(--app-border);
  border-radius: 10px;
  background: var(--app-surface-muted);
}

.nearby-device p {
  margin: 5px 0 0;
  color: var(--app-text-muted);
  font-size: 12px;
}
</style>

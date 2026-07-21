<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from 'vue'

import type { ServiceState } from '@shared/types'

import { useServiceStore } from '../stores/service'

const serviceStore = useServiceStore()

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

onMounted(() => {
  void serviceStore.initialize()
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
        <el-descriptions-item label="服务端口">
          {{ serviceStore.status.port }}
        </el-descriptions-item>
      </el-descriptions>

      <el-alert
        v-if="serviceStore.errorMessage"
        class="service-error"
        :title="serviceStore.errorMessage"
        type="error"
        :closable="false"
      />
    </el-card>

    <el-card shadow="never">
      <template #header>连接设备</template>
      <el-empty description="手动连接与设备握手将在阶段 6 实现" />
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

.service-error {
  margin-top: 16px;
}
</style>

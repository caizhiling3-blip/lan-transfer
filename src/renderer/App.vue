<script setup lang="ts">
import { ElMessageBox } from 'element-plus'
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'

import { useConnectionStore } from './stores/connection'
import { useFileTransferStore } from './stores/file-transfer'
import ThemeToggle from './components/ThemeToggle.vue'
import linduLogo from '../../build/icon.svg?no-inline'
import HomeView from './views/HomeView.vue'
import HistoryView from './views/HistoryView.vue'
import SettingsView from './views/SettingsView.vue'
import TransferView from './views/TransferView.vue'

type PageKey = 'home' | 'transfer' | 'history' | 'settings'

const activePage = ref<PageKey>('home')
const connectionStore = useConnectionStore()
const fileTransferStore = useFileTransferStore()
const activeApprovalRequestId = ref<string | null>(null)

watch(
  () => fileTransferStore.incomingOffer,
  (offer) => {
    if (offer !== null) activePage.value = 'transfer'
  },
)

watch(
  () => connectionStore.incomingRequest,
  (request) => {
    if (request === null) {
      if (activeApprovalRequestId.value !== null) {
        ElMessageBox.close()
        activeApprovalRequestId.value = null
      }
      return
    }
    if (activeApprovalRequestId.value === request.requestId) return
    if (activeApprovalRequestId.value !== null) ElMessageBox.close()
    activeApprovalRequestId.value = request.requestId
    const description = `${request.peer.deviceName}（${request.peer.ipAddress}:${String(request.peer.servicePort)}）请求连接`
    void ElMessageBox.confirm(description, '设备连接请求', {
      confirmButtonText: '允许',
      cancelButtonText: '拒绝',
      type: 'warning',
      distinguishCancelAndClose: true,
    })
      .then(() => connectionStore.respondToIncoming(request.requestId, 'accept'))
      .catch(() => connectionStore.respondToIncoming(request.requestId, 'reject'))
      .finally(() => {
        if (activeApprovalRequestId.value === request.requestId) {
          activeApprovalRequestId.value = null
        }
      })
  },
)

onMounted(() => {
  void connectionStore.initialize()
  fileTransferStore.initialize()
})

onBeforeUnmount(() => {
  connectionStore.dispose()
  fileTransferStore.dispose()
})
</script>

<template>
  <el-container class="app-shell">
    <el-aside width="220px" class="sidebar">
      <div class="brand">
        <img class="brand-mark" :src="linduLogo" alt="邻渡 Logo" draggable="false" />
        <span class="brand-copy">
          <strong>邻渡</strong>
          <small>NEARBY TRANSFER</small>
        </span>
      </div>
      <nav class="sidebar-nav" aria-label="主菜单">
        <p class="sidebar-label">功能</p>
        <el-menu
          v-model="activePage"
          :default-active="activePage"
          @select="activePage = $event as PageKey"
        >
          <el-menu-item index="home">首页</el-menu-item>
          <el-menu-item index="transfer">传输</el-menu-item>
          <el-menu-item index="history">历史记录</el-menu-item>
          <el-menu-item index="settings">设置</el-menu-item>
        </el-menu>
      </nav>
      <div class="sidebar-footer">
        <span class="security-indicator" aria-hidden="true"></span>
        仅在局域网内通信
      </div>
    </el-aside>
    <el-main
      class="main-content"
      :class="{
        'is-fixed-page': activePage === 'transfer' || activePage === 'history',
        'is-transfer-page': activePage === 'transfer',
        'is-history-page': activePage === 'history',
      }"
    >
      <div class="content-container">
        <header class="page-header">
          <p>邻近设备 · 安全直传</p>
          <ThemeToggle />
        </header>
        <HomeView v-if="activePage === 'home'" />
        <TransferView v-else-if="activePage === 'transfer'" />
        <HistoryView v-else-if="activePage === 'history'" />
        <SettingsView v-else />
      </div>
    </el-main>
  </el-container>
</template>

<script setup lang="ts">
import { ElMessageBox } from 'element-plus'
import { h, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import type { HistoryEntryDto } from '@shared/types'

import { useConnectionStore } from './stores/connection'
import { useFileTransferStore } from './stores/file-transfer'
import { useSecurityStore } from './stores/security'
import ThemeToggle from './components/ThemeToggle.vue'
import linduLogo from '../../build/icon.svg?no-inline'
import HomeView from './views/HomeView.vue'
import DiagnosticsView from './views/DiagnosticsView.vue'
import HistoryView from './views/HistoryView.vue'
import SettingsView from './views/SettingsView.vue'
import TransferView from './views/TransferView.vue'

type PageKey = 'home' | 'transfer' | 'history' | 'diagnostics' | 'settings'

const activePage = ref<PageKey>('home')
const connectionStore = useConnectionStore()
const fileTransferStore = useFileTransferStore()
const securityStore = useSecurityStore()
const activeApprovalRequestId = ref<string | null>(null)
const activePairingRequestId = ref<string | null>(null)
const targetHistoryMessage = ref<HistoryEntryDto | null>(null)
let pairingDialogGeneration = 0

const formatShortFingerprint = (fingerprint: string): string =>
  (fingerprint.slice(0, 24).match(/.{1,4}/gu) ?? []).join(' ')

const locateHistoryMessage = (entry: HistoryEntryDto): void => {
  targetHistoryMessage.value = entry
  activePage.value = 'transfer'
}

const selectPage = (page: PageKey): void => {
  if (page === 'transfer') targetHistoryMessage.value = null
  activePage.value = page
}

watch(
  () => fileTransferStore.incomingOffer,
  (offer) => {
    if (offer !== null) activePage.value = 'transfer'
  },
)

const showPairingDialog = (
  request: NonNullable<typeof securityStore.pendingPairing>,
  hasInvalidCode = false,
): void => {
  const dialogGeneration = ++pairingDialogGeneration
  activePairingRequestId.value = request.requestId
  const identityDetails = h('small', `设备指纹：${formatShortFingerprint(request.peerFingerprint)}`)
  if (request.verificationMode === 'display') {
    const message = h('div', { class: 'pairing-confirmation' }, [
      h('p', `${request.peer.deviceName} 正在与本机建立安全连接。`),
      h('p', '请让对方在发起连接的设备上输入此六位验证码：'),
      h('strong', { class: 'pairing-code' }, request.verificationCode),
      identityDetails,
    ])
    void ElMessageBox.confirm(message, '安全配对', {
      confirmButtonText: '取消配对',
      showCancelButton: false,
      type: 'warning',
      closeOnClickModal: false,
      closeOnPressEscape: false,
    })
      .then(() => securityStore.rejectPairing(request.requestId))
      .catch(() => undefined)
      .finally(() => {
        if (pairingDialogGeneration === dialogGeneration) activePairingRequestId.value = null
      })
    return
  }

  const message = hasInvalidCode
    ? '验证码不正确，请核对显示验证码的设备后重新输入。'
    : '请输入对方设备显示的六位验证码。'
  void ElMessageBox.prompt(message, '安全配对', {
    confirmButtonText: '验证并配对',
    cancelButtonText: '拒绝配对',
    inputPlaceholder: '6 位数字',
    inputPattern: /^\d{6}$/u,
    inputErrorMessage: '请输入 6 位数字验证码',
    type: 'warning',
    distinguishCancelAndClose: true,
    closeOnClickModal: false,
    closeOnPressEscape: false,
  })
    .then(async ({ value }) => {
      const verified = await securityStore.verifyCode(request.requestId, value)
      if (!verified && securityStore.pendingPairing?.requestId === request.requestId) {
        showPairingDialog(request, true)
      }
    })
    .catch(() => securityStore.rejectPairing(request.requestId))
    .finally(() => {
      if (pairingDialogGeneration === dialogGeneration) activePairingRequestId.value = null
    })
}

watch(
  () => securityStore.pendingPairing,
  (request) => {
    if (request === null) {
      if (activePairingRequestId.value !== null) {
        pairingDialogGeneration += 1
        ElMessageBox.close()
        activePairingRequestId.value = null
      }
      return
    }
    if (activePairingRequestId.value === request.requestId) return
    if (activePairingRequestId.value !== null) ElMessageBox.close()
    showPairingDialog(request)
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
  void securityStore.initialize()
  fileTransferStore.initialize()
})

onBeforeUnmount(() => {
  connectionStore.dispose()
  securityStore.dispose()
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
          @select="selectPage($event as PageKey)"
        >
          <el-menu-item index="home">首页</el-menu-item>
          <el-menu-item index="transfer">传输</el-menu-item>
          <el-menu-item index="history">历史记录</el-menu-item>
          <el-menu-item index="diagnostics">诊断</el-menu-item>
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
        <TransferView
          v-else-if="activePage === 'transfer'"
          :target-history-message="targetHistoryMessage"
          @navigate="activePage = $event"
        />
        <HistoryView v-else-if="activePage === 'history'" @locate-message="locateHistoryMessage" />
        <DiagnosticsView v-else-if="activePage === 'diagnostics'" />
        <SettingsView v-else />
      </div>
    </el-main>
  </el-container>
</template>

<script setup lang="ts">
import { ElMessage } from 'element-plus'
import { onBeforeUnmount, onMounted, reactive, watch } from 'vue'

import {
  MAX_FILE_SIZE_BYTES,
  MAX_HISTORY_LIMIT,
  MAX_SERVICE_PORT,
  MIN_HISTORY_LIMIT,
  MIN_SERVICE_PORT,
} from '@shared/constants'

import { useSettingsStore } from '../stores/settings'

const store = useSettingsStore()
const form = reactive({
  deviceName: '',
  servicePort: 53_317,
  maxFileSizeMiB: 2_048,
  historyLimit: 1_000,
  receiveDirectoryDisplayPath: '',
})

watch(
  () => store.settings,
  (settings) => {
    if (settings === null) return
    form.deviceName = settings.deviceName
    form.servicePort = settings.servicePort
    form.maxFileSizeMiB = Math.floor(settings.maxFileSizeBytes / 1_024 / 1_024)
    form.historyLimit = settings.historyLimit
    form.receiveDirectoryDisplayPath = settings.receiveDirectoryDisplayPath
  },
  { immediate: true },
)

const save = async (): Promise<void> => {
  const succeeded = await store.save({
    deviceName: form.deviceName.trim(),
    servicePort: form.servicePort,
    maxFileSizeBytes: form.maxFileSizeMiB * 1_024 * 1_024,
    historyLimit: form.historyLimit,
  })
  if (succeeded) ElMessage.success('设置已保存')
}

const chooseDirectory = async (): Promise<void> => {
  const selectedPath = await store.chooseReceiveDirectory()
  if (selectedPath !== null) {
    form.receiveDirectoryDisplayPath = selectedPath
    ElMessage.success('默认接收目录已更新')
  }
}

onMounted(() => void store.initialize())
onBeforeUnmount(() => store.dispose())
</script>

<template>
  <el-card v-loading="store.loading" shadow="never" class="settings-card">
    <el-form label-position="top" @submit.prevent>
      <el-form-item label="本机设备名称">
        <el-input v-model="form.deviceName" maxlength="128" show-word-limit />
      </el-form-item>
      <el-form-item label="默认接收目录">
        <div class="directory-field">
          <el-input v-model="form.receiveDirectoryDisplayPath" readonly />
          <el-button @click="chooseDirectory">选择目录</el-button>
        </div>
      </el-form-item>
      <el-form-item label="服务端口">
        <el-input-number
          v-model="form.servicePort"
          :min="MIN_SERVICE_PORT"
          :max="MAX_SERVICE_PORT"
          controls-position="right"
        />
        <span class="field-help">修改后会立即重启局域网服务。</span>
      </el-form-item>
      <el-form-item label="最大单文件大小（MiB）">
        <el-input-number
          v-model="form.maxFileSizeMiB"
          :min="1"
          :max="MAX_FILE_SIZE_BYTES / 1024 / 1024"
          controls-position="right"
        />
      </el-form-item>
      <el-form-item label="历史记录保存上限">
        <el-input-number
          v-model="form.historyLimit"
          :min="MIN_HISTORY_LIMIT"
          :max="MAX_HISTORY_LIMIT"
          controls-position="right"
        />
      </el-form-item>
      <el-alert
        v-if="store.errorMessage"
        :title="store.errorMessage"
        type="error"
        :closable="false"
      />
      <el-button
        class="save-button"
        type="primary"
        :loading="store.saving"
        :disabled="form.deviceName.trim().length === 0"
        @click="save"
      >
        保存设置
      </el-button>
    </el-form>
  </el-card>
</template>

<style scoped>
.settings-card {
  max-width: 760px;
}

.directory-field {
  display: flex;
  width: 100%;
  gap: 10px;
}

.field-help {
  margin-left: 12px;
  color: #94a3b8;
  font-size: 12px;
}

.save-button {
  margin-top: 8px;
}
</style>

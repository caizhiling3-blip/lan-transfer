<script setup lang="ts">
import { computed, ref } from 'vue'

import HomeView from './views/HomeView.vue'

type PageKey = 'home' | 'transfer' | 'history' | 'settings'

const activePage = ref<PageKey>('home')

const pageTitles: Readonly<Record<PageKey, string>> = {
  home: '首页',
  transfer: '传输',
  history: '历史记录',
  settings: '设置',
}

const currentTitle = computed(() => pageTitles[activePage.value])
</script>

<template>
  <el-container class="app-shell">
    <el-aside width="220px" class="sidebar">
      <div class="brand">局域网互传</div>
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
    </el-aside>
    <el-main class="main-content">
      <h1>{{ currentTitle }}</h1>
      <HomeView v-if="activePage === 'home'" />
      <el-card v-else shadow="never">
        <el-empty description="项目骨架已就绪，业务功能将在后续阶段逐步实现" />
      </el-card>
    </el-main>
  </el-container>
</template>

<template>
  <div class="app-container">
    <TopHeader />
    <DataSourceBanner />
    <div class="main-body">
      <SideNavigation />
      <div class="content-area">
        <router-view v-slot="{ Component }">
          <transition name="page" mode="out-in">
            <component :is="Component" />
          </transition>
        </router-view>
      </div>
    </div>
    <DemoPanel v-if="store.demoMode" />
  </div>
</template>

<script setup>
import { onMounted, onUnmounted } from 'vue'
import { useFireStore } from './stores/fireStore'
import { useDemoStore } from './stores/demoStore'
import { dataSource } from './api'
import TopHeader from './components/TopHeader.vue'
import SideNavigation from './components/SideNavigation.vue'
import DemoPanel from './components/DemoPanel.vue'
import DataSourceBanner from './components/DataSourceBanner.vue'

const store = useFireStore()
const demoStore = useDemoStore()

let timer = null
onMounted(async () => {
  // 远端模式（api / demo）：经 Service 层从 Workers → D1 拉取初始化数据
  // 失败时不会静默回退 mock，而是置位 remoteError 并由 DataSourceBanner 明确告警
  await store.initFromRemote()

  // demo 模式：连接后端状态机实时通道（WebSocket），状态一律以后端广播为准
  if (dataSource.isDemo) demoStore.connect()

  // 本地随机数据仅在 mock 模式启用：
  // api / demo 模式下的数据由后端（D1 + 状态机）驱动，前端不再自行造数，避免与真实状态冲突
  if (dataSource.isMock) {
    timer = setInterval(() => {
      store.updateRandomData()
    }, 5000)
  }

  // 仅开发环境暴露 E2E 钩子（生产构建会被剔除）
  if (import.meta.env.DEV) {
    window.__demo = { store, demoStore, dataSource }
  }
})

onUnmounted(() => {
  if (timer) clearInterval(timer)
  if (dataSource.isDemo) demoStore.disconnect()
})
</script>

<style scoped>
.app-container {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--fire-dark);
  overflow: hidden;
  position: relative;
}

.main-body {
  flex: 1;
  display: flex;
  overflow: hidden;
  min-height: 0;
}

.content-area {
  flex: 1;
  overflow: hidden;
  padding: 10px;
  min-width: 0;
  position: relative;
}
</style>

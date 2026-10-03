<template>
  <div class="app-container">
    <TopHeader />
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
import TopHeader from './components/TopHeader.vue'
import SideNavigation from './components/SideNavigation.vue'
import DemoPanel from './components/DemoPanel.vue'

const store = useFireStore()

let timer = null
onMounted(() => {
  // api 数据源：经 Service 层从 Workers → D1 拉取初始化数据（mock 模式下为空操作）
  store.initFromRemote()
  timer = setInterval(() => {
    store.updateRandomData()
  }, 5000)
})

onUnmounted(() => {
  if (timer) clearInterval(timer)
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

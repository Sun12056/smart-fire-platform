<template>
  <div v-if="visible" class="ds-banner" :class="level">
    <svg class="ds-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
      <path d="M12 9v4M12 17h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
    </svg>
    <div class="ds-text">
      <span class="ds-title">{{ title }}</span>
      <span class="ds-detail">{{ detail }}</span>
    </div>
    <button class="ds-btn" @click="store.initFromRemote()">重试连接</button>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { useFireStore } from '../stores/fireStore'
import { useDemoStore } from '../stores/demoStore'
import { dataSource } from '../api'

const store = useFireStore()
const demoStore = useDemoStore()

const visible = computed(() => Boolean(store.remoteError || store.dataSourceDegraded || demoStore.error))
const level = computed(() => 'danger')
const title = computed(() => {
  if (store.dataSourceDegraded) return `后端不可用（${dataSource.mode.toUpperCase()} 模式）`
  return '状态机连接异常'
})
const detail = computed(() => {
  if (store.remoteError) return `${store.remoteError} —— 当前页面显示的是本地示例数据，并非真实后端数据`
  if (demoStore.error) return demoStore.error
  return '未加载到真实后端数据'
})
</script>

<style scoped>
.ds-banner {
  position: fixed;
  top: 8px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 2000;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 14px;
  border-radius: 3px;
  border: 1px solid rgba(239, 68, 68, 0.5);
  background: rgba(127, 29, 29, 0.92);
  color: #FEE2E2;
  font-size: var(--fs-xs);
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.45);
  max-width: 70vw;
}
.ds-icon { width: 16px; height: 16px; flex-shrink: 0; }
.ds-text { display: flex; flex-direction: column; gap: 2px; }
.ds-title { font-weight: 600; letter-spacing: 0.5px; }
.ds-detail { opacity: 0.85; }
.ds-btn {
  border: 1px solid rgba(254, 226, 226, 0.5);
  background: transparent;
  color: #FEE2E2;
  padding: 4px 10px;
  border-radius: 2px;
  cursor: pointer;
  font-size: var(--fs-xs);
}
.ds-btn:hover { background: rgba(254, 226, 226, 0.12); }
</style>

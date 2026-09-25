<template>
  <header class="top-header">
    <div class="header-left">
      <div class="logo-area">
        <svg class="logo-icon" width="26" height="26" viewBox="0 0 24 24" fill="none">
          <path d="M12 2C12 2 8 6 8 11C8 14 10 16 12 16C14 16 16 14 16 11C16 9 15 7 14 6C14 8 13 9 12 9C13 6 12 2 12 2Z" fill="#EF4444"/>
          <path d="M12 22C8 22 5 19 5 15C5 12 7 10 8 9C8 11 9 12 10 12C9 9 11 5 12 4C12 8 14 9 15 11C15.5 12 16 13 16 15C16 19 14 22 12 22Z" fill="#DC2626" opacity="0.75"/>
        </svg>
        <div class="logo-text">
          <h1>
            <span class="t-white">智慧消防</span><span class="t-arc">数字孪生</span><span class="t-white">指挥中心</span>
          </h1>
          <p>消防智能感知与应急联动平台</p>
        </div>
      </div>
    </div>

    <div class="header-right">
      <div class="status-item">
        <span class="status-dot"></span>
        <span class="status-label">系统运行中</span>
      </div>
      <div class="status-item admin-area" @click="store.toggleDemoMode()">
        <span class="admin-badge" :class="{ active: store.demoMode }">
          {{ store.demoMode ? '演示模式' : '管理员' }}
        </span>
      </div>
    </div>
  </header>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue'
import { useFireStore } from '../stores/fireStore'

const store = useFireStore()
const currentTime = ref('')

let timer = null
function updateTime() {
  const d = new Date()
  const h = String(d.getHours()).padStart(2, '0')
  const m = String(d.getMinutes()).padStart(2, '0')
  const s = String(d.getSeconds()).padStart(2, '0')
  currentTime.value = `${h}:${m}:${s}`
}

onMounted(() => {
  updateTime()
  timer = setInterval(updateTime, 1000)
})
onUnmounted(() => {
  if (timer) clearInterval(timer)
})
</script>

<style scoped>
/* 石墨黑顶部导航 — 平台视觉基准 */
.top-header {
  height: 60px;
  background: #1B1F2A;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 20px 0 24px;
  position: relative;
  z-index: 10;
  box-shadow: 0 1px 0 rgba(255, 255, 255, 0.04);
}

.header-left {
  display: flex;
  align-items: center;
}

.logo-area {
  display: flex;
  align-items: center;
  gap: 12px;
}

.logo-icon {
  flex-shrink: 0;
}

.logo-text h1 {
  font-size: var(--fs-display);
  font-weight: 600;
  letter-spacing: 2px;
  line-height: var(--lh-tight);
  display: flex;
  align-items: baseline;
  white-space: nowrap;
}

.logo-text .t-white {
  color: #FFFFFF;
}

.logo-text .t-arc {
  color: var(--color-arc-blue);
}

.logo-text p {
  font-size: var(--fs-xs);
  color: rgba(255, 255, 255, 0.55);
  margin-top: 3px;
  letter-spacing: 2px;
  font-weight: 400;
}

.header-right {
  display: flex;
  align-items: center;
  gap: 22px;
}

.status-item {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--fs-md);
  color: rgba(255, 255, 255, 0.85);
}

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #22C55E;
}

.status-label {
  color: rgba(255, 255, 255, 0.6);
}

.status-value {
  color: #FFFFFF;
}

.time-display .time-value {
  font-size: var(--fs-lg);
  color: var(--color-arc-blue);
  letter-spacing: 1px;
  font-weight: 500;
}

.admin-badge {
  padding: 4px 12px;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.18);
  color: rgba(255, 255, 255, 0.85);
  font-size: var(--fs-sm);
  cursor: pointer;
  transition: all 0.2s;
  letter-spacing: 0.5px;
}

.admin-badge:hover {
  border-color: var(--color-arc-blue);
  color: #FFFFFF;
}

.admin-badge.active {
  background: rgba(76, 201, 240, 0.16);
  border-color: rgba(76, 201, 240, 0.5);
  color: var(--color-arc-blue);
}

.admin-area {
  cursor: pointer;
}
</style>

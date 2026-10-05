<template>
  <div class="log-page">
    <div class="log-header">
      <h2>📋 后台日志</h2>
      <span class="log-count">共 {{ store.operationLogs.length }} 条记录</span>
      <span v-if="refreshing" class="log-loading">读取后端权威日志…</span>
      <button class="log-clear-btn ghost" :disabled="refreshing" @click="refresh">刷新日志</button>
      <button class="log-clear-btn" @click="store.operationLogs = []">清空日志</button>
    </div>
    
    <div class="log-timeline">
      <div v-if="store.operationLogs.length === 0" class="log-empty">
        暂无操作记录
      </div>
      
      <div v-for="log in store.operationLogs" :key="log.id" 
           class="log-entry" :class="log.level">
        <div class="log-dot" :class="log.level"></div>
        <div class="log-connector" v-if="!isLast(log.id)"></div>
        <div class="log-body">
          <div class="log-time num-font">{{ log.time }}</div>
          <div class="log-action">{{ log.action }}</div>
          <div v-if="log.module" class="log-module">{{ log.module }}</div>
          <div v-if="log.detail" class="log-detail">{{ log.detail }}</div>
          <div class="log-level-badge" :class="log.level">{{ log.level }}</div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, watch, onMounted } from 'vue'
import { useFireStore } from '../stores/fireStore'
const store = useFireStore()

// P2-03：后台日志页必须能看到后端（含 demo 六阶段）落库的权威记录。
// operationLogs 此前只在数据源初始化时读过一次，演示过程中写入的演示流程记录不会出现在页面上。
const refreshing = ref(false)
async function refresh() {
  refreshing.value = true
  try {
    await store.refreshOperationLogs()
  } finally {
    refreshing.value = false
  }
}
onMounted(refresh)
// 阶段推进时自动回读，保证演示进行中也能看到最新的阶段记录
watch(() => store.emergencyStage, refresh)

function isLast(id) {
  const idx = store.operationLogs.findIndex(l => l.id === id)
  return idx === store.operationLogs.length - 1
}
</script>

<style scoped>
.log-page {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: #0A0E1A;
  padding: 24px;
  overflow: hidden;
}
.log-header {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-bottom: 24px;
  padding-bottom: 16px;
  border-bottom: 1px solid rgba(76,201,240,0.15);
}
.log-header h2 {
  font-size: 20px;
  color: #fff;
  margin: 0;
}
.log-count {
  font-size: 12px;
  color: rgba(76,201,240,0.6);
}
.log-loading {
  font-size: 12px;
  color: rgba(76,201,240,0.85);
}
.log-clear-btn.ghost {
  margin-left: 0;
  background: rgba(76,201,240,0.1);
  border-color: rgba(76,201,240,0.35);
  color: #4CC9F0;
}
.log-clear-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
.log-clear-btn {
  margin-left: auto;
  padding: 4px 12px;
  background: rgba(239,68,68,0.1);
  border: 1px solid rgba(239,68,68,0.3);
  border-radius: 4px;
  color: #EF4444;
  font-size: 12px;
  cursor: pointer;
}
.log-timeline {
  flex: 1;
  overflow-y: auto;
  padding: 0 8px;
}
.log-timeline::-webkit-scrollbar { width: 4px; }
.log-timeline::-webkit-scrollbar-track { background: transparent; }
.log-timeline::-webkit-scrollbar-thumb { background: rgba(76,201,240,0.3); border-radius: 2px; }

.log-empty {
  text-align: center;
  color: rgba(255,255,255,0.3);
  padding: 48px 0;
  font-size: 14px;
}
.log-entry {
  position: relative;
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 10px 0 10px 24px;
}
.log-dot {
  position: absolute;
  left: 6px;
  top: 14px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}
.log-dot.info { background: #4CC9F0; }
.log-dot.warning { background: #F59E0B; }
.log-dot.success { background: #22C55E; }
.log-dot.danger { background: #EF4444; }

.log-connector {
  position: absolute;
  left: 9.5px;
  top: 24px;
  bottom: -2px;
  width: 1px;
  background: rgba(76,201,240,0.15);
}

.log-body {
  flex: 1;
  background: rgba(15,23,42,0.6);
  border: 1px solid rgba(76,201,240,0.1);
  border-radius: 6px;
  padding: 10px 14px;
}
.log-entry.warning .log-body { border-color: rgba(245,158,11,0.25); background: rgba(245,158,11,0.06); }
.log-entry.danger .log-body { border-color: rgba(239,68,68,0.25); background: rgba(239,68,68,0.06); }
.log-entry.success .log-body { border-color: rgba(34,197,94,0.25); background: rgba(34,197,94,0.06); }

.log-time {
  font-size: 11px;
  color: rgba(76,201,240,0.7);
  margin-bottom: 4px;
}
.log-action {
  font-size: 14px;
  color: #fff;
  font-weight: 600;
  margin-bottom: 2px;
}
.log-module {
  font-size: 11px;
  color: rgba(255,255,255,0.45);
  margin-bottom: 4px;
}
.log-detail {
  font-size: 12px;
  color: rgba(255,255,255,0.6);
}
.log-level-badge {
  display: inline-block;
  margin-top: 6px;
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 3px;
  font-weight: 600;
  letter-spacing: 0.5px;
}
.log-level-badge.info { background: rgba(76,201,240,0.15); color: #4CC9F0; }
.log-level-badge.warning { background: rgba(245,158,11,0.15); color: #F59E0B; }
.log-level-badge.success { background: rgba(34,197,94,0.15); color: #22C55E; }
.log-level-badge.danger { background: rgba(239,68,68,0.15); color: #EF4444; }
</style>

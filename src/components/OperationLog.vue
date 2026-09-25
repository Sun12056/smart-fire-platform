<template>
  <div class="op-log fire-card">
    <div class="log-header">
      <h4>操作日志</h4>
      <span class="log-count">{{ safeLogs.length }} 条</span>
    </div>
    <div class="log-body">
      <transition-group name="log-list" tag="div">
        <div
          v-for="log in displayLogs"
          :key="log.id"
          class="log-item"
          :class="`level-${log.level || 'info'}`"
        >
          <div class="log-time num-font">{{ log.time }}</div>
          <div class="log-content">
            <div class="log-action">{{ log.action }}</div>
            <div class="log-detail" v-if="log.detail">{{ log.detail }}</div>
            <div class="log-meta" v-if="log.operator">
              <span class="log-operator">{{ log.operator }}</span>
              <span class="log-result" v-if="log.result"> · {{ log.result }}</span>
            </div>
          </div>
          <div class="log-level-icon">
            <svg v-if="log.level === 'danger'" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#EF4444" stroke-width="1.5"><circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/></svg>
            <svg v-else-if="log.level === 'warning'" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#F59E0B" stroke-width="1.5"><path d="M12 2L2 22h20L12 2z"/><path d="M12 9v5M12 17h.01"/></svg>
            <svg v-else width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#4CC9F0" stroke-width="1.5"><circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/></svg>
          </div>
        </div>
      </transition-group>
      <div v-if="displayLogs.length === 0" class="log-empty">
        暂无操作记录
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { useFireStore } from '../stores/fireStore'

const fireStore = useFireStore()

// evacuationLogs 可能仍是 Proxy（setup store 未正确初始化），强制转为安全数组
const safeLogs = computed(() => {
  const raw = fireStore.evacuationLogs
  return Array.isArray(raw) ? raw : []
})

const displayLogs = computed(() => safeLogs.value.slice(0, 15))
</script>

<style scoped>
.op-log {
  display: flex;
  flex-direction: column;
  height: 100%;
  padding: 0;
}

.log-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 10px 14px;
  border-bottom: 1px solid var(--fire-border);
}

.log-header h4 {
  font-size: var(--fs-sm);
  color: var(--text-primary);
  letter-spacing: 1px;
  font-weight: 600;
}

.log-count {
  font-size: var(--fs-xs);
  color: var(--text-tertiary);
  background: rgba(76, 201, 240, 0.04);
  padding: 2px 8px;
  border-radius: 2px;
}

.log-body {
  flex: 1;
  overflow-y: auto;
  padding: 6px 8px;
}

.log-item {
  display: flex;
  gap: 8px;
  padding: 8px 10px;
  margin-bottom: 4px;
  border-radius: 2px;
  background: rgba(76, 201, 240, 0.02);
  border-left: 2px solid transparent;
  transition: all 0.2s;
}

.log-item:hover {
  background: rgba(76, 201, 240, 0.06);
}

.log-item.level-danger {
  border-left-color: var(--fire-red);
  background: rgba(239, 68, 68, 0.05);
}

.log-item.level-warning {
  border-left-color: var(--fire-orange);
  background: rgba(245, 158, 11, 0.05);
}

.log-item.level-info {
  border-left-color: var(--fire-blue);
}

.log-time {
  font-size: var(--fs-xs);
  color: var(--text-tertiary);
  flex-shrink: 0;
  min-width: 56px;
  padding-top: 1px;
}

.log-content {
  flex: 1;
  min-width: 0;
}

.log-action {
  font-size: var(--fs-sm);
  color: var(--text-primary);
  font-weight: 500;
  line-height: var(--lh-normal);
  word-break: break-all;
}

.log-detail {
  font-size: var(--fs-xs);
  color: var(--text-secondary);
  margin-top: 2px;
  line-height: var(--lh-normal);
}

.log-meta {
  font-size: var(--fs-tiny);
  color: var(--text-tertiary);
  margin-top: 2px;
}

.log-operator {
  color: var(--text-tertiary);
}

.log-result {
  color: var(--fire-green);
}

.log-level-icon {
  flex-shrink: 0;
  padding-top: 1px;
  display: flex;
  align-items: center;
}

.log-empty {
  text-align: center;
  padding: 30px 0;
  color: var(--text-tertiary);
  font-size: var(--fs-sm);
  letter-spacing: 1px;
}

/* 动画 */
.log-list-enter-active {
  transition: all 0.3s ease-out;
}

.log-list-leave-active {
  transition: all 0.2s ease-in;
}

.log-list-enter-from {
  opacity: 0;
  transform: translateX(-20px);
}

.log-list-leave-to {
  opacity: 0;
}
</style>

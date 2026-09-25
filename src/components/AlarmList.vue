<template>
  <div class="alarm-list fire-card">
    <div class="list-header">
      <div class="header-left">
        <span class="header-bar"></span>
        <h3>实时告警</h3>
      </div>
      <span class="alarm-count num-font" v-if="store.alarms.length">{{ store.alarms.length }} 条</span>
    </div>
    <div class="list-body">
      <div
        v-for="alarm in displayAlarms"
        :key="alarm.id"
        class="alarm-item"
        :class="`level-${alarm.level}`"
        @click="handleAlarmClick(alarm)"
      >
        <div class="alarm-content">
          <div class="alarm-title">
            <span class="alarm-location">{{ alarm.building }} {{ alarm.floor }}</span>
            <span class="alarm-type">{{ alarm.device }}</span>
          </div>
          <div class="alarm-desc">{{ alarm.type }}</div>
          <div class="alarm-meta">
            <span class="alarm-time num-font">{{ alarm.time }}</span>
            <span class="alarm-status" :class="`status-${alarm.status}`">
              <span class="status-dot"></span>
              {{ statusLabel(alarm.status) }}
            </span>
          </div>
        </div>
      </div>
      <div v-if="displayAlarms.length === 0" class="empty-state">
        <svg width="32" height="32" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M16 4L2 28H30L16 4Z" stroke="#1B1F2A" stroke-width="1.5" fill="none"/>
          <rect x="15" y="12" width="2" height="8" fill="#1B1F2A" rx="1"/>
          <circle cx="16" cy="23" r="1.2" fill="#1B1F2A"/>
        </svg>
        <span>暂无告警事件</span>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { useFireStore } from '../stores/fireStore'
import { alarmStatuses } from '../mock/alarms'

const store = useFireStore()
const router = useRouter()

const displayAlarms = computed(() => store.alarms.slice(0, 8))

function statusLabel(status) {
  return alarmStatuses[status]?.label || status
}

function handleAlarmClick(alarm) {
  store.selectBuilding(store.buildings.find((b) => b.name === alarm.building))
  router.push('/alarms')
}
</script>

<style scoped>
.alarm-list {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.list-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px;
  border-bottom: 1px solid rgba(76, 201, 240, 0.12);
}

.header-left {
  display: flex;
  align-items: center;
  gap: 8px;
}

.header-bar {
  width: 2px;
  height: 14px;
  background: #EF4444;

  border-radius: 1px;
}

.list-header h3 {
  font-size: var(--fs-sm);
  color: var(--text-primary);
  letter-spacing: 2px;
  font-weight: 600;
}

.alarm-count {
  font-size: var(--fs-xs);
  color: var(--fire-red);
  padding: 2px 10px;
  border-radius: 10px;
  background: rgba(239, 68, 68, 0.1);
  border: 1px solid rgba(239, 68, 68, 0.2);
}

.num-font {
  font-family: 'DIN Alternate', 'Roboto Mono', 'Courier New', monospace;
  letter-spacing: 0.5px;
}

.list-body {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
}

.alarm-item {
  padding: 10px 12px;
  margin-bottom: 6px;
  border-radius: 4px;
  cursor: pointer;
  transition: all 0.2s;
  border-left: 3px solid transparent;
  background: rgba(8, 21, 37, 0.4);
}

.alarm-item:hover {
  background: rgba(76, 201, 240, 0.04);
  transform: translateX(2px);
}

.alarm-item.level-danger {
  border-left-color: #EF4444;
  background: rgba(239, 68, 68, 0.04);
}

.alarm-item.level-danger .alarm-location {
  color: #EF4444;
}

.alarm-item.level-warning {
  border-left-color: #F59E0B;
  background: rgba(245, 158, 11, 0.03);
}

.alarm-item.level-info {
  border-left-color: #4CC9F0;
  background: rgba(76, 201, 240, 0.02);
}

/* danger 级别竖条脉冲 */
.alarm-item.level-danger {
  animation: dangerPulse 2s ease-in-out infinite;
}

@keyframes dangerPulse {
  0%, 100% { border-left-color: #EF4444; box-shadow: -2px 0 8px rgba(239, 68, 68, 0); }
  50% { border-left-color: #EF4444; box-shadow: -2px 0 8px rgba(239, 68, 68, 0.4); }
}

.alarm-content {
  flex: 1;
  min-width: 0;
}

.alarm-title {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 4px;
}

.alarm-location {
  font-size: var(--fs-sm);
  font-weight: 600;
  color: var(--text-primary);
  letter-spacing: 0.5px;
}

.alarm-type {
  font-size: var(--fs-tiny);
  color: var(--text-tertiary);
}

.alarm-desc {
  font-size: var(--fs-xs);
  color: var(--text-secondary);
  margin-bottom: 6px;
  line-height: var(--lh-normal);
}

.alarm-meta {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.alarm-time {
  font-size: var(--fs-tiny);
  color: var(--text-tertiary);
}

.alarm-status {
  font-size: var(--fs-tiny);
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 1px 8px;
  border-radius: 8px;
}

.status-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
}

.status-pending { color: #F59E0B; background: rgba(245, 158, 11, 0.1); }
.status-pending .status-dot { background: #F59E0B; box-shadow: 0 0 4px #F59E0B; }

.status-processing { color: #4CC9F0; background: rgba(76, 201, 240, 0.1); }
.status-processing .status-dot { background: #4CC9F0; box-shadow: 0 0 4px #4CC9F0; }

.status-reviewing { color: #4CC9F0; background: rgba(76, 201, 240, 0.08); }
.status-reviewing .status-dot { background: #4CC9F0; box-shadow: 0 0 4px #4CC9F0; }

.status-resolved { color: #22C55E; background: rgba(34, 197, 94, 0.1); }
.status-resolved .status-dot { background: #22C55E; box-shadow: 0 0 4px #22C55E; }

.empty-state {
  text-align: center;
  padding: 40px 0;
  color: #1B1F2A;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}

.empty-state span {
  font-size: var(--fs-sm);
  letter-spacing: 1px;
  color: var(--text-tertiary);
}
</style>

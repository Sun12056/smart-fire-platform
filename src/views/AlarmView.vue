<template>
  <div class="alarm-view">
    <!-- 页面头部 -->
    <div class="page-header">
      <div class="header-bar"></div>
      <div class="header-text">
        <h2 class="title-spacing">智能告警中心</h2>
        <p class="header-sub">消防告警事件全流程处置与跟踪</p>
      </div>
    </div>

    <!-- 统计卡区域 -->
    <div class="alarm-stats-row">
      <div
        class="alarm-stat-card fire-card"
        :class="{ active: filterStatus === '' }"
        @click="filterStatus = ''"
      >
        <div class="stat-bar stat-bar-cyan"></div>
        <div class="stat-body">
          <span class="stat-value num-font glow-text-sm">{{ store.alarms.length }}</span>
          <span class="stat-name">全部告警</span>
        </div>
        <svg class="stat-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <path d="M3 9h18M9 3v18" />
        </svg>
      </div>
      <div
        class="alarm-stat-card fire-card"
        :class="{ active: filterStatus === 'pending' }"
        @click="filterStatus = 'pending'"
      >
        <div class="stat-bar stat-bar-orange"></div>
        <div class="stat-body">
          <span class="stat-value num-font glow-text-sm" style="color: var(--fire-orange)">{{ store.alarmStats.pending }}</span>
          <span class="stat-name">待处理</span>
        </div>
        <svg class="stat-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 2" />
        </svg>
      </div>
      <div
        class="alarm-stat-card fire-card"
        :class="{ active: filterStatus === 'processing' }"
        @click="filterStatus = 'processing'"
      >
        <div class="stat-bar stat-bar-blue"></div>
        <div class="stat-body">
          <span class="stat-value num-font glow-text-sm" style="color: var(--fire-blue)">{{ store.alarmStats.processing }}</span>
          <span class="stat-name">处理中</span>
        </div>
        <svg class="stat-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M21 12a9 9 0 11-6.219-8.56" />
          <path d="M21 3v6h-6" />
        </svg>
      </div>
      <div
        class="alarm-stat-card fire-card"
        :class="{ active: filterStatus === 'resolved' }"
        @click="filterStatus = 'resolved'"
      >
        <div class="stat-bar stat-bar-green"></div>
        <div class="stat-body">
          <span class="stat-value num-font glow-text-sm" style="color: var(--fire-green)">{{ store.alarmStats.resolved }}</span>
          <span class="stat-name">已解决</span>
        </div>
        <svg class="stat-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M20 6L9 17l-5-5" />
        </svg>
      </div>
    </div>

    <!-- 告警列表 -->
    <div class="alarm-table fire-card">
      <div class="table-header">
        <div class="th-col th-id">告警编号</div>
        <div class="th-col th-time">发生时间</div>
        <div class="th-col th-loc">位置</div>
        <div class="th-col th-device">设备</div>
        <div class="th-col th-type">告警类型</div>
        <div class="th-col th-level">等级</div>
        <div class="th-col th-status">状态</div>
        <div class="th-col th-progress">处置进度</div>
        <div class="th-col th-action">操作</div>
      </div>
      <div class="table-body">
        <div
          v-for="alarm in filteredAlarms"
          :key="alarm.id"
          class="alarm-row"
          :class="[`level-${alarm.level}`, { 'row-danger': alarm.level === 'danger' }]"
          @click="handleAlarmClick(alarm)"
        >
          <div class="td-col td-id">
            <span class="row-bar" :class="`bar-${alarm.level}`"></span>
            <span class="num-font row-id-text">{{ alarm.id }}</span>
          </div>
          <div class="td-col td-time">
            <span class="num-font">{{ alarm.time }}</span>
          </div>
          <div class="td-col td-loc">
            <span class="loc-building">{{ alarm.building }}</span>
            <span class="loc-floor num-font">{{ alarm.floor }}</span>
          </div>
          <div class="td-col td-device">{{ alarm.device }}</div>
          <div class="td-col td-type">{{ alarm.type }}</div>
          <div class="td-col td-level">
            <span class="level-tag" :class="`tag-${alarm.level}`">{{ levelLabel(alarm.level) }}</span>
          </div>
          <div class="td-col td-status">
            <span class="status-tag" :class="statusClass(alarm.status)">{{ statusLabel(alarm.status) }}</span>
          </div>
          <div class="td-col td-progress">
            <div class="mini-progress">
              <div class="mini-progress-fill" :style="{ width: `${alarm.progress}%` }"></div>
              <span class="mini-progress-text num-font">{{ alarm.progress }}%</span>
            </div>
          </div>
          <div class="td-col td-action">
            <button class="row-action-btn" @click.stop="handleAlarmClick(alarm)">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="14" height="14">
                <path d="M12 20h9" />
                <path d="M16.5 3.5a2.121 2.121 0 113 3L7 19l-4 1 1-4L16.5 3.5z" />
              </svg>
              <span>处置</span>
            </button>
          </div>
        </div>
        <div v-if="filteredAlarms.length === 0" class="table-empty">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="32" height="32">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 8v4M12 16h.01" />
          </svg>
          <span>暂无符合条件的告警</span>
        </div>
      </div>
    </div>

    <!-- 告警详情弹窗 -->
    <el-dialog v-model="detailVisible" title="告警详情 — 处置流程" width="820px" :close-on-click-modal="true">
      <template v-if="selectedAlarm">
        <!-- 详情头部 -->
        <div class="detail-header">
          <div class="detail-level-badge" :class="`badge-${selectedAlarm.level}`">
            <span class="badge-text">{{ levelLabel(selectedAlarm.level) }}</span>
          </div>
          <div class="detail-title-area">
            <h3 class="detail-title">{{ selectedAlarm.type }} — {{ selectedAlarm.building }} {{ selectedAlarm.floor }}</h3>
            <p class="detail-desc">{{ selectedAlarm.description }}</p>
          </div>
        </div>

        <!-- 详情元数据 -->
        <div class="detail-meta-grid">
          <div class="meta-cell">
            <span class="meta-label">告警编号</span>
            <span class="meta-value num-font">{{ selectedAlarm.id }}</span>
          </div>
          <div class="meta-cell">
            <span class="meta-label">发生时间</span>
            <span class="meta-value num-font">{{ selectedAlarm.time }}</span>
          </div>
          <div class="meta-cell">
            <span class="meta-label">关联设备</span>
            <span class="meta-value">{{ selectedAlarm.device }} ({{ selectedAlarm.deviceId }})</span>
          </div>
          <div class="meta-cell">
            <span class="meta-label">当前状态</span>
            <span class="meta-value">
              <span class="status-tag" :class="statusClass(selectedAlarm.status)">{{ statusLabel(selectedAlarm.status) }}</span>
            </span>
          </div>
        </div>

        <!-- 处置流程时间线 -->
        <div class="detail-section-title">
          <div class="section-bar"></div>
          <span>处置流程</span>
        </div>
        <div class="process-timeline">
          <div
            v-for="(step, idx) in processSteps"
            :key="idx"
            class="tl-step"
            :class="{ done: step.done, current: step.current }"
          >
            <div class="tl-indicator">
              <span class="tl-dot" :class="{ 'dot-done': step.done, 'dot-current': step.current, 'dot-pending': !step.done && !step.current }">
                <svg v-if="step.done" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="10" height="10">
                  <path d="M20 6L9 17l-5-5" />
                </svg>
              </span>
              <span class="tl-line" v-if="idx < processSteps.length - 1" :class="{ 'line-done': step.done }"></span>
            </div>
            <div class="tl-content">
              <span class="tl-name" :class="{ 'name-active': step.done || step.current }">{{ step.name }}</span>
              <span class="tl-status" :class="{ 'status-done-text': step.done, 'status-current-text': step.current, 'status-pending-text': !step.done && !step.current }">
                {{ step.done ? '已完成' : step.current ? '进行中' : '待处理' }}
              </span>
            </div>
          </div>
        </div>

        <!-- 处置操作 -->
        <div class="detail-actions">
          <div class="action-msg-area" v-if="actionMessage">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="14" height="14">
              <circle cx="12" cy="12" r="9" />
              <path d="M12 8v4M12 16h.01" />
            </svg>
            <span>{{ actionMessage }}</span>
          </div>
          <div class="action-btn-row">
            <button v-if="selectedAlarm.status === 'pending'" class="op-btn op-btn-primary" @click="handleStartProcess">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="14" height="14">
                <path d="M5 3l14 9-14 9V3z" />
              </svg>
              <span>开始处置</span>
            </button>
            <button v-if="selectedAlarm.status === 'processing'" class="op-btn op-btn-primary" @click="handleDispatch">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="14" height="14">
                <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" />
              </svg>
              <span>模拟派单</span>
            </button>
            <button v-if="selectedAlarm.status === 'processing'" class="op-btn op-btn-default" @click="handleReview">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="14" height="14">
                <path d="M9 11l3 3L22 4" />
                <path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11" />
              </svg>
              <span>提交复核</span>
            </button>
            <button v-if="selectedAlarm.status === 'reviewing'" class="op-btn op-btn-primary" @click="handleComplete">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="14" height="14">
                <path d="M20 6L9 17l-5-5" />
              </svg>
              <span>完成处置</span>
            </button>
            <button v-if="selectedAlarm.status === 'resolved'" class="op-btn op-btn-done" disabled>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="14" height="14">
                <path d="M20 6L9 17l-5-5" />
              </svg>
              <span>已完成处置</span>
            </button>
            <button class="op-btn op-btn-default" @click="detailVisible = false">关闭</button>
          </div>
        </div>
      </template>
    </el-dialog>

    <!-- 交互流程标注 -->
    <div class="flow-bar fire-card">
      <div class="flow-bar-label">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="14" height="14">
          <path d="M3 12h18M3 12l4-4M3 12l4 4M21 12l-4-4M21 12l-4 4" />
        </svg>
        <span>处置流程</span>
      </div>
      <div class="flow-bar-steps">
        <span class="flow-node">发现异常</span>
        <span class="flow-arrow">→</span>
        <span class="flow-node">平台研判</span>
        <span class="flow-arrow">→</span>
        <span class="flow-node">告警确认</span>
        <span class="flow-arrow">→</span>
        <span class="flow-node">任务派发</span>
        <span class="flow-arrow">→</span>
        <span class="flow-node">现场处置</span>
        <span class="flow-arrow">→</span>
        <span class="flow-node">结果复核</span>
        <span class="flow-arrow">→</span>
        <span class="flow-node flow-node-end">关闭</span>
      </div>
      <div class="flow-bar-hint">
        <span>点击告警行查看详情 · 确认告警后可跳转</span>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="12" height="12">
          <path d="M5 12h14M12 5l7 7-7 7" />
        </svg>
        <span>应急救援指挥中心</span>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import { useFireStore } from '../stores/fireStore'
import { alarmLevels, alarmStatuses } from '../mock/alarms'

const store = useFireStore()

const filterStatus = ref('')
const detailVisible = ref(false)
const selectedAlarm = ref(null)
const actionMessage = ref('')

const filteredAlarms = computed(() => {
  if (!filterStatus.value) return store.alarms
  if (filterStatus.value === 'processing') {
    return store.alarms.filter((a) => a.status === 'processing' || a.status === 'reviewing')
  }
  return store.alarms.filter((a) => a.status === filterStatus.value)
})

const processSteps = computed(() => {
  if (!selectedAlarm.value) return []
  const status = selectedAlarm.value.status
  const steps = [
    { name: '发现异常', done: true, current: false },
    { name: '平台研判', done: true, current: false },
    { name: '告警确认', done: status !== 'pending', current: status === 'pending' },
    { name: '任务派发', done: ['processing', 'reviewing', 'resolved'].includes(status), current: false },
    { name: '现场处置', done: ['reviewing', 'resolved'].includes(status), current: status === 'processing' },
    { name: '结果复核', done: status === 'resolved', current: status === 'reviewing' },
    { name: '事件关闭', done: status === 'resolved', current: false },
  ]
  return steps
})

function handleAlarmClick(alarm) {
  selectedAlarm.value = alarm
  actionMessage.value = ''
  detailVisible.value = true
}

function levelLabel(level) {
  return alarmLevels[level]?.label || level
}

function levelTagType(level) {
  const types = { danger: 'danger', warning: 'warning', info: 'info' }
  return types[level] || 'info'
}

function statusLabel(status) {
  return alarmStatuses[status]?.label || status
}

function statusClass(status) {
  const map = {
    pending: 'orange',
    processing: 'blue',
    reviewing: 'cyan',
    resolved: 'green',
  }
  return map[status] || 'blue'
}

function handleStartProcess() {
  selectedAlarm.value.status = 'processing'
  selectedAlarm.value.progress = 30
  actionMessage.value = '告警处置已启动，等待任务派发...'
}

function handleDispatch() {
  actionMessage.value = '处置任务已下发至现场安保团队'
  selectedAlarm.value.progress = 50
}

function handleReview() {
  selectedAlarm.value.status = 'reviewing'
  selectedAlarm.value.progress = 80
  actionMessage.value = '现场处置已完成，提交复核中...'
}

function handleComplete() {
  selectedAlarm.value.status = 'resolved'
  selectedAlarm.value.progress = 100
  store.resolveAlarm(selectedAlarm.value.id)
  actionMessage.value = '告警事件已完成关闭'
}
</script>

<style scoped>
.alarm-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  gap: 10px;
}

/* ========================== 页面头部 ========================== */
.page-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 4px 0;
}

.header-bar {
  width: 2px;
  height: 28px;
  background: var(--fire-red);

  flex-shrink: 0;
}

.header-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.header-text h2 {
  font-size: 18px;
  color: var(--text-primary);
  letter-spacing: 3px;
  font-weight: 600;
  line-height: 1;
}

.header-sub {
  font-size: 11px;
  color: var(--text-tertiary);
  letter-spacing: 1px;
}

/* ========================== 统计卡 ========================== */
.alarm-stats-row {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 10px;
}

.alarm-stat-card {
  display: flex;
  align-items: center;
  padding: 14px 16px;
  cursor: pointer;
  transition: all 0.2s ease;
  position: relative;
  overflow: hidden;
}

.stat-bar {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 2px;
  transition: all 0.2s ease;
}

.stat-bar-cyan { background: var(--fire-cyan); }
.stat-bar-orange { background: var(--fire-orange); }
.stat-bar-blue { background: var(--fire-blue); }
.stat-bar-green { background: var(--fire-green); }

.stat-body {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
}

.stat-value {
  font-size: 24px;
  font-weight: 700;
  line-height: 1;
  color: var(--text-primary);
}

.stat-name {
  font-size: 10px;
  color: var(--text-tertiary);
  letter-spacing: 1px;
  text-transform: uppercase;
}

.stat-icon {
  width: 20px;
  height: 20px;
  color: var(--text-tertiary);
  opacity: 0.5;
  flex-shrink: 0;
}

.alarm-stat-card:hover {
  border-color: var(--fire-border-hover);
}

.alarm-stat-card:hover .stat-bar {
  box-shadow: 0 0 6px currentColor;
}

.alarm-stat-card.active {
  background: rgba(76, 201, 240, 0.04);
  border-color: var(--fire-border-active);
}

.alarm-stat-card.active .stat-bar {

  width: 3px;
}

.alarm-stat-card.active .stat-icon {
  color: var(--fire-cyan);
  opacity: 0.8;
}

/* ========================== 告警表格 ========================== */
.alarm-table {
  flex: 1;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.table-header {
  display: grid;
  grid-template-columns: 180px 160px 100px 1fr 110px 70px 90px 110px 70px;
  align-items: center;
  padding: 0 12px;
  height: 36px;
  background: rgba(76, 201, 240, 0.03);
  border-bottom: 1px solid var(--fire-border);
  flex-shrink: 0;
}

.th-col {
  font-size: 10px;
  color: var(--text-tertiary);
  letter-spacing: 1px;
  text-transform: uppercase;
  padding: 0 6px;
}

.table-body {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
}

.alarm-row {
  display: grid;
  grid-template-columns: 180px 160px 100px 1fr 110px 70px 90px 110px 70px;
  align-items: center;
  height: 42px;
  padding: 0 12px;
  border-bottom: 1px solid rgba(76, 201, 240, 0.05);
  cursor: pointer;
  transition: all 0.15s ease;
  position: relative;
}

.alarm-row:hover {
  background: rgba(76, 201, 240, 0.04);
  transform: translateX(1px);
}

.alarm-row.row-danger {
  animation: dangerPulse 2s ease-in-out infinite;
}

@keyframes dangerPulse {
  0%, 100% { background: transparent; }
  50% { background: rgba(239, 68, 68, 0.04); }
}

.td-col {
  padding: 0 6px;
  font-size: 12px;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.td-id {
  display: flex;
  align-items: center;
  gap: 8px;
}

.row-bar {
  width: 3px;
  height: 20px;
  flex-shrink: 0;
  border-radius: 1px;
}

.bar-danger { background: var(--fire-red); box-shadow: 0 0 4px rgba(239, 68, 68, 0.4); }
.bar-warning { background: var(--fire-orange); }
.bar-info { background: var(--fire-blue); }

.row-id-text {
  font-size: 11px;
  color: var(--text-primary);
}

.td-time {
  font-size: 11px;
  color: var(--text-tertiary);
}

.td-loc {
  display: flex;
  align-items: center;
  gap: 4px;
}

.loc-building {
  font-size: 12px;
  color: var(--text-secondary);
}

.loc-floor {
  font-size: 11px;
  color: var(--text-tertiary);
}

.td-device {
  font-size: 12px;
  color: var(--text-secondary);
}

.td-type {
  font-size: 12px;
  color: var(--text-secondary);
}

.level-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 6px;
  border-radius: 2px;
  font-size: 10px;
  font-weight: 500;
}

.level-tag::before {
  content: '';
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: currentColor;
}

.tag-danger { color: var(--fire-red); background: rgba(239, 68, 68, 0.1); }
.tag-warning { color: var(--fire-orange); background: rgba(245, 158, 11, 0.1); }
.tag-info { color: var(--fire-blue); background: rgba(76, 201, 240, 0.1); }

.mini-progress {
  position: relative;
  width: 100%;
  height: 16px;
  background: rgba(76, 201, 240, 0.05);
  border-radius: 2px;
  overflow: hidden;
}

.mini-progress-fill {
  height: 100%;
  background: linear-gradient(90deg, rgba(76, 201, 240, 0.3), rgba(76, 201, 240, 0.5));
  transition: width 0.3s ease;
}

.mini-progress-text {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  font-size: 10px;
  color: var(--text-secondary);
}

.row-action-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  border: 1px solid var(--fire-border);
  border-radius: 2px;
  background: transparent;
  color: var(--text-secondary);
  font-size: 11px;
  cursor: pointer;
  transition: all 0.15s ease;
}

.row-action-btn:hover {
  border-color: var(--fire-cyan);
  color: var(--fire-cyan);
  background: rgba(76, 201, 240, 0.05);
}

.table-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 40px;
  color: var(--text-tertiary);
  font-size: 13px;
}

/* ========================== 弹窗详情 ========================== */
.detail-header {
  display: flex;
  gap: 14px;
  padding: 14px;
  background: rgba(76, 201, 240, 0.03);
  border: 1px solid var(--fire-border);
  border-radius: 3px;
  margin-bottom: 14px;
}

.detail-level-badge {
  width: 56px;
  height: 56px;
  border-radius: 3px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.badge-danger {
  background: rgba(239, 68, 68, 0.15);
  border: 1px solid rgba(239, 68, 68, 0.3);
}

.badge-warning {
  background: rgba(245, 158, 11, 0.15);
  border: 1px solid rgba(245, 158, 11, 0.3);
}

.badge-info {
  background: rgba(76, 201, 240, 0.15);
  border: 1px solid rgba(76, 201, 240, 0.3);
}

.badge-text {
  font-size: 14px;
  font-weight: 700;
  letter-spacing: 1px;
}

.badge-danger .badge-text { color: var(--fire-red); }
.badge-warning .badge-text { color: var(--fire-orange); }
.badge-info .badge-text { color: var(--fire-blue); }

.detail-title-area {
  display: flex;
  flex-direction: column;
  gap: 4px;
  justify-content: center;
}

.detail-title {
  font-size: 15px;
  color: var(--text-primary);
  font-weight: 600;
}

.detail-desc {
  font-size: 12px;
  color: var(--text-secondary);
  line-height: 1.5;
}

.detail-meta-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 8px;
  margin-bottom: 16px;
}

.meta-cell {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 12px;
  background: rgba(76, 201, 240, 0.03);
  border: 1px solid var(--fire-border);
  border-radius: 2px;
}

.meta-label {
  font-size: 11px;
  color: var(--text-tertiary);
  letter-spacing: 1px;
}

.meta-value {
  font-size: 12px;
  color: var(--text-primary);
}

.detail-section-title {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
}

.section-bar {
  width: 2px;
  height: 14px;
  background: var(--fire-cyan);
  box-shadow: 0 0 4px rgba(76, 201, 240, 0.4);
}

.detail-section-title span {
  font-size: 13px;
  color: var(--text-primary);
  letter-spacing: 2px;
}

/* ========================== 时间线 ========================== */
.process-timeline {
  display: flex;
  gap: 0;
  margin-bottom: 20px;
  padding: 12px 0;
  overflow-x: auto;
}

.tl-step {
  display: flex;
  flex-direction: column;
  align-items: center;
  flex: 1;
  min-width: 80px;
}

.tl-indicator {
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 100%;
}

.tl-dot {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1;
  transition: all 0.3s ease;
}

.dot-done {
  background: var(--fire-green);
  box-shadow: 0 0 5px rgba(34, 197, 94, 0.3);
  color: #fff;
}

.dot-current {
  background: var(--fire-cyan);
  box-shadow: 0 0 7px rgba(76, 201, 240, 0.4);
  animation: dotBreathe 1.5s ease-in-out infinite;
  color: #fff;
}

@keyframes dotBreathe {
  0%, 100% { transform: scale(1); box-shadow: 0 0 8px rgba(76, 201, 240, 0.4); }
  50% { transform: scale(1.15); box-shadow: 0 0 12px rgba(76, 201, 240, 0.5); }
}

.dot-pending {
  background: rgba(71, 85, 105, 0.3);
  border: 1px solid rgba(71, 85, 105, 0.5);
}

.tl-line {
  width: 100%;
  height: 2px;
  background: rgba(71, 85, 105, 0.3);
  margin-top: 7px;
}

.tl-line.line-done {
  background: linear-gradient(90deg, var(--fire-green), var(--fire-cyan));
}

.tl-content {
  display: flex;
  flex-direction: column;
  align-items: center;
  margin-top: 8px;
  text-align: center;
  gap: 2px;
}

.tl-name {
  font-size: 11px;
  color: var(--text-tertiary);
  white-space: nowrap;
}

.tl-name.name-active {
  color: var(--text-primary);
}

.tl-status {
  font-size: 9px;
  letter-spacing: 0.5px;
}

.status-done-text { color: var(--fire-green); }
.status-current-text { color: var(--fire-cyan); }
.status-pending-text { color: var(--text-tertiary); }

/* ========================== 操作区 ========================== */
.detail-actions {
  padding-top: 14px;
  border-top: 1px solid var(--fire-border);
}

.action-msg-area {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  background: rgba(76, 201, 240, 0.08);
  border: 1px solid rgba(76, 201, 240, 0.15);
  border-radius: 2px;
  margin-bottom: 12px;
  font-size: 12px;
  color: var(--fire-cyan);
}

.action-btn-row {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  align-items: center;
}

.op-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  border-radius: 2px;
  font-size: 12px;
  cursor: pointer;
  transition: all 0.2s ease;
  border: 1px solid var(--fire-border);
  background: rgba(76, 201, 240, 0.04);
  color: var(--text-secondary);
  letter-spacing: 1px;
}

.op-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.op-btn-primary {
  border-color: rgba(76, 201, 240, 0.4);
  background: rgba(76, 201, 240, 0.1);
  color: var(--fire-cyan);
}

.op-btn-primary:hover {
  background: rgba(76, 201, 240, 0.2);
  box-shadow: 0 2px 8px rgba(76, 201, 240, 0.15);
}

.op-btn-default:hover {
  border-color: var(--fire-border-hover);
  color: var(--text-primary);
}

.op-btn-done {
  border-color: rgba(34, 197, 94, 0.3);
  background: rgba(34, 197, 94, 0.08);
  color: var(--fire-green);
}

/* ========================== 交互流程标注 ========================== */
.flow-bar {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 8px 16px;
  flex-shrink: 0;
}

.flow-bar-label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--text-tertiary);
  letter-spacing: 1px;
  flex-shrink: 0;
}

.flow-bar-label svg {
  color: var(--fire-cyan);
  opacity: 0.6;
}

.flow-bar-steps {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: 1;
  flex-wrap: wrap;
}

.flow-node {
  font-size: 10px;
  color: var(--text-secondary);
  padding: 2px 8px;
  background: rgba(76, 201, 240, 0.04);
  border: 1px solid var(--fire-border);
  border-radius: 2px;
  letter-spacing: 0.5px;
  white-space: nowrap;
}

.flow-node-end {
  color: var(--fire-green);
  border-color: rgba(34, 197, 94, 0.2);
  background: rgba(34, 197, 94, 0.05);
}

.flow-arrow {
  font-size: 10px;
  color: var(--text-tertiary);
  opacity: 0.5;
}

.flow-bar-hint {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 10px;
  color: var(--text-tertiary);
  flex-shrink: 0;
  opacity: 0.7;
}

.flow-bar-hint svg {
  opacity: 0.5;
}
</style>

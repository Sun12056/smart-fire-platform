<template>
  <div class="inspection-view">
    <!-- 页面头部 -->
    <div class="page-header">
      <div class="header-bar"></div>
      <div class="header-text">
        <h2 class="title-spacing">远程智能巡检中心</h2>
        <p class="header-sub">对消防设备进行远程自动化巡检，实时掌握设备运行状态</p>
      </div>
    </div>

    <!-- 设备选择区 -->
    <div class="device-selector fire-card">
      <div class="selector-left">
        <svg class="selector-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="2" y="6" width="20" height="12" rx="2"/>
          <path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M8 14h8"/>
        </svg>
        <el-select v-model="selectedDeviceId" placeholder="选择巡检设备" style="width: 260px" @change="onDeviceChange">
          <el-option v-for="d in store.inspectionDevices" :key="d.id" :label="d.name" :value="d.id" />
        </el-select>
      </div>
      <div class="device-meta" v-if="selectedDevice">
        <span class="meta-tag">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 21h18M5 21V7l8-4v18M19 21V11l-6-4"/></svg>
          {{ selectedDevice.building }}
        </span>
        <span class="meta-tag">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v20M2 12h20"/></svg>
          {{ selectedDevice.floor }}
        </span>
        <span class="meta-tag">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/></svg>
          {{ selectedDevice.type }}
        </span>
        <span class="meta-tag meta-id">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7V4h16v3M9 20h6M12 4v16"/></svg>
          {{ selectedDevice.id }}
        </span>
      </div>
    </div>

    <!-- 主体区域 -->
    <div class="main-content">
      <!-- 左侧：巡检流程 -->
      <div class="left-panel fire-card">
        <div class="panel-header">
          <div class="panel-title-area">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M9 11l3 3L22 4"/>
              <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>
            </svg>
            <h3 class="title-spacing-sm">巡检流程</h3>
          </div>
          <div class="panel-actions">
            <button
              v-if="!store.inspectionInProgress && !inspectionDone"
              class="action-btn primary"
              :disabled="!selectedDeviceId"
              @click="handleStartInspection"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>
              开始巡检
            </button>
            <button
              v-else-if="inspectionDone"
              class="action-btn primary"
              @click="handleStartInspection"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M3 22v-6h6"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/></svg>
              重新巡检
            </button>
            <span v-else class="inspecting-tag">
              <span class="pulse-dot"></span>
              巡检进行中
            </span>
          </div>
        </div>

        <!-- 进度条 -->
        <div class="progress-section" v-if="store.inspectionInProgress || inspectionDone">
          <div class="progress-track">
            <div class="progress-fill" :style="{ width: progressPercent + '%' }"></div>
          </div>
          <span class="progress-text num-font">{{ progressPercent }}<span class="progress-unit">%</span></span>
        </div>

        <!-- 流程步骤 -->
        <div class="steps-container">
          <div class="steps-flow">
            <div
              v-for="(step, idx) in store.inspectionSteps"
              :key="step.id"
              class="step-node"
              :class="step.status"
            >
              <!-- 连接线 -->
              <div class="step-line" v-if="idx < store.inspectionSteps.length - 1">
                <div class="line-fill" :class="step.status"></div>
              </div>
              <!-- 圆形节点 -->
              <div class="step-circle">
                <svg v-if="step.status === 'done'" class="step-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                <svg v-else-if="step.status === 'processing'" class="step-icon spinning" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
                <span v-else class="step-num num-font">{{ idx + 1 }}</span>
              </div>
              <!-- 步骤内容 -->
              <div class="step-content">
                <div class="step-name">{{ step.name }}</div>
                <div class="step-desc">{{ step.description }}</div>
                <div class="step-status">
                  <span v-if="step.status === 'done'" class="status-tag green">已完成</span>
                  <span v-else-if="step.status === 'processing'" class="status-tag cyan">执行中</span>
                  <span v-else class="status-tag" style="color: var(--text-tertiary); background: rgba(71,85,105,0.08);">待执行</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- 巡检结果 -->
        <transition name="result-slide">
          <div class="result-section" v-if="inspectionDone && inspectionResultData">
            <div class="result-header">
              <div class="result-title-area">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
                <h4 class="title-spacing-sm">巡检结果</h4>
              </div>
              <span class="result-badge" :class="inspectionResultData.result">
                {{ resultLabel(inspectionResultData.result) }}
              </span>
            </div>
            <div class="result-summary">
              <div class="summary-item">
                <span class="summary-label">设备编号</span>
                <span class="summary-value num-font">{{ inspectionResultData.deviceId }}</span>
              </div>
              <div class="summary-item">
                <span class="summary-label">巡检耗时</span>
                <span class="summary-value num-font">{{ inspectionResultData.durationText }}</span>
              </div>
              <div class="summary-item">
                <span class="summary-label">巡检时间</span>
                <span class="summary-value num-font">{{ inspectionResultData.time }}</span>
              </div>
            </div>
            <div class="result-items">
              <div
                v-for="(item, idx) in inspectionResultData.items"
                :key="idx"
                class="result-item"
              >
                <span class="result-check" :class="item.result">
                  <svg v-if="item.result === 'pass'" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                  <svg v-else-if="item.result === 'warning'" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
                  <svg v-else width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                </span>
                <span class="result-name">{{ item.name }}</span>
                <span class="result-msg">{{ item.message }}</span>
              </div>
            </div>
            <button class="report-btn" @click="handleGenerateReport">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>
              生成巡检报告
            </button>
          </div>
        </transition>
      </div>

      <!-- 右侧：巡检历史 -->
      <div class="right-panel fire-card">
        <div class="panel-header">
          <div class="panel-title-area">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
            <h3 class="title-spacing-sm">巡检历史</h3>
          </div>
          <span class="history-count num-font">{{ store.inspectionHistory.length }} 条</span>
        </div>
        <div class="history-list">
          <div
            v-for="record in store.inspectionHistory"
            :key="record.id"
            class="history-item"
            @click="showDetail(record)"
          >
            <div class="history-left">
              <span class="history-result-tag" :class="record.result">
                {{ resultLabel(record.result) }}
              </span>
            </div>
            <div class="history-center">
              <div class="history-device">{{ record.deviceName || record.device }}</div>
              <div class="history-time num-font">{{ record.time }}</div>
            </div>
            <div class="history-right">
              <span class="history-duration num-font">{{ formatDuration(record.duration) }}</span>
              <svg class="history-arrow" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
            </div>
          </div>
          <div v-if="store.inspectionHistory.length === 0" class="empty-state">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="opacity:0.3"><circle cx="12" cy="12" r="10"/><line x1="8" y1="12" x2="16" y2="12"/></svg>
            <span>暂无巡检记录</span>
          </div>
        </div>
      </div>
    </div>

    <!-- 交互流程标注 -->
    <div class="flow-bar fire-card">
      <svg class="flow-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="3"/><circle cx="18" cy="18" r="3"/><path d="M6 9v6a3 3 0 0 0 3 3h6"/></svg>
      <div class="flow-steps">
        <span class="flow-step">设备选择</span>
        <span class="flow-arrow">→</span>
        <span class="flow-step">开始巡检</span>
        <span class="flow-arrow">→</span>
        <span class="flow-step">逐步执行</span>
        <span class="flow-arrow">→</span>
        <span class="flow-step">结果汇总</span>
        <span class="flow-arrow">→</span>
        <span class="flow-step">报告生成</span>
        <span class="flow-arrow">→</span>
        <span class="flow-step">历史追溯</span>
      </div>
    </div>

    <!-- 详情弹窗 -->
    <el-dialog v-model="detailVisible" title="巡检详情" width="620px">
      <template v-if="detailRecord">
        <div class="detail-header">
          <span class="detail-id num-font">{{ detailRecord.id }}</span>
          <span class="detail-result-tag" :class="detailRecord.result">
            {{ resultLabel(detailRecord.result) }}
          </span>
        </div>
        <div class="detail-info">
          <div class="detail-row">
            <span class="detail-label">设备名称</span>
            <span class="detail-value">{{ detailRecord.deviceName || detailRecord.device }}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">设备编号</span>
            <span class="detail-value num-font">{{ detailRecord.deviceId }}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">巡检时间</span>
            <span class="detail-value num-font">{{ detailRecord.time }}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">巡检耗时</span>
            <span class="detail-value num-font">{{ formatDuration(detailRecord.duration) }}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">操作人员</span>
            <span class="detail-value">{{ detailRecord.operator || '系统自动' }}</span>
          </div>
        </div>
        <div class="detail-items" v-if="detailRecord.details || detailRecord.items">
          <h4 class="title-spacing-sm">检测项目</h4>
          <div v-for="(item, idx) in (detailRecord.details || detailRecord.items)" :key="idx" class="detail-check-item">
            <span class="result-check" :class="item.result">
              <svg v-if="item.result === 'pass'" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
              <svg v-else-if="item.result === 'warning'" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
              <svg v-else width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </span>
            <span class="check-name">{{ item.name }}</span>
            <span class="check-msg">{{ item.message || '正常' }}</span>
          </div>
        </div>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, computed, onUnmounted } from 'vue'
import { useFireStore } from '../stores/fireStore'
import { generateInspectionResult } from '../mock/inspection'

const store = useFireStore()

// 选中设备
const selectedDeviceId = ref('')
const selectedDevice = computed(() => {
  return store.inspectionDevices.find((d) => d.id === selectedDeviceId.value) || null
})

// 巡检状态
const inspectionDone = ref(false)
const inspectionResultData = ref(null)
const startTime = ref(0)
let stepTimer = null

// 详情弹窗
const detailVisible = ref(false)
const detailRecord = ref(null)

// 进度
const progressPercent = computed(() => {
  const steps = store.inspectionSteps
  if (!steps.length) return 0
  const done = steps.filter((s) => s.status === 'done').length
  return Math.round((done / steps.length) * 100)
})

const progressColor = computed(() => {
  if (progressPercent.value === 100) return '#22C55E'
  return '#4CC9F0'
})

// 事件处理
function onDeviceChange() {
  resetInspectionState()
}

function resetInspectionState() {
  inspectionDone.value = false
  inspectionResultData.value = null
}

function handleStartInspection() {
  if (!selectedDeviceId.value) return
  resetInspectionState()
  store.startInspection(selectedDeviceId.value)
  startTime.value = Date.now()
  advanceSteps()
}

function advanceSteps() {
  if (stepTimer) clearTimeout(stepTimer)
  stepTimer = setTimeout(() => {
    const allDone = store.advanceInspectionStep()
    if (!allDone) {
      advanceSteps()
    } else {
      completeInspection()
    }
  }, 1200 + Math.random() * 800)
}

function completeInspection() {
  const elapsed = Date.now() - startTime.value
  const seconds = Math.round(elapsed / 1000)
  const durationText = seconds < 60 ? `${seconds}秒` : `${Math.floor(seconds / 60)}分${seconds % 60}秒`

  const result = generateInspectionResult(selectedDeviceId.value)
  result.duration = elapsed
  result.durationText = durationText
  result.device = selectedDevice.value?.name || selectedDeviceId.value
  result.deviceName = selectedDevice.value?.name || selectedDeviceId.value

  store.completeInspection(result)
  inspectionResultData.value = result
  inspectionDone.value = true

  store.addNotification({
    title: '巡检完成',
    message: `${result.device} 巡检结果: ${resultLabel(result.result)}`,
    level: result.result === 'fail' ? 'warning' : 'success',
    time: new Date().toLocaleTimeString('zh-CN'),
  })
}

function handleGenerateReport() {
  store.addNotification({
    title: '巡检报告已生成',
    message: `${inspectionResultData.value?.device} 的巡检报告已生成并归档`,
    level: 'success',
    time: new Date().toLocaleTimeString('zh-CN'),
  })
}

function showDetail(record) {
  detailRecord.value = record
  detailVisible.value = true
}

function resultLabel(result) {
  const labels = { pass: '通过', warning: '警告', fail: '异常' }
  return labels[result] || result
}

function formatDuration(duration) {
  if (typeof duration === 'string') return duration
  const seconds = Math.round(duration / 1000)
  if (seconds < 60) return `${seconds}秒`
  return `${Math.floor(seconds / 60)}分${seconds % 60}秒`
}

onUnmounted(() => {
  if (stepTimer) clearTimeout(stepTimer)
})
</script>

<style scoped>
.inspection-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  gap: 10px;
  overflow: hidden;
}

/* 页面头部 */
.page-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 4px;
}

.header-bar {
  width: 2px;
  height: 32px;
  background: var(--fire-blue);

  flex-shrink: 0;
}

.header-text h2 {
  font-size: 18px;
  color: var(--text-primary);
  font-weight: 700;
  letter-spacing: 2px;
  line-height: 1.2;
}

.header-sub {
  font-size: 12px;
  color: var(--text-tertiary);
  margin-top: 2px;
}

/* 设备选择区 */
.device-selector {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
}

.selector-left {
  display: flex;
  align-items: center;
  gap: 8px;
}

.selector-icon {
  color: var(--fire-blue);
  flex-shrink: 0;
}

.device-meta {
  display: flex;
  gap: 6px;
  align-items: center;
}

.meta-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  padding: 3px 8px;
  border-radius: 2px;
  background: rgba(76, 201, 240, 0.04);
  border: 1px solid var(--fire-border);
  color: var(--text-secondary);
}

.meta-tag svg {
  opacity: 0.6;
}

.meta-id {
  color: var(--fire-cyan);
  border-color: rgba(76, 201, 240, 0.2);
}

/* 主体区域 */
.main-content {
  flex: 1;
  display: grid;
  grid-template-columns: 1fr 320px;
  gap: 10px;
  min-height: 0;
}

.left-panel,
.right-panel {
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* 面板头部 */
.panel-header {
  padding: 10px 14px;
  border-bottom: 1px solid var(--fire-border);
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-shrink: 0;
}

.panel-title-area {
  display: flex;
  align-items: center;
  gap: 8px;
}

.panel-title-area svg {
  color: var(--fire-blue);
}

.panel-header h3 {
  font-size: 13px;
  color: var(--text-primary);
  font-weight: 600;
}

.panel-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.history-count {
  font-size: 11px;
  color: var(--text-tertiary);
  background: rgba(76, 201, 240, 0.04);
  padding: 2px 8px;
  border-radius: 2px;
  border: 1px solid var(--fire-border);
}

/* 操作按钮 */
.action-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 14px;
  border-radius: 3px;
  border: 1px solid rgba(76, 201, 240, 0.3);
  background: linear-gradient(135deg, rgba(76, 201, 240, 0.12), rgba(76, 201, 240, 0.04));
  color: var(--fire-cyan);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s;
}

.action-btn:hover:not(:disabled) {
  background: linear-gradient(135deg, rgba(76, 201, 240, 0.2), rgba(76, 201, 240, 0.08));
  box-shadow: 0 2px 8px rgba(76, 201, 240, 0.15);
}

.action-btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.inspecting-tag {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--fire-orange);
}

.pulse-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--fire-orange);
  box-shadow: 0 0 6px var(--fire-orange);
  animation: pulseOrange 1.5s ease-in-out infinite;
}

@keyframes pulseOrange {
  0%, 100% { opacity: 1; box-shadow: 0 0 6px var(--fire-orange); }
  50% { opacity: 0.4; box-shadow: 0 0 8px rgba(245, 158, 11, 0.55); }
}

/* 进度条 */
.progress-section {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px 0;
}

.progress-track {
  flex: 1;
  height: 3px;
  background: rgba(76, 201, 240, 0.08);
  border-radius: 2px;
  overflow: hidden;
}

.progress-fill {
  height: 100%;
  background: linear-gradient(90deg, var(--fire-green), var(--fire-cyan));
  border-radius: 2px;
  transition: width 0.5s ease;
  box-shadow: 0 0 6px rgba(76, 201, 240, 0.4);
}

.progress-text {
  font-size: 13px;
  color: var(--fire-cyan);
  font-weight: 700;
  min-width: 40px;
  text-align: right;
}

.progress-unit {
  font-size: 10px;
  opacity: 0.6;
  margin-left: 1px;
}

/* 流程步骤 */
.steps-container {
  flex: 1;
  overflow-y: auto;
  padding: 16px 14px;
}

.steps-flow {
  display: flex;
  flex-direction: column;
}

.step-node {
  display: flex;
  gap: 12px;
  position: relative;
  min-height: 48px;
}

/* 连接线 */
.step-line {
  position: absolute;
  left: 15px;
  top: 32px;
  width: 2px;
  height: calc(100% - 20px);
  background: rgba(71, 85, 105, 0.2);
  z-index: 0;
}

.line-fill.done {
  background: #22C55E;
}

.line-fill.processing {
  background: linear-gradient(180deg, var(--fire-cyan), rgba(76, 201, 240, 0.2));
  animation: flowDown 1.5s linear infinite;
  background-size: 2px 8px;
  background-image: linear-gradient(180deg, var(--fire-cyan) 50%, transparent 50%);
}

@keyframes flowDown {
  to { background-position: 0 8px; }
}

.line-fill.pending {
  background: repeating-linear-gradient(180deg, rgba(71,85,105,0.2) 0, rgba(71,85,105,0.2) 3px, transparent 3px, transparent 6px);
}

/* 圆形节点 */
.step-circle {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: rgba(10, 25, 45, 0.8);
  border: 2px solid rgba(71, 85, 105, 0.3);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  z-index: 1;
  transition: all 0.3s;
}

.step-node.done .step-circle {
  background: rgba(34, 197, 94, 0.15);
  border-color: var(--fire-green);
  box-shadow: 0 0 5px rgba(34, 197, 94, 0.3);
}

.step-node.done .step-icon {
  color: var(--fire-green);
}

.step-node.processing .step-circle {
  background: rgba(76, 201, 240, 0.15);
  border-color: var(--fire-cyan);
  box-shadow: 0 0 7px rgba(76, 201, 240, 0.4);
  animation: pulseCyan 1.5s ease-in-out infinite;
}

.step-node.processing .step-icon {
  color: var(--fire-cyan);
}

@keyframes pulseCyan {
  0%, 100% { box-shadow: 0 0 6px rgba(76, 201, 240, 0.3); }
  50% { box-shadow: 0 0 12px rgba(76, 201, 240, 0.5); }
}

.step-icon {
  display: flex;
  align-items: center;
  justify-content: center;
}

.step-icon.spinning {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.step-num {
  color: var(--text-tertiary);
  font-size: 13px;
  font-weight: 700;
}

/* 步骤内容 */
.step-content {
  flex: 1;
  padding-bottom: 14px;
}

.step-name {
  font-size: 13px;
  color: var(--text-primary);
  font-weight: 600;
  margin-bottom: 3px;
  letter-spacing: 0.5px;
}

.step-node.processing .step-name {
  color: var(--fire-cyan);
}

.step-node.done .step-name {
  color: var(--text-primary);
}

.step-desc {
  font-size: 11px;
  color: var(--text-tertiary);
  margin-bottom: 5px;
  line-height: 1.4;
}

/* 巡检结果 */
.result-section {
  padding: 14px;
  border-top: 1px solid var(--fire-border);
  max-height: 280px;
  overflow-y: auto;
  flex-shrink: 0;
}

.result-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 10px;
}

.result-title-area {
  display: flex;
  align-items: center;
  gap: 6px;
}

.result-title-area svg {
  color: var(--fire-blue);
}

.result-header h4 {
  font-size: 13px;
  color: var(--text-primary);
  font-weight: 600;
}

.result-badge {
  font-size: 12px;
  padding: 3px 12px;
  border-radius: 2px;
  font-weight: 700;
  letter-spacing: 1px;
}

.result-badge.pass { color: var(--fire-green); background: rgba(34, 197, 94, 0.12); border: 1px solid rgba(34, 197, 94, 0.3); }
.result-badge.warning { color: var(--fire-orange); background: rgba(245, 158, 11, 0.12); border: 1px solid rgba(245, 158, 11, 0.3); }
.result-badge.fail { color: var(--fire-red); background: rgba(239, 68, 68, 0.12); border: 1px solid rgba(239, 68, 68, 0.3); }

.result-summary {
  display: flex;
  gap: 20px;
  margin-bottom: 10px;
  padding: 8px 10px;
  background: rgba(76, 201, 240, 0.03);
  border-radius: 3px;
  border: 1px solid var(--fire-border);
}

.summary-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.summary-label {
  font-size: 10px;
  color: var(--text-tertiary);
  text-transform: uppercase;
  letter-spacing: 1px;
}

.summary-value {
  font-size: 13px;
  color: var(--text-primary);
  font-weight: 600;
}

.result-items {
  display: flex;
  flex-direction: column;
  gap: 5px;
  margin-bottom: 10px;
}

.result-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  background: rgba(10, 25, 45, 0.4);
  border-radius: 3px;
  border: 1px solid var(--fire-border);
  transition: all 0.2s;
}

.result-item:hover {
  border-color: var(--fire-border-hover);
}

.result-check {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.result-check.pass { color: var(--fire-green); background: rgba(34, 197, 94, 0.12); }
.result-check.warning { color: var(--fire-orange); background: rgba(245, 158, 11, 0.12); }
.result-check.fail { color: var(--fire-red); background: rgba(239, 68, 68, 0.12); }

.result-name {
  font-size: 12px;
  color: var(--text-primary);
  font-weight: 600;
  flex-shrink: 0;
  min-width: 70px;
}

.result-msg {
  font-size: 11px;
  color: var(--text-secondary);
  margin-left: auto;
  text-align: right;
}

.report-btn {
  width: 100%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 8px;
  border-radius: 3px;
  border: 1px solid rgba(76, 201, 240, 0.3);
  background: linear-gradient(135deg, rgba(76, 201, 240, 0.08), rgba(76, 201, 240, 0.02));
  color: var(--fire-blue);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s;
}

.report-btn:hover {
  background: linear-gradient(135deg, rgba(76, 201, 240, 0.15), rgba(76, 201, 240, 0.05));
  box-shadow: 0 2px 8px rgba(76, 201, 240, 0.15);
}

/* 历史记录 */
.history-list {
  flex: 1;
  overflow-y: auto;
  padding: 6px 8px;
}

.history-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-radius: 3px;
  margin-bottom: 5px;
  background: rgba(10, 25, 45, 0.3);
  border: 1px solid var(--fire-border);
  cursor: pointer;
  transition: all 0.2s;
}

.history-item:hover {
  border-color: rgba(76, 201, 240, 0.3);
  background: rgba(76, 201, 240, 0.05);
}

.history-result-tag {
  font-size: 10px;
  padding: 2px 8px;
  border-radius: 2px;
  font-weight: 600;
  white-space: nowrap;
  letter-spacing: 0.5px;
}

.history-result-tag.pass { color: var(--fire-green); background: rgba(34, 197, 94, 0.12); }
.history-result-tag.warning { color: var(--fire-orange); background: rgba(245, 158, 11, 0.12); }
.history-result-tag.fail { color: var(--fire-red); background: rgba(239, 68, 68, 0.12); }

.history-center {
  flex: 1;
  min-width: 0;
}

.history-device {
  font-size: 12px;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-bottom: 2px;
}

.history-time {
  font-size: 11px;
  color: var(--text-tertiary);
}

.history-right {
  display: flex;
  align-items: center;
  gap: 6px;
}

.history-duration {
  font-size: 11px;
  color: var(--text-secondary);
}

.history-arrow {
  color: var(--text-tertiary);
  transition: transform 0.2s;
}

.history-item:hover .history-arrow {
  color: var(--fire-cyan);
  transform: translateX(2px);
}

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 40px 0;
  color: var(--text-tertiary);
  font-size: 12px;
}

/* 交互流程标注 */
.flow-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 14px;
  flex-shrink: 0;
}

.flow-icon {
  color: var(--fire-blue);
  flex-shrink: 0;
}

.flow-steps {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.flow-step {
  font-size: 11px;
  color: var(--text-secondary);
  letter-spacing: 1px;
  white-space: nowrap;
}

.flow-arrow {
  font-size: 10px;
  color: var(--text-tertiary);
}

/* 结果区域过渡 */
.result-slide-enter-active {
  transition: all 0.4s ease-out;
}
.result-slide-enter-from {
  opacity: 0;
  transform: translateY(10px);
}

/* 弹窗详情 */
.detail-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 14px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--fire-border);
}

.detail-id {
  font-size: 14px;
  color: var(--text-primary);
  font-weight: 600;
}

.detail-result-tag {
  font-size: 12px;
  padding: 3px 12px;
  border-radius: 2px;
  font-weight: 600;
  letter-spacing: 1px;
}

.detail-result-tag.pass { color: var(--fire-green); background: rgba(34, 197, 94, 0.12); }
.detail-result-tag.warning { color: var(--fire-orange); background: rgba(245, 158, 11, 0.12); }
.detail-result-tag.fail { color: var(--fire-red); background: rgba(239, 68, 68, 0.12); }

.detail-info {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 6px;
  margin-bottom: 14px;
}

.detail-row {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 7px 10px;
  background: rgba(76, 201, 240, 0.03);
  border-radius: 3px;
  border: 1px solid var(--fire-border);
}

.detail-label {
  font-size: 10px;
  color: var(--text-tertiary);
  text-transform: uppercase;
  letter-spacing: 1px;
}

.detail-value {
  font-size: 13px;
  color: var(--text-primary);
}

.detail-items h4 {
  font-size: 12px;
  color: var(--text-secondary);
  margin-bottom: 8px;
}

.detail-check-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  background: rgba(10, 25, 45, 0.3);
  border-radius: 3px;
  margin-bottom: 4px;
  border: 1px solid var(--fire-border);
}

.check-name {
  font-size: 12px;
  color: var(--text-primary);
  font-weight: 600;
  min-width: 80px;
}

.check-msg {
  font-size: 11px;
  color: var(--text-secondary);
}
</style>

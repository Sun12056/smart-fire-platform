<template>
  <div class="demo-panel fire-card">
    <div class="panel-header">
      <span class="panel-title">演示控制台</span>
      <button class="close-btn" @click="store.toggleDemoMode()">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
      </button>
    </div>
    <div class="panel-body">
      <!-- 快捷操作（不弹窗，仅驱动平台真实状态） -->
      <div class="section-label">快捷操作</div>
      <button class="demo-btn reset" @click="handleReset">
        <svg class="btn-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 12a9 9 0 0115.5-6.5L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 01-15.5 6.5L3 16"/><path d="M3 21v-5h5"/></svg>
        <span>正常状态</span>
      </button>
      <button class="demo-btn warning" @click="handleSimulateAlarm">
        <svg class="btn-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 9v4M12 17h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/></svg>
        <span>模拟异常</span>
      </button>
      <button class="demo-btn danger" @click="handleSimulateFire">
        <svg class="btn-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 2C8 6 6 9 6 13a6 6 0 0012 0c0-2-1-4-2-5 0 2-1 3-2 3 0-3-2-6-2-9z"/></svg>
        <span>模拟火灾</span>
      </button>

      <div class="section-divider"></div>
      <!-- 六阶段演示流程（真实改变平台状态，统一单一数据源） -->
      <div class="section-label">六阶段演示流程</div>
      <div class="demo-flow-progress">
        <el-progress :percentage="platformStore.demoFlowProgress" :stroke-width="6" :color="'#4CC9F0'" />
      </div>
      <div class="demo-flow-steps">
        <div
          v-for="(step, idx) in platformStore.demoFlowSteps"
          :key="step.id"
          class="flow-step"
          :class="stepStatus(idx)"
        >
          <span class="step-icon">
            <svg v-if="step.icon === 'fire'" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 2C8 6 6 9 6 13a6 6 0 0012 0c0-2-1-4-2-5 0 2-1 3-2 3 0-3-2-6-2-9z"/></svg>
            <svg v-else-if="step.icon === 'alert'" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 9v4M12 17h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/></svg>
            <svg v-else-if="step.icon === 'route'" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="M6 8.5V14a2 2 0 0 0 2 2h6.5"/><path d="M16 4.5h2.5V11"/></svg>
            <svg v-else-if="step.icon === 'evac'" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="9" cy="7" r="3"/><path d="M3 21v-2a6 6 0 0 1 12 0v2"/><path d="M15 11l5 5M20 11l-5 5"/></svg>
            <svg v-else-if="step.icon === 'check'" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><path d="M22 4L12 14.01l-3-3"/></svg>
            <svg v-else-if="step.icon === 'rescue'" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 2l8 4v6c0 5-3.5 8.5-8 10-4.5-1.5-8-5-8-10V6l8-4z"/><path d="M12 8v8M8 12h8"/></svg>
          </span>
          <span class="step-name">{{ step.name }}</span>
          <span class="step-status">
            <svg v-if="stepStatus(idx) === 'done'" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#22C55E" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg>
            <span v-else-if="stepStatus(idx) === 'processing'" class="processing-dot"></span>
            <span v-else class="step-dot"></span>
          </span>
        </div>
      </div>
      <div class="stage-desc" v-if="stageDesc">{{ stageDesc }}</div>
      <!-- demo 模式：连接状态与后端状态机错误 -->
      <div v-if="dataSource.isDemo" class="demo-link" :class="demoStore.wsStatus">
        <span class="link-dot"></span>
        <span>{{ linkText }}</span>
      </div>
      <div v-if="demoStore.error" class="demo-error">{{ demoStore.error }}</div>
      <div class="demo-flow-actions">
        <button class="demo-btn demo-flow" @click="handleDemoFlow">
          <svg class="btn-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <polygon v-if="!platformStore.demoFlowActive" points="5 3 19 12 5 21 5 3"/>
              <template v-else>
                <path d="M5 4l10 8-10 8z"/>
                <path d="M19 5v14"/>
              </template>
            </svg>
          <span>{{ platformStore.demoFlowActive ? '推进下一步' : '启动演示流程' }}</span>
        </button>
        <button class="demo-btn demo-auto" @click="handleAutoDemo">
          <svg class="btn-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><polygon points="5 4 15 12 5 20 5 4"/><line x1="19" y1="5" x2="19" y2="19"/></svg>
          <span>自动演示</span>
        </button>
        <button class="demo-btn reset" @click="handleStopAutoDemo" v-if="platformStore.demoFlowActive || store.emergencyStage > 0">
          <svg class="btn-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="6" y="6" width="12" height="12"/></svg>
          <span>停止重置</span>
        </button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { useFireStore } from '../stores/fireStore'
import { usePlatformStore } from '../stores/platformStore'
import { useDemoStore } from '../stores/demoStore'
import { dataSource } from '../api'
import { computed } from 'vue'

const store = useFireStore()
const platformStore = usePlatformStore()
const demoStore = useDemoStore()

const LINK_TEXT = {
  idle: '未连接',
  connecting: '连接中…',
  open: '已连接·后端状态机驱动',
  reconnecting: '断线重连中…',
  closed: '已断开',
  error: '连接异常',
}
const linkText = computed(() => LINK_TEXT[demoStore.wsStatus] || demoStore.wsStatus)

const stageDescMap = {
  0: '点击「启动演示流程」开始六阶段消防应急演示。',
  1: '已定位火情建筑/楼层/区域（3号楼 5F A区），设备状态与日志已更新。',
  2: '已确认火灾并启动应急响应：联动应急照明、标记危险区域与风险人员、自动计算疏散路线。',
  3: '多套疏散路线已生成（避开火灾区、不穿墙），查看推荐/备选路线后「确认疏散路径」。',
  4: '智能疏散中：疏散指示灯进入脉冲强闪，A/B/C/D 人员沿路线动态撤离。',
  5: '疏散完成，自动识别滞留人员；页面直接显示滞留人数/位置，点击「确认滞留人员位置」。',
  6: '协同救援已启动：已联系消防救援队伍，建立救援任务与通道。',
}
const stageDesc = computed(() => stageDescMap[store.emergencyStage] || '')

function stepStatus(idx) {
  const cur = platformStore.demoStepIndex
  if (idx < cur) return 'done'
  if (idx === cur) return 'processing'
  return 'pending'
}

function handleReset() {
  store.resetDemoState()
}

function handleSimulateAlarm() {
  store.simulateAlarm()
}

function handleSimulateFire() {
  store.simulateFireAlarm()
}

function handleDemoFlow() {
  if (!platformStore.demoFlowActive) platformStore.startDemoFlow()
  else platformStore.advanceDemoFlow()
}

let autoDemoTimer = null
function stopAuto() {
  if (autoDemoTimer) {
    clearInterval(autoDemoTimer)
    autoDemoTimer = null
  }
}
function handleAutoDemo() {
  stopAuto()
  if (!platformStore.demoFlowActive) platformStore.startDemoFlow()
  autoDemoTimer = setInterval(() => {
    if (store.emergencyStage >= 6) {
      stopAuto()
      return
    }
    platformStore.advanceDemoFlow()
  }, 3500)
}
function handleStopAutoDemo() {
  stopAuto()
  platformStore.resetDemoFlow()
}
</script>

<style scoped>
.demo-panel {
  position: fixed;
  bottom: 16px;
  left: 76px;
  width: 232px;
  z-index: 1000;
  padding: 0;
  border-color: rgba(76, 201, 240, 0.15);
  box-shadow: 0 4px 24px rgba(0, 0, 0, 0.4);
  max-height: 84vh;
  overflow-y: auto;
}

.panel-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 12px;
  border-bottom: 1px solid var(--fire-border);
  background: rgba(76, 201, 240, 0.04);
  position: sticky;
  top: 0;
  z-index: 1;
}

.panel-title {
  font-size: var(--fs-sm);
  font-weight: 600;
  color: var(--fire-blue);
  letter-spacing: 1.5px;
}

.close-btn {
  background: none;
  border: none;
  color: #475569;
  cursor: pointer;
  font-size: 12px;
  display: flex;
  align-items: center;
}

.close-btn:hover {
  color: #EF4444;
}

.panel-body {
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.section-label {
  font-size: 10px;
  color: #475569;
  padding: 4px 0 2px;
  letter-spacing: 1px;
}

.section-divider {
  height: 1px;
  background: var(--fire-border);
  margin: 6px 0;
}

.demo-btn {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  border-radius: 2px;
  border: 1px solid var(--fire-border);
  background: rgba(76, 201, 240, 0.03);
  color: var(--text-secondary);
  font-size: var(--fs-xs);
  cursor: pointer;
  transition: all 0.2s;
  text-align: left;
  letter-spacing: 0.5px;
}

.demo-btn:hover {
  transform: translateX(2px);
  filter: brightness(1.3);
}

.demo-btn.reset { border-color: rgba(34, 197, 94, 0.2); }
.demo-btn.reset:hover { background: rgba(34, 197, 94, 0.08); }

.demo-btn.warning { border-color: rgba(245, 158, 11, 0.2); }
.demo-btn.warning:hover { background: rgba(245, 158, 11, 0.08); }

.demo-btn.danger { border-color: rgba(239, 68, 68, 0.2); }
.demo-btn.danger:hover { background: rgba(239, 68, 68, 0.08); }

.demo-btn.demo-flow {
  border-color: rgba(76, 201, 240, 0.3);
  background: rgba(76, 201, 240, 0.06);
  color: #4CC9F0;
}

.demo-btn.demo-flow:hover {
  background: rgba(76, 201, 240, 0.12);
  box-shadow: 0 2px 8px rgba(27, 31, 42, 0.1);
}

.demo-btn.demo-auto {
  border-color: rgba(168, 85, 247, 0.3);
  background: rgba(168, 85, 247, 0.06);
  color: #4361EE;
}

.demo-btn.demo-auto:hover {
  background: rgba(168, 85, 247, 0.12);
  box-shadow: 0 2px 8px rgba(27, 31, 42, 0.1);
}

.btn-svg {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
}

.demo-flow-progress {
  margin: 4px 0;
}

:deep(.el-progress-bar__inner) {
  background: #4CC9F0 !important;
}

.demo-flow-steps {
  display: flex;
  flex-direction: column;
  gap: 3px;
  max-height: 220px;
  overflow-y: auto;
}

.flow-step {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 8px;
  border-radius: 2px;
  font-size: var(--fs-xs);
  transition: all 0.2s;
  border: 1px solid transparent;
}

.flow-step.pending { color: #475569; }
.flow-step.processing {
  color: #4CC9F0;
  background: rgba(76,201,240,0.1);
  border-color: rgba(76,201,240,0.3);
}
.flow-step.done {
  color: #22C55E;
  background: rgba(34,197,94,0.05);
}

.step-icon {
  display: flex;
  align-items: center;
  flex-shrink: 0;
}

.step-name {
  flex: 1;
}

.step-status {
  width: 14px;
  text-align: center;
  display: flex;
  align-items: center;
  justify-content: center;
}

.step-dot {
  display: inline-block;
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: #475569;
}

.processing-dot {
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #4CC9F0;
  animation: blink 1s ease-in-out infinite;
}

.demo-link {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 10px;
  color: #475569;
  padding: 4px 6px;
  border-radius: 2px;
  border: 1px solid var(--fire-border);
}
.demo-link.open { color: #22C55E; border-color: rgba(34,197,94,0.3); }
.demo-link.reconnecting { color: #F59E0B; border-color: rgba(245,158,11,0.3); }
.demo-link.error { color: #EF4444; border-color: rgba(239,68,68,0.3); }
.link-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
}
.demo-error {
  font-size: 10px;
  color: #FCA5A5;
  background: rgba(239,68,68,0.08);
  border: 1px solid rgba(239,68,68,0.25);
  border-radius: 2px;
  padding: 5px 8px;
  line-height: 1.4;
}

.stage-desc {
  font-size: 11px;
  line-height: 1.5;
  color: rgba(255,255,255,0.7);
  background: rgba(76,201,240,0.05);
  border: 1px solid rgba(76,201,240,0.15);
  border-radius: 3px;
  padding: 6px 8px;
}

.demo-flow-actions {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

@keyframes blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
}
</style>

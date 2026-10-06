<template>
  <div class="lighting-view">
    <!-- 页面头部 -->
    <div class="page-header">
      <div class="header-bar"></div>
      <div class="header-text">
        <h2 class="title-spacing">智能照明控制中心</h2>
        <p class="header-sub">基于人员感知的智能照明联动与节能管理</p>
      </div>
      <div class="header-status">
        <span class="status-tag" :class="currentMode === 'emergency' ? 'red' : currentMode === 'sensor' ? 'cyan' : 'green'">
          {{ modeLabel }}
        </span>
      </div>
    </div>

    <!-- 设备选择区 -->
    <div class="device-selector fire-card">
      <div class="selector-group">
        <span class="selector-label">楼栋</span>
        <el-select v-model="selectedBuilding" placeholder="选择楼栋" style="width: 120px" @change="onBuildingChange" size="small">
          <el-option v-for="b in buildingOptions" :key="b" :label="b" :value="b" />
        </el-select>
      </div>
      <div class="selector-divider"></div>
      <div class="selector-group">
        <span class="selector-label">楼层</span>
        <el-select v-model="selectedFloor" placeholder="选择楼层" style="width: 100px" @change="onFloorChange" :disabled="!selectedBuilding" size="small">
          <el-option v-for="f in floorOptions" :key="f" :label="f" :value="f" />
        </el-select>
      </div>
      <div class="selector-divider"></div>
      <div class="selector-group">
        <span class="selector-label">设备</span>
        <el-select v-model="selectedDeviceId" placeholder="选择照明设备" style="width: 200px" @change="onDeviceChange" :disabled="!selectedFloor" size="small">
          <el-option v-for="d in currentFloorLights" :key="d.id" :label="d.name" :value="d.id" />
        </el-select>
      </div>
      <div class="selector-divider"></div>
      <div class="device-info" v-if="currentDevice">
        <span class="status-tag" :class="currentDevice.status === 'offline' ? 'orange' : 'green'">
          {{ statusLabel(currentDevice.status) }}
        </span>
        <span class="info-text">{{ currentDevice.type || 'LED照明' }}</span>
        <span class="info-text num-font">{{ currentDevice.powerConsumption || 0 }}W</span>
      </div>
    </div>

    <!-- 主体两栏 -->
    <div class="main-content">
      <!-- 左侧：SVG 照明可视化 -->
      <div class="left-col fire-card">
        <div class="map-header">
          <span class="col-section-title title-spacing-sm">楼层照明分布</span>
          <div class="map-legend">
            <span class="legend-item"><span class="legend-dot" style="background: #475569;"></span>关闭</span>
            <span class="legend-item"><span class="legend-dot" style="background: var(--fire-orange); box-shadow: 0 0 6px var(--fire-orange);"></span>中亮</span>
            <span class="legend-item"><span class="legend-dot" style="background: #F59E0B; box-shadow: 0 0 6px #F59E0B;"></span>全亮</span>
          </div>
        </div>

        <div class="svg-container">
          <svg viewBox="0 0 800 420" class="floor-svg">
            <defs>
              <pattern id="grid-fine-l" width="20" height="20" patternUnits="userSpaceOnUse">
                <path d="M 20 0 L 0 0 0 20" fill="none" stroke="rgba(245,158,11,0.03)" stroke-width="0.5"/>
              </pattern>
              <pattern id="grid-bold-l" width="80" height="80" patternUnits="userSpaceOnUse">
                <rect width="80" height="80" fill="url(#grid-fine-l)"/>
                <path d="M 80 0 L 0 0 0 80" fill="none" stroke="rgba(245,158,11,0.06)" stroke-width="1"/>
              </pattern>
              <linearGradient id="scan-grad-l" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stop-color="rgba(245,158,11,0)"/>
                <stop offset="50%" stop-color="rgba(245,158,11,0.1)"/>
                <stop offset="100%" stop-color="rgba(245,158,11,0)"/>
              </linearGradient>
              <!-- 灯光径向渐变 -->
              <radialGradient id="light-dim" cx="50%" cy="50%" r="50%">
                <stop offset="0%" stop-color="rgba(245,158,11,0.15)"/>
                <stop offset="100%" stop-color="rgba(245,158,11,0)"/>
              </radialGradient>
              <radialGradient id="light-mid" cx="50%" cy="50%" r="50%">
                <stop offset="0%" stop-color="rgba(245,158,11,0.3)"/>
                <stop offset="60%" stop-color="rgba(245,158,11,0.08)"/>
                <stop offset="100%" stop-color="rgba(245,158,11,0)"/>
              </radialGradient>
              <radialGradient id="light-bright" cx="50%" cy="50%" r="50%">
                <stop offset="0%" stop-color="rgba(255,215,0,0.4)"/>
                <stop offset="50%" stop-color="rgba(255,215,0,0.12)"/>
                <stop offset="100%" stop-color="rgba(255,215,0,0)"/>
              </radialGradient>
              <radialGradient id="light-emergency" cx="50%" cy="50%" r="50%">
                <stop offset="0%" stop-color="rgba(239,68,68,0.35)"/>
                <stop offset="60%" stop-color="rgba(239,68,68,0.1)"/>
                <stop offset="100%" stop-color="rgba(239,68,68,0)"/>
              </radialGradient>
            </defs>

            <!-- 双层网格背景 -->
            <rect width="800" height="420" fill="url(#grid-bold-l)"/>

            <!-- 扫描线动画 -->
            <rect x="0" y="0" width="800" height="60" fill="url(#scan-grad-l)" class="scan-line-l"/>

            <!-- 房间简化版 -->
            <g class="rooms-l">
              <rect x="20" y="20" width="160" height="100" rx="2" class="room-l"/>
              <text x="100" y="75" class="room-label-l">办公室 A</text>
              <rect x="200" y="20" width="140" height="100" rx="2" class="room-l"/>
              <text x="270" y="75" class="room-label-l">办公室 B</text>
              <rect x="360" y="20" width="160" height="100" rx="2" class="room-l"/>
              <text x="440" y="75" class="room-label-l">会议室</text>
              <rect x="540" y="20" width="120" height="100" rx="2" class="room-l"/>
              <text x="600" y="75" class="room-label-l">休息区</text>
              <rect x="680" y="20" width="100" height="100" rx="2" class="room-l"/>
              <text x="730" y="75" class="room-label-l">储物间</text>
              <rect x="20" y="280" width="180" height="100" rx="2" class="room-l"/>
              <text x="110" y="335" class="room-label-l">设备机房</text>
              <rect x="220" y="280" width="160" height="100" rx="2" class="room-l"/>
              <text x="300" y="335" class="room-label-l">走廊通道</text>
              <rect x="400" y="280" width="180" height="100" rx="2" class="room-l"/>
              <text x="490" y="335" class="room-label-l">配电室</text>
              <rect x="600" y="280" width="180" height="100" rx="2" class="room-l"/>
              <text x="690" y="335" class="room-label-l">值班室</text>
              <!-- 走廊 -->
              <rect x="20" y="140" width="760" height="120" rx="1" class="corridor-l"/>
              <text x="400" y="205" class="corridor-label-l">主走廊</text>
            </g>

            <!-- 灯具组 -->
            <g class="lights">
              <!-- 办公室A 灯具 -->
              <g class="light-group" v-for="light in lightLayout" :key="light.id" @click="selectLight(light)">
                <!-- 光照范围 -->
                <circle
                  :cx="light.x" :cy="light.y" :r="lightRadius(light)"
                  :fill="lightGradient(light)"
                  :opacity="lightOpacity(light)"
                  class="light-range"
                />
                <!-- 灯具本体 -->
                <circle
                  :cx="light.x" :cy="light.y" r="6"
                  :fill="lightColor(light)"
                  :stroke="lightStrokeColor(light)"
                  stroke-width="1"
                  class="light-bulb"
                />
                <!-- 灯具编号 -->
                <text :x="light.x" :y="light.y - 12" class="light-label">{{ light.id }}</text>
              </g>
            </g>

            <!-- 模式标识水印 -->
            <g class="mode-watermark" v-if="currentMode === 'emergency'">
              <rect x="300" y="190" width="200" height="40" rx="2" fill="rgba(239,68,68,0.08)" stroke="rgba(239,68,68,0.3)" stroke-width="1"/>
              <text x="400" y="215" text-anchor="middle" fill="var(--fire-red)" font-size="16" font-weight="700" letter-spacing="4">应急照明模式</text>
            </g>
            <g class="mode-watermark" v-else-if="currentMode === 'sensor'">
              <rect x="300" y="190" width="200" height="40" rx="2" fill="rgba(76,201,240,0.06)" stroke="rgba(76,201,240,0.2)" stroke-width="1"/>
              <text x="400" y="215" text-anchor="middle" fill="var(--fire-cyan)" font-size="16" font-weight="700" letter-spacing="4">人员感应模式</text>
            </g>
            <g class="mode-watermark" v-else>
              <rect x="300" y="190" width="200" height="40" rx="2" fill="rgba(34,197,94,0.05)" stroke="rgba(34,197,94,0.15)" stroke-width="1"/>
              <text x="400" y="215" text-anchor="middle" fill="var(--fire-green)" font-size="16" font-weight="700" letter-spacing="4">节能模式</text>
            </g>
          </svg>
        </div>
      </div>

      <!-- 右侧：控制面板 + 图表 -->
      <div class="right-col">
        <!-- 亮度 + 状态 -->
        <div class="fire-card control-card">
          <div class="col-section-title title-spacing-sm">照明控制</div>

          <!-- 亮度大字显示 -->
          <div class="brightness-row">
            <div class="brightness-display">
              <span class="brightness-value num-font glow-text" :style="{ color: bulbColor }">{{ brightness }}%</span>
              <span class="brightness-label">当前亮度</span>
            </div>
            <!-- 灯泡 SVG -->
            <div class="bulb-visual">
              <svg viewBox="0 0 100 120" class="bulb-svg">
                <defs>
                  <radialGradient id="bulbGlowL" cx="50%" cy="40%" r="50%">
                    <stop offset="0%" :stop-color="bulbColor" :stop-opacity="glowOpacity"/>
                    <stop offset="100%" :stop-color="bulbColor" :stop-opacity="0"/>
                  </radialGradient>
                </defs>
                <circle cx="50" cy="45" r="40" fill="url(#bulbGlowL)" :opacity="brightness / 100"/>
                <path d="M 50 15 C 30 15 22 32 22 48 C 22 60 28 68 31 76 L 69 76 C 72 68 78 60 78 48 C 78 32 70 15 50 15 Z"
                  :fill="bulbFill" :stroke="bulbColor" stroke-width="1.5" :opacity="0.3 + brightness / 200"/>
                <path d="M 38 40 Q 50 52 62 40 Q 56 58 50 64 Q 44 58 38 40"
                  :stroke="bulbColor" stroke-width="1.5" fill="none" :opacity="brightness / 100"/>
                <rect x="38" y="76" width="24" height="12" rx="1" fill="#475569" stroke="#475569" stroke-width="0.5"/>
                <line x1="40" y1="79" x2="60" y2="79" stroke="#475569" stroke-width="1"/>
                <line x1="40" y1="83" x2="60" y2="83" stroke="#475569" stroke-width="1"/>
                <rect x="45" y="88" width="10" height="6" rx="1" fill="#1B1F2A" stroke="#475569" stroke-width="0.5"/>
              </svg>
            </div>
          </div>

          <!-- 状态信息 -->
          <div class="status-row">
            <div class="status-item">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" :style="{ color: personDetected ? 'var(--fire-cyan)' : 'var(--text-tertiary)' }">
                <circle cx="12" cy="8" r="4"/><path d="M4 22c0-4 4-6 8-6s8 2 8 6"/>
              </svg>
              <span class="status-name">人员检测</span>
              <span class="status-val" :class="personDetected ? 'text-cyan' : 'text-gray'">
                {{ personDetected ? '已检测' : '未检测' }}
              </span>
            </div>
            <div class="status-item">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color: var(--fire-green);">
                <circle cx="12" cy="12" r="10"/><polyline points="9 12 11 14 15 10"/>
              </svg>
              <span class="status-name">设备状态</span>
              <span class="status-val text-green">{{ ambientLabel }}</span>
            </div>
          </div>

          <!-- 亮度滑块 -->
          <div class="slider-section">
            <div class="slider-header">
              <span class="slider-label">亮度调节</span>
              <span class="num-font slider-val" :style="{ color: bulbColor }">{{ sliderBrightness }}%</span>
            </div>
            <el-slider
              v-model="sliderBrightness"
              :min="0"
              :max="100"
              :show-tooltip="false"
              @change="handleBrightnessChange"
              :style="{ '--el-slider-main-bg-color': bulbColor }"
            />
          </div>

          <!-- 模式选择 -->
          <div class="mode-section">
            <div class="mode-label">控制模式</div>
            <div class="mode-buttons">
              <button
                v-for="m in modeList"
                :key="m.key"
                class="mode-btn"
                :class="{ active: currentMode === m.key }"
                :style="currentMode === m.key ? { borderColor: m.color, color: m.color, background: m.color + '12', boxShadow: '0 0 12px ' + m.color + '20' } : {}"
                @click="handleModeChange(m.key)"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                  <template v-if="m.key === 'energy'"><path d="M12 2v10l4 4"/><circle cx="12" cy="12" r="10"/></template>
                  <template v-else-if="m.key === 'sensor'"><circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="8" stroke-dasharray="3 2"/></template>
                  <template v-else><path d="M12 2L2 22h20L12 2z"/><line x1="12" y1="9" x2="12" y2="15"/></template>
                </svg>
                <span>{{ m.label }}</span>
              </button>
            </div>
          </div>
        </div>

        <!-- 历史亮度曲线 -->
        <div class="fire-card chart-card-l">
          <div class="chart-title-row">
            <span class="col-section-title title-spacing-sm">亮度变化趋势</span>
          </div>
          <div class="chart-area" ref="chartRef"></div>
        </div>

        <!-- 能耗统计 -->
        <div class="fire-card energy-card-l">
          <div class="chart-title-row">
            <span class="col-section-title title-spacing-sm">能耗统计</span>
          </div>
          <div class="energy-grid">
            <div class="energy-item">
              <span class="energy-value num-font text-cyan">{{ energy.today }}</span>
              <span class="energy-unit">kWh</span>
              <span class="energy-label">今日能耗</span>
            </div>
            <div class="energy-item">
              <span class="energy-value num-font text-blue">{{ energy.month }}</span>
              <span class="energy-unit">kWh</span>
              <span class="energy-label">本月能耗</span>
            </div>
            <div class="energy-item">
              <span class="energy-value num-font text-green">{{ energy.saved }}</span>
              <span class="energy-unit">kWh</span>
              <span class="energy-label">节能总量</span>
            </div>
            <div class="energy-item">
              <span class="energy-value num-font text-orange">{{ energy.savedPercent }}%</span>
              <span class="energy-label">节能率</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 底部操作按钮 -->
    <div class="bottom-actions">
      <button class="action-btn sensor" @click="handleSimulatePerson">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="8" r="4"/><path d="M4 22c0-4 4-6 8-6s8 2 8 6"/></svg>
        <span>模拟人员进入</span>
      </button>
      <button class="action-btn emergency" @click="handleEmergency">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 2L2 22h20L12 2z"/><line x1="12" y1="9" x2="12" y2="15"/><circle cx="12" cy="18" r="1" fill="currentColor"/></svg>
        <span>启动应急模式</span>
      </button>
      <button class="action-btn reset" @click="handleReset">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><polyline points="3 3 3 8 8 8"/></svg>
        <span>恢复默认</span>
      </button>
    </div>

    <!-- 交互流程标注 -->
    <div class="flow-bar">
      <div class="flow-step">
        <span class="flow-num">01</span>
        <span class="flow-text">设备选择</span>
      </div>
      <div class="flow-arrow">›</div>
      <div class="flow-step">
        <span class="flow-num">02</span>
        <span class="flow-text">亮度调节</span>
      </div>
      <div class="flow-arrow">›</div>
      <div class="flow-step">
        <span class="flow-num">03</span>
        <span class="flow-text">模式切换</span>
      </div>
      <div class="flow-arrow">›</div>
      <div class="flow-step">
        <span class="flow-num">04</span>
        <span class="flow-text">效果预览</span>
      </div>
      <div class="flow-arrow">›</div>
      <div class="flow-step">
        <span class="flow-num">05</span>
        <span class="flow-text">能耗分析</span>
      </div>
      <div class="flow-arrow">›</div>
      <div class="flow-step">
        <span class="flow-num">06</span>
        <span class="flow-text">联动配置</span>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import * as echarts from 'echarts'
import { useFireStore } from '../stores/fireStore'
import { dataSource } from '../api'

const store = useFireStore()

// 选择状态
const selectedBuilding = ref('')
const selectedFloor = ref('')
const selectedDeviceId = ref('')

// 滑块亮度
const sliderBrightness = ref(60)

// 图表
const chartRef = ref(null)
let chart = null

// 照明模式 key 映射（store 使用 daily/induction/emergency，UI 使用 energy/sensor/emergency）
const UI_MODE_MAP = { energy: 'daily', sensor: 'induction', emergency: 'emergency' }
const STORE_MODE_MAP = { daily: 'energy', induction: 'sensor', emergency: 'emergency' }

const storeMode = (uiKey) => UI_MODE_MAP[uiKey] || uiKey
const uiMode = (storeKey) => STORE_MODE_MAP[storeKey] || storeKey

// 模式列表
const modeList = computed(() =>
  Object.values(store.lightingModes).map((m) => ({
    ...m,
    key: STORE_MODE_MAP[m.id] || m.id,
    label: m.name,
    color: m.color,
  }))
)

// 楼栋/楼层选项
const buildingOptions = computed(() => {
  const set = new Set(store.lightingDevices.map((d) => d.building))
  return [...set]
})

const floorOptions = computed(() => {
  if (!selectedBuilding.value) return []
  const set = new Set(
    store.lightingDevices
      .filter((d) => d.building === selectedBuilding.value)
      .map((d) => d.floor)
  )
  return [...set]
})

// 当前楼栋+楼层的照明设备（真实层级过滤，楼层切换时列表/数据联动）
const currentFloorLights = computed(() => {
  if (!selectedBuilding.value || !selectedFloor.value) return []
  return store.lightingDevices.filter(
    (d) => d.building === selectedBuilding.value && d.floor === selectedFloor.value
  )
})

// 楼层设备变化时默认选中第一个设备（楼栋/楼层切换后自动联动）
watch(currentFloorLights, (newList) => {
  if (newList.length > 0 && !newList.find((d) => d.id === selectedDeviceId.value)) {
    selectedDeviceId.value = newList[0].id
  }
})

// 当前设备（默认选中当前楼层第一个设备，禁止跨楼栋/楼层回退）
const currentDevice = computed(() => {
  if (!selectedDeviceId.value) return currentFloorLights.value[0] || null
  return store.lightingDevices.find((d) => d.id === selectedDeviceId.value) || null
})

// 将选中设备同步到照明聚合状态（楼层/设备切换后亮度、模式、人员检测联动）
// P1.7.3-B1：demo 模式下 lightingStatus / device 亮度与人员检测都属于后端业务状态，
// 本页只能消费（DemoWorld.lighting + DemoWorld.devices → WS → store → 本页），禁止反向写入
function applyDeviceToStatus(dev) {
  if (!dev) return
  sliderBrightness.value = dev.brightness ?? 60
  if (dataSource.isDemo) return
  if (store.lightingStatus) {
    store.lightingStatus.currentDevice = dev
    store.lightingStatus.brightness = dev.brightness ?? 60
    store.lightingStatus.mode = dev.currentMode || 'energy'
    store.lightingStatus.detectedPerson = !!dev.detectedPerson
  }
}

// 状态派生
const brightness = computed(() => {
  return store.lightingStatus?.brightness ?? currentDevice.value?.brightness ?? 60
})

const currentMode = computed(() => {
  const m = store.lightingStatus?.mode ?? 'energy'
  return STORE_MODE_MAP[m] || m || 'energy'
})

const personDetected = computed(() => {
  return store.lightingStatus?.detectedPerson ?? currentDevice.value?.detectedPerson ?? false
})

const ambientLabel = computed(() => {
  return store.lightingStatus?.status === 'offline' ? '设备离线' : '正常'
})

const energy = computed(() => store.lightingEnergy || { today: 0, month: 0, saved: 0, savedPercent: 0 })

const modeLabel = computed(() => {
  const m = modeList.value.find((x) => x.key === currentMode.value)
  return m ? m.label : '日常节能'
})

// 灯泡颜色与光效
const bulbColor = computed(() => {
  if (currentMode.value === 'emergency') return '#EF4444'
  if (currentMode.value === 'induction') return '#4CC9F0'
  return '#F59E0B'
})

const bulbFill = computed(() => {
  if (brightness.value < 10) return '#1B1F2A'
  return bulbColor.value
})

const glowOpacity = computed(() => {
  return 0.3 + (brightness.value / 100) * 0.7
})

/* ==================== 灯具布局数据 ==================== */
const lightLayout = computed(() => {
  const baseLights = [
    { id: 'L01', x: 60, y: 55, room: 'A' },
    { id: 'L02', x: 130, y: 55, room: 'A' },
    { id: 'L03', x: 250, y: 55, room: 'B' },
    { id: 'L04', x: 420, y: 55, room: '会议室' },
    { id: 'L05', x: 480, y: 55, room: '会议室' },
    { id: 'L06', x: 580, y: 55, room: '休息区' },
    { id: 'L07', x: 720, y: 55, room: '储物间' },
    { id: 'L08', x: 80, y: 320, room: '机房' },
    { id: 'L09', x: 160, y: 320, room: '机房' },
    { id: 'L10', x: 280, y: 320, room: '通道' },
    { id: 'L11', x: 470, y: 320, room: '配电' },
    { id: 'L12', x: 660, y: 320, room: '值班' },
    { id: 'L13', x: 740, y: 320, room: '值班' },
    { id: 'L14', x: 150, y: 200, room: '走廊' },
    { id: 'L15', x: 400, y: 200, room: '走廊' },
    { id: 'L16', x: 650, y: 200, room: '走廊' },
  ]
  // 根据模式和亮度设置每盏灯的状态
  return baseLights.map((l) => {
    let level = brightness.value
    if (currentMode.value === 'energy') {
      level = personDetected.value && l.room === '走廊' ? 60 : 30
    } else if (currentMode.value === 'sensor') {
      level = personDetected.value ? 85 : 20
    } else if (currentMode.value === 'emergency') {
      level = 100
    }
    return { ...l, level }
  })
})

function lightColor(light) {
  if (light.level < 10) return '#475569'
  if (currentMode.value === 'emergency') return '#EF4444'
  if (light.level > 70) return '#F59E0B'
  return '#F59E0B'
}
function lightStrokeColor(light) {
  if (light.level < 10) return 'rgba(26,58,90,0.5)'
  if (currentMode.value === 'emergency') return 'rgba(239,68,68,0.8)'
  if (light.level > 70) return 'rgba(255,215,0,0.8)'
  return 'rgba(245,158,11,0.8)'
}
function lightRadius(light) {
  return 20 + (light.level / 100) * 40
}
function lightOpacity(light) {
  return 0.3 + (light.level / 100) * 0.5
}
function lightGradient(light) {
  if (light.level < 10) return 'url(#light-dim)'
  if (currentMode.value === 'emergency') return 'url(#light-emergency)'
  if (light.level > 70) return 'url(#light-bright)'
  return 'url(#light-mid)'
}
function selectLight(light) {
  // 选中单灯逻辑（保留扩展）
}

// 事件处理
function onBuildingChange() {
  selectedFloor.value = ''
  selectedDeviceId.value = ''
}

function onFloorChange() {
  selectedDeviceId.value = ''
}

function onDeviceChange() {
  applyDeviceToStatus(currentDevice.value)
}

function handleModeChange(mode) {
  const storeMode = UI_MODE_MAP[mode] || mode
  store.switchLightingMode(storeMode)
  sliderBrightness.value = store.lightingStatus.brightness
}

function handleBrightnessChange(val) {
  if (dataSource.isDemo) {
    console.warn('[LightingView] demo 模式禁止本地调节亮度')
    return
  }
  store.lightingStatus.brightness = val
  if (currentDevice.value) {
    currentDevice.value.brightness = val
  }
  const now = new Date()
  const label = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
  store.brightnessHistory.time.push(label)
  store.brightnessHistory.values.push(val)
  if (store.brightnessHistory.time.length > 30) {
    store.brightnessHistory.time.shift()
    store.brightnessHistory.values.shift()
  }
  updateChart()
}

function handleSimulatePerson() {
  store.simulatePersonEnter()
  sliderBrightness.value = store.lightingStatus.brightness
  store.addNotification({
    title: '智能照明已增强',
    message: '检测到人员进入，照明亮度已自动提升至 85%',
    level: 'info',
    time: new Date().toLocaleTimeString('zh-CN'),
  })
  updateChart()
}

function handleEmergency() {
  store.switchLightingMode('emergency')
  sliderBrightness.value = 100
  store.addNotification({
    title: '消防应急照明已启动',
    message: '已进入消防应急照明状态，亮度已调至100%',
    level: 'warning',
    time: new Date().toLocaleTimeString('zh-CN'),
  })
  updateChart()
}

function handleReset() {
  if (dataSource.isDemo) {
    console.warn('[LightingView] demo 模式禁止本地复位照明状态')
    return
  }
  store.switchLightingMode('daily')
  sliderBrightness.value = 30
  store.lightingStatus.detectedPerson = false
  if (currentDevice.value) {
    currentDevice.value.detectedPerson = false
  }
  store.addNotification({
    title: '照明已恢复',
    message: '已恢复至日常节能模式',
    level: 'info',
    time: new Date().toLocaleTimeString('zh-CN'),
  })
  updateChart()
}

function statusLabel(status) {
  const labels = { online: '在线', offline: '离线', on: '在线' }
  return labels[status] || status
}

// ECharts
function initChart() {
  if (!chartRef.value) return
  chart = echarts.init(chartRef.value)
  updateChart()
}

function updateChart() {
  if (!chart) return
  const hist = store.brightnessHistory
  chart.setOption({
    tooltip: {
      trigger: 'axis',
      backgroundColor: 'rgba(13,19,32,0.9)',
      borderColor: '#1B1F2A',
      textStyle: { color: '#e2e8f0', fontSize: 12 },
    },
    grid: { left: '3%', right: '5%', bottom: '3%', top: '10%', containLabel: true },
    xAxis: {
      type: 'category',
      data: hist.time || [],
      axisLabel: { color: '#64748b', fontSize: 10 },
      axisLine: { lineStyle: { color: '#1B1F2A' } },
    },
    yAxis: {
      type: 'value',
      max: 100,
      axisLabel: { color: '#64748b', fontSize: 10, formatter: '{value}%' },
      splitLine: { lineStyle: { color: 'rgba(27,31,42,0.5)' } },
    },
    series: [
      {
        type: 'line',
        data: hist.values || [],
        smooth: true,
        symbol: 'circle',
        symbolSize: 5,
        lineStyle: { color: '#F59E0B', width: 2 },
        itemStyle: { color: '#F59E0B' },
        areaStyle: {
          color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
            { offset: 0, color: 'rgba(251,191,36,0.3)' },
            { offset: 1, color: 'rgba(251,191,36,0)' },
          ]),
        },
      },
    ],
  }, true)
}

function handleResize() {
  chart?.resize()
}

watch(currentDevice, (dev) => applyDeviceToStatus(dev))

onMounted(() => {
  if (store.lightingDevices.length > 0) {
    const first = store.lightingDevices[0]
    selectedBuilding.value = first.building
    selectedFloor.value = first.floor
    // 默认选中当前楼栋+楼层的第一个设备
    selectedDeviceId.value = currentFloorLights.value[0]?.id || first.id
  }
  applyDeviceToStatus(currentDevice.value)
  initChart()
  window.addEventListener('resize', handleResize)
})

onUnmounted(() => {
  window.removeEventListener('resize', handleResize)
  chart?.dispose()
})
</script>

<style scoped>
.lighting-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  gap: 8px;
  overflow: hidden;
}

/* ==================== 页面头部 ==================== */
.page-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 0 2px 0;
}
.header-bar {
  width: 2px;
  height: 36px;
  background: var(--fire-orange);

  border-radius: 1px;
  flex-shrink: 0;
}
.header-text {
  flex: 1;
}
.header-text h2 {
  font-size: 18px;
  color: var(--text-primary);
  font-weight: 600;
  line-height: 1.2;
}
.header-sub {
  font-size: 12px;
  color: var(--text-tertiary);
  margin-top: 2px;
}
.header-status {
  display: flex;
  gap: 6px;
}

/* ==================== 设备选择区 ==================== */
.device-selector {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  flex-wrap: wrap;
}
.selector-group {
  display: flex;
  align-items: center;
  gap: 6px;
}
.selector-label {
  font-size: 11px;
  color: var(--text-tertiary);
  letter-spacing: 1px;
}
.selector-divider {
  width: 1px;
  height: 20px;
  background: var(--fire-border);
}
.device-info {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
}
.info-text {
  font-size: 11px;
  color: var(--text-secondary);
}

/* ==================== 主体两栏 ==================== */
.main-content {
  flex: 1;
  display: grid;
  grid-template-columns: 1fr 300px;
  gap: 8px;
  min-height: 0;
}

/* ==================== 左侧 SVG 可视化 ==================== */
.left-col {
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
  padding: 10px;
}
.map-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
  flex-shrink: 0;
}
.col-section-title {
  font-size: 11px;
  color: var(--text-secondary);
  font-weight: 600;
  text-transform: uppercase;
}
.map-legend {
  display: flex;
  gap: 10px;
}
.legend-item {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 10px;
  color: var(--text-tertiary);
}
.legend-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
}
.svg-container {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  border: 1px solid rgba(245, 158, 11, 0.06);
  border-radius: 3px;
  background: var(--fire-dark);
}
.floor-svg {
  width: 100%;
  height: 100%;
}

/* SVG 样式 */
.room-l {
  fill: rgba(245, 158, 11, 0.03);
  stroke: rgba(245, 158, 11, 0.15);
  stroke-width: 1;
}
.room-label-l {
  fill: var(--text-tertiary);
  font-size: 10px;
  text-anchor: middle;
}
.corridor-l {
  fill: rgba(0, 0, 0, 0.2);
  stroke: rgba(245, 158, 11, 0.06);
  stroke-width: 1;
  stroke-dasharray: 4 4;
}
.corridor-label-l {
  fill: var(--text-tertiary);
  font-size: 10px;
  text-anchor: middle;
  opacity: 0.4;
}

/* 扫描线 */
.scan-line-l {
  animation: scanMoveL 5s linear infinite;
}
@keyframes scanMoveL {
  0% { transform: translateY(-60px); }
  100% { transform: translateY(420px); }
}

/* 灯具 */
.light-group {
  cursor: pointer;
  transition: opacity 0.2s;
}
.light-group:hover {
  opacity: 0.85;
}
.light-bulb {
  transition: all 0.3s;
  filter: drop-shadow(0 0 3px currentColor);
}
.light-label {
  fill: var(--text-tertiary);
  font-size: 8px;
  text-anchor: middle;
  pointer-events: none;
  font-family: 'DIN', 'Roboto Mono', monospace;
}

/* 模式水印 */
.mode-watermark {
  opacity: 0.9;
  pointer-events: none;
}

/* ==================== 右侧 ==================== */
.right-col {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 0;
  overflow: hidden;
}

/* 控制面板 */
.control-card {
  padding: 12px;
  flex-shrink: 0;
}

.brightness-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}
.brightness-display {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.brightness-value {
  font-size: 36px;
  font-weight: 700;
  line-height: 1;
}
.brightness-label {
  font-size: 11px;
  color: var(--text-tertiary);
  letter-spacing: 1px;
}
.bulb-visual {
  width: 70px;
  height: 84px;
  flex-shrink: 0;
}
.bulb-svg {
  width: 100%;
  height: 100%;
}

/* 状态行 */
.status-row {
  display: flex;
  gap: 16px;
  margin-bottom: 12px;
  padding: 8px 0;
  border-top: 1px solid var(--fire-border);
  border-bottom: 1px solid var(--fire-border);
}
.status-item {
  display: flex;
  align-items: center;
  gap: 4px;
}
.status-name {
  font-size: 11px;
  color: var(--text-tertiary);
}
.status-val {
  font-size: 11px;
  font-weight: 600;
}

/* 亮度滑块 */
.slider-section {
  margin-bottom: 12px;
}
.slider-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 6px;
}
.slider-label {
  font-size: 11px;
  color: var(--text-secondary);
}
.slider-val {
  font-size: 16px;
  font-weight: 700;
}

/* 模式选择 */
.mode-section {
  width: 100%;
}
.mode-label {
  font-size: 11px;
  color: var(--text-tertiary);
  margin-bottom: 6px;
  letter-spacing: 1px;
}
.mode-buttons {
  display: flex;
  gap: 6px;
}
.mode-btn {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 8px 4px;
  border-radius: 3px;
  border: 1px solid var(--fire-border);
  background: rgba(76, 201, 240, 0.03);
  color: var(--text-secondary);
  font-size: 11px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s;
}
.mode-btn:hover {
  border-color: rgba(76, 201, 240, 0.3);
  color: var(--text-primary);
}
.mode-btn.active {
  font-weight: 600;
}

/* 图表 */
.chart-card-l {
  padding: 10px;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.chart-title-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}
.chart-area {
  flex: 1;
  min-height: 120px;
}

/* 能耗统计 */
.energy-card-l {
  padding: 10px;
  flex-shrink: 0;
}
.energy-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 6px;
}
.energy-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 8px 4px;
  background: rgba(76, 201, 240, 0.03);
  border-radius: 3px;
  border: 1px solid var(--fire-border);
}
.energy-value {
  font-size: 20px;
  font-weight: 700;
  line-height: 1;
}
.energy-unit {
  font-size: 10px;
  color: var(--text-tertiary);
  margin-top: 2px;
}
.energy-label {
  font-size: 10px;
  color: var(--text-tertiary);
  margin-top: 2px;
}

/* 底部操作 */
.bottom-actions {
  display: flex;
  gap: 8px;
  justify-content: center;
  flex-shrink: 0;
}
.action-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 16px;
  border-radius: 3px;
  border: 1px solid var(--fire-border);
  background: rgba(76, 201, 240, 0.04);
  color: var(--text-secondary);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s;
}
.action-btn.sensor {
  border-color: rgba(76, 201, 240, 0.2);
  background: rgba(76, 201, 240, 0.05);
  color: var(--fire-cyan);
}
.action-btn.sensor:hover {
  background: rgba(76, 201, 240, 0.12);
  border-color: rgba(76, 201, 240, 0.4);
  box-shadow: 0 2px 8px rgba(76, 201, 240, 0.12);
}
.action-btn.emergency {
  border-color: rgba(239, 68, 68, 0.2);
  background: rgba(239, 68, 68, 0.05);
  color: var(--fire-red);
}
.action-btn.emergency:hover {
  background: rgba(239, 68, 68, 0.12);
  border-color: rgba(239, 68, 68, 0.4);
  box-shadow: 0 2px 8px rgba(239, 68, 68, 0.14);
}
.action-btn.reset {
  border-color: rgba(34, 197, 94, 0.2);
  background: rgba(34, 197, 94, 0.05);
  color: var(--fire-green);
}
.action-btn.reset:hover {
  background: rgba(34, 197, 94, 0.12);
  border-color: rgba(34, 197, 94, 0.4);
  box-shadow: 0 2px 8px rgba(34, 197, 94, 0.14);
}

/* ==================== 交互流程标注 ==================== */
.flow-bar {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 6px 0;
  background: rgba(10, 25, 45, 0.5);
  border: 1px solid var(--fire-border);
  border-radius: 3px;
  flex-shrink: 0;
}
.flow-step {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 8px;
}
.flow-num {
  font-family: 'DIN', 'Roboto Mono', monospace;
  font-size: 10px;
  color: var(--fire-orange);
  font-weight: 700;
  letter-spacing: 1px;
}
.flow-text {
  font-size: 11px;
  color: var(--text-secondary);
  letter-spacing: 1px;
}
.flow-arrow {
  font-size: 14px;
  color: var(--text-tertiary);
  opacity: 0.5;
}

/* 文字颜色工具 */
.text-cyan { color: var(--fire-cyan); }
.text-gray { color: var(--text-tertiary); }
.text-green { color: var(--fire-green); }
.text-blue { color: var(--fire-blue); }
.text-orange { color: var(--fire-orange); }

/* 响应式 */
@media (max-width: 1366px) {
  .main-content {
    grid-template-columns: 1fr 260px;
  }
}
</style>

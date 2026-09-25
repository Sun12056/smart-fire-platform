<template>
  <div class="building-view">
    <!-- Page Header -->
    <div class="page-header">
      <div class="header-bar"></div>
      <div class="header-text">
        <h2 class="title-spacing">楼宇消防态势</h2>
        <p class="header-sub">实时监测各建筑消防设备运行状态</p>
      </div>
    </div>

    <div class="building-content">
      <!-- 左侧：楼栋列表 + 楼层选择（与 3D 数字孪生共享 Pinia 状态） -->
      <div class="building-list fire-card">
        <div class="panel-title-bar">
          <svg class="panel-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M3 21V7l9-4 9 4v14" />
            <path d="M9 21v-6h6v6" />
            <line x1="3" y1="21" x2="21" y2="21" />
          </svg>
          <span class="panel-title title-spacing-sm">楼栋列表</span>
          <span class="panel-count num-font">{{ store.buildings.length }}</span>
        </div>
        <div class="list-body">
          <div
            v-for="bld in store.buildings"
            :key="bld.id"
            class="building-item"
            :class="{ active: selectedBld?.id === bld.id, warning: bld.status === 'warning' }"
            @click="selectBuilding(bld)"
          >
            <div class="bld-left-bar"></div>
            <div class="bld-main">
              <div class="bld-top">
                <span class="bld-name">{{ bld.name }}</span>
                <span class="bld-type">{{ bld.type }}</span>
              </div>
              <div class="bld-bottom">
                <span class="bld-devices num-font">{{ bld.deviceCount }}</span>
                <span class="bld-unit">台设备</span>
                <span class="bld-sep">|</span>
                <span v-if="bld.abnormal > 0" class="bld-abnormal num-font">{{ bld.abnormal }}</span>
                <span v-if="bld.abnormal > 0" class="bld-abnormal-label">异常</span>
                <span v-else class="bld-normal-label">全部正常</span>
              </div>
            </div>
            <div class="bld-right">
              <span class="status-tag" :class="bld.status === 'warning' ? 'red' : 'green'">
                {{ bld.status === 'warning' ? '告警' : '正常' }}
              </span>
            </div>
          </div>
        </div>

        <!-- 楼层快速选择（6F~1F） -->
        <div class="floor-select">
          <div class="fs-head">
            <span class="fs-title title-spacing-sm">楼层选择</span>
            <span class="fs-sub">点击楼层 / 区域联动 3D</span>
          </div>
          <div class="fs-grid">
            <button
              v-for="fl in floorData"
              :key="fl.floor"
              class="fs-btn"
              :class="{ active: selectedFloorId === fl.floor, abnormal: fl.abnormal > 0 }"
              @click="selectFloor(fl)"
            >
              <span class="fs-num num-font">{{ fl.floor }}</span>
              <span v-if="fl.abnormal > 0" class="fs-badge">{{ fl.abnormal }}</span>
            </button>
          </div>
        </div>
      </div>

      <!-- 中间：3D 数字孪生楼宇 -->
      <div class="floor-view fire-card">
        <div class="panel-title-bar" v-if="selectedBld">
          <svg class="panel-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <rect x="4" y="3" width="16" height="18" rx="1" />
            <line x1="9" y1="3" x2="9" y2="21" />
            <line x1="15" y1="3" x2="15" y2="21" />
            <line x1="4" y1="9" x2="20" y2="9" />
            <line x1="4" y1="15" x2="20" y2="15" />
          </svg>
          <span class="panel-title title-spacing-sm">{{ selectedBld.name }} 楼宇数字孪生</span>
          <div class="panel-info">
            <div class="info-block">
              <span class="info-label">楼层</span>
              <span class="info-value num-font">{{ selectedBld.floors }}</span>
            </div>
            <div class="info-divider"></div>
            <div class="info-block">
              <span class="info-label">设备</span>
              <span class="info-value num-font">{{ selectedBld.deviceCount }}</span>
            </div>
            <div class="info-divider"></div>
            <div class="info-block">
              <span class="info-label">巡检率</span>
              <span class="info-value num-font" :class="{ 'text-orange': selectedBld.patrolRate < 95 }">{{ selectedBld.patrolRate }}%</span>
            </div>
          </div>
        </div>
        <div class="panel-title-bar" v-else>
          <span class="panel-title title-spacing-sm">请选择楼栋查看详情</span>
        </div>

        <div class="twin-wrap" v-if="selectedBld">
          <BuildingDigitalTwin />
        </div>
        <div class="twin-status" v-if="selectedBld">
          <div class="ts-block">
            <span class="ts-label">当前楼层</span>
            <span class="ts-value num-font">{{ selectedFloorId || '总览' }}</span>
          </div>
          <div class="ts-div"></div>
          <div class="ts-block">
            <span class="ts-label">当前区域</span>
            <span class="ts-value num-font">{{ selectedZoneId || '—' }}</span>
          </div>
          <div class="ts-div"></div>
          <div class="ts-block">
            <span class="ts-label">区域人员</span>
            <span class="ts-value num-font" :class="{ 'text-orange': statusPersonsInZone > 0 }">{{ statusPersonsInZone }}</span>
          </div>
          <div class="ts-div"></div>
          <div class="ts-block">
            <span class="ts-label">本层设备</span>
            <span class="ts-value num-font">{{ statusDevices }}</span>
          </div>
          <div class="ts-div"></div>
          <div class="ts-block">
            <span class="ts-label">火情</span>
            <span class="ts-value" :class="statusFire ? 'text-red' : 'text-green'">
              {{ statusFire ? statusFire.area + ' 火灾' : '正常' }}
            </span>
          </div>
        </div>
        <div class="floor-list-empty" v-else>
          <svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="1" opacity="0.2" width="48" height="48">
            <rect x="10" y="8" width="44" height="48" rx="2" />
            <line x1="22" y1="8" x2="22" y2="56" />
            <line x1="42" y1="8" x2="42" y2="56" />
            <line x1="10" y1="24" x2="54" y2="24" />
            <line x1="10" y1="40" x2="54" y2="40" />
          </svg>
          <span class="empty-text">选择左侧楼栋查看楼层信息</span>
        </div>
      </div>

      <!-- 右侧：楼层 / 区域详情（设备清单 + 平面图） -->
      <div class="floor-detail-panel fire-card" v-if="selectedFloorObj">
        <div class="panel-title-bar">
          <svg class="panel-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <rect x="3" y="3" width="18" height="18" rx="1" />
            <line x1="3" y1="9" x2="21" y2="9" />
            <line x1="3" y1="15" x2="21" y2="15" />
            <line x1="9" y1="3" x2="9" y2="21" />
            <line x1="15" y1="3" x2="15" y2="21" />
          </svg>
          <span class="panel-title title-spacing-sm">{{ selectedBld.name }} {{ selectedFloorObj.floor }} 平面图</span>
          <button class="close-btn" @click="store.selectFloor(null)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div class="floor-plan-area">
          <svg viewBox="0 0 400 300" class="plan-svg">
            <!-- 双层网格背景 -->
            <defs>
              <pattern id="grid-fine" width="10" height="10" patternUnits="userSpaceOnUse">
                <path d="M 10 0 L 0 0 0 10" fill="none" stroke="rgba(76,201,240,0.04)" stroke-width="0.5"/>
              </pattern>
              <pattern id="grid-coarse" width="40" height="40" patternUnits="userSpaceOnUse">
                <path d="M 40 0 L 0 0 0 40" fill="none" stroke="rgba(76,201,240,0.08)" stroke-width="0.5"/>
              </pattern>
              <radialGradient id="device-glow-green">
                <stop offset="0%" stop-color="#22C55E" stop-opacity="0.6"/>
                <stop offset="100%" stop-color="#22C55E" stop-opacity="0"/>
              </radialGradient>
              <radialGradient id="device-glow-red">
                <stop offset="0%" stop-color="#EF4444" stop-opacity="0.6"/>
                <stop offset="100%" stop-color="#EF4444" stop-opacity="0"/>
              </radialGradient>
              <radialGradient id="device-glow-gray">
                <stop offset="0%" stop-color="#475569" stop-opacity="0.4"/>
                <stop offset="100%" stop-color="#475569" stop-opacity="0"/>
              </radialGradient>
            </defs>
            <rect width="400" height="300" fill="url(#grid-fine)" />
            <rect width="400" height="300" fill="url(#grid-coarse)" />

            <!-- 走廊 -->
            <rect x="50" y="130" width="300" height="40" fill="rgba(76,201,240,0.03)" stroke="rgba(76,201,240,0.15)" stroke-width="1"/>
            <text x="200" y="155" fill="rgba(76,201,240,0.25)" font-size="9" text-anchor="middle" letter-spacing="2">走廊</text>

            <!-- 房间 -->
            <rect x="50" y="40" width="90" height="80" rx="1" fill="rgba(76,201,240,0.02)" stroke="rgba(76,201,240,0.12)" stroke-width="1"/>
            <text x="95" y="85" fill="#475569" font-size="9" text-anchor="middle">办公室 01</text>

            <rect x="150" y="40" width="90" height="80" rx="1" fill="rgba(76,201,240,0.02)" stroke="rgba(76,201,240,0.12)" stroke-width="1"/>
            <text x="195" y="85" fill="#475569" font-size="9" text-anchor="middle">办公室 02</text>

            <rect x="250" y="40" width="100" height="80" rx="1" fill="rgba(76,201,240,0.02)" stroke="rgba(76,201,240,0.12)" stroke-width="1"/>
            <text x="300" y="85" fill="#475569" font-size="9" text-anchor="middle">会议室</text>

            <rect x="50" y="180" width="90" height="80" rx="1" fill="rgba(76,201,240,0.02)" stroke="rgba(76,201,240,0.12)" stroke-width="1"/>
            <text x="95" y="225" fill="#475569" font-size="9" text-anchor="middle">办公室 03</text>

            <rect x="150" y="180" width="90" height="80" rx="1" fill="rgba(76,201,240,0.02)" stroke="rgba(76,201,240,0.12)" stroke-width="1"/>
            <text x="195" y="225" fill="#475569" font-size="9" text-anchor="middle">办公室 04</text>

            <rect x="250" y="180" width="100" height="80" rx="1" fill="rgba(76,201,240,0.02)" stroke="rgba(76,201,240,0.12)" stroke-width="1"/>
            <text x="300" y="225" fill="#475569" font-size="9" text-anchor="middle">设备间</text>

            <!-- 安全出口 -->
            <g>
              <rect x="345" y="140" width="20" height="20" fill="rgba(34,197,94,0.1)" stroke="#22C55E" stroke-width="1"/>
              <text x="355" y="154" fill="#22C55E" font-size="7" text-anchor="middle">出口</text>
            </g>
            <g>
              <rect x="35" y="140" width="20" height="20" fill="rgba(34,197,94,0.1)" stroke="#22C55E" stroke-width="1"/>
              <text x="45" y="154" fill="#22C55E" font-size="7" text-anchor="middle">出口</text>
            </g>

            <!-- 楼梯 -->
            <g>
              <rect x="345" y="40" width="20" height="20" fill="rgba(71,85,105,0.08)" stroke="#475569" stroke-width="1" stroke-dasharray="2,2"/>
              <text x="355" y="55" fill="#475569" font-size="6" text-anchor="middle">楼梯</text>
            </g>
            <g>
              <rect x="35" y="260" width="20" height="20" fill="rgba(71,85,105,0.08)" stroke="#475569" stroke-width="1" stroke-dasharray="2,2"/>
              <text x="45" y="275" fill="#475569" font-size="6" text-anchor="middle">楼梯</text>
            </g>

            <!-- 设备点位 -->
            <g v-for="(dev, idx) in currentFloorDevices" :key="dev.id" @click="showDevice(dev)" class="plan-device" :class="dev.status">
              <circle :cx="getDeviceX(idx)" :cy="getDeviceY(idx)" :r="12" :fill="`url(#device-glow-${dev.status === 'abnormal' ? 'red' : dev.status === 'offline' ? 'gray' : 'green'})`" :class="{ 'alarm-pulse': dev.status === 'abnormal' }"/>
              <circle :cx="getDeviceX(idx)" :cy="getDeviceY(idx)" :r="5" :fill="getDeviceColor(dev.status)" :class="{ 'alarm-breathe': dev.status === 'abnormal', 'offline-dot': dev.status === 'offline' }"/>
              <circle :cx="getDeviceX(idx)" :cy="getDeviceY(idx)" :r="7" fill="none" :stroke="getDeviceColor(dev.status)" stroke-width="1" opacity="0.4"/>
              <text :x="getDeviceX(idx)" :y="getDeviceY(idx) - 11" :fill="getDeviceColor(dev.status)" font-size="7" text-anchor="middle" font-weight="600">{{ getDeviceLabel(dev.type) }}</text>
            </g>
          </svg>
        </div>

        <!-- 设备列表 -->
        <div class="floor-device-list">
          <div class="list-title-bar">
            <span class="list-title title-spacing-sm">设备清单</span>
            <span class="list-count num-font">{{ currentFloorDevices.length }}</span>
          </div>
          <div class="device-rows">
            <div
              v-for="dev in currentFloorDevices"
              :key="dev.id"
              class="device-row"
              :class="dev.status"
              @click="showDevice(dev)"
            >
              <span class="dev-id num-font">{{ dev.id }}</span>
              <span class="dev-name">{{ dev.name }}</span>
              <span class="dev-type-tag">{{ dev.type }}</span>
              <span class="status-tag" :class="dev.status === 'normal' ? 'green' : dev.status === 'abnormal' ? 'red' : 'cyan'">
                {{ statusLabel(dev.status) }}
              </span>
            </div>
          </div>
        </div>

        <!-- 设备详情弹出 -->
        <div class="device-popup" v-if="popupDevice">
          <div class="popup-header">
            <div class="popup-title-row">
              <svg class="popup-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <circle cx="12" cy="12" r="3" />
                <circle cx="12" cy="12" r="8" stroke-dasharray="2,2" />
              </svg>
              <span class="popup-title-text">{{ popupDevice.name }}</span>
              <span class="status-tag" :class="popupDevice.status === 'normal' ? 'green' : popupDevice.status === 'abnormal' ? 'red' : 'cyan'">
                {{ statusLabel(popupDevice.status) }}
              </span>
            </div>
            <button class="popup-close" @click="popupDevice = null">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
          <div class="popup-body">
            <div class="popup-grid">
              <div class="popup-row">
                <span class="popup-label">设备编号</span>
                <span class="popup-value num-font">{{ popupDevice.id }}</span>
              </div>
              <div class="popup-row">
                <span class="popup-label">设备类型</span>
                <span class="popup-value">{{ popupDevice.type }}</span>
              </div>
              <div class="popup-row">
                <span class="popup-label">电量</span>
                <span class="popup-value num-font">{{ popupDevice.battery }}%</span>
              </div>
              <div class="popup-row">
                <span class="popup-label">温度</span>
                <span class="popup-value num-font">{{ popupDevice.temperature }}℃</span>
              </div>
              <div class="popup-row">
                <span class="popup-label">通信状态</span>
                <span class="popup-value" :class="popupDevice.communication === 'online' ? 'text-green' : 'text-tertiary-c'">
                  {{ popupDevice.communication === 'online' ? '在线' : '离线' }}
                </span>
              </div>
              <div class="popup-row">
                <span class="popup-label">最后上报</span>
                <span class="popup-value">{{ popupDevice.lastReport }}</span>
              </div>
            </div>
          </div>
          <div class="popup-actions">
            <button class="popup-btn" @click="handleSelfCheck(popupDevice)">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="12" height="12">
                <path d="M21 12a9 9 0 11-6.219-8.56" />
                <polyline points="21 4 21 10 15 10" />
              </svg>
              远程自检
            </button>
            <button class="popup-btn popup-btn-warn" @click="goToAlarm(popupDevice)">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="12" height="12">
                <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
                <line x1="12" y1="9" x2="12" y2="13" />
                <line x1="12" y1="17" x2="12.01" y2="17" />
              </svg>
              查看告警
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- 底部交互流程标注 -->
    <div class="flow-bar fire-card">
      <div class="flow-step">
        <span class="flow-num num-font">01</span>
        <span class="flow-text">楼栋选择</span>
      </div>
      <div class="flow-arrow">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" width="14" height="14">
          <line x1="5" y1="12" x2="19" y2="12" />
          <polyline points="12 5 19 12 12 19" />
        </svg>
      </div>
      <div class="flow-step">
        <span class="flow-num num-font">02</span>
        <span class="flow-text">楼层查看</span>
      </div>
      <div class="flow-arrow">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" width="14" height="14">
          <line x1="5" y1="12" x2="19" y2="12" />
          <polyline points="12 5 19 12 12 19" />
        </svg>
      </div>
      <div class="flow-step">
        <span class="flow-num num-font">03</span>
        <span class="flow-text">设备点位</span>
      </div>
      <div class="flow-arrow">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" width="14" height="14">
          <line x1="5" y1="12" x2="19" y2="12" />
          <polyline points="12 5 19 12 12 19" />
        </svg>
      </div>
      <div class="flow-step">
        <span class="flow-num num-font">04</span>
        <span class="flow-text">详情弹窗</span>
      </div>
      <div class="flow-arrow">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" width="14" height="14">
          <line x1="5" y1="12" x2="19" y2="12" />
          <polyline points="12 5 19 12 12 19" />
        </svg>
      </div>
      <div class="flow-step">
        <span class="flow-num num-font">05</span>
        <span class="flow-text">状态排查</span>
      </div>
      <div class="flow-arrow">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" width="14" height="14">
          <line x1="5" y1="12" x2="19" y2="12" />
          <polyline points="12 5 19 12 12 19" />
        </svg>
      </div>
      <div class="flow-step">
        <span class="flow-num num-font">06</span>
        <span class="flow-text">告警处理</span>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useFireStore } from '../stores/fireStore'
import BuildingDigitalTwin from '../components/BuildingDigitalTwin.vue'

const store = useFireStore()
const router = useRouter()

const selectedBld = ref(store.selectedBuilding || store.buildings[0])
const popupDevice = ref(null)

// 与 3D 数字孪生共享的选中状态（统一来自 Pinia，不维护独立副本）
const selectedFloorId = computed(() => store.dashboardView.selectedFloorId)
const selectedFloorObj = computed(() => {
  if (!selectedFloorId.value) return null
  return (
    floorData.value.find((f) => f.floor === selectedFloorId.value) || {
      floor: selectedFloorId.value,
      total: 0,
      normal: 0,
      abnormal: 0,
    }
  )
})
const selectedZoneId = computed(() => store.dashboardView.selectedZone)

// 底部状态栏
const statusPersonsInZone = computed(() => {
  const b = selectedBld.value ? selectedBld.value.name : null
  return (store.persons || []).filter(
    (p) => p.building === b && p.floor === selectedFloorId.value && (p.zone || p.area) === selectedZoneId.value
  ).length
})
const statusDevices = computed(() => {
  const b = selectedBld.value ? selectedBld.value.name : null
  if (!selectedFloorId.value) return 0
  return (store.devices || []).filter((d) => d.building === b && d.floor === selectedFloorId.value).length
})
const statusFire = computed(() => {
  const fe = store.fireEvent
  const b = selectedBld.value ? selectedBld.value.name : null
  return fe && fe.building === b ? fe : null
})

// 楼层列表数据：从 store.devices 实时聚合，每楼层设备数不同
const floorData = computed(() => {
  if (!selectedBld.value) return []
  const bName = selectedBld.value.name
  const devs = (store.devices || []).filter((d) => d.building === bName)
  const floorMap = {}
  devs.forEach((d) => {
    if (!floorMap[d.floor]) {
      floorMap[d.floor] = { floor: d.floor, total: 0, normal: 0, abnormal: 0 }
    }
    floorMap[d.floor].total++
    if (d.status === 'warning' || d.status === 'emergency' || d.status === 'fault') {
      floorMap[d.floor].abnormal++
    } else if (d.status === 'normal') {
      floorMap[d.floor].normal++
    }
  })
  return Object.values(floorMap).reverse()
})

// 当前选中楼层的设备：用于 SVG 点位和设备列表
const currentFloorDevices = computed(() => {
  if (!selectedFloorId.value || !selectedBld.value) return []
  return (store.devices || []).filter(
    (d) => d.building === selectedBld.value.name && d.floor === selectedFloorId.value
  )
})

function selectBuilding(bld) {
  selectedBld.value = bld
  store.selectBuilding(bld)
  store.selectFloor(null)
  store.selectZone('A区')
  popupDevice.value = null
}

function selectFloor(floor) {
  store.selectFloor(floor.floor)
  popupDevice.value = null
}

function showDevice(dev) {
  popupDevice.value = dev
}

function getDeviceX(idx) {
  const positions = [90, 195, 300, 90, 195, 300, 140, 250]
  return positions[idx % positions.length]
}

function getDeviceY(idx) {
  const positions = [70, 70, 70, 210, 210, 210, 150, 150]
  return positions[idx % positions.length]
}

function getDeviceColor(status) {
  if (status === 'abnormal') return '#EF4444'
  if (status === 'offline') return '#475569'
  return '#22C55E'
}

function getDeviceLabel(type) {
  const labels = {
    '应急照明灯': '灯',
    '烟感探测器': '烟',
    '温感探测器': '温',
    '声光报警器': '警',
    '消防栓': '栓',
    '喷淋头': '淋',
  }
  return labels[type] || '设'
}

function statusLabel(status) {
  const labels = { normal: '正常', abnormal: '异常', offline: '离线' }
  return labels[status] || status
}

function handleSelfCheck(dev) {
  store.addNotification({
    title: '自检指令已下发',
    message: `${dev.name} 远程自检已启动`,
    level: 'info',
    time: new Date().toLocaleTimeString('zh-CN'),
  })
  popupDevice.value = null
}

function goToAlarm(dev) {
  router.push('/alarms')
}

onMounted(() => {
  if (!store.selectedBuilding && store.buildings.length) {
    store.selectBuilding(store.buildings[0])
  }
  if (!selectedBld.value) selectedBld.value = store.selectedBuilding || store.buildings[0]
})
</script>

<style scoped>
/* ========== Page Header ========== */
.page-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 0 4px 0;
}

.header-bar {
  width: 2px;
  height: 28px;
  background: var(--fire-blue);
  border-radius: 1px;
  flex-shrink: 0;
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

/* ========== Layout ========== */
.building-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  gap: 10px;
}

.building-content {
  flex: 1;
  display: grid;
  grid-template-columns: 260px 1fr 400px;
  gap: 10px;
  min-height: 0;
}

/* ========== Panel Title Bar ========== */
.panel-title-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--fire-border);
  flex-shrink: 0;
}

.panel-icon {
  width: 14px;
  height: 14px;
  color: var(--fire-cyan);
  flex-shrink: 0;
}

.panel-title {
  font-size: 13px;
  color: var(--text-primary);
  font-weight: 500;
  flex: 1;
}

.panel-count {
  font-size: 12px;
  color: var(--text-tertiary);
  background: rgba(76, 201, 240, 0.06);
  padding: 1px 8px;
  border-radius: 2px;
}

.panel-info {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-left: auto;
}

.info-block {
  display: flex;
  align-items: baseline;
  gap: 3px;
}

.info-label {
  font-size: 10px;
  color: var(--text-tertiary);
}

.info-value {
  font-size: 13px;
  color: var(--text-primary);
  font-weight: 600;
}

.info-divider {
  width: 1px;
  height: 10px;
  background: var(--fire-border);
}

.close-btn {
  background: none;
  border: none;
  color: var(--text-tertiary);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 2px;
  border-radius: 2px;
  transition: all 0.2s;
}

.close-btn:hover {
  color: var(--fire-red);
  background: rgba(239, 68, 68, 0.08);
}

/* ========== Building List ========== */
.building-list {
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.list-body {
  flex: 1;
  overflow-y: auto;
  padding: 6px;
  min-height: 0;
}

.building-item {
  display: flex;
  align-items: center;
  height: 48px;
  cursor: pointer;
  transition: all 0.2s;
  margin-bottom: 4px;
  border-radius: 3px;
  background: rgba(76, 201, 240, 0.02);
  border: 1px solid transparent;
  position: relative;
  overflow: hidden;
}

.building-item:hover {
  background: rgba(76, 201, 240, 0.05);
  border-color: var(--fire-border);
}

.bld-left-bar {
  width: 2px;
  height: 100%;
  background: transparent;
  transition: all 0.2s;
  flex-shrink: 0;
}

.building-item.active .bld-left-bar {
  background: var(--fire-cyan);
  box-shadow: 0 0 6px var(--fire-cyan);
}

.building-item.active {
  background: rgba(76, 201, 240, 0.06);
  border-color: rgba(76, 201, 240, 0.2);
}

.building-item.warning .bld-left-bar {
  background: var(--fire-red);
  animation: warningPulse 1.5s ease-in-out infinite;
}

@keyframes warningPulse {
  0%, 100% { box-shadow: 0 0 6px var(--fire-red); }
  50% { box-shadow: 0 0 10px rgba(239, 68, 68, 0.35); }
}

.bld-main {
  flex: 1;
  padding: 0 10px;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 2px;
  min-width: 0;
}

.bld-top {
  display: flex;
  align-items: center;
  gap: 6px;
}

.bld-name {
  font-size: 13px;
  color: var(--text-primary);
  font-weight: 600;
}

.bld-type {
  font-size: 10px;
  color: var(--text-tertiary);
  padding: 0 4px;
  background: rgba(76, 201, 240, 0.04);
  border-radius: 1px;
}

.bld-bottom {
  display: flex;
  align-items: baseline;
  gap: 3px;
  font-size: 11px;
  color: var(--text-tertiary);
}

.bld-devices {
  font-size: 13px;
  color: var(--text-secondary);
  font-weight: 600;
}

.bld-unit {
  font-size: 10px;
  color: var(--text-tertiary);
}

.bld-sep {
  color: rgba(71, 85, 105, 0.5);
  margin: 0 2px;
}

.bld-abnormal {
  color: var(--fire-red);
  font-weight: 600;
  font-size: 12px;
}

.bld-abnormal-label {
  color: var(--fire-red);
  font-size: 10px;
}

.bld-normal-label {
  color: var(--fire-green);
  font-size: 10px;
}

.bld-right {
  padding-right: 10px;
  flex-shrink: 0;
}

/* ========== Floor Select (left footer) ========== */
.floor-select {
  flex-shrink: 0;
  border-top: 1px solid var(--fire-border);
  padding: 8px 10px 10px;
  background: rgba(8, 21, 37, 0.4);
}

.fs-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: 6px;
}

.fs-title {
  font-size: 12px;
  color: var(--text-primary);
}

.fs-sub {
  font-size: 9px;
  color: var(--text-tertiary);
}

.fs-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 5px;
}

.fs-btn {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  height: 30px;
  border-radius: 3px;
  border: 1px solid rgba(76, 201, 240, 0.14);
  background: rgba(76, 201, 240, 0.03);
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.2s;
}

.fs-btn:hover {
  border-color: var(--fire-cyan);
  color: var(--fire-cyan);
  background: rgba(76, 201, 240, 0.08);
}

.fs-btn.active {
  background: rgba(76, 201, 240, 0.12);
  border-color: var(--fire-cyan);
  color: var(--fire-cyan);
  box-shadow: 0 0 7px rgba(76, 201, 240, 0.25);
}

.fs-btn.abnormal {
  border-color: rgba(239, 68, 68, 0.3);
}

.fs-btn.abnormal .fs-num {
  color: var(--fire-red);
}

.fs-num {
  font-size: 12px;
  font-weight: 600;
}

.fs-badge {
  position: absolute;
  top: -4px;
  right: -4px;
  min-width: 14px;
  height: 14px;
  padding: 0 3px;
  border-radius: 7px;
  background: var(--fire-red);
  color: #fff;
  font-size: 9px;
  line-height: 14px;
  text-align: center;
}

/* ========== 3D Twin (center) ========== */
.floor-view {
  display: flex;
  flex-direction: column;
}

.twin-wrap {
  flex: 1;
  min-height: 0;
  position: relative;
}

.twin-status {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 14px;
  border-top: 1px solid var(--fire-border);
  background: rgba(8, 21, 37, 0.5);
}

.ts-block {
  display: flex;
  align-items: baseline;
  gap: 6px;
}

.ts-label {
  font-size: 10px;
  color: var(--text-tertiary);
}

.ts-value {
  font-size: 14px;
  color: var(--text-primary);
  font-weight: 600;
}

.ts-div {
  width: 1px;
  height: 14px;
  background: var(--fire-border);
}

.floor-list-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  color: var(--text-tertiary);
}

.empty-text {
  font-size: 12px;
  color: var(--text-tertiary);
}

/* ========== Floor Detail Panel ========== */
.floor-detail-panel {
  display: flex;
  flex-direction: column;
}

.floor-plan-area {
  padding: 14px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-bottom: 1px solid var(--fire-border);
}

.plan-svg {
  width: 100%;
  max-width: 380px;
  height: auto;
}

.plan-device {
  cursor: pointer;
  transition: all 0.2s;
}

.plan-device:hover circle:nth-child(2) {
  r: 7;
}

.alarm-breathe {
  animation: alarmBreathe 1.2s ease-in-out infinite;
}

@keyframes alarmBreathe {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
}

.alarm-pulse {
  animation: alarmPulseRing 2s ease-out infinite;
  transform-origin: center;
  transform-box: fill-box;
}

@keyframes alarmPulseRing {
  0% { opacity: 0.6; }
  100% { opacity: 0; }
}

.offline-dot {
  opacity: 0.4;
}

/* ========== Floor Device List ========== */
.floor-device-list {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.list-title-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 14px;
  border-bottom: 1px solid var(--fire-border);
}

.list-title {
  font-size: 12px;
  color: var(--text-secondary);
  flex: 1;
}

.list-count {
  font-size: 11px;
  color: var(--fire-cyan);
  background: rgba(76, 201, 240, 0.06);
  padding: 1px 6px;
  border-radius: 2px;
}

.device-rows {
  flex: 1;
  overflow-y: auto;
  padding: 4px 6px;
}

.device-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  margin-bottom: 3px;
  border-radius: 2px;
  cursor: pointer;
  transition: all 0.2s;
  background: rgba(76, 201, 240, 0.02);
  border-left: 2px solid transparent;
}

.device-row:hover {
  background: rgba(76, 201, 240, 0.06);
  border-left-color: var(--fire-cyan);
}

.device-row.abnormal {
  background: rgba(239, 68, 68, 0.04);
  border-left-color: var(--fire-red);
}

.device-row.offline {
  opacity: 0.6;
}

.dev-id {
  font-size: 11px;
  color: var(--fire-cyan);
  width: 60px;
  flex-shrink: 0;
}

.dev-name {
  font-size: 12px;
  color: var(--text-primary);
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dev-type-tag {
  font-size: 10px;
  color: var(--text-tertiary);
  padding: 1px 5px;
  background: rgba(76, 201, 240, 0.04);
  border-radius: 1px;
  flex-shrink: 0;
}

/* ========== Device Popup ========== */
.device-popup {
  margin: 10px;
  padding: 12px;
  border-radius: 3px;
  background: rgba(8, 21, 37, 0.9);
  border: 1px solid var(--fire-border-hover);
}

.popup-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 10px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--fire-border);
}

.popup-title-row {
  display: flex;
  align-items: center;
  gap: 6px;
}

.popup-icon {
  width: 14px;
  height: 14px;
  color: var(--fire-cyan);
}

.popup-title-text {
  font-size: 13px;
  font-weight: 600;
  color: var(--fire-cyan);
}

.popup-close {
  background: none;
  border: none;
  color: var(--text-tertiary);
  cursor: pointer;
  display: flex;
  align-items: center;
  padding: 2px;
  border-radius: 2px;
}

.popup-close:hover {
  color: var(--fire-red);
}

.popup-body {
  margin-bottom: 10px;
}

.popup-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
}

.popup-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 5px 8px;
  background: rgba(76, 201, 240, 0.03);
  border-radius: 2px;
}

.popup-label {
  font-size: 11px;
  color: var(--text-tertiary);
}

.popup-value {
  font-size: 12px;
  color: var(--text-primary);
  font-weight: 500;
}

.popup-actions {
  display: flex;
  gap: 6px;
}

.popup-btn {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 7px 10px;
  border-radius: 2px;
  border: 1px solid var(--fire-border);
  background: rgba(76, 201, 240, 0.04);
  color: var(--text-secondary);
  font-size: 11px;
  cursor: pointer;
  transition: all 0.2s;
}

.popup-btn:hover {
  border-color: var(--fire-cyan);
  color: var(--fire-cyan);
  background: rgba(76, 201, 240, 0.08);
}

.popup-btn-warn:hover {
  border-color: var(--fire-orange);
  color: var(--fire-orange);
  background: rgba(245, 158, 11, 0.08);
}

/* ========== Flow Bar ========== */
.flow-bar {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 8px 16px;
  flex-shrink: 0;
}

.flow-step {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 3px 10px;
  background: rgba(76, 201, 240, 0.04);
  border: 1px solid var(--fire-border);
  border-radius: 2px;
}

.flow-num {
  font-size: 11px;
  color: var(--fire-cyan);
  font-weight: 700;
}

.flow-text {
  font-size: 11px;
  color: var(--text-secondary);
  letter-spacing: 1px;
}

.flow-arrow {
  color: var(--text-tertiary);
  display: flex;
  align-items: center;
  opacity: 0.5;
}

/* ========== Text Colors ========== */
.text-orange { color: var(--fire-orange); }
.text-green { color: var(--fire-green); }
.text-red { color: var(--fire-red); }
</style>

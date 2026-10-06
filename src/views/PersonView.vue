<template>
  <div class="person-view">
    <!-- 页面头部 -->
    <div class="page-header">
      <div class="header-bar"></div>
      <div class="header-text">
        <h2 class="title-spacing">消防生命感知中心</h2>
        <p class="header-sub">毫米波雷达实时人员定位与生命体征监测</p>
      </div>
      <div class="header-status">
        <span class="status-tag cyan">雷达在线</span>
        <span class="status-tag green">系统正常</span>
      </div>
    </div>

    <!-- 统计卡片行 -->
    <div class="stat-row">
      <div class="mini-stat fire-card">
        <div class="mini-stat-bar" style="background: var(--fire-blue); "></div>
        <div class="mini-stat-body">
          <span class="mini-stat-value num-font glow-text-sm" style="color: var(--fire-blue);">{{ currentFloorStats.total }}</span>
          <span class="mini-stat-label">实时人员</span>
        </div>
        <svg class="mini-stat-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="color: var(--fire-blue);">
          <circle cx="12" cy="8" r="4"/><path d="M4 22c0-4 4-6 8-6s8 2 8 6"/>
        </svg>
      </div>
      <div class="mini-stat fire-card">
        <div class="mini-stat-bar" style="background: var(--fire-cyan); "></div>
        <div class="mini-stat-body">
          <span class="mini-stat-value num-font glow-text-sm" style="color: var(--fire-cyan);">{{ currentFloorStats.active }}</span>
          <span class="mini-stat-label">活动目标</span>
        </div>
        <svg class="mini-stat-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="color: var(--fire-cyan);">
          <circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="8" stroke-dasharray="4 3"/>
        </svg>
      </div>
      <div class="mini-stat fire-card">
        <div class="mini-stat-bar" style="background: var(--fire-orange); "></div>
        <div class="mini-stat-body">
          <span class="mini-stat-value num-font glow-text-sm" style="color: var(--fire-orange);">{{ currentFloorStats.risk }}</span>
          <span class="mini-stat-label">风险区域</span>
        </div>
        <svg class="mini-stat-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="color: var(--fire-orange);">
          <path d="M12 2L2 22h20L12 2z"/><line x1="12" y1="9" x2="12" y2="15"/><circle cx="12" cy="18" r="1" fill="currentColor"/>
        </svg>
      </div>
      <div class="mini-stat fire-card">
        <div class="mini-stat-bar" style="background: var(--fire-green); "></div>
        <div class="mini-stat-body">
          <span class="mini-stat-value num-font glow-text-sm" style="color: var(--fire-green);">{{ currentFloorStats.sensors }}</span>
          <span class="mini-stat-label">感知节点</span>
        </div>
        <svg class="mini-stat-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="color: var(--fire-green);">
          <circle cx="12" cy="12" r="2" fill="currentColor"/><circle cx="12" cy="12" r="6" stroke-dasharray="3 2"/><circle cx="12" cy="12" r="10" stroke-dasharray="2 3" opacity="0.5"/>
        </svg>
      </div>
    </div>

    <!-- 主体三栏 -->
    <div class="main-content">
      <!-- 左侧：楼层选择 + 区域列表 -->
      <div class="left-col">
        <!-- 楼层选择器 -->
        <div class="fire-card floor-selector-card">
          <div class="col-section-title title-spacing-sm">楼层选择</div>
          <div class="floor-list">
            <button
              v-for="fo in floorOptions"
              :key="fo.floor"
              class="floor-btn"
              :class="{ active: fo.floor === selectedFloor }"
              @click="onFloorSelect(fo.floor)"
            >
              <span class="floor-btn-text">{{ fo.floor }}</span>
              <span
                class="floor-btn-count num-font"
                style="font-size: 11px;"
                :style="fo.count > 0 ? { color: 'var(--fire-cyan)', fontWeight: 600 } : { color: 'var(--text-tertiary)', opacity: 0.6 }"
              >{{ fo.count }}<span style="font-size: 9px; margin-left: 1px;">人</span></span>
            </button>
          </div>
          <div class="building-select-row">
            <el-select v-model="selectedBuildingName" placeholder="选择楼栋" style="width: 100%" @change="onBuildingChange" size="small">
              <el-option v-for="b in buildingOptions" :key="b" :label="b" :value="b" />
            </el-select>
          </div>
        </div>

        <!-- 区域列表 -->
        <div class="fire-card zone-list-card">
          <div class="col-section-title title-spacing-sm">区域监测</div>
          <div class="zone-list">
            <div
              v-for="zone in heatmapData"
              :key="zone.name"
              class="zone-item"
            >
              <div class="zone-name">{{ zone.name }}</div>
              <div class="zone-meta">
                <span class="zone-count num-font" :class="zone.count > 2 ? 'zone-hot' : zone.count > 0 ? 'zone-warm' : 'zone-cold'">{{ zone.count }}</span>
                <span class="status-tag" :class="zone.count > 2 ? 'red' : zone.count > 0 ? 'cyan' : 'green'">
                  {{ zone.count > 2 ? '密集' : zone.count > 0 ? '有人' : '空闲' }}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- 中间：SVG 楼层平面图 -->
      <div class="center-col fire-card">
        <div class="map-header">
          <div class="map-title-row">
            <span class="col-section-title title-spacing-sm">{{ selectedBuildingName }} · {{ selectedFloor }} 平面图</span>
            <span class="info-badge">{{ currentFloorPersons.length }} 人在区域</span>
          </div>
          <div class="map-legend">
            <span class="legend-item"><span class="legend-dot" style="background: var(--fire-blue); box-shadow: 0 0 6px var(--fire-blue);"></span>正常</span>
            <span class="legend-item"><span class="legend-dot" style="background: var(--fire-red); box-shadow: 0 0 6px var(--fire-red);"></span>异常</span>
            <span class="legend-item"><span class="legend-dot" style="background: var(--fire-green);"></span>出口</span>
            <span class="legend-item"><span class="legend-dot" style="background: var(--fire-orange);"></span>楼梯</span>
          </div>
        </div>

        <div class="svg-container">
          <svg viewBox="0 0 800 420" class="floor-svg" @click="selectedPerson = null">
            <defs>
              <!-- 网格 pattern -->
              <pattern id="grid-fine" width="20" height="20" patternUnits="userSpaceOnUse">
                <path d="M 20 0 L 0 0 0 20" fill="none" stroke="rgba(76,201,240,0.04)" stroke-width="0.5"/>
              </pattern>
              <pattern id="grid-bold" width="80" height="80" patternUnits="userSpaceOnUse">
                <rect width="80" height="80" fill="url(#grid-fine)"/>
                <path d="M 80 0 L 0 0 0 80" fill="none" stroke="rgba(76,201,240,0.08)" stroke-width="1"/>
              </pattern>
              <!-- 扫描线渐变 -->
              <linearGradient id="scan-grad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stop-color="rgba(76,201,240,0)"/>
                <stop offset="50%" stop-color="rgba(76,201,240,0.12)"/>
                <stop offset="100%" stop-color="rgba(76,201,240,0)"/>
              </linearGradient>
              <!-- 人员光晕 -->
              <radialGradient id="person-glow-blue" cx="50%" cy="50%" r="50%">
                <stop offset="0%" stop-color="rgba(76,201,240,0.4)"/>
                <stop offset="100%" stop-color="rgba(76,201,240,0)"/>
              </radialGradient>
              <radialGradient id="person-glow-red" cx="50%" cy="50%" r="50%">
                <stop offset="0%" stop-color="rgba(239,68,68,0.4)"/>
                <stop offset="100%" stop-color="rgba(239,68,68,0)"/>
              </radialGradient>
              <!-- 风险区域渐变 -->
              <radialGradient id="risk-grad" cx="50%" cy="50%" r="50%">
                <stop offset="0%" stop-color="rgba(239,68,68,0.25)"/>
                <stop offset="100%" stop-color="rgba(239,68,68,0.05)"/>
              </radialGradient>
            </defs>

            <!-- 双层网格背景 -->
            <rect width="800" height="420" fill="url(#grid-bold)"/>

            <!-- 扫描线动画 -->
            <rect x="0" y="0" width="800" height="60" fill="url(#scan-grad)" class="scan-line"/>

            <!-- 房间区域（按楼栋类型动态布局） -->
            <g class="rooms">
              <template v-for="z in currentLayout.zones" :key="z.name">
                <rect
                  :x="z.x" :y="z.y" :width="z.w" :height="z.h" rx="2"
                  :class="z.kind === 'corridor' ? 'corridor' : 'room'"
                />
                <text
                  :x="z.x + z.w / 2" :y="z.y + z.h / 2 + 4"
                  :class="z.kind === 'corridor' ? 'corridor-label' : 'room-label'"
                >{{ z.name }}</text>
              </template>
            </g>

            <!-- 楼梯 -->
            <g class="stairs">
              <rect x="690" y="140" width="50" height="50" rx="2" class="stair"/>
              <line x1="695" y1="148" x2="735" y2="148" class="stair-line"/>
              <line x1="695" y1="158" x2="735" y2="158" class="stair-line"/>
              <line x1="695" y1="168" x2="735" y2="168" class="stair-line"/>
              <line x1="695" y1="178" x2="735" y2="178" class="stair-line"/>
              <text x="715" y="195" class="stair-label">楼梯</text>
            </g>

            <!-- 安全出口 -->
            <g class="exits">
              <g transform="translate(30, 140)">
                <rect x="-4" y="-4" width="28" height="20" rx="2" class="exit"/>
                <path d="M 2 6 L 10 6 M 7 3 L 10 6 L 7 9" stroke="#22C55E" stroke-width="1.5" fill="none"/>
                <text x="10" y="14" class="exit-label">出口</text>
              </g>
              <g transform="translate(740, 260)">
                <rect x="-4" y="-4" width="28" height="20" rx="2" class="exit"/>
                <path d="M 2 6 L 10 6 M 7 3 L 10 6 L 7 9" stroke="#22C55E" stroke-width="1.5" fill="none"/>
                <text x="10" y="14" class="exit-label">出口</text>
              </g>
            </g>

            <!-- 风险区域 -->
            <g v-for="zone in currentFloorRiskZones" :key="zone.id">
              <rect
                :x="zone.x" :y="zone.y" :width="zone.w" :height="zone.h"
                rx="2"
                fill="url(#risk-grad)"
                :style="{ opacity: zone.flash ? 0.6 : 0.3 }"
                class="risk-zone-rect"
              />
              <rect
                :x="zone.x" :y="zone.y" :width="zone.w" :height="zone.h"
                rx="2"
                fill="none"
                stroke="var(--fire-red)"
                stroke-width="1.5"
                stroke-dasharray="6 3"
                class="risk-zone-border"
              />
              <text :x="zone.x + zone.w / 2" :y="zone.y + zone.h / 2 + 5" class="risk-label">{{ zone.name }}</text>
            </g>

            <!-- 人员目标点 -->
            <g class="persons">
              <g
                v-for="person in currentFloorPersons"
                :key="person.id"
                @click.stop="onPersonClick(person)"
                class="person-group"
              >
                <!-- 光晕 -->
                <circle
                  :cx="person.x" :cy="person.y" r="12"
                  :fill="person.isAbnormal ? 'url(#person-glow-red)' : 'url(#person-glow-blue)'"
                />
                <!-- 异常人员脉冲圈 -->
                <circle
                  v-if="person.isAbnormal"
                  :cx="person.x" :cy="person.y" r="6"
                  fill="none" stroke="var(--fire-red)" stroke-width="1.5"
                  class="pulse-ring"
                />
                <!-- 人员圆点 -->
                <circle
                  :cx="person.x" :cy="person.y" r="4"
                  :class="person.isAbnormal ? 'person-abnormal' : 'person-normal'"
                />
                <text :x="person.x" :y="person.y - 10" class="person-label">{{ person.id }}</text>
              </g>
            </g>
          </svg>
        </div>

        <!-- 人员详情面板（内嵌） -->
        <transition name="slide-fade">
          <div v-if="selectedPerson" class="person-detail-panel">
            <div class="panel-header">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color: var(--fire-cyan);">
                <circle cx="12" cy="8" r="4"/><path d="M4 22c0-4 4-6 8-6s8 2 8 6"/>
              </svg>
              <span>目标详情 · {{ selectedPerson.id }}</span>
              <button class="close-btn" @click="selectedPerson = null">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>
              </button>
            </div>
            <div class="panel-body">
              <div class="detail-row">
                <span class="detail-key">目标编号</span>
                <span class="detail-val num-font">{{ selectedPerson.id }}</span>
              </div>
              <div class="detail-row">
                <span class="detail-key">检测状态</span>
                <span class="detail-val" :class="selectedPerson.isAbnormal ? 'text-red' : 'text-green'">
                  {{ selectedPerson.isAbnormal ? '异常' : '正常' }}
                </span>
              </div>
              <div class="detail-row">
                <span class="detail-key">距离</span>
                <span class="detail-val num-font">{{ selectedPerson.distance }} m</span>
              </div>
              <div class="detail-row">
                <span class="detail-key">方向</span>
                <span class="detail-val">{{ selectedPerson.direction }}</span>
              </div>
              <div class="detail-row">
                <span class="detail-key">速度</span>
                <span class="detail-val num-font">{{ selectedPerson.speed }} m/s</span>
              </div>
              <div class="detail-row">
                <span class="detail-key">更新时间</span>
                <span class="detail-val num-font">{{ selectedPerson.updateTime }}</span>
              </div>
            </div>
          </div>
        </transition>

        <!-- 底部操作按钮 -->
        <div class="map-actions">
          <button class="demo-btn" @click="handleSimulatePerson">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="8" r="4"/><path d="M4 22c0-4 4-6 8-6s8 2 8 6"/><line x1="18" y1="4" x2="18" y2="10"/><line x1="15" y1="7" x2="21" y2="7"/></svg>
            <span>模拟人员进入</span>
          </button>
          <button class="demo-btn danger" @click="handleSimulateRisk">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 2L2 22h20L12 2z"/><line x1="12" y1="9" x2="12" y2="15"/><circle cx="12" cy="18" r="1" fill="currentColor"/></svg>
            <span>模拟风险区域</span>
          </button>
          <button class="demo-btn" @click="handleReset">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><polyline points="3 3 3 8 8 8"/></svg>
            <span>重置场景</span>
          </button>
        </div>
      </div>

      <!-- 右侧：趋势图 + 热力图 -->
      <div class="right-col">
        <!-- 人数趋势图 -->
        <div class="fire-card chart-card">
          <div class="chart-title-row">
            <span class="col-section-title title-spacing-sm">{{ selectedBuildingName }} · {{ selectedFloor }} 人数趋势</span>
            <span class="status-tag cyan">实时</span>
          </div>
          <div ref="trendChartRef" class="chart-box"></div>
        </div>

        <!-- 区域密度热力图 -->
        <div class="fire-card chart-card">
          <div class="chart-title-row">
            <span class="col-section-title title-spacing-sm">区域密度热力图</span>
          </div>
          <div class="heatmap-grid">
            <div
              v-for="zone in heatmapData"
              :key="zone.name"
              class="heatmap-cell"
              :style="heatmapStyle(zone.density)"
              :title="`${zone.name}: ${zone.count}人`"
            >
              <span class="heatmap-name">{{ zone.name }}</span>
              <span class="heatmap-count num-font">{{ zone.count }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 交互流程标注 -->
    <div class="flow-bar">
      <div class="flow-step">
        <span class="flow-num">01</span>
        <span class="flow-text">楼层选择</span>
      </div>
      <div class="flow-arrow">›</div>
      <div class="flow-step">
        <span class="flow-num">02</span>
        <span class="flow-text">区域查看</span>
      </div>
      <div class="flow-arrow">›</div>
      <div class="flow-step">
        <span class="flow-num">03</span>
        <span class="flow-text">人员点击</span>
      </div>
      <div class="flow-arrow">›</div>
      <div class="flow-step">
        <span class="flow-num">04</span>
        <span class="flow-text">详情分析</span>
      </div>
      <div class="flow-arrow">›</div>
      <div class="flow-step">
        <span class="flow-num">05</span>
        <span class="flow-text">风险评估</span>
      </div>
      <div class="flow-arrow">›</div>
      <div class="flow-step">
        <span class="flow-num">06</span>
        <span class="flow-text">告警联动</span>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue'
import * as echarts from 'echarts'
import { useFireStore } from '../stores/fireStore'
// P1.6.1：本视图是「人员感知平面图」，房间矩形是本页自己的展示版式（viewBox 800×420），
// 而人员权威坐标来自后端 / mock 的平面图坐标空间（floorPlanData: 560×300）。
// 因此这里做的是与 3D svgToStand 同性质的「视图坐标变换」——只读统一字段 position，
// 绝不重算路线、进度或速度，也不回写 store。
import { SVG_W as PLAN_W, SVG_H as PLAN_H } from '../mock/floorPlanData.js'
// P1.7.3-B3：楼层 / 区域 / 楼栋判定统一走 canonical helper
import {
  positionOf, BUILDING_NAME_TO_ID, buildingIdOf, floorIdOf, zoneOf,
} from '../../shared/person/personRuntime.js'

const store = useFireStore()

/* ==================== 楼栋 / 楼层选择 ==================== */
const buildingOptions = ['1号楼', '2号楼', '3号楼', '4号楼']
const selectedBuildingName = ref('3号楼')
const selectedFloor = ref('5F')

const allFloors = ['1F', '2F', '3F', '4F', '5F', '6F']
const FLOOR_MAP = {
  '1号楼': ['1F', '2F', '3F'],
  '2号楼': ['1F', '2F', '3F', '4F'],
  '3号楼': allFloors,
  '4号楼': ['1F', '2F', '3F', '4F', '5F'],
}

// 楼栋 → 平面布局类型（决定 SVG 房间与热力区域）
const BUILDING_TYPES = { '1号楼': 'office', '2号楼': 'office', '3号楼': 'lab', '4号楼': 'complex' }

// 各类型楼栋固定区域（SVG viewBox 800x420 坐标）
const FLOOR_LAYOUTS = {
  // 办公类（1/2号楼）
  office: {
    zones: [
      { name: '办公室A', x: 20, y: 20, w: 240, h: 100 },
      { name: '办公室B', x: 270, y: 20, w: 240, h: 100 },
      { name: '会议室', x: 520, y: 20, w: 260, h: 100 },
      { name: '走廊', x: 20, y: 140, w: 760, h: 120, kind: 'corridor' },
      { name: '储物间', x: 20, y: 280, w: 365, h: 100 },
      { name: '设备间', x: 395, y: 280, w: 365, h: 100 },
    ],
  },
  // 实验楼（3号楼）
  lab: {
    zones: [
      { name: '实验室A', x: 20, y: 20, w: 240, h: 100 },
      { name: '实验室B', x: 270, y: 20, w: 240, h: 100 },
      { name: '实验室C', x: 520, y: 20, w: 260, h: 100 },
      { name: '走廊', x: 20, y: 140, w: 760, h: 120, kind: 'corridor' },
      { name: '准备间', x: 20, y: 280, w: 365, h: 100 },
      { name: '仪器室', x: 395, y: 280, w: 365, h: 100 },
    ],
  },
  // 综合楼（4号楼）
  complex: {
    zones: [
      { name: '营业厅', x: 20, y: 20, w: 370, h: 100 },
      { name: '会议室', x: 400, y: 20, w: 360, h: 100 },
      { name: '走廊', x: 20, y: 140, w: 760, h: 120, kind: 'corridor' },
      { name: '办公区', x: 20, y: 280, w: 370, h: 100 },
      { name: '后勤区', x: 400, y: 280, w: 360, h: 100 },
    ],
  },
}

// 雷达区域旧命名（mock 数据 zone）→ 当前平面布局命名
const ZONE_ALIASES = {
  office: { 'A区': '办公室A', 'B区': '办公室B', 'C区': '会议室' },
  lab: { 'A区': '实验室A', 'B区': '实验室B', 'C区': '实验室C', '实验室': '实验室B' },
  complex: { 'A区': '办公区', 'B区': '会议室', 'C区': '后勤区', '大厅': '营业厅' },
}

function currentLayoutType() {
  return BUILDING_TYPES[selectedBuildingName.value] || 'office'
}

function layoutZonesOf(type) {
  return (FLOOR_LAYOUTS[type] || FLOOR_LAYOUTS.office).zones
}

// 任意 zone 标记 → 当前布局内的固定区域名（无法识别则落到首个非走廊区域）
function resolveZoneName(token, type) {
  const zones = layoutZonesOf(type)
  if (token && zones.some((z) => z.name === token)) return token
  const aliases = ZONE_ALIASES[type] || ZONE_ALIASES.office
  const target = token && aliases[token]
  if (target && zones.some((z) => z.name === target)) return target
  const fallback = zones.find((z) => z.kind !== 'corridor')
  return fallback ? fallback.name : zones[0].name
}

/**
 * 平面图权威坐标 → 本视图展示坐标（只读 view 变换，单向）
 *   后端 / mock 的人员坐标统一走 personRuntime.positionOf()（position || x/y 别名），
 *   再按平面图坐标系整体等比缩放到本页房间版式区域 —— 与 3D 的 svgToStand 是同一类变换，
 *   ⚠️ 不做任何「第二次位置推导」：不算路线、不算速度、不回写 store。
 */
const VIEW_BAND = { x: 20, y: 20, w: 760, h: 380 }
function projectToView(p) {
  const pos = positionOf(p)
  if (!pos) return null
  const nx = Math.min(1, Math.max(0, pos.x / PLAN_W))
  const ny = Math.min(1, Math.max(0, pos.y / PLAN_H))
  return {
    x: Math.round(VIEW_BAND.x + nx * VIEW_BAND.w),
    y: Math.round(VIEW_BAND.y + ny * VIEW_BAND.h),
  }
}

/**
 * 楼栋判定（P1.7.3-B3）：canonical buildingId 唯一权威，
 * 旧别名 building（中文名）只在 buildingId 缺失时兜底；冲突时以 canonical 为准。
 */
function inBuilding(p, buildingName, buildingId) {
  const pid = buildingIdOf(p)
  if (pid) return String(pid) === String(buildingId || BUILDING_NAME_TO_ID[buildingName] || '')
  return String(p.building || '') === String(buildingName)
}

// 楼层按钮列表（含每楼层实时人数标签）
// P1.6.1：按统一字段 buildingId / floorId 统计
const floorOptions = computed(() => {
  const building = selectedBuildingName.value
  const buildingId = BUILDING_NAME_TO_ID[building] || ''
  const floors = FLOOR_MAP[building] || allFloors
  const list = Array.isArray(store.persons) ? store.persons : []
  return floors.map((floor) => ({
    floor,
    count: list.filter((p) => p && inBuilding(p, building, buildingId) && floorIdOf(p) === String(floor)).length,
  }))
})

// 当前楼栋类型对应的布局（SVG 房间 / 热力区域共用）
const currentLayout = computed(() => FLOOR_LAYOUTS[currentLayoutType()] || FLOOR_LAYOUTS.office)

function onBuildingChange() {
  if (!floorOptions.value.some((fo) => fo.floor === selectedFloor.value)) {
    selectedFloor.value = floorOptions.value.length ? floorOptions.value[0].floor : '1F'
  }
  selectedPerson.value = null
}

function onFloorSelect(floor) {
  selectedFloor.value = floor
  selectedPerson.value = null
}

/* ==================== 当前楼层人员（按楼栋+楼层过滤并投影到平面图） ==================== */
// P1.6.1：过滤一律用统一字段 buildingId / floorId / zone（旧别名 building / floor / area 仅兼容回退）
const currentFloorPersons = computed(() => {
  const type = currentLayoutType()
  const building = selectedBuildingName.value
  const buildingId = BUILDING_NAME_TO_ID[building] || ''
  const floor = selectedFloor.value
  const zones = layoutZonesOf(type)
  const list = Array.isArray(store.persons) ? store.persons : []
  const out = []
  for (const p of list) {
    if (!p || !inBuilding(p, building, buildingId)) continue
    if (floorIdOf(p) !== String(floor)) continue
    const zname = resolveZoneName(zoneOf(p), type)
    const zone = zones.find((z) => z.name === zname)
    if (!zone) continue
    const pos = projectToView(p)
    if (!pos) continue
    out.push({
      ...p,
      x: pos.x,
      y: pos.y,
      zoneName: zname,
      isAbnormal: p.status === 'warning' || p.status === 'abnormal',
    })
  }
  return out
})

/* ==================== 当前楼层统计（每楼层独立） ==================== */
const currentFloorStats = computed(() => {
  const ps = currentFloorPersons.value
  // P1.7.3-B3：设备归属按 canonical（buildingId / floorId）
  const bid = BUILDING_NAME_TO_ID[selectedBuildingName.value] || ''
  const sensors = (Array.isArray(store.devices) ? store.devices : []).filter(
    (d) => d && buildingIdOf(d) === bid && floorIdOf(d) === String(selectedFloor.value) && d.type === 'radar_sensor'
  ).length
  return {
    total: ps.length,
    active: ps.filter((p) => p.movementType === 'moving').length,
    risk: ps.filter((p) => p.status === 'warning').length,
    sensors,
  }
})

/* ==================== 当前楼层风险区域（映射为平面图矩形） ==================== */
const currentFloorRiskZones = computed(() => {
  const type = currentLayoutType()
  const zones = layoutZonesOf(type)
  const building = selectedBuildingName.value
  const floor = selectedFloor.value
  const risks = Array.isArray(store.riskAreas) ? store.riskAreas : []
  const out = []
  const seen = new Set()
  const bid = BUILDING_NAME_TO_ID[building] || ''
  for (const r of risks) {
    // P1.7.3-B3：风险区域 canonical 优先（riskAreas 已带 buildingId / floorId），别名仅兜底
    if (!r) continue
    if (r.buildingId || r.floorId) {
      if (String(r.buildingId || '') !== bid || String(r.floorId || '') !== String(floor)) continue
    } else if (r.building !== building || r.floor !== floor) continue
    const zname = resolveZoneName(r.zone, type)
    if (!zname || seen.has(zname)) continue
    const zone = zones.find((z) => z.name === zname)
    if (!zone) continue
    seen.add(zname)
    out.push({ id: r.id, name: zone.name, x: zone.x, y: zone.y, w: zone.w, h: zone.h, flash: r.level === 'high' })
  }
  return out
})

/* ==================== 人员详情 ==================== */
const selectedPerson = ref(null)

function onPersonClick(person) {
  selectedPerson.value = person
}

/* ==================== ECharts 人数变化曲线 ==================== */
const trendChartRef = ref(null)
let trendChart = null

// 每楼层独立趋势：以当前楼层实时人数为曲线量级基准，按楼栋/楼层哈希差异化形态
const currentFloorTrend = computed(() => {
  const base = store.personTrend && typeof store.personTrend === 'object' ? store.personTrend : {}
  const hours = Array.isArray(base.hours) && base.hours.length
    ? base.hours
    : ['00:00', '02:00', '04:00', '06:00', '08:00', '10:00', '12:00', '14:00', '16:00', '18:00', '20:00', '22:00', '24:00']
  const shape = Array.isArray(base.values) && base.values.length ? base.values : hours.map((_, i) => i + 1)
  const peakShape = Math.max(1, ...shape)
  const live = currentFloorPersons.value.length
  // 楼层专属种子：同一楼栋同一楼层每次渲染一致，不同楼层曲线互不相同
  const key = `${selectedBuildingName.value}|${selectedFloor.value}`
  let seed = 0
  for (let i = 0; i < key.length; i++) seed = (seed * 31 + key.charCodeAt(i)) % 100000
  const floorNum = parseInt(selectedFloor.value, 10) || 1
  const heightFactor = Math.max(0.4, 1.3 - floorNum * 0.1) // 楼层越高历史活动相对越少
  const variance = 0.8 + (seed % 41) / 100 // 0.80 ~ 1.20 层间波动
  const values = shape.map((v, i) => {
    const profile = v / peakShape
    const jitter = (seed >> (i % 5)) & 1 ? 1 : 0
    if (live > 0) {
      // 有人的楼层：峰值时段高度 ≈ 该楼层当前人数
      return Math.max(0, Math.round(profile * live * variance * heightFactor + jitter))
    }
    // 空楼层：低幅独立形态，直观体现"当前楼层无人"
    return Math.max(0, Math.round(profile * 3 * variance * heightFactor + jitter))
  })
  return { hours: [...hours], values }
})

function initTrendChart() {
  if (!trendChartRef.value) return
  trendChart = echarts.init(trendChartRef.value)
  renderTrendChart()
}

function renderTrendChart() {
  if (!trendChart) return
  const data = currentFloorTrend.value
  trendChart.setOption({
    tooltip: {
      trigger: 'axis',
      backgroundColor: 'rgba(13,19,32,0.9)',
      borderColor: '#1B1F2A',
      textStyle: { color: '#e2e8f0', fontSize: 12 },
    },
    grid: { left: '8%', right: '5%', bottom: '8%', top: '12%', containLabel: true },
    xAxis: {
      type: 'category',
      data: data.hours,
      axisLabel: { color: '#64748b', fontSize: 9, interval: 2 },
      axisLine: { lineStyle: { color: '#1B1F2A' } },
    },
    yAxis: {
      type: 'value',
      axisLabel: { color: '#64748b', fontSize: 10 },
      splitLine: { lineStyle: { color: 'rgba(27,31,42,0.5)' } },
    },
    series: [
      {
        name: '人数',
        type: 'line',
        data: data.values,
        smooth: true,
        symbol: 'circle',
        symbolSize: 5,
        lineStyle: { color: '#4361EE', width: 2 },
        itemStyle: { color: '#4361EE' },
        areaStyle: {
          color: 'rgba(67,97,238,0.12)',
        },
      },
    ],
  }, true)
}

/* ==================== 区域热力图（当前楼层固定区域 x/y 落入计数） ==================== */
const heatmapData = computed(() => {
  const pps = currentFloorPersons.value
  return currentLayout.value.zones.map((z) => {
    const count = pps.filter((p) => p.x >= z.x && p.x <= z.x + z.w && p.y >= z.y && p.y <= z.y + z.h).length
    return { name: z.name, count, density: count / 5 }
  })
})

function heatmapStyle(density) {
  const d = Math.min(1, density)
  if (d > 0.6) {
    return {
      background: `rgba(239, 68, 68, ${0.2 + d * 0.35})`,
      borderColor: 'rgba(239, 68, 68, 0.5)',
    }
  } else if (d > 0.3) {
    return {
      background: `rgba(245, 158, 11, ${0.15 + d * 0.25})`,
      borderColor: 'rgba(245, 158, 11, 0.4)',
    }
  } else {
    return {
      background: `rgba(76, 201, 240, ${0.1 + d * 0.2})`,
      borderColor: 'rgba(76, 201, 240, 0.25)',
    }
  }
}

/* ==================== 演示操作 ==================== */
function handleSimulatePerson() {
  const names = ['陈八', '周九', '吴十', '郑十一', '王十二']
  const departments = ['研发部', '运营部', '安保部', '行政部', '财务部']
  const roomZones = currentLayout.value.zones.filter((z) => z.kind !== 'corridor')
  const targetZone = roomZones[Math.floor(Math.random() * roomZones.length)]
  const building = selectedBuildingName.value
  const floor = selectedFloor.value
  const isMoving = Math.random() > 0.3
  const person = {
    id: `P${String((Array.isArray(store.persons) ? store.persons.length : 0) + 1).padStart(3, '0')}`,
    name: names[Math.floor(Math.random() * names.length)],
    department: departments[Math.floor(Math.random() * departments.length)],
    building,
    floor,
    zone: targetZone ? targetZone.name : 'A区',
    x: 20 + Math.random() * 60,
    y: 20 + Math.random() * 60,
    enterTime: new Date().toLocaleString('zh-CN'),
    detectedAt: new Date().toLocaleString('zh-CN'),
    status: 'normal',
    movementType: isMoving ? 'moving' : 'static',
    speed: isMoving ? +(0.5 + Math.random() * 2).toFixed(2) : 0,
    direction: isMoving ? Math.floor(Math.random() * 360) : 0,
    distance: isMoving ? +(1 + Math.random() * 6).toFixed(1) : 0,
  }
  store.persons.push(person)
  store.refreshPersonStats()
  store.addNotification({
    title: '人员进入',
    message: `${person.name}（${person.department}）进入${building}${floor}${targetZone ? targetZone.name : ''}`,
    level: 'info',
    time: new Date().toLocaleTimeString('zh-CN'),
  })
}

function handleSimulateRisk() {
  const roomZones = currentLayout.value.zones.filter((z) => z.kind !== 'corridor')
  // 优先在"当前楼层有人"的区域触发风险，其次随机区域
  const occupied = [...new Set(currentFloorPersons.value.map((p) => p.zoneName).filter(Boolean))]
    .map((name) => roomZones.find((z) => z.name === name))
    .filter(Boolean)
  const pool = occupied.length ? occupied : roomZones
  const target = pool[Math.floor(Math.random() * pool.length)]
  if (!target) return
  // 该区域人员同步标记为风险（风险统计按 warning 人数，点位同步变红）
  currentFloorPersons.value
    .filter((p) => p.zoneName === target.name)
    .forEach((p) => {
      const origin = (Array.isArray(store.persons) ? store.persons : []).find((o) => o && o.id === p.id)
      if (origin) origin.status = 'warning'
    })
  store.simulateRisk(selectedBuildingName.value, selectedFloor.value, target.name)
}

function handleReset() {
  selectedPerson.value = null
  store.resetDemoState()
}

/* ==================== 生命周期 ==================== */
function handleResize() {
  trendChart?.resize()
}

onMounted(() => {
  store.refreshPersonStats()
  nextTick(() => {
    initTrendChart()
  })
  window.addEventListener('resize', handleResize)
})

onUnmounted(() => {
  window.removeEventListener('resize', handleResize)
  trendChart?.dispose()
})

watch(currentFloorTrend, renderTrendChart)
</script>

<style scoped>
.person-view {
  display: grid;
  grid-template-rows: auto auto 1fr auto;
  height: 100%;
  gap: 10px;
  overflow: hidden;
  min-height: 0;
}

/* ==================== 页面头部 ==================== */
.page-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 0 4px 0;
}
.header-bar {
  width: 2px;
  height: 36px;
  background: var(--fire-blue);

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

/* ==================== 统计卡片 ==================== */
.stat-row {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
}
.mini-stat {
  display: flex;
  align-items: center;
  padding: 10px 12px;
  gap: 10px;
  position: relative;
}
.mini-stat-bar {
  width: 2px;
  height: 32px;
  border-radius: 1px;
  flex-shrink: 0;
}
.mini-stat-body {
  display: flex;
  flex-direction: column;
  flex: 1;
}
.mini-stat-value {
  font-size: 28px;
  font-weight: 700;
  line-height: 1;
}
.mini-stat-label {
  font-size: 10px;
  color: var(--text-tertiary);
  margin-top: 4px;
  letter-spacing: 1px;
}
.mini-stat-icon {
  width: 28px;
  height: 28px;
  opacity: 0.4;
  flex-shrink: 0;
}

/* ==================== 主体三栏 ==================== */
.main-content {
  display: grid;
  grid-template-columns: 180px 1fr 280px;
  gap: 8px;
  min-height: 0;
  overflow: hidden;
}

/* ==================== 左侧 ==================== */
.left-col {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 0;
  overflow: hidden;
}
.floor-selector-card {
  padding: 10px;
  flex-shrink: 0;
}
.col-section-title {
  font-size: 11px;
  color: var(--text-secondary);
  font-weight: 600;
  margin-bottom: 8px;
  text-transform: uppercase;
}
.floor-list {
  display: flex;
  flex-direction: column;
  gap: 3px;
  margin-bottom: 8px;
}
.floor-btn {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 7px 10px;
  background: rgba(76, 201, 240, 0.03);
  border: 1px solid rgba(76, 201, 240, 0.08);
  border-radius: 3px;
  color: var(--text-secondary);
  font-size: 12px;
  cursor: pointer;
  transition: all 0.2s;
  text-align: left;
}
.floor-btn:hover {
  background: rgba(76, 201, 240, 0.08);
  border-color: rgba(76, 201, 240, 0.2);
  color: var(--text-primary);
}
.floor-btn.active {
  background: rgba(76, 201, 240, 0.12);
  border-color: var(--fire-blue);
  color: var(--fire-blue);

}
.floor-btn-indicator {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: rgba(76, 201, 240, 0.2);
}
.floor-btn.active .floor-btn-indicator {
  background: var(--fire-blue);
  box-shadow: 0 0 6px var(--fire-blue);
}
.building-select-row {
  margin-top: 4px;
}

/* 区域列表 */
.zone-list-card {
  padding: 10px;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.zone-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  overflow-y: auto;
  flex: 1;
}
.zone-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 8px;
  background: rgba(76, 201, 240, 0.02);
  border: 1px solid rgba(76, 201, 240, 0.06);
  border-radius: 3px;
  transition: all 0.2s;
}
.zone-item:hover {
  background: rgba(76, 201, 240, 0.06);
}
.zone-name {
  font-size: 11px;
  color: var(--text-secondary);
}
.zone-meta {
  display: flex;
  align-items: center;
  gap: 6px;
}
.zone-count {
  font-size: 14px;
  font-weight: 700;
}
.zone-hot { color: var(--fire-red); }
.zone-warm { color: var(--fire-cyan); }
.zone-cold { color: var(--fire-green); }

/* ==================== 中间 ==================== */
.center-col {
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
.map-title-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.info-badge {
  font-size: 11px;
  color: var(--fire-cyan);
  padding: 2px 8px;
  background: rgba(76, 201, 240, 0.08);
  border: 1px solid rgba(76, 201, 240, 0.2);
  border-radius: 2px;
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

/* SVG 容器 */
.svg-container {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  position: relative;
  border: 1px solid rgba(76, 201, 240, 0.06);
  border-radius: 3px;
  background: var(--fire-dark);
}
.floor-svg {
  width: 100%;
  height: 100%;
}

/* SVG 样式 */
.room {
  fill: rgba(76, 201, 240, 0.04);
  stroke: rgba(76, 201, 240, 0.2);
  stroke-width: 1;
}
.room-label {
  fill: var(--text-tertiary);
  font-size: 10px;
  text-anchor: middle;
}
.corridor {
  fill: rgba(0, 0, 0, 0.3);
  stroke: rgba(76, 201, 240, 0.08);
  stroke-width: 1;
  stroke-dasharray: 4 4;
}
.corridor-label {
  fill: var(--text-tertiary);
  font-size: 10px;
  text-anchor: middle;
  opacity: 0.5;
}
.stair {
  fill: rgba(245, 158, 11, 0.06);
  stroke: rgba(245, 158, 11, 0.25);
  stroke-width: 1;
}
.stair-line {
  stroke: rgba(245, 158, 11, 0.3);
  stroke-width: 1;
}
.stair-label {
  fill: var(--fire-orange);
  font-size: 9px;
  text-anchor: middle;
  opacity: 0.7;
}
.exit {
  fill: rgba(34, 197, 94, 0.1);
  stroke: rgba(34, 197, 94, 0.4);
  stroke-width: 1;
}
.exit-label {
  fill: var(--fire-green);
  font-size: 8px;
  text-anchor: middle;
  font-weight: 600;
}

/* 扫描线 */
.scan-line {
  animation: scanMove 4s linear infinite;
}
@keyframes scanMove {
  0% { transform: translateY(-60px); }
  100% { transform: translateY(420px); }
}

/* 风险区域 */
.risk-zone-rect {
  animation: riskFlash 1.5s ease-in-out infinite;
}
.risk-zone-border {
  animation: riskFlash 1.5s ease-in-out infinite;
}
.risk-label {
  fill: var(--fire-red);
  font-size: 10px;
  text-anchor: middle;
  font-weight: 600;
}
@keyframes riskFlash {
  0%, 100% { opacity: 0.3; }
  50% { opacity: 0.7; }
}

/* 人员点 */
.person-group {
  cursor: pointer;
}
.person-normal {
  fill: var(--fire-blue);
  stroke: rgba(76, 201, 240, 0.8);
  stroke-width: 1;
  filter: drop-shadow(0 0 4px rgba(76, 201, 240, 0.6));
  transition: r 0.2s;
}
.person-group:hover .person-normal {
  r: 6;
}
.person-abnormal {
  fill: var(--fire-red);
  stroke: rgba(239, 68, 68, 0.8);
  stroke-width: 1;
  filter: drop-shadow(0 0 6px rgba(239, 68, 68, 0.7));
  animation: abnormalBlink 0.8s infinite;
  transition: r 0.2s;
}
.person-group:hover .person-abnormal {
  r: 6;
}
.pulse-ring {
  animation: pulseExpand 1.5s infinite;
  transform-origin: center;
}
.person-label {
  fill: var(--text-secondary);
  font-size: 8px;
  text-anchor: middle;
  pointer-events: none;
  font-family: 'DIN', 'Roboto Mono', monospace;
}
@keyframes abnormalBlink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}
@keyframes pulseExpand {
  0% { r: 4; opacity: 0.8; }
  100% { r: 16; opacity: 0; }
}

/* 人员详情面板 */
.person-detail-panel {
  position: absolute;
  bottom: 56px;
  right: 16px;
  width: 220px;
  background: var(--fire-panel-solid, #111827);
  border: 1px solid var(--fire-border, rgba(76, 201, 240, 0.2));
  border-radius: 12px;
  z-index: 10;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);

}
.panel-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--fire-border);
  font-size: 12px;
  color: #4361EE;
  font-weight: 600;
}
.panel-header span {
  flex: 1;
}
.close-btn {
  background: none;
  border: none;
  color: var(--text-tertiary);
  cursor: pointer;
  padding: 0;
  display: flex;
  align-items: center;
}
.close-btn:hover {
  color: var(--fire-red);
}
.panel-body {
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.detail-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 12px;
}
.detail-key {
  color: var(--text-tertiary);
}
.detail-val {
  color: var(--text-primary);
  font-weight: 500;
}
.text-red { color: var(--fire-red) !important; }
.text-green { color: var(--fire-green) !important; }

/* 地图操作按钮 */
.map-actions {
  display: flex;
  gap: 8px;
  margin-top: 8px;
  flex-shrink: 0;
  justify-content: center;
}
.demo-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 16px;
  border-radius: 3px;
  border: 1px solid rgba(76, 201, 240, 0.2);
  background: rgba(76, 201, 240, 0.05);
  color: var(--fire-cyan);
  font-size: 12px;
  cursor: pointer;
  transition: all 0.2s;
}
.demo-btn:hover {
  background: rgba(76, 201, 240, 0.12);
  border-color: rgba(76, 201, 240, 0.4);
  box-shadow: 0 2px 8px rgba(76, 201, 240, 0.12);
}
.demo-btn.danger {
  border-color: rgba(239, 68, 68, 0.2);
  background: rgba(239, 68, 68, 0.05);
  color: var(--fire-red);
}
.demo-btn.danger:hover {
  background: rgba(239, 68, 68, 0.12);
  border-color: rgba(239, 68, 68, 0.4);
  box-shadow: 0 2px 8px rgba(239, 68, 68, 0.14);
}

/* ==================== 右侧 ==================== */
.right-col {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 0;
  overflow: hidden;
}
.chart-card {
  display: flex;
  flex-direction: column;
  padding: 10px;
  min-height: 0;
}
.chart-title-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
  flex-shrink: 0;
}
.chart-box {
  flex: 1;
  min-height: 160px;
}

/* 热力图网格 */
.heatmap-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 4px;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}
.heatmap-cell {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  border: 1px solid;
  border-radius: 3px;
  padding: 6px 4px;
  transition: all 0.2s;
  cursor: default;
}
.heatmap-cell:hover {
  transform: scale(1.05);
  border-color: var(--fire-cyan);
}
.heatmap-name {
  font-size: 10px;
  color: var(--text-secondary);
  margin-bottom: 2px;
}
.heatmap-count {
  font-size: 18px;
  font-weight: 700;
  color: var(--text-primary);
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
  color: var(--fire-blue);
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

/* 过渡动画 */
.slide-fade-enter-active {
  transition: all 0.3s ease;
}
.slide-fade-leave-active {
  transition: all 0.2s ease;
}
.slide-fade-enter-from {
  transform: translateY(20px);
  opacity: 0;
}
.slide-fade-leave-to {
  transform: translateY(20px);
  opacity: 0;
}

/* 响应式 */
@media (max-width: 1366px) {
  .main-content {
    grid-template-columns: 160px 1fr 240px;
  }
}
</style>

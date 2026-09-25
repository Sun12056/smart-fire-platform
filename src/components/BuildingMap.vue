<template>
  <div class="building-map fire-card">
    <div class="map-header">
      <h3>消防楼宇态势图</h3>
      <div class="map-legend">
        <span class="legend-item"><span class="dot normal"></span>正常</span>
        <span class="legend-item"><span class="dot warning"></span>告警</span>
        <span class="legend-item"><span class="dot device"></span>设备点位</span>
      </div>
    </div>

    <div class="map-container" @click.self="selectedBuildingInfo = null">
      <!-- 扫描线 -->
      <div class="scanline"></div>

      <svg viewBox="0 0 800 500" class="map-svg" @click.self="selectedBuildingInfo = null">
        <!-- defs -->
        <defs>
          <!-- 细网格 20px -->
          <pattern id="grid-fine" width="20" height="20" patternUnits="userSpaceOnUse">
            <path d="M 20 0 L 0 0 0 20" fill="none" stroke="rgba(76,201,240,0.04)" stroke-width="0.5"/>
          </pattern>
          <!-- 粗网格 80px -->
          <pattern id="grid-bold" width="80" height="80" patternUnits="userSpaceOnUse">
            <path d="M 80 0 L 0 0 0 80" fill="none" stroke="rgba(76,201,240,0.06)" stroke-width="0.8"/>
          </pattern>
          <!-- 楼宇 glow filter -->
          <filter id="glow-cyan" x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur stdDeviation="2" result="blur"/>
            <feMerge>
              <feMergeNode in="blur"/>
              <feMergeNode in="SourceGraphic"/>
            </feMerge>
          </filter>
          <filter id="glow-red" x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur stdDeviation="3" result="blur"/>
            <feMerge>
              <feMergeNode in="blur"/>
              <feMergeNode in="SourceGraphic"/>
            </feMerge>
          </filter>
          <filter id="glow-green" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="1.5" result="blur"/>
            <feMerge>
              <feMergeNode in="blur"/>
              <feMergeNode in="SourceGraphic"/>
            </feMerge>
          </filter>
          <!-- 雷达扫描渐变 -->
          <linearGradient id="radar-sweep" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stop-color="rgba(76,201,240,0.15)"/>
            <stop offset="100%" stop-color="rgba(76,201,240,0)"/>
          </linearGradient>
          <!-- 消防站内部网格 -->
          <pattern id="station-grid" width="8" height="8" patternUnits="userSpaceOnUse">
            <path d="M 8 0 L 0 0 0 8" fill="none" stroke="rgba(76,201,240,0.15)" stroke-width="0.5"/>
          </pattern>
        </defs>

        <!-- 双层网格背景 -->
        <rect width="800" height="500" fill="url(#grid-fine)"/>
        <rect width="800" height="500" fill="url(#grid-bold)"/>

        <!-- 雷达扫描 -->
        <g class="radar-sweep" style="transform-origin: 400px 250px;">
          <line x1="400" y1="250" x2="750" y2="250" stroke="url(#radar-sweep)" stroke-width="120" opacity="0.5"/>
        </g>

        <!-- 消防通道 - 数据流 -->
        <path d="M 50 250 L 750 250" stroke="rgba(76,201,240,0.08)" stroke-width="20" fill="none" stroke-dasharray="8,4" class="data-flow"/>
        <path d="M 200 50 L 200 450" stroke="rgba(76,201,240,0.08)" stroke-width="15" fill="none" stroke-dasharray="8,4" class="data-flow"/>
        <path d="M 600 50 L 600 450" stroke="rgba(76,201,240,0.08)" stroke-width="15" fill="none" stroke-dasharray="8,4" class="data-flow"/>
        <text x="400" y="245" fill="rgba(76,201,240,0.3)" font-size="9" text-anchor="middle" letter-spacing="2">消防通道</text>

        <!-- 消防站 - 六边形 -->
        <g @click.stop="selectBuilding(null, '消防站')" class="building-group">
          <polygon points="370,290 370,270 400,260 430,270 430,290 400,300"
            fill="rgba(76,201,240,0.08)" stroke="#4CC9F0" stroke-width="1" filter="url(#glow-cyan)"/>
          <polygon points="375,288 375,272 400,264 425,272 425,288 400,296"
            fill="url(#station-grid)" stroke="rgba(76,201,240,0.2)" stroke-width="0.5"/>
          <text x="400" y="283" fill="#4CC9F0" font-size="9" text-anchor="middle" font-weight="600" letter-spacing="1">消防站</text>
        </g>

        <!-- 1号楼 -->
        <g @click.stop="selectBuilding(store.buildings[0])" class="building-group" :class="{ warning: store.buildings[0]?.status === 'warning' }">
          <rect x="80" y="80" width="180" height="140" rx="3"
            :fill="store.buildings[0]?.status === 'warning' ? 'rgba(239,68,68,0.06)' : 'rgba(76,201,240,0.04)'"
            :stroke="store.buildings[0]?.status === 'warning' ? '#EF4444' : '#4CC9F0'"
            stroke-width="1"
            :filter="store.buildings[0]?.status === 'warning' ? 'url(#glow-red)' : 'url(#glow-cyan)'"/>
          <!-- 楼层线 -->
          <line x1="260" y1="100" x2="268" y2="100" stroke="rgba(76,201,240,0.2)" stroke-width="0.8"/>
          <line x1="260" y1="130" x2="268" y2="130" stroke="rgba(76,201,240,0.2)" stroke-width="0.8"/>
          <line x1="260" y1="160" x2="268" y2="160" stroke="rgba(76,201,240,0.2)" stroke-width="0.8"/>
          <line x1="260" y1="190" x2="268" y2="190" stroke="rgba(76,201,240,0.2)" stroke-width="0.8"/>
          <text x="170" y="145" :fill="store.buildings[0]?.status === 'warning' ? '#EF4444' : '#4CC9F0'" font-size="14" text-anchor="middle" font-weight="600" letter-spacing="1">1号楼</text>
          <text x="170" y="165" fill="#475569" font-size="9" text-anchor="middle">{{ store.buildings[0]?.deviceCount }}台设备</text>
          <!-- 设备点位 -->
          <circle cx="120" cy="100" r="2.5" fill="#22C55E" filter="url(#glow-green)">
            <animate attributeName="opacity" values="0.4;1;0.4" dur="3s" repeatCount="indefinite"/>
          </circle>
          <circle cx="160" cy="100" r="2.5" fill="#22C55E" filter="url(#glow-green)">
            <animate attributeName="opacity" values="0.4;1;0.4" dur="3s" begin="0.3s" repeatCount="indefinite"/>
          </circle>
          <circle cx="200" cy="100" r="2.5" fill="#22C55E" filter="url(#glow-green)">
            <animate attributeName="opacity" values="0.4;1;0.4" dur="3s" begin="0.6s" repeatCount="indefinite"/>
          </circle>
          <circle cx="120" cy="200" r="2.5" fill="#22C55E" filter="url(#glow-green)">
            <animate attributeName="opacity" values="0.4;1;0.4" dur="3s" begin="0.9s" repeatCount="indefinite"/>
          </circle>
          <circle cx="220" cy="200" r="2.5" fill="#22C55E" filter="url(#glow-green)">
            <animate attributeName="opacity" values="0.4;1;0.4" dur="3s" begin="1.2s" repeatCount="indefinite"/>
          </circle>
          <circle cx="100" cy="150" r="2.5" fill="#22C55E" filter="url(#glow-green)">
            <animate attributeName="opacity" values="0.4;1;0.4" dur="3s" begin="1.5s" repeatCount="indefinite"/>
          </circle>
          <circle cx="240" cy="150" r="2.5" fill="#22C55E" filter="url(#glow-green)">
            <animate attributeName="opacity" values="0.4;1;0.4" dur="3s" begin="1.8s" repeatCount="indefinite"/>
          </circle>
        </g>

        <!-- 2号楼 -->
        <g @click.stop="selectBuilding(store.buildings[1])" class="building-group" :class="{ warning: store.buildings[1]?.status === 'warning' }">
          <rect x="440" y="80" width="180" height="140" rx="3"
            :fill="store.buildings[1]?.status === 'warning' ? 'rgba(239,68,68,0.06)' : 'rgba(76,201,240,0.04)'"
            :stroke="store.buildings[1]?.status === 'warning' ? '#EF4444' : '#4CC9F0'"
            stroke-width="1"
            :filter="store.buildings[1]?.status === 'warning' ? 'url(#glow-red)' : 'url(#glow-cyan)'"/>
          <line x1="620" y1="100" x2="628" y2="100" stroke="rgba(76,201,240,0.2)" stroke-width="0.8"/>
          <line x1="620" y1="130" x2="628" y2="130" stroke="rgba(76,201,240,0.2)" stroke-width="0.8"/>
          <line x1="620" y1="160" x2="628" y2="160" stroke="rgba(76,201,240,0.2)" stroke-width="0.8"/>
          <line x1="620" y1="190" x2="628" y2="190" stroke="rgba(76,201,240,0.2)" stroke-width="0.8"/>
          <text x="530" y="145" :fill="store.buildings[1]?.status === 'warning' ? '#EF4444' : '#4CC9F0'" font-size="14" text-anchor="middle" font-weight="600" letter-spacing="1">2号楼</text>
          <text x="530" y="165" fill="#475569" font-size="9" text-anchor="middle">{{ store.buildings[1]?.deviceCount }}台设备</text>
          <circle cx="480" cy="100" r="2.5" fill="#22C55E" filter="url(#glow-green)">
            <animate attributeName="opacity" values="0.4;1;0.4" dur="3s" begin="0.2s" repeatCount="indefinite"/>
          </circle>
          <circle cx="520" cy="100" r="2.5" fill="#22C55E" filter="url(#glow-green)">
            <animate attributeName="opacity" values="0.4;1;0.4" dur="3s" begin="0.5s" repeatCount="indefinite"/>
          </circle>
          <circle cx="560" cy="100" r="2.5" fill="#22C55E" filter="url(#glow-green)">
            <animate attributeName="opacity" values="0.4;1;0.4" dur="3s" begin="0.8s" repeatCount="indefinite"/>
          </circle>
          <circle cx="480" cy="200" r="2.5" fill="#22C55E" filter="url(#glow-green)">
            <animate attributeName="opacity" values="0.4;1;0.4" dur="3s" begin="1.1s" repeatCount="indefinite"/>
          </circle>
          <circle cx="580" cy="200" r="2.5" fill="#22C55E" filter="url(#glow-green)">
            <animate attributeName="opacity" values="0.4;1;0.4" dur="3s" begin="1.4s" repeatCount="indefinite"/>
          </circle>
          <circle cx="460" cy="150" r="2.5" fill="#22C55E" filter="url(#glow-green)">
            <animate attributeName="opacity" values="0.4;1;0.4" dur="3s" begin="1.7s" repeatCount="indefinite"/>
          </circle>
        </g>

        <!-- 3号楼 - 有告警 -->
        <g @click.stop="selectBuilding(store.buildings[2])" class="building-group" :class="{ warning: store.buildings[2]?.status === 'warning' }">
          <rect x="80" y="320" width="180" height="140" rx="3"
            :fill="store.buildings[2]?.status === 'warning' ? 'rgba(239,68,68,0.06)' : 'rgba(76,201,240,0.04)'"
            :stroke="store.buildings[2]?.status === 'warning' ? '#EF4444' : '#4CC9F0'"
            stroke-width="1"
            :filter="store.buildings[2]?.status === 'warning' ? 'url(#glow-red)' : 'url(#glow-cyan)'"/>
          <line x1="260" y1="340" x2="268" y2="340" stroke="rgba(76,201,240,0.2)" stroke-width="0.8"/>
          <line x1="260" y1="370" x2="268" y2="370" stroke="rgba(76,201,240,0.2)" stroke-width="0.8"/>
          <line x1="260" y1="400" x2="268" y2="400" stroke="rgba(76,201,240,0.2)" stroke-width="0.8"/>
          <line x1="260" y1="430" x2="268" y2="430" stroke="rgba(76,201,240,0.2)" stroke-width="0.8"/>
          <text x="170" y="385" :fill="store.buildings[2]?.status === 'warning' ? '#EF4444' : '#4CC9F0'" font-size="14" text-anchor="middle" font-weight="600" letter-spacing="1">3号楼</text>
          <text x="170" y="405" fill="#475569" font-size="9" text-anchor="middle">{{ store.buildings[2]?.deviceCount }}台设备</text>
          <circle cx="120" cy="340" r="2.5" fill="#22C55E" filter="url(#glow-green)">
            <animate attributeName="opacity" values="0.4;1;0.4" dur="3s" begin="0.1s" repeatCount="indefinite"/>
          </circle>
          <circle cx="160" cy="340" r="2.5" fill="#22C55E" filter="url(#glow-green)">
            <animate attributeName="opacity" values="0.4;1;0.4" dur="3s" begin="0.4s" repeatCount="indefinite"/>
          </circle>
          <circle cx="200" cy="340" r="2.5" fill="#22C55E" filter="url(#glow-green)">
            <animate attributeName="opacity" values="0.4;1;0.4" dur="3s" begin="0.7s" repeatCount="indefinite"/>
          </circle>
          <circle cx="120" cy="440" r="2.5" fill="#22C55E" filter="url(#glow-green)">
            <animate attributeName="opacity" values="0.4;1;0.4" dur="3s" begin="1.0s" repeatCount="indefinite"/>
          </circle>
          <circle cx="220" cy="440" r="2.5" fill="#22C55E" filter="url(#glow-green)">
            <animate attributeName="opacity" values="0.4;1;0.4" dur="3s" begin="1.3s" repeatCount="indefinite"/>
          </circle>
          <!-- 告警设备点 - 红色脉冲 -->
          <circle cx="140" cy="380" r="3.5" fill="#EF4444" filter="url(#glow-red)">
            <animate attributeName="opacity" values="0.8;0.3;0.8" dur="1.5s" repeatCount="indefinite"/>
          </circle>
          <circle cx="140" cy="380" r="3.5" fill="none" stroke="#EF4444" stroke-width="1">
            <animate attributeName="r" values="3.5;10;3.5" dur="1.5s" repeatCount="indefinite"/>
            <animate attributeName="opacity" values="0.8;0;0.8" dur="1.5s" repeatCount="indefinite"/>
          </circle>
          <!-- 告警设备点 - 橙色脉冲 -->
          <circle cx="180" cy="400" r="3.5" fill="#F59E0B" filter="url(#glow-red)">
            <animate attributeName="opacity" values="0.8;0.3;0.8" dur="1.5s" begin="0.3s" repeatCount="indefinite"/>
          </circle>
          <circle cx="180" cy="400" r="3.5" fill="none" stroke="#F59E0B" stroke-width="1">
            <animate attributeName="r" values="3.5;10;3.5" dur="1.5s" begin="0.3s" repeatCount="indefinite"/>
            <animate attributeName="opacity" values="0.8;0;0.8" dur="1.5s" begin="0.3s" repeatCount="indefinite"/>
          </circle>
          <circle cx="240" cy="370" r="2.5" fill="#22C55E" filter="url(#glow-green)">
            <animate attributeName="opacity" values="0.4;1;0.4" dur="3s" begin="1.6s" repeatCount="indefinite"/>
          </circle>
        </g>

        <!-- 4号楼 -->
        <g @click.stop="selectBuilding(store.buildings[3])" class="building-group" :class="{ warning: store.buildings[3]?.status === 'warning' }">
          <rect x="440" y="320" width="180" height="140" rx="3"
            :fill="store.buildings[3]?.status === 'warning' ? 'rgba(239,68,68,0.06)' : 'rgba(76,201,240,0.04)'"
            :stroke="store.buildings[3]?.status === 'warning' ? '#EF4444' : '#4CC9F0'"
            stroke-width="1"
            :filter="store.buildings[3]?.status === 'warning' ? 'url(#glow-red)' : 'url(#glow-cyan)'"/>
          <line x1="620" y1="340" x2="628" y2="340" stroke="rgba(76,201,240,0.2)" stroke-width="0.8"/>
          <line x1="620" y1="370" x2="628" y2="370" stroke="rgba(76,201,240,0.2)" stroke-width="0.8"/>
          <line x1="620" y1="400" x2="628" y2="400" stroke="rgba(76,201,240,0.2)" stroke-width="0.8"/>
          <line x1="620" y1="430" x2="628" y2="430" stroke="rgba(76,201,240,0.2)" stroke-width="0.8"/>
          <text x="530" y="385" :fill="store.buildings[3]?.status === 'warning' ? '#EF4444' : '#4CC9F0'" font-size="14" text-anchor="middle" font-weight="600" letter-spacing="1">4号楼</text>
          <text x="530" y="405" fill="#475569" font-size="9" text-anchor="middle">{{ store.buildings[3]?.deviceCount }}台设备</text>
          <circle cx="480" cy="340" r="2.5" fill="#22C55E" filter="url(#glow-green)">
            <animate attributeName="opacity" values="0.4;1;0.4" dur="3s" begin="0.15s" repeatCount="indefinite"/>
          </circle>
          <circle cx="520" cy="340" r="2.5" fill="#22C55E" filter="url(#glow-green)">
            <animate attributeName="opacity" values="0.4;1;0.4" dur="3s" begin="0.45s" repeatCount="indefinite"/>
          </circle>
          <circle cx="560" cy="340" r="2.5" fill="#22C55E" filter="url(#glow-green)">
            <animate attributeName="opacity" values="0.4;1;0.4" dur="3s" begin="0.75s" repeatCount="indefinite"/>
          </circle>
          <circle cx="480" cy="440" r="2.5" fill="#22C55E" filter="url(#glow-green)">
            <animate attributeName="opacity" values="0.4;1;0.4" dur="3s" begin="1.05s" repeatCount="indefinite"/>
          </circle>
          <circle cx="580" cy="440" r="2.5" fill="#22C55E" filter="url(#glow-green)">
            <animate attributeName="opacity" values="0.4;1;0.4" dur="3s" begin="1.35s" repeatCount="indefinite"/>
          </circle>
          <circle cx="460" cy="390" r="2.5" fill="#22C55E" filter="url(#glow-green)">
            <animate attributeName="opacity" values="0.4;1;0.4" dur="3s" begin="1.65s" repeatCount="indefinite"/>
          </circle>
        </g>
      </svg>

      <!-- 建筑信息面板 -->
      <transition name="page">
        <div v-if="selectedBuildingInfo" class="building-info-panel">
          <div class="panel-header">
            <h4>{{ selectedBuildingInfo.name }}</h4>
            <button class="close-btn" @click="selectedBuildingInfo = null">✕</button>
          </div>
          <div class="panel-body" v-if="selectedBuildingInfo !== '消防站'">
            <div class="info-row">
              <span class="info-label">楼层数量</span>
              <span class="info-value num-font">{{ selectedBuildingInfo.floors }} 层</span>
            </div>
            <div class="info-row">
              <span class="info-label">建筑类型</span>
              <span class="info-value">{{ selectedBuildingInfo.type }}</span>
            </div>
            <div class="info-row">
              <span class="info-label">消防设备</span>
              <span class="info-value num-font">{{ selectedBuildingInfo.deviceCount }} 台</span>
            </div>
            <div class="info-row">
              <span class="info-label">在线设备</span>
              <span class="info-value num-font text-green">{{ selectedBuildingInfo.online }} 台</span>
            </div>
            <div class="info-row">
              <span class="info-label">异常设备</span>
              <span class="info-value num-font" :class="selectedBuildingInfo.abnormal > 0 ? 'text-red' : 'text-green'">
                {{ selectedBuildingInfo.abnormal }} 台
              </span>
            </div>
            <div class="info-row">
              <span class="info-label">最近告警</span>
              <span class="info-value text-dim">{{ selectedBuildingInfo.lastAlarm }}</span>
            </div>
            <div class="info-row">
              <span class="info-label">巡检状态</span>
              <span class="info-value num-font text-cyan">{{ selectedBuildingInfo.patrolRate }}%</span>
            </div>
          </div>
          <div class="panel-body" v-else>
            <p class="station-desc">园区消防应急救援站<br/>24小时值班待命</p>
          </div>
          <div class="panel-footer" v-if="selectedBuildingInfo !== '消防站'">
            <button class="action-btn primary" @click="goToBuildingDetail">
              查看建筑详情 →
            </button>
          </div>
        </div>
      </transition>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { useFireStore } from '../stores/fireStore'

const store = useFireStore()
const router = useRouter()
const selectedBuildingInfo = ref(null)

function selectBuilding(building) {
  if (!building) return
  selectedBuildingInfo.value = building
}

function goToBuildingDetail() {
  if (selectedBuildingInfo.value) {
    store.selectBuilding(selectedBuildingInfo.value)
    router.push('/building')
  }
  selectedBuildingInfo.value = null
}
</script>

<style scoped>
.building-map {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
  position: relative;
}

.map-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px;
  border-bottom: 1px solid rgba(67, 97, 238, 0.15);
}

.map-header h3 {
  font-size: 14px;
  color: var(--text-primary);
  letter-spacing: 2px;
}

.map-legend {
  display: flex;
  gap: 12px;
}

.legend-item {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--text-tertiary);
}

.legend-item .dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
}

.dot.normal { background: #22C55E; box-shadow: 0 0 4px #22C55E; }
.dot.warning { background: #EF4444; box-shadow: 0 0 4px #EF4444; }
.dot.device { background: #4CC9F0; box-shadow: 0 0 4px #4CC9F0; }

.map-container {
  flex: 1;
  position: relative;
  overflow: hidden;
  background: radial-gradient(ellipse at center, rgba(0, 100, 180, 0.06), transparent 70%);
  min-height: 0;
}

/* 扫描线 */
.scanline {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 1px;
  background: rgba(76, 201, 240, 0.15);
  z-index: 5;
  pointer-events: none;
  animation: scanlineMove 8s linear infinite;
}

@keyframes scanlineMove {
  0% { top: 0; opacity: 1; }
  50% { top: 100%; opacity: 0.5; }
  100% { top: 0; opacity: 1; }
}

.map-svg {
  width: 100%;
  height: 100%;
  display: block;
}

/* 雷达扫描 */
.radar-sweep {
  animation: radarRotate 4s linear infinite;
  transform-origin: 400px 250px;
}

@keyframes radarRotate {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

/* 消防通道数据流 */
.data-flow {
  animation: dataFlow 1.5s linear infinite;
}

@keyframes dataFlow {
  from { stroke-dashoffset: 0; }
  to { stroke-dashoffset: -24; }
}

.building-group {
  cursor: pointer;
  transition: all 0.2s;
}

.building-group:hover rect {
  filter: brightness(1.4);
}

.building-group.warning rect {
  animation: buildingPulse 2s ease-in-out infinite;
}

@keyframes buildingPulse {
  0%, 100% { stroke-opacity: 1; }
  50% { stroke-opacity: 0.4; }
}

/* 建筑信息面板 - 玻璃面板 */
.building-info-panel {
  position: absolute;
  top: 20px;
  right: 20px;
  width: 280px;
  padding: 0;
  background: var(--fire-panel-solid, #111827);
  border: 1px solid var(--fire-border, rgba(76, 201, 240, 0.2));
  border-radius: 12px;

  animation: slideIn 0.3s ease-out;
  overflow: hidden;
}

@keyframes slideIn {
  from { opacity: 0; transform: translateX(20px); }
  to { opacity: 1; transform: translateX(0); }
}

.panel-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px;
  border-bottom: 1px solid rgba(67, 97, 238, 0.15);
}

.panel-header h4 {
  font-size: 14px;
  color: var(--fire-blue);
  letter-spacing: 1px;
}

.close-btn {
  background: none;
  border: none;
  color: #475569;
  cursor: pointer;
  font-size: 14px;
  padding: 4px;
  transition: color 0.2s;
}

.close-btn:hover {
  color: #EF4444;
}

.panel-body {
  padding: 12px 16px;
}

.info-row {
  display: flex;
  justify-content: space-between;
  padding: 6px 0;
  border-bottom: 1px solid rgba(67, 97, 238, 0.08);
  font-size: 13px;
}

.info-label {
  color: var(--text-tertiary);
}

.info-value {
  color: var(--text-secondary);
  font-weight: 500;
}

.num-font {
  font-family: 'DIN Alternate', 'Roboto Mono', 'Courier New', monospace;
  letter-spacing: 0.5px;
}

.text-green { color: var(--fire-green); }
.text-red { color: var(--fire-red); }
.text-cyan { color: var(--fire-blue); }
.text-dim { color: var(--text-tertiary); font-size: 12px; }

.station-desc {
  color: #475569;
  text-align: center;
  padding: 20px 0;
  font-size: 12px;
  line-height: 1.6;
}

.panel-footer {
  padding: 12px 16px;
  border-top: 1px solid rgba(67, 97, 238, 0.15);
}

.action-btn {
  width: 100%;
  padding: 8px 16px;
  border-radius: 3px;
  border: none;
  cursor: pointer;
  font-size: 12px;
  transition: all 0.2s;
  letter-spacing: 1px;
}

.action-btn.primary {
  background: linear-gradient(135deg, rgba(67, 97, 238, 0.15), rgba(67, 97, 238, 0.06));
  border: 1px solid rgba(67, 97, 238, 0.3);
  color: var(--fire-blue);
}

.action-btn.primary:hover {
  background: linear-gradient(135deg, rgba(67, 97, 238, 0.22), rgba(67, 97, 238, 0.1));
  box-shadow: 0 4px 12px rgba(67, 97, 238, 0.2);
}
</style>

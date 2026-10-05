<template>
  <div class="route-plan-view">
    <!-- 顶部标题 + 模式切换 -->
    <div class="rp-header">
      <div class="rp-title">
        智能疏散路径规划
        <span class="rp-sub">选择楼栋 → 一键自动规划所有区域 × 所有出口，火灾自动重规划 → 确认路径进入智能疏散</span>
      </div>
      <div class="mode-switch">
        <button :class="['mode-btn', { active: store.routeMode === 'auto' }]" @click="store.routeMode = 'auto'">● 自动规划</button>
        <button :class="['mode-btn', { active: store.routeMode === 'manual' }]" @click="store.routeMode = 'manual'">○ 手动规划</button>
      </div>
    </div>

    <!-- 页面内提示（替代业务弹窗） -->
    <div v-if="pageNotice" :class="['page-notice', `notice-${pageNotice.level}`]">
      <span class="notice-title">{{ pageNotice.title }}</span>
      <span class="notice-text">{{ pageNotice.text }}</span>
      <button class="notice-close" @click="pageNotice = null">知道了</button>
    </div>

    <!-- ============ 自动规划 ============ -->
    <div v-if="store.routeMode === 'auto'" class="rp-auto">
      <!-- 左：配置 -->
      <div class="rp-config fire-card">
        <div class="panel-title-bar"><span class="panel-title">规划参数</span></div>
        <div class="form-row">
          <label>楼栋</label>
          <select v-model="selBuilding" @change="onBuildingChange">
            <option v-for="b in buildingOptions" :key="b.id" :value="b.id">{{ b.name }}</option>
          </select>
        </div>
        <div class="form-row">
          <label>目标楼层</label>
          <select v-model="selFloor">
            <option v-for="f in floorOptions" :key="f" :value="f">{{ f }}</option>
          </select>
        </div>
        <div class="form-row">
          <label>目标出口</label>
          <select v-model="selExit">
            <option value="">自动选择（多出口择优）</option>
            <option value="出口A">A出口（东侧）</option>
            <option value="出口B">B出口（西侧）</option>
          </select>
        </div>
        <button class="primary-btn" @click="generate">一键自动规划（全区域）</button>
        <p class="tip-text">无需选择起始区域，系统自动读取 {{ selFloor }} 所有可疏散区域（{{ zoneNames }}），为每个区域生成多条候选路线。</p>

        <div class="divider"></div>

        <div class="panel-title-bar"><span class="panel-title">火灾模拟演示</span></div>
        <div class="form-row">
          <label>火灾楼层</label>
          <select v-model="fireFloor">
            <option v-for="f in floorOptions" :key="f" :value="f">{{ f }}</option>
          </select>
        </div>
        <div class="form-row">
          <label>火灾区域</label>
          <select v-model="fireArea">
            <option v-for="a in zoneOptions" :key="a" :value="a">{{ a }}</option>
          </select>
        </div>
        <button class="danger-btn" @click="startFire">开始模拟火灾（自动重规划）</button>
        <button class="ghost-btn" @click="clearFire">解除火灾场景</button>

        <div class="divider"></div>

        <!-- 阶段③：确认当前疏散路径 → 进入智能疏散（六阶段状态机内流转，不绕过） -->
        <div class="confirm-block" :class="{ ready: canConfirmPlan }">
          <template v-if="store.emergencyStage >= 4 && store.routeDecisionConfirmed">
            <div class="confirmed-tip">✓ 疏散路径已确认：{{ confirmedPlanName }}</div>
          </template>
          <template v-else>
            <button class="confirm-btn" :disabled="!canConfirmPlan" @click="confirmPlan">
              ✓ 确认当前疏散路径 → 进入智能疏散
            </button>
            <p class="tip-text">
              {{ store.fireEvent
                ? (store.emergencyStage === 3
                    ? `已为 ${store.fireEvent.building} ${store.fireEvent.floor} ${store.fireEvent.area} 生成多套候选方案，确认后进入智能疏散`
                    : '当前流程尚未进入「疏散路径」阶段，请先在指挥中心完成前置阶段')
                : '尚无火灾事件：在指挥中心点击「模拟火灾」后，系统将自动进入本页生成多套疏散方案' }}
            </p>
          </template>
        </div>
      </div>

      <!-- 中：平面图（同时显示所有区域路线） -->
      <div class="rp-map fire-card">
        <div class="panel-title-bar">
          <span class="panel-title">{{ currentBuildingName }} · {{ routeFloorId }} 全区域疏散路线</span>
          <span class="legend">
            <i v-for="z in zoneList" :key="z.zone" class="lg" :style="{ background: z.color }"></i>
          </span>
          <button class="debug-btn" :class="{ active: store.routeDebug }" @click="store.toggleRouteDebug()">🛰 路网调试 {{ store.routeDebug ? '开' : '关' }}</button>
        </div>
        <!-- 整栋楼疏散：火灾只描述位置，疏散范围覆盖全部有人的楼层+区域 -->
        <div v-if="buildingSummary" class="rp-building-tip">
          <span class="bp-scope">疏散范围：整栋楼</span>
          <span class="bp-stat">{{ buildingSummary.zoneCount }} 区 / {{ buildingSummary.personCount }} 人 / 最慢 {{ buildingSummary.maxEstimatedTime }}s</span>
          <span class="bp-chips">
            <button
              v-for="bp in store.buildingEvacuationPlans" :key="bp.id"
              class="bp-chip" :class="{ active: bp.id === store.activeBuildingPlanId }"
              @click.stop="store.setActiveBuildingPlan(bp.id)"
            >{{ bp.strategyLabel }}·{{ strategyName(bp) }}</button>
          </span>
        </div>
        <svg class="floor-svg" viewBox="0 0 560 300" preserveAspectRatio="xMidYMid meet" @click="onMapClick">
          <!-- 走廊背景 -->
          <rect x="60" y="150" width="440" height="40" fill="rgba(67,97,238,0.05)" stroke="rgba(67,97,238,0.2)"/>
          <!-- 房间 -->
          <g class="rooms">
            <rect x="90" y="28" width="105" height="120" rx="2" class="room" :class="{ sel: store.selectedZone==='A区', fire: isFireZone('A区') }" @click.stop="pickZone('A区')"/>
            <text x="142" y="92" text-anchor="middle" class="room-label">A区</text>
            <rect x="90" y="210" width="105" height="70" rx="2" class="room" :class="{ sel: store.selectedZone==='B区', fire: isFireZone('B区') }" @click.stop="pickZone('B区')"/>
            <text x="142" y="248" text-anchor="middle" class="room-label">B区</text>
            <rect x="375" y="28" width="80" height="120" rx="2" class="room" :class="{ sel: store.selectedZone==='C区', fire: isFireZone('C区') }" @click.stop="pickZone('C区')"/>
            <text x="415" y="92" text-anchor="middle" class="room-label">C区</text>
            <rect x="375" y="210" width="80" height="70" rx="2" class="room" :class="{ sel: store.selectedZone==='D区', fire: isFireZone('D区') }" @click.stop="pickZone('D区')"/>
            <text x="415" y="248" text-anchor="middle" class="room-label">D区</text>
          </g>
          <!-- 楼梯 -->
          <g class="stairs">
            <rect x="462" y="28" width="30" height="34" rx="2" class="stair"/>
            <text x="477" y="48" text-anchor="middle" class="stair-label">梯A</text>
            <rect x="57" y="28" width="30" height="34" rx="2" class="stair"/>
            <text x="72" y="48" text-anchor="middle" class="stair-label">梯B</text>
            <rect x="57" y="252" width="30" height="34" rx="2" class="stair"/>
            <text x="72" y="272" text-anchor="middle" class="stair-label">梯C</text>
            <rect x="462" y="252" width="30" height="34" rx="2" class="stair"/>
            <text x="477" y="272" text-anchor="middle" class="stair-label">梯D</text>
          </g>
          <!-- 出口 -->
          <g class="exits">
            <circle cx="532" cy="170" r="9" class="exit-node"/>
            <text x="532" y="190" text-anchor="middle" class="exit-label">A出口</text>
            <circle cx="28" cy="170" r="9" class="exit-node"/>
            <text x="28" y="190" text-anchor="middle" class="exit-label">B/C出口</text>
          </g>
          <!-- 所有区域路线 -->
          <g v-for="z in allZoneRoutes" :key="'rt-'+z.zone">
            <polyline
              v-if="z.segment.length"
              :points="z.segment.map(p=>p.x+','+p.y).join(' ')"
              :class="['zone-route', { active: store.selectedZone===z.zone }]"
              :style="{ stroke: z.color }"
            />
            <circle :cx="z.segment[0] ? z.segment[0].x : 0" :cy="z.segment[0] ? z.segment[0].y : 0" r="6" :fill="z.color" class="zone-start"/>
          </g>
          <!-- 火灾热区 -->
          <g v-if="isRouteFloorOnFire">
            <text x="142" y="80" text-anchor="middle" font-size="26">🔥</text>
          </g>
          <!-- 路网调试层：墙/边/节点 -->
          <g v-if="network" class="net-debug">
            <rect v-for="(w, i) in network.walls" :key="'w' + i" :x="w.x" :y="w.y" :width="w.w" :height="w.h" fill="rgba(239,68,68,0.06)" stroke="rgba(239,68,68,0.65)" stroke-width="1" stroke-dasharray="4 3" />
            <line v-for="(e, i) in networkEdges" :key="'ne' + i" :x1="e.x1" :y1="e.y1" :x2="e.x2" :y2="e.y2" stroke="rgba(34,197,94,0.55)" stroke-width="1" />
            <circle v-for="(n, i) in network.nodes" :key="'nn' + i" :cx="n.x" :cy="n.y" r="3" :fill="nodeTypeColor(n.type)" stroke="#fff" stroke-width="0.5" />
            <text v-for="(n, i) in network.nodes" :key="'nt' + i" :x="n.x + 4" :y="n.y + 3" font-size="7" fill="#475569">{{ typeShort(n.type) }}</text>
          </g>
        </svg>
      </div>

      <!-- 右：整栋楼疏散方案 · 本层各区域路线 -->
      <div class="rp-plans">
        <div class="panel-title-bar">
          <span class="panel-title">整栋楼疏散方案</span>
          <span v-if="buildingSummary" class="rp-plan-scope">
            {{ buildingSummary.floors.length }} 层 · {{ buildingSummary.zoneCount }} 区 ·
            {{ buildingSummary.personCount }} 人 · {{ buildingSummary.routeCount }} 条路线
          </span>
        </div>
        <div v-if="!store.activeBuildingPlan" class="empty-tip">点击左侧「一键自动规划」生成整栋楼方案</div>
        <div
          v-for="z in zonePlanCards"
          :key="z.zone"
          :class="['zone-card', { active: store.selectedZone===z.zone, blocked: z.blocked }]"
          @click="store.setSelectedZone(z.zone)"
        >
          <div class="zone-head">
            <span class="zone-dot" :style="{ background: z.color }"></span>
            <span class="zone-name">{{ routeFloorId }} {{ z.zone }}</span>
            <span class="zone-persons">👤 {{ z.personCount }} 人</span>
            <span v-if="z.blocked" class="tag blk">❌ 无安全路线</span>
          </div>
          <div class="zone-rec">
            <span class="rec-label">出口</span>
            <span class="rec-name">{{ z.exitLabel }}</span>
            <span class="rec-meta">距离 {{ z.distance }}m · {{ z.estimatedTime }}s · 风险{{ z.riskLevel }}</span>
          </div>
          <div class="zone-bak">
            <span class="bak-label">routeId</span>
            <span class="bak-name">{{ z.routeId }}</span>
          </div>
          <div class="zone-actions">
            <button class="mini-btn" @click.stop="viewZone(z.zone)">查看路线</button>
          </div>
        </div>
      </div>
    </div>

    <!-- ============ 手动规划 ============ -->
    <div v-else class="rp-manual">
      <div class="rp-config fire-card">
        <div class="panel-title-bar"><span class="panel-title">手动编辑说明</span></div>
        <p class="tip-text">在平面图上<strong>点击空白处</strong>添加路线节点；<strong>点击节点</strong>可连接到上一个节点；选中节点后可设为<strong>起点 / 终点</strong>。</p>
        <div class="form-row">
          <label>楼栋</label>
          <select v-model="selBuilding" @change="onBuildingChange">
            <option v-for="b in buildingOptions" :key="b.id" :value="b.id">{{ b.name }}</option>
          </select>
        </div>
        <div class="form-row">
          <label>楼层</label>
          <select v-model="selFloor">
            <option v-for="f in floorOptions" :key="f" :value="f">{{ f }}</option>
          </select>
        </div>
        <button class="primary-btn" @click="setStart" :disabled="!selectedNodeId">设为起点</button>
        <button class="primary-btn" @click="setExit" :disabled="!selectedNodeId">设为终点</button>
        <button class="ghost-btn" @click="connectNodes" :disabled="!selectedNodeId">连接节点</button>
        <button class="primary-btn" @click="saveManual">保存路线</button>
        <button class="danger-btn" @click="clearManual">清空</button>
      </div>

      <div class="rp-map fire-card" style="flex: 1;">
        <div class="panel-title-bar"><span class="panel-title">{{ currentBuildingName }} · {{ routeFloorId }} 手动路线编辑</span></div>
        <svg class="floor-svg" viewBox="0 0 560 300" preserveAspectRatio="xMidYMid meet" @click="onSvgClick">
          <rect x="60" y="150" width="440" height="40" fill="rgba(67,97,238,0.05)" stroke="rgba(67,97,238,0.2)"/>
          <g class="rooms">
            <rect x="90" y="28" width="105" height="120" rx="2" class="room"/>
            <rect x="90" y="210" width="105" height="70" rx="2" class="room"/>
            <rect x="375" y="28" width="80" height="120" rx="2" class="room"/>
            <rect x="375" y="210" width="80" height="70" rx="2" class="room"/>
          </g>
          <g class="stairs">
            <rect x="462" y="28" width="30" height="34" rx="2" class="stair"/>
            <rect x="57" y="28" width="30" height="34" rx="2" class="stair"/>
            <rect x="57" y="252" width="30" height="34" rx="2" class="stair"/>
            <rect x="462" y="252" width="30" height="34" rx="2" class="stair"/>
          </g>
          <line
            v-for="(edge, i) in store.routeEdges"
            :key="'e' + i"
            :x1="nodeById(edge[0]).x" :y1="nodeById(edge[0]).y"
            :x2="nodeById(edge[1]).x" :y2="nodeById(edge[1]).y"
            class="manual-edge"
          />
          <g v-for="n in store.routeNodes" :key="n.id" @click.stop="selectNode(n.id)">
            <circle
              :cx="n.x" :cy="n.y" r="9"
              :class="['manual-node', { selected: n.id === selectedNodeId, start: n.isStart, exit: n.isExit, pending: n.id === pendingNodeId }]"
            />
            <text :x="n.x" :y="n.y + 3" text-anchor="middle" class="node-text">
              {{ n.isStart ? '起' : n.isExit ? '终' : '' }}
            </text>
          </g>
          <g v-if="network" class="net-debug">
            <rect v-for="(w, i) in network.walls" :key="'mw' + i" :x="w.x" :y="w.y" :width="w.w" :height="w.h" fill="rgba(239,68,68,0.06)" stroke="rgba(239,68,68,0.65)" stroke-width="1" stroke-dasharray="4 3" />
            <line v-for="(e, i) in networkEdges" :key="'mne' + i" :x1="e.x1" :y1="e.y1" :x2="e.x2" :y2="e.y2" stroke="rgba(34,197,94,0.55)" stroke-width="1" />
            <circle v-for="(n, i) in network.nodes" :key="'mnn' + i" :cx="n.x" :cy="n.y" r="3" :fill="nodeTypeColor(n.type)" stroke="#fff" stroke-width="0.5" />
          </g>
        </svg>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useFireStore } from '../stores/fireStore'
import { useDemoStore } from '../stores/demoStore'
import { dataSource } from '../api'
import { getFloorTopology, WALLS } from '../mock/routeGraph'
// P1.6.1：人员「楼层 / 区域 / 楼栋」判定统一走契约 helper（buildingId / floorId / zone）
import { countPersonsInLocation, BUILDING_NAME_TO_ID } from '../../shared/person/personRuntime.js'

const store = useFireStore()
const demoStore = useDemoStore()
const router = useRouter()

// 页面内提示（替代业务弹窗：手动规划校验失败等）
const pageNotice = ref(null)
function showNotice(title, text, level = 'warning') {
  pageNotice.value = { title, text, level }
}

// 阶段③ 确认当前疏散路径：权威判据 = 是否存在当前整栋楼方案（activeBuildingPlanId）
const canConfirmPlan = computed(() => {
  if (!store.fireEvent || store.emergencyStage !== 3) return false
  return Boolean(store.activeBuildingPlanId && store.activeBuildingPlan)
})
const confirmedPlanName = computed(() => {
  const bp = store.activeBuildingPlan
  return bp ? bp.name : '推荐方案'
})
function confirmPlan() {
  if (!canConfirmPlan.value) return
  const ok = store.confirmEvacuationPlan()
  if (ok) router.push('/evacuation')
}

const selBuilding = ref('B003')
const selFloor = ref('5F')
const selExit = ref('')
const fireFloor = ref('5F')
const fireArea = ref('A区')

const selectedNodeId = ref(null)
const pendingNodeId = ref(null)

const buildingOptions = computed(() => store.buildings.map((b) => ({ id: b.id, name: b.name, floors: b.floors })))
const currentBuildingName = computed(() => {
  const b = store.buildings.find((x) => x.id === selBuilding.value)
  return b ? b.name : '3号楼'
})
const floorOptions = computed(() => {
  const b = store.buildings.find((x) => x.id === selBuilding.value)
  const max = b && b.floors ? b.floors : 7
  return Array.from({ length: max }, (_, i) => `${i + 1}F`)
})
const zoneNames = 'A区 / B区 / C区 / D区'
const zoneOptions = ['A区', 'B区', 'C区', 'D区']
const routeFloorId = computed({
  get: () => store.routeFloorId,
  set: (v) => { store.routeFloorId = v },
})

const allZoneRoutes = computed(() => store.getAllZoneRoutes())
// 整栋楼方案汇总与策略切换（A 均衡 / B 快速 / C 安全）
const buildingSummary = computed(() => {
  const bp = store.activeBuildingPlan
  return bp && bp.summary ? bp.summary : null
})
const STRATEGY_CN = { BALANCED: '均衡疏散', FASTEST: '快速疏散', SAFEST: '安全优先' }
const strategyName = (bp) => STRATEGY_CN[bp.strategy] || bp.strategy
const RISK_CN = { LOW: '低', MEDIUM: '中', HIGH: '高' }
const ZONE_COLOR_MAP = { 'A区': '#4361EE', 'B区': '#22C55E', 'C区': '#F59E0B', 'D区': '#8B5CF6', '走廊': '#64748B' }
const zoneList = computed(() =>
  allZoneRoutes.value.map((z) => ({ zone: z.zone, color: z.color }))
)

// 路网调试层
const network = computed(() => (store.routeDebug ? getFloorTopology() : null))
const networkEdges = computed(() => {
  if (!network.value) return []
  const map = {}
  network.value.nodes.forEach((n) => { map[n.id] = n })
  return network.value.edges.map((e) => ({ x1: map[e.from].x, y1: map[e.from].y, x2: map[e.to].x, y2: map[e.to].y }))
})
function nodeTypeColor(t) {
  return { room: '#4361EE', corridor: '#F59E0B', stair: '#4CC9F0', exit: '#22C55E' }[t] || '#64748B'
}
function typeShort(t) {
  return { room: '门', corridor: '廊', stair: '梯', exit: '出' }[t] || t
}
// 几何工具：线段是否穿过房间实体（手动模式合法性校验）
function segHitsWall(x1, y1, x2, y2) {
  return WALLS.some((r) => segIntersectsRect({ x: x1, y: y1 }, { x: x2, y: y2 }, r))
}
function segIntersectsRect(p1, p2, r) {
  const rx2 = r.x + r.w, ry2 = r.y + r.h
  const inside = (px, py) => px >= r.x && px <= rx2 && py >= r.y && py <= ry2
  if (inside(p1.x, p1.y) || inside(p2.x, p2.y)) return true
  const segs = [
    [[r.x, r.y], [rx2, r.y]], [[rx2, r.y], [rx2, ry2]], [[rx2, ry2], [r.x, ry2]], [[r.x, ry2], [r.x, r.y]],
  ]
  return segs.some((a) => segSeg(p1.x, p1.y, p2.x, p2.y, a[0][0], a[0][1], a[1][0], a[1][1]))
}
function segSeg(x1, y1, x2, y2, x3, y3, x4, y4) {
  const d = (x2 - x1) * (y4 - y3) - (y2 - y1) * (x4 - x3)
  if (d === 0) return false
  const t = ((x3 - x1) * (y4 - y3) - (y3 - y1) * (x4 - x3)) / d
  const u = ((x3 - x1) * (y2 - y1) - (y3 - y1) * (x2 - x1)) / d
  return t >= 0 && t <= 1 && u >= 0 && u <= 1
}

/**
 * 右侧区域卡片：整栋楼方案在当前楼层的各区域路线（只读展示）
 * 数据源恒为 activeBuildingPlan（buildingEvacuationPlans + activeBuildingPlanId），
 * 不再读 routeMatrix.perZone —— perZone 只是兼容投影。
 */
const zonePlanCards = computed(() => {
  const bp = store.activeBuildingPlan
  if (!bp || !Array.isArray(bp.routes)) return []
  const floorId = routeFloorId.value
  return bp.routes
    .filter((r) => r && r.floorId === floorId)
    .map((r) => ({
      zone: r.zone,
      color: ZONE_COLOR_MAP[r.zone] || '#4361EE',
      routeId: r.routeId,
      exitLabel: r.exitLabel || r.exitId,
      distance: Math.round(r.distance || 0),
      estimatedTime: r.estimatedTime,
      riskLevel: RISK_CN[r.riskLevel] || '低',
      personCount: r.personCount || 0,
      blocked: !r.valid,
    }))
})

const isRouteFloorOnFire = computed(() =>
  !!(store.fireEvent && store.fireEvent.floor === routeFloorId.value && store.fireEvent.building === currentBuildingName.value)
)
function isFireZone(zone) {
  return isRouteFloorOnFire.value && store.fireEvent.area === zone
}

// P1.6.1：人员按统一字段 buildingId / floorId / zone 计数（与 2D/3D 同一口径）
function personCount(zone) {
  return countPersonsInLocation(store.persons, {
    buildingId: BUILDING_NAME_TO_ID[currentBuildingName.value] || '',
    building: currentBuildingName.value,
    floorId: routeFloorId.value,
    zone,
  })
}

function onBuildingChange() {
  selFloor.value = floorOptions.value[0]
  fireFloor.value = floorOptions.value[0]
}
function generate() {
  // 整栋楼疏散：一次规划覆盖该楼全部「有人员的 floorId + zone」，A/B/C = 三种整栋楼策略
  const res = store.generateBuildingEvacuationPlans({ buildingId: selBuilding.value })
  if (!res || !res.plans.length) {
    // 整栋楼规划失败（如无人员数据）时回退旧的按楼层规划，保证页面仍可用
    store.generateRoutePlans({ buildingId: selBuilding.value, floorId: selFloor.value, targetExit: selExit.value })
  }
}
function pickZone(zone) {
  store.setSelectedZone(zone)
}
function viewZone(zone) {
  store.setSelectedZone(zone)
}
function setCurrent(zone, id) {
  if (id) store.setCurrentRoutePlan(zone, id)
}
function startFire() {
  // demo 模式：火情必须经后端状态机 START_FIRE，禁止本地模拟绕过状态机
  if (dataSource.isDemo) {
    demoStore.startFire()
    return
  }
  store.simulateRouteFire(currentBuildingName.value, fireFloor.value, fireArea.value)
}
function clearFire() {
  if (dataSource.isDemo) {
    demoStore.reset()
    return
  }
  store.clearRouteFire()
}

// 手动模式
function nodeById(id) {
  return store.routeNodes.find((n) => n.id === id) || { x: 0, y: 0 }
}
function onSvgClick(e) {
  const svg = e.currentTarget
  const pt = svg.createSVGPoint()
  pt.x = e.clientX
  pt.y = e.clientY
  const p = pt.matrixTransform(svg.getScreenCTM().inverse())
  store.addManualNode(Math.round(p.x), Math.round(p.y), 'waypoint')
}
function onMapClick() { /* 平面图点击交由房间/区域处理 */ }
function selectNode(id) {
  if (pendingNodeId.value && pendingNodeId.value !== id) {
    const a = nodeById(pendingNodeId.value)
    const b = nodeById(id)
    if ((a.x || a.y) && (b.x || b.y) && segHitsWall(a.x, a.y, b.x, b.y)) {
      showNotice('无法连接', '两个节点之间不存在可通行通道（穿墙/穿房间），请沿走廊重新选择节点', 'warning')
      pendingNodeId.value = null
      selectedNodeId.value = id
      return
    }
    store.toggleManualEdge(pendingNodeId.value)
    store.toggleManualEdge(id)
    pendingNodeId.value = null
  } else {
    pendingNodeId.value = id
  }
  selectedNodeId.value = id
}
function setStart() {
  if (selectedNodeId.value) store.setManualStart(selectedNodeId.value)
}
function setExit() {
  if (selectedNodeId.value) store.setManualExit(selectedNodeId.value)
}
function connectNodes() {
  if (selectedNodeId.value) {
    store.toggleManualEdge(selectedNodeId.value)
    pendingNodeId.value = selectedNodeId.value
  }
}
function saveManual() {
  const ok = store.routeEdges.every((e) => {
    const a = nodeById(e[0])
    const b = nodeById(e[1])
    return !(a.x || a.y) || !(b.x || b.y) || !segHitsWall(a.x, a.y, b.x, b.y)
  })
  if (!ok) {
    showNotice('路线非法', '存在穿越墙体/房间的连线，已禁止保存，请删除非法连线后重试', 'danger')
    return
  }
  store.saveManualRoute()
}
function clearManual() {
  store.clearManualRoute()
  selectedNodeId.value = null
  pendingNodeId.value = null
}

onMounted(() => {
  // 整栋楼方案是唯一权威数据源（routeMatrix 只是兼容投影）
  if (!store.buildingEvacuationPlans.length) generate()
})
</script>

<style scoped>
.route-plan-view {
  height: 100%;
  display: flex;
  flex-direction: column;
  padding: 12px;
  gap: 12px;
  overflow: hidden;
  background: transparent;
}
.rp-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-shrink: 0;
}
.rp-title {
  font-size: var(--fs-xl, 20px);
  font-weight: 700;
  color: var(--text-primary);
  letter-spacing: 1px;
  display: flex;
  align-items: baseline;
  gap: 12px;
}
.rp-sub {
  font-size: var(--fs-xs, 11px);
  font-weight: 400;
  color: var(--text-tertiary);
  letter-spacing: 0;
}
.mode-switch { display: flex; gap: 8px; }
.mode-btn {
  padding: 8px 18px;
  border: 1px solid rgba(76, 201, 240, 0.25);
  background: rgba(20, 30, 50, 0.55);
  color: var(--text-secondary);
  border-radius: 6px;
  font-size: var(--fs-sm, 13px);
  cursor: pointer;
  transition: all 0.2s;
}
.mode-btn.active { background: var(--fire-blue); color: #fff; border-color: var(--fire-blue); box-shadow: 0 2px 10px rgba(67,97,238,0.3); }

.rp-auto, .rp-manual { flex: 1; display: grid; gap: 12px; min-height: 0; }
.rp-auto { grid-template-columns: 260px 1fr 340px; }
.rp-manual { grid-template-columns: 260px 1fr; }

.rp-config { padding: 14px; overflow-y: auto; display: flex; flex-direction: column; gap: 10px; }
.form-row { display: flex; align-items: center; gap: 8px; }
.form-row label { width: 64px; font-size: var(--fs-sm, 13px); color: var(--text-secondary); flex-shrink: 0; }
.form-row select {
  flex: 1; padding: 7px 10px; border: 1px solid rgba(76, 201, 240, 0.25);
  border-radius: 6px; background: rgba(10, 14, 26, 0.85); color: var(--text-primary); font-size: var(--fs-sm, 13px); outline: none;
}
.form-row select option { background: #111827; color: var(--text-primary); }
.primary-btn, .danger-btn, .ghost-btn {
  padding: 9px 12px; border-radius: 6px; font-size: var(--fs-sm, 13px); cursor: pointer;
  border: 1px solid transparent; transition: all 0.2s; font-weight: 500;
}
.primary-btn { background: var(--fire-blue); color: #fff; }
.primary-btn:hover { filter: brightness(1.05); }
.primary-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.danger-btn { background: rgba(239, 68, 68, 0.1); color: #F87171; border-color: rgba(239, 68, 68, 0.55); }
.danger-btn:hover { background: var(--fire-red); color: #fff; }
.ghost-btn { background: rgba(20, 30, 50, 0.55); color: var(--text-secondary); border-color: rgba(76, 201, 240, 0.25); }
.ghost-btn:hover { border-color: var(--fire-blue); color: var(--fire-blue); }
.confirm-block {
  border: 1px dashed rgba(76, 201, 240, 0.35);
  border-radius: 8px;
  padding: 10px;
  background: rgba(76, 201, 240, 0.04);
  transition: all 0.3s;
}
.confirm-block.ready { border-color: rgba(76, 201, 240, 0.7); background: rgba(76, 201, 240, 0.08); box-shadow: 0 0 12px rgba(76, 201, 240, 0.15) inset; }
.confirm-btn {
  width: 100%;
  padding: 11px 12px;
  border-radius: 6px;
  font-size: var(--fs-sm, 13px);
  font-weight: 700;
  cursor: pointer;
  border: 1px solid rgba(76, 201, 240, 0.5);
  background: linear-gradient(135deg, #4361EE, #4CC9F0);
  color: #0A0E1A;
  letter-spacing: 0.5px;
  transition: all 0.2s;
}
.confirm-btn:hover:not(:disabled) { filter: brightness(1.1); box-shadow: 0 4px 14px rgba(76, 201, 240, 0.3); }
.confirm-btn:disabled { opacity: 0.35; cursor: not-allowed; }
.confirmed-tip {
  padding: 9px 10px;
  border-radius: 6px;
  border: 1px solid rgba(34, 197, 94, 0.45);
  background: rgba(34, 197, 94, 0.08);
  color: #4ADE80;
  font-size: var(--fs-sm, 13px);
  font-weight: 600;
}

.page-notice {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
  padding: 9px 14px;
  border-radius: 8px;
  font-size: var(--fs-sm, 13px);
  border: 1px solid rgba(245, 158, 11, 0.45);
  background: rgba(245, 158, 11, 0.08);
}
.page-notice.notice-danger { border-color: rgba(239, 68, 68, 0.5); background: rgba(239, 68, 68, 0.08); }
.notice-title { font-weight: 700; color: #FBBF24; }
.page-notice.notice-danger .notice-title { color: #F87171; }
.notice-text { color: var(--text-secondary); flex: 1; }
.notice-close {
  border: 1px solid rgba(148, 163, 184, 0.35);
  background: transparent;
  color: var(--text-tertiary);
  border-radius: 5px;
  padding: 3px 10px;
  font-size: var(--fs-xs, 11px);
  cursor: pointer;
  transition: all 0.2s;
}
.notice-close:hover { color: var(--text-primary); border-color: var(--fire-blue); }

.divider { height: 1px; background: rgba(76, 201, 240, 0.12); margin: 4px 0; }
.tip-text { font-size: var(--fs-xs, 11px); color: var(--text-secondary); line-height: 1.6; }
.tip-text strong { color: var(--fire-blue); }

.rp-map { padding: 12px; display: flex; flex-direction: column; gap: 8px; min-height: 0; overflow: hidden; }
.debug-btn { padding: 5px 12px; border: 1px solid rgba(34,197,94,0.4); background: rgba(20,30,50,0.6); color: #4ADE80; border-radius: 6px; font-size: var(--fs-xs, 11px); cursor: pointer; font-weight: 600; transition: all 0.2s; }
.debug-btn:hover { border-color: #22C55E; }
.debug-btn.active { background: #22C55E; color: #fff; border-color: #22C55E; }
.net-debug { pointer-events: none; }
.floor-svg {
  flex: 1; width: 100%; min-height: 0;
  background:
    linear-gradient(rgba(67,97,238,0.03) 1px, transparent 1px) 0 0 / 28px 28px,
    linear-gradient(90deg, rgba(67,97,238,0.03) 1px, transparent 1px) 0 0 / 28px 28px;
  border-radius: 6px;
}
.room { fill: rgba(67,97,238,0.04); stroke: rgba(67,97,238,0.25); stroke-width: 1; cursor: pointer; transition: fill 0.2s; }
.room.sel { fill: rgba(67,97,238,0.12); stroke: var(--fire-blue); stroke-width: 2; }
.room.fire { fill: rgba(239,68,68,0.18); stroke: #EF4444; stroke-width: 2; }
.room-label, .stair-label, .exit-label, .node-text { font-size: 10px; fill: var(--text-secondary); font-weight: 600; }
.stair { fill: rgba(34,197,94,0.1); stroke: #22C55E; stroke-width: 1; }
.exit-node { fill: #22C55E; opacity: 0.9; }
.zone-route { fill: none; stroke-width: 3; stroke-linecap: round; stroke-linejoin: round; opacity: 0.45; }
.zone-route.active { stroke-width: 4; opacity: 1; filter: drop-shadow(0 0 4px currentColor); }
.zone-start { opacity: 0.9; }
.manual-edge { stroke: #4361EE; stroke-width: 2.5; stroke-dasharray: 4 3; }
.manual-node { fill: #141E32; stroke: #4CC9F0; stroke-width: 2; cursor: pointer; }
.manual-node.selected { fill: #4361EE; }
.manual-node.pending { stroke-dasharray: 3 2; }
.manual-node.start { fill: #22C55E; stroke: #16A34A; }
.manual-node.exit { fill: #F59E0B; stroke: #EA580C; }

.rp-plans { padding: 12px; overflow-y: auto; display: flex; flex-direction: column; gap: 10px; min-height: 0; }
.panel-title-bar { display: flex; align-items: center; justify-content: space-between; flex-shrink: 0; }
.panel-title { font-size: var(--fs-md, 14px); font-weight: 700; color: var(--text-primary); letter-spacing: 0.5px; }
.legend { display: flex; gap: 6px; }
.legend i.lg { width: 14px; height: 4px; border-radius: 2px; }
.empty-tip { color: var(--text-tertiary); font-size: var(--fs-sm, 13px); text-align: center; padding: 30px 0; }
.rp-plan-scope { margin-left: auto; font-size: var(--fs-xs, 11px); color: var(--text-secondary); opacity: 0.85; }
.rp-building-tip { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; font-size: var(--fs-xs, 11px); color: var(--text-secondary); }
.rp-building-tip .bp-scope { color: #4ADE80; font-weight: 700; }
.rp-building-tip .bp-stat { opacity: 0.8; }
.bp-chips { display: flex; gap: 4px; margin-left: auto; }
.bp-chip { padding: 3px 8px; border: 1px solid rgba(76,201,240,0.3); background: rgba(20,30,50,0.6); color: var(--text-secondary); border-radius: 4px; font-size: var(--fs-xs, 11px); cursor: pointer; }
.bp-chip:hover { border-color: var(--fire-blue); color: var(--text-primary); }
.bp-chip.active { border-color: #4ADE80; background: rgba(34,197,94,0.16); color: #4ADE80; font-weight: 700; }

.zone-card { border: 1px solid rgba(76, 201, 240, 0.18); border-radius: 8px; padding: 10px; background: rgba(15, 23, 42, 0.55); cursor: pointer; transition: all 0.2s; }
.zone-card:hover { border-color: var(--fire-blue); box-shadow: 0 2px 12px rgba(67,97,238,0.15); }
.zone-card.active { border-color: var(--fire-blue); border-width: 2px; }
.zone-card.blocked { opacity: 0.8; border-color: rgba(239,68,68,0.4); background: rgba(239,68,68,0.03); }
.zone-head { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; }
.zone-dot { width: 10px; height: 10px; border-radius: 50%; }
.zone-name { font-size: var(--fs-md, 14px); font-weight: 700; color: var(--text-primary); }
.zone-persons { font-size: var(--fs-tiny, 10px); color: var(--text-tertiary); margin-left: auto; }
.tag { font-size: var(--fs-tiny, 10px); padding: 1px 6px; border-radius: 3px; }
.tag.blk { background: rgba(239,68,68,0.15); color: #EF4444; }
.zone-rec, .zone-bak { display: flex; align-items: center; gap: 6px; font-size: var(--fs-xs, 11px); margin-top: 4px; flex-wrap: wrap; }
.rec-label, .bak-label { background: rgba(67,97,238,0.12); color: var(--fire-blue); padding: 1px 6px; border-radius: 3px; font-weight: 600; }
.bak-label { background: rgba(148,163,184,0.15); color: #64748B; }
.rec-name, .bak-name { font-weight: 600; color: var(--text-primary); }
.rec-meta { color: var(--text-tertiary); }
.rec-score { margin-left: auto; color: #F59E0B; font-weight: 700; }
.zone-actions { display: flex; gap: 6px; margin-top: 8px; }
.mini-btn { flex: 1; padding: 6px; border-radius: 5px; font-size: var(--fs-xs, 11px); border: 1px solid rgba(76, 201, 240, 0.25); background: rgba(20, 30, 50, 0.55); color: var(--text-secondary); cursor: pointer; }
.mini-btn.primary { background: var(--fire-blue); color: #fff; border-color: var(--fire-blue); }
.mini-btn:hover { filter: brightness(1.05); }
</style>

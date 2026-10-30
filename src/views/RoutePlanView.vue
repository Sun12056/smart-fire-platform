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
        <!-- RW-3（方案 B）：刷新后仅存整栋楼路线投影、无当前方案上下文 —— 地图所画为历史路线 -->
        <div
          v-if="store.hasStaleRoutesWithoutActivePlan"
          class="rp-stale-tip"
          title="地图所示为本轮刷新前保存的路线，非当前有效方案"
        >⚠️ 历史路线，请重新规划</div>
        <!-- 整栋楼疏散：火灾只描述位置，疏散范围覆盖全部有人的楼层+区域 -->
        <div v-if="buildingSummary" class="rp-building-tip">
          <span class="bp-scope">疏散范围：整栋楼</span>
          <span class="bp-stat">{{ buildingSummary.zoneCount }} 区 / {{ buildingSummary.personCount }} 人 / 最慢 {{ buildingSummary.maxEstimatedTime }}s</span>
          <span class="bp-chips">
            <button
              v-for="bp in store.buildingEvacuationPlans" :key="bp.id"
              class="bp-chip" :class="{ active: bp.id === store.activeBuildingPlanId }"
              @click.stop="store.selectBuildingPlan(bp.id)"
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
          :class="['zone-card', { active: store.selectedZone===z.zone, blocked: z.blocked, unknown: z.unknown }]"
          @click="store.setSelectedZone(z.zone)"
        >
          <div class="zone-head">
            <span class="zone-dot" :style="{ background: z.color }"></span>
            <span class="zone-name">{{ routeFloorId }} {{ z.zone }}</span>
            <span class="zone-persons">👤 {{ z.personCount }} 人</span>
            <span v-if="z.blocked" class="tag blk">❌ 无安全路线</span>
            <span v-else-if="z.unknown" class="tag unk">⚠️ 状态未知</span>
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
      <!-- 左：权威图选点（可执行路线） -->
      <div class="rp-config fire-card">
        <div class="panel-title-bar"><span class="panel-title">权威图选点 · 可执行路线</span></div>
        <div class="form-row">
          <label>楼栋</label>
          <select v-model="selBuilding" @change="onBuildingChange">
            <option v-for="b in buildingOptions" :key="b.id" :value="b.id">{{ b.name }}</option>
          </select>
        </div>
        <p v-if="!authGraph" class="tip-text auth-fail">⚠️ 当前楼栋无法识别或权威图构建失败，已禁止选点。</p>
        <template v-else>
          <div class="panel-title-bar"><span class="panel-title">1. 选择起点（房间 / 门）</span></div>
          <div class="auth-node-list">
            <button
              v-for="n in authStartNodes" :key="n.id"
              class="auth-node-chip" :class="{ active: isPathStart(n.id), locked: authPath.length }"
              :disabled="authPath.length > 0"
              @click="pickStart(n.id)"
            >{{ n.floorId }} · {{ n.label }}</button>
          </div>

          <div class="panel-title-bar"><span class="panel-title">当前路径（{{ authPath.length }} 节点）</span></div>
          <div class="auth-path">
            <template v-if="authPath.length">
              <span v-for="(id, i) in authPath" :key="id" class="auth-path-chip">
                <i>{{ authNodeLabel(id) }}</i><span v-if="i < authPath.length - 1" class="auth-arrow">→</span>
              </span>
            </template>
            <span v-else class="tip-text">尚未选择起点</span>
          </div>

          <div v-if="authPath.length && !isPathComplete" class="panel-title-bar"><span class="panel-title">2. 下一步可选（真实邻接）</span></div>
          <div v-if="authPath.length && !isPathComplete" class="auth-node-list">
            <button v-for="n in authNextNodes" :key="n.id" class="auth-node-chip next" @click="appendNode(n.id)">
              {{ n.floorId }} · {{ n.label }}<span class="auth-type">{{ typeLabel(n.type) }}</span>
            </button>
          </div>
          <div v-if="isPathComplete" class="auth-done-tip">✓ 已达规范出口，可保存。</div>

          <div class="auth-actions">
            <button class="ghost-btn" :disabled="authPath.length <= 1" @click="undoStep">撤销上一步</button>
            <button class="ghost-btn" @click="cancelEdit">取消编辑</button>
            <button class="primary-btn" :disabled="!isPathComplete" @click="saveAuth">保存为可执行路线</button>
          </div>
          <p v-if="authGraphDraftId" class="tip-text">正在编辑 {{ authGraphDraftId }}（保存将按 ID 替换）</p>
        </template>
      </div>

      <!-- 中：地图（权威图 + 选点路径 + 自由绘制草稿叠加） -->
      <div class="rp-map fire-card" style="flex: 1;">
        <div class="panel-title-bar">
          <span class="panel-title">{{ currentBuildingName }} · {{ selFloor }} 手动编辑</span>
          <select v-model="selFloor" class="floor-mini">
            <option v-for="f in floorOptions" :key="f" :value="f">{{ f }}</option>
          </select>
        </div>
        <svg class="floor-svg" viewBox="0 0 560 300" preserveAspectRatio="xMidYMid meet" @click="onSvgClick">
          <rect x="60" y="150" width="440" height="40" fill="rgba(67,97,238,0.05)" stroke="rgba(67,97,238,0.2)"/>
          <g class="rooms">
            <rect x="90" y="28" width="105" height="120" rx="2" class="room"/>
            <rect x="90" y="210" width="105" height="70" rx="2" class="room"/>
            <rect x="375" y="28" width="80" height="120" rx="2" class="room"/>
            <rect x="375" y="210" width="80" height="70" rx="2" class="room"/>
          </g>
          <!-- 权威图（当前楼层）节点与边 -->
          <g class="auth-net">
            <line v-for="(e, i) in authGraphFloorEdges" :key="'ae' + i" :x1="e.x1" :y1="e.y1" :x2="e.x2" :y2="e.y2" class="auth-edge" />
            <circle v-for="n in authGraphFloorNodes" :key="'an' + n.id" :cx="n.x" :cy="n.y" r="4" :fill="nodeTypeColor(n.type)" stroke="#fff" stroke-width="0.5" />
          </g>
          <!-- 权威图已选路径（当前楼层） -->
          <polyline v-if="authPathOnFloor.length" :points="authPathOnFloor.map(p=>p.x+','+p.y).join(' ')" class="auth-path-line" />
          <circle v-for="n in authPathOnFloor" :key="'ap' + n.id" :cx="n.x" :cy="n.y" r="7" class="auth-path-node" />
          <!-- 自由绘制草稿 -->
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
        </svg>
      </div>

      <!-- 右：自由绘制草稿 + 已保存可执行路线 -->
      <div class="rp-manual-side">
        <div class="fire-card side-card">
          <div class="panel-title-bar"><span class="panel-title">自由绘制（草稿）</span></div>
          <p class="tip-text">点击空白处添加节点；点击节点连线。仅生成草稿，不进入可执行路线。</p>
          <button class="primary-btn" @click="saveManual">保存草稿</button>
          <button class="danger-btn" @click="clearManual">清空画布</button>
          <div v-if="store.manualRouteDrafts.length" class="side-list">
            <div v-for="d in store.manualRouteDrafts" :key="d.id" class="side-row">
              <span class="side-name">{{ d.name }} · {{ d.startFloor }}</span>
              <button class="mini-btn" @click="store.deleteManualRouteDraft(d.id)">删除</button>
            </div>
          </div>
        </div>
        <div class="fire-card side-card">
          <div class="panel-title-bar"><span class="panel-title">已保存可执行路线（{{ store.manualExecutableRoutes.length }}）</span></div>
          <!-- K-1B.5：状态筛选（只读，AND 组合）+ JSON 导出 -->
          <div class="route-filter">
            <select v-model="filterTopology" class="filter-select">
              <option value="">拓扑：全部</option>
              <option value="VALID">拓扑：有效</option>
              <option value="INVALID">拓扑：无效</option>
              <option value="BUILDING_UNAVAILABLE">拓扑：无法验证楼栋</option>
            </select>
            <select v-model="filterExit" class="filter-select">
              <option value="">出口：全部</option>
              <option value="AVAILABLE">出口：可用</option>
              <option value="UNAVAILABLE">出口：不可用</option>
              <option value="UNKNOWN">出口：未知</option>
            </select>
            <button class="mini-btn primary" :disabled="filteredRoutes.length === 0" @click="exportRoutes">
              导出 JSON（{{ filteredRoutes.length }} 条）
            </button>
          </div>
          <div v-if="!store.manualExecutableRoutes.length" class="empty-tip">暂无手动可执行路线</div>
          <div v-else-if="!filteredRoutes.length" class="empty-tip">无符合筛选条件的路线</div>
          <div v-for="r in filteredRoutes" :key="r.id" class="side-list">
            <div class="side-row">
              <span class="side-name">{{ r.id }}</span>
              <span class="side-meta">{{ r.nodes.length }} 节点 · 出口 {{ r.exitId }}</span>
            </div>
            <!-- K-1B.4：只读状态展示（消费 manualRouteStatusView，不回写路线对象） -->
            <div class="route-status">
              <span class="status-badge" :class="topologyBadge(statusOf(r.id).topologyStatus)">
                拓扑：{{ topologyText(statusOf(r.id).topologyStatus) }}
              </span>
              <span class="status-badge" :class="exitBadge(statusOf(r.id).exitStatus)">
                出口：{{ exitText(statusOf(r.id).exitStatus) }}
              </span>
            </div>
            <div v-if="statusOf(r.id).topologyReason" class="status-reason">
              拓扑原因：{{ reasonText(statusOf(r.id).topologyReason) }}
            </div>
            <div v-if="statusOf(r.id).exitReason" class="status-reason">
              出口原因：{{ reasonText(statusOf(r.id).exitReason) }}
            </div>
            <div class="side-actions">
              <button class="mini-btn" @click="editRoute(r.id)">编辑</button>
              <button class="mini-btn danger" @click="store.deleteManualExecutableRoute(r.id)">删除</button>
            </div>
          </div>
        </div>
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
// P1.7.3-B3：火灾判定同样只认 canonical（buildingId / floorId / zone）
import {
  countPersonsInLocation, BUILDING_NAME_TO_ID, buildingIdOf, floorIdOf, zoneOf,
} from '../../shared/person/personRuntime.js'

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
    .map((r) => {
      // P1.8.2 K-4：运行时状态一律取自权威投影 routePlans（经 reconcileRouteStatuses 协调）
      const proj = store.getRoutePlanById(r.routeId)
      const status = proj ? proj.status : null
      const blocked = !r.valid || status === 'BLOCKED'
      return {
        zone: r.zone,
        color: ZONE_COLOR_MAP[r.zone] || '#4361EE',
        routeId: r.routeId,
        exitLabel: r.exitLabel || r.exitId,
        distance: Math.round(r.distance || 0),
        estimatedTime: r.estimatedTime,
        riskLevel: RISK_CN[r.riskLevel] || '低',
        personCount: r.personCount || 0,
        blocked,
        // 三态语义：投影未命中 / 状态缺失 ⇒ 未知（既不判「正常」也不判「阻断」）
        unknown: !blocked && (status === null || status === undefined),
      }
    })
})

// P1.7.3-B3：canonical 火源判定（buildingId / floorId / zone），别名不再参与
const fireLoc = computed(() => {
  const fe = store.fireEvent
  return fe ? { buildingId: buildingIdOf(fe), floorId: floorIdOf(fe), zone: zoneOf(fe) } : null
})
const isRouteFloorOnFire = computed(() => {
  const loc = fireLoc.value
  const bid = BUILDING_NAME_TO_ID[currentBuildingName.value] || ''
  return !!(loc && loc.floorId === routeFloorId.value && loc.buildingId && loc.buildingId === bid)
})
function isFireZone(zone) {
  const loc = fireLoc.value
  return isRouteFloorOnFire.value && !!loc && loc.zone === zone
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
  // K-1B.2.1：权威图跟随「当前选定楼栋」；选点编辑态的重置统一由 store 内
  // watch(routeBuildingId) 负责，此处只同步当前楼栋，不再各自实现清理逻辑。
  store.routeBuildingId = selBuilding.value
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

// ════════════════════════════════════════════════════════════════
// K-1B.2：权威图选点（沿真实邻接逐节点选点）
// ════════════════════════════════════════════════════════════════
const authGraph = computed(() => store.authoritativeRouteGraph)
const authPath = computed(() => store.authGraphPath || [])
const authGraphDraftId = computed(() => store.authGraphDraftId)

// 起点候选：权威图中 type 为 ROOM 或 DOOR 的节点（按楼层 + key 排序）
const authStartNodes = computed(() => {
  const g = authGraph.value
  if (!g || !g.nodes) return []
  return Object.values(g.nodes)
    .filter((n) => store.isAuthStartNode(n.id))
    .sort((a, b) => a.floorId.localeCompare(b.floorId) || a.key.localeCompare(b.key))
})

// 当前节点真实邻接（graph.adj[currentNodeId]），供「继续选点」
const authNextNodes = computed(() => {
  const g = authGraph.value
  const path = authPath.value
  if (!g || !path.length) return []
  const last = path[path.length - 1]
  return store.authAdjacentNodeIds(last)
    .map((id) => g.nodes[id])
    .filter(Boolean)
    .sort((a, b) => a.floorId.localeCompare(b.floorId) || a.key.localeCompare(b.key))
})

// 终点是否已落在规范出口节点集合
const isPathComplete = computed(() => {
  const path = authPath.value
  return path.length >= 2 && store.isAuthExitNode(path[path.length - 1])
})

// 当前楼层权威图（仅渲染 selFloor 的节点与同层边）
const authGraphFloorNodes = computed(() => {
  const g = authGraph.value
  if (!g || !g.nodes) return []
  return Object.values(g.nodes).filter((n) => n.floorId === selFloor.value)
})
const authGraphFloorEdges = computed(() => {
  const g = authGraph.value
  if (!g || !g.adj) return []
  const onFloor = new Set(authGraphFloorNodes.value.map((n) => n.id))
  const seen = new Set()
  const out = []
  Object.entries(g.adj).forEach(([from, arr]) => {
    if (!onFloor.has(from)) return
    arr.forEach((e) => {
      if (!onFloor.has(e.to)) return
      const ek = [from, e.to].sort().join('|')
      if (seen.has(ek)) return
      seen.add(ek)
      out.push({ x1: g.nodes[from].x, y1: g.nodes[from].y, x2: g.nodes[e.to].x, y2: g.nodes[e.to].y })
    })
  })
  return out
})
// 权威图已选路径中落在当前楼层的节点（用于可视化）
const authPathOnFloor = computed(() => {
  const g = authGraph.value
  return authPath.value.map((id) => (g && g.nodes ? g.nodes[id] : null)).filter((n) => n && n.floorId === selFloor.value)
})

function authNodeLabel(id) {
  const g = authGraph.value
  const n = g && g.nodes ? g.nodes[id] : null
  return n ? `${n.floorId}·${n.label || n.key}` : id
}
function typeLabel(t) {
  return { room: '门', door: '门', corridor: '廊', stair: '梯', exit: '出' }[t] || t
}
function isPathStart(id) {
  return authPath.value[0] === id
}
function pickStart(id) {
  if (authPath.value.length) return
  if (!store.pickAuthGraphStart(id)) {
    showNotice('无法选择起点', '仅允许选择房间 / 门节点作为起点', 'warning')
  }
}
function appendNode(id) {
  const ok = store.appendAuthGraphNode(id)
  if (!ok) {
    showNotice('无法选点', '目标节点与当前节点不邻接（或不存在合法下降边）', 'warning')
  }
}
function undoStep() {
  store.undoAuthGraphStep()
}
function cancelEdit() {
  store.cancelAuthGraphSelection()
}
function saveAuth() {
  const res = store.saveAuthGraphRoute()
  if (!res.ok) {
    showNotice('保存失败', authErrText(res.reason), 'danger')
  } else {
    showNotice('已保存', '手动可执行路线已保存', 'success')
  }
}
function editRoute(id) {
  store.loadAuthGraphRouteForEdit(id)
}
function authErrText(reason) {
  return {
    AUTH_GRAPH_UNAVAILABLE: '当前楼栋无法识别或权威图构建失败',
    PATH_TOO_SHORT: '路径节点不足',
    INVALID_START_TYPE: '起点必须是房间或门节点',
    NOT_ADJACENT: '存在不邻接的节点（非法跨层或跳跃）',
    INVALID_EXIT: '终点必须属于规范出口节点',
    UNKNOWN_NODE: '存在未知节点',
    DUPLICATE_ID: '路线 ID 重复',
    REPLACE_NOT_FOUND: '未找到待替换的路线',
  }[reason] || reason
}

// ════════════════════════════════════════════════════════════════
// K-1B.4：只读状态展示（消费 store.manualRouteStatusView，绝不回写路线）
// ════════════════════════════════════════════════════════════════
const routeStatusMap = computed(() => {
  const m = {}
  ;(store.manualRouteStatusView || []).forEach((s) => { if (s && s.id) m[s.id] = s })
  return m
})
function statusOf(id) {
  return routeStatusMap.value[id]
    || { topologyStatus: null, topologyReason: null, exitStatus: null, exitReason: null }
}
// 两个独立维度，不合并为单一布尔/「可执行」结论
const TOPOLOGY_TEXT = { VALID: '有效', INVALID: '无效', BUILDING_UNAVAILABLE: '无法验证楼栋' }
const EXIT_TEXT = { AVAILABLE: '可用', UNAVAILABLE: '不可用', UNKNOWN: '未知/尚无上报' }
const REASON_TEXT = {
  NO_EXIT_RUNTIME: '尚无出口上报', NO_EXIT_ID: '缺少出口 ID', EXIT_NOT_REPORTED_USABLE: '出口未上报为可用',
  BUILDING_MISSING: '缺少所属楼栋', BUILDING_NOT_FOUND: '所属楼栋不存在',
  BUILDING_FLOORS_INVALID: '楼栋层数非法', BUILDING_GRAPH_FAILED: '楼栋图构建失败',
  PATH_TOO_SHORT: '路径节点不足', INVALID_START_TYPE: '起点类型非法', UNKNOWN_NODE: '存在未知节点',
  NOT_ADJACENT: '存在不邻接节点', INVALID_EXIT: '终点非规范出口',
  EXIT_ID_MISMATCH: '出口 ID 与终点不一致', INVALID_ROUTE_OBJECT: '路线对象非法',
}
function topologyText(s) { return TOPOLOGY_TEXT[s] || '状态未知' }
function exitText(s) { return EXIT_TEXT[s] || '状态未知' }
function topologyBadge(s) { return { VALID: 'ok', INVALID: 'bad', BUILDING_UNAVAILABLE: 'warn' }[s] || 'unknown' }
function exitBadge(s) { return { AVAILABLE: 'ok', UNAVAILABLE: 'bad', UNKNOWN: 'unknown' }[s] || 'unknown' }
function reasonText(r) { return (r && REASON_TEXT[r]) || r || '' }

// ════════════════════════════════════════════════════════════════
// K-1B.5：状态筛选（只读，AND 组合）+ JSON 导出
// ════════════════════════════════════════════════════════════════
const filterTopology = ref('') // '' = 全部
const filterExit = ref('')     // '' = 全部
const filteredRoutes = computed(() => {
  return store.manualExecutableRoutes.filter((r) => {
    const s = statusOf(r.id)
    if (filterTopology.value && s.topologyStatus !== filterTopology.value) return false
    if (filterExit.value && s.exitStatus !== filterExit.value) return false
    return true
  })
})
/** 构建导出载荷：原始字段来自 manualExecutableRoutes，状态字段来自 manualRouteStatusView（按 id 关联） */
function buildExportPayload() {
  const routes = filteredRoutes.value.map((r) => {
    const s = statusOf(r.id)
    const item = {
      id: r.id,
      buildingId: r.buildingId,
      startNode: r.startNode,
      exitId: r.exitId,
      nodes: Array.isArray(r.nodes) ? r.nodes.slice() : [],
      topologyStatus: s.topologyStatus ?? null,
      topologyReason: s.topologyReason ?? null,
      exitStatus: s.exitStatus ?? null,
      exitReason: s.exitReason ?? null,
    }
    // 仅当真实存在时间字段时才导出，不臆造字段名
    if (r.createdAt !== undefined && r.createdAt !== null) item.routeCreatedAt = r.createdAt
    if (r.updatedAt !== undefined && r.updatedAt !== null) item.routeUpdatedAt = r.updatedAt
    return item
  })
  return {
    exportedAt: new Date().toISOString(),
    scope: 'filtered',
    totalRoutes: routes.length,
    filter: { topologyStatus: filterTopology.value || null, exitStatus: filterExit.value || null },
    routes,
  }
}
/** 浏览器原生下载 JSON；不新增依赖，不写回路线/store/持久化 */
function exportRoutes() {
  if (!filteredRoutes.value.length) return
  const json = JSON.stringify(buildExportPayload(), null, 2)
  const blob = new Blob([json], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `manual-routes-${new Date().toISOString().slice(0, 10)}.json`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  // 延迟释放对象 URL，避免过早回收导致下载失败
  setTimeout(() => URL.revokeObjectURL(url), 1000)
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
.rp-manual { grid-template-columns: 280px 1fr 320px; }

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
/* RW-3（方案 B）：历史路线提示 —— 纯展示态，不参与任何门禁 */
.rp-stale-tip {
  padding: 5px 10px; border: 1px solid rgba(245,158,11,0.45); border-radius: 6px;
  background: rgba(245,158,11,0.10); color: #F59E0B;
  font-size: var(--fs-xs, 11px); font-weight: 700;
}
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
/* P1.8.2 K-4：状态未知（投影未命中 / 状态缺失）—— 视觉上区别于阻断与正常 */
.zone-card.unknown { border-color: rgba(148,163,184,0.4); border-style: dashed; background: rgba(148,163,184,0.04); }
.zone-head { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; }
.zone-dot { width: 10px; height: 10px; border-radius: 50%; }
.zone-name { font-size: var(--fs-md, 14px); font-weight: 700; color: var(--text-primary); }
.zone-persons { font-size: var(--fs-tiny, 10px); color: var(--text-tertiary); margin-left: auto; }
.tag { font-size: var(--fs-tiny, 10px); padding: 1px 6px; border-radius: 3px; }
.tag.blk { background: rgba(239,68,68,0.15); color: #EF4444; }
.tag.unk { background: rgba(148,163,184,0.15); color: #94A3B8; }
.zone-rec, .zone-bak { display: flex; align-items: center; gap: 6px; font-size: var(--fs-xs, 11px); margin-top: 4px; flex-wrap: wrap; }
.rec-label, .bak-label { background: rgba(67,97,238,0.12); color: var(--fire-blue); padding: 1px 6px; border-radius: 3px; font-weight: 600; }
.bak-label { background: rgba(148,163,184,0.15); color: #64748B; }
.rec-name, .bak-name { font-weight: 600; color: var(--text-primary); }
.rec-meta { color: var(--text-tertiary); }
.rec-score { margin-left: auto; color: #F59E0B; font-weight: 700; }
.zone-actions { display: flex; gap: 6px; margin-top: 8px; }
.mini-btn { flex: 1; padding: 6px; border-radius: 5px; font-size: var(--fs-xs, 11px); border: 1px solid rgba(76, 201, 240, 0.25); background: rgba(20, 30, 50, 0.55); color: var(--text-secondary); cursor: pointer; }
.mini-btn.primary { background: var(--fire-blue); color: #fff; border-color: var(--fire-blue); }
.mini-btn.danger { color: #F87171; border-color: rgba(239, 68, 68, 0.45); }
.mini-btn:hover { filter: brightness(1.05); }
.mini-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.mini-btn:disabled:hover { filter: none; }

/* ══════ K-1B.5 状态筛选 ══════ */
.route-filter { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.filter-select {
  flex: 1; min-width: 0; padding: 5px 6px; border-radius: 5px; font-size: var(--fs-tiny, 10px);
  border: 1px solid rgba(76, 201, 240, 0.25); background: rgba(10, 14, 26, 0.85); color: var(--text-primary); outline: none;
}
.filter-select option { background: #111827; color: var(--text-primary); }

/* ══════════ K-1B.2 权威图选点 ══════════ */
.auth-fail { color: #F87171; }
.auth-node-list { display: flex; flex-wrap: wrap; gap: 5px; max-height: 168px; overflow-y: auto; }
.auth-node-chip {
  padding: 4px 8px; border-radius: 5px; font-size: var(--fs-xs, 11px); cursor: pointer;
  border: 1px solid rgba(76, 201, 240, 0.25); background: rgba(20, 30, 50, 0.55); color: var(--text-secondary);
  transition: all 0.15s; text-align: left;
}
.auth-node-chip:hover:not(:disabled) { border-color: var(--fire-blue); color: var(--text-primary); }
.auth-node-chip:disabled { opacity: 0.4; cursor: not-allowed; }
.auth-node-chip.active { border-color: var(--fire-blue); background: rgba(67,97,238,0.16); color: var(--text-primary); }
.auth-node-chip.next { border-color: rgba(34,197,94,0.45); color: #4ADE80; }
.auth-node-chip .auth-type { margin-left: 4px; opacity: 0.7; font-size: var(--fs-tiny, 10px); }
.auth-path { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
.auth-path-chip {
  display: inline-flex; align-items: center; gap: 4px; padding: 3px 7px; border-radius: 5px;
  background: rgba(67,97,238,0.12); color: var(--fire-blue); font-size: var(--fs-xs, 11px); font-weight: 600;
}
.auth-arrow { color: var(--text-tertiary); }
.auth-done-tip { color: #4ADE80; font-size: var(--fs-xs, 11px); font-weight: 600; }
.auth-actions { display: flex; gap: 6px; flex-wrap: wrap; }
.auth-actions .ghost-btn, .auth-actions .primary-btn { flex: 1; }
.auth-net { pointer-events: none; }
.auth-edge { stroke: rgba(34,197,94,0.28); stroke-width: 1; }
.auth-path-line { fill: none; stroke: #F59E0B; stroke-width: 3; stroke-linecap: round; stroke-linejoin: round; filter: drop-shadow(0 0 4px rgba(245,158,11,0.5)); }
.auth-path-node { fill: #F59E0B; stroke: #fff; stroke-width: 1.5; }
.floor-mini {
  padding: 4px 8px; border: 1px solid rgba(76, 201, 240, 0.25); border-radius: 5px;
  background: rgba(10, 14, 26, 0.85); color: var(--text-primary); font-size: var(--fs-xs, 11px); outline: none;
}
.rp-manual-side { padding: 0; display: flex; flex-direction: column; gap: 12px; min-height: 0; overflow-y: auto; }
.side-card { padding: 12px; display: flex; flex-direction: column; gap: 8px; }
.side-list { display: flex; flex-direction: column; gap: 4px; border-top: 1px solid rgba(76,201,240,0.1); padding-top: 6px; }
.side-row { display: flex; align-items: center; gap: 8px; }
.side-name { font-size: var(--fs-xs, 11px); color: var(--text-primary); font-weight: 600; word-break: break-all; }
.side-meta { font-size: var(--fs-tiny, 10px); color: var(--text-tertiary); }
.side-actions { display: flex; gap: 6px; margin-top: 2px; }

/* ══════ K-1B.4 只读状态展示 ══════ */
.route-status { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 4px; }
.status-badge {
  padding: 2px 7px; border-radius: 4px; font-size: var(--fs-tiny, 10px); font-weight: 600;
  border: 1px solid rgba(148, 163, 184, 0.35); color: var(--text-secondary);
}
.status-badge.ok { border-color: rgba(34, 197, 94, 0.45); color: #4ADE80; background: rgba(34, 197, 94, 0.08); }
.status-badge.bad { border-color: rgba(239, 68, 68, 0.5); color: #F87171; background: rgba(239, 68, 68, 0.08); }
.status-badge.warn { border-color: rgba(245, 158, 11, 0.5); color: #FBBF24; background: rgba(245, 158, 11, 0.08); }
.status-badge.unknown { border-color: rgba(148, 163, 184, 0.4); color: #94A3B8; border-style: dashed; }
.status-reason { font-size: var(--fs-tiny, 10px); color: var(--text-tertiary); line-height: 1.5; }
</style>

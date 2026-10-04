// Demo Simulation Engine 的运行时世界状态（仅存于 Durable Object 内存 / DO Storage；
// D1 只保存业务与历史数据，实时状态一律不落 D1）

export interface DemoScenario {
  buildingId: string
  buildingName: string
  floorId: string
  zone: string
}

// ── 整栋楼疏散方案（scope = BUILDING） ──
// fireEvent 只描述火灾位置；一次火灾 = 一栋楼的一次整体疏散任务。
// PLAN-A/B/C 是三种整栋楼策略（均衡/快速/安全），每套内部为每个「有人的 floorId+zone」生成一条路线。
export interface EvacuationRoute {
  routeId: string          // `${planId}:${floorId}:${zone}` —— 后端下发与前端/3D 消费同一个 id
  floorId: string
  zone: string
  startNode: string
  exitId: string
  exitLabel: string
  nodes: string[]
  points: Array<{ x: number; y: number }>
  distance: number
  estimatedTime: number
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH'
  valid: boolean
  reasons: string[]
  floorsPassed: string[]
  personCount: number
}

export interface BuildingEvacuationPlan {
  id: string
  name: string
  buildingId: string
  buildingName: string
  scope: 'BUILDING'
  strategy: 'BALANCED' | 'FASTEST' | 'SAFEST'
  strategyLabel: string
  fire: { buildingId: string; floorId: string; zone: string } | null
  summary: {
    zoneCount: number
    routeCount: number
    validRouteCount: number
    personCount: number
    floors: string[]
    exits: Record<string, number>
    exitLabels: string[]
    totalDistance: number
    maxEstimatedTime: number
    avgEstimatedTime: number
    riskLevel: 'LOW' | 'MEDIUM' | 'HIGH'
    stairRouteCount: number
  }
  routes: EvacuationRoute[]
  routesByZone: Record<string, EvacuationRoute>
  status: string
  valid: boolean
  reasons: string[]
  recommended: boolean
}

/**
 * 人员运行时（P1.6.1 统一数据契约）
 * 对外（WebSocket snapshot / tick）一律经 shared/person/personRuntime 的 normalizePersonRuntime 序列化为：
 *   id / buildingId / floorId / zone / status / routeId / routePoints / progress / position
 * 内部仿真仍用 x / y / waypoint 推进；position 由 x/y 派生，避免两份坐标源。
 * 铁律：routeId / routePoints / progress / position 只能由后端产生，2D 与 3D 只消费。
 */
export interface PersonRuntime {
  id: string
  buildingId: string
  floorId: string
  zone: string
  x: number
  y: number
  status: string
  movementType: string
  /** 疏散进度 0~1，1 表示已抵达安全出口 */
  progress: number
  /** 撤离目标点（出口节点） */
  targetX: number
  targetY: number
  /** 整栋楼方案中该人员所属 floorId+zone 的路线 id（2D/3D/后端同一个） */
  routeId: string | null
  /** 沿用的疏散路线（节点 id 序列，来自 shared/evacuation 规划器） */
  route: string[]
  /** 路线折线点（SVG 平面图坐标），逐段推进用 */
  routePoints: Array<{ x: number; y: number }>
  /** 当前所处折线段下标 */
  waypoint: number
  evacuating: boolean
  retained: boolean
  rescued: boolean
}

export interface DeviceRuntime {
  id: string
  type: string
  status: string
  currentMode: string
  direction: string
  brightness: number
  emergencyFlash: boolean
}

/** 疏散方案 —— 结构与 shared/evacuation/routePlanner 的输出一致（前端/3D 直接复用） */
export interface DemoPlan {
  id: string
  name: string
  /** 起点区域（如 A区） */
  startZones: string[]
  startNode: string
  exitId: string
  exitLabel: string
  /** 路线距离（m） */
  distance: number
  /** 预计时间（s） */
  estimatedTime: number
  /** 风险等级：由脱离火源的快慢推导 */
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH'
  /** 距火源最近距离（m） */
  fireDistance: number
  /** 脱离距离：路线上第一个楼梯/出口距火源（m） */
  escapeDistance: number
  /** 起点到出口直线距离（m） */
  exitDistance: number
  /** 途经楼层（自上而下，末位为 1F） */
  floorsPassed: string[]
  /** 路线节点 id 序列 */
  nodes: string[]
  /** 路线折线点（SVG 平面图坐标 560×300） */
  points: Array<{ x: number; y: number }>
  congestion: number
  score: number
  recommended: boolean
  valid: boolean
  reasons: string[]
  /** EvacuationPlan 生命周期（与 Demo 六阶段互相独立） */
  status: 'NORMAL' | 'WARNING' | 'BLOCKED' | 'CONFIRMED' | 'EXECUTING' | 'DONE'
}

export interface DemoEvent {
  id: string
  seq: number
  at: string
  stage: string
  action: string
  detail: string
  level: 'info' | 'success' | 'warning' | 'danger'
}

export interface DemoLighting {
  mode: 'daily' | 'induction' | 'emergency'
  brightness: number
  pulse: boolean
  updatedAt: string
}

export interface DemoMetrics {
  total: number
  evacuating: number
  evacuated: number
  retained: number
  rescued: number
  riskZones: number
}

export interface DemoRescue {
  active: boolean
  completed: boolean
  task: { id: string; teams: string[]; targetZone: string; status: string; startedAt: string } | null
}

export interface DemoWorld {
  sessionId: string
  seq: number
  stage: string
  scenario: DemoScenario
  fire: {
    id: string
    buildingId: string
    buildingName: string
    floorId: string
    zone: string
    level: string
    detectedAt: string
  } | null
  alarmId: string | null
  /**
   * ⚠️ LEGACY（旧「单火灾区域 A/B/C 方案」，P1.5.5 起退出决策链）
   * 仅用于：D1 历史记录与旧 REST 接口兼容（GET /api/v1/evacuation-plans）。
   * 禁止用于：人员路线、当前执行方案、设备联动、CONFIRM_ROUTE 校验、2D/3D 路线。
   * 权威顺序恒为：buildingPlans > activeBuildingPlanId > person.routeId/routePoints。
   */
  legacyPlans: DemoPlan[]
  /** ⚠️ LEGACY：与 legacyPlans 配套，仅作历史展示，不参与任何决策 */
  legacyActivePlanId: string | null
  /** 权威：整栋楼疏散方案（scope=BUILDING），PLAN-A/B/C = 三种整栋楼策略 */
  buildingPlans: BuildingEvacuationPlan[]
  /** 权威：当前执行的整栋楼方案 id（唯一来源） */
  activeBuildingPlanId: string | null
  /** 疏散范围：火灾只描述位置，疏散范围恒为整栋楼 */
  evacuationScope: 'BUILDING'
  persons: Record<string, PersonRuntime>
  devices: Record<string, DeviceRuntime>
  lighting: DemoLighting
  metrics: DemoMetrics
  rescue: DemoRescue
  eventLog: DemoEvent[]
  tick: number
  /** 疏散是否自然跑完（用于提示前端可推进） */
  evacuationSettled: boolean
  enteredAt: string
  updatedAt: string
}

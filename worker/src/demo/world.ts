// Demo Simulation Engine 的运行时世界状态（仅存于 Durable Object 内存 / DO Storage；
// D1 只保存业务与历史数据，实时状态一律不落 D1）

export interface DemoScenario {
  buildingId: string
  buildingName: string
  floorId: string
  zone: string
}

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
  plans: DemoPlan[]
  activePlanId: string | null
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

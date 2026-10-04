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
  /** 撤离目标点（出口/楼梯节点） */
  targetX: number
  targetY: number
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

export interface DemoPlan {
  id: string
  name: string
  exitId: string
  exitLabel: string
  distance: number
  estimatedTime: number
  congestion: number
  recommended: boolean
  /** EvacuationPlan 生命周期（与 Demo 阶段互相独立） */
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

// 实体与运行时类型定义（与 docs/API_CONTRACT.md、src/api/contract.js 对齐）

export interface Env {
  DB: D1Database
  /** Demo Simulation Engine 的实时状态协调器（Durable Object） */
  DEMO_ROOM: DurableObjectNamespace
  SEED_TOKEN?: string
}

// ── Building ──
export interface Building {
  id: string
  name: string
  type: string
  floors: number
  deviceCount: number
  online: number
  abnormal: number
  offline: number
  status: 'normal' | 'warning' | 'emergency'
  patrolRate: number
  lastAlarm: string | null
}

// ── Device（wire 层含 area 只读别名 = zone） ──
export interface Device {
  id: string
  planId?: string
  name: string
  type: string
  buildingId: string
  building: string
  floorId: string
  floor: string
  zone: string
  area: string
  zoneName?: string
  x?: number
  y?: number
  status: string
  controllable: boolean
  battery?: number
  temperature?: number
  communication: string
  lastReport?: string
  installPosition?: string
  workHours?: number
  voltage?: number
  signal?: number
  direction?: string
  recommendedDirection?: string
  brightness?: number
  currentMode?: string
  detectionRange?: number
  detectedPersons?: number
  exitId?: string
  stairId?: string
  doorId?: string
  emergencyFlash?: boolean
}

// ── Telemetry ──
export interface TelemetryEntry {
  id?: number
  deviceId: string
  kind: string
  value: string
  reportedAt?: string
}

// ── Alarm ──
export interface Alarm {
  id: string
  deviceId?: string
  buildingId: string
  building: string
  floorId?: string
  floor?: string
  zone?: string
  type: string
  level: string
  status: string
  progress: number
  description?: string
  occurredAt: string
  time: string // occurredAt 只读别名（兼容前端）
  handledAt?: string | null
  handledBy?: string | null
}

// ── Inspection ──
export interface Inspection {
  id: string
  deviceId: string
  deviceName?: string
  result: 'pass' | 'warning' | 'fail'
  durationMs?: number
  details?: Array<{ itemId: string; name: string; result: string; message: string }>
  operator?: string
  createdAt: string
  time: string // createdAt 只读别名
}

// ── EvacuationPlan ──
export interface EvacuationPlan {
  id: string
  name?: string
  buildingId: string
  buildingName?: string
  startFloor: string
  startArea: string
  corridor?: string
  stair?: string
  exit?: string
  exitLabel?: string
  exitSide?: string
  type: 'auto' | 'manual'
  status: string
  recommended: boolean
  floorsPassed: string[]
  riskLevel?: string
  score?: number
  distance?: number
  estimatedTime?: number
  deviceCount?: number
  congestion?: number
  zoneColor?: string
  path: Array<Record<string, unknown>>
  manualNodes?: Array<Record<string, unknown>>
  manualEdges?: Array<[string, string]>
}

// ── PersonPresence ──
export interface PersonPresence {
  id: string
  buildingId: string
  building: string
  floorId: string
  floor: string
  zone: string
  x?: number
  y?: number
  status: string
  speed?: number
  direction?: number
  distance?: number
  movementType?: string
  sourceDeviceId?: string
  detectedAt?: string
  name?: string
  department?: string
}

// ── OperationLog ──
export interface OperationLog {
  id?: number
  module?: string
  action: string
  detail?: string
  operator?: string
  level?: string
  createdAt?: string
  time?: string
}

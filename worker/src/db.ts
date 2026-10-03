// D1 访问与 DB ↔ wire 双向映射
import type { Alarm, Building, Device, EvacuationPlan, Inspection, OperationLog, PersonPresence, TelemetryEntry } from './types'

type Row = Record<string, unknown>

export async function all(db: D1Database, sql: string, params: unknown[] = []): Promise<Row[]> {
  const { results } = await db.prepare(sql).bind(...(params as unknown[])).all<Row>()
  return results ?? []
}

export async function first(db: D1Database, sql: string, params: unknown[] = []): Promise<Row | null> {
  return (await all(db, sql, params))[0] ?? null
}

export async function run(db: D1Database, sql: string, params: unknown[] = []): Promise<void> {
  await db.prepare(sql).bind(...(params as unknown[])).run()
}

export async function batch(db: D1Database, statements: D1PreparedStatement[]): Promise<void> {
  if (!statements.length) return
  // D1 单批上限约 100 条语句，超出分批执行
  for (let i = 0; i < statements.length; i += 100) {
    await db.batch(statements.slice(i, i + 100))
  }
}

// 统一时间格式：Asia/Shanghai（生产 Worker 运行在 UTC，显式指定时区保证与前端本地时间一致）
const shFmt = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', hour12: false,
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
})
export function fmtSH(date: Date = new Date()): string {
  const parts = Object.fromEntries(shFmt.formatToParts(date).map((p) => [p.type, p.value]))
  const p2 = (v: string | undefined, len = 2) => String(v ?? '00').padStart(len, '0')
  return `${p2(parts.year, 4)}-${p2(parts.month)}-${p2(parts.day)} ${p2(parts.hour)}:${p2(parts.minute)}:${p2(parts.second)}`
}
const now = () => fmtSH()
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v))
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v))

// ── Building（聚合派生字段在 SQL 层计算） ──
export function mapBuildingRow(r: Row): Building {
  const abnormal = Number(r.abnormal ?? 0)
  const emergency = Number(r.emergency ?? 0)
  return {
    id: String(r.id),
    name: String(r.name),
    type: String(r.type),
    floors: Number(r.floors ?? 6),
    deviceCount: Number(r.device_count ?? 0),
    online: Number(r.online ?? 0),
    abnormal,
    offline: Number(r.offline ?? 0),
    status: emergency > 0 ? 'emergency' : abnormal > 0 ? 'warning' : 'normal',
    patrolRate: Number(r.patrol_rate ?? 96),
    lastAlarm: (r.last_alarm as string) ?? null,
  }
}

export const BUILDING_AGGREGATE_SQL = `
  SELECT b.*, 
    (SELECT COUNT(*) FROM devices d WHERE d.building_id = b.id) AS device_count,
    (SELECT COUNT(*) FROM devices d WHERE d.building_id = b.id AND d.status != 'fault') AS online,
    (SELECT COUNT(*) FROM devices d WHERE d.building_id = b.id AND d.status IN ('warning','emergency')) AS abnormal,
    (SELECT COUNT(*) FROM devices d WHERE d.building_id = b.id AND d.status = 'emergency') AS emergency,
    (SELECT COUNT(*) FROM devices d WHERE d.building_id = b.id AND d.status = 'fault') AS offline,
    (SELECT MAX(a.occurred_at) FROM alarms a WHERE a.building_id = b.id) AS last_alarm
  FROM buildings b`

// ── Device ──
export function mapDeviceRow(r: Row): Device {
  const zone = (r.zone as string) ?? ''
  return {
    id: String(r.id),
    planId: (r.plan_id as string) ?? undefined,
    name: String(r.name),
    type: String(r.type),
    buildingId: String(r.building_id),
    building: String(r.building ?? ''),
    floorId: String(r.floor_id),
    floor: String(r.floor_id),
    zone,
    area: zone, // 契约：area 为 zone 的只读别名
    zoneName: (r.zone_name as string) ?? zone,
    x: r.x === null || r.x === undefined ? undefined : Number(r.x),
    y: r.y === null || r.y === undefined ? undefined : Number(r.y),
    status: String(r.status),
    controllable: Number(r.controllable) === 1,
    battery: num(r.battery) ?? undefined,
    temperature: num(r.temperature) ?? undefined,
    communication: String(r.communication ?? 'online'),
    lastReport: (r.last_report as string) ?? undefined,
    installPosition: (r.install_position as string) ?? undefined,
    workHours: num(r.work_hours) ?? undefined,
    voltage: num(r.voltage) ?? undefined,
    signal: num(r.signal) ?? undefined,
    direction: (r.direction as string) ?? undefined,
    recommendedDirection: (r.recommended_direction as string) ?? undefined,
    brightness: num(r.brightness) ?? undefined,
    currentMode: (r.current_mode as string) ?? undefined,
    detectionRange: num(r.detection_range) ?? undefined,
    detectedPersons: num(r.detected_persons) ?? undefined,
    exitId: (r.exit_id as string) ?? undefined,
    stairId: (r.stair_id as string) ?? undefined,
    doorId: (r.door_id as string) ?? undefined,
    emergencyFlash: Number(r.emergency_flash ?? 0) === 1,
  }
}

export const DEVICE_JOIN_SQL = 'SELECT d.*, b.name AS building FROM devices d LEFT JOIN buildings b ON b.id = d.building_id'

// PATCH 白名单：wire 字段 → SQL 列
export const DEVICE_PATCH_COLUMNS: Record<string, { col: string; kind: 'str' | 'num' | 'bool'; telemetry?: string }> = {
  status: { col: 'status', kind: 'str', telemetry: 'status' },
  direction: { col: 'direction', kind: 'str', telemetry: 'direction' },
  recommendedDirection: { col: 'recommended_direction', kind: 'str' },
  brightness: { col: 'brightness', kind: 'num', telemetry: 'brightness' },
  currentMode: { col: 'current_mode', kind: 'str', telemetry: 'mode' },
  emergencyFlash: { col: 'emergency_flash', kind: 'bool' },
  communication: { col: 'communication', kind: 'str' },
  battery: { col: 'battery', kind: 'num' },
  temperature: { col: 'temperature', kind: 'num' },
  signal: { col: 'signal', kind: 'num' },
  voltage: { col: 'voltage', kind: 'num' },
  detectedPersons: { col: 'detected_persons', kind: 'num', telemetry: 'personCount' },
  detectionRange: { col: 'detection_range', kind: 'num' },
  lastReport: { col: 'last_report', kind: 'str' },
}

// ── Telemetry ──
export function mapTelemetryRow(r: Row): TelemetryEntry {
  return {
    id: Number(r.id),
    deviceId: String(r.device_id),
    kind: String(r.kind),
    value: String(r.value),
    reportedAt: String(r.reported_at),
  }
}

// ── Alarm ──
export const ALARM_JOIN_SQL = 'SELECT a.*, b.name AS building FROM alarms a LEFT JOIN buildings b ON b.id = a.building_id'

export function mapAlarmRow(r: Row): Alarm {
  const occurredAt = String(r.occurred_at)
  return {
    id: String(r.id),
    deviceId: (r.device_id as string) ?? undefined,
    buildingId: String(r.building_id),
    building: String(r.building ?? ''),
    floorId: (r.floor_id as string) ?? undefined,
    floor: (r.floor_id as string) ?? undefined,
    zone: (r.zone as string) ?? undefined,
    type: String(r.type),
    level: String(r.level),
    status: String(r.status),
    progress: Number(r.progress ?? 10),
    description: (r.description as string) ?? undefined,
    occurredAt,
    time: occurredAt,
    handledAt: (r.handled_at as string) ?? null,
    handledBy: (r.handled_by as string) ?? null,
  }
}

// ── Inspection ──
export function mapInspectionRow(r: Row): Inspection {
  const createdAt = String(r.created_at)
  return {
    id: String(r.id),
    deviceId: String(r.device_id),
    deviceName: (r.device_name as string) ?? undefined,
    result: String(r.result) as Inspection['result'],
    durationMs: num(r.duration_ms) ?? undefined,
    details: r.details ? (JSON.parse(String(r.details)) as Inspection['details']) : undefined,
    operator: (r.operator as string) ?? undefined,
    createdAt,
    time: createdAt,
  }
}

// ── EvacuationPlan ──
export function mapPlanRow(r: Row): EvacuationPlan {
  const extra = r.extra ? (JSON.parse(String(r.extra)) as Record<string, unknown>) : {}
  return {
    id: String(r.id),
    name: (r.name as string) ?? undefined,
    buildingId: String(r.building_id),
    buildingName: (r.building_name as string) ?? undefined,
    startFloor: String(r.start_floor),
    startArea: String(r.start_area),
    corridor: (extra.corridor as string) ?? undefined,
    stair: (extra.stair as string) ?? undefined,
    exit: (r.exit_id as string) ?? undefined,
    exitLabel: (r.exit_label as string) ?? undefined,
    exitSide: (r.exit_side as string) ?? undefined,
    type: (String(r.type ?? 'auto') as EvacuationPlan['type']),
    status: String(r.status ?? 'NORMAL'),
    recommended: Number(r.recommended ?? 0) === 1,
    floorsPassed: r.floors_passed ? (JSON.parse(String(r.floors_passed)) as string[]) : [],
    riskLevel: (r.risk_level as string) ?? undefined,
    score: num(r.score) ?? undefined,
    distance: num(r.distance) ?? undefined,
    estimatedTime: num(r.estimated_time) ?? undefined,
    deviceCount: num(r.device_count) ?? undefined,
    congestion: num(r.congestion) ?? undefined,
    zoneColor: (r.zone_color as string) ?? undefined,
    path: r.path ? (JSON.parse(String(r.path)) as EvacuationPlan['path']) : [],
    manualNodes: (extra.manualNodes as EvacuationPlan['manualNodes']) ?? undefined,
    manualEdges: (extra.manualEdges as EvacuationPlan['manualEdges']) ?? undefined,
  }
}

// ── PersonPresence ──
export const PERSON_JOIN_SQL = 'SELECT p.*, b.name AS building FROM person_presence p LEFT JOIN buildings b ON b.id = p.building_id'

export function mapPersonRow(r: Row): PersonPresence {
  return {
    id: String(r.id),
    buildingId: String(r.building_id),
    building: String(r.building ?? ''),
    floorId: String(r.floor_id),
    floor: String(r.floor_id),
    zone: String(r.zone),
    x: num(r.x) ?? undefined,
    y: num(r.y) ?? undefined,
    status: String(r.status),
    speed: num(r.speed) ?? undefined,
    direction: num(r.direction) ?? undefined,
    distance: num(r.distance) ?? undefined,
    movementType: (r.movement_type as string) ?? undefined,
    sourceDeviceId: (r.source_device_id as string) ?? undefined,
    detectedAt: (r.detected_at as string) ?? undefined,
    name: (r.name as string) ?? undefined,
    department: (r.department as string) ?? undefined,
  }
}

// ── OperationLog ──
export function mapLogRow(r: Row): OperationLog {
  const createdAt = String(r.created_at)
  const hhmmss = createdAt.includes(' ') ? createdAt.split(' ')[1] : createdAt
  return {
    id: Number(r.id),
    module: (r.module as string) ?? '综合',
    action: String(r.action),
    detail: (r.detail as string) ?? '',
    operator: (r.operator as string) ?? '管理员',
    level: (r.level as string) ?? 'info',
    createdAt,
    time: hhmmss,
  }
}

export { now, num, str }

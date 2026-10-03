// 种子数据生成：复用前端 src/mock 的纯 JS 数据模块，保证 mock 数据源与 D1 种子数据同源。
// 注意：mock 模块中模块级 new Date() 派生的时间戳（alarms.time / deviceSeed.lastReport /
// person.detectedAt / inspectionHistory.time）在 Worker 运行时不可靠（workerd 本地快照求值
// 会得到过期常量，生产环境则为 UTC），因此种子数据的时间戳一律在 seed 请求时按 Asia/Shanghai 重算。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import { buildings as mockBldMeta } from '../../src/mock/devices.js'
import { buildSeedDevices } from '../../src/mock/deviceSeed.js'
import { alarms as mockAlarms } from '../../src/mock/alarms.js'
import { persons as mockPersons } from '../../src/mock/person.js'
import { inspectionHistory as mockInspections } from '../../src/mock/inspection.js'
import { fmtSH } from './db'

const BUILDING_NAME_TO_ID: Record<string, string> = {
  '1号楼': 'B001', '2号楼': 'B002', '3号楼': 'B003', '4号楼': 'B004',
}
const PATROL_RATES: Record<string, number> = { B001: 95, B002: 97, B003: 98, B004: 96 }

export async function seed(db: D1Database): Promise<Record<string, number>> {
  const stmts: D1PreparedStatement[] = []
  const counts: Record<string, number> = {}
  const now = Date.now()
  const ts = fmtSH()
  // 分钟前的 Asia/Shanghai 时间戳
  const minutesAgo = (m: number) => fmtSH(new Date(now - m * 60000))
  const hoursAgo = (h: number) => fmtSH(new Date(now - h * 3600000))

  // 1. Buildings（类型与楼层数来自前端元数据）
  for (const b of mockBldMeta as Array<{ id: string; name: string; floors: number; type: string }>) {
    stmts.push(db.prepare(`INSERT OR REPLACE INTO buildings (id, name, type, floors, patrol_rate, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(b.id, b.name, b.type, b.floors, PATROL_RATES[b.id] ?? 96, ts, ts))
  }
  counts.buildings = (mockBldMeta as unknown[]).length

  // 2. Devices（deviceSeed 与前端 store 完全同源，4 栋 × 6 层 ≈ 550 台；lastReport 请求时重算）
  const devices = buildSeedDevices()
  devices.forEach((d, i) => {
    stmts.push(db.prepare(`INSERT OR REPLACE INTO devices
      (id, plan_id, name, type, building_id, floor_id, zone, zone_name, x, y, status, controllable, communication,
       battery, temperature, last_report, install_position, work_hours, voltage, signal, direction, recommended_direction,
       brightness, current_mode, detection_range, detected_persons, exit_id, stair_id, door_id, emergency_flash, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
      d.id, d.planId ?? null, d.name, d.type, d.buildingId, d.floorId, d.area ?? null, d.zoneName ?? null,
      d.x ?? null, d.y ?? null, d.status, d.controllable ? 1 : 0, d.communication,
      d.battery ?? null, d.temperature ?? null, minutesAgo((i % 60) + 1), d.installPosition ?? null,
      d.workHours ?? null, d.voltage ?? null, d.signal ?? null, d.direction ?? null, d.recommendedDirection ?? null,
      d.brightness ?? null, d.currentMode ?? null, d.detectionRange ?? null, d.detectedPersons ?? null,
      d.exitId ?? null, d.stairId ?? null, d.doorId ?? null, d.emergencyFlash ? 1 : 0, ts, ts,
    ))
  })
  counts.devices = devices.length

  // 3. Alarms（occurred_at = 请求时刻递推 10 分钟，保持 mock 的相对时序）
  const alarms = mockAlarms as Array<Record<string, unknown>>
  alarms.forEach((a, i) => {
    stmts.push(db.prepare(`INSERT OR REPLACE INTO alarms
      (id, device_id, building_id, floor_id, zone, type, level, status, progress, description, occurred_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
      String(a.id), (a.deviceId as string) ?? null, BUILDING_NAME_TO_ID[String(a.building)] ?? 'B001',
      (a.floor as string) ?? null, (a.area as string) ?? null,
      String(a.type), String(a.level), String(a.status ?? 'pending'), Number(a.progress ?? 10),
      (a.description as string) ?? null, minutesAgo((i + 1) * 10), ts, ts,
    ))
  })
  counts.alarms = alarms.length

  // 4. Inspections（created_at = 请求时刻递推 3 小时）
  const inspections = mockInspections as Array<Record<string, unknown>>
  inspections.forEach((ins, i) => {
    stmts.push(db.prepare(`INSERT OR REPLACE INTO inspections
      (id, device_id, device_name, result, duration_ms, details, operator, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(
      String(ins.id), String(ins.deviceId), (ins.deviceName as string) ?? null, String(ins.result),
      Number(ins.duration ?? 0), JSON.stringify(ins.details ?? []), (ins.operator as string) ?? '系统自动', hoursAgo((i + 1) * 3),
    ))
  })
  counts.inspections = inspections.length

  // 5. PersonPresence（mock Person → 契约字段；detectedAt 请求时重算）
  const persons = mockPersons as Array<Record<string, unknown>>
  persons.forEach((p, i) => {
    stmts.push(db.prepare(`INSERT OR REPLACE INTO person_presence
      (id, building_id, floor_id, zone, x, y, status, speed, direction, distance, movement_type, detected_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
      String(p.id), BUILDING_NAME_TO_ID[String(p.building)] ?? 'B001', String(p.floor), String(p.zone),
      (p.x as number) ?? null, (p.y as number) ?? null, String(p.status ?? 'normal'),
      (p.speed as number) ?? null, (p.direction as number) ?? null, (p.distance as number) ?? null,
      String(p.movementType ?? 'static'), minutesAgo((i % 55) + 5), ts,
    ))
  })
  counts.persons = persons.length

  // 分批执行（D1 单批上限 100 条语句）
  for (let i = 0; i < stmts.length; i += 100) {
    await db.batch(stmts.slice(i, i + 100))
  }
  return counts
}

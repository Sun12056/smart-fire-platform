// ================== 设备运行时统一数据契约（P1.6.2） ==================
//
// 全链路：D1 devices → DemoRoom(DeviceRuntime) → WebSocket snapshot → demoStore → fireStore → 2D 设备 / 3D
//
// 统一字段（唯一权威，10 项）：
//   id / type / buildingId / floorId / zone / status / currentMode / direction / brightness / emergencyFlash
//
// buildId / floorId / zone 是「楼层归属」三元组：
//   · 后端 DeviceRuntime 由 D1 devices.building_id / floor_id / zone 填充（唯一权威来源）
//   · WebSocket 快照经本模块序列化，前端凭 (buildingId, floorId) 即可把设备准确定位到楼层
//   · zone 是该设备的所属区域（走廊 / A区 / 楼梯1 …），用于烟感、区域联动定位
//
// 铁律：
//   ① 后端是唯一权威：设备状态 / 模式 / 方向 / 亮度一律由后端下发，前端不得推导
//   ② 整栋楼联动的设备筛选必须基于 buildingId + floorId（不是中文楼栋名，不是 deviceId 字符串解析）
//   ③ 旧字段 building / floor / area 只是「只读别名」，由统一字段派生，禁止反向写回权威字段
// ────────────────────────────────────────────────────────────
import {
  BUILDING_ID_TO_NAME, BUILDING_NAME_TO_ID, buildingIdOf, buildingNameOf, floorIdOf, zoneOf,
} from '../person/personRuntime.js'

/** 统一字段清单（顺序即权威字段顺序） */
export const DEVICE_FIELDS = Object.freeze([
  'id', 'type', 'buildingId', 'floorId', 'zone', 'status', 'currentMode', 'direction', 'brightness', 'emergencyFlash',
])

export const DEFAULT_DEVICE_STATUS = 'normal'
export const DEFAULT_DEVICE_MODE = 'daily'
export const DEFAULT_DEVICE_DIRECTION = 'right'
export const DEFAULT_DEVICE_BRIGHTNESS = 60

/** 联动设备类型（后端 DeviceRuntime 的场景范围，与 D1 SQL 的 type IN (...) 一致） */
export const LINKAGE_DEVICE_TYPES = Object.freeze([
  'evacuation_light', 'emergency_light', 'smoke_detector', 'radar_sensor',
])

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : (v === '' || v === null || v === undefined ? null : Number(v)))

/** 楼层 id 归一化：'5' → '5F'；非法/缺失返回 ''（禁止编造楼层） */
export { floorIdOf }

/** 楼栋 id：buildingId → building（中文名）→ 缺省 buildingId */
export { buildingIdOf, buildingNameOf }

/** 区域：zone → area（设备布点的 area 才是真正的归属区域名） */
export { zoneOf }

/** D1 行 → 统一字段时的 zone 解析（列名叫 zone，语义上是 area） */
export function zoneFromRow(row) {
  const r = row || {}
  return zoneOf({ zone: r.zone, area: r.area })
}

export function typeOf(raw) {
  const r = raw || {}
  return r.type !== undefined && r.type !== null && r.type !== '' ? String(r.type) : ''
}

export function statusOf(raw) {
  const r = raw || {}
  return r.status !== undefined && r.status !== null && r.status !== '' ? String(r.status) : DEFAULT_DEVICE_STATUS
}

export function currentModeOf(raw) {
  const r = raw || {}
  if (r.currentMode !== undefined && r.currentMode !== null && r.currentMode !== '') return String(r.currentMode)
  return DEFAULT_DEVICE_MODE
}

export function directionOf(raw) {
  const r = raw || {}
  if (r.direction !== undefined && r.direction !== null && r.direction !== '') return String(r.direction)
  return DEFAULT_DEVICE_DIRECTION
}

/** 亮度 0~100，非法值归默认值（禁止臆造亮度） */
export function brightnessOf(raw) {
  const r = raw || {}
  const n = num(r.brightness)
  if (n === null) return DEFAULT_DEVICE_BRIGHTNESS
  return Math.max(0, Math.min(100, n))
}

export function emergencyFlashOf(raw) {
  const r = raw || {}
  if (typeof r.emergencyFlash === 'boolean') return r.emergencyFlash
  if (r.emergencyFlash === undefined || r.emergencyFlash === null) return false
  return Number(r.emergencyFlash) === 1 || String(r.emergencyFlash) === 'true'
}

/**
 * 规范化为统一设备对象（后端 DTO / 前端 store 都用它）。
 * 输出一定包含 DEVICE_FIELDS 全部 10 项 + 旧只读别名；其余业务字段（name / x / y …）原样保留。
 */
export function normalizeDeviceRuntime(raw, ctx = {}) {
  const r = raw || {}
  // 先保留源对象的全部业务字段，再覆写/派生统一字段（避免规范化把设备台账字段弄丢）
  const out = { ...r }
  const context = {
    buildingId: ctx.buildingId || r.buildingId || '',
    floorId: ctx.floorId || r.floorId || '',
    zone: ctx.zone || undefined,
  }
  Object.assign(out, {
    id: r.id !== undefined && r.id !== null ? String(r.id) : '',
    type: typeOf(r),
    buildingId: buildingIdOf(r, context),
    floorId: floorIdOf(r, context),
    zone: zoneOf(r, context),
    status: statusOf(r),
    currentMode: currentModeOf(r),
    direction: directionOf(r),
    brightness: brightnessOf(r),
    emergencyFlash: emergencyFlashOf(r),
  })
  // ── 旧只读别名（由统一字段派生；旧视图 / 台账组件仍在用）──
  // P1.7.3-B3：别名必须跟着 canonical 走 —— 即使源对象给了冲突的 building / floor / area，
  //   也必须以 buildingId / floorId / zone 为准（禁止旧别名反向成为第二套权威身份）
  const name = BUILDING_ID_TO_NAME[out.buildingId] || buildingNameOf(r, context)
  if (name) out.building = name
  if (out.floorId) out.floor = out.floorId
  if (out.zone) out.area = out.zone
  if (out.type === undefined) out.type = ''
  return out
}

/** 列表批量规范化 */
export function toDeviceRuntimeList(list, ctx = {}) {
  return (Array.isArray(list) ? list : []).map((d) => normalizeDeviceRuntime(d, ctx))
}

/**
 * 把后端下发的设备运行时合并进既有 store 设备对象（按统一字段写，别名同步）。
 * 只写「后端确实给了」的字段，避免用默认值覆盖本地台账（x/y/name/battery …）。
 */
export function assignDeviceRuntime(target, source, ctx = {}) {
  if (!target || !source) return target
  const n = normalizeDeviceRuntime(source, ctx)
  if (n.id) target.id = n.id
  if (n.type) target.type = n.type
  // 楼层归属三元组：后端权威，缺失时保留本地台账值（REST 已带，WS 可能未带）
  if (n.buildingId) target.buildingId = n.buildingId
  if (n.floorId) target.floorId = n.floorId
  if (n.zone) target.zone = n.zone
  if (source.status !== undefined && source.status !== null) target.status = n.status
  if (source.currentMode !== undefined && source.currentMode !== null) target.currentMode = n.currentMode
  if (source.direction !== undefined && source.direction !== null) {
    target.direction = n.direction
    if ('recommendedDirection' in target) target.recommendedDirection = n.direction
  }
  if (source.brightness !== undefined && source.brightness !== null) target.brightness = n.brightness
  target.emergencyFlash = n.emergencyFlash
  // 统一字段完整性兜底：缺了才用别名补齐（不反向写回权威字段）
  if (!target.buildingId) target.buildingId = buildingIdOf(target, ctx)
  if (!target.floorId) target.floorId = floorIdOf(target, ctx)
  if (!target.zone) target.zone = zoneOf(target, ctx)
  // P1.7.3-B3：别名按 canonical 重算（冲突时以 canonical 为准，不是「缺了才补」）
  const cname = BUILDING_ID_TO_NAME[target.buildingId]
  if (cname) target.building = cname
  else if (!target.building) target.building = buildingNameOf(target, ctx)
  if (target.floorId) target.floor = target.floorId
  if (target.zone) target.area = target.zone
  return target
}

/** 统一字段完整性校验（E2E / 单测用） */
export function isCanonicalDevice(d) {
  if (!d || typeof d !== 'object') return false
  if (d.id === undefined || d.id === null || String(d.id) === '') return false
  if (!d.type) return false
  if (!d.buildingId || !/^B\d{3}$/.test(String(d.buildingId))) return false
  if (!d.floorId || !/^\d+F$/.test(String(d.floorId))) return false
  if (d.zone === undefined || d.zone === null) return false
  if (!d.status) return false
  if (typeof d.brightness !== 'number' || !Number.isFinite(d.brightness)) return false
  if (typeof d.emergencyFlash !== 'boolean') return false
  return true
}

/** 设备归属 key：`${floorId}:${zone}`（整栋楼联动的分区索引） */
export function deviceZoneKey(d) {
  if (!d) return ''
  const floorId = floorIdOf(d)
  const zone = zoneOf(d)
  return floorId && zone ? `${floorId}:${zone}` : ''
}

/** 楼层索引（3D 楼层高度用）：'5F' → 5；非法返回 null */
export function deviceFloorIndex(d) {
  const fid = floorIdOf(d)
  const m = /^(\d+)F$/.exec(fid)
  return m ? parseInt(m[1], 10) : null
}

/** 是否属于指定楼栋（入参同时兼容 canonical id 与旧中文名） */
export function deviceInBuilding(d, buildingIdOrName) {
  if (!d || !buildingIdOrName) return false
  const raw = String(buildingIdOrName)
  // P1.7.3-B3-03：期望值先归一成 canonical id（中文名按表反查；未知值保持原样 → 自然不命中，禁止串楼栋）
  const want = /^B\d{3}$/.test(raw) ? raw : (BUILDING_NAME_TO_ID[raw] || raw)
  const bid = buildingIdOf(d)
  // canonical 存在 → 只认 canonical，禁止旧别名 building 成为第二套楼栋权威
  if (bid) return String(bid) === String(want)
  // canonical 缺失 → 才允许 legacy 别名兜底
  const bname = buildingNameOf(d)
  return Boolean(bname && bname === raw)
}

/** 是否位于指定楼层（只看 floorId，不解析 deviceId 字符串） */
export function deviceOnFloor(d, floorId, buildingId) {
  if (!d || !floorId) return false
  if (buildingId && !deviceInBuilding(d, buildingId)) return false
  const want = floorIdOf({ floorId })
  return Boolean(want) && floorIdOf(d) === want
}

/** 按楼栋筛选（快照 → 该楼栋全部设备） */
export function devicesInBuilding(list, buildingId) {
  return (Array.isArray(list) ? list : []).filter((d) => deviceInBuilding(d, buildingId))
}

/** 按楼栋 + 楼层筛选（「WS 快照准确定位到楼层」的核心能力） */
export function devicesOnFloor(list, buildingId, floorId) {
  return (Array.isArray(list) ? list : []).filter((d) => deviceOnFloor(d, floorId, buildingId))
}

/**
 * 设备快照 → 楼层分组（Map<floorId, device[]>）。
 * 楼层顺序按 numbers 升序（1F → 6F），保证前端遍历顺序稳定。
 */
export function groupDevicesByFloor(list, buildingId) {
  const out = new Map()
  const src = buildingId ? devicesInBuilding(list, buildingId) : (Array.isArray(list) ? list : [])
  src.forEach((d) => {
    const fid = floorIdOf(d)
    if (!fid) return
    const bucket = out.get(fid) || []
    bucket.push(d)
    out.set(fid, bucket)
  })
  return new Map([...out.entries()].sort((a, b) => {
    const ai = deviceFloorIndex({ floorId: a[0] })
    const bi = deviceFloorIndex({ floorId: b[0] })
    return (ai ?? 0) - (bi ?? 0)
  }))
}

/** 快照覆盖的楼层清单（升序） */
export function floorsOfDevices(list, buildingId) {
  return [...groupDevicesByFloor(list, buildingId).keys()]
}

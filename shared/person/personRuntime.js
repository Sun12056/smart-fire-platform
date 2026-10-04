// ================== 人员运行时统一数据契约（P1.6.1） ==================
//
// 全链路：DemoRoom(PersonRuntime) → WebSocket snapshot → demoStore → fireStore → 2D 人员 → PersonLayer3D
//
// 统一字段（唯一权威，9 项）：
//   id / buildingId / floorId / zone / status / routeId / routePoints / progress / position
//
// 铁律：
//   ① 后端是唯一权威：routeId / routePoints / progress / position 全部由后端下发，前端不得推导
//   ② 2D / 3D 只消费不生产：禁止前端自行生成路线、速度或路径（3D 仅做视觉插值 lerp）
//   ③ 后端、2D、3D 使用同一个人员 id 与同一个 routeId
//   ④ 旧字段 building / floor / area / x / y / route 只是「只读别名」，由统一字段派生，
//      兼容旧组件与 SVG 模板，禁止反向写回权威字段
// ────────────────────────────────────────────────────────────

/** 统一字段清单（顺序即权威字段顺序） */
export const PERSON_FIELDS = Object.freeze([
  'id', 'buildingId', 'floorId', 'zone', 'status', 'routeId', 'routePoints', 'progress', 'position',
])

export const DEFAULT_PERSON_STATUS = 'normal'

/** 楼栋名 ↔ id（与 src/mock/buildings.js、worker/src/seed.ts 一致） */
export const BUILDING_NAME_TO_ID = Object.freeze({
  '1号楼': 'B001', '2号楼': 'B002', '3号楼': 'B003', '4号楼': 'B004',
})
export const BUILDING_ID_TO_NAME = Object.freeze({
  B001: '1号楼', B002: '2号楼', B003: '3号楼', B004: '4号楼',
})

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : (v === '' || v === null || v === undefined ? null : Number(v)))

// ── 各字段的解析（旧别名 → 统一字段） ──
export function buildingIdOf(raw, ctx = {}) {
  const r = raw || {}
  if (r.buildingId) return String(r.buildingId)
  if (r.building) {
    return BUILDING_NAME_TO_ID[String(r.building)] || (/^B\d{3}$/.test(String(r.building)) ? String(r.building) : '')
  }
  return ctx.buildingId ? String(ctx.buildingId) : ''
}

export function buildingNameOf(raw, ctx = {}) {
  const r = raw || {}
  if (r.building) return String(r.building)
  const id = buildingIdOf(r, ctx)
  return BUILDING_ID_TO_NAME[id] || ''
}

export function floorIdOf(raw, ctx = {}) {
  const r = raw || {}
  const rawFloor = r.floorId !== undefined && r.floorId !== null ? r.floorId : r.floor
  if (rawFloor === undefined || rawFloor === null || rawFloor === '') return ctx.floorId ? String(ctx.floorId) : ''
  const s = String(rawFloor)
  if (/^\d+F$/.test(s)) return s
  if (/^\d+$/.test(s)) return `${s}F`
  return s
}

export function zoneOf(raw, ctx = {}) {
  const r = raw || {}
  if (r.zone !== undefined && r.zone !== null && r.zone !== '') return String(r.zone)
  if (r.area !== undefined && r.area !== null && r.area !== '') return String(r.area)
  return ctx.zone ? String(ctx.zone) : ''
}

export function statusOf(raw) {
  const r = raw || {}
  return r.status !== undefined && r.status !== null && r.status !== '' ? String(r.status) : DEFAULT_PERSON_STATUS
}

/** 疏散进度 0~1（1 = 已抵达安全出口）；非法值一律归 0 */
export function progressOf(raw) {
  const r = raw || {}
  const n = num(r.progress)
  if (n === null) return 0
  return Math.max(0, Math.min(1, n))
}

/** 路线折线点（SVG 平面图坐标）；非数组一律归 [] */
export function routePointsOf(raw) {
  const r = raw || {}
  if (!Array.isArray(r.routePoints)) return []
  return r.routePoints
    .filter((pt) => pt && Number.isFinite(Number(pt.x)) && Number.isFinite(Number(pt.y)))
    .map((pt) => ({ x: Number(pt.x), y: Number(pt.y) }))
}

/** routeId = `${buildingPlanId}:${floorId}:${zone}`（后端权威，2D/3D 同一个） */
export function routeIdOf(raw) {
  const r = raw || {}
  if (r.routeId === undefined || r.routeId === null || r.routeId === '') return null
  return String(r.routeId)
}

/** 位置：优先 position，其次旧别名 x / y；完全没有坐标时为 null（禁止编造） */
export function positionOf(raw) {
  const r = raw || {}
  if (r.position && Number.isFinite(Number(r.position.x)) && Number.isFinite(Number(r.position.y))) {
    return { x: Number(r.position.x), y: Number(r.position.y) }
  }
  const x = num(r.x)
  const y = num(r.y)
  if (x === null || y === null) return null
  return { x, y }
}

/**
 * 规范化为统一人员对象（后端 DTO / 前端 store 都用它）。
 * 输出一定包含 PERSON_FIELDS 全部 9 项 + 运行时标志 + 旧只读别名；
 * 其余业务字段（name / department / speed / detectedAt …）原样保留。
 */
export function normalizePersonRuntime(raw, ctx = {}) {
  const r = raw || {}
  // 先保留源对象的全部业务字段，再覆写/派生统一字段（避免规范化把人员档案字段弄丢）
  const out = { ...r }
  const position = positionOf(r)
  Object.assign(out, {
    id: r.id !== undefined && r.id !== null ? String(r.id) : '',
    buildingId: buildingIdOf(r, ctx),
    floorId: floorIdOf(r, ctx),
    zone: zoneOf(r, ctx),
    status: statusOf(r),
    routeId: routeIdOf(r),
    routePoints: routePointsOf(r),
    progress: progressOf(r),
    position,
  })
  // ── 运行时标志（后端权威，逐字段透传，缺失不臆造）──
  if (r.movementType !== undefined && r.movementType !== null) out.movementType = String(r.movementType)
  if (typeof r.evacuating === 'boolean') out.evacuating = r.evacuating
  if (typeof r.retained === 'boolean') out.retained = r.retained
  if (typeof r.rescued === 'boolean') out.rescued = r.rescued
  if (typeof r.waypoint === 'number' && Number.isFinite(r.waypoint)) out.waypoint = r.waypoint
  if (Array.isArray(r.route)) out.route = r.route.slice()
  // ── 旧只读别名（由统一字段派生；旧组件 / SVG 模板仍在用）──
  const name = buildingNameOf(r, ctx)
  if (name) out.building = name
  if (out.floorId) out.floor = out.floorId
  if (out.zone) out.area = out.zone
  if (position) { out.x = position.x; out.y = position.y }
  return out
}

/** 列表批量规范化 */
export function toPersonRuntimeList(list, ctx = {}) {
  return (Array.isArray(list) ? list : []).map((p) => normalizePersonRuntime(p, ctx))
}

/**
 * 把后端下发的人员运行时合并进既有 store 人员对象（按统一字段写，别名同步）。
 * 只写「后端确实给了」的字段，避免用默认值覆盖本地基线。
 */
export function assignPersonRuntime(target, source, ctx = {}) {
  if (!target || !source) return target
  const n = normalizePersonRuntime(source, ctx)
  if (n.id) target.id = n.id
  if (n.buildingId) target.buildingId = n.buildingId
  if (n.floorId) target.floorId = n.floorId
  if (n.zone) target.zone = n.zone
  if (source.status !== undefined && source.status !== null) target.status = n.status
  if (source.routeId !== undefined) target.routeId = n.routeId
  if (Array.isArray(source.routePoints)) target.routePoints = n.routePoints
  if (source.progress !== undefined && source.progress !== null) target.progress = n.progress
  if (n.position) {
    target.position = n.position
    target.x = n.position.x
    target.y = n.position.y
  } else if (target.position === undefined) {
    target.position = null
  }
  if (n.movementType) target.movementType = n.movementType
  if (typeof n.evacuating === 'boolean') target.evacuating = n.evacuating
  if (typeof n.retained === 'boolean') target.retained = n.retained
  if (typeof n.rescued === 'boolean') target.rescued = n.rescued
  if (typeof n.waypoint === 'number') target.waypoint = n.waypoint
  if (Array.isArray(n.route)) target.route = n.route
  // 旧别名跟随统一字段（不反向写回）
  if (target.buildingId && !target.building) target.building = BUILDING_ID_TO_NAME[target.buildingId] || target.building
  if (target.floorId) target.floor = target.floorId
  if (target.zone && !target.area) target.area = target.zone
  return target
}

/** 统一字段完整性校验（E2E / 单测用） */
export function isCanonicalPerson(p) {
  if (!p || typeof p !== 'object') return false
  if (p.id === undefined || p.id === null || String(p.id) === '') return false
  if (!p.buildingId || !p.floorId || !p.zone) return false
  if (!p.status) return false
  if (p.routeId !== null && typeof p.routeId !== 'string') return false
  if (!Array.isArray(p.routePoints)) return false
  const pr = num(p.progress)
  if (pr === null || pr < 0 || pr > 1) return false
  const pos = p.position
  if (!pos || !Number.isFinite(Number(pos.x)) || !Number.isFinite(Number(pos.y))) return false
  return true
}

/** 该人员的 routeId 是否属于指定整栋楼方案（scope 校验） */
export function routeIdBelongsToPlan(routeId, buildingPlanId) {
  if (!routeId || !buildingPlanId) return false
  return String(routeId) === String(buildingPlanId) || String(routeId).startsWith(`${buildingPlanId}:`)
}

/** 人员归属 key：`${floorId}:${zone}`（与 buildingEvacuationTypes.zoneKeyOf 同构） */
export function personZoneKey(p) {
  if (!p) return ''
  const floorId = floorIdOf(p)
  const zone = zoneOf(p)
  return floorId && zone ? `${floorId}:${zone}` : ''
}

/**
 * 整栋楼疏散规划器 —— BuildingEvacuationPlan 的唯一产出者
 *
 * 约束（严格遵守，避免重复造轮子）：
 *   ① 不修改 shared/evacuation/routeGraph.js 的基础拓扑；
 *   ② 不修改 Dijkstra / Yen K 最短路实现 —— 仍然调用 routePlanner.findPaths()；
 *   ③ 不修改 routeValidator 的基础能力 —— 每条路线仍然过 validateRoute()；
 *   ④ 火灾只作为「动态障碍」，不改变 evacuationScope（永远是整栋楼 BUILDING）。
 *
 * 流程：
 *   整栋楼人员 → 按 floorId + zone 分组 → 每组调用 findPaths() 取候选
 *   → 按 strategy 为每组选一条 → 汇总为 BuildingEvacuationPlan
 *   → 全量校验（不穿墙 / 不经火区 / 必达 1F 出口 / 跨层必经楼梯）
 */
import {
  EVACUATION_SCOPE, STRATEGY, STRATEGY_META, RISK_RANK,
  emptyRoute, emptyBuildingPlan, emptySummary, zoneKeyOf,
} from './buildingEvacuationTypes.js'
import { RISK_LEVEL } from './routeTypes.js'
import {
  buildBuildingGraph, exitIdsOf, blockedNodesForFire, floorNum, ZONE_NODE_KEY, ZONE_CORRIDOR_KEY,
} from './routeGraph.js'
import { findPaths, startNodeId } from './routePlanner.js'
import { validateRoute } from './routeValidator.js'

const finite = (v) => (isFinite(v) ? v : 0)

/**
 * ① 整栋楼人员 → 按 floorId + zone 分组（ evacuationScope = BUILDING 的基础）
 * @param {Array<{id:string, buildingId:string, floorId:string, zone:string, status?:string}>} persons
 * @param {object} opts
 * @param {string} [opts.buildingId] 只统计该楼栋（不传则全部）
 * @param {string[]} [opts.excludeStatuses] 排除的状态（如已撤离 safe）
 */
export function groupPersonsByZone(persons = [], opts = {}) {
  const { buildingId = null, excludeStatuses = [] } = opts
  const map = new Map()
  for (const p of persons) {
    if (!p || !p.floorId || !p.zone) continue
    if (buildingId && p.buildingId && String(p.buildingId) !== String(buildingId)) continue
    if (excludeStatuses.length && excludeStatuses.includes(p.status)) continue
    const key = zoneKeyOf(p.floorId, p.zone)
    if (!map.has(key)) {
      map.set(key, { zoneKey: key, floorId: p.floorId, zone: p.zone, personCount: 0, personIds: [] })
    }
    const g = map.get(key)
    g.personCount += 1
    if (p.id) g.personIds.push(p.id)
  }
  return [...map.values()].sort(
    (a, b) => floorNum(b.floorId) - floorNum(a.floorId) || String(a.zone).localeCompare(String(b.zone), 'zh'),
  )
}

/**
 * 火灾 → 动态障碍集合（只影响拓扑可达性，不改变疏散范围）
 * 火源房间封死；火源门厅对「不同门厅的区域」也封闭（火势蔓延走廊）。
 * 与火源共用同一门厅的区域（如 A区/B区 同门厅）不能被封死 —— 那是它唯一的出路。
 */
export function fireBlockSets(graph, fire, floorId, zone, startId) {
  const empty = { blockedNodes: new Set(), fireNodeIds: new Set() }
  if (!fire || !fire.floorId || !fire.zone) return empty
  const fireFloor = String(fire.floorId)
  const fireKey = ZONE_NODE_KEY[fire.zone]
  if (!fireKey) return empty

  const fireNodeIds = blockedNodesForFire({ floorId: fireFloor, zone: fire.zone, spreadToCorridor: false })
  const startHall = ZONE_CORRIDOR_KEY[ZONE_NODE_KEY[zone]]
  const fireHall = ZONE_CORRIDOR_KEY[fireKey]
  const sameHall = Boolean(startHall) && startHall === fireHall && String(floorId) === fireFloor
  const blockedNodes = blockedNodesForFire({
    floorId: fireFloor, zone: fire.zone, spreadToCorridor: !sameHall,
  })
  // 火源区人员必须从火源房间撤离 —— 起点落在火源节点时允许进入（撤离动作本身不可避免）
  if (startId && blockedNodes.has(startId)) blockedNodes.delete(startId)
  return { blockedNodes, fireNodeIds }
}

/**
 * ② 单个 floorId + zone 的候选路线（复用现有 findPaths / Dijkstra / Yen / validateRoute）
 */
export function planZoneRoutes(opts = {}) {
  const {
    graph, floorId, zone, fire = null, personCount = 0,
    k = 3, limit = 3, idPrefix = 'R',
  } = opts
  const startId = startNodeId(graph, floorId, zone)
  if (!startId) {
    return { startId: null, candidates: [], blockedNodes: [], fireNodeIds: [] }
  }
  const { blockedNodes, fireNodeIds } = fireBlockSets(graph, fire, floorId, zone, startId)
  const candidates = findPaths({
    graph, startId, blockedNodes, fireNodeIds,
    congestion: personCount, k, limit, idPrefix: `${idPrefix}-${floorId}-${zone}`,
  })
  return { startId, candidates, blockedNodes: [...blockedNodes], fireNodeIds: [...fireNodeIds] }
}

/**
 * ③ 按策略为单个区域选择路线
 *   BALANCED：综合评分优先 + 出口负载均衡（人流分摊到不同安全出口）
 *   FASTEST ：预计耗时最短
 *   SAFEST  ：风险最低 / 远离火源
 */
export function pickRouteByStrategy(candidates = [], strategy = STRATEGY.BALANCED, ctx = {}) {
  const list = (candidates || []).filter((c) => c && c.valid)
  if (!list.length) return null

  if (strategy === STRATEGY.FASTEST) {
    return [...list].sort(
      (a, b) => a.estimatedTime - b.estimatedTime || a.distance - b.distance,
    )[0]
  }
  if (strategy === STRATEGY.SAFEST) {
    return [...list].sort(
      (a, b) => (RISK_RANK[a.riskLevel] ?? 9) - (RISK_RANK[b.riskLevel] ?? 9)
        || finite(b.fireDistance) - finite(a.fireDistance)
        || finite(b.escapeDistance) - finite(a.escapeDistance)
        || a.estimatedTime - b.estimatedTime,
    )[0]
  }
  // BALANCED
  const exitLoad = ctx.exitLoad || new Map()
  return [...list].sort((a, b) => {
    const la = exitLoad.get(a.exitId) || 0
    const lb = exitLoad.get(b.exitId) || 0
    // 负载差达到 1 人及以上时优先走人少的出口，否则按综合评分
    if (Math.abs(la - lb) >= 1) return la - lb
    return (b.score || 0) - (a.score || 0)
  })[0]
}

/** 候选方案 → EvacuationRoute（结构对齐 buildingEvacuationTypes） */
function routeFromCandidate(cand, { planId, floorId, zone, personCount }) {
  return emptyRoute({
    routeId: `${planId}:${floorId}:${zone}`,
    floorId,
    zone,
    startNode: cand.startNode,
    exitId: cand.exitId,
    exitLabel: cand.exitLabel,
    nodes: [...(cand.nodes || [])],
    points: (cand.points || []).map((p) => ({ x: p.x, y: p.y })),
    distance: cand.distance,
    estimatedTime: cand.estimatedTime,
    riskLevel: cand.riskLevel,
    valid: Boolean(cand.valid),
    reasons: [...(cand.reasons || [])],
    floorsPassed: [...(cand.floorsPassed || [])],
    fireDistance: cand.fireDistance,
    escapeDistance: cand.escapeDistance,
    exitDistance: cand.exitDistance,
    personCount,
    sourcePlanId: cand.id,
  })
}

/** 汇总指标（UI / 后端校验直接消费） */
export function summarizeBuildingPlan(routes = [], groups = []) {
  const list = routes.filter(Boolean)
  const floors = [...new Set(list.map((r) => r.floorId))]
    .sort((a, b) => floorNum(b) - floorNum(a))
  const exits = {}
  list.forEach((r) => {
    exits[r.exitId] = (exits[r.exitId] || 0) + (r.personCount || 0)
  })
  const times = list.map((r) => r.estimatedTime || 0)
  const riskLevel = list.reduce((acc, r) => (
    (RISK_RANK[r.riskLevel] ?? 0) > (RISK_RANK[acc] ?? 0) ? r.riskLevel : acc
  ), RISK_LEVEL.LOW)
  const personCount = list.reduce((s, r) => s + (r.personCount || 0), 0)
  return emptySummary({
    zoneCount: groups.length,
    routeCount: list.length,
    validRouteCount: list.filter((r) => r.valid).length,
    personCount,
    floors,
    exits,
    exitLabels: [...new Set(list.map((r) => r.exitLabel).filter(Boolean))],
    totalDistance: Math.round(list.reduce((s, r) => s + (r.distance || 0), 0) * 10) / 10,
    maxEstimatedTime: times.length ? Math.max(...times) : 0,
    avgEstimatedTime: times.length ? Math.round((times.reduce((s, t) => s + t, 0) / times.length) * 10) / 10 : 0,
    riskLevel,
    stairRouteCount: list.filter((r) => (r.floorsPassed || []).length > 1).length,
  })
}

/**
 * ④ 生成一整套整栋楼疏散方案（一个 strategy = 一个 BuildingEvacuationPlan）
 */
export function planBuildingEvacuation(opts = {}) {
  const {
    buildingId = '', buildingName = '', strategy = STRATEGY.BALANCED,
    persons = [], fire = null, maxFloor = 6, graph = null,
    k = 3, limit = 3, idPrefix = 'PLAN', createdAt = null,
    excludeStatuses = [],
  } = opts
  const g = graph || buildBuildingGraph(maxFloor)
  const meta = STRATEGY_META[strategy] || STRATEGY_META[STRATEGY.BALANCED]
  const planId = `${idPrefix}-${meta.label}`
  const groups = groupPersonsByZone(persons, { buildingId: buildingId || null, excludeStatuses })

  const exitLoad = new Map()
  const routes = []
  const missingZones = []
  for (const grp of groups) {
    const { candidates } = planZoneRoutes({
      graph: g, floorId: grp.floorId, zone: grp.zone, fire,
      personCount: grp.personCount, k, limit, idPrefix,
    })
    const chosen = pickRouteByStrategy(candidates, strategy, { exitLoad })
    if (!chosen) { missingZones.push(grp.zoneKey); continue }
    exitLoad.set(chosen.exitId, (exitLoad.get(chosen.exitId) || 0) + grp.personCount)
    routes.push(routeFromCandidate(chosen, {
      planId, floorId: grp.floorId, zone: grp.zone, personCount: grp.personCount,
    }))
  }

  const plan = emptyBuildingPlan({
    id: planId,
    name: `方案${meta.label}·${meta.name}`,
    buildingId,
    buildingName,
    strategy,
    strategyLabel: meta.label,
    fire: fire
      ? { buildingId: fire.buildingId || buildingId, floorId: fire.floorId, zone: fire.zone }
      : null,
    createdAt,
  })
  plan.routes = routes
  plan.routesByZone = Object.fromEntries(
    routes.map((r) => [zoneKeyOf(r.floorId, r.zone), r]),
  )
  plan.summary = summarizeBuildingPlan(routes, groups)

  const v = validateBuildingEvacuationPlan(plan, { graph: g, groups, fire })
  plan.valid = v.valid
  plan.reasons = v.reasons
  return { plan, graph: g, groups, missingZones }
}

/**
 * 一次生成 PLAN-A / PLAN-B / PLAN-C 三套「整栋楼」方案
 * A = 均衡疏散 / B = 快速疏散 / C = 安全优先
 */
export function planBuildingStrategies(opts = {}) {
  const { strategies = [STRATEGY.BALANCED, STRATEGY.FASTEST, STRATEGY.SAFEST], maxFloor = 6, graph = null } = opts
  let g = graph || buildBuildingGraph(maxFloor)
  const plans = []
  let groups = []
  const missing = {}
  strategies.forEach((strategy) => {
    const res = planBuildingEvacuation({ ...opts, strategy, graph: g })
    g = res.graph
    groups = res.groups
    missing[strategy] = res.missingZones
    plans.push(res.plan)
  })
  // A 为默认推荐（均衡）
  plans.forEach((p, i) => { p.recommended = i === 0 })
  return { plans, graph: g, groups, missingZonesByStrategy: missing }
}

/**
 * ⑤ 整栋楼方案合法性校验（逐条路线复用现有 validateRoute）
 *   - scope 必须为 BUILDING
 *   - 每个「有人员的 floorId + zone」都必须有合法路线
 *   - 每条路线：不穿墙 / 不经过火区 / 终点为 1F 安全出口 / 跨层必经楼梯
 */
export function validateBuildingEvacuationPlan(plan, opts = {}) {
  const { graph, groups = null, fire = null, blockedNodes = null } = opts
  const reasons = []
  const invalidRoutes = []
  if (!plan) return { valid: false, reasons: ['方案为空'], invalidRoutes }
  if (plan.scope !== EVACUATION_SCOPE.BUILDING) reasons.push(`疏散范围必须为 BUILDING，实际 ${plan.scope}`)

  const routes = plan.routes || []
  if (!routes.length) reasons.push('整栋楼方案不包含任何路线')

  const f = fire || plan.fire
  const exitIds = graph ? exitIdsOf(graph, '1F') : null
  routes.forEach((r) => {
    if (!graph) return
    // 火灾障碍按「该路线所属区域」推导：与火源共用门厅的区域（同层 A区/B区）不被封死，
    // 因此不能用全楼并集校验，否则会误判火源区唯一出路为非法。
    const blocked = blockedNodes
      || fireBlockSets(graph, f, r.floorId, r.zone, r.startNode).blockedNodes
    const v = validateRoute(r, { graph, blockedNodes: blocked })
    if (!v.valid) {
      invalidRoutes.push({ zoneKey: zoneKeyOf(r.floorId, r.zone), reasons: v.reasons })
      reasons.push(`${r.floorId}-${r.zone} 路线非法：${v.reasons.join('；')}`)
    }
    if (exitIds && !exitIds.includes(r.exitId)) {
      invalidRoutes.push({ zoneKey: zoneKeyOf(r.floorId, r.zone), reasons: ['终点不是 1F 安全出口'] })
      reasons.push(`${r.floorId}-${r.zone} 终点不是 1F 安全出口：${r.exitId}`)
    }
    if (floorNum(r.floorId) > 1 && !(r.floorsPassed || []).includes('1F')) {
      reasons.push(`${r.floorId}-${r.zone} 未下降到 1F`)
    }
  })

  // 覆盖度：有人员的区域必须都有路线
  if (groups && groups.length) {
    groups.forEach((g) => {
      if (!plan.routesByZone || !plan.routesByZone[g.zoneKey]) {
        reasons.push(`${g.zoneKey} 有 ${g.personCount} 人但没有疏散路线`)
      }
    })
  }
  return { valid: reasons.length === 0, reasons, invalidRoutes }
}

/** 取某个区域（floorId + zone）的路线 */
export function routeOfZone(plan, floorId, zone) {
  if (!plan) return null
  return (plan.routesByZone || {})[zoneKeyOf(floorId, zone)] || null
}

/** 取某个人员（buildingId/floorId/zone）的路线 —— 后端下发 routePoints 与前端 3D 消费同一个 routeId */
export function routeOfPerson(plan, person) {
  if (!plan || !person) return null
  return routeOfZone(plan, person.floorId, person.zone)
}

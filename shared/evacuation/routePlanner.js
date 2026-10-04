/**
 * 疏散路线规划器 —— A/B/C 候选方案的唯一产出者
 *
 * 流程：
 *   人员所在区域（起点节点）
 *     → 从图中剔除火灾节点（动态障碍）
 *     → Dijkstra 求最短路
 *     → Yen K 最短路求第二/第三路径
 *     → 逐条 validateRoute（不穿墙 / 不经过火区 / 必须到出口）
 *     → 计算 distance / estimatedTime / riskLevel / fireDistance / exitDistance
 *     → 按综合评分排序，取前 3 条命名为 方案A / 方案B / 方案C
 */
import {
  NODE_TYPE, PLAN_LABELS, PLAN_STATUS, RISK_LEVEL, ROUTE_CONST, emptyPlan,
} from './routeTypes.js'
import {
  buildBuildingGraph, exitIdsOf, kShortestPaths, pathCost,
  euclid, edgeKey, ZONE_NODE_KEY, ZONE_CORRIDOR_KEY, blockedNodesForFire,
  riskByFireDistance, floorNum,
} from './routeGraph.js'
import { validateRoute } from './routeValidator.js'

const { PX_PER_M, EVAC_SPEED, STAIR_PENALTY_S } = ROUTE_CONST

/** 起点节点 → 区域Id（A区/B区/...） */
export function startNodeId(graph, floorId, zone) {
  const key = ZONE_NODE_KEY[zone]
  const id = `${floorId}:${key}`
  return graph.nodes[id] ? id : null
}

/**
 * 单条路径 → 方案对象（含全部指标）
 * @param {object} graph
 * @param {string[]} nodes 节点 id 序列
 * @param {object} opts
 */
export function buildPlan(graph, nodes, opts = {}) {
  const {
    idPrefix = 'PLAN', index = 0, fireNodeIds = new Set(), congestion = 0, exits = null,
  } = opts
  const nodeList = nodes.map((id) => graph.nodes[id]).filter(Boolean)
  const points = nodeList.map((n) => ({ x: n.x, y: n.y }))
  const start = nodeList[0]
  const end = nodeList[nodeList.length - 1]

  const floorsPassed = []
  nodeList.forEach((n) => { if (!floorsPassed.includes(n.floorId)) floorsPassed.push(n.floorId) })
  const floorsDescended = Math.max(0, floorNum(start.floorId) - floorNum(end.floorId))

  const distance = Math.round(pathCost(nodes, graph) * 10) / 10
  const estimatedTime = Math.round(distance / EVAC_SPEED + floorsDescended * STAIR_PENALTY_S)

  // 距火源最近距离（m）：不含起点房间本身 —— 从着火房间撤离是无可避免的第一段
  let fireDistance = Infinity
  // 脱离距离（m）：路线上第一个「楼梯 / 安全出口」距火源的距离，代表脱离本层火源影响的快慢
  let escapeDistance = Infinity
  if (fireNodeIds && fireNodeIds.size) {
    const firePts = [...fireNodeIds].map((id) => graph.nodes[id]).filter(Boolean)
    points.forEach((p, i) => {
      if (i === 0) return
      firePts.forEach((f) => {
        const d = euclid(p, f) / PX_PER_M
        if (d < fireDistance) fireDistance = d
      })
    })
    const escapeNode = nodeList.find(
      (n, i) => i > 0 && (n.type === NODE_TYPE.STAIR || n.type === NODE_TYPE.EXIT),
    )
    if (escapeNode) {
      escapeDistance = Math.min(...firePts.map((f) => euclid(escapeNode, f) / PX_PER_M))
    }
  }
  fireDistance = Math.round(fireDistance * 10) / 10
  escapeDistance = Math.round(escapeDistance * 10) / 10

  // 起点到出口的直线距离（m）
  const exitDistance = end ? Math.round((euclid(start, end) / PX_PER_M) * 10) / 10 : 0

  const plan = emptyPlan({
    id: `${idPrefix}-${String.fromCharCode(65 + index)}`,
    name: `方案${PLAN_LABELS[index] || index + 1}`,
    startZones: start && start.zone ? [start.zone] : [],
    startNode: start ? start.id : '',
    exitId: end ? end.id : '',
    exitLabel: end ? end.label : '',
    distance,
    estimatedTime,
    // 风险等级由「脱离火源的快慢」推导：越快进入楼梯/出口 → 风险越低
    riskLevel: riskByFireDistance(isFinite(escapeDistance) ? escapeDistance : fireDistance),
    fireDistance,
    escapeDistance,
    exitDistance,
    floorsPassed,
    nodes: [...nodes],
    points,
    congestion,
  })

  const v = validateRoute(plan, { graph, blockedNodes: fireNodeIds, exits })
  plan.valid = v.valid
  plan.reasons = v.reasons
  if (!v.valid) plan.status = PLAN_STATUS.BLOCKED
  return plan
}

/**
 * 生成 A/B/C 候选方案
 * @param {object} opts
 * @param {object} opts.graph
 * @param {string} opts.startId       起点节点 id
 * @param {string[]} [opts.exitIds]   候选出口（默认取 1F 全部安全出口）
 * @param {Set<string>} [opts.blockedNodes] 火灾封锁节点
 * @param {Set<string>} [opts.blockedEdges] 封锁边
 * @param {number} [opts.k]           每个出口取几条（默认 3）
 * @param {number} [opts.limit]       最终保留几条（默认 3 → A/B/C）
 * @param {number} [opts.congestion]  该区域人数（用于评分）
 * @param {string} [opts.idPrefix]
 */
export function findPaths(opts = {}) {
  const {
    graph, startId, exitIds, blockedNodes = new Set(), blockedEdges = new Set(),
    k = 3, limit = 3, congestion = 0, idPrefix = 'PLAN', fireNodeIds = null,
  } = opts
  if (!graph || !graph.nodes[startId]) return []

  const goals = exitIds && exitIds.length ? exitIds : exitIdsOf(graph, '1F')
  const candidates = []
  const seen = new Set()

  goals.forEach((exitId) => {
    if (!graph.nodes[exitId]) return
    const paths = kShortestPaths(graph, startId, exitId, blockedNodes, blockedEdges, k)
    paths.forEach((p) => {
      const key = p.path.join('>')
      if (seen.has(key)) return
      seen.add(key)
      const plan = buildPlan(graph, p.path, {
        idPrefix, index: candidates.length, fireNodeIds: fireNodeIds || blockedNodes, congestion,
      })
      // 关键防线：不穿墙 / 不经过火区 / 必须到出口 —— 非法路线一律不展示
      if (!plan.valid) return
      candidates.push(plan)
    })
  })

  return rankPlans(candidates).slice(0, limit)
}

/** 综合评分 + 命名 A/B/C + 标记推荐/备用 */
export function rankPlans(plans) {
  const list = plans.filter((p) => p.valid)
  if (!list.length) return []
  const maxDist = Math.max(...list.map((p) => p.distance), 1)
  const maxTime = Math.max(...list.map((p) => p.estimatedTime), 1)
  const riskScore = { [RISK_LEVEL.LOW]: 1, [RISK_LEVEL.MEDIUM]: 0.55, [RISK_LEVEL.HIGH]: 0.1 }
  list.forEach((p) => {
    const normDist = 1 - p.distance / maxDist
    const normTime = 1 - p.estimatedTime / maxTime
    const risk = riskScore[p.riskLevel] ?? 0.5
    p.score = Math.round((risk * 0.45 + normTime * 0.25 + normDist * 0.2 + (p.fireDistance >= 40 ? 0.1 : 0)) * 100)
  })
  list.sort((a, b) => b.score - a.score)

  // 出口多样性：先保证每个安全出口各有一条候选，再按评分补齐 —— 避免 A/B/C 三条路都通向同一出口
  const byExit = new Map()
  list.forEach((p) => {
    if (!byExit.has(p.exitId)) byExit.set(p.exitId, [])
    byExit.get(p.exitId).push(p)
  })
  const queues = [...byExit.values()]
  const ordered = []
  let round = 0
  while (ordered.length < list.length) {
    let added = false
    for (const q of queues) {
      if (q[round]) { ordered.push(q[round]); added = true }
      if (ordered.length === list.length) break
    }
    if (!added) break
    round += 1
  }

  ordered.forEach((p, i) => {
    p.name = `方案${PLAN_LABELS[i] || i + 1}`
    p.id = p.id.replace(/-[A-Z]$/, `-${PLAN_LABELS[i] || i + 1}`)
    p.recommended = i === 0
    p.status = PLAN_STATUS.NORMAL
  })
  return ordered
}

/**
 * 一次调用完成：建图 → 火灾封锁 → 规划 → 校验
 * @param {object} opts
 * @param {string} opts.floorId   起点楼层（如 '5F'）
 * @param {string} opts.zone      起点区域（如 'A区'）
 * @param {string} [opts.fireZone] 火灾区域（默认与起点同区）
 * @param {boolean} [opts.spreadToCorridor]
 * @param {number} [opts.maxFloor] 楼栋层数（默认 6）
 * @param {number} [opts.congestion]
 */
export function planEvacuationRoutes(opts = {}) {
  const {
    floorId = '5F', zone = 'A区', fireZone = zone, spreadToCorridor = zone !== fireZone,
    maxFloor = 6, congestion = 0, limit = 3, idPrefix = 'PLAN',
  } = opts
  const graph = buildBuildingGraph(maxFloor)
  const startId = startNodeId(graph, floorId, zone)
  if (!startId) return { graph, plans: [], blockedNodes: [], fireNodeIds: [], startId: null }

  // 火灾 → 动态障碍：火源房间必封；其他区域的路线还要避开火源门厅（火势蔓延走廊）。
  // 例外：与火源共用同一门厅的区域（如 A区/B区 同一门厅）不能被封死 —— 那会是它唯一的出路。
  const startHall = ZONE_CORRIDOR_KEY[ZONE_NODE_KEY[zone]]
  const fireHall = ZONE_CORRIDOR_KEY[ZONE_NODE_KEY[fireZone]]
  const spread = Boolean(spreadToCorridor) && startHall !== fireHall
  const fireNodeIds = fireZone ? blockedNodesForFire({ floorId, zone: fireZone, spreadToCorridor: false }) : new Set()
  const blockedNodes = fireZone
    ? blockedNodesForFire({ floorId, zone: fireZone, spreadToCorridor: spread })
    : new Set()
  // 火源区人员必须从火源房间撤离 —— 火源房间作为「起点」时允许进入（撤离动作本身不可避免）
  if (blockedNodes.has(startId)) blockedNodes.delete(startId)

  const plans = findPaths({ graph, startId, blockedNodes, fireNodeIds, congestion, limit, idPrefix })
  return { graph, plans, blockedNodes: [...blockedNodes], fireNodeIds: [...fireNodeIds], startId }
}

export { buildBuildingGraph, blockedNodesForFire, validateRoute, NODE_TYPE, edgeKey }

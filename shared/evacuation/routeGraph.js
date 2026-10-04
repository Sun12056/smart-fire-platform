/**
 * 楼层拓扑 + 寻路算法（前端、Worker、3D 共用这一份）
 *
 * 设计原则：
 *   1. 先定义「节点 + 连接关系」的拓扑，再寻路 —— 不直接用像素坐标连两点；
 *   2. 火灾区域作为动态障碍从图中剔除（blockedNodes），而不是事后过滤；
 *   3. 所有坐标沿用建筑平面图 SVG 560×300 空间，与设备/人员/3D 模型同源。
 *
 * 楼栋结构（与 src/mock/floorPlanData.js 同源）：
 *   ┌──────────┬──────────┐
 *   │    A     │    C     │    ← 北排房间（门在 y=150）
 *   ├──────────┼──────────┤    ← 主走廊 y=150~190，中心线 y=170
 *   │    B     │    D     │    ← 南排房间（门在 y=190）
 *   └──────────┴──────────┘
 *   四角设楼梯（NW/NE/SW/SE），1F 走廊两端设西侧/东侧安全出口。
 */
import { NODE_TYPE, ROUTE_CONST, RISK_LEVEL } from './routeTypes.js'

const { PX_PER_M, STAIR_DESCENT_M, RISK_FAR_M, RISK_NEAR_M } = ROUTE_CONST

// ══════════════════════════════════════
// ① 节点定义
// ══════════════════════════════════════

/**
 * 单层节点蓝本。
 * 说明：房间的疏散起点取「门口」而非房间几何中心 —— 房间只有通过门才能进入走廊，
 *      这样既符合真实通行约束，也保证路线第一段不会从房间内部穿出。
 * @type {Array<{key:string,x:number,y:number,type:import('./routeTypes.js').NodeType,zone?:string,label:string}>}
 */
export const FLOOR_NODE_BLUEPRINTS = [
  { key: 'A_CENTER', x: 140, y: 150, type: NODE_TYPE.ROOM, zone: 'A区', label: 'A区门口' },
  { key: 'B_CENTER', x: 140, y: 190, type: NODE_TYPE.ROOM, zone: 'B区', label: 'B区门口' },
  { key: 'C_CENTER', x: 415, y: 150, type: NODE_TYPE.ROOM, zone: 'C区', label: 'C区门口' },
  { key: 'D_CENTER', x: 415, y: 190, type: NODE_TYPE.ROOM, zone: 'D区', label: 'D区门口' },

  { key: 'CORRIDOR_N', x: 140, y: 170, type: NODE_TYPE.CORRIDOR, label: 'A/B 门厅' },
  { key: 'CORRIDOR_CENTER', x: 280, y: 170, type: NODE_TYPE.CORRIDOR, label: '主走廊中心' },
  { key: 'CORRIDOR_S', x: 415, y: 170, type: NODE_TYPE.CORRIDOR, label: 'C/D 门厅' },
  { key: 'CORRIDOR_W', x: 72, y: 170, type: NODE_TYPE.CORRIDOR, label: '西端楼梯厅' },
  { key: 'CORRIDOR_E', x: 477, y: 170, type: NODE_TYPE.CORRIDOR, label: '东端楼梯厅' },

  { key: 'STAIR_NW', x: 72, y: 45, type: NODE_TYPE.STAIR, label: '西北楼梯' },
  { key: 'STAIR_NE', x: 477, y: 45, type: NODE_TYPE.STAIR, label: '东北楼梯' },
  { key: 'STAIR_SW', x: 72, y: 272, type: NODE_TYPE.STAIR, label: '西南楼梯' },
  { key: 'STAIR_SE', x: 477, y: 272, type: NODE_TYPE.STAIR, label: '东南楼梯' },
]

/** 区域 → 起点节点 */
export const ZONE_NODE_KEY = {
  'A区': 'A_CENTER',
  'B区': 'B_CENTER',
  'C区': 'C_CENTER',
  'D区': 'D_CENTER',
}

/** 房间节点 → 其接入的门厅节点（火灾影响走廊时可作为二次封锁对象） */
export const ZONE_CORRIDOR_KEY = {
  A_CENTER: 'CORRIDOR_N',
  B_CENTER: 'CORRIDOR_N',
  C_CENTER: 'CORRIDOR_S',
  D_CENTER: 'CORRIDOR_S',
}

/** 安全出口（仅 1F 直通室外；其余楼层必须经楼梯下行到 1F） */
export const EXIT_BLUEPRINTS = [
  { key: 'EXIT_W', x: 32, y: 170, type: NODE_TYPE.EXIT, label: '西侧安全出口', side: 'left' },
  { key: 'EXIT_E', x: 528, y: 170, type: NODE_TYPE.EXIT, label: '东侧安全出口', side: 'right' },
]

// ══════════════════════════════════════
// ② 连接关系（拓扑依据）
// ══════════════════════════════════════

export const FLOOR_EDGE_BLUEPRINTS = [
  ['A_CENTER', 'CORRIDOR_N'],
  ['B_CENTER', 'CORRIDOR_N'],
  ['C_CENTER', 'CORRIDOR_S'],
  ['D_CENTER', 'CORRIDOR_S'],

  ['CORRIDOR_N', 'CORRIDOR_CENTER'],
  ['CORRIDOR_S', 'CORRIDOR_CENTER'],
  ['CORRIDOR_N', 'CORRIDOR_W'],
  ['CORRIDOR_S', 'CORRIDOR_E'],

  ['CORRIDOR_W', 'STAIR_NW'],
  ['CORRIDOR_W', 'STAIR_SW'],
  ['CORRIDOR_E', 'STAIR_NE'],
  ['CORRIDOR_E', 'STAIR_SE'],
]

/** 四角楼梯在 1F 接入安全出口（四角楼梯下行后经 1F 走廊末端出楼） */
export const EXIT_EDGE_BLUEPRINTS = [
  ['CORRIDOR_W', 'EXIT_W'],
  ['STAIR_NW', 'EXIT_W'],
  ['STAIR_SW', 'EXIT_W'],
  ['CORRIDOR_E', 'EXIT_E'],
  ['STAIR_NE', 'EXIT_E'],
  ['STAIR_SE', 'EXIT_E'],
]

/** 可跨层下降的楼梯 */
export const STAIR_KEYS = ['STAIR_NW', 'STAIR_NE', 'STAIR_SW', 'STAIR_SE']

// ══════════════════════════════════════
// ③ 墙体（路线合法性校验用，禁止穿越）
// ══════════════════════════════════════
export const WALLS = [
  { x: 90, y: 28, w: 105, h: 120, type: 'room' },   // A区
  { x: 90, y: 210, w: 105, h: 70, type: 'room' },   // B区
  { x: 375, y: 28, w: 80, h: 120, type: 'room' },   // C区
  { x: 375, y: 210, w: 80, h: 70, type: 'room' },   // D区
  { x: 195, y: 20, w: 6, h: 130, type: 'inner' },   // A/C 左墙
  { x: 355, y: 20, w: 6, h: 130, type: 'inner' },   // A/C 右墙
  { x: 195, y: 190, w: 6, h: 110, type: 'inner' },  // B/D 左墙
  { x: 355, y: 190, w: 6, h: 110, type: 'inner' },  // B/D 右墙
]

// ══════════════════════════════════════
// ④ 建图
// ══════════════════════════════════════

export function edgeKey(a, b) {
  return [a, b].sort().join('|')
}

export function euclid(a, b) {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2)
}

export function nodeId(floorId, key) {
  return `${floorId}:${key}`
}

export function floorNum(floorId) {
  return parseInt(String(floorId).replace('F', ''), 10) || 1
}

/** 单层图 */
export function buildFloorGraph(floorId) {
  const nodes = {}
  const adj = {}
  const add = (bp) => {
    const id = nodeId(floorId, bp.key)
    nodes[id] = {
      id, floorId, key: bp.key, x: bp.x, y: bp.y, type: bp.type,
      zone: bp.zone || null, label: bp.label, side: bp.side || null,
    }
    adj[id] = []
    return id
  }
  FLOOR_NODE_BLUEPRINTS.forEach(add)
  if (floorNum(floorId) === 1) EXIT_BLUEPRINTS.forEach(add)

  const link = (ka, kb, weight) => {
    const a = nodeId(floorId, ka)
    const b = nodeId(floorId, kb)
    if (!nodes[a] || !nodes[b]) return
    const w = weight != null ? weight : Math.round((euclid(nodes[a], nodes[b]) / PX_PER_M) * 100) / 100
    const ek = edgeKey(a, b)
    adj[a].push({ to: b, w, ek })
    adj[b].push({ to: a, w, ek })
  }
  FLOOR_EDGE_BLUEPRINTS.forEach(([a, b]) => link(a, b))
  if (floorNum(floorId) === 1) EXIT_EDGE_BLUEPRINTS.forEach(([a, b]) => link(a, b))

  return { nodes, adj, floorId }
}

/** 完整楼栋图（含跨楼层楼梯下降边） */
export function buildBuildingGraph(maxFloor = 6) {
  const nodes = {}
  const adj = {}
  const n = floorNum(`${maxFloor}F`)

  for (let f = n; f >= 1; f--) {
    const g = buildFloorGraph(`${f}F`)
    Object.assign(nodes, g.nodes)
    Object.assign(adj, g.adj)
  }
  // 跨楼层下降（STAIR_DESCENT_M / 层）
  STAIR_KEYS.forEach((key) => {
    for (let f = n; f >= 2; f--) {
      const up = nodeId(`${f}F`, key)
      const down = nodeId(`${f - 1}F`, key)
      if (!nodes[up] || !nodes[down]) continue
      const ek = edgeKey(up, down)
      adj[up].push({ to: down, w: STAIR_DESCENT_M, ek })
      adj[down].push({ to: up, w: STAIR_DESCENT_M, ek })
    }
  })

  return { nodes, adj, maxFloor: n }
}

/** 某楼层的安全出口节点 id 列表（真实出口在 1F） */
export function exitIdsOf(graph, floorId = '1F') {
  return Object.values(graph.nodes)
    .filter((n) => n.type === NODE_TYPE.EXIT && n.floorId === floorId)
    .map((n) => n.id)
}

/**
 * 火灾 → 动态障碍节点。
 * 默认只封锁火源房间节点；若火势已蔓延到走廊，可显式传入 spreadToCorridor 封锁门厅。
 * @param {object} opts
 * @param {string} opts.floorId
 * @param {string} opts.zone  'A区'|'B区'|'C区'|'D区'
 * @param {boolean} [opts.spreadToCorridor]
 * @param {string[]} [opts.extraNodes]
 */
export function blockedNodesForFire({ floorId, zone, spreadToCorridor = false, extraNodes = [] } = {}) {
  const key = ZONE_NODE_KEY[zone]
  const set = new Set()
  if (key) set.add(nodeId(floorId, key))
  if (spreadToCorridor && key && ZONE_CORRIDOR_KEY[key]) set.add(nodeId(floorId, ZONE_CORRIDOR_KEY[key]))
  extraNodes.forEach((k) => set.add(k.includes(':') ? k : nodeId(floorId, k)))
  return set
}

// ══════════════════════════════════════
// ⑤ 寻路算法
// ══════════════════════════════════════

/** Dijkstra（支持封锁节点/边） */
export function dijkstra(graph, startId, goalId, blockedNodes, blockedEdges) {
  const { nodes, adj } = graph
  if (!nodes[startId] || !nodes[goalId]) return null
  const dist = {}
  const prev = {}
  const visited = {}
  Object.keys(nodes).forEach((id) => (dist[id] = Infinity))
  dist[startId] = 0
  const pq = [{ id: startId, d: 0 }]
  while (pq.length) {
    pq.sort((a, b) => a.d - b.d)
    const cur = pq.shift()
    if (visited[cur.id]) continue
    visited[cur.id] = true
    if (cur.id === goalId) break
    if (blockedNodes && blockedNodes.has(cur.id)) continue
    adj[cur.id].forEach((e) => {
      if (blockedNodes && blockedNodes.has(e.to)) return
      if (blockedEdges && blockedEdges.has(e.ek)) return
      const nd = dist[cur.id] + e.w
      if (nd < dist[e.to]) {
        dist[e.to] = nd
        prev[e.to] = cur.id
        pq.push({ id: e.to, d: nd })
      }
    })
  }
  if (dist[goalId] === Infinity) return null
  const path = []
  let c = goalId
  while (c) {
    path.unshift(c)
    c = prev[c]
  }
  return { path, cost: dist[goalId] }
}

/** 路径总代价（按图权重，含跨层楼梯等效距离） */
export function pathCost(path, graph) {
  let c = 0
  for (let i = 0; i < path.length - 1; i++) {
    const a = graph.nodes[path[i]]
    const b = graph.nodes[path[i + 1]]
    if (!a || !b) continue
    c += Math.round((euclid(a, b) / PX_PER_M) * 100) / 100
    if (a.floorId !== b.floorId) c += STAIR_DESCENT_M
  }
  return Math.round(c * 100) / 100
}

/** K 最短路径（Yen 算法）—— A/B/C 候选路线的来源 */
export function kShortestPaths(graph, startId, goalId, blockedNodes, blockedEdges, k = 3) {
  const A = []
  const first = dijkstra(graph, startId, goalId, blockedNodes, blockedEdges)
  if (!first) return A
  A.push(first)
  const B = []
  for (let i = 0; i < k - 1; i++) {
    const prevPath = A[i].path
    for (let j = 0; j < prevPath.length - 1; j++) {
      const spurNode = prevPath[j]
      const rootPrefix = prevPath.slice(0, j + 1)
      const removedEdges = new Set(blockedEdges || [])
      A.forEach((p) => {
        if (p.path.length > j && p.path.slice(0, j + 1).join('>') === rootPrefix.join('>')) {
          removedEdges.add(edgeKey(p.path[j], p.path[j + 1]))
        }
      })
      const removedNodes = new Set(blockedNodes || [])
      rootPrefix.slice(0, j).forEach((nd) => removedNodes.add(nd))
      const spur = dijkstra(graph, spurNode, goalId, removedNodes, removedEdges)
      if (spur && spur.path.length) {
        const totalPath = rootPrefix.concat(spur.path.slice(1))
        const key = totalPath.join('>')
        if (!A.some((p) => p.path.join('>') === key) && !B.some((p) => p.path.join('>') === key)) {
          B.push({ path: totalPath, cost: pathCost(totalPath, graph) })
        }
      }
    }
    if (!B.length) break
    B.sort((a, b) => a.cost - b.cost)
    A.push(B.shift())
  }
  return A
}

/** 风险等级：由「路线与火源的最小距离」推导 */
export function riskByFireDistance(fireDistance) {
  if (!isFinite(fireDistance)) return RISK_LEVEL.LOW
  if (fireDistance < RISK_NEAR_M) return RISK_LEVEL.HIGH
  if (fireDistance < RISK_FAR_M) return RISK_LEVEL.MEDIUM
  return RISK_LEVEL.LOW
}

export { RISK_LEVEL }

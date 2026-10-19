/**
 * 楼层拓扑寻路 + 动态障碍（前端、Worker、3D 共用这一份）
 *
 * P1.8.1 变更：
 *   · 拓扑数据（节点/边/墙体/楼梯/出口/区域）**上移到 floorTopology.js**，本文件不再自带蓝图；
 *   · 建图改为经 topologyGraphAdapter.js 翻译，输出结构 `{ nodes, adj, ... }` 与变更前后完全一致；
 *   · Dijkstra / Yen K 最短路函数体**未做任何修改**；
 *   · 本文件保留全部既有导出（含蓝图常量），保证旧 import 不断。
 *
 * 设计原则：
 *   1. 先定义「节点 + 连接关系」的拓扑，再寻路 —— 不直接用像素坐标连两点；
 *   2. 火灾区域作为动态障碍从图中剔除（blockedNodes / blockedEdges），而不是事后过滤；
 *   3. 所有坐标沿用建筑平面图 SVG 560×300 空间，与设备/人员/3D 模型同源。
 */
import { NODE_TYPE, ROUTE_CONST, RISK_LEVEL } from './routeTypes.js'
import {
  FLOOR_NODES, ZONE_DEFS, ZONE_NODE_KEY, ZONE_CORRIDOR_KEY,
  EXIT_DEFS, STAIR_KEYS, WALLS, EDGE_TYPE,
  FLOOR_EDGE_DEFS, EXIT_EDGE_DEFS, floorEdgeDefsOf,
  nodeId, floorNum, edgeKey, euclid,
} from './floorTopology.js'
import {
  buildFloorTopologyGraph, buildBuildingTopologyGraph, edgeListOf, validateTopology,
} from './topologyGraphAdapter.js'

const { PX_PER_M, STAIR_DESCENT_M, RISK_FAR_M, RISK_NEAR_M } = ROUTE_CONST

// ══════════════════════════════════════
// ① 拓扑常量（重导出，来源已收敛到 floorTopology.js）
// ══════════════════════════════════════

/** 单层节点蓝本（13 个：4 房间门口 + 5 走廊 + 4 楼梯） */
export const FLOOR_NODE_BLUEPRINTS = FLOOR_NODES

/** 安全出口蓝本（仅 1F 直通室外） */
export const EXIT_BLUEPRINTS = EXIT_DEFS.map((e) => ({
  key: e.key, x: e.x, y: e.y, type: e.type, label: e.label, side: e.side,
}))

/** 单层连接关系（元组形式，兼容旧引用） */
export const FLOOR_EDGE_BLUEPRINTS = FLOOR_EDGE_DEFS.map((d) => [d.from, d.to])

/** 1F 出口连接关系（元组形式，兼容旧引用） */
export const EXIT_EDGE_BLUEPRINTS = EXIT_EDGE_DEFS.map((d) => [d.from, d.to])

export {
  NODE_TYPE, WALLS, ZONE_DEFS, ZONE_NODE_KEY, ZONE_CORRIDOR_KEY, EDGE_TYPE, STAIR_KEYS,
  nodeId, floorNum, edgeKey, euclid,
  edgeListOf, validateTopology,
}

// ══════════════════════════════════════
// ② 建图（委托给拓扑适配器，输出结构不变）
// ══════════════════════════════════════

/** 单层图 */
export function buildFloorGraph(floorId) {
  return buildFloorTopologyGraph(floorId)
}

/** 完整楼栋图（含跨楼层楼梯下降边） */
export function buildBuildingGraph(maxFloor = 6) {
  return buildBuildingTopologyGraph(maxFloor)
}

/** 某楼层的安全出口节点 id 列表（真实出口在 1F） */
export function exitIdsOf(graph, floorId = '1F') {
  return Object.values(graph.nodes)
    .filter((n) => n.type === NODE_TYPE.EXIT && n.floorId === floorId)
    .map((n) => n.id)
}

// ══════════════════════════════════════
// ③ 火灾 → 动态障碍
// ══════════════════════════════════════

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

/**
 * 火灾 → 动态障碍边（P1.8.1 新增）。
 * 当前火灾模型按「房间/门厅节点」封锁，边阻断能力由此入口提供：
 * 传入楼层与节点集合，凡两端**任一**落在封锁集合内的边即被切断。
 * 无封锁节点时返回空集（不改变既有行为）。
 */
export function blockedEdgesForFire(graph, blockedNodes) {
  const set = new Set()
  if (!graph || !blockedNodes || !blockedNodes.size) return set
  edgeListOf(graph).forEach((e) => {
    if (blockedNodes.has(e.from) || blockedNodes.has(e.to)) set.add(e.id)
  })
  return set
}

// ══════════════════════════════════════
// ④ 寻路算法（P1.8.1 未修改，逐字保留）
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

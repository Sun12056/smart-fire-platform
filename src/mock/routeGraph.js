/**
 * 消防疏散路网拓扑 —— 基于 floorPlanData.js 的建筑空间模型
 * 所有节点/边/墙/出口坐标来自统一的建筑数据源，路线与设备共享同一套坐标。
 */

import {
  buildPlanGraph, edgeKey, getFloorPlanNodes, getFloorPlanEdges,
  ROOM_AREAS, EXIT_NODES, ZONE_COLORS, WALLS, DOORS, STAIRS, ROOMS, CORRIDOR,
  FLOOR_HEIGHT_M, EVAC_SPEED, STAIR_PENALTY_S, getFloorTopology,
} from './floorPlanData.js'

// 重导出（保持 store 旧 import 兼容）
export {
  buildPlanGraph as buildBuildingGraph, edgeKey, ROOM_AREAS, EXIT_NODES,
  ZONE_COLORS, WALLS, DOORS, STAIRS, ROOMS, CORRIDOR,
  FLOOR_HEIGHT_M, EVAC_SPEED, STAIR_PENALTY_S, getFloorTopology,
  getFloorPlanNodes as FLOOR_NODES_FN, getFloorPlanEdges as FLOOR_EDGES_FN,
}

// 兼容旧引用
export const FLOOR_NODES = {
  'A区': { x: 140, y: 150 },
  'B区': { x: 140, y: 190 },
  'C区': { x: 415, y: 150 },
  'D区': { x: 415, y: 190 },
}

// ══════════════════════════════════════
// 寻路算法
// ══════════════════════════════════════

function euclid(a, b) {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2)
}

function pathCost(path, graph) {
  let c = 0
  for (let i = 0; i < path.length - 1; i++) {
    const a = graph.nodes[path[i]]
    const b = graph.nodes[path[i + 1]]
    if (!a || !b) return c
    c += euclid(a, b) / 10
  }
  return Math.round(c * 100) / 100
}

// Dijkstra
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

// K 最短路径（Yen 算法）
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
      const rootPathPrefix = prevPath.slice(0, j + 1)
      const removedEdges = new Set(blockedEdges || [])
      A.forEach((p) => {
        if (p.path.length > j && p.path.slice(0, j + 1).join('>') === rootPathPrefix.join('>')) {
          removedEdges.add(edgeKey(p.path[j], p.path[j + 1]))
        }
      })
      const removedNodes = new Set(blockedNodes || [])
      rootPathPrefix.slice(0, j).forEach((nd) => removedNodes.add(nd))
      const spur = dijkstra(graph, spurNode, goalId, removedNodes, removedEdges)
      if (spur && spur.path.length) {
        const totalPath = rootPathPrefix.concat(spur.path.slice(1))
        const key = totalPath.join('>')
        const exists = A.some((p) => p.path.join('>') === key) || B.some((p) => p.path.join('>') === key)
        if (!exists) B.push({ path: totalPath, cost: pathCost(totalPath, graph) })
      }
    }
    if (!B.length) break
    B.sort((a, b) => a.cost - b.cost)
    A.push(B.shift())
  }
  return A
}

// 单层相邻表
export function floorAdjacency() {
  const adj = {}
  const nodes = getFloorPlanNodes('1F')
  const edges = getFloorPlanEdges('1F')
  nodes.forEach((n) => (adj[n.id] = []))
  edges.forEach((e) => {
    adj[e.from].push(e.to)
    adj[e.to].push(e.from)
  })
  return adj
}

// ══════════════════════════════════════
// 路线合法性校验
// ══════════════════════════════════════

function segIntersectsRect(p1, p2, r) {
  const x1 = p1.x, y1 = p1.y, x2 = p2.x, y2 = p2.y
  const rx2 = r.x + r.w, ry2 = r.y + r.h
  const inside = (px, py) => px >= r.x && px <= rx2 && py >= r.y && py <= ry2
  if (inside(x1, y1) || inside(x2, y2)) return true
  const edges = [
    [{ x: r.x, y: r.y }, { x: rx2, y: r.y }],
    [{ x: rx2, y: r.y }, { x: rx2, y: ry2 }],
    [{ x: rx2, y: ry2 }, { x: r.x, y: ry2 }],
    [{ x: r.x, y: ry2 }, { x: r.x, y: r.y }],
  ]
  return edges.some(([a, b]) => segSeg(x1, y1, x2, y2, a.x, a.y, b.x, b.y))
}

function segSeg(x1, y1, x2, y2, x3, y3, x4, y4) {
  const d = (x2 - x1) * (y4 - y3) - (y2 - y1) * (x4 - x3)
  if (d === 0) return false
  const t = ((x3 - x1) * (y4 - y3) - (y3 - y1) * (x4 - x3)) / d
  const u = ((x3 - x1) * (y2 - y1) - (y3 - y1) * (x2 - x1)) / d
  return t >= 0 && t <= 1 && u >= 0 && u <= 1
}

export function validateRoute(pathNodes, opts = {}) {
  const reasons = []
  if (!pathNodes || pathNodes.length < 2) return { valid: false, reasons: ['路径为空'] }
  const first = pathNodes[0]
  const last = pathNodes[pathNodes.length - 1]
  if (first.type !== 'room' && first.type !== 'door') reasons.push('起点不在房间')
  if (last.type !== 'exit') reasons.push('终点未到达安全出口')
  const edgeSet = opts.edgeSet
  for (let i = 0; i < pathNodes.length - 1; i++) {
    const a = pathNodes[i]
    const b = pathNodes[i + 1]
    if (a.type === 'room' && b.type === 'room') reasons.push('房间直接连接房间（禁止穿房）')
    if (edgeSet && !edgeSet.has(edgeKey(a.id, b.id))) reasons.push(`非法节点跳跃: ${a.id}→${b.id}`)
  }
  // 仅校验房间实体墙（不校验外墙，因为路线沿走廊可能贴外墙行走）
  const roomWalls = (opts.walls || WALLS).filter(w => w.type === 'room' || w.type === 'inner')
  for (let i = 0; i < pathNodes.length - 1; i++) {
    const a = pathNodes[i]
    const b = pathNodes[i + 1]
    if (roomWalls.some(r => segIntersectsRect(a, b, r))) {
      reasons.push(`路线穿墙/穿房间: ${a.id}→${b.id}`)
    }
  }
  return { valid: reasons.length === 0, reasons }
}

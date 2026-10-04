/**
 * 消防疏散路网 —— 统一算法入口
 *
 * 唯一算法实现位于 shared/evacuation（前端、Worker、3D 共用同一份）：
 *   - routeGraph.js    拓扑 + Dijkstra + Yen K 最短路
 *   - routeValidator.js 绝不穿墙校验
 *   - routePlanner.js  A/B/C 候选方案
 * 本文件只做两件事：
 *   1. 重导出 shared 的算法（保证前端页面与新规划器同源）；
 *   2. 保留旧调用签名适配（validateRoute(pathNodes, { edgeSet })）。
 * 楼层平面数据（房间/门/走廊/楼梯/出口坐标）仍来自 floorPlanData.js。
 */
import {
  edgeKey, getFloorPlanNodes, getFloorPlanEdges,
  ROOM_AREAS, EXIT_NODES, ZONE_COLORS, WALLS, DOORS, STAIRS, ROOMS, CORRIDOR,
  FLOOR_HEIGHT_M, EVAC_SPEED, STAIR_PENALTY_S,
} from './floorPlanData.js'
import {
  dijkstra, kShortestPaths, euclid, pathCost, buildBuildingGraph as buildSharedGraph,
  FLOOR_NODE_BLUEPRINTS, FLOOR_EDGE_BLUEPRINTS, EXIT_BLUEPRINTS, ZONE_NODE_KEY,
  blockedNodesForFire, buildFloorGraph, exitIdsOf, STAIR_KEYS,
} from '../../shared/evacuation/routeGraph.js'
import { validateRoute as validateRouteShared } from '../../shared/evacuation/routeValidator.js'
import { findPaths, planEvacuationRoutes, rankPlans, buildPlan, startNodeId } from '../../shared/evacuation/routePlanner.js'

// 重导出（保持旧 import 兼容）
// ⚠️ buildBuildingGraph 已从这里移除：拓扑唯一数据源是 shared/evacuation，
//    旧名会让人误以为仍在用 floorPlanData 的图（曾经的坑）。请直接 import shared。
export {
  edgeKey, ROOM_AREAS, EXIT_NODES,
  ZONE_COLORS, WALLS, DOORS, STAIRS, ROOMS, CORRIDOR,
  FLOOR_HEIGHT_M, EVAC_SPEED, STAIR_PENALTY_S,
  getFloorPlanNodes as FLOOR_NODES_FN, getFloorPlanEdges as FLOOR_EDGES_FN,
  // shared 算法（新代码请直接引用 shared/evacuation，这里仅为兼容旧 import）
  dijkstra, kShortestPaths, pathCost, euclid,
  buildSharedGraph, buildFloorGraph, exitIdsOf, blockedNodesForFire,
  FLOOR_NODE_BLUEPRINTS, FLOOR_EDGE_BLUEPRINTS, EXIT_BLUEPRINTS, ZONE_NODE_KEY, STAIR_KEYS,
  findPaths, planEvacuationRoutes, rankPlans, buildPlan, startNodeId,
  validateRouteShared,
}

// 兼容旧引用
export const FLOOR_NODES = {
  'A区': { x: 140, y: 150 },
  'B区': { x: 140, y: 190 },
  'C区': { x: 415, y: 150 },
  'D区': { x: 415, y: 190 },
}

/**
 * 路网调试层（2D 视图画拓扑用）—— 必须与实际寻路同一张图，
 * 因此直接取 shared 的单层图，不再用 floorPlanData 的旧拓扑。
 */
export function getFloorTopology(floorId = '5F') {
  const g = buildFloorGraph(floorId)
  const nodes = Object.values(g.nodes).map((n) => ({
    id: n.id, key: n.key, x: n.x, y: n.y, type: n.type, label: n.label || n.key,
  }))
  const seen = new Set()
  const edges = []
  Object.entries(g.adj).forEach(([from, arr]) => {
    arr.forEach(({ to, ek }) => {
      if (seen.has(ek)) return
      seen.add(ek)
      edges.push({ from, to })
    })
  })
  return { nodes, edges }
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

/**
 * 旧签名适配：validateRoute(pathNodes, { edgeSet, walls, blockedNodes })
 * pathNodes 为节点对象数组（含 id/x/y/type），内部转成 shared 校验器的路线结构。
 */
export function validateRoute(pathNodes, opts = {}) {
  const list = Array.isArray(pathNodes) ? pathNodes.filter(Boolean) : []
  const route = {
    nodes: list.map((n) => n.id),
    points: list.map((n) => ({ x: n.x, y: n.y })),
    exitId: list.length ? list[list.length - 1].id : '',
  }
  const nodes = {}
  const adj = {}
  list.forEach((n) => {
    nodes[n.id] = n
    adj[n.id] = []
  })
  if (opts.edgeSet) {
    opts.edgeSet.forEach((k) => {
      const [a, b] = String(k).split('|')
      if (adj[a] && adj[b]) {
        adj[a].push({ to: b })
        adj[b].push({ to: a })
      }
    })
  } else {
    for (let i = 0; i < list.length - 1; i++) {
      const a = list[i].id
      const b = list[i + 1].id
      if (adj[a] && adj[b]) {
        adj[a].push({ to: b })
        adj[b].push({ to: a })
      }
    }
  }
  return validateRouteShared(route, {
    graph: { nodes, adj },
    walls: opts.walls || WALLS,
    blockedNodes: opts.blockedNodes ? new Set(opts.blockedNodes) : undefined,
    requireExitNode: opts.requireExitNode,
  })
}

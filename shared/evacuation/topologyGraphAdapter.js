/**
 * 拓扑 → 寻路图的适配器 —— P1.8.1
 *
 * 职责：把 floorTopology.js 的权威拓扑模型，转换成既有寻路算法消费的图结构。
 *
 * 关键边界（严格遵守）：
 *   ① 输出结构与 P1.8.1 之前**完全一致**：`{ nodes, adj, floorId|maxFloor }`，
 *      节点字段 `{ id, floorId, key, x, y, type, zone, label, side }`，邻接项 `{ to, w, ek }`；
 *      邻接项**追加** `t`（边类型）字段，既有读取方只读 `to/w/ek`，不受影响。
 *   ② 不重写 Dijkstra / Yen / 评分 / 校验几何 —— 只做「拓扑 → 图」的翻译；
 *   ③ 墙体不穿越校验**复用** routeValidator.js 的 segIntersectsRect，不新建第二套几何规则。
 */
import { NODE_TYPE } from './routeTypes.js'
import {
  FLOOR_NODES, EXIT_DEFS, EDGE_TYPE, WALLS,
  floorEdgeDefsOf, stairDescentEdgeDefs, stairDescentDistance,
  nodeId, floorNum, edgeKey, euclid, pxToM,
} from './floorTopology.js'
import { segIntersectsRect } from './routeValidator.js'

// ══════════════════════════════════════
// ① 拓扑 → 图
// ══════════════════════════════════════

/** 单层图：房间 → 门厅 → 走廊 → 楼梯（1F 另加安全出口） */
export function buildFloorTopologyGraph(floorId) {
  const nodes = {}
  const adj = {}

  FLOOR_NODES.forEach((bp) => {
    const id = nodeId(floorId, bp.key)
    nodes[id] = {
      id, floorId, key: bp.key, x: bp.x, y: bp.y, type: bp.type,
      zone: bp.zone || null, label: bp.label, side: null,
    }
    adj[id] = []
  })

  // 安全出口只在 1F 直通室外（其余楼层必须经楼梯下行到 1F）
  if (floorNum(floorId) === 1) {
    EXIT_DEFS.forEach((e) => {
      nodes[e.nodeId] = {
        id: e.nodeId, floorId: e.floorId, key: e.key, x: e.x, y: e.y,
        type: NODE_TYPE.EXIT, zone: null, label: e.label, side: e.side,
      }
      adj[e.nodeId] = []
    })
  }

  floorEdgeDefsOf(floorId).forEach((d) => {
    link(adj, nodes, nodeId(floorId, d.from), nodeId(floorId, d.to), d.type)
  })

  return { nodes, adj, floorId }
}

/** 完整楼栋图（含跨楼层楼梯下降边） */
export function buildBuildingTopologyGraph(maxFloor = 6) {
  const nodes = {}
  const adj = {}
  const n = floorNum(`${maxFloor}F`)

  for (let f = n; f >= 1; f--) {
    const g = buildFloorTopologyGraph(`${f}F`)
    Object.assign(nodes, g.nodes)
    Object.assign(adj, g.adj)
  }

  // 跨楼层下降（D2：仅当楼梯在上下两层都可用时才有这条边）
  const descent = stairDescentDistance()
  stairDescentEdgeDefs(maxFloor).forEach((d) => {
    const up = nodeId(d.fromFloor, d.from)
    const down = nodeId(d.toFloor, d.to)
    if (!nodes[up] || !nodes[down]) return
    push(adj, up, down, descent, d.type)
  })

  return { nodes, adj, maxFloor: n }
}

function link(adj, nodes, a, b, type) {
  if (!nodes[a] || !nodes[b]) return
  push(adj, a, b, pxToM(euclid(nodes[a], nodes[b])), type)
}

function push(adj, a, b, w, type) {
  const ek = edgeKey(a, b)
  adj[a].push({ to: b, w, ek, t: type })
  adj[b].push({ to: a, w, ek, t: type })
}

// ══════════════════════════════════════
// ② 边实体视图（供测试 / 可达性 / 阻断消费）
// ══════════════════════════════════════

/**
 * 把邻接表展开为去重后的边实体列表。
 * 每条边：{ id, from, to, type, floorId, distance, walkable, blocked }
 *   · id        = edgeKey(from,to)，与既有 blockedEdges 口径一致
 *   · distance  单位 m（跨层为楼梯等效距离）
 *   · walkable  拓扑层面是否可通行（楼梯停用导致的跨层缺失边根本不会进图）
 *   · blocked   火灾/人为阻断标记（由阻断层写入，此处默认 false）
 */
export function edgeListOf(graph) {
  const seen = new Set()
  const out = []
  Object.entries(graph.adj || {}).forEach(([from, arr]) => {
    arr.forEach((e) => {
      if (seen.has(e.ek)) return
      seen.add(e.ek)
      const a = graph.nodes[from]
      const b = graph.nodes[e.to]
      out.push({
        id: e.ek,
        from,
        to: e.to,
        type: e.t || null,
        floorId: a && b && a.floorId === b.floorId ? a.floorId : `${a ? a.floorId : '?'}>${b ? b.floorId : '?'}`,
        distance: e.w,
        walkable: true,
        blocked: false,
      })
    })
  })
  return out
}

/** 某层的边实体 */
export function edgeListOfFloor(graph, floorId) {
  return edgeListOf(graph).filter((e) => e.floorId === floorId)
}

/** 拓扑节点视图 */
export function nodeListOf(graph) {
  return Object.values(graph.nodes || {})
}

// ══════════════════════════════════════
// ③ 拓扑自检（T1 / T2 / T3 / T6）
// ══════════════════════════════════════

/**
 * 拓扑合法性自检。
 * 复用 routeValidator.segIntersectsRect 做「边不得穿墙」，不新建几何规则。
 * 跨层下降边是垂直交通，不参与平面墙体校验。
 *
 * @param {object} graph
 * @param {Array} [walls] 默认取拓扑自带墙体
 * @returns {{ok:boolean, errors:string[]}}
 */
export function validateTopology(graph, walls = null) {
  const errors = []
  const wallList = walls || WALLS
  const nodes = graph && graph.nodes
  if (!nodes) return { ok: false, errors: ['图为空'] }

  // T1：各类节点必须进入拓扑
  const types = new Set(Object.values(nodes).map((n) => n.type))
  ;[NODE_TYPE.ROOM, NODE_TYPE.CORRIDOR, NODE_TYPE.STAIR, NODE_TYPE.EXIT].forEach((t) => {
    if (!types.has(t)) errors.push(`拓扑缺少类型为 ${t} 的节点`)
  })
  const zones = new Set(Object.values(nodes).map((n) => n.zone).filter(Boolean))
  ;['A区', 'B区', 'C区', 'D区'].forEach((z) => {
    if (!zones.has(z)) errors.push(`拓扑缺少区域 ${z}`)
  })
  if (!Object.values(nodes).some((n) => n.type === NODE_TYPE.EXIT)) {
    errors.push('拓扑缺少安全出口节点')
  }

  // T2：节点 id 唯一（Object 键天然唯一，此处校验显式 id 与键一致）
  Object.entries(nodes).forEach(([key, n]) => {
    if (!n || n.id !== key) errors.push(`节点 id 与键不一致: ${key}`)
  })

  // T2 + T3：边 id 唯一、两端存在、距离为正、不穿墙
  const seenEdge = new Set()
  edgeListOf(graph).forEach((e) => {
    if (seenEdge.has(e.id)) errors.push(`重复 edgeId: ${e.id}`)
    seenEdge.add(e.id)
    const a = nodes[e.from]
    const b = nodes[e.to]
    if (!a) errors.push(`边 ${e.id} 的 from 节点不存在: ${e.from}`)
    if (!b) errors.push(`边 ${e.id} 的 to 节点不存在: ${e.to}`)
    if (!(e.distance > 0)) errors.push(`边 ${e.id} 的 distance 非正: ${e.distance}`)
    if (!a || !b) return
    // T6：跨层下降边不做平面墙体校验
    if (a.floorId !== b.floorId) return
    if (wallList.some((r) => segIntersectsRect(a, b, r))) {
      errors.push(`边 ${e.id} 穿越墙体/房间: ${a.key}→${b.key}`)
    }
  })

  return { ok: errors.length === 0, errors }
}

export { EDGE_TYPE }

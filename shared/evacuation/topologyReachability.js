/**
 * Zone → Exit 可达性 —— P1.8.1
 *
 * 目标：让「哪些区域能够到达哪些出口」成为**可计算**的结论，而不是写死的字面量。
 *
 * 三态语义：
 *   reachable    在当前阻断条件下存在通路
 *   blocked      当前无通路，但**移除火灾阻断后**存在通路（被火灾/出口不可用阻断）
 *   unreachable  即使移除阻断也不存在通路（拓扑结构上不通）
 *
 * 边界：本文件只做「能不能到」，不做「走哪条更好」—— 出口选择 / 评分 / 分流属 P1.8.2。
 */
import { EXIT_DEFS, EXIT_BY_NODE_ID, EXIT_STATUS, ZONE_NODE_KEY, nodeId } from './floorTopology.js'
import { dijkstra } from './routeGraph.js'

/** 可达性状态 */
export const REACHABILITY = {
  REACHABLE: 'reachable',
  BLOCKED: 'blocked',
  UNREACHABLE: 'unreachable',
}

const EMPTY_NODES = new Set()
const EMPTY_EDGES = new Set()

/**
 * 单个起点 → 单个出口的可达性判定。
 * @param {object} graph
 * @param {string} startId   起点节点 id
 * @param {string} exitNodeId 出口节点 id
 * @param {Set<string>} [blockedNodes]
 * @param {Set<string>} [blockedEdges]
 * @param {Array} [exits]     出口实体（用于可用性判定）
 */
export function exitReachability(graph, startId, exitNodeId, blockedNodes, blockedEdges, exits = EXIT_DEFS) {
  // 优先采用传入的 exits（运行态可覆盖 available/status），缺省才回落到静态定义
  const exit = (exits || []).find((e) => e.nodeId === exitNodeId) || EXIT_BY_NODE_ID[exitNodeId] || null

  // 出口自身不可用 → 一律视为被阻断（与「火灾阻断拓扑」区分在 reason 上）
  if (exit && !(exit.available && exit.status !== EXIT_STATUS.BLOCKED && exit.status !== EXIT_STATUS.CLOSED)) {
    return {
      exitId: exitNodeId,
      status: REACHABILITY.BLOCKED,
      distance: Infinity,
      path: [],
      reason: `出口不可用（available=${exit.available}, status=${exit.status}）`,
    }
  }

  const withBlocks = dijkstra(graph, startId, exitNodeId, blockedNodes || EMPTY_NODES, blockedEdges || EMPTY_EDGES)
  if (withBlocks) {
    return {
      exitId: exitNodeId,
      status: REACHABILITY.REACHABLE,
      distance: withBlocks.cost,
      path: withBlocks.path,
      reason: '',
    }
  }

  // 当前不通 —— 区分「被阻断」与「结构上就不通」
  const withoutBlocks = dijkstra(graph, startId, exitNodeId, EMPTY_NODES, EMPTY_EDGES)
  return withoutBlocks
    ? {
      exitId: exitNodeId,
      status: REACHABILITY.BLOCKED,
      distance: Infinity,
      path: [],
      reason: '存在通路但被火灾/阻断条件切断',
    }
    : {
      exitId: exitNodeId,
      status: REACHABILITY.UNREACHABLE,
      distance: Infinity,
      path: [],
      reason: '拓扑结构上不存在该起点到该出口的通路',
    }
}

/**
 * 区域 → 全部候选出口的可达性。
 * @param {object} opts
 * @param {object} opts.graph
 * @param {string} opts.floorId   起点楼层（如 '5F'）
 * @param {string} opts.zone      起点区域（如 'A区'）
 * @param {string} [opts.startId] 起点节点 id（默认按 ZONE_NODE_KEY 推导）
 * @param {string[]} [opts.exitIds] 候选出口节点 id（默认全部出口）
 * @param {Set<string>} [opts.blockedNodes]
 * @param {Set<string>} [opts.blockedEdges]
 * @param {Array} [opts.exits]
 * @returns {Array<{exitId,exitLabel,status,distance,path,reason}>}
 */
export function zoneExitReachability(opts = {}) {
  const {
    graph, floorId, zone, startId = null, exitIds = null,
    blockedNodes = null, blockedEdges = null, exits = EXIT_DEFS,
  } = opts
  if (!graph || !floorId || !zone) return []

  const from = startId || nodeId(floorId, ZONE_NODE_KEY[zone])
  if (!graph.nodes[from]) return []

  const goals = exitIds && exitIds.length
    ? exitIds
    : exits.map((e) => e.nodeId)

  return goals.map((exitNodeId) => {
    const r = exitReachability(graph, from, exitNodeId, blockedNodes, blockedEdges, exits)
    const exit = EXIT_BY_NODE_ID[exitNodeId]
    return { ...r, exitLabel: exit ? exit.label : exitNodeId }
  })
}

/** 可达（reachable）的出口节点 id 列表 */
export function reachableExitIds(opts = {}) {
  return zoneExitReachability(opts)
    .filter((r) => r.status === REACHABILITY.REACHABLE)
    .map((r) => r.exitId)
}

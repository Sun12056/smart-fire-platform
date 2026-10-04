/**
 * 路线合法性校验 —— 「绝不穿墙」的最后一道防线
 *
 * 任何路线在展示/下发前必须通过 validateRoute，任一检查失败即返回 valid=false：
 *   ① 节点合法：相邻节点必须是拓扑中的合法边，禁止 房间→房间 直连、禁止凭空跳跃；
 *   ② 线段合法：相邻两点之间的线段不得与任何墙体/房间实体相交；
 *   ③ 必须到达安全出口：终点节点类型必须是 exit；
 *   ④ 不得经过火灾区域：路线任一节点不得落在 blockedNodes 中。
 *
 * 调用方（routePlanner / Demo Engine / 前端 store）都必须丢弃校验失败的路线。
 */
import { NODE_TYPE } from './routeTypes.js'
import { edgeKey, WALLS } from './routeGraph.js'

/** 线段与矩形（墙）是否相交 */
export function segIntersectsRect(p1, p2, r) {
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

/**
 * @param {{nodes:string[], points:Array<{x:number,y:number}>, exitId?:string}} route 待校验路线
 * @param {object} opts
 * @param {object} opts.graph  拓扑图（提供 nodes/adj）
 * @param {Set<string>} [opts.blockedNodes] 火灾封锁节点
 * @param {Array} [opts.walls] 墙体（默认取拓扑自带 WALLS）
 * @param {boolean} [opts.requireExitNode] 是否要求终点为 exit 节点（单层路线可为 false）
 */
export function validateRoute(route, opts = {}) {
  const reasons = []
  const { graph, blockedNodes, walls = WALLS } = opts
  const nodes = route && route.nodes
  if (!nodes || nodes.length < 2) return { valid: false, reasons: ['路径为空或节点不足'] }

  const nodeOf = (id) => (graph && graph.nodes ? graph.nodes[id] : null)
  const first = nodeOf(nodes[0])
  const last = nodeOf(nodes[nodes.length - 1])

  // ① 节点合法性
  if (!first) reasons.push(`起点节点不存在: ${nodes[0]}`)
  if (!last) reasons.push(`终点节点不存在: ${nodes[nodes.length - 1]}`)
  if (first && first.type === NODE_TYPE.EXIT) reasons.push('起点不能是安全出口')
  if (first && ![NODE_TYPE.ROOM, NODE_TYPE.DOOR].includes(first.type)) reasons.push('起点必须是房间/门口')

  for (let i = 0; i < nodes.length - 1; i++) {
    const a = nodeOf(nodes[i])
    const b = nodeOf(nodes[i + 1])
    if (!a || !b) { reasons.push(`节点缺失: ${nodes[i]}→${nodes[i + 1]}`); continue }
    if (a.type === NODE_TYPE.ROOM && b.type === NODE_TYPE.ROOM) reasons.push(`房间直接连接房间（禁止穿房）: ${a.key}→${b.key}`)
    // 跨楼层只允许经楼梯
    if (a.floorId !== b.floorId && !(a.type === NODE_TYPE.STAIR && b.type === NODE_TYPE.STAIR)) {
      reasons.push(`非法跨层: ${a.key}→${b.key}`)
    }
    // 必须是图中合法边
    if (graph && graph.adj && graph.adj[a.id] && !graph.adj[a.id].some((e) => e.to === b.id)) {
      reasons.push(`非法节点跳跃（拓扑中无此连接）: ${a.key}→${b.key}`)
    }
  }

  // ② 线段不得穿墙（跨层楼梯段是垂直下降，不参与平面墙体校验）
  const pts = route.points && route.points.length === nodes.length ? route.points : null
  if (pts) {
    for (let i = 0; i < pts.length - 1; i++) {
      const a = nodeOf(nodes[i])
      const b = nodeOf(nodes[i + 1])
      if (a && b && a.floorId !== b.floorId) continue
      if (walls.some((r) => segIntersectsRect(pts[i], pts[i + 1], r))) {
        reasons.push(`路线穿墙/穿房间: ${nodes[i]}→${nodes[i + 1]}`)
      }
    }
  }

  // ③ 必须到达安全出口
  const exitId = route.exitId || (last && last.id)
  if (opts.requireExitNode !== false) {
    if (!last || last.type !== NODE_TYPE.EXIT) reasons.push('终点未到达安全出口')
  }
  if (route.exitId && last && last.id !== route.exitId) reasons.push('终点与声明的出口不一致')

  // ④ 不得经过火灾区域
  //    例外：火源区人员的第一步必然是「离开着火房间」，因此起点落在火源节点不算违规
  if (blockedNodes && blockedNodes.size) {
    nodes.forEach((id, i) => {
      if (i === 0 && opts.allowStartInFireZone !== false) return
      if (blockedNodes.has(id)) reasons.push(`路线经过火灾封锁节点: ${id}`)
    })
  }

  return { valid: reasons.length === 0, reasons, exitId }
}

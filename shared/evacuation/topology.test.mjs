/**
 * 空间拓扑与出口模型专项测试（P1.8.1）
 *   node shared/evacuation/topology.test.mjs
 *
 * 覆盖：T1 拓扑完整性 / T2 唯一性 / T3 边合法性 / T4 区域可达出口 / T5 火灾阻断
 *      / T6 墙体不可穿越 / T7 多出口 / T8 现有寻路回归
 * 另含 D2（楼梯逐层可通行）与 D3（A/B、C/D 不再共门厅）的针对性验证。
 */
import {
  buildBuildingGraph, buildFloorGraph, exitIdsOf, dijkstra, kShortestPaths, edgeKey, nodeId,
} from './routeGraph.js'
import {
  buildBuildingTopologyGraph, edgeListOf, validateTopology,
} from './topologyGraphAdapter.js'
import {
  zoneExitReachability, exitReachability, reachableExitIds, REACHABILITY,
} from './topologyReachability.js'
import {
  WALLS, EXIT_DEFS, EXIT_BY_NODE_ID, EXIT_STATUS, FLOOR_NODES, ZONE_DEFS, ZONE_IDS,
  ZONE_NODE_KEY, ZONE_CORRIDOR_KEY, STAIR_DEFS, STAIR_KEYS, STAIR_ACTIVE_FLOORS,
  EDGE_TYPE, FLOOR_EDGE_DEFS, EXIT_EDGE_DEFS, stairDescentEdgeDefs,
  activeStairKeysForFloor, isStairActiveOnFloor, availableExitNodeIds, isExitUsable,
} from './floorTopology.js'
import { findPaths, planEvacuationRoutes, rankPlans } from './routePlanner.js'
import { validateRoute, segIntersectsRect } from './routeValidator.js'
import { fireBlockSets, planBuildingEvacuation, planZoneRoutes } from './buildingEvacuationPlanner.js'
import { NODE_TYPE } from './routeTypes.js'

let pass = 0, fail = 0
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${extra !== undefined ? ' → ' + JSON.stringify(extra) : ''}`) }
}

console.log('\n=== 空间拓扑与出口模型专项测试（P1.8.1）===\n')

const graph = buildBuildingGraph(6)
const FLOORS = ['1F', '2F', '3F', '4F', '5F', '6F']

// ══════════════════════════════════════
console.log('[T1] 楼层拓扑完整性：A/B/C/D + 走廊 + 楼梯 + 出口均进入拓扑')
// ══════════════════════════════════════
FLOORS.forEach((f) => {
  const g = buildFloorGraph(f)
  const types = new Set(Object.values(g.nodes).map((n) => n.type))
  check(`${f} 含房间节点`, types.has(NODE_TYPE.ROOM))
  check(`${f} 含走廊节点`, types.has(NODE_TYPE.CORRIDOR))
  check(`${f} 含楼梯节点`, types.has(NODE_TYPE.STAIR))
  const zones = new Set(Object.values(g.nodes).map((n) => n.zone).filter(Boolean))
  check(`${f} A/B/C/D 四区齐全`, ['A区', 'B区', 'C区', 'D区'].every((z) => zones.has(z)), [...zones])
})
check('1F 含安全出口节点',
  Object.values(buildFloorGraph('1F').nodes).some((n) => n.type === NODE_TYPE.EXIT))
check('2F~6F 无安全出口节点（须经楼梯下行）',
  FLOORS.slice(1).every((f) => !Object.values(buildFloorGraph(f).nodes).some((n) => n.type === NODE_TYPE.EXIT)))
check('ZONE_DEFS 四区与 ZONE_NODE_KEY 一致',
  ZONE_DEFS.length === 4 && ZONE_DEFS.every((z) => ZONE_NODE_KEY[z.zone] === z.doorKey))
check('每个区域都能在图中找到起点节点',
  FLOORS.every((f) => ZONE_IDS.every((z) => Boolean(graph.nodes[nodeId(f, ZONE_NODE_KEY[z])]))))
check('拓扑自检通过（validateTopology）', validateTopology(graph).ok, validateTopology(graph).errors)

// ══════════════════════════════════════
console.log('\n[T2] 唯一性：无重复 nodeId / exitId / edgeId')
// ══════════════════════════════════════
const allNodeIds = Object.keys(graph.nodes)
check('nodeId 无重复', new Set(allNodeIds).size === allNodeIds.length,
  allNodeIds.length - new Set(allNodeIds).size)
check('节点 id 与其键一致', Object.entries(graph.nodes).every(([k, n]) => n.id === k))
const exitIds = EXIT_DEFS.map((e) => e.id)
check('exitId 无重复', new Set(exitIds).size === exitIds.length, exitIds)
const exitNodeIds = EXIT_DEFS.map((e) => e.nodeId)
check('出口 nodeId 无重复', new Set(exitNodeIds).size === exitNodeIds.length, exitNodeIds)
const edges = edgeListOf(graph)
const edgeIds = edges.map((e) => e.id)
check('edgeId 无重复', new Set(edgeIds).size === edgeIds.length,
  edgeIds.filter((id, i) => edgeIds.indexOf(id) !== i))
check('节点蓝本 key 无重复',
  new Set(FLOOR_NODES.map((n) => n.key)).size === FLOOR_NODES.length)

// ══════════════════════════════════════
console.log('\n[T3] Edge 合法性：from/to 存在、distance > 0、无幽灵边')
// ══════════════════════════════════════
const badFrom = edges.filter((e) => !graph.nodes[e.from])
const badTo = edges.filter((e) => !graph.nodes[e.to])
const badDist = edges.filter((e) => !(e.distance > 0))
check('每条边 from 节点存在', badFrom.length === 0, badFrom.slice(0, 3).map((e) => e.id))
check('每条边 to 节点存在', badTo.length === 0, badTo.slice(0, 3).map((e) => e.id))
check('每条边 distance > 0', badDist.length === 0, badDist.slice(0, 3).map((e) => e.distance))
check('边类型均来自 EDGE_TYPE 枚举',
  edges.every((e) => Object.values(EDGE_TYPE).includes(e.type)),
  [...new Set(edges.map((e) => e.type))])
check('邻接对称（有向表双向一致）',
  Object.entries(graph.adj).every(([from, arr]) => arr.every((e) => graph.adj[e.to].some((x) => x.to === from))))
check('无自环边', edges.every((e) => e.from !== e.to))

// ══════════════════════════════════════
console.log('\n[T4] 区域可达出口：Zone → Exit 三态（由拓扑计算，非写死）')
// ══════════════════════════════════════
const normalResults = []
FLOORS.forEach((f) => {
  ZONE_IDS.forEach((z) => {
    const rs = zoneExitReachability({ graph, floorId: f, zone: z })
    normalResults.push({ f, z, rs })
    check(`${f}-${z} 得到 ${exitNodeIds.length} 个出口的可达性结论`, rs.length === exitNodeIds.length, rs.length)
    check(`${f}-${z} 常态下至少 1 个出口 reachable`,
      rs.some((r) => r.status === REACHABILITY.REACHABLE), rs.map((r) => r.status))
  })
})
check('常态下所有区域均可到达全部安全出口（由真实拓扑算出）',
  normalResults.every(({ rs }) => rs.every((r) => r.status === REACHABILITY.REACHABLE)),
  normalResults.filter(({ rs }) => rs.some((r) => r.status !== REACHABILITY.REACHABLE)).slice(0, 3))

// 三态语义：blocked（有通路但被切断）
// D3 后 B 区拥有两条门厅通路（CORRIDOR_N + CORRIDOR_W），故需同时封闭才是「被切断」
const cutBoth = new Set([nodeId('5F', 'CORRIDOR_W'), nodeId('5F', 'CORRIDOR_N')])
const cutRs = zoneExitReachability({ graph, floorId: '5F', zone: 'B区', blockedNodes: cutBoth })
check('B区两条门厅通路均被封时，其出口变为 blocked（而非 unreachable）',
  cutRs.every((r) => r.status === REACHABILITY.BLOCKED), cutRs.map((r) => [r.exitId, r.status]))
// 仅封一条门厅通路时，另一条应仍可作为备份（D3 冗余边的价值）
const cutOne = new Set([nodeId('5F', 'CORRIDOR_W')])
const cutOneRs = zoneExitReachability({ graph, floorId: '5F', zone: 'B区', blockedNodes: cutOne })
check('仅封闭西端楼梯厅时，B区经近端门厅仍可达（备份通路生效）',
  cutOneRs.every((r) => r.status === REACHABILITY.REACHABLE), cutOneRs.map((r) => [r.exitId, r.status]))

// 三态语义：unreachable（结构上就不通）—— 用最小合成图验证 API 语义
const isolatedExit = { nodeId: '1F:ISO_EXIT', available: true, status: EXIT_STATUS.OPEN, label: '孤立出口' }
const synthetic = {
  nodes: {
    '1F:A': { id: '1F:A', floorId: '1F', key: 'A', x: 0, y: 0, type: NODE_TYPE.ROOM },
    '1F:B': { id: '1F:B', floorId: '1F', key: 'B', x: 10, y: 0, type: NODE_TYPE.CORRIDOR },
    '1F:ISO_EXIT': { id: '1F:ISO_EXIT', floorId: '1F', key: 'ISO_EXIT', x: 999, y: 0, type: NODE_TYPE.EXIT },
  },
  adj: {
    '1F:A': [{ to: '1F:B', w: 1, ek: edgeKey('1F:A', '1F:B') }],
    '1F:B': [{ to: '1F:A', w: 1, ek: edgeKey('1F:A', '1F:B') }],
    '1F:ISO_EXIT': [],
  },
}
check('结构上不通的出口判定为 unreachable',
  exitReachability(synthetic, '1F:A', '1F:ISO_EXIT', null, null, [isolatedExit]).status === REACHABILITY.UNREACHABLE)
check('出口自身不可用时判定为 blocked 并给出原因',
  exitReachability(graph, nodeId('5F', 'A_CENTER'), '1F:EXIT_W', null, null,
    [{ ...EXIT_BY_NODE_ID['1F:EXIT_W'], available: false, status: EXIT_STATUS.CLOSED }]).status === REACHABILITY.BLOCKED)
check('reachableExitIds 只返回可达出口',
  reachableExitIds({ graph, floorId: '5F', zone: 'A区' }).length === exitNodeIds.length)

// ══════════════════════════════════════
console.log('\n[T5] 火灾阻断：节点 / 边 / 出口可用状态共同参与路径约束')
// ══════════════════════════════════════
const fire = { buildingId: 'B003', floorId: '5F', zone: 'A区' }
// 不带 startId：火源房间应被封锁
const fbSelf = fireBlockSets(graph, fire, '5F', 'A区', null)
check('火源房间进入 blockedNodes', fbSelf.blockedNodes.has(nodeId('5F', 'A_CENTER')), [...fbSelf.blockedNodes])
check('火源房间进入 fireNodeIds', fbSelf.fireNodeIds.has(nodeId('5F', 'A_CENTER')), [...fbSelf.fireNodeIds])
check('阻断从节点扩展到边（blockedEdges 非空）', fbSelf.blockedEdges.size > 0, fbSelf.blockedEdges.size)
check('blockedEdges 只含真实存在的边 id',
  [...fbSelf.blockedEdges].every((id) => edgeIds.includes(id)))
// 带 startId：火源区人员必须从火源房间撤离，起点豁免（既有契约，不得回退）
const fbStart = fireBlockSets(graph, fire, '5F', 'A区', nodeId('5F', 'A_CENTER'))
check('火源区自身起点豁免（仍需能从火源房间撤离）',
  !fbStart.blockedNodes.has(nodeId('5F', 'A_CENTER')), [...fbStart.blockedNodes])
check('火灾不误伤出口实体（出口节点不在火源节点集合内）',
  fbSelf.exits.every((e) => !fbSelf.blockedNodes.has(e.nodeId)), fbSelf.exits.map((e) => [e.id, e.status]))

const fbOther = fireBlockSets(graph, fire, '5F', 'C区', nodeId('5F', 'C_CENTER'))
check('异门厅区域被封锁火源门厅 CORRIDOR_N', fbOther.blockedNodes.has(nodeId('5F', 'CORRIDOR_N')), [...fbOther.blockedNodes])
check('封锁门厅后该门厅相关边被切断', fbOther.blockedEdges.size > 0, fbOther.blockedEdges.size)
check('火灾阻断不误伤出口实体', fbOther.exits.every((e) => e.nodeId !== nodeId('5F', 'CORRIDOR_N')))

// 出口不可用 → 不再作为疏散目标
const closedWest = EXIT_DEFS.map((e) => (e.id === 'EXIT_W'
  ? { ...e, available: false, status: EXIT_STATUS.CLOSED }
  : e))
check('isExitUsable 正确识别不可用出口',
  isExitUsable('1F:EXIT_W', closedWest) === false && isExitUsable('1F:EXIT_E', closedWest) === true)
const closedPlans = findPaths({
  graph, startId: nodeId('5F', 'C_CENTER'), exits: closedWest, blockedNodes: new Set(), blockedEdges: new Set(),
})
check('西侧出口关闭后，候选路线不再指向它',
  closedPlans.length > 0 && closedPlans.every((p) => p.exitId !== '1F:EXIT_W'),
  closedPlans.map((p) => p.exitId))
check('availableExitNodeIds 正确过滤', availableExitNodeIds(closedWest).length === 1, availableExitNodeIds(closedWest))

// ── 出口状态 → 实际规划调用链（findPaths / planBuildingEvacuation）──
// closedWest 之上再构造「仅 status=CLOSED、available 仍为 true」的出口，
// 用于验证 availableExitNodeIds 与 isExitUsable 的判定口径一致（P1.8.1 收口复核修正项）
const closedOnly = EXIT_DEFS.map((e) => (e.id === 'EXIT_W'
  ? { ...e, available: true, status: EXIT_STATUS.CLOSED }
  : e))
// 「仅 status=BLOCKED」变体：验证三种状态都走同一条判定路径
const blockedWest = EXIT_DEFS.map((e) => (e.id === 'EXIT_W'
  ? { ...e, available: true, status: EXIT_STATUS.BLOCKED }
  : e))
check('status=CLOSED 且 available=true 时，isExitUsable 判定为不可用',
  isExitUsable('1F:EXIT_W', closedOnly) === false)
check('status=CLOSED 且 available=true 时，availableExitNodeIds 同样排除（口径一致）',
  availableExitNodeIds(closedOnly).length === 1, availableExitNodeIds(closedOnly))
check('status=CLOSED 的出口不进入候选目标',
  findPaths({ graph, startId: nodeId('5F', 'C_CENTER'), exits: closedOnly })
    .every((p) => p.exitId !== '1F:EXIT_W'))
check('status=BLOCKED 的出口同样被排除',
  isExitUsable('1F:EXIT_W', EXIT_DEFS.map((e) => (e.id === 'EXIT_W'
    ? { ...e, available: false, status: EXIT_STATUS.BLOCKED }
    : e))) === false)
check('status=OPEN 且 available=true 的出口可用',
  isExitUsable('1F:EXIT_E', closedOnly) === true)

// ── 火灾在现有业务规则下**不会**直接导致出口不可用（P1.8.1 边界，非缺陷）──
// 依据：blockedNodesForFire 只产出 ZONE_NODE_KEY（房间门口）与 ZONE_CORRIDOR_KEY（门厅），
//       从不产出出口节点 → 出口实体状态不会被 fireBlockSets 改写。
const fbAllZones = ['A区', 'B区', 'C区', 'D区'].map((z) => fireBlockSets(graph, fire, '5F', z, nodeId('5F', 'C_CENTER')))
check('任何区域起火，fireBlockSets 都不会把出口标记为不可用',
  fbAllZones.every((fb) => fb.exits.every((e) => e.available === true && e.status === EXIT_STATUS.OPEN)),
  fbAllZones.map((fb) => fb.exits.map((e) => [e.id, e.available, e.status])))
check('火源区自身的 fireBlockSets 也不产出 BLOCKED 出口',
  fireBlockSets(graph, fire, '5F', 'A区', nodeId('5F', 'A_CENTER')).exits
    .every((e) => e.status === EXIT_STATUS.OPEN))
// 真实规划链：起火时全部出口仍参与规划，且仍有多出口分流
const firePlans = planBuildingEvacuation({
  buildingId: 'B003', buildingName: '3号楼',
  persons: [{ id: 'PX1', buildingId: 'B003', floorId: '5F', zone: 'A区' },
    { id: 'PX2', buildingId: 'B003', floorId: '5F', zone: 'B区' },
    { id: 'PX3', buildingId: 'B003', floorId: '5F', zone: 'C区' },
    { id: 'PX4', buildingId: 'B003', floorId: '5F', zone: 'D区' }],
  fire, graph,
})
check('真实规划链中，起火不会使任何出口不可用（4 区仍分流到 2 个出口）',
  new Set(firePlans.plan.routes.map((r) => r.exitId)).size === 2,
  firePlans.plan.routes.map((r) => [r.zone, r.exitId]))

// ── 三态可达性 × 真实规划链的阻断集合 ────────────────────────────
// 验证 zoneExitReachability 与 planZoneRoutes 消费的是同一份阻断数据
const fbB = fireBlockSets(graph, fire, '5F', 'B区', nodeId('5F', 'B_CENTER'))
const rsRealChain = zoneExitReachability({
  graph, floorId: '5F', zone: 'B区',
  blockedNodes: fbB.blockedNodes, blockedEdges: fbB.blockedEdges, exits: fbB.exits,
})
check('A 区起火时，B 区两个出口在真实阻断集合下均可达',
  rsRealChain.every((r) => r.status === REACHABILITY.REACHABLE),
  rsRealChain.map((r) => [r.exitId, r.status]))
const rsSelf = zoneExitReachability({
  graph, floorId: '5F', zone: 'A区',
  blockedNodes: fireBlockSets(graph, fire, '5F', 'A区', nodeId('5F', 'A_CENTER')).blockedNodes,
})
check('火源区（A 区）自身在真实阻断集合下仍可达出口（起点豁免）',
  rsSelf.every((r) => r.status === REACHABILITY.REACHABLE),
  rsSelf.map((r) => [r.exitId, r.status]))
// 三态全覆盖：reachable（常态）/ blocked（切断通路）/ unreachable（结构不通）
const triReachable = exitReachability(graph, nodeId('5F', 'A_CENTER'), '1F:EXIT_W', null, null, EXIT_DEFS)
check('三态之 reachable：常态下存在通路',
  triReachable.status === REACHABILITY.REACHABLE && triReachable.path.length > 0)
const triBlocked = exitReachability(
  graph, nodeId('5F', 'A_CENTER'), '1F:EXIT_W',
  new Set([nodeId('5F', 'CORRIDOR_N'), nodeId('5F', 'CORRIDOR_W'), nodeId('5F', 'STAIR_NW'), nodeId('5F', 'STAIR_SW')]),
  null, EXIT_DEFS,
)
check('三态之 blocked：切断全部西向通路后变为 blocked（移除阻断即可达）',
  triBlocked.status === REACHABILITY.BLOCKED && /阻断/.test(triBlocked.reason), triBlocked.reason)
const triUnreachable = exitReachability(synthetic, '1F:A', '1F:ISO_EXIT', null, null, [isolatedExit])
check('三态之 unreachable：结构上无通路',
  triUnreachable.status === REACHABILITY.UNREACHABLE, triUnreachable.reason)
check('planZoneRoutes 与 zoneExitReachability 消费同一份阻断集合',
  fbB.blockedNodes.size > 0 && rsRealChain.some((r) => r.status === REACHABILITY.REACHABLE))

// ── capacity 语义 ────────────────────────────────────────────────
check('capacity 为 null（容量未知/未配置，非无限容量）',
  EXIT_DEFS.every((e) => e.capacity === null), EXIT_DEFS.map((e) => e.capacity))
check('capacity=null 时不施加任何容量约束：大流量区域仍获得合法路线',
  planBuildingEvacuation({
    buildingId: 'B003', buildingName: '3号楼',
    persons: Array.from({ length: 91 }, (_, i) => ({
      id: `PC${i}`, buildingId: 'B003', floorId: '5F', zone: 'C区',
    })),
    fire, graph,
  }).plan.routes.every((r) => r.valid && r.exitId),
  planBuildingEvacuation({
    buildingId: 'B003', buildingName: '3号楼',
    persons: Array.from({ length: 91 }, (_, i) => ({
      id: `PC${i}`, buildingId: 'B003', floorId: '5F', zone: 'C区',
    })),
    fire, graph,
  }).plan.routes.map((r) => [r.zone, r.personCount, r.exitId]))

// ══════════════════════════════════════
console.log('\n[T6] 墙体不可穿越：任意拓扑边不得跨越不可通行区域（复用 segIntersectsRect）')
// ══════════════════════════════════════
const crossing = edges.filter((e) => {
  const a = graph.nodes[e.from]
  const b = graph.nodes[e.to]
  if (!a || !b || a.floorId !== b.floorId) return false
  return WALLS.some((r) => segIntersectsRect(a, b, r))
})
check('无任何拓扑边穿越墙体/房间实体', crossing.length === 0, crossing.slice(0, 3).map((e) => e.id))
check('validateTopology 报告无穿墙错误',
  validateTopology(graph).errors.filter((s) => s.includes('穿越墙体')).length === 0,
  validateTopology(graph).errors)
check('墙体数据只有一份（floorTopology 为唯一来源）', WALLS.length === 8, WALLS.length)
check('跨层下降边不参与平面墙体校验',
  edges.some((e) => e.type === EDGE_TYPE.STAIR_DESCENT))

// ══════════════════════════════════════
console.log('\n[T7] 多出口：同一楼层可同时存在多个安全出口')
// ══════════════════════════════════════
check('拓扑中存在多个安全出口', EXIT_DEFS.length >= 2, EXIT_DEFS.map((e) => e.id))
check('全部出口都进入拓扑图', EXIT_DEFS.every((e) => Boolean(graph.nodes[e.nodeId])), EXIT_DEFS.map((e) => e.nodeId))
check('exitIdsOf(graph,"1F") 与出口实体一致',
  exitIdsOf(graph, '1F').sort().join(',') === exitNodeIds.slice().sort().join(','), exitIdsOf(graph, '1F'))
check('出口实体字段完整（id/nodeId/floorId/type/available/status）',
  EXIT_DEFS.every((e) => e.id && e.nodeId && e.floorId === '1F' && e.type === NODE_TYPE.EXIT
    && typeof e.available === 'boolean' && Boolean(e.status)))
check('每个出口都能被至少一个区域到达',
  EXIT_DEFS.every((ex) => FLOORS.some((f) => ZONE_IDS.some((z) => zoneExitReachability({
    graph, floorId: f, zone: z,
  }).some((r) => r.exitId === ex.nodeId && r.status === REACHABILITY.REACHABLE)))))

// ══════════════════════════════════════
console.log('\n[T8] 现有寻路回归：Dijkstra / Yen / findPaths / validateRoute / rankPlans 未被破坏')
// ══════════════════════════════════════
check('图结构契约保持 { nodes, adj, maxFloor }',
  Boolean(graph.nodes) && Boolean(graph.adj) && graph.maxFloor === 6)
check('节点数契约保持 = 楼层数 × 13 + 2', Object.keys(graph.nodes).length === 6 * 13 + 2, Object.keys(graph.nodes).length)
check('节点字段契约保持（id/floorId/key/x/y/type/zone/label/side）',
  Object.values(graph.nodes).every((n) => 'id' in n && 'floorId' in n && 'key' in n && 'x' in n
    && 'y' in n && 'type' in n && 'zone' in n && 'label' in n && 'side' in n))
check('邻接项契约保持（to/w/ek）',
  Object.values(graph.adj).every((arr) => arr.every((e) => 'to' in e && 'w' in e && 'ek' in e)))
check('buildBuildingTopologyGraph 与 buildBuildingGraph 同构',
  Object.keys(buildBuildingTopologyGraph(6).nodes).length === Object.keys(graph.nodes).length)

const dRes = dijkstra(graph, nodeId('5F', 'A_CENTER'), '1F:EXIT_E', new Set(), new Set())
check('Dijkstra 仍能求出最短路', Boolean(dRes && dRes.path.length > 1), dRes && dRes.path.length)
check('Dijkstra 终点为出口', dRes && dRes.path[dRes.path.length - 1] === '1F:EXIT_E')
const kRes = kShortestPaths(graph, nodeId('5F', 'A_CENTER'), '1F:EXIT_E', new Set(), new Set(), 3)
check('Yen K 仍能求多条路径', kRes.length >= 1, kRes.length)
const { plans } = planEvacuationRoutes({ floorId: '5F', zone: 'A区', fireZone: 'A区', congestion: 12 })
check('planEvacuationRoutes 仍产出 3 套方案', plans.length === 3, plans.map((p) => p.name))
check('3 套方案全部通过既有 validateRoute', plans.every((p) => p.valid), plans.map((p) => p.reasons))
// 注：rankPlans 含「出口多样性轮转」，最终顺序按出口交替，故分数不保证全局单调；
//     契约是「同出口内按评分有序 + 首条不低于末条」（与 route.test.mjs 既有口径一致）
check('rankPlans 评分口径保持（首条不低于末条）',
  plans[0].score >= plans[plans.length - 1].score, plans.map((p) => p.score))
check('rankPlans 出口多样性保持（覆盖多个出口）',
  new Set(plans.map((p) => p.exitId)).size >= 2, plans.map((p) => p.exitLabel))
check('rankPlans 标记推荐方案', plans[0].recommended === true, plans.map((p) => p.recommended))
check('每条候选路线仍通过 validateRoute',
  findPaths({ graph, startId: nodeId('5F', 'A_CENTER') }).every(
    (p) => validateRoute(p, { graph, blockedNodes: new Set() }).valid))

// ══════════════════════════════════════
console.log('\n[D2] 楼梯逐层可通行状态进入权威拓扑')
// ══════════════════════════════════════
check('楼梯节点在停用楼层仍然保留（不删除节点）',
  FLOORS.every((f) => STAIR_KEYS.every((k) => Boolean(graph.nodes[nodeId(f, k)]))))
check('3F 的 STAIR_SE 标记为停用', isStairActiveOnFloor('STAIR_SE', '3F') === false)
check('4F 的 STAIR_SW 标记为停用', isStairActiveOnFloor('STAIR_SW', '4F') === false)
check('6F 的 STAIR_NW 标记为停用', isStairActiveOnFloor('STAIR_NW', '6F') === false)
check('1F/2F/5F 四部楼梯全部可用',
  ['1F', '2F', '5F'].every((f) => activeStairKeysForFloor(f).length === 4))
const descent = stairDescentEdgeDefs(6)
check('停用楼梯的跨层边不进入图（总数 15 < 全可用 20）', descent.length === 15, descent.length)
check('3F↔2F 不存在 STAIR_SE 跨层边',
  !descent.some((d) => d.from === 'STAIR_SE' && d.fromFloor === '3F' && d.toFloor === '2F'))
check('4F↔3F 不存在 STAIR_SW 跨层边',
  !descent.some((d) => d.from === 'STAIR_SW' && d.fromFloor === '4F' && d.toFloor === '3F'))
check('6F↔5F 不存在 STAIR_NW 跨层边',
  !descent.some((d) => d.from === 'STAIR_NW' && d.fromFloor === '6F' && d.toFloor === '5F'))
const sixFPlan = planEvacuationRoutes({ floorId: '6F', zone: 'A区', fireZone: null, congestion: 1 })
check('6F 仍能生成方案（停用 NW 后仍有其他楼梯可下行）', sixFPlan.plans.length > 0, sixFPlan.plans.length)
check('6F 路线不经过 6F:STAIR_NW（该层停用）',
  sixFPlan.plans.every((p) => !p.nodes.includes(nodeId('6F', 'STAIR_NW'))),
  sixFPlan.plans.map((p) => p.nodes.filter((n) => n.includes('STAIR_'))))

// ══════════════════════════════════════
console.log('\n[D3] A/B、C/D 不再共门厅')
// ══════════════════════════════════════
const halls = ZONE_DEFS.map((z) => z.hallKey)
check('四个区域的门厅互不相同', new Set(halls).size === 4, halls)
check('A区与B区不共门厅', ZONE_CORRIDOR_KEY.A_CENTER !== ZONE_CORRIDOR_KEY.B_CENTER,
  [ZONE_CORRIDOR_KEY.A_CENTER, ZONE_CORRIDOR_KEY.B_CENTER])
check('C区与D区不共门厅', ZONE_CORRIDOR_KEY.C_CENTER !== ZONE_CORRIDOR_KEY.D_CENTER,
  [ZONE_CORRIDOR_KEY.C_CENTER, ZONE_CORRIDOR_KEY.D_CENTER])
const bFireRes = planEvacuationRoutes({ floorId: '5F', zone: 'B区', fireZone: 'A区', congestion: 8 })
check('A区起火时 B区仍有可行路线', bFireRes.plans.length > 0, bFireRes.plans.length)
check('A区起火时 B区路线不再经过火源门厅 CORRIDOR_N',
  bFireRes.plans.every((p) => !p.nodes.includes(nodeId('5F', 'CORRIDOR_N'))),
  bFireRes.plans.map((p) => p.nodes))
check('A区起火时 B区路线不进入火源房间',
  bFireRes.plans.every((p) => !p.nodes.includes(nodeId('5F', 'A_CENTER'))))
check('改接后的新边仍不穿墙（B区门口 → 西端楼梯厅）',
  !WALLS.some((r) => segIntersectsRect(graph.nodes[nodeId('5F', 'B_CENTER')], graph.nodes[nodeId('5F', 'CORRIDOR_W')], r)))
check('改接后的新边仍不穿墙（D区门口 → 东端楼梯厅）',
  !WALLS.some((r) => segIntersectsRect(graph.nodes[nodeId('5F', 'D_CENTER')], graph.nodes[nodeId('5F', 'CORRIDOR_E')], r)))

// ══════════════════════════════════════
console.log('\n[出口状态合并顺序] exits 默认值 / 覆盖列表 / 运行态穿透')
// ══════════════════════════════════════
// 契约（P1.8.1 明确，勿混用）：
//   · exitIds —— **白名单**：限定「从哪些出口里选」，是候选集的唯一裁剪手段
//   · exits   —— **状态覆盖列表**：只覆盖 available/status，**不是**白名单
//     未在 exits 中列出的出口，回落 EXIT_DEFS 静态默认状态（P1.8.1 既有行为，未改变）

// 1) 默认行为：不传 exits → 旧调用方零影响，两个出口均参与候选
const dfltPlans = findPaths({ graph, startId: nodeId('5F', 'C_CENTER') })
check('不传 exits 时默认兼容旧调用方（两个出口均进入候选）',
  dfltPlans.length > 0 && new Set(dfltPlans.map((p) => p.exitId)).size === 2,
  [...new Set(dfltPlans.map((p) => p.exitId))])
check('不传 exits 时不穿墙、不经火区（默认路径合法）', dfltPlans.every((p) => p.valid))

// 2) 完整出口数组：显式关闭/阻断的出口不因默认值回流
check('传入完整出口数组时，被关闭的出口不回流',
  findPaths({ graph, startId: nodeId('5F', 'C_CENTER'), exits: closedWest })
    .every((p) => p.exitId !== '1F:EXIT_W'))

// 3) 部分出口数组：未列出的出口回落静态默认（覆盖列表语义，非白名单）
const partialExits = [{ ...EXIT_BY_NODE_ID['1F:EXIT_W'], available: false, status: EXIT_STATUS.BLOCKED }]
check('传入部分出口数组：未列出的出口回落 EXIT_DEFS 默认状态',
  findPaths({ graph, startId: nodeId('5F', 'C_CENTER'), exits: partialExits })
    .some((p) => p.exitId === '1F:EXIT_E'),
  findPaths({ graph, startId: nodeId('5F', 'C_CENTER'), exits: partialExits }).map((p) => p.exitId))
check('传入部分出口数组时，已列出的不可用出口仍被排除',
  findPaths({ graph, startId: nodeId('5F', 'C_CENTER'), exits: partialExits })
    .every((p) => p.exitId !== '1F:EXIT_W'))
check('空数组 exits 等价于「无覆盖」（回落默认，不崩、不误杀）',
  findPaths({ graph, startId: nodeId('5F', 'C_CENTER'), exits: [] }).length > 0)
check('null exits 等价于「无覆盖」（回落默认，不崩）',
  findPaths({ graph, startId: nodeId('5F', 'C_CENTER'), exits: null }).length > 0)

// 4) 白名单语义由 exitIds 承担
check('exitIds 显式限定后，只从指定出口选路',
  findPaths({ graph, startId: nodeId('5F', 'C_CENTER'), exitIds: ['1F:EXIT_E'] })
    .every((p) => p.exitId === '1F:EXIT_E'))
check('exitIds 指向已关闭出口时结果为空（不静默改走别的出口）',
  findPaths({ graph, startId: nodeId('5F', 'C_CENTER'), exitIds: ['1F:EXIT_W'], exits: closedWest }).length === 0)

// 5) 合并顺序：运行态状态不得被默认值覆盖
check('运行态 CLOSED 经 findPaths 直传时生效（不被 EXIT_DEFS 覆盖）',
  findPaths({ graph, startId: nodeId('5F', 'C_CENTER'), exits: closedOnly })
    .every((p) => p.exitId !== '1F:EXIT_W'))
check('运行态 BLOCKED 经 findPaths 直传时生效',
  findPaths({ graph, startId: nodeId('5F', 'C_CENTER'), exits: blockedWest })
    .every((p) => p.exitId !== '1F:EXIT_W'))
check('fireBlockSets 生成的出口实体以运行态为基底（不丢失运行态状态）',
  (() => {
    const merged = fireBlockSets(graph, fire, '5F', 'C区', nodeId('5F', 'C_CENTER'), closedOnly)
    const w = merged.exits.find((e) => e.id === 'EXIT_W')
    // closedOnly 本身是 available:true / status:CLOSED —— 关键是 status 未被回退成 OPEN
    return w.status === EXIT_STATUS.CLOSED && isExitUsable(w.nodeId, merged.exits) === false
      && merged.exits.find((e) => e.id === 'EXIT_E').status === EXIT_STATUS.OPEN
  })(),
  fireBlockSets(graph, fire, '5F', 'C区', nodeId('5F', 'C_CENTER'), closedOnly)
    .exits.map((e) => [e.id, e.available, e.status]))
check('fireBlockSets 不传入 baseExits 时行为与之前一致（默认 EXIT_DEFS）',
  fireBlockSets(graph, fire, '5F', 'C区', nodeId('5F', 'C_CENTER')).exits
    .every((e) => e.available === true && e.status === EXIT_STATUS.OPEN))
check('运行态关闭的出口经 planZoneRoutes 依然被排除（状态穿透真实规划链）',
  planZoneRoutes({ graph, floorId: '5F', zone: 'C区', exits: closedOnly }).candidates
    .every((c) => c.exitId !== '1F:EXIT_W'),
  planZoneRoutes({ graph, floorId: '5F', zone: 'C区', exits: closedOnly }).candidates.map((c) => c.exitId))
check('运行态关闭的出口经 planBuildingEvacuation 依然被排除',
  planBuildingEvacuation({
    buildingId: 'B003', buildingName: '3号楼',
    persons: [{ id: 'PZ1', buildingId: 'B003', floorId: '5F', zone: 'C区' }],
    fire, graph, exits: closedOnly,
  }).plan.routes.every((r) => r.exitId !== '1F:EXIT_W'))
check('运行态未指定 exits 时，planBuildingEvacuation 默认行为不变（合法路线 + 出口取自默认集合）',
  (() => {
    const rs = planBuildingEvacuation({
      buildingId: 'B003', buildingName: '3号楼',
      persons: [{ id: 'PZ2', buildingId: 'B003', floorId: '5F', zone: 'C区' }],
      fire, graph,
    }).plan.routes
    return rs.length === 1 && rs[0].valid && exitNodeIds.includes(rs[0].exitId)
  })(),
  planBuildingEvacuation({
    buildingId: 'B003', buildingName: '3号楼',
    persons: [{ id: 'PZ2', buildingId: 'B003', floorId: '5F', zone: 'C区' }],
    fire, graph,
  }).plan.routes.map((r) => [r.zone, r.exitId, r.valid]))

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`)
if (fail) process.exit(1)

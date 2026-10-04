/**
 * 疏散路线算法单测（node shared/evacuation/route.test.mjs）
 * 校验：拓扑寻路 / A/B/C 三方案 / 不穿墙 / 不经火区 / 必达出口 / 指标完整
 */
import { planEvacuationRoutes } from './routePlanner.js'
import { buildBuildingGraph, nodeId } from './routeGraph.js'
import { validateRoute } from './routeValidator.js'
import { NODE_TYPE } from './routeTypes.js'

let pass = 0, fail = 0
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${extra !== undefined ? ' → ' + JSON.stringify(extra) : ''}`) }
}

console.log('\n=== 疏散路线算法单测 ===\n')

const FLOOR = '5F'
const FIRE_ZONE = 'A区'
const graph = buildBuildingGraph(6)

console.log('[1] 拓扑')
check('节点数 = 楼层数 × 13 + 2 个出口', Object.keys(graph.nodes).length === 6 * 13 + 2, Object.keys(graph.nodes).length)
check('房间节点为叶子（只接门厅）', graph.adj[nodeId(FLOOR, 'A_CENTER')].length === 1, graph.adj[nodeId(FLOOR, 'A_CENTER')])
check('出口仅存在于 1F', Object.values(graph.nodes).filter((n) => n.type === NODE_TYPE.EXIT).every((n) => n.floorId === '1F'))

console.log('\n[2] 火源区（A区）路线规划')
const { plans, blockedNodes, fireNodeIds } = planEvacuationRoutes({ floorId: FLOOR, zone: FIRE_ZONE, fireZone: FIRE_ZONE, congestion: 12 })
check('生成 3 套候选方案 A/B/C', plans.length === 3, plans.map((p) => p.name))
check('命名为 方案A/方案B/方案C', plans.map((p) => p.name).join(',') === '方案A,方案B,方案C', plans.map((p) => p.name))
check('火源房间被标记为封锁', fireNodeIds.includes(nodeId(FLOOR, 'A_CENTER')), fireNodeIds)
console.log('    方案对比：')
plans.forEach((p) => console.log(`      ${p.name} · ${p.distance}m · ${p.estimatedTime}s · 风险${p.riskLevel} · 距火${p.fireDistance}m · 脱离${p.escapeDistance}m · 出口 ${p.exitLabel} · 评分 ${p.score}`))

plans.forEach((p, i) => {
  check(`方案${p.name} 通过合法性校验`, p.valid, p.reasons)
  check(`方案${p.name} 终点为安全出口`, graph.nodes[p.exitId]?.type === NODE_TYPE.EXIT, p.exitId)
  check(`方案${p.name} 有距离`, p.distance > 0, p.distance)
  check(`方案${p.name} 有预计时间`, p.estimatedTime > 0, p.estimatedTime)
  check(`方案${p.name} 有风险等级`, ['LOW', 'MEDIUM', 'HIGH'].includes(p.riskLevel), p.riskLevel)
  check(`方案${p.name} 有距火距离`, isFinite(p.fireDistance), p.fireDistance)
  check(`方案${p.name} 有到出口距离`, p.exitDistance > 0, p.exitDistance)
  check(`方案${p.name} nodes/points 数量一致`, p.nodes.length === p.points.length, [p.nodes.length, p.points.length])
  check(`方案${p.name} 跨层下降到 1F`, p.floorsPassed[p.floorsPassed.length - 1] === '1F', p.floorsPassed)
  check(`方案${p.name} 起点为火源区域`, p.startZones.includes(FIRE_ZONE), p.startZones)
})

check('三条路线互不相同', new Set(plans.map((p) => p.nodes.join('>'))).size === 3)
check('推荐方案为 A', plans[0].recommended === true && plans[0].name === '方案A')
check('A/B/C 覆盖多个安全出口（保证真正可选）', new Set(plans.map((p) => p.exitId)).size >= 2, plans.map((p) => p.exitLabel))
check('同出口内评分有序', plans[0].score >= plans[2].score, plans.map((p) => p.score))
check('推荐方案为最高分', plans[0].score === Math.max(...plans.map((p) => p.score)), plans.map((p) => p.score))

console.log('\n[3] 绝不穿墙 / 不经过火区')
plans.forEach((p) => {
  const v = validateRoute(p, { graph, blockedNodes: new Set(blockedNodes) })
  check(`方案${p.name} validateRoute 通过`, v.valid, v.reasons)
  check(`方案${p.name} 未经过封锁节点`, !p.nodes.some((n) => blockedNodes.includes(n)), p.nodes.filter((n) => blockedNodes.includes(n)))
})

console.log('\n[4] 非火源区路线避开火源门厅')
const cRes = planEvacuationRoutes({ floorId: FLOOR, zone: 'C区', fireZone: FIRE_ZONE, congestion: 8 })
check('C区生成候选方案', cRes.plans.length > 0, cRes.plans.length)
check('C区路线不经过火源门厅 CORRIDOR_N', cRes.plans.every((p) => !p.nodes.includes(nodeId(FLOOR, 'CORRIDOR_N'))), cRes.plans.map((p) => p.nodes))
check('C区路线不经过火源房间', cRes.plans.every((p) => !p.nodes.includes(nodeId(FLOOR, 'A_CENTER'))))
cRes.plans.forEach((p) => check(`C区${p.name} 校验通过`, p.valid, p.reasons))
// 与火源共用同一门厅的区域不能被封死（A区/B区 同一门厅）
const bRes = planEvacuationRoutes({ floorId: FLOOR, zone: 'B区', fireZone: FIRE_ZONE, congestion: 8 })
check('B区（与火源同门厅）仍有可行路线', bRes.plans.length > 0, bRes.plans.length)
check('B区路线不进入火源房间', bRes.plans.every((p) => !p.nodes.includes(nodeId(FLOOR, 'A_CENTER'))))

console.log('\n[5] 无火情时也能规划')
const noFire = planEvacuationRoutes({ floorId: FLOOR, zone: 'C区', fireZone: null, congestion: 5 })
check('无火情生成 3 套方案', noFire.plans.length === 3, noFire.plans.length)
check('无火情全部合法', noFire.plans.every((p) => p.valid))

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`)
if (fail) process.exit(1)

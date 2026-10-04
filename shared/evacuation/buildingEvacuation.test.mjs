/**
 * 整栋楼疏散方案单测（node shared/evacuation/buildingEvacuation.test.mjs）
 *
 * 校验：
 *   · 火灾位置与疏散范围分离（fire 只描述位置，scope = BUILDING）
 *   · 整栋楼人员全部进入疏散任务（每个有人的 floorId+zone 都有路线）
 *   · PLAN-A/B/C 都是整栋楼方案（三种策略）
 *   · 所有路线到 1F 安全出口、不穿墙、不经火区、跨层必经楼梯
 *   · routeId 与 routeOfPerson 一致（后端下发与前端/3D 消费同源）
 */
import {
  planBuildingStrategies, planBuildingEvacuation, groupPersonsByZone, routeOfPerson,
  validateBuildingEvacuationPlan, fireBlockSets,
} from './buildingEvacuationPlanner.js'
import { EVACUATION_SCOPE, STRATEGY, RISK_RANK, zoneKeyOf } from './buildingEvacuationTypes.js'
import { buildBuildingGraph } from './routeGraph.js'
import { validateRoute } from './routeValidator.js'
import { NODE_TYPE } from './routeTypes.js'

let pass = 0, fail = 0
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${extra !== undefined ? ' → ' + JSON.stringify(extra) : ''}`) }
}

console.log('\n=== 整栋楼疏散方案单测 ===\n')

const BUILDING_ID = 'B003'
const graph = buildBuildingGraph(6)

// ── 构造整栋楼人员（跨 6F/5F/4F/3F，只覆盖有人的区域） ──
const person = (id, floorId, zone) => ({ id, buildingId: BUILDING_ID, floorId, zone, status: 'normal' })
const persons = [
  ...['T501', 'T502', 'T503'].map((id) => person(id, '5F', 'A区')),   // 火源区
  ...['T511', 'T512'].map((id) => person(id, '5F', 'B区')),
  ...['T521', 'T522'].map((id) => person(id, '5F', 'C区')),
  person('T531', '5F', 'D区'),
  ...['T401', 'T402', 'T403', 'T404'].map((id) => person(id, '4F', 'A区')),
  ...['T311', 'T312'].map((id) => person(id, '3F', 'C区')),
  person('T601', '6F', 'B区'),
  person('T101', '1F', 'A区'),
]
const fire = { buildingId: BUILDING_ID, floorId: '5F', zone: 'A区' }

console.log('[1] 人员分组（整栋楼）')
const groups = groupPersonsByZone(persons, { buildingId: BUILDING_ID })
check('按 floorId+zone 分组', groups.length === 8, groups.map((g) => g.zoneKey))
check('同区域多人合并计数', groups.find((g) => g.zoneKey === '5F:A区')?.personCount === 3)
check('覆盖多个楼层', new Set(groups.map((g) => g.floorId)).size === 5, [...new Set(groups.map((g) => g.floorId))])
check('zoneKey 格式 = floorId:zone', groups.every((g) => g.zoneKey === zoneKeyOf(g.floorId, g.zone)))

console.log('\n[2] PLAN-A/B/C 三套整栋楼方案')
const { plans } = planBuildingStrategies({
  buildingId: BUILDING_ID, buildingName: '3号楼', persons, fire, maxFloor: 6, graph,
})
check('生成 3 套方案', plans.length === 3, plans.map((p) => p.id))
check('策略依次为 均衡/快速/安全',
  plans.map((p) => p.strategy).join(',') === 'BALANCED,FASTEST,SAFEST', plans.map((p) => p.strategy))
check('命名 PLAN-A / PLAN-B / PLAN-C', plans.map((p) => p.id).join(',') === 'PLAN-A,PLAN-B,PLAN-C', plans.map((p) => p.id))
check('PLAN-A 为推荐方案', plans[0].recommended === true)
plans.forEach((p) => {
  check(`${p.id} scope = BUILDING`, p.scope === EVACUATION_SCOPE.BUILDING, p.scope)
  check(`${p.id} 是整栋楼方案（覆盖全部 ${groups.length} 个有人区域）`, p.routes.length === groups.length, p.routes.length)
  check(`${p.id} 通过整栋楼校验`, p.valid, p.reasons)
  check(`${p.id} 每个有人区域都有路线`,
    groups.every((g) => Boolean(p.routesByZone[g.zoneKey])),
    groups.filter((g) => !p.routesByZone[g.zoneKey]).map((g) => g.zoneKey))
  check(`${p.id} 纳入全部 ${persons.length} 人`, p.summary.personCount === persons.length, p.summary.personCount)
})

console.log('\n[3] 火灾位置与疏散范围分离')
const planA = plans[0]
check('fire 只描述火灾位置（楼/层/区）',
  planA.fire && planA.fire.buildingId === BUILDING_ID && planA.fire.floorId === '5F' && planA.fire.zone === 'A区', planA.fire)
check('疏散范围不因火灾退化为单楼层',
  new Set(planA.routes.map((r) => r.floorId)).size > 1, [...new Set(planA.routes.map((r) => r.floorId))])
check('非火源楼层（6F/4F/3F）也有路线',
  ['6F', '4F', '3F'].every((f) => planA.routes.some((r) => r.floorId === f)), planA.routes.map((r) => r.floorId))
const noFirePlan = planBuildingEvacuation({
  buildingId: BUILDING_ID, persons, fire: null, strategy: STRATEGY.BALANCED, graph,
}).plan
check('无火情时疏散范围同样是整栋楼', noFirePlan.routes.length === groups.length && noFirePlan.scope === EVACUATION_SCOPE.BUILDING)

console.log('\n[4] 每条路线合法性（不穿墙 / 不经火区 / 到 1F 出口 / 跨层必经楼梯）')
const exitIds = Object.values(graph.nodes).filter((n) => n.type === NODE_TYPE.EXIT).map((n) => n.id)
const fireNodes = ['5F:A_CENTER']
plans.forEach((p) => {
  p.routes.forEach((r) => {
    const v = validateRoute(r, {
      graph,
      blockedNodes: new Set(fireNodes.concat(r.floorId === '5F' && r.zone !== 'A区' && r.zone !== 'B区' ? ['5F:CORRIDOR_N'] : [])),
    })
    check(`${p.id} ${r.floorId}-${r.zone} validateRoute 通过`, v.valid, v.reasons)
    const last = graph.nodes[r.nodes[r.nodes.length - 1]]
    check(`${p.id} ${r.floorId}-${r.zone} 终点是 1F 安全出口`,
      last && last.type === NODE_TYPE.EXIT && last.floorId === '1F', last && last.id)
    check(`${p.id} ${r.floorId}-${r.zone} exitId 合法`, exitIds.includes(r.exitId), r.exitId)
    if (r.floorId !== '1F') {
      check(`${p.id} ${r.floorId}-${r.zone} 跨层下降经过楼梯`,
        r.nodes.some((id) => graph.nodes[id] && graph.nodes[id].type === NODE_TYPE.STAIR), r.nodes)
      check(`${p.id} ${r.floorId}-${r.zone} 途经 1F`, r.floorsPassed.includes('1F'), r.floorsPassed)
    }
    check(`${p.id} ${r.floorId}-${r.zone} nodes/points 数量一致`, r.nodes.length === r.points.length, [r.nodes.length, r.points.length])
    check(`${p.id} ${r.floorId}-${r.zone} 指标完整`,
      r.distance > 0 && r.estimatedTime > 0 && ['LOW', 'MEDIUM', 'HIGH'].includes(r.riskLevel), r)
  })
})

console.log('\n[5] 策略语义：A 均衡 / B 最快 / C 最安全')
const [A, B, C] = plans
groups.forEach((g) => {
  const ra = A.routesByZone[g.zoneKey], rb = B.routesByZone[g.zoneKey], rc = C.routesByZone[g.zoneKey]
  check(`${g.zoneKey} B(快速) 耗时 ≤ A(均衡)`, rb.estimatedTime <= ra.estimatedTime, [rb.estimatedTime, ra.estimatedTime])
  check(`${g.zoneKey} C(安全) 风险 ≤ A(均衡)`,
    (RISK_RANK[rc.riskLevel] ?? 9) <= (RISK_RANK[ra.riskLevel] ?? 9), [rc.riskLevel, ra.riskLevel])
})
const bTotalTime = B.summary.maxEstimatedTime
check('B 方案全楼最慢区域耗时 ≤ A 方案', bTotalTime <= A.summary.maxEstimatedTime, [bTotalTime, A.summary.maxEstimatedTime])
check('A/B/C 三套方案路线数一致（都是整栋楼）', A.routes.length === B.routes.length && B.routes.length === C.routes.length)
check('不同策略确实选出不同路线（非同一套结果）',
  new Set(plans.map((p) => p.routes.map((r) => r.nodes.join('>')).join('|'))).size > 1)
check('A 均衡：人流分摊到多个安全出口', Object.keys(A.summary.exits).length >= 2, A.summary.exits)

console.log('\n[6] routeId 一致性（后端下发与前端/3D 消费同源）')
const sample = persons[0]
const routeOfSample = routeOfPerson(A, sample)
check('按 buildingId/floorId/zone 取到路线', Boolean(routeOfSample), routeOfSample && routeOfSample.routeId)
check('routeId = planId:floorId:zone',
  routeOfSample.routeId === `${A.id}:${sample.floorId}:${sample.zone}`, routeOfSample.routeId)
check('routesByZone 键与 routeId 指向同一条路线',
  A.routesByZone[zoneKeyOf(sample.floorId, sample.zone)] === routeOfSample)

console.log('\n[7] 汇总指标（UI 展示）')
plans.forEach((p) => {
  const s = p.summary
  check(`${p.id} summary 字段完整`,
    s.zoneCount === groups.length && s.routeCount === groups.length && s.validRouteCount === groups.length
    && s.personCount === persons.length && s.maxEstimatedTime > 0 && s.totalDistance > 0, s)
  check(`${p.id} 涉及多个楼层`, s.floors.length > 1, s.floors)
  console.log(`      ${p.name} · ${s.zoneCount}区/${s.personCount}人 · 最慢 ${s.maxEstimatedTime}s · 总距离 ${s.totalDistance}m · 风险 ${s.riskLevel} · 出口 ${s.exitLabels.join('、')}`)
})

console.log('\n[8] 每条路线都通过既有 routeValidator（P1.5.5 回归）')
plans.forEach((p) => {
  const bad = p.routes.filter((r) => r.valid !== true || (r.reasons || []).length > 0)
  check(`${p.id} 所有路由 valid 且无 reasons`, bad.length === 0, bad.slice(0, 2).map((r) => [r.routeId, r.reasons]))
  const notExit = p.routes.filter((r) => !/^1F:EXIT_/.test(r.exitId) || r.nodes[r.nodes.length - 1] !== r.exitId)
  check(`${p.id} 所有路线终点都是 1F 安全出口`, notExit.length === 0, notExit.slice(0, 2).map((r) => [r.routeId, r.exitId]))
  const noStair = p.routes.filter((r) => r.floorId !== '1F' && !r.nodes.some((n) => /STAIR_/.test(n)))
  check(`${p.id} 非 1F 路线跨层必经楼梯`, noStair.length === 0, noStair.map((r) => r.routeId))
  const throughFire = p.routes.filter((r) => r.nodes.slice(1).includes('5F:A_CENTER'))
  check(`${p.id} 路线不经过火源房间（起点除外）`, throughFire.length === 0, throughFire.map((r) => r.routeId))
  // 逐条用既有 routeValidator 复核（不依赖规划器自证；火灾障碍按该区域推导）
  const revalidated = p.routes.filter((r) => {
    // 与规划器同口径：火源障碍按该路线所属区域推导（fireBlockSets）
    const blocked = fireBlockSets(graph, fire, r.floorId, r.zone, r.startNode).blockedNodes
    return !validateRoute(r, { graph, blockedNodes: blocked }).valid
  })
  check(`${p.id} 逐条 routeValidator 复核通过`, revalidated.length === 0, revalidated.slice(0, 2).map((r) => r.routeId))
})
check('1F~6F 每个有人区域都拿到路线',
  plans.every((p) => groups.every((g) => Boolean(p.routesByZone[zoneKeyOf(g.floorId, g.zone)]))),
  groups.map((g) => g.zoneKey))

console.log('\n[9] 边界')
const emptyRes = planBuildingEvacuation({ buildingId: BUILDING_ID, persons: [], fire, strategy: STRATEGY.BALANCED, graph })
check('无人员时不抛错（routes 为空且校验不通过）', emptyRes.plan.routes.length === 0 && emptyRes.plan.valid === false)
const partial = planBuildingEvacuation({
  buildingId: BUILDING_ID, persons: [person('X1', '5F', 'A区')], fire, strategy: STRATEGY.FASTEST, graph,
})
check('单区域人员也能生成整栋楼方案（1 条路线）', partial.plan.routes.length === 1 && partial.plan.valid, partial.plan.reasons)
const tampered = { ...A, routes: A.routes.map((r, i) => (i === 0 ? { ...r, exitId: '1F:A_CENTER', nodes: [...r.nodes.slice(0, -1), '1F:A_CENTER'] } : r)) }
tampered.routesByZone = Object.fromEntries(tampered.routes.map((r) => [zoneKeyOf(r.floorId, r.zone), r]))
const tv = validateBuildingEvacuationPlan(tampered, { graph, groups, fire })
check('篡改终点出口会被整栋楼校验拦截', tv.valid === false, tv.reasons.slice(0, 2))

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`)
if (fail) process.exit(1)

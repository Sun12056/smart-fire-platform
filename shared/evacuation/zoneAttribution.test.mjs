/**
 * RG-01 测试契约：Zone 归属数据一致性（node shared/evacuation/zoneAttribution.test.mjs）
 *
 * 缺陷背景（修复前实测）：
 *   resolvePlanningZone 把走廊人员归到房间区域，但 groupPersonsByZone 仍把原始 p.zone
 *   写进分组对象 ⇒ zoneKey 用归属后区域、zone 仍是「走廊」：
 *     · 该组走 planZoneRoutes 取不到起点节点 → 进 missingZones，人既无路线也不计入统计；
 *     · 若走廊人员先入组，同组的房间人员会一起失效（结果依赖人员数组顺序）。
 *
 * 本文件锁定的语义（三者必须同源）：
 *   · group.zone    = 归一化后的规划区域
 *   · group.zoneKey = `${floorId}:${group.zone}`
 *   · group.sourceZones 保留原始区域（如 ['A区','走廊']）
 *   · 坐标无效（NULL / NaN / Infinity / 非数字）不得参与「最近区域」判定，且必须明确失败
 *   · Worker 校验规则 auditZoneGroups 必须拒绝 zone / zoneKey 不一致的数据
 *
 * 边界声明：
 *   · 只新增测试，不改任何寻路算法 / 评分 / 出口分配策略 / 既有测试文件。
 *   · 必须覆盖「人员分组 → 路线生成」完整链路，不能只断言 resolvePlanningZone 的返回值。
 */
import {
  planBuildingStrategies, planBuildingEvacuation, groupPersonsByZone,
  resolvePlanningZone, auditZoneGroups, isValidCoordinate,
} from './buildingEvacuationPlanner.js'
import { STRATEGY, RISK_RANK, zoneKeyOf } from './buildingEvacuationTypes.js'
import { buildBuildingGraph } from './routeGraph.js'

let pass = 0, fail = 0
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${extra !== undefined ? ' → ' + JSON.stringify(extra) : ''}`) }
}

const BUILDING_ID = 'B003'
const graph = buildBuildingGraph(6)
const person = (id, floorId, zone, x, y) => ({
  id, buildingId: BUILDING_ID, floorId, zone, status: 'normal', x, y,
})
const sortZh = (arr) => [...arr].map(String).sort((a, b) => a.localeCompare(b, 'zh'))
const routesToExit = (plan) => (plan.routes || []).every((r) => {
  const m = /^(1F):EXIT_/.exec(r.exitId)
  return Boolean(m) && (r.floorsPassed || []).includes('1F')
})

console.log('\n=== RG-01 Zone 归属一致性测试 ===\n')

// ══════════════════════════════════════
// [1] 普通房间人员正常分组
// ══════════════════════════════════════
console.log('[1] 普通房间人员正常分组')
{
  const persons = [
    person('R1', '5F', 'A区', 140, 150),
    person('R2', '5F', 'A区', 150, 155),
    person('R3', '5F', 'C区', 415, 150),
  ]
  const groups = groupPersonsByZone(persons, { buildingId: BUILDING_ID, graph })
  check('房间人员按 floorId+zone 分为 2 组', groups.length === 2, groups.map((g) => g.zoneKey))
  check('zone 保存的是房间区域本身', groups.every((g) => g.zone === 'A区' || g.zone === 'C区'),
    groups.map((g) => g.zone))
  check('zoneKey === zoneKeyOf(floorId, zone)', groups.every((g) => g.zoneKey === zoneKeyOf(g.floorId, g.zone)),
    groups.map((g) => [g.zoneKey, zoneKeyOf(g.floorId, g.zone)]))
  check('同区域多人合并计数', groups.find((g) => g.zoneKey === '5F:A区')?.personCount === 2,
    groups.find((g) => g.zoneKey === '5F:A区')?.personCount)
  check('房间人员 sourceZones 只有自身区域',
    groups.every((g) => g.sourceZones.length === 1 && g.sourceZones[0] === g.zone),
    groups.map((g) => g.sourceZones))
}

// ══════════════════════════════════════
// [2] 走廊人员归属最近合法区域（双向验证，不锁单值）
// ══════════════════════════════════════
console.log('\n[2] 走廊人员归属最近合法区域')
{
  const nearA = person('C1', '5F', '走廊', 140, 160)
  const nearC = person('C2', '5F', '走廊', 415, 165)
  check('走廊(140,160) → A区', resolvePlanningZone(graph, nearA) === 'A区', resolvePlanningZone(graph, nearA))
  check('走廊(415,165) → C区', resolvePlanningZone(graph, nearC) === 'C区', resolvePlanningZone(graph, nearC))
  const groups = groupPersonsByZone([nearA, nearC], { buildingId: BUILDING_ID, graph })
  check('分组后 zone 已是归属后的房间区域', groups.length === 2 && groups.every((g) => g.zone !== '走廊'),
    groups.map((g) => [g.zoneKey, g.zone]))
  check('sourceZones 保留「走廊」原始区域', groups.every((g) => g.sourceZones.includes('走廊')),
    groups.map((g) => g.sourceZones))
}

// ══════════════════════════════════════
// [3] ★ 走廊人员经过完整分组 → 路线生成链路后能获得合法路线
//     （本项是验收主条件：不能只测 resolvePlanningZone 的返回值）
// ══════════════════════════════════════
console.log('\n[3] ★ 走廊人员走完整链路后获得路线')
{
  const persons = [person('C1', '5F', '走廊', 415, 165)]
  const res = planBuildingEvacuation({
    buildingId: BUILDING_ID, buildingName: '3号楼', persons, fire: null, strategy: STRATEGY.BALANCED, graph,
  })
  const { plan, groups, missingZones } = res
  const route = plan.routesByZone[zoneKeyOf('5F', 'C区')]
  check('分组键为归属后的 5F:C区', groups.length === 1 && groups[0].zoneKey === '5F:C区',
    groups.map((g) => g.zoneKey))
  check('得到路线：routesByZone[5F:C区] 存在', Boolean(route), Object.keys(plan.routesByZone))
  check('不存在 routesByZone[5F:走廊]', !plan.routesByZone[zoneKeyOf('5F', '走廊')],
    Object.keys(plan.routesByZone))
  check('路线通过校验（valid）', Boolean(route && route.valid), route && route.reasons)
  check('路线起点是 5F:C_CENTER', Boolean(route && route.nodes[0] === '5F:C_CENTER'), route && route.nodes[0])
  check('路线终点是 1F 安全出口', Boolean(route && /^1F:EXIT_/.test(route.exitId)), route && route.exitId)
  check('route.zone 与 routeId 后缀一致（5F:C区）',
    Boolean(route && route.zone === 'C区' && route.routeId === `${plan.id}:5F:C区`),
    route && [route.zone, route.routeId])
  check('missingZones 为空', missingZones.length === 0, missingZones)
  check('方案整体有效', plan.valid === true, plan.reasons)
  check('走廊人员被计入统计（1/1）', plan.summary.personCount === 1, plan.summary.personCount)
  check('全程无「走廊」区域残留', !Object.keys(plan.routesByZone).some((k) => k.includes('走廊')),
    Object.keys(plan.routesByZone))
}

// ══════════════════════════════════════
// [4] 多个走廊人员归属同一区域时正确合并
// ══════════════════════════════════════
console.log('\n[4] 多个走廊人员归属同一区域合并')
{
  const persons = [
    person('C1', '5F', '走廊', 415, 165),
    person('C2', '5F', '走廊', 420, 168),
    person('C3', '5F', '走廊', 410, 158),
  ]
  const res = planBuildingEvacuation({
    buildingId: BUILDING_ID, persons, fire: null, strategy: STRATEGY.BALANCED, graph,
  })
  check('合并为 1 个分组', res.groups.length === 1, res.groups.map((g) => g.zoneKey))
  check('personCount = 3', res.groups[0]?.personCount === 3, res.groups[0]?.personCount)
  check('personIds 全部保留', sortZh(res.groups[0]?.personIds || []).join(',') === 'C1,C2,C3',
    res.groups[0]?.personIds)
  check('只生成 1 条路线', res.plan.routes.length === 1, res.plan.routes.map((r) => r.routeId))
  check('统计人数 = 3（未丢人）', res.plan.summary.personCount === 3, res.plan.summary.personCount)
  check('summary.zoneCount = 1', res.plan.summary.zoneCount === 1, res.plan.summary.zoneCount)
}

// ══════════════════════════════════════
// [5] 不同楼层的同名区域不会错误合并
// ══════════════════════════════════════
console.log('\n[5] 不同楼层同名区域不合并')
{
  const persons = [
    person('F5', '5F', 'A区', 140, 150),
    person('F4', '4F', 'A区', 140, 150),
    person('C5', '5F', '走廊', 142, 160), // 应并入 5F:A区，而不是 4F:A区
  ]
  const groups = groupPersonsByZone(persons, { buildingId: BUILDING_ID, graph })
  const keys = groups.map((g) => g.zoneKey).sort()
  check('5F:A区 与 4F:A区 是两组', keys.join(',') === '4F:A区,5F:A区', keys)
  check('5F:A区 人数 = 2（房间 1 + 走廊 1）',
    groups.find((g) => g.zoneKey === '5F:A区')?.personCount === 2,
    groups.find((g) => g.zoneKey === '5F:A区')?.personCount)
  check('4F:A区 人数 = 1（走廊人员未跨层合并）',
    groups.find((g) => g.zoneKey === '4F:A区')?.personCount === 1,
    groups.find((g) => g.zoneKey === '4F:A区')?.personCount)
  const res = planBuildingEvacuation({
    buildingId: BUILDING_ID, persons, fire: null, strategy: STRATEGY.BALANCED, graph,
  })
  const r5 = res.plan.routesByZone[zoneKeyOf('5F', 'A区')]
  const r4 = res.plan.routesByZone[zoneKeyOf('4F', 'A区')]
  check('两条路线各自起点在自己的楼层',
    Boolean(r5 && r5.nodes[0] === '5F:A_CENTER' && r4 && r4.nodes[0] === '4F:A_CENTER'),
    [r5 && r5.nodes[0], r4 && r4.nodes[0]])
}

// ══════════════════════════════════════
// [6] 无法确定归属区域时采用明确的失败行为（不静默回退）
// ══════════════════════════════════════
console.log('\n[6] 无法确定归属 → 明确失败')
{
  // 9F 不在拓扑楼层范围内：同层没有任何房间节点 ⇒ 无法归属
  const persons = [person('X9', '9F', '走廊', 100, 100)]
  const res = planBuildingEvacuation({
    buildingId: BUILDING_ID, persons, fire: null, strategy: STRATEGY.BALANCED, graph,
  })
  check('保留原始区域作为键（不做猜测）', res.groups[0]?.zoneKey === '9F:走廊', res.groups[0]?.zoneKey)
  check('进入 missingZones', res.missingZones.includes('9F:走廊'), res.missingZones)
  check('方案整体无效（valid = false）', res.plan.valid === false, res.plan.valid)
  check('失败原因显式指向该区域',
    res.plan.reasons.some((s) => s.includes('9F:走廊') && s.includes('没有疏散路线')), res.plan.reasons)
  check('未把该人员静默计入已覆盖统计', res.plan.summary.personCount === 0, res.plan.summary.personCount)
  const audit = auditZoneGroups({ groups: res.groups, persons, plan: res.plan })
  check('审计同样判定未覆盖（ok = false）', audit.ok === false, audit)
  check('审计 missing 含 9F:走廊', audit.missing.includes('9F:走廊'), audit.missing)
}

// ══════════════════════════════════════
// [7] 原始来源 sourceZones 得到保留
// ══════════════════════════════════════
console.log('\n[7] 原始来源保留')
{
  const mixed = groupPersonsByZone(
    [person('M1', '5F', 'A区', 140, 150), person('M2', '5F', '走廊', 140, 160)],
    { buildingId: BUILDING_ID, graph },
  )
  const g = mixed[0]
  check('混合组 sourceZones 含 A区 与 走廊（顺序按输入，只校验集合）',
    g.sourceZones.length === 2 && g.sourceZones.includes('A区') && g.sourceZones.includes('走廊'), g.sourceZones)
  check('混合组 zone 只有归属后区域（不含走廊）', g.zone === 'A区', g.zone)
  check('混合组 zoneKey 与 zone 一致', g.zoneKey === zoneKeyOf(g.floorId, g.zone), [g.zoneKey, g.zone])

  const pure = groupPersonsByZone([person('P1', '5F', '走廊', 415, 165)], { buildingId: BUILDING_ID, graph })
  check('纯走廊组 sourceZones = [走廊]', pure[0].sourceZones.join(',') === '走廊', pure[0].sourceZones)
  check('纯走廊组 zone = 归属后区域 C区', pure[0].zone === 'C区', pure[0].zone)

  const noGraph = groupPersonsByZone([person('N1', '5F', '走廊', 415, 165)], { buildingId: BUILDING_ID })
  check('不传 graph 时不做归属（保持原 zone）', noGraph[0].zone === '走廊' && noGraph[0].zoneKey === '5F:走廊',
    [noGraph[0].zone, noGraph[0].zoneKey])
}

// ══════════════════════════════════════
// [8] BALANCED / FASTEST / SAFEST 三种策略不发生回归
// ══════════════════════════════════════
console.log('\n[8] 三种策略无回归')
{
  const persons = [
    person('S1', '5F', 'A区', 140, 150),
    person('S2', '5F', '走廊', 415, 165),
    person('S3', '4F', 'B区', 140, 190),
    person('S4', '6F', '走廊', 477, 175),
    person('S5', '3F', 'C区', 415, 150),
  ]
  const fire = { buildingId: BUILDING_ID, floorId: '5F', zone: 'A区' }
  const { plans, groups, missingZonesByStrategy } = planBuildingStrategies({
    buildingId: BUILDING_ID, buildingName: '3号楼', persons, fire, maxFloor: 6, graph,
  })
  check('生成 3 套方案（A/B/C）', plans.map((p) => p.id).join(',') === 'PLAN-A,PLAN-B,PLAN-C',
    plans.map((p) => p.id))
  check('三套策略均无缺失区域',
    [STRATEGY.BALANCED, STRATEGY.FASTEST, STRATEGY.SAFEST]
      .every((s) => Array.isArray(missingZonesByStrategy[s]) && missingZonesByStrategy[s].length === 0),
    missingZonesByStrategy)
  plans.forEach((p) => {
    check(`${p.id} 路线数 = 分组数（${groups.length}）`, p.routes.length === groups.length,
      [p.routes.length, groups.length])
    check(`${p.id} 每个分组都有 routesByZone[zoneKey]`,
      groups.every((g) => Boolean(p.routesByZone[g.zoneKey])),
      groups.filter((g) => !p.routesByZone[g.zoneKey]).map((g) => g.zoneKey))
    check(`${p.id} 全部路线 valid 且终点为 1F 出口`, p.routes.every((r) => r.valid) && routesToExit(p), p.reasons)
    check(`${p.id} 统计人数 = ${persons.length}`, p.summary.personCount === persons.length, p.summary.personCount)
    check(`${p.id} 无「走廊」区域键`, !Object.keys(p.routesByZone).some((k) => k.includes('走廊')),
      Object.keys(p.routesByZone))
  })
  const [A, B, C] = plans
  const strategyOk = groups.every((g) => {
    const ra = A.routesByZone[g.zoneKey]
    const rb = B.routesByZone[g.zoneKey]
    const rc = C.routesByZone[g.zoneKey]
    return rb.estimatedTime <= ra.estimatedTime
      && (RISK_RANK[rc.riskLevel] ?? 9) <= (RISK_RANK[ra.riskLevel] ?? 9)
  })
  check('B(快速) 耗时 ≤ A(均衡)、C(安全) 风险 ≤ A(均衡)', strategyOk,
    groups.map((g) => [g.zoneKey,
      A.routesByZone[g.zoneKey]?.estimatedTime, B.routesByZone[g.zoneKey]?.estimatedTime]))
}

// ══════════════════════════════════════
// [9] 输入顺序无关（走廊人员先入组 vs 房间人员先入组）
// ══════════════════════════════════════
console.log('\n[9] 输入顺序无关')
{
  const corridor = [person('C1', '5F', '走廊', 140, 160), person('C2', '5F', '走廊', 142, 162)]
  const room = [person('R1', '5F', 'A区', 140, 150), person('R2', '5F', 'C区', 415, 150)]
  const forward = [...corridor, ...room]
  const backward = [...room, ...corridor]
  const g1 = groupPersonsByZone(forward, { buildingId: BUILDING_ID, graph })
  const g2 = groupPersonsByZone(backward, { buildingId: BUILDING_ID, graph })
  check('分组键集合一致', sortZh(g1.map((g) => g.zoneKey)).join(',') === sortZh(g2.map((g) => g.zoneKey)).join(','),
    [g1.map((g) => g.zoneKey), g2.map((g) => g.zoneKey)])
  check('每组人数一致', g1.every((a) => g2.find((b) => b.zoneKey === a.zoneKey)?.personCount === a.personCount),
    [g1.map((g) => [g.zoneKey, g.personCount]), g2.map((g) => [g.zoneKey, g.personCount])])
  check('每组 zone 一致（不依赖谁先入组）',
    g1.every((a) => g2.find((b) => b.zoneKey === a.zoneKey)?.zone === a.zone),
    [g1.map((g) => [g.zoneKey, g.zone]), g2.map((g) => [g.zoneKey, g.zone])])
  const p1 = planBuildingEvacuation({
    buildingId: BUILDING_ID, persons: forward, fire: null, strategy: STRATEGY.BALANCED, graph,
  })
  const p2 = planBuildingEvacuation({
    buildingId: BUILDING_ID, persons: backward, fire: null, strategy: STRATEGY.BALANCED, graph,
  })
  check('两种顺序生成的路线集合一致',
    sortZh(Object.keys(p1.plan.routesByZone)).join(',') === sortZh(Object.keys(p2.plan.routesByZone)).join(','),
    [Object.keys(p1.plan.routesByZone), Object.keys(p2.plan.routesByZone)])
  check('两种顺序统计人数一致且 = 4',
    p1.plan.summary.personCount === 4 && p2.plan.summary.personCount === 4,
    [p1.plan.summary.personCount, p2.plan.summary.personCount])
  check('两种顺序方案均有效', p1.plan.valid === true && p2.plan.valid === true,
    [p1.plan.reasons, p2.plan.reasons])
}

// ══════════════════════════════════════
// [10] 缺失坐标 / NULL / 非有限数值不得产生错误归属
// ══════════════════════════════════════
console.log('\n[10] 无效坐标不产生错误归属')
{
  check('isValidCoordinate 判定：0 有效', isValidCoordinate(0) === true)
  check('isValidCoordinate 判定：null 无效', isValidCoordinate(null) === false)
  check('isValidCoordinate 判定：NaN 无效', isValidCoordinate(NaN) === false)
  check('isValidCoordinate 判定：Infinity 无效', isValidCoordinate(Infinity) === false)
  check('isValidCoordinate 判定：空串无效', isValidCoordinate('') === false)
  check('isValidCoordinate 判定：非数字字符串无效', isValidCoordinate('abc') === false)

  const cases = [
    ['null', person('N1', '5F', '走廊', null, null)],
    ['undefined', person('N2', '5F', '走廊', undefined, undefined)],
    ['NaN', person('N3', '5F', '走廊', NaN, 160)],
    ['Infinity', person('N4', '5F', '走廊', Infinity, 170)],
    ['非数字字符串', person('N5', '5F', '走廊', 'abc', 160)],
    ['仅缺 y', person('N6', '5F', '走廊', 415, null)],
  ]
  cases.forEach(([label, p]) => {
    const zone = resolvePlanningZone(graph, p)
    const g = groupPersonsByZone([p], { buildingId: BUILDING_ID, graph })[0]
    check(`${label}：不归到 A区/C区（保持原始区域）`, zone === '走廊' && g.zone === '走廊', [zone, g.zone])
    check(`${label}：分组键为 5F:走廊（可被审计发现）`, g.zoneKey === '5F:走廊', g.zoneKey)
  })

  const res = planBuildingEvacuation({
    buildingId: BUILDING_ID, persons: cases.map((c) => c[1]), fire: null, strategy: STRATEGY.BALANCED, graph,
  })
  check('无效坐标人员进入 missingZones（明确失败）', res.missingZones.includes('5F:走廊'), res.missingZones)
  check('方案无效而非静默给出一条错路线', res.plan.valid === false && res.plan.routes.length === 0,
    [res.plan.valid, res.plan.routes.length])
  // 对照组：坐标有效时同样的人员形态必须能归属并拿到路线
  const okRes = planBuildingEvacuation({
    buildingId: BUILDING_ID, persons: [person('OK', '5F', '走廊', 415, 165)],
    fire: null, strategy: STRATEGY.BALANCED, graph,
  })
  check('对照组：有效坐标 → 归属 C区并生成路线',
    okRes.missingZones.length === 0 && Boolean(okRes.plan.routesByZone[zoneKeyOf('5F', 'C区')]),
    okRes.missingZones)
}

// ══════════════════════════════════════
// [11] 篡改 zone / zoneKey 后，Worker 校验规则必须拒绝
//      （规则来源 = auditZoneGroups，Worker validateConfirmedBuildingPlan 直接调用它）
// ══════════════════════════════════════
console.log('\n[11] 篡改 zone / zoneKey 必须被拒绝')
{
  const persons = [
    person('T1', '5F', 'A区', 140, 150),
    person('T2', '5F', '走廊', 415, 165),
  ]
  const res = planBuildingEvacuation({
    buildingId: BUILDING_ID, persons, fire: null, strategy: STRATEGY.BALANCED, graph,
  })
  const base = auditZoneGroups({ groups: res.groups, persons, plan: res.plan })
  check('未篡改时审计通过', base.ok === true, base.reasons)

  // ① 篡改 zoneKey（zone 仍正确）
  const badKey = res.groups.map((g) => (g.zoneKey === '5F:A区' ? { ...g, zoneKey: '5F:走廊' } : { ...g }))
  const a1 = auditZoneGroups({ groups: badKey, persons, plan: res.plan })
  check('篡改 zoneKey → 拒绝', a1.ok === false, a1)
  check('篡改 zoneKey → 报告 inconsistent', a1.inconsistent.length === 1, a1.inconsistent)

  // ② 篡改 zone（zoneKey 仍正确）
  const badZone = res.groups.map((g) => (g.zoneKey === '5F:A区' ? { ...g, zone: '走廊' } : { ...g }))
  const a2 = auditZoneGroups({ groups: badZone, persons, plan: res.plan })
  check('篡改 zone → 拒绝', a2.ok === false, a2)
  check('篡改 zone → 报告 inconsistent 且给出期望键',
    a2.inconsistent.length === 1 && a2.inconsistent[0].expectedKey === '5F:走廊', a2.inconsistent)

  // ③ 丢人（personIds 被删）
  const lost = res.groups.map((g) => (
    g.zoneKey === '5F:C区' ? { ...g, personIds: [], personCount: 1 } : { ...g }
  ))
  const a3 = auditZoneGroups({ groups: lost, persons, plan: res.plan })
  check('分组丢人 → 拒绝', a3.ok === false, a3)
  check('分组丢人 → 报告 missingPersons 含 T2', a3.missingPersons.includes('T2'), a3.missingPersons)

  // ④ 删掉方案里某个区域的路线
  const badPlan = { ...res.plan, routesByZone: { ...res.plan.routesByZone } }
  delete badPlan.routesByZone['5F:C区']
  const a4 = auditZoneGroups({ groups: res.groups, persons, plan: badPlan })
  check('方案缺路线 → 拒绝', a4.ok === false, a4)
  check('方案缺路线 → 报告 missing 含 5F:C区', a4.missing.includes('5F:C区'), a4.missing)
}

// ══════════════════════════════════════
// [12] RG-01-R1.1：人员完整性（唯一性 / 越界 / 计数一致）
// ══════════════════════════════════════
console.log('\n[12] 人员完整性（唯一性 / 越界 / 计数）')
{
  const g = (floorId, zone, ids, count) => ({
    zoneKey: zoneKeyOf(floorId, zone), floorId, zone, sourceZones: [zone],
    personIds: ids, personCount: count === undefined ? ids.length : count,
  })
  const r = (floorId, zone) => ({ routeId: `PLAN-A:${floorId}:${zone}`, floorId, zone, valid: true })
  const planOf = (routes) => ({ routesByZone: Object.fromEntries(routes.map((x) => [zoneKeyOf(x.floorId, x.zone), x])) })

  // ① 同一人员出现在两个分组
  const a1 = auditZoneGroups({
    groups: [g('5F', 'A区', ['X']), g('5F', 'C区', ['X'])],
    persons: [person('X', '5F', 'A区', 140, 150)],
    plan: planOf([r('5F', 'A区'), r('5F', 'C区')]),
  })
  check('同一人员出现在两个分组 → 拒绝', a1.ok === false, a1.reasons)
  check('同一人员出现在两个分组 → 报告 duplicatePersonIds', a1.duplicatePersonIds.length === 1
    && a1.duplicatePersonIds[0].id === 'X' && a1.duplicatePersonIds[0].count === 2, a1.duplicatePersonIds)

  // ② 输入人员 ID 重复（分组结果只有一个 X）
  const a2 = auditZoneGroups({
    groups: [g('5F', 'A区', ['X'])],
    persons: [person('X', '5F', 'A区', 140, 150), person('X', '5F', 'A区', 141, 151)],
    plan: planOf([r('5F', 'A区')]),
  })
  check('输入人员 id 重复 → 拒绝', a2.ok === false, a2.reasons)
  check('输入人员 id 重复 → 报告 duplicatePersons', a2.duplicatePersons.length === 1
    && a2.duplicatePersons[0].count === 2, a2.duplicatePersons)

  // ③ 分组出现多余人员 ID（不在输入集合内）
  const a3 = auditZoneGroups({
    groups: [g('5F', 'A区', ['X', 'GHOST'])],
    persons: [person('X', '5F', 'A区', 140, 150)],
    plan: planOf([r('5F', 'A区')]),
  })
  check('分组含多余 id → 拒绝', a3.ok === false, a3.reasons)
  check('分组含多余 id → 报告 extraPersonIds 含 GHOST',
    a3.extraPersonIds.length === 1 && a3.extraPersonIds[0] === 'GHOST', a3.extraPersonIds)

  // ④ personCount 与 personIds.length 不一致
  const a4 = auditZoneGroups({
    groups: [g('5F', 'A区', ['X'], 5)],
    persons: [person('X', '5F', 'A区', 140, 150)],
    plan: planOf([r('5F', 'A区')]),
  })
  check('personCount 与 personIds.length 不一致 → 拒绝', a4.ok === false, a4.reasons)
  check('计数不一致 → 报告 countMismatch（5 vs 1）', a4.countMismatch.length === 1
    && a4.countMismatch[0].personCount === 5 && a4.countMismatch[0].idCount === 1, a4.countMismatch)

  // 对照组：同结构完全合法
  const ok1 = auditZoneGroups({
    groups: [g('5F', 'A区', ['X'])],
    persons: [person('X', '5F', 'A区', 140, 150)],
    plan: planOf([r('5F', 'A区')]),
  })
  check('对照组合法 → 通过', ok1.ok === true, ok1.reasons)
}

// ══════════════════════════════════════
// [13] RG-01-R1.1：分组 ↔ 路线区域对应关系
// ══════════════════════════════════════
console.log('\n[13] 分组 ↔ 路线区域对应')
{
  const groups = [{
    zoneKey: '5F:A区', floorId: '5F', zone: 'A区', sourceZones: ['A区'],
    personIds: ['T1'], personCount: 1,
  }]
  const persons = [person('T1', '5F', 'A区', 140, 150)]

  // ① route.zone 与 group.zone 不一致（同楼层、别的区域路线冒充）
  const a1 = auditZoneGroups({
    groups,
    persons,
    plan: { routesByZone: { '5F:A区': { routeId: 'PLAN-A:5F:C区', floorId: '5F', zone: 'C区', valid: true } } },
  })
  check('route.zone ≠ group.zone → 拒绝', a1.ok === false, a1.reasons)
  check('route.zone ≠ group.zone → 报告 invalidRoutes',
    a1.invalidRoutes.length === 1 && a1.invalidRoutes[0].routeZone === 'C区', a1.invalidRoutes)
  check('该情形不计入 missing（键确实存在）', a1.missing.length === 0, a1.missing)

  // ② 同区域名但别的楼层路线冒充
  const a2 = auditZoneGroups({
    groups,
    persons,
    plan: { routesByZone: { '5F:A区': { routeId: 'PLAN-A:4F:A区', floorId: '4F', zone: 'A区', valid: true } } },
  })
  check('route.floorId ≠ group.floorId → 拒绝', a2.ok === false, a2.reasons)
  check('跨楼层冒充 → 报告 invalidRoutes', a2.invalidRoutes.length === 1
    && a2.invalidRoutes[0].routeFloorId === '4F', a2.invalidRoutes)

  // ③ routesByZone 结构缺失
  const a3 = auditZoneGroups({ groups, persons, plan: { routes: [] } })
  check('routesByZone 缺失 → 拒绝', a3.ok === false, a3.reasons)
  check('routesByZone 缺失 → 明确报告 missing 含 5F:A区', a3.missing.includes('5F:A区'), a3.missing)
  check('routesByZone 缺失 → reasons 有明确说明',
    a3.reasons.some((s) => s.includes('5F:A区') && s.includes('没有疏散路线')), a3.reasons)

  // ④ 路线对象为空 / null
  const a4 = auditZoneGroups({ groups, persons, plan: { routesByZone: { '5F:A区': null } } })
  check('路线对象为 null → 拒绝并计入 missing', a4.ok === false && a4.missing.length === 1, a4.reasons)

  // 对照组：区域一致 → 通过
  const ok1 = auditZoneGroups({
    groups,
    persons,
    plan: { routesByZone: { '5F:A区': { routeId: 'PLAN-A:5F:A区', floorId: '5F', zone: 'A区', valid: true } } },
  })
  check('对照组合法 → 通过', ok1.ok === true, ok1.reasons)
}

// ══════════════════════════════════════
// [14] RG-01-R1.1：异常输入（缺失 ≠ 合法空集合）
// ══════════════════════════════════════
console.log('\n[14] 异常输入处理')
{
  const persons = [person('T1', '5F', 'A区', 140, 150)]
  const plan = { routesByZone: { '5F:A区': { routeId: 'PLAN-A:5F:A区', floorId: '5F', zone: 'A区', valid: true } } }
  const groups = [{
    zoneKey: '5F:A区', floorId: '5F', zone: 'A区', sourceZones: ['A区'],
    personIds: ['T1'], personCount: 1,
  }]

  let threw = false
  let r1 = null
  try { r1 = auditZoneGroups({ groups: null, persons, plan }) } catch (e) { threw = true }
  check('groups: null → 不抛出未处理异常', threw === false)
  check('groups: null → 明确失败（ok = false）', Boolean(r1) && r1.ok === false, r1)
  check('groups: null → inputErrors 指明 groups', Boolean(r1) && r1.inputErrors.some((s) => s.includes('groups')),
    r1 && r1.inputErrors)

  let threw2 = false
  let r2 = null
  try { r2 = auditZoneGroups({ groups, persons: null, plan }) } catch (e) { threw2 = true }
  check('persons: null → 不抛出未处理异常', threw2 === false)
  check('persons: null → 不得静默跳过覆盖校验（ok = false）', Boolean(r2) && r2.ok === false, r2)
  check('persons: null → inputErrors 指明 persons',
    Boolean(r2) && r2.inputErrors.some((s) => s.includes('persons')), r2 && r2.inputErrors)

  const r3 = auditZoneGroups({ groups, persons })
  check('plan 缺失 → 明确失败', r3.ok === false && r3.inputErrors.some((s) => s.includes('plan')), r3)

  const r4 = auditZoneGroups({ groups: undefined, persons, plan })
  check('groups: undefined → 明确失败', r4.ok === false && r4.inputErrors.length > 0, r4.inputErrors)

  // 合法空集合必须通过（区分于非法缺失参数）
  const empty = auditZoneGroups({ groups: [], persons: [], plan: { routesByZone: {} } })
  check('合法空集合 groups:[] + persons:[] → 通过', empty.ok === true, empty.reasons)
  check('合法空集合 → 无任何失败明细',
    empty.reasons.length === 0 && empty.missing.length === 0 && empty.missingPersons.length === 0
    && empty.inputErrors.length === 0, empty)

  // 空集合 + routesByZone 缺失 仍是合法空集合（无分组 ⇒ 无需路线）
  const emptyNoZone = auditZoneGroups({ groups: [], persons: [], plan: {} })
  check('空集合 + plan 无 routesByZone → 仍通过（无分组）', emptyNoZone.ok === true, emptyNoZone.reasons)

  // 有人员但分组为空 ⇒ 明确失败（不静默）
  const orphan = auditZoneGroups({ groups: [], persons, plan: { routesByZone: {} } })
  check('有人员但零分组 → 拒绝', orphan.ok === false, orphan.reasons)
  check('有人员但零分组 → 报告 missingPersons 含 T1', orphan.missingPersons.includes('T1'), orphan.missingPersons)
}

// ══════════════════════════════════════
// [15] RG-01-R1.2：非法人员记录必须留痕（G1 / G2 / G3 / G4）
//      修复前：persons 中的 null / 非对象 / 无 id 记录被静默 return，ok 仍为 true
// ══════════════════════════════════════
console.log('\n[15] 非法人员记录必须留痕')
{
  const mkPlan = (zones) => ({
    routesByZone: Object.fromEntries(zones.map(([f, z]) => [
      zoneKeyOf(f, z), { routeId: `PLAN-A:${f}:${z}`, floorId: f, zone: z, valid: true },
    ])),
  })
  const mkGroups = (persons) => groupPersonsByZone(persons, { buildingId: BUILDING_ID, graph })
  const planA = mkPlan([['5F', 'A区']])
  const good = [person('T1', '5F', 'A区', 140, 150)]

  const base = auditZoneGroups({ groups: mkGroups(good), persons: good, plan: planA })
  check('合法基线 → ok=true 且 inputErrors 为空', base.ok === true && base.inputErrors.length === 0, base)

  // G1：非对象记录（null / undefined / 字符串 / 数组）
  // G2：无效 id（null / 空串 / 纯空白 / 对象 / 布尔 / NaN / Infinity）
  const badCases = [
    ['null 记录', [null]],
    ['undefined 记录', [undefined]],
    ['裸字符串记录', ['A001']],
    ['数组记录', [['T1']]],
    ['空对象', [{}]],
    ['id 为 null', [{ id: null, floorId: '5F', zone: 'A区' }]],
    ['id 为空字符串', [{ id: '', floorId: '5F', zone: 'A区' }]],
    ['id 为纯空白字符串', [{ id: '   ', floorId: '5F', zone: 'A区' }]],
    ['id 为对象', [{ id: { a: 1 }, floorId: '5F', zone: 'A区' }]],
    ['id 为数组', [{ id: ['T1'], floorId: '5F', zone: 'A区' }]],
    ['id 为布尔值', [{ id: true, floorId: '5F', zone: 'A区' }]],
    ['id 为 NaN', [{ id: NaN, floorId: '5F', zone: 'A区' }]],
    ['id 为 Infinity', [{ id: Infinity, floorId: '5F', zone: 'A区' }]],
  ]
  badCases.forEach(([label, persons]) => {
    const r = auditZoneGroups({ groups: mkGroups(persons), persons, plan: planA })
    check(`${label} → inputErrors 非空`, r.inputErrors.length >= 1, r.inputErrors)
    check(`${label} → ok=false`, r.ok === false, r.reasons)
    check(`${label} → reasons 指明具体条目`, r.reasons.some((s) => s.includes('persons[')), r.reasons)
  })

  // G3 反向：数字 0 / 字符串 '0' 在 normalizePersonId 层必须被接受（不因 falsy 被拒）
  // G5（RG-01-R1.3 已修）：数字 0 必须与 normalizePersonId 的判定同源，正常入组并通过审计
  const zeroNum = [{ id: 0, floorId: '5F', zone: 'A区', x: 140, y: 150 }]
  const gz = mkGroups(zeroNum)
  const r0 = auditZoneGroups({ groups: gz, persons: zeroNum, plan: planA })
  check('数字 id 0 → 进入 personIds 且 personCount=1',
    gz[0].personIds.length === 1 && gz[0].personIds[0] === 0 && gz[0].personCount === 1,
    { personIds: gz[0].personIds, personCount: gz[0].personCount })
  check('数字 id 0 → 端到端通过审计（ok=true，无 inputErrors / countMismatch）',
    r0.ok === true && r0.inputErrors.length === 0 && r0.countMismatch.length === 0, r0.reasons)

  const zeroStr = [{ id: '0', floorId: '5F', zone: 'A区', x: 140, y: 150 }]
  const rs = auditZoneGroups({ groups: mkGroups(zeroStr), persons: zeroStr, plan: planA })
  check("字符串 id '0' 端到端被接受", rs.ok === true && rs.inputErrors.length === 0, rs)

  const bothZero = [zeroNum[0], zeroStr[0]]
  const rb = auditZoneGroups({ groups: mkGroups(bothZero), persons: bothZero, plan: planA })
  check('数字 0 与字符串 \'0\' 归一化为同一 id → 判重复而非静默合并',
    rb.ok === false && rb.duplicatePersons.length === 1, rb.duplicatePersons)

  // G3 原值保留：仅用 trim 判断是否空白，不改变有效字符串
  const padded = [
    { id: ' A001 ', floorId: '5F', zone: 'A区', x: 140, y: 150, buildingId: BUILDING_ID },
    { id: 'A001', floorId: '5F', zone: 'A区', x: 141, y: 151, buildingId: BUILDING_ID },
  ]
  const rp = auditZoneGroups({ groups: mkGroups(padded), persons: padded, plan: planA })
  check('含前后空白的 id 保留原值，与无空白 id 视为不同身份',
    rp.ok === true && rp.duplicatePersons.length === 0, rp.duplicatePersons)

  // G4：合法与非法混入 —— 不得因合法部分齐全而放行
  const mixed = [null, good[0], 'X', {}, { id: '' }]
  const rm = auditZoneGroups({ groups: mkGroups(mixed), persons: mixed, plan: planA })
  check('合法+非法混入 → inputErrors 记录 4 条非法记录', rm.inputErrors.length === 4, rm.inputErrors)
  check('合法+非法混入 → ok=false（合法部分齐全也不放行）', rm.ok === false, rm.reasons)
  check('合法+非法混入 → 非法条目不再影响合法人员的覆盖判定',
    rm.missingPersons.length === 0 && rm.missing.length === 0, { mp: rm.missingPersons, m: rm.missing })

  // G4 汇总不变量：inputErrors 非空 ⇒ ok 必为 false
  const invariant = [
    [null], [undefined], ['A001'], [{}], [{ id: '' }], [{ id: '   ' }], [{ id: {} }], [{ id: false }],
  ].every((persons) => {
    const r = auditZoneGroups({ groups: mkGroups(persons), persons, plan: planA })
    return r.inputErrors.length > 0 && r.ok === false
  })
  check('不变量：inputErrors 非空 ⇒ ok 恒为 false', invariant)
}

// ══════════════════════════════════════
// [16] RG-01-R1.3：错误文案健壮性 —— 任何非法 id 都不能让审计自身抛异常
//      修复前：错误文案使用 JSON.stringify(p.id)，对 BigInt 直接抛 TypeError
// ══════════════════════════════════════
console.log('\n[16] 错误文案健壮性')
{
  const planA = {
    routesByZone: { '5F:A区': { routeId: 'PLAN-A:5F:A区', floorId: '5F', zone: 'A区', valid: true } },
  }
  const run = (persons) => {
    try {
      const groups = groupPersonsByZone(persons, { buildingId: BUILDING_ID, graph })
      return { threw: false, r: auditZoneGroups({ groups, persons, plan: planA }) }
    } catch (e) {
      return { threw: true, message: String(e && e.message) }
    }
  }
  const circular = {}
  circular.self = circular

  const dangerous = [
    ['id: 1n（BigInt）', [{ id: 1n, floorId: '5F', zone: 'A区' }], '1n'],
    ["id: Symbol('invalid')", [{ id: Symbol('invalid'), floorId: '5F', zone: 'A区' }], 'Symbol(invalid)'],
    ['id: 循环引用对象', [{ id: circular, floorId: '5F', zone: 'A区' }], '<object>'],
    ['id: 函数', [{ id: () => 1, floorId: '5F', zone: 'A区' }], '<function>'],
  ]
  dangerous.forEach(([label, persons, hint]) => {
    const out = run(persons)
    check(`${label} → 审计不抛异常`, out.threw === false, out.message)
    check(`${label} → ok=false`, out.threw === false && out.r.ok === false, out.threw ? 'threw' : out.r.reasons)
    check(`${label} → inputErrors 非空`, out.threw === false && out.r.inputErrors.length >= 1,
      out.threw ? 'threw' : out.r.inputErrors)
    check(`${label} → 文案含类型摘要 ${hint}`,
      out.threw === false && out.r.inputErrors.some((s) => s.includes(hint)), out.threw ? 'threw' : out.r.inputErrors)
    check(`${label} → reasons 保留对应错误信息`,
      out.threw === false && out.r.reasons.some((s) => s.includes('persons[')), out.threw ? 'threw' : out.r.reasons)
  })

  // 既有非法类型仍按原规则判失败（文案加固不改变判定规则）
  const legacy = [
    ['空对象', [{}]],
    ['数组 id', [{ id: [], floorId: '5F', zone: 'A区' }]],
    ['布尔 id', [{ id: true, floorId: '5F', zone: 'A区' }]],
    ['null id', [{ id: null, floorId: '5F', zone: 'A区' }]],
    ['纯空白 id', [{ id: '   ', floorId: '5F', zone: 'A区' }]],
  ]
  legacy.forEach(([label, persons]) => {
    const out = run(persons)
    check(`${label} → 仍判失败且不抛异常`, out.threw === false && out.r.ok === false, out.threw ? out.message : out.r.reasons)
  })

  // 文案安全性不掩盖真正的审计错误：合法人员缺路线仍应报 missing
  const okPersons = [person('T1', '5F', 'A区', 140, 150)]
  const missOut = run(okPersons)
  const missCheck = auditZoneGroups({
    groups: groupPersonsByZone(okPersons, { buildingId: BUILDING_ID, graph }),
    persons: okPersons,
    plan: { routesByZone: {} },
  })
  check('文案加固不影响正常审计结论（缺路线仍报 missing）',
    missOut.threw === false && missOut.r.ok === true && missCheck.ok === false
    && missCheck.missing.includes('5F:A区'), missCheck.reasons)
}

// ══════════════════════════════════════
// [17] RG-01-R1.4：已撤销 Proxy 作为非法 id —— 文案格式化不得让审计抛异常
//      修复前：describeIdValue 在 Array.isArray(revokedProxy) 上抛
//      TypeError: Cannot perform 'IsArray' on a proxy that has been revoked
// ══════════════════════════════════════
console.log('\n[17] 已撤销 Proxy 的文案兜底')
{
  const planA = {
    routesByZone: { '5F:A区': { routeId: 'PLAN-A:5F:A区', floorId: '5F', zone: 'A区', valid: true } },
  }
  const auditOnce = (persons) => {
    try {
      const groups = groupPersonsByZone(persons, { buildingId: BUILDING_ID, graph })
      return { threw: false, r: auditZoneGroups({ groups, persons, plan: planA }) }
    } catch (e) {
      return { threw: true, message: String(e && e.message) }
    }
  }

  const { proxy: revoked, revoke } = Proxy.revocable({}, {})
  revoke()
  const proxyPerson = { id: revoked, floorId: '5F', zone: 'A区', x: 140, y: 150 }
  const out = auditOnce([proxyPerson])

  check('revoked Proxy 作为 id → 审计不抛异常', out.threw === false, out.message)
  check('revoked Proxy 作为 id → ok=false', out.threw === false && out.r.ok === false,
    out.threw ? 'threw' : out.r.reasons)
  check('revoked Proxy 作为 id → inputErrors 非空',
    out.threw === false && out.r.inputErrors.length >= 1, out.threw ? 'threw' : out.r.inputErrors)
  check('revoked Proxy 作为 id → 摘要为安全占位符 <unprintable>',
    out.threw === false && out.r.inputErrors.some((s) => s.includes('<unprintable>')),
    out.threw ? 'threw' : out.r.inputErrors)
  check('revoked Proxy 作为 id → reasons 保留对应错误条目',
    out.threw === false && out.r.reasons.some((s) => s.includes('persons[')),
    out.threw ? 'threw' : out.r.reasons)

  // 与合法人员混合：非法记录留痕，但不得误伤合法人员的覆盖判定
  const mixedOut = auditOnce([proxyPerson, person('T1', '5F', 'A区', 140, 150)])
  check('非法 + 合法混合 → ok=false 且合法人员不被误判为丢人',
    mixedOut.threw === false && mixedOut.r.ok === false
    && mixedOut.r.missingPersons.length === 0 && mixedOut.r.missing.length === 0,
    mixedOut.threw ? 'threw' : { mp: mixedOut.r.missingPersons, m: mixedOut.r.missing })

  // 回归：R1.3 已覆盖的安全格式化场景仍然成立
  const circular = {}
  circular.self = circular
  const bigintOut = auditOnce([{ id: 1n, floorId: '5F', zone: 'A区' }])
  check('回归 BigInt：不抛异常且摘要为 1n',
    bigintOut.threw === false && bigintOut.r.inputErrors.some((s) => s.includes('1n')),
    bigintOut.threw ? bigintOut.message : bigintOut.r.inputErrors)
  const symbolOut = auditOnce([{ id: Symbol('x'), floorId: '5F', zone: 'A区' }])
  check('回归 Symbol：不抛异常且摘要为 Symbol(x)',
    symbolOut.threw === false && symbolOut.r.inputErrors.some((s) => s.includes('Symbol(x)')),
    symbolOut.threw ? symbolOut.message : symbolOut.r.inputErrors)
  const circularOut = auditOnce([{ id: circular, floorId: '5F', zone: 'A区' }])
  check('回归 循环引用对象：不抛异常且摘要为 <object>',
    circularOut.threw === false && circularOut.r.inputErrors.some((s) => s.includes('<object>')),
    circularOut.threw ? circularOut.message : circularOut.r.inputErrors)

  // 回归：合法 ID / 数字 0 / 0 与 '0' 重复检测
  const validOut = auditOnce([person('T1', '5F', 'A区', 140, 150)])
  check('回归 合法 ID：审计通过', validOut.threw === false && validOut.r.ok === true,
    validOut.threw ? validOut.message : validOut.r.reasons)
  const zeroOut = auditOnce([{ id: 0, floorId: '5F', zone: 'A区', x: 140, y: 150 }])
  check('回归 数字 0：不被判为无效 id 且审计通过',
    zeroOut.threw === false && zeroOut.r.ok === true && zeroOut.r.inputErrors.length === 0,
    zeroOut.threw ? zeroOut.message : zeroOut.r.reasons)
  const bothZero = [
    { id: 0, floorId: '5F', zone: 'A区', x: 140, y: 150 },
    { id: '0', floorId: '5F', zone: 'A区', x: 141, y: 151 },
  ]
  const dupOut = auditOnce(bothZero)
  check("回归 数字 0 与字符串 '0'：仍判重复",
    dupOut.threw === false && dupOut.r.ok === false && dupOut.r.duplicatePersons.length === 1,
    dupOut.threw ? dupOut.message : dupOut.r.duplicatePersons)
}

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`)
if (fail) process.exit(1)

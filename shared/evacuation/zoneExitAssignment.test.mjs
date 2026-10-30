/**
 * S2-A 测试契约：Zone→Exit 分配行为冻结（node shared/evacuation/zoneExitAssignment.test.mjs）
 *
 * 依据：docs/P1.8.2-Stage2-Zone-Exit分配设计定义.md §5.3（分配规则）与 §7（边界场景）。
 * 目标：将现有分配行为转化为可执行断言，证明现有实现符合契约。
 *
 * 边界声明：
 *   · 本文件只新增测试，不改任何业务源码 / 既有测试 / 配置。
 *   · score 权重 / EVAC_SPEED / STAIR_PENALTY_S 仅为「现有行为回归基线」，不宣称业务认可。
 *   · 不接入 zoneExitReachability；不实现 capacity / 拥堵 / 转弯 / 周转评分。
 */
import {
  planBuildingStrategies, planBuildingEvacuation, groupPersonsByZone,
  pickRouteByStrategy, resolvePlanningZone,
} from './buildingEvacuationPlanner.js'
import { STRATEGY, zoneKeyOf } from './buildingEvacuationTypes.js'
import { buildBuildingGraph } from './routeGraph.js'
import { EXIT_DEFS, EXIT_STATUS } from './floorTopology.js'
import { ROUTE_CONST, RISK_LEVEL, emptyPlan } from './routeTypes.js'
import { rankPlans } from './routePlanner.js'

let pass = 0, fail = 0
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${extra !== undefined ? ' → ' + JSON.stringify(extra) : ''}`) }
}

console.log('\n=== S2-A Zone→Exit 分配契约测试 ===\n')

const BUILDING_ID = 'B003'
const graph = buildBuildingGraph(6)
const person = (id, floorId, zone) => ({ id, buildingId: BUILDING_ID, floorId, zone, status: 'normal' })
const persons = [
  ...['T501', 'T502', 'T503'].map((id) => person(id, '5F', 'A区')),
  ...['T511', 'T512'].map((id) => person(id, '5F', 'B区')),
  ...['T521', 'T522'].map((id) => person(id, '5F', 'C区')),
  person('T531', '5F', 'D区'),
]
const fire = { buildingId: BUILDING_ID, floorId: '5F', zone: 'A区' }

// ══════════════════════════════════════
// [1] pickRouteByStrategy 契约（§5.3 规则 3/4）
// ══════════════════════════════════════
console.log('\n[1] pickRouteByStrategy 契约')
const cand = (exitId, score, estimatedTime, riskLevel) => ({ exitId, score, estimatedTime, riskLevel, valid: true })

// BALANCED：负载差 >=1 走人少出口
const c1 = cand('E1', 90, 50, RISK_LEVEL.LOW)
const c2 = cand('E2', 95, 55, RISK_LEVEL.LOW)
const loadSkewed = new Map([['E1', 10], ['E2', 7]])
const picked1 = pickRouteByStrategy([c1, c2], STRATEGY.BALANCED, { exitLoad: loadSkewed })
check('BALANCED 负载差>=1 走人少出口', picked1 && picked1.exitId === 'E2', picked1)

// BALANCED：负载差<1 按 score 降序
const loadEven = new Map([['E1', 5], ['E2', 5]])
const picked2 = pickRouteByStrategy([c1, c2], STRATEGY.BALANCED, { exitLoad: loadEven })
check('BALANCED 负载差<1 按 score 降序', picked2 && picked2.exitId === 'E2', picked2)

// FASTEST：estimatedTime 最小
const pickedFast = pickRouteByStrategy([cand('E1', 90, 60, RISK_LEVEL.LOW), cand('E2', 95, 40, RISK_LEVEL.LOW)], STRATEGY.FASTEST, {})
check('FASTEST 选 estimatedTime 最小', pickedFast && pickedFast.exitId === 'E2', pickedFast)

// SAFEST：riskLevel 最低（RISK_RANK 小者优先）
const pickedSafe = pickRouteByStrategy([cand('E1', 90, 50, RISK_LEVEL.HIGH), cand('E2', 80, 50, RISK_LEVEL.LOW)], STRATEGY.SAFEST, {})
check('SAFEST 选 riskLevel 最低', pickedSafe && pickedSafe.exitId === 'E2', pickedSafe)

// 空候选返回 null
check('空候选返回 null', pickRouteByStrategy([], STRATEGY.BALANCED, {}) === null)

// ══════════════════════════════════════
// [2] 不可用出口过滤（§5.3 规则 2，§7 边界）
// ══════════════════════════════════════
console.log('\n[2] 不可用出口过滤')
const exitEClosed = EXIT_DEFS.map((e) => (e.id === 'EXIT_E' ? { ...e, status: EXIT_STATUS.CLOSED } : e))
const resClosed = planBuildingEvacuation({ buildingId: BUILDING_ID, persons, fire, strategy: STRATEGY.BALANCED, graph, exits: exitEClosed })
check('CLOSED 出口不进入分配', resClosed.plan.routes.every((r) => r.exitId !== '1F:EXIT_E'), resClosed.plan.routes.map((r) => r.exitId))

const exitEBlocked = EXIT_DEFS.map((e) => (e.id === 'EXIT_E' ? { ...e, status: EXIT_STATUS.BLOCKED } : e))
const resBlocked = planBuildingEvacuation({ buildingId: BUILDING_ID, persons, fire, strategy: STRATEGY.BALANCED, graph, exits: exitEBlocked })
check('BLOCKED 出口不进入分配', resBlocked.plan.routes.every((r) => r.exitId !== '1F:EXIT_E'), resBlocked.plan.routes.map((r) => r.exitId))

const exitEUnavail = EXIT_DEFS.map((e) => (e.id === 'EXIT_E' ? { ...e, available: false } : e))
const resUnavail = planBuildingEvacuation({ buildingId: BUILDING_ID, persons, fire, strategy: STRATEGY.BALANCED, graph, exits: exitEUnavail })
check('available=false 出口不进入分配', resUnavail.plan.routes.every((r) => r.exitId !== '1F:EXIT_E'), resUnavail.plan.routes.map((r) => r.exitId))

const allClosed = EXIT_DEFS.map((e) => ({ ...e, status: EXIT_STATUS.CLOSED }))
const resAll = planBuildingEvacuation({ buildingId: BUILDING_ID, persons, fire, strategy: STRATEGY.BALANCED, graph, exits: allClosed })
check('全出口不可用 → valid=false', resAll.plan.valid === false, resAll.plan.reasons)
check('全出口不可用 → 分配路线数为 0', resAll.plan.routes.length === 0, resAll.plan.routes.length)
check('全出口不可用 → missingZones 为全部 4 区（集合，不锁顺序）',
  resAll.missingZones.length === 4 && ['5F:A区', '5F:B区', '5F:C区', '5F:D区'].every((z) => resAll.missingZones.includes(z)),
  resAll.missingZones)

// ══════════════════════════════════════
// [3] 分配规则：每 zone 一条路线，终点 1F 出口（§5.3 规则 1）
// ══════════════════════════════════════
console.log('\n[3] 分配规则（每 zone 一条合法路线）')
const groups = groupPersonsByZone(persons, { buildingId: BUILDING_ID, graph })
const { plans, missingZonesByStrategy } = planBuildingStrategies({ buildingId: BUILDING_ID, buildingName: '3号楼', persons, fire, maxFloor: 6, graph })
check('正常场景 missingZonesByStrategy 三种策略均无缺失区域',
  [STRATEGY.BALANCED, STRATEGY.FASTEST, STRATEGY.SAFEST].every((s) => Array.isArray(missingZonesByStrategy[s]) && missingZonesByStrategy[s].length === 0),
  missingZonesByStrategy)
plans.forEach((p) => {
  check(`${p.id} 每个有人员 zone 恰好一条路线`, p.routes.length === groups.length, [p.routes.length, groups.length])
  check(`${p.id} 路线终点均为 1F 出口`, p.routes.every((r) => /^1F:EXIT_/.test(r.exitId)), p.routes.map((r) => r.exitId))
  check(`${p.id} routesByZone 覆盖全部有人员 zone`, groups.every((g) => Boolean(p.routesByZone[zoneKeyOf(g.floorId, g.zone)])), groups.filter((g) => !p.routesByZone[g.zoneKey]).map((g) => g.zoneKey))
  check(`${p.id} 全部路线 valid`, p.routes.every((r) => r.valid), p.reasons)
})

// 生产链路：BALANCED 下 exitLoad 人数累积体现在 summary.exits
const planA = plans[0]
const exitTotal = Object.values(planA.summary.exits).reduce((s, n) => s + n, 0)
check('PLAN-A 出口人数之和 = 总人数（8）', exitTotal === persons.length, planA.summary.exits)
check('PLAN-A 分摊到多个出口（≥2）', Object.keys(planA.summary.exits).length >= 2, planA.summary.exits)

// ══════════════════════════════════════
// [4] capacity=null 不施加约束（§7 边界）
// ══════════════════════════════════════
console.log('\n[4] capacity=null 不施加约束')
const bigZone = Array.from({ length: 50 }, (_, i) => person(`BIG${i}`, '5F', 'A区'))
const resCap = planBuildingEvacuation({ buildingId: BUILDING_ID, persons: bigZone, fire, strategy: STRATEGY.BALANCED, graph })
check('50 人大流量区域仍获得合法路线', resCap.plan.routes.length === 1 && resCap.plan.routes[0].valid, resCap.plan.reasons)
check('EXIT_DEFS capacity 恒为 null（未配置）', EXIT_DEFS.every((e) => e.capacity === null))

// ══════════════════════════════════════
// [5] 走廊人员经 resolvePlanningZone 归到最近房间 zone（§7 边界）
// ══════════════════════════════════════
console.log('\n[5] 走廊人员归属')
const corridorPerson = { id: 'X1', buildingId: BUILDING_ID, floorId: '5F', zone: '走廊', x: 140, y: 160 }
check('走廊人员归到最近房间 zone（A区）', resolvePlanningZone(graph, corridorPerson) === 'A区', resolvePlanningZone(graph, corridorPerson))

// ══════════════════════════════════════
// [6] 评分参数回归基线（冻结现有行为，不宣称业务认可）
// ══════════════════════════════════════
console.log('\n[6] 评分参数回归基线（冻结现有行为）')
check('EVAC_SPEED 冻结 = 1.2', ROUTE_CONST.EVAC_SPEED === 1.2, ROUTE_CONST.EVAC_SPEED)
check('STAIR_PENALTY_S 冻结 = 5', ROUTE_CONST.STAIR_PENALTY_S === 5, ROUTE_CONST.STAIR_PENALTY_S)

// estimatedTime 公式冻结：round(distance / EVAC_SPEED + floorsDescended * STAIR_PENALTY_S)
plans.forEach((p) => {
  p.routes.forEach((r) => {
    const m = /^(\d+)F/.exec(r.startNode || '')
    const startFloor = m ? parseInt(m[1], 10) : 1
    const floorsDescended = Math.max(0, startFloor - 1)
    const expected = Math.round(r.distance / ROUTE_CONST.EVAC_SPEED + floorsDescended * ROUTE_CONST.STAIR_PENALTY_S)
    check(`${p.id} ${r.floorId}-${r.zone} estimatedTime = distance/1.2 + 层数×5`, r.estimatedTime === expected, [r.estimatedTime, expected, r.distance, floorsDescended])
  })
})

// score 公式冻结（rankPlans 直接单测）：
//   score = round((risk*0.45 + normTime*0.25 + normDist*0.2 + (fireDistance>=40 ? 0.1 : 0)) * 100)
//   risk = {LOW:1, MEDIUM:0.55, HIGH:0.1}
const pa = emptyPlan({ id: 'X-A', exitId: '1F:EXIT_W', distance: 100, estimatedTime: 50, riskLevel: RISK_LEVEL.LOW, fireDistance: 50, valid: true })
const pb = emptyPlan({ id: 'Y-A', exitId: '1F:EXIT_E', distance: 200, estimatedTime: 100, riskLevel: RISK_LEVEL.HIGH, fireDistance: 10, valid: true })
const ranked = rankPlans([pa, pb])
const byExit = Object.fromEntries(ranked.map((r) => [r.exitId, r]))
// 注：理想值 78（0.775×100），但浮点累加使实际为 77。
//     此处冻结「实际输出 77」为回归基线，不宣称 77 或 78 哪个是业务认可值。
check('score 冻结：LOW 风险 + 远火(50m) → 77（浮点，理论 78）', byExit['1F:EXIT_W'] && byExit['1F:EXIT_W'].score === 77, byExit['1F:EXIT_W'] && byExit['1F:EXIT_W'].score)
check('score 冻结：HIGH 风险 + 近火(10m) → 5', byExit['1F:EXIT_E'] && byExit['1F:EXIT_E'].score === 5, byExit['1F:EXIT_E'] && byExit['1F:EXIT_E'].score)

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`)
if (fail) process.exit(1)

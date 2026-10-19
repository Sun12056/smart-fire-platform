/**
 * P1.8.2 Stage 1.1（第一批）：出口状态变化后的路线一致性 —— 共享逻辑持续回归
 * （node shared/evacuation/exitConsistency.test.mjs）
 *
 * 覆盖：
 *   · F-1：routePlans 与 routeMatrix.perZone[].plans 为**不同对象实例**时，仍按稳定 ID 同步失效
 *   · F-1：recommendedId / backupId 不指向失效路线；无可选时置 null
 *   · F-1：routeMatrix.exits 仅保留可用出口
 *   · F-12：状态模型区分「已失效待重规划 / 重规划失败 / 确认无可行路线 / 验证后发布」
 *   · F-2：重复 / 非法 / 部分 / 缺失 / 完整输入下，isExitUsable 与 usableExitNodeIds 口径一致
 *   · F-12：异步旧结果（代次不一致）不得覆盖新状态
 *   · N1：出口过滤与标识归一化口径一致（nodeId / key / id 三种合法形式）
 *   · N2：失效判定（A 层）与可用性判定（B 层）的语义边界
 *   · N3：PLAN_STATUS.DONE 的契约（终态已完成 ⇒ 不属于"当前可用路线"）
 *
 * ⚠️ 范围声明（不得夸大）：
 *   本文件仅验证 **shared 层纯函数** 的一致性语义。
 *   它**不能**证明浏览器 / Worker / Durable Object 中的端到端重规划闭环，
 *   也不能证明 person.routeId / routePoints 的实际一致性 —— 那些需第二批授权后验证。
 */
import {
  normalizeExitStates, usableExitNodeIds,
  applyExitInvalidation, routesAffectedByExits, exitDiff,
  pickSafeRecommendations, filterExitNodeIds, isRouteUsable,
  shouldInvalidateByExits, USABLE_ROUTE_STATUSES,
  PLANNING_STATUS, PLANNING_EVENT, nextPlanningState, nextPlanningGeneration,
  shouldApplyReplanResult,
  // N1 补充修复新增的两个「唯一解析入口」
  resolveRouteExitNodeId, toUsableNodeIdSet,
} from './exitRuntime.js'
import { EXIT_DEFS, EXIT_STATUS, isExitUsable, EXIT_NODE_IDS } from './floorTopology.js'

let pass = 0, fail = 0
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${extra !== undefined ? ' → ' + JSON.stringify(extra) : ''}`) }
}

const EXIT_W = EXIT_DEFS.find((e) => e.key === 'EXIT_W').nodeId
const EXIT_E = EXIT_DEFS.find((e) => e.key === 'EXIT_E').nodeId

console.log('\n=== P1.8.2 Stage 1.1 · 出口变化后路线一致性（共享逻辑纯内存回归）===\n')

// ══════════════════════════════════════
// 测试夹具：复刻 fireStore.js:2864 与 :2877 的同构结构
// routePlans 与 perZone[].plans 是**两次独立构造**，同 id 但不同对象引用
// ══════════════════════════════════════
const ROUTES = [
  { id: 'PLAN-A:5F:A区', routeId: 'PLAN-A:5F:A区', zone: 'A区', floorId: '5F', exit: EXIT_W },
  { id: 'PLAN-A:5F:C区', routeId: 'PLAN-A:5F:C区', zone: 'C区', floorId: '5F', exit: EXIT_E },
  { id: 'PLAN-A:3F:B区', routeId: 'PLAN-A:3F:B区', zone: 'B区', floorId: '3F', exit: EXIT_W },
]

function makeProjections(routes) {
  // 实例组 A（对应 fireStore.js:2864）
  const routePlans = routes.map((r) => ({ ...r, status: 'NORMAL' }))
  // 实例组 B（对应 fireStore.js:2877，不同引用）
  const perZone = {}
  routes.forEach((r) => {
    if (!perZone[r.zone]) perZone[r.zone] = { plans: [], recommendedId: null, backupId: null }
    perZone[r.zone].plans.push({ ...r, status: 'NORMAL' })
    perZone[r.zone].recommendedId = perZone[r.zone].plans[0].id
    perZone[r.zone].backupId = perZone[r.zone].plans[1] ? perZone[r.zone].plans[1].id : null
  })
  return { routePlans, perZone }
}

// ══════════════════════════════════════
// 生产同构夹具（F-E 核心场景）：三套整栋楼策略 × 三个区域
//   · routePlans      —— 仅含 **active 方案**     （对应 fireStore.js:2864）
//   · perZone[].plans —— 含 **A/B/C 全部方案**    （对应 fireStore.js:2875-2878）
// ⇒ B / C 方案的路线 id **永远不在 routePlans 中**。修复前 perZone 仅按
//   「routePlans 派生的受影响 id 集合」标记，它们即便途经已关闭出口也漏标。
// ══════════════════════════════════════
const PLANS = ['PLAN-A', 'PLAN-B', 'PLAN-C']
const ACTIVE_PLAN = 'PLAN-A'
const PLAN_EXIT_OF = {
  'PLAN-A': { 'A区': EXIT_W, 'B区': EXIT_W, 'C区': EXIT_E },
  'PLAN-B': { 'A区': EXIT_W, 'B区': EXIT_E, 'C区': EXIT_E },
  'PLAN-C': { 'A区': EXIT_E, 'B区': EXIT_W, 'C区': EXIT_W },
}
const ZONES = [
  { zone: 'A区', floorId: '5F' },
  { zone: 'B区', floorId: '3F' },
  { zone: 'C区', floorId: '5F' },
]

/** 与 fireStore 同构：两个投影各自独立构造（同 id，对象引用不同） */
function makeMultiPlanProjections({ activePlan = ACTIVE_PLAN } = {}) {
  const build = (bp, z) => ({
    id: bp + ':' + z.floorId + ':' + z.zone,
    routeId: bp + ':' + z.floorId + ':' + z.zone,
    zone: z.zone,
    floorId: z.floorId,
    exit: PLAN_EXIT_OF[bp][z.zone],
    buildingPlanId: bp,
    status: 'NORMAL',
  })
  const routePlans = ZONES.map((z) => build(activePlan, z))
  const perZone = {}
  ZONES.forEach((z) => {
    const candidates = PLANS.map((bp) => build(bp, z))
    const rec = candidates.find((p) => p.buildingPlanId === activePlan) || candidates[0] || null
    perZone[z.zone] = {
      plans: candidates,
      recommendedId: rec ? rec.id : null,
      backupId: candidates[1] ? candidates[1].id : null,
    }
  })
  return { routePlans, perZone }
}

const closeExit = (nodeId) => EXIT_DEFS.map((e) => (
  e.nodeId === nodeId ? { ...e, available: false, status: EXIT_STATUS.CLOSED } : { ...e }
))

const statusById = (list, id) => (list.find((p) => p.id === id) || {}).status

// ══════════════════════════════════════
console.log('[1] 前置条件：夹具与 fireStore 生产结构同构')
console.log('    routePlans ← :2864（仅 active 方案）；perZone[].plans ← :2875-2878（全部方案）')
// ══════════════════════════════════════
const base0 = makeMultiPlanProjections()
check('routePlans 仅含 active 方案（PLAN-A）',
  base0.routePlans.length === ZONES.length
  && base0.routePlans.every((p) => p.buildingPlanId === ACTIVE_PLAN))
check('perZone[zone].plans 含 A/B/C 全部方案',
  ZONES.every((z) => base0.perZone[z.zone].plans.length === PLANS.length))
check('B / C 方案路线不在 routePlans 中（F-E 触发前提）',
  !base0.routePlans.some((p) => p.buildingPlanId === 'PLAN-B')
  && !base0.routePlans.some((p) => p.buildingPlanId === 'PLAN-C'))
check('两个投影为不同对象实例（被测函数必须跨越此差异）',
  base0.routePlans[0] !== base0.perZone['A区'].plans[0])
check('同 id 可跨投影关联（稳定 ID 可用作关联键）',
  base0.routePlans[0].id === base0.perZone['A区'].plans[0].id)

// ══════════════════════════════════════
console.log('\n[2] F-1：出口关闭 → 所有兼容投影按 ID 同步失效')
// ══════════════════════════════════════
const proj = makeProjections(ROUTES)
const closedState = normalizeExitStates(closeExit(EXIT_E))
check('归一化后 EXIT_E 不可用', !closedState.usableNodeIds.includes(EXIT_E), closedState.usableNodeIds)

const out = applyExitInvalidation({
  routePlans: proj.routePlans,
  perZone: proj.perZone,
  exits: closedState.exits,
  usableNodeIds: closedState.usableNodeIds,
})
check('受影响路线（走 EXIT_E）被标记 BLOCKED',
  statusById(out.routePlans, 'PLAN-A:5F:C区') === 'BLOCKED')
check('未受影响路线（走 EXIT_W）保持 NORMAL',
  statusById(out.routePlans, 'PLAN-A:5F:A区') === 'NORMAL'
  && statusById(out.routePlans, 'PLAN-A:3F:B区') === 'NORMAL')
check('受影响 id 列表正确',
  out.affectedRouteIds.length === 1 && out.affectedRouteIds[0] === 'PLAN-A:5F:C区',
  out.affectedRouteIds)
check('perZone[C区].plans 按 id 同步为 BLOCKED（跨不同实例）',
  statusById(out.perZone['C区'].plans, 'PLAN-A:5F:C区') === 'BLOCKED')
check('perZone[A区] / perZone[B区] 保持 NORMAL',
  statusById(out.perZone['A区'].plans, 'PLAN-A:5F:A区') === 'NORMAL'
  && statusById(out.perZone['B区'].plans, 'PLAN-A:3F:B区') === 'NORMAL')

// ══════════════════════════════════════════════════════════════
console.log('\n[3] F-1：推荐 / 备用不指向失效路线')
// ══════════════════════════════════════════════════════════════
check('原推荐指向 EXIT_E 的 C区 → recommendedId 置 null',
  out.perZone['C区'].recommendedId === null, out.perZone['C区'].recommendedId)
check('A区推荐仍保留（走 EXIT_W）',
  out.perZone['A区'].recommendedId === 'PLAN-A:5F:A区', out.perZone['A区'].recommendedId)
check('pickSafeRecommendations 仅从可用出口中选',
  pickSafeRecommendations([
    { id: 'r-w', exit: EXIT_W, status: 'NORMAL' },
    { id: 'r-e', exit: EXIT_E, status: 'NORMAL' },
  ], [EXIT_W]).recommendedId === 'r-w')
check('pickSafeRecommendations 排除已 BLOCKED 的候选',
  pickSafeRecommendations([
    { id: 'r-w', exit: EXIT_W, status: 'BLOCKED' },
    { id: 'r-e', exit: EXIT_E, status: 'NORMAL' },
  ], [EXIT_W, EXIT_E]).recommendedId === 'r-e')

// ══════════════════════════════════════════════════════════════════
console.log('\n[4] F-1：routeMatrix.exits 仅保留可用出口')
// ══════════════════════════════════════════════════════════════════
check('过滤后出口列表不含 EXIT_E',
  out.exits.length === 1 && out.exits[0].nodeId === EXIT_W, out.exits.map((e) => e.nodeId))
check('exitNodeIds 同样过滤（默认全集）',
  out.exitNodeIds.length === 1 && out.exitNodeIds[0] === EXIT_W, out.exitNodeIds)
check('filterExitNodeIds 对空可用集返回空数组',
  filterExitNodeIds(EXIT_NODE_IDS, []).length === 0)
check('全出口可用时过滤不丢项',
  filterExitNodeIds(EXIT_NODE_IDS, EXIT_NODE_IDS).length === EXIT_NODE_IDS.length)

// ══════════════════════════════════════
console.log('\n[5] F-12：无可行路线 → 明确状态，旧路线不复活')
// ══════════════════════════════════════
const allClosed = normalizeExitStates(EXIT_DEFS.map((e) => ({ ...e, status: EXIT_STATUS.CLOSED })))
const outAll = applyExitInvalidation({
  routePlans: makeProjections(ROUTES).routePlans,
  perZone: makeProjections(ROUTES).perZone,
  exits: allClosed.exits,
  usableNodeIds: allClosed.usableNodeIds,
})
check('全出口不可用 → 全部路线 BLOCKED',
  outAll.routePlans.every((p) => p.status === 'BLOCKED'), outAll.routePlans.map((p) => p.status))
check('全出口不可用 → blockedAll=true', outAll.blockedAll === true)
check('全出口不可用 → 所有区域的 recommendedId / backupId 为 null',
  Object.values(outAll.perZone).every((info) => info.recommendedId === null && info.backupId === null))
check('全出口不可用 → 出口列表为空', outAll.exits.length === 0 && outAll.exitNodeIds.length === 0)

// ══════════════════════════════════════
console.log('\n[6] F-12：出口恢复 → 已失效旧路线不自动复活')
// ══════════════════════════════════════
const reopened = normalizeExitStates(EXIT_DEFS)
const diff = exitDiff(closedState.exits, reopened.exits)
check('exitDiff 识别 EXIT_E 重新可用', diff.changed === true && diff.openedNodeIds.includes(EXIT_E),
  [diff.closedNodeIds, diff.openedNodeIds])
check('exitDiff 反向识别 EXIT_E 被关闭',
  exitDiff(reopened.exits, closedState.exits).closedNodeIds.includes(EXIT_E))
check('exitDiff 无变化时 changed=false',
  exitDiff(reopened.exits, EXIT_DEFS).changed === false)

const outReopen = applyExitInvalidation({
  routePlans: out.routePlans,     // 上一轮已失效的投影
  perZone: out.perZone,
  exits: reopened.exits,
  usableNodeIds: reopened.usableNodeIds,
})
check('出口恢复后，上一轮失效的旧路线仍为 BLOCKED（不自动复活）',
  statusById(outReopen.routePlans, 'PLAN-A:5F:C区') === 'BLOCKED')
check('出口恢复后，推荐 / 备用仍不指向该失效路线',
  outReopen.perZone['C区'].recommendedId === null && outReopen.perZone['C区'].backupId === null)
check('失效判定幂等：重复应用不改变结果',
  JSON.stringify(applyExitInvalidation({
    routePlans: out.routePlans, perZone: out.perZone,
    exits: closedState.exits, usableNodeIds: closedState.usableNodeIds,
  }).routePlans) === JSON.stringify(out.routePlans))

// ══════════════════════════════════════
console.log('\n[7] F-2：重复 / 非法 / 部分 / 缺失 / 完整 的安全语义一致')
// ══════════════════════════════════════
const dupA = normalizeExitStates([
  { nodeId: EXIT_W, available: false, status: EXIT_STATUS.CLOSED },
  { nodeId: EXIT_W, available: true, status: EXIT_STATUS.OPEN },
])
check('重复 [CLOSED, OPEN] → isExitUsable=false',
  isExitUsable(EXIT_W, dupA.exits) === false)
check('重复 [CLOSED, OPEN] → usableExitNodeIds 同样排除（口径一致）',
  !usableExitNodeIds(dupA.exits).includes(EXIT_W), usableExitNodeIds(dupA.exits))
check('duplicate 标志置位', dupA.duplicate === true)

const dupB = normalizeExitStates([
  { nodeId: EXIT_W, available: true, status: EXIT_STATUS.OPEN },
  { nodeId: EXIT_W, available: false, status: EXIT_STATUS.CLOSED },
])
check('重复 [OPEN, CLOSED] → 同样不可用（与顺序无关，非 last-wins）',
  isExitUsable(EXIT_W, dupB.exits) === false
  && !usableExitNodeIds(dupB.exits).includes(EXIT_W))

const unknownEntry = normalizeExitStates([
  { nodeId: EXIT_W, available: false, status: EXIT_STATUS.CLOSED },
  { id: '1F:EXIT_ZZZ', available: false, status: EXIT_STATUS.CLOSED },
])
check('含未知条目 → unknown=true 并记录原始 id（不再静默丢弃）',
  unknownEntry.unknown === true && unknownEntry.unknownRawIds.includes('1F:EXIT_ZZZ'),
  unknownEntry.unknownRawIds)
check('未知条目不影响其余出口的解析',
  unknownEntry.exits.find((e) => e.nodeId === EXIT_W).status === EXIT_STATUS.CLOSED)

const partialState = normalizeExitStates([{ nodeId: EXIT_E, available: false, status: EXIT_STATUS.CLOSED }])
check('部分下发 → reason=partial；未列出的 EXIT_W 静态可用（覆盖语义保留）',
  partialState.reason === 'partial'
  && partialState.usableNodeIds.includes(EXIT_W)
  && !partialState.usableNodeIds.includes(EXIT_E))

// ══════════════════════════════════════
console.log('\n[8] F-2：已关闭出口不被静态默认值重新判为可用（核心回归）')
// ══════════════════════════════════════
const keyForm = normalizeExitStates([{ id: 'EXIT_W', available: false, status: EXIT_STATUS.CLOSED }])
check('key/id 形式下发的关闭状态被保留（修复前被静默丢弃 → 回落 OPEN）',
  keyForm.exits.find((e) => e.nodeId === EXIT_W).available === false
  && keyForm.exits.find((e) => e.nodeId === EXIT_W).status === EXIT_STATUS.CLOSED,
  keyForm.exits.find((e) => e.nodeId === EXIT_W))
check('该出口不在可用列表中',
  !keyForm.usableNodeIds.includes(EXIT_W), keyForm.usableNodeIds)
check('isExitUsable 与 usableExitNodeIds 在 key/id 形式下口径一致',
  isExitUsable(EXIT_W, keyForm.exits) === keyForm.usableNodeIds.includes(EXIT_W))

check('三种不可用形态在完整数组下均判为不可用',
  [EXIT_STATUS.CLOSED, EXIT_STATUS.BLOCKED].every((st) => (
    isExitUsable(EXIT_E, EXIT_DEFS.map((e) => (e.nodeId === EXIT_E ? { ...e, status: st } : e))) === false
  ))
  && isExitUsable(EXIT_E, withExitAvailFalse()) === false)

function withExitAvailFalse() {
  return EXIT_DEFS.map((e) => (e.nodeId === EXIT_E ? { ...e, available: false } : e))
}

// ══════════════════════════════════════
console.log('\n[9] F-12：异步旧结果不得覆盖新状态')
// ══════════════════════════════════════
check('代次一致 → 允许应用',
  shouldApplyReplanResult(7, 7) === true)
check('代次不一致（旧结果） → 拒绝应用',
  shouldApplyReplanResult(8, 7) === false)
check('非法代次（NaN / undefined） → 拒绝应用',
  shouldApplyReplanResult(NaN, 7) === false
  && shouldApplyReplanResult(undefined, 7) === false
  && shouldApplyReplanResult(7, null) === false)

// ══════════════════════════════════════
console.log('\n[10] F-12：状态模型 —— 禁止伪造未发生的重规划结果')
// ══════════════════════════════════════
const S = PLANNING_STATUS
const E = PLANNING_EVENT
check('出口变化 ∅→ INVALIDATED', nextPlanningState(S.NONE, E.EXIT_CHANGED) === S.INVALIDATED)
check('出口变化 OK→ INVALIDATED', nextPlanningState(S.OK, E.EXIT_CHANGED) === S.INVALIDATED)
check('INVALIDATED 可进入 REPLANNING', nextPlanningState(S.INVALIDATED, E.REPLAN_STARTED) === S.REPLANNING)
check('REPLANNING 成功 → OK', nextPlanningState(S.REPLANNING, E.REPLAN_SUCCEEDED) === S.OK)
check('REPLANNING 失败 → FAILED', nextPlanningState(S.REPLANNING, E.REPLAN_FAILED) === S.FAILED)
check('REPLANNING 无可行路线 → NO_FEASIBLE_ROUTE',
  nextPlanningState(S.REPLANNING, E.NO_FEASIBLE_ROUTE) === S.NO_FEASIBLE_ROUTE)
check('⚠️ 出口变化不得直接产生 FAILED（模型层面禁止伪造）',
  nextPlanningState(S.NONE, E.EXIT_CHANGED) !== S.FAILED
  && nextPlanningState(S.INVALIDATED, E.EXIT_CHANGED) !== S.FAILED
  && nextPlanningState(S.OK, E.EXIT_CHANGED) !== S.FAILED)
check('⚠️ 出口变化不得直接产生 NO_FEASIBLE_ROUTE（模型层面禁止伪造）',
  nextPlanningState(S.NONE, E.EXIT_CHANGED) !== S.NO_FEASIBLE_ROUTE
  && nextPlanningState(S.INVALIDATED, E.EXIT_CHANGED) !== S.NO_FEASIBLE_ROUTE)
check('FAILED 后可重试进入 REPLANNING', nextPlanningState(S.FAILED, E.REPLAN_STARTED) === S.REPLANNING)
check('新的出口变化可覆盖陈旧失败态 → INVALIDATED',
  nextPlanningState(S.FAILED, E.EXIT_CHANGED) === S.INVALIDATED
  && nextPlanningState(S.NO_FEASIBLE_ROUTE, E.EXIT_CHANGED) === S.INVALIDATED)
check('任意状态 + reset → NONE',
  [S.NONE, S.OK, S.INVALIDATED, S.REPLANNING, S.FAILED, S.NO_FEASIBLE_ROUTE]
    .every((s) => nextPlanningState(s, E.RESET) === S.NONE))
check('非法事件 → null（调用方须拒绝并保持原状态）',
  nextPlanningState(S.INVALIDATED, 'not_an_event') === null
  && nextPlanningState('BOGUS_STATE', E.EXIT_CHANGED) === null)

// ══════════════════════════════════════
console.log('\n[11] F-12：出口差异检测驱动失效判定（端到端共享口径）')
// ══════════════════════════════════════
const before = normalizeExitStates(EXIT_DEFS)
const after = normalizeExitStates(closeExit(EXIT_E))
const d = exitDiff(before.exits, after.exits)
check('EXIT_E 进入 closedNodeIds', d.closedNodeIds.includes(EXIT_E), d.closedNodeIds)
check('EXIT_W 不在 closedNodeIds', !d.closedNodeIds.includes(EXIT_W))
check('指纹变化 → changed=true', d.changed === true)
const affected = routesAffectedByExits(ROUTES, d.closedNodeIds)
check('受影响路线经 exitDiff 推导正确',
  affected.length === 1 && affected[0] === 'PLAN-A:5F:C区', affected)
check('无关闭出口时受影响列表为空', routesAffectedByExits(ROUTES, []).length === 0)

// ══════════════════════════════════════
console.log('\n[12] F-E 回归：perZone 中「不在 routePlans 内的方案路线」同样被标记失效')
console.log('     场景：同一 zone 存在 A/B/C 多方案，routePlans 只含 active 方案')
// ══════════════════════════════════════
const mp = makeMultiPlanProjections()
const closedE = normalizeExitStates(closeExit(EXIT_E))
const outMp = applyExitInvalidation({
  routePlans: mp.routePlans,
  perZone: mp.perZone,
  exits: closedE.exits,
  usableNodeIds: closedE.usableNodeIds,
})
const st = (zone, id) => statusById(outMp.perZone[zone].plans, id)
check('⚠️ B 方案中走 EXIT_E 的 B区路线被标记 BLOCKED（修复前漏标）',
  st('B区', 'PLAN-B:3F:B区') === 'BLOCKED',
  outMp.perZone['B区'].plans.map((p) => p.id + ':' + p.status))
check('⚠️ C 方案中走 EXIT_E 的 A区路线被标记 BLOCKED（修复前漏标）',
  st('A区', 'PLAN-C:5F:A区') === 'BLOCKED',
  outMp.perZone['A区'].plans.map((p) => p.id + ':' + p.status))
check('⚠️ B 方案中走 EXIT_E 的 C区路线被标记 BLOCKED（修复前漏标）',
  st('C区', 'PLAN-B:5F:C区') === 'BLOCKED')
check('受影响 id 汇总去重，覆盖两个投影',
  ['PLAN-A:5F:C区', 'PLAN-B:5F:C区', 'PLAN-B:3F:B区', 'PLAN-C:5F:A区']
    .every((id) => outMp.affectedRouteIds.includes(id))
  && new Set(outMp.affectedRouteIds).size === outMp.affectedRouteIds.length,
  outMp.affectedRouteIds)
check('走 EXIT_W 的路线（含 B/C 方案）全部保持 NORMAL',
  st('A区', 'PLAN-A:5F:A区') === 'NORMAL'
  && st('A区', 'PLAN-B:5F:A区') === 'NORMAL'
  && st('B区', 'PLAN-A:3F:B区') === 'NORMAL'
  && st('B区', 'PLAN-C:3F:B区') === 'NORMAL'
  && st('C区', 'PLAN-C:5F:C区') === 'NORMAL')
check('perZone 各区推荐均不指向失效路线',
  ZONES.every((z) => {
    const info = outMp.perZone[z.zone]
    if (info.recommendedId === null) return true
    const p = info.plans.find((x) => x.id === info.recommendedId)
    return Boolean(p) && p.status !== 'BLOCKED'
  }))

// ══════════════════════════════════════
console.log('\n[13] 推荐与备用同时失效 → 一律置 null')
// ══════════════════════════════════════
const bothStalePlans = [
  { id: 's:1', exit: EXIT_E, status: 'NORMAL' },
  { id: 's:2', exit: EXIT_E, status: 'NORMAL' },
]
const outBoth = applyExitInvalidation({
  routePlans: bothStalePlans.map((p) => ({ ...p })),
  perZone: {
    'S区': { plans: bothStalePlans.map((p) => ({ ...p })), recommendedId: 's:1', backupId: 's:2' },
  },
  exits: closedE.exits,
  usableNodeIds: closedE.usableNodeIds,
})
check('两条候选均经已关闭出口 → 全部 BLOCKED',
  outBoth.routePlans.every((p) => p.status === 'BLOCKED'), outBoth.routePlans.map((p) => p.status))
check('recommendedId 置 null', outBoth.perZone['S区'].recommendedId === null, outBoth.perZone['S区'].recommendedId)
check('backupId 置 null', outBoth.perZone['S区'].backupId === null, outBoth.perZone['S区'].backupId)

// ══════════════════════════════════════
console.log('\n[14] F-D：当前选中路线失效后的重选（保留 fireStore.js:314-316 行为）')
// ══════════════════════════════════════
const selPlans = [
  { id: 'k:1', exit: EXIT_E, status: 'NORMAL' },
  { id: 'k:2', exit: EXIT_W, status: 'NORMAL' },
  { id: 'k:3', exit: EXIT_W, status: 'NORMAL' },
]
const outSel = applyExitInvalidation({
  routePlans: selPlans.map((p) => ({ ...p })),
  perZone: {
    'K区': { plans: selPlans.map((p) => ({ ...p })), recommendedId: 'k:1', backupId: 'k:2' },
  },
  exits: closedE.exits,
  usableNodeIds: closedE.usableNodeIds,
  activeRoutePlanId: 'k:1',
})
check('原选中走已关闭出口 → 改选第一条仍可用路线',
  outSel.activeRoutePlanId === 'k:2', outSel.activeRoutePlanId)
check('改选结果不指向失效路线', outSel.activeRoutePlanId !== 'k:1')
check('推荐同步为 k:2，备用为 k:3',
  outSel.perZone['K区'].recommendedId === 'k:2'
  && outSel.perZone['K区'].backupId === 'k:3')

const noAltPlans = [{ id: 'n:1', exit: EXIT_E, status: 'NORMAL' }]
const outNoAlt = applyExitInvalidation({
  routePlans: noAltPlans.map((p) => ({ ...p })),
  perZone: {
    'N区': { plans: noAltPlans.map((p) => ({ ...p })), recommendedId: 'n:1', backupId: null },
  },
  exits: closedE.exits,
  usableNodeIds: closedE.usableNodeIds,
  activeRoutePlanId: 'n:1',
})
check('⚠️ 原选中失效且无替代 → 返回 null（绝不回退失效路线）',
  outNoAlt.activeRoutePlanId === null, outNoAlt.activeRoutePlanId)
check('推荐与备用同时为 null',
  outNoAlt.perZone['N区'].recommendedId === null
  && outNoAlt.perZone['N区'].backupId === null)

const keepPlans = [
  { id: 'g:1', exit: EXIT_W, status: 'NORMAL' },
  { id: 'g:2', exit: EXIT_W, status: 'NORMAL' },
]
const outKeep = applyExitInvalidation({
  routePlans: keepPlans.map((p) => ({ ...p })),
  perZone: {
    'G区': { plans: keepPlans.map((p) => ({ ...p })), recommendedId: 'g:1', backupId: 'g:2' },
  },
  exits: closedE.exits,
  usableNodeIds: closedE.usableNodeIds,
  activeRoutePlanId: 'g:1',
})
check('原选中仍可用 → 保持不变', outKeep.activeRoutePlanId === 'g:1', outKeep.activeRoutePlanId)

// ══════════════════════════════════════
console.log('\n[15] S-A 回归：REPLANNING 期间再次发生 exit_changed')
console.log('     迁移语义：在途结果所依据的出口状态已过期 ⇒ 回到 INVALIDATED，')
console.log('     并由 nextPlanningGeneration 递增代次使在途结果无法提交。')
// ══════════════════════════════════════
check('REPLANNING + exit_changed → INVALIDATED（出口变化不被静默忽略）',
  nextPlanningState(S.REPLANNING, E.EXIT_CHANGED) === S.INVALIDATED)
check('该迁移不得直接产出 FAILED',
  nextPlanningState(S.REPLANNING, E.EXIT_CHANGED) !== S.FAILED)
check('该迁移不得直接产出 NO_FEASIBLE_ROUTE（不得伪造未发生的重规划结果）',
  nextPlanningState(S.REPLANNING, E.EXIT_CHANGED) !== S.NO_FEASIBLE_ROUTE)
check('回到 INVALIDATED 后可再次进入 REPLANNING',
  nextPlanningState(S.INVALIDATED, E.REPLAN_STARTED) === S.REPLANNING)
check('exit_changed 递增代次 ⇒ 在途结果作废',
  nextPlanningGeneration(5, E.EXIT_CHANGED) === 6)
check('replan_started 递增代次 ⇒ 旧请求作废',
  nextPlanningGeneration(5, E.REPLAN_STARTED) === 6)
check('成功 / 失败 / 无可行路线 / 重置不改变代次',
  nextPlanningGeneration(5, E.REPLAN_SUCCEEDED) === 5
  && nextPlanningGeneration(5, E.REPLAN_FAILED) === 5
  && nextPlanningGeneration(5, E.NO_FEASIBLE_ROUTE) === 5
  && nextPlanningGeneration(5, E.RESET) === 5)

// ══════════════════════════════════════
console.log('\n[16] 状态迁移 × 代次校验 的配套语义（端到端）')
console.log('     ① 发起请求递增代次 ② 出口变化递增代次 ③ 提交前校验代次')
// ══════════════════════════════════════
let liveGen = 0
liveGen = nextPlanningGeneration(liveGen, E.REPLAN_STARTED)
const inFlightGen = liveGen
let liveState = nextPlanningState(S.NONE, E.REPLAN_STARTED)
check('① 发起请求后进入 REPLANNING', liveState === S.REPLANNING, liveState)
liveState = nextPlanningState(liveState, E.EXIT_CHANGED)
liveGen = nextPlanningGeneration(liveGen, E.EXIT_CHANGED)
check('② 出口变化后回到 INVALIDATED', liveState === S.INVALIDATED, liveState)
check('③ 基于旧出口状态的在途结果被拒绝',
  shouldApplyReplanResult(liveGen, inFlightGen) === false)
const retryGen = nextPlanningGeneration(liveGen, E.REPLAN_STARTED)
check('③ 新一轮请求的结果可提交',
  shouldApplyReplanResult(retryGen, retryGen) === true)
check('③ 陈旧结果即便晚到也不会覆盖新代次',
  shouldApplyReplanResult(retryGen, inFlightGen) === false)

const reopenedFull = normalizeExitStates(EXIT_DEFS)
const outReopen2 = applyExitInvalidation({
  routePlans: out.routePlans,
  perZone: out.perZone,
  exits: reopenedFull.exits,
  usableNodeIds: reopenedFull.usableNodeIds,
  activeRoutePlanId: 'PLAN-A:5F:C区',
})
check('⚠️ 出口恢复后旧路线仍为 BLOCKED（不自动复活）',
  statusById(outReopen2.routePlans, 'PLAN-A:5F:C区') === 'BLOCKED')
check('⚠️ 出口恢复后不会选回已失效的旧路线（改选其他仍可用路线）',
  outReopen2.activeRoutePlanId !== 'PLAN-A:5F:C区'
  && outReopen2.activeRoutePlanId === 'PLAN-A:5F:A区', outReopen2.activeRoutePlanId)
check('出口恢复后 exits 列表恢复完整',
  outReopen2.exits.length === EXIT_DEFS.length)

// ══════════════════════════════════════
console.log('\n[17] N1 回归（投影级）：三种标识形式下 exits 与 exitNodeIds 一致')
console.log('     修复前：applyExitInvalidation 直读原始 e.nodeId || e.id，')
console.log('     与 resolveExitKey 的三种合法形式不一致 ⇒ key/id 形式整条被筛掉，')
console.log('     出现「exitNodeIds 非空而 exits 为空」的同对象内部矛盾')
// ══════════════════════════════════════
const N1_BASE = closeExit(EXIT_E)
const N1_FORMS = {
  nodeId: N1_BASE.map((e) => ({ nodeId: e.nodeId, available: e.available, status: e.status })),
  id: N1_BASE.map((e) => ({ id: e.id, available: e.available, status: e.status })),
  key: N1_BASE.map((e) => ({ key: e.key, available: e.available, status: e.status })),
}
Object.entries(N1_FORMS).forEach(([form, list]) => {
  const o = applyExitInvalidation({
    routePlans: [], perZone: {}, exits: list, usableNodeIds: [EXIT_W],
  })
  const ids = o.exits.map((e) => e.nodeId)
  check(`⚠️ [${form} 形式] exits 与 exitNodeIds 一致（修复前 key/id 形式 exits 为空）`,
    JSON.stringify(ids) === JSON.stringify(o.exitNodeIds), [ids, o.exitNodeIds])
  check(`[${form} 形式] 仅保留可用出口 EXIT_W`, ids.length === 1 && ids[0] === EXIT_W, ids)
  check(`[${form} 形式] 已关闭 EXIT_E 被剔除`, !ids.includes(EXIT_E), ids)
  check(`[${form} 形式] 输出已规范化（nodeId = 1F:key 且 id === key）`,
    o.exits.every((e) => e.nodeId === '1F:' + e.key && e.id === e.key))
})

// ⚠️ N1 关键回归：未知出口标识不得被静默转换为已知出口
//   normalizeExitStates 丢弃未知条目后，其余已知出口按**既有契约**回填静态默认（OPEN），
//   故投影中不该出现由 EXIT_ZZZ 派生的条目，只会出现真实的已知出口。
const N1_UNKNOWN_NORM = normalizeExitStates([
  { key: 'EXIT_ZZZ', available: true, status: EXIT_STATUS.OPEN },
])
const N1_UNKNOWN = applyExitInvalidation({
  routePlans: [], perZone: {},
  exits: N1_UNKNOWN_NORM.exits,
  usableNodeIds: N1_UNKNOWN_NORM.usableNodeIds,
})
const N1_KNOWN = EXIT_DEFS.map((e) => e.nodeId)
check('⚠️ 未知出口标识被标记 unknown 并保留原始 id（修复前静默丢弃）',
  N1_UNKNOWN_NORM.unknown === true
  && N1_UNKNOWN_NORM.unknownRawIds.includes('EXIT_ZZZ'),
  N1_UNKNOWN_NORM.unknownRawIds)
check('⚠️ 未知出口标识未被静默转换为已知出口（投影仅含真实已知出口）',
  N1_UNKNOWN.exits.length > 0
  && N1_UNKNOWN.exits.every((e) => N1_KNOWN.includes(e.nodeId)),
  N1_UNKNOWN.exits.map((e) => e.nodeId))
check('⚠️ 含未知条目时 exits 与 exitNodeIds 仍一致（无同对象内部矛盾）',
  JSON.stringify(N1_UNKNOWN.exits.map((e) => e.nodeId))
  === JSON.stringify(N1_UNKNOWN.exitNodeIds),
  [N1_UNKNOWN.exits.map((e) => e.nodeId), N1_UNKNOWN.exitNodeIds])

// 重复且状态矛盾 ⇒ 保守合并（任一不可用 ⇒ 不可用），且投影随之剔除
const N1_DUP_NORM = normalizeExitStates([
  { nodeId: EXIT_W, available: false, status: EXIT_STATUS.CLOSED },
  { nodeId: EXIT_W, available: true, status: EXIT_STATUS.OPEN },
])
const N1_DUP = applyExitInvalidation({
  routePlans: [], perZone: {},
  exits: N1_DUP_NORM.exits,
  usableNodeIds: N1_DUP_NORM.usableNodeIds,
})
check('⚠️ 重复矛盾 [CLOSED, OPEN] → duplicate 置位', N1_DUP_NORM.duplicate === true)
check('⚠️ 重复矛盾 [CLOSED, OPEN] → 该出口不在可用列表',
  !N1_DUP_NORM.usableNodeIds.includes(EXIT_W), N1_DUP_NORM.usableNodeIds)
check('⚠️ 重复矛盾 [CLOSED, OPEN] → exits 投影剔除该出口',
  N1_DUP.exits.every((e) => e.nodeId !== EXIT_W), N1_DUP.exits.map((e) => e.nodeId))

// ══════════════════════════════════════
console.log('\n[18] N2 语义边界（投影级）：失效 vs 可用 —— 表驱动 + 无矛盾不变式')
console.log('     A层 = shouldInvalidateByExits：路线本身是否还成立（成立 ⇒ 保持原状态）')
console.log('     B层 = isRouteUsable：能否作为当前选中 / 推荐 / 备用路线')
console.log('     不变式 I1：指针（推荐 / 备用 / 当前选中）不得指向最终 BLOCKED 的路线')
console.log('     不变式 I2：同一 id 在两个投影中的最终状态必须一致')
console.log('     不变式 I3：affectedRouteIds == 两投影中 BLOCKED 路线 id 的去重并集')
// ══════════════════════════════════════
const N2_EXITS = closeExit(EXIT_E)
const N2_OPEN_EXITS = EXIT_DEFS.map((e) => ({ ...e, available: true, status: EXIT_STATUS.OPEN }))
const N2_U = [EXIT_W]

/** 收集两个投影中每条路线的最终状态（按 id 索引，同时保留全部副本用于冲突检测） */
function projectionStatusList(out) {
  const map = new Map()
  const push = (p) => {
    if (!p || p.id === undefined || p.id === null) return
    const id = String(p.id)
    if (!map.has(id)) map.set(id, [])
    map.get(id).push(p.status)
  }
  const plans = out.routePlans || []
  plans.forEach(push)
  const zones = out.perZone || {}
  Object.values(zones).forEach((info) => {
    const list = (info && info.plans) || []
    list.forEach(push)
  })
  return map
}

/** 返回全部矛盾项（空数组 ⇒ 各投影一致） */
function contradictionsOf(out) {
  const bad = []
  const statusList = projectionStatusList(out)
  // I2：同一 id 在两个投影中的最终状态必须一致
  statusList.forEach((statuses, id) => {
    const uniq = [...new Set(statuses)]
    if (uniq.length > 1) bad.push(`跨投影状态冲突 id=${id} → ${uniq.join('/')}`)
  })
  // I1：指针不得指向最终 BLOCKED 的路线
  const ptrs = []
  Object.entries(out.perZone || {}).forEach(([z, info]) => {
    if (info.recommendedId !== null && info.recommendedId !== undefined) {
      ptrs.push([`recommendedId(${z})`, info.recommendedId])
    }
    if (info.backupId !== null && info.backupId !== undefined) {
      ptrs.push([`backupId(${z})`, info.backupId])
    }
  })
  if (out.activeRoutePlanId !== null && out.activeRoutePlanId !== undefined) {
    ptrs.push(['activeRoutePlanId', out.activeRoutePlanId])
  }
  ptrs.forEach(([label, id]) => {
    const list = statusList.get(String(id))
    if (list && list.includes('BLOCKED')) bad.push(`${label} 指向已失效路线 ${id}`)
  })
  // I3：affectedRouteIds == BLOCKED id 并集
  const blocked = new Set()
  const plans2 = out.routePlans || []
  plans2.forEach((p) => { if (p && p.status === 'BLOCKED' && p.id) blocked.add(String(p.id)) })
  Object.values(out.perZone || {}).forEach((info) => {
    const list = (info && info.plans) || []
    list.forEach((p) => { if (p && p.status === 'BLOCKED' && p.id) blocked.add(String(p.id)) })
  })
  const a = [...blocked].sort()
  const b = [...new Set((out.affectedRouteIds || []).map(String))].sort()
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    bad.push(`affectedRouteIds(${b.join(',')}) ≠ BLOCKED 集合(${a.join(',')})`)
  }
  return bad
}

/**
 * 状态 × 出口 矩阵（前提：EXIT_W 可用、EXIT_E 关闭）
 *   [名称, 路线, A层失效?, B层可用?, 协调后最终 status, 期望 recommendedId, 期望 activeRoutePlanId]
 *
 * 说明：A 层与 B 层**唯一刻意的差异**是 DONE —— A 层不失效（终态保护），
 *       B 层不可用（已完成路线不能再作为"现在要走的路"）。
 */
const N2_MATRIX = [
  ['NORMAL    / 走可用出口', { id: 'p-nw', exit: EXIT_W, status: 'NORMAL' }, false, true, 'NORMAL', 'p-nw', 'p-nw'],
  ['WARNING   / 走可用出口', { id: 'p-ww', exit: EXIT_W, status: 'WARNING' }, false, true, 'WARNING', 'p-ww', 'p-ww'],
  ['CONFIRMED / 走可用出口', { id: 'p-cw', exit: EXIT_W, status: 'CONFIRMED' }, false, true, 'CONFIRMED', 'p-cw', 'p-cw'],
  ['EXECUTING / 走可用出口', { id: 'p-ew', exit: EXIT_W, status: 'EXECUTING' }, false, true, 'EXECUTING', 'p-ew', 'p-ew'],
  ['NORMAL    / 出口OPEN→CLOSED', { id: 'p-ne', exit: EXIT_E, status: 'NORMAL' }, true, false, 'BLOCKED', null, null],
  ['WARNING   / 出口OPEN→CLOSED', { id: 'p-we', exit: EXIT_E, status: 'WARNING' }, true, false, 'BLOCKED', null, null],
  ['EXECUTING / 出口OPEN→CLOSED', { id: 'p-ee', exit: EXIT_E, status: 'EXECUTING' }, true, false, 'BLOCKED', null, null],
  ['BLOCKED   / 出口仍可用（幂等）', { id: 'p-bw', exit: EXIT_W, status: 'BLOCKED' }, true, false, 'BLOCKED', null, null],
  ['BLOCKED   / 出口已关闭（幂等）', { id: 'p-be', exit: EXIT_E, status: 'BLOCKED' }, true, false, 'BLOCKED', null, null],
  ['DONE      / 出口仍可用（终态保护）', { id: 'p-dw', exit: EXIT_W, status: 'DONE' }, false, false, 'DONE', null, null],
  ['DONE      / 出口已关闭（终态保护）', { id: 'p-de', exit: EXIT_E, status: 'DONE' }, false, false, 'DONE', null, null],
  ['INVALIDATED / 出口可用（未知⇒保守）', { id: 'p-iv', exit: EXIT_W, status: 'INVALIDATED' }, true, false, 'BLOCKED', null, null],
  ['FAILED    / 出口可用（未知⇒保守）', { id: 'p-fl', exit: EXIT_W, status: 'FAILED' }, true, false, 'BLOCKED', null, null],
  ['未知状态  / 出口可用（保守）', { id: 'p-uk', exit: EXIT_W, status: 'WEIRD' }, true, false, 'BLOCKED', null, null],
  ['缺失状态  / 出口可用（保守）', { id: 'p-ns', exit: EXIT_W }, true, false, 'BLOCKED', null, null],
  ['缺失 exit / NORMAL（保守）', { id: 'p-nx', status: 'NORMAL' }, true, false, 'BLOCKED', null, null],
  ['空串出口标识 / NORMAL（保守）', { id: 'p-es', exit: '', status: 'NORMAL' }, true, false, 'BLOCKED', null, null],
  ['未知出口标识 / NORMAL（保守）', { id: 'p-ue', exit: '1F:EXIT_ZZZ', status: 'NORMAL' }, true, false, 'BLOCKED', null, null],
]

/** 用「生产同构」方式构造：routePlans 与 perZone 各自独立构造（同 id，不同引用） */
function applyMatrixCase(route) {
  return applyExitInvalidation({
    routePlans: [{ ...route }],
    perZone: { 'M区': { plans: [{ ...route }], recommendedId: route.id, backupId: null } },
    exits: N2_EXITS,
    usableNodeIds: N2_U,
    activeRoutePlanId: route.id,
  })
}

N2_MATRIX.forEach(([label, route, expectInvalidate, expectUsable, expectStatus, expectRec, expectActive]) => {
  const a = shouldInvalidateByExits({ ...route }, N2_U)
  const b = isRouteUsable({ ...route }, N2_U)
  check(`A层 ${label} → 失效=${expectInvalidate}`, a === expectInvalidate, a)
  check(`B层 ${label} → 可用=${expectUsable}`, b === expectUsable, b)
  const o = applyMatrixCase(route)
  const finalStatus = o.routePlans[0].status
  check(`⚠️ 投影 ${label} → routePlans.status=${expectStatus}`, finalStatus === expectStatus, finalStatus)
  check(`⚠️ 投影 ${label} → perZone 状态与 routePlans 一致`,
    o.perZone['M区'].plans[0].status === finalStatus, o.perZone['M区'].plans[0].status)
  check(`⚠️ 投影 ${label} → recommendedId=${expectRec}`,
    o.perZone['M区'].recommendedId === expectRec, o.perZone['M区'].recommendedId)
  check(`⚠️ 投影 ${label} → activeRoutePlanId=${expectActive}`,
    o.activeRoutePlanId === expectActive, o.activeRoutePlanId)
  const bad = contradictionsOf(o)
  check(`⚠️ 不变式 ${label} → 各投影无矛盾`, bad.length === 0, bad)
})

// ══════════════════════════════════════
console.log('\n[19] N1 补充修复（投影级）：裸 key / 裸 id 形式下的跨投影一致性')
console.log('     ★ 原始缺陷复现：exit="EXIT_W" + usableNodeIds=["1F:EXIT_W"]')
console.log('     校验：routePlans / perZone / exits / exitNodeIds / 推荐 / 选中 无矛盾')
// ══════════════════════════════════════
// ⚠️ 三种形式一律**从真实 EXIT_DEFS 读取**，不得写成相同常量后声称覆盖三种格式
//    （第二次独立复审 P3-3：原实现把「裸 id」写成与「裸 key」完全相同的 'EXIT_W'，
//     该组用例退化为重复样例；一旦 id 与 key 分离，硬编码用例将无法发现失效）。
const D_W2 = EXIT_DEFS.find((e) => e.key === 'EXIT_W')
const D_E2 = EXIT_DEFS.find((e) => e.key === 'EXIT_E')
const BARE_W = D_W2.key          // 裸 key 形式
const BARE_E = D_E2.key
const BARE_ID_W = D_W2.id        // 裸 id 形式
const BARE_ID_E = D_E2.id

const mkProjection = (route, usableNodeIds) => applyExitInvalidation({
  routePlans: [{ ...route }],
  perZone: { 'P区': { plans: [{ ...route }], recommendedId: route.id, backupId: null } },
  exits: N2_EXITS,
  usableNodeIds,
  activeRoutePlanId: route.id,
})

// ── 19.1 ★ 原始缺陷的投影级复现 ──
const reproP = mkProjection({ id: 'r1', exit: BARE_W, status: 'NORMAL' }, [EXIT_W])
check('⚠️ [原始缺陷] 裸 key 路线 → routePlans.status 保持 NORMAL',
  reproP.routePlans[0].status === 'NORMAL', reproP.routePlans[0].status)
check('⚠️ [原始缺陷] 裸 key 路线 → recommendedId 不为 null（修复前为 null）',
  reproP.perZone['P区'].recommendedId === 'r1', reproP.perZone['P区'].recommendedId)
check('⚠️ [原始缺陷] 裸 key 路线 → activeRoutePlanId 不为 null（修复前为 null）',
  reproP.activeRoutePlanId === 'r1', reproP.activeRoutePlanId)
check('⚠️ [原始缺陷] 裸 key 路线 → exits 与 exitNodeIds 一致',
  JSON.stringify(reproP.exits.map((e) => e.nodeId)) === JSON.stringify(reproP.exitNodeIds),
  [reproP.exits.map((e) => e.nodeId), reproP.exitNodeIds])
check('⚠️ [原始缺陷] 裸 key 路线 → 各投影无矛盾',
  contradictionsOf(reproP).length === 0, contradictionsOf(reproP))

// ── 19.2 三种标识形式 × 三种集合形式：跨投影一致性 ──
;[
  ['规范 nodeId', EXIT_W, EXIT_E],
  ['裸 key', BARE_W, BARE_E],
  ['裸 id', BARE_ID_W, BARE_ID_E],
].forEach(([formLabel, idOpen, idClosed]) => {
  ;[
    ['nodeId 集', [EXIT_W]],
    ['key 集', [BARE_W]],
    ['混合集', [EXIT_W, BARE_W]],
  ].forEach(([setLabel, set]) => {
    // (a) 走可用出口 ⇒ 保持原状态、可推荐、可选中
    const oOpen = mkProjection({ id: 'o1', exit: idOpen, status: 'NORMAL' }, set)
    check(`⚠️ ${formLabel} × ${setLabel} / 可用出口 → status 保持 NORMAL`,
      oOpen.routePlans[0].status === 'NORMAL', oOpen.routePlans[0].status)
    check(`⚠️ ${formLabel} × ${setLabel} / 可用出口 → recommendedId 命中`,
      oOpen.perZone['P区'].recommendedId === 'o1', oOpen.perZone['P区'].recommendedId)
    check(`⚠️ ${formLabel} × ${setLabel} / 可用出口 → activeRoutePlanId 保持`,
      oOpen.activeRoutePlanId === 'o1', oOpen.activeRoutePlanId)
    check(`⚠️ ${formLabel} × ${setLabel} / 可用出口 → 各投影无矛盾`,
      contradictionsOf(oOpen).length === 0, contradictionsOf(oOpen))
    // (b) 走已关闭出口 ⇒ BLOCKED、不推荐、不选回
    const oClosed = mkProjection({ id: 'o2', exit: idClosed, status: 'NORMAL' }, set)
    check(`⚠️ ${formLabel} × ${setLabel} / 已关闭出口 → status 置 BLOCKED`,
      oClosed.routePlans[0].status === 'BLOCKED', oClosed.routePlans[0].status)
    check(`⚠️ ${formLabel} × ${setLabel} / 已关闭出口 → recommendedId 置 null`,
      oClosed.perZone['P区'].recommendedId === null, oClosed.perZone['P区'].recommendedId)
    check(`⚠️ ${formLabel} × ${setLabel} / 已关闭出口 → activeRoutePlanId 置 null`,
      oClosed.activeRoutePlanId === null, oClosed.activeRoutePlanId)
    check(`⚠️ ${formLabel} × ${setLabel} / 已关闭出口 → 各投影无矛盾`,
      contradictionsOf(oClosed).length === 0, contradictionsOf(oClosed))
  })
})

// ── 19.3 出口恢复：已失效路线不复活（裸形式同样适用）──
const recP = mkProjection({ id: 'q1', exit: BARE_E, status: 'NORMAL' }, [EXIT_W])
check('⚠️ 裸 key 路线走已关闭出口 → BLOCKED',
  recP.routePlans[0].status === 'BLOCKED', recP.routePlans[0].status)
const recPBack = applyExitInvalidation({
  routePlans: recP.routePlans,
  perZone: recP.perZone,
  exits: N2_EXITS,
  usableNodeIds: [EXIT_W, EXIT_E],
  activeRoutePlanId: 'q1',
})
check('⚠️ 出口恢复后已失效路线不自动复活（仍 BLOCKED）',
  recPBack.routePlans[0].status === 'BLOCKED', recPBack.routePlans[0].status)
check('⚠️ 出口恢复后仍不被推荐',
  recPBack.perZone['P区'].recommendedId === null, recPBack.perZone['P区'].recommendedId)

// ── 19.4 DONE 在裸形式下保持完成状态、不被删除、不参与推荐 ──
;[[BARE_W, '可用出口'], [BARE_E, '已关闭出口']].forEach(([exitId, desc]) => {
  const doneP = mkProjection({ id: 's1', exit: exitId, status: 'DONE' }, [EXIT_W])
  check(`⚠️ 裸形式 / DONE / ${desc} → status 保持 DONE（未被改写为 BLOCKED）`,
    doneP.routePlans[0].status === 'DONE', doneP.routePlans[0].status)
  check(`⚠️ 裸形式 / DONE / ${desc} → perZone 同样保持 DONE`,
    doneP.perZone['P区'].plans[0].status === 'DONE', doneP.perZone['P区'].plans[0].status)
  check(`⚠️ 裸形式 / DONE / ${desc} → 不被推荐（recommendedId 置 null）`,
    doneP.perZone['P区'].recommendedId === null, doneP.perZone['P区'].recommendedId)
  check(`⚠️ 裸形式 / DONE / ${desc} → 路线未被删除（数组长度保持）`,
    doneP.routePlans.length === 1, doneP.routePlans.length)
  check(`⚠️ 裸形式 / DONE / ${desc} → DONE 与 BLOCKED 未合并（不进入 affectedRouteIds）`,
    doneP.routePlans[0].status !== 'BLOCKED' && doneP.affectedRouteIds.length === 0,
    doneP.affectedRouteIds)
})

// ── 19.5 公共解析入口的投影级一致性 ──
check('⚠️ resolveRouteExitNodeId：裸 key → 规范 nodeId',
  resolveRouteExitNodeId({ exit: BARE_W }) === EXIT_W,
  resolveRouteExitNodeId({ exit: BARE_W }))
check('⚠️ resolveRouteExitNodeId：未知标识 → null（不静默猜测）',
  resolveRouteExitNodeId({ exit: 'EXIT_ZZZ' }) === null,
  resolveRouteExitNodeId({ exit: 'EXIT_ZZZ' }))
check('⚠️ toUsableNodeIdSet：裸 key 集 → 规范 nodeId 集',
  toUsableNodeIdSet([BARE_W]).has(EXIT_W), [...toUsableNodeIdSet([BARE_W])])
check('⚠️ toUsableNodeIdSet：不把未知标识静默猜测为已知出口',
  !toUsableNodeIdSet(['EXIT_ZZZ']).has(EXIT_W) && !toUsableNodeIdSet(['EXIT_ZZZ']).has(EXIT_E),
  [...toUsableNodeIdSet(['EXIT_ZZZ'])])
check('⚠️ filterExitNodeIds：裸 key 集入参正确命中',
  JSON.stringify(filterExitNodeIds(EXIT_NODE_IDS, [BARE_W])) === JSON.stringify([EXIT_W]),
  filterExitNodeIds(EXIT_NODE_IDS, [BARE_W]))
check('⚠️ routesAffectedByExits：裸 key 路线可被识别为受影响',
  JSON.stringify(routesAffectedByExits([{ id: 't1', exit: BARE_E }], [EXIT_E]))
    === JSON.stringify(['t1']),
  routesAffectedByExits([{ id: 't1', exit: BARE_E }], [EXIT_E]))

// ══════════════════════════════════════
console.log('\n[20] 第三批补充修复（投影级）：blockAll×DONE / 降级可见 / 输出同源 / 冲突暴露')
console.log('     P2-1: blockAll 不得绕过 DONE 终态保护（三种情形）')
console.log('     P2-2: exitNodeIds 与 exits 同源；冲突仅暴露，不裁定优先级')
console.log('     P2-3: exitStates 透出降级信息')
console.log('     P3  : 三种形式取自真实 EXIT_DEFS，投影级一致')
// ══════════════════════════════════════
const OPEN_EXITS = EXIT_DEFS.map((e) => ({ ...e, available: true, status: EXIT_STATUS.OPEN }))
// 东出口关闭、西出口可用
const E_CLOSED = EXIT_DEFS.map((e) => ({
  ...e, available: e.nodeId === EXIT_W,
  status: e.nodeId === EXIT_W ? EXIT_STATUS.OPEN : EXIT_STATUS.CLOSED,
}))
// 与上者相反：西出口关闭、东出口可用（用于「两入参矛盾」场景）
const W_CLOSED = EXIT_DEFS.map((e) => ({
  ...e, available: e.nodeId === EXIT_E,
  status: e.nodeId === EXIT_E ? EXIT_STATUS.OPEN : EXIT_STATUS.CLOSED,
}))

// ── 20.1 P2-1：blockAll 三种情形下 DONE 在两个投影中均保持 DONE ──
;[
  ['usableNodeIds=[]（自动 blockAll）', { usableNodeIds: [] }],
  ['显式 blockAll=true', { usableNodeIds: [EXIT_W], blockAll: true }],
  ['普通出口变化（非 blockAll）', { usableNodeIds: [EXIT_W] }],
].forEach(([label, extra]) => {
  const donePlan = { id: 'bd1', exit: EXIT_E, status: 'DONE' }
  const normalPlan = { id: 'bn1', exit: EXIT_E, status: 'NORMAL' }
  const out = applyExitInvalidation({
    routePlans: [{ ...donePlan }, { ...normalPlan }],
    perZone: {
      'B区': {
        plans: [{ ...donePlan }, { ...normalPlan }],
        recommendedId: 'bd1', backupId: null,
      },
    },
    exits: E_CLOSED,
    activeRoutePlanId: 'bd1',
    ...extra,
  })
  check(`⚠️ P2-1 ${label} → routePlans 中 DONE 保持 DONE`,
    out.routePlans[0].status === 'DONE', out.routePlans[0].status)
  check(`⚠️ P2-1 ${label} → perZone 中 DONE 同样保持（两投影一致）`,
    out.perZone['B区'].plans[0].status === out.routePlans[0].status,
    out.perZone['B区'].plans[0].status)
  check(`⚠️ P2-1 ${label} → DONE 不进入 affectedRouteIds`,
    !out.affectedRouteIds.includes('bd1'), out.affectedRouteIds)
  check(`⚠️ P2-1 ${label} → DONE 记录未被删除（两投影长度均保持 2）`,
    out.routePlans.length === 2 && out.perZone['B区'].plans.length === 2,
    [out.routePlans.length, out.perZone['B区'].plans.length])
  check(`⚠️ P2-1 ${label} → DONE 不被推荐 / 不被选中`,
    out.perZone['B区'].recommendedId !== 'bd1' && out.activeRoutePlanId !== 'bd1',
    { rec: out.perZone['B区'].recommendedId, active: out.activeRoutePlanId })
  check(`⚠️ P2-1 ${label} → 非 DONE 路线仍按既有逻辑 BLOCKED（未误伤）`,
    out.routePlans[1].status === 'BLOCKED', out.routePlans[1].status)
  check(`⚠️ P2-1 ${label} → 各投影无矛盾`,
    contradictionsOf(out).length === 0, contradictionsOf(out))
})

// ── 20.2 P2-3：降级信息可见（投影级）──
const noExitsP = applyExitInvalidation({ usableNodeIds: [EXIT_W] })
check('⚠️ P2-3 不传 exits → exitStates.degraded=true / reason=missing（修复前被丢弃）',
  noExitsP.exitStates.degraded === true && noExitsP.exitStates.reason === 'missing',
  noExitsP.exitStates)
const fullP = applyExitInvalidation({ exits: OPEN_EXITS, usableNodeIds: [EXIT_W] })
check('⚠️ P2-3 完整一致 → exitStates.degraded=false / reason=null',
  fullP.exitStates.degraded === false && fullP.exitStates.reason === null, fullP.exitStates)
check('⚠️ P2-3 降级透出不改变投影结果本身（exits 与 exitNodeIds 仍一致）',
  JSON.stringify(fullP.exits.map((e) => e.nodeId)) === JSON.stringify(fullP.exitNodeIds),
  [fullP.exits.map((e) => e.nodeId), fullP.exitNodeIds])

// ── 20.3 P2-2：两输出同源 + 冲突暴露 ──
const sameP = applyExitInvalidation({ exits: OPEN_EXITS, usableNodeIds: [EXIT_W, EXIT_E] })
check('⚠️ P2-2 未传 exitNodeIds → exitNodeIds 恒等于 exits 的 nodeId 列表（同源）',
  JSON.stringify(sameP.exitNodeIds) === JSON.stringify(sameP.exits.map((e) => e.nodeId)),
  [sameP.exitNodeIds, sameP.exits.map((e) => e.nodeId)])
const narrowP = applyExitInvalidation({
  exits: OPEN_EXITS, usableNodeIds: [EXIT_W, EXIT_E], exitNodeIds: [EXIT_W],
})
check('⚠️ P2-2 传入部分 exitNodeIds → 恒为 exits 子集（不再是独立候选池）',
  narrowP.exitNodeIds.length === 1 && narrowP.exitNodeIds[0] === EXIT_W
  && narrowP.exits.length === 2,
  [narrowP.exitNodeIds, narrowP.exits.map((e) => e.nodeId)])
// ★ 该项在修复**前**会失败：修复前 exitNodeIds = filter(input.exitNodeIds, usable)，
//   未知名 id 只要同时出现在两个入参中就会被**原样输出**，形成「假可用出口」。
const unknownIdP = applyExitInvalidation({
  exits: OPEN_EXITS, usableNodeIds: [EXIT_W, 'EXIT_ZZZ'], exitNodeIds: [EXIT_W, 'EXIT_ZZZ'],
})
check('⚠️ P2-2 未知名出口 id 同时出现在两个入参 → exitNodeIds 不得输出它（修复前原样输出）',
  !unknownIdP.exitNodeIds.includes('EXIT_ZZZ'), unknownIdP.exitNodeIds)
const agreeP = applyExitInvalidation({ exits: E_CLOSED, usableNodeIds: [EXIT_W] })
check('⚠️ P2-2 两入参一致 → exitsConflict 为空', agreeP.exitsConflict.length === 0, agreeP.exitsConflict)
const disagreeP = applyExitInvalidation({ exits: W_CLOSED, usableNodeIds: [EXIT_W] })
check('⚠️ P2-2 两入参矛盾 → exitsConflict 为**双向对称差**',
  disagreeP.exitsConflict.includes(EXIT_W) && disagreeP.exitsConflict.includes(EXIT_E),
  disagreeP.exitsConflict)
// 【第四批 · D1 已批准】冲突时按**保守取交集**处置（行为**已变更**）。
check('⚠️ P2-2 D1 已批准：冲突时保守取交集 ⇒ 无共同可用出口 ⇒ 整批失效',
  disagreeP.blockedAll === true
  && JSON.stringify(disagreeP.exits) === JSON.stringify([])
  && JSON.stringify(disagreeP.exitNodeIds) === JSON.stringify([]),
  { blockedAll: disagreeP.blockedAll, exits: disagreeP.exits, exitNodeIds: disagreeP.exitNodeIds })

// ── 20.4 P3：三种形式在投影级均一致（取自真实 EXIT_DEFS）──
check('⚠️ P3 规范 nodeId 与 裸 key 是不同字符串（否则多形式用例退化为重复样例）',
  EXIT_W !== BARE_W, { EXIT_W, BARE_W })
;[[EXIT_W, '规范 nodeId'], [BARE_W, '裸 key'], [BARE_ID_W, '裸 id']].forEach(([exitId, label]) => {
  check(`⚠️ P3 ${label} → 解析为规范 nodeId`,
    resolveRouteExitNodeId({ exit: exitId }) === EXIT_W, resolveRouteExitNodeId({ exit: exitId }))
  const p = applyExitInvalidation({
    routePlans: [{ id: 'p1', exit: exitId, status: 'NORMAL' }],
    perZone: {
      'P区': {
        plans: [{ id: 'p1', exit: exitId, status: 'NORMAL' }],
        recommendedId: 'p1', backupId: null,
      },
    },
    exits: E_CLOSED,
    usableNodeIds: [EXIT_W],
    activeRoutePlanId: 'p1',
  })
  check(`⚠️ P3 ${label} / 可用出口 → 保持 NORMAL 且被推荐 / 选中`,
    p.routePlans[0].status === 'NORMAL' && p.perZone['P区'].recommendedId === 'p1'
    && p.activeRoutePlanId === 'p1',
    { st: p.routePlans[0].status, rec: p.perZone['P区'].recommendedId, active: p.activeRoutePlanId })
  check(`⚠️ P3 ${label} / 可用出口 → 各投影无矛盾`,
    contradictionsOf(p).length === 0, contradictionsOf(p))
})

// ══════════════════════════════════════
console.log('\n[22] 第四批（G-2）：输入组合全覆盖矩阵（投影级）')
console.log('     T1 仅 exits｜T3 两者一致｜T4 冲突｜T5 两者均缺失｜T7a 部分缺失')
console.log('     D1 保守取交集（已批准）｜D2 partial 不算冲突（已批准）')
// ══════════════════════════════════════
const projPlans = () => [
  { id: 'pw', exit: EXIT_W, status: 'NORMAL' },
  { id: 'pe', exit: EXIT_E, status: 'NORMAL' },
  { id: 'pd', exit: EXIT_E, status: 'DONE' },
]
const zoneOf = (plans) => ({
  'G区': { plans, recommendedId: 'pw', backupId: null },
})
const runMatrix = (label, input) => {
  const plans = projPlans()
  const out = applyExitInvalidation({
    routePlans: plans,
    perZone: zoneOf(plans.map((p) => ({ ...p }))),
    ...input,
  })
  console.log(`\n  ── ${label} ──`)
  console.log('     exits        =', JSON.stringify(out.exits.map((e) => e.nodeId + ':' + e.status)))
  console.log('     exitNodeIds  =', JSON.stringify(out.exitNodeIds))
  console.log('     affected     =', JSON.stringify(out.affectedRouteIds))
  console.log('     blockedAll   =', out.blockedAll, '| active =', out.activeRoutePlanId)
  console.log('     exitStates   =', JSON.stringify(out.exitStates))
  console.log('     exitsConflict=', JSON.stringify(out.exitsConflict))
  return out
}

// T1 仅提供 exits（D4 已批准 ⇒ 由 exits 派生 usable）
const mT1 = runMatrix('T1 仅提供 exits（全 OPEN）', { exits: OPEN_EXITS })
check('⚠️ G-2 T1 投影级 → exits 输出全部出口（修复前 []）',
  JSON.stringify(mT1.exits.map((e) => e.nodeId)) === JSON.stringify([EXIT_W, EXIT_E]),
  mT1.exits.map((e) => e.nodeId))
check('⚠️ G-2 T1 投影级 → exitNodeIds 与 exits 同源',
  JSON.stringify(mT1.exitNodeIds) === JSON.stringify(mT1.exits.map((e) => e.nodeId)),
  [mT1.exitNodeIds, mT1.exits.map((e) => e.nodeId)])
check('⚠️ G-2 T1 投影级 → blockedAll=false（修复前 true）',
  mT1.blockedAll === false, mT1.blockedAll)
check('⚠️ G-2 T1 投影级 → 各投影无矛盾',
  contradictionsOf(mT1).length === 0, contradictionsOf(mT1))

// T3 两者一致
const mT3 = runMatrix('T3 两者一致（E 关闭，usable=[W]）', { exits: E_CLOSED, usableNodeIds: [EXIT_W] })
check('⚠️ G-2 T3 投影级 → exitsConflict 为空',
  mT3.exitsConflict.length === 0, mT3.exitsConflict)
check('⚠️ G-2 T3 投影级 → 各投影无矛盾',
  contradictionsOf(mT3).length === 0, contradictionsOf(mT3))

// T4 两者冲突（D1 已批准 ⇒ 保守取交集 ⇒ 无共同可用出口 ⇒ 整批失效）
const mT4 = runMatrix('T4 两者冲突（W 关闭，usable=[W]）', { exits: W_CLOSED, usableNodeIds: [EXIT_W] })
check('⚠️ G-2 T4 投影级 → exitsConflict 为双向对称差',
  mT4.exitsConflict.includes(EXIT_W) && mT4.exitsConflict.includes(EXIT_E),
  mT4.exitsConflict)
check('⚠️ G-2 T4 投影级 → D1 保守取交集 ⇒ blockedAll=true',
  mT4.blockedAll === true, mT4.blockedAll)
check('⚠️ G-2 T4 投影级 → DONE 仍保持 DONE 且不进 affected',
  mT4.routePlans[2].status === 'DONE' && !mT4.affectedRouteIds.includes('pd'),
  mT4.routePlans[2].status)
check('⚠️ G-2 T4 投影级 → 各投影无矛盾',
  contradictionsOf(mT4).length === 0, contradictionsOf(mT4))

// T5 两者均缺失 ⇒ fail-closed
const mT5 = runMatrix('T5 两者均缺失', {})
check('⚠️ G-2 T5 投影级 → blockedAll=true（fail-closed 保持）',
  mT5.blockedAll === true, mT5.blockedAll)
check('⚠️ G-2 T5 投影级 → exits 与 exitNodeIds 同源（均空）',
  JSON.stringify(mT5.exits) === JSON.stringify([])
  && JSON.stringify(mT5.exitNodeIds) === JSON.stringify([]), mT5.exits)
check('⚠️ G-2 T5 投影级 → 降级可见 reason=missing',
  mT5.exitStates.degraded === true && mT5.exitStates.reason === 'missing',
  mT5.exitStates)
check('⚠️ G-2 T5 投影级 → 各投影无矛盾',
  contradictionsOf(mT5).length === 0, contradictionsOf(mT5))

// T7a 部分缺失（D2 已批准 ⇒ partial 不算冲突）
const mT7 = runMatrix('T7a 部分下发（仅 W）', {
  exits: [{ ...D_W2, available: true, status: EXIT_STATUS.OPEN }],
  usableNodeIds: [EXIT_W],
})
check('⚠️ G-2 T7a 投影级 → degraded=true / reason=partial',
  mT7.exitStates.degraded === true && mT7.exitStates.reason === 'partial',
  mT7.exitStates)
check('⚠️ G-2 T7a 投影级 → D2 已批准：partial 不算入参冲突 ⇒ exitsConflict=[]',
  JSON.stringify(mT7.exitsConflict) === JSON.stringify([]), mT7.exitsConflict)
check('⚠️ G-2 T7a 投影级 → 各投影无矛盾',
  contradictionsOf(mT7).length === 0, contradictionsOf(mT7))

// ══════════════════════════════════════
console.log('\n[23] P1-1：exits 派生守卫（投影级）—— 完全无效输入 ⇒ fail-closed')
console.log('     守卫由 exitsIn.length > 0 收紧为 norm.reason ∉ {missing, invalid}')
// ══════════════════════════════════════

// ── A. 完全无效输入：三个投影必须同时 fail-closed 且互不矛盾 ──
const P1_INVALID_P = [
  ['对象结构非法 [{foo:1}]', [{ foo: 1 }]],
  ['未知 nodeId [{nodeId:ZZZ}]', [{ nodeId: '1F:EXIT_ZZZ', available: true, status: EXIT_STATUS.OPEN }]],
  ['混合标量 [null,"x",42]', [null, 'x', 42]],
]
P1_INVALID_P.forEach(([label, exits]) => {
  const o = runMatrix('P1-1 ' + label, { exits })
  check('⚠️ P1-1 ' + label + ' 投影级 → blockedAll=true（修复前 false ⇒ fail-open）',
    o.blockedAll === true, o.blockedAll)
  check('⚠️ P1-1 ' + label + ' 投影级 → 非 DONE 路线全失效',
    JSON.stringify(o.affectedRouteIds) === JSON.stringify(['pw', 'pe']), o.affectedRouteIds)
  check('⚠️ P1-1 ' + label + ' 投影级 → exits / exitNodeIds 同源且均为空',
    JSON.stringify(o.exits) === JSON.stringify([]) && JSON.stringify(o.exitNodeIds) === JSON.stringify([]),
    [o.exits.map((e) => e.nodeId), o.exitNodeIds])
  check('⚠️ P1-1 ' + label + ' 投影级 → DONE 不进 affected、不被推荐/备用/选中',
    o.routePlans[2].status === 'DONE'
    && !o.affectedRouteIds.includes('pd')
    && o.perZone['G区'].recommendedId !== 'pd'
    && o.perZone['G区'].backupId !== 'pd'
    && o.activeRoutePlanId !== 'pd',
    [o.routePlans[2].status, o.perZone['G区'].recommendedId, o.perZone['G区'].backupId, o.activeRoutePlanId])
  check('⚠️ P1-1 ' + label + ' 投影级 → 各投影无矛盾',
    contradictionsOf(o).length === 0, contradictionsOf(o))
})

// ── B. 混合输入：部分有效不得一律判为无效 ──
const mMixP = runMatrix('P1-1 混合（垃圾 + W OPEN）', {
  exits: [{ foo: 1 }, { nodeId: EXIT_W, available: true, status: EXIT_STATUS.OPEN }],
})
check('⚠️ P1-1 混合 投影级 → reason=partial，不判为 invalid',
  mMixP.exitStates.reason === 'partial', mMixP.exitStates)
check('⚠️ P1-1 混合 投影级 → 已上报且有效的出口路线保持 NORMAL',
  mMixP.routePlans[0].status === 'NORMAL', mMixP.routePlans[0].status)
check('⚠️ P1-1 混合 投影级 → 各投影无矛盾',
  contradictionsOf(mMixP).length === 0, contradictionsOf(mMixP))

// ── B4. 【P2-1 策略 B · 已批准】未上报出口一律不可用（投影级）──
check('⚠️ P2-1 B 混合 投影级 → 未上报的 E 不进入 exits / exitNodeIds（仅 [W]）',
  JSON.stringify(mMixP.exits.map((e) => e.nodeId)) === JSON.stringify([EXIT_W])
  && JSON.stringify(mMixP.exitNodeIds) === JSON.stringify([EXIT_W]),
  [mMixP.exits.map((e) => e.nodeId), mMixP.exitNodeIds])
check('⚠️ P2-1 B 混合 投影级 → 未上报出口的路线在两投影中一致失效',
  JSON.stringify(mMixP.affectedRouteIds) === JSON.stringify(['pe']), mMixP.affectedRouteIds)

const mBMixClosed = runMatrix('P2-1 B 混合（垃圾 + W CLOSED）', {
  exits: [{ foo: 1 }, { nodeId: EXIT_W, available: false, status: EXIT_STATUS.CLOSED }],
})
check('⚠️ P2-1 B 混合关闭 投影级 → 派生集为空 ⇒ 非 DONE 全失效',
  JSON.stringify(mBMixClosed.affectedRouteIds) === JSON.stringify(['pw', 'pe']),
  mBMixClosed.affectedRouteIds)
check('⚠️ P2-1 B 混合关闭 投影级 → exits / exitNodeIds 均为空',
  JSON.stringify(mBMixClosed.exits) === JSON.stringify([])
  && JSON.stringify(mBMixClosed.exitNodeIds) === JSON.stringify([]),
  [mBMixClosed.exits.map((e) => e.nodeId), mBMixClosed.exitNodeIds])
check('⚠️ P2-1 B 混合关闭 投影级 → DONE 保持 DONE 且不进 affected',
  mBMixClosed.routePlans[2].status === 'DONE'
  && !mBMixClosed.affectedRouteIds.includes('pd'),
  [mBMixClosed.routePlans[2].status, mBMixClosed.affectedRouteIds])
check('⚠️ P2-1 B 混合关闭 投影级 → 各投影无矛盾',
  contradictionsOf(mBMixClosed).length === 0, contradictionsOf(mBMixClosed))

const mBDup = runMatrix('P2-1 B 重复（W OPEN + W CLOSED）', {
  exits: [
    { nodeId: EXIT_W, available: true, status: EXIT_STATUS.OPEN },
    { nodeId: EXIT_W, available: false, status: EXIT_STATUS.CLOSED },
  ],
})
check('⚠️ P2-1 B 重复 投影级 → reason=duplicate（仍算已上报，不判 invalid）',
  mBDup.exitStates.reason === 'duplicate' && mBDup.exitStates.duplicate === true,
  mBDup.exitStates)
check('⚠️ P2-1 B 重复 投影级 → 保守合并 ⇒ W 不可用；E 未上报 ⇒ 全失效',
  JSON.stringify(mBDup.affectedRouteIds) === JSON.stringify(['pw', 'pe']), mBDup.affectedRouteIds)
check('⚠️ P2-1 B 重复 投影级 → DONE 不被推荐 / 备用 / 选中',
  mBDup.perZone['G区'].recommendedId !== 'pd'
  && mBDup.perZone['G区'].backupId !== 'pd'
  && mBDup.activeRoutePlanId !== 'pd',
  [mBDup.perZone['G区'].recommendedId, mBDup.perZone['G区'].backupId, mBDup.activeRoutePlanId])
check('⚠️ P2-1 B 重复 投影级 → 各投影无矛盾',
  contradictionsOf(mBDup).length === 0, contradictionsOf(mBDup))

// ── C. 回归守卫：D4 派生行为不变 ──
const mP1D4 = runMatrix('P1-1 回归守卫：仅有效全 OPEN exits', { exits: OPEN_EXITS })
check('⚠️ P1-1 回归守卫 投影级 → D4 派生不变（blockedAll=false / exits 两项）',
  mP1D4.blockedAll === false
  && JSON.stringify(mP1D4.exits.map((e) => e.nodeId)) === JSON.stringify([EXIT_W, EXIT_E]),
  [mP1D4.blockedAll, mP1D4.exits.map((e) => e.nodeId)])

// ══════════════════════════════════════
console.log('\n[24] P2-1 全局策略 B：missing / invalid + 非空声明集（投影级）')
console.log('     声明集不得单独放行出口 ⇒ 有效可用集为空 ⇒ 非 DONE 整批失效')
// ══════════════════════════════════════
// runMatrix 返回字段（= applyExitInvalidation 返回值，逐项列出以确定断言可覆盖）：
//   · routePlans[].status                      路线最终状态
//   · perZone['G区'].{ plans, recommendedId, backupId }
//   · exits[] / exitNodeIds[]                  有效可用集过滤后的出口（应为空）
//   · affectedRouteIds[]                       最终 BLOCKED 并集去重
//   · blockedAll                               回显或「有效可用集为空」派生
//   · activeRoutePlanId
//   · exitStates{ degraded, reason, unknown, partial, duplicate, unknownRawIds }
//   · exitsConflict[]                          仅诊断
// 三指针初始值一律**显式指向 DONE 的 pd**（非 null）⇒ 覆盖「被清除 / 被重选」真实路径，
//   避免用初始即为 null 的值形成空覆盖。
const sbPointerZone = () => ({
  'G区': { plans: projPlans().map((p) => ({ ...p })), recommendedId: 'pd', backupId: 'pd' },
})
;[
  ['SB-P1 missing', []],
  ['SB-P2 invalid', [{ foo: 1 }]],
].forEach(([label, exits]) => {
  const o = runMatrix(label, {
    exits,
    usableNodeIds: [EXIT_W],
    perZone: sbPointerZone(),
    activeRoutePlanId: 'pd',
  })
  check(`⚠️ 策略 B ${label} 投影级 → blockedAll=true（有效可用集为空 ⇒ 自动置位）`,
    o.blockedAll === true, o.blockedAll)
  check(`⚠️ 策略 B ${label} 投影级 → exits / exitNodeIds 同源且均为空（声明集不得放行）`,
    JSON.stringify(o.exits) === JSON.stringify([])
    && JSON.stringify(o.exitNodeIds) === JSON.stringify([]),
    [o.exits.map((e) => e.nodeId), o.exitNodeIds])
  check(`⚠️ 策略 B ${label} 投影级 → 非 DONE 全失效、DONE 不进 affectedRouteIds`,
    JSON.stringify(o.affectedRouteIds) === JSON.stringify(['pw', 'pe'])
    && !o.affectedRouteIds.includes('pd')
    && o.routePlans[2].status === 'DONE',
    [o.affectedRouteIds, o.routePlans.map((p) => p.status)])
  check(`⚠️ 策略 B ${label} 投影级 → DONE 不被推荐 / 备用 / 选中（三指针均被清除）`,
    o.perZone['G区'].recommendedId !== 'pd'
    && o.perZone['G区'].backupId !== 'pd'
    && o.activeRoutePlanId !== 'pd',
    [o.perZone['G区'].recommendedId, o.perZone['G区'].backupId, o.activeRoutePlanId])
  // ⚠️【Stage 1.1-R P2】本场景三指针终值**均为 null**，而 contradictionsOf 在
  //   `:638/:641/:645` **跳过** null / undefined 指针 ⇒ 其 I1 分支在此**平凡成立、
  //   无判别力**。故本断言只声称覆盖了 I2（跨投影状态一致）与 I3（affected == BLOCKED
  //   并集）；I1 的实际判别由下方 SB-P3（非空指针场景）承担。
  check(`⚠️ 策略 B ${label} 投影级 → 各投影无矛盾（仅 I2 跨投影状态 / I3 affected；I1 在本场景平凡成立，见 SB-P3）`,
    contradictionsOf(o).length === 0, contradictionsOf(o))
})

// ── SB-P3：让 I1 具判别力（Stage 1.1-R P2）—— **非空指针**场景 ──
//   SB-P1/P2 的三指针全部被清除为 null ⇒ contradictionsOf 无候选指针可判 ⇒ I1 平凡成立。
//   本例沿用 SB-11 的 partial 重选语义构造非空指针（三指针初值仍由 sbPointerZone /
//   activeRoutePlanId 显式指向 DONE 的 pd，非空覆盖）：
//     exits = [W(OPEN)]（partial）+ usableNodeIds = [W, E] ⇒ 仅 W 可用
//     ⇒ routePlans = [NORMAL(pw), BLOCKED(pe), DONE(pd)]，affected = [pe]
//     ⇒ recommendedId = 'pw' / backupId = null / activeRoutePlanId = 'pw'
//   backupId 为 null 的契约依据（非猜测）：pickSafeRecommendations 按可用顺序取前两条，
//   该项目集下只剩 pw 一条可用 ⇒ `exitRuntime.js:617` safe[1] 无命中 ⇒ null。
//   ⇒ 两条非空指针使 contradictionsOf 的 I1 真正可判。
const sbP3 = runMatrix('SB-P3 partial 重选（非空指针）', {
  exits: [{ nodeId: EXIT_W, available: true, status: EXIT_STATUS.OPEN }],
  usableNodeIds: [EXIT_W, EXIT_E],
  perZone: sbPointerZone(),
  activeRoutePlanId: 'pd',
})
const sbP3Pointers = [
  ['recommendedId', sbP3.perZone['G区'].recommendedId],
  ['backupId', sbP3.perZone['G区'].backupId],
  ['activeRoutePlanId', sbP3.activeRoutePlanId],
]
const sbP3NonNull = sbP3Pointers.filter(([, id]) => id !== null && id !== undefined)
const sbP3StatusById = new Map(
  (sbP3.routePlans || [])
    .filter((p) => p && p.id !== undefined && p.id !== null)
    .map((p) => [String(p.id), p.status]),
)
const sbP3Resolve = (id) => (sbP3StatusById.has(String(id))
  ? sbP3StatusById.get(String(id)) : '<所指路线不存在>')
check('⚠️ 策略 B SB-P3 I1 前提：partial 重选后确存在非空指针（recommendedId / activeRoutePlanId）',
  sbP3NonNull.length > 0
  && sbP3.perZone['G区'].recommendedId === 'pw'
  && sbP3.activeRoutePlanId === 'pw',
  [sbP3Pointers, sbP3.routePlans.map((p) => p.status)])
check('⚠️ 策略 B SB-P3 I1 实体性断言：非空指针所指路线**存在**且**不是 BLOCKED**',
  sbP3NonNull.length > 0
  && sbP3NonNull.every(([, id]) => sbP3StatusById.has(String(id)))
  && sbP3NonNull.every(([, id]) => sbP3StatusById.get(String(id)) !== 'BLOCKED'),
  sbP3NonNull.map(([k, id]) => [k, id, sbP3Resolve(id)]))
check('⚠️ 策略 B SB-P3 contradictionsOf 无矛盾（本场景 I1 / I2 / I3 三者均具判别力）',
  contradictionsOf(sbP3).length === 0, contradictionsOf(sbP3))

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`)
process.exit(fail ? 1 : 0)

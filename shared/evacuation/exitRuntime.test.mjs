/**
 * P1.8.2 Stage 1 专项测试：出口运行态统一契约 + 路径 B 透传
 * （node shared/evacuation/exitRuntime.test.mjs）
 *
 * 校验：
 *   · 默认出口状态 = 静态权威定义，capacity 恒 null（D-7：不定义/不计算/不实施容量）
 *   · 规范化 fail-safe：缺失 / 过期 / 结构非法 → 回落静态默认 + 显式 degraded，**不静默当作可用**
 *   · 可用性判定与 floorTopology.isExitUsable 同一口径
 *   · 路径 B（planEvacuationRoutes）补齐 exits 透传后过滤生效，且不传时行为不变
 *   · 版本指纹可用于变化检测（触发重规划 / 存量路线失效）
 */
import {
  defaultExitStates, normalizeExitStates, usableExitNodeIds, hasUsableExit, exitStatesSignature,
  resolveExitKey, rawExitIdOf, isExitStatesFull, exitDiff, routesAffectedByExits,
  pickSafeRecommendations, filterExitNodeIds, applyExitInvalidation, isRouteUsable,
  shouldInvalidateByExits, USABLE_ROUTE_STATUSES, UNKNOWN_EXIT_POLICY,
  PLANNING_STATUS, PLANNING_EVENT, nextPlanningState, nextPlanningGeneration,
  shouldApplyReplanResult,
  // N1 补充修复新增的两个「唯一解析入口」
  resolveRouteExitNodeId, toUsableNodeIdSet,
} from './exitRuntime.js'
import { EXIT_DEFS, EXIT_STATUS, isExitUsable } from './floorTopology.js'
import { PLAN_STATUS } from './routeTypes.js'
import { planEvacuationRoutes } from './routePlanner.js'

let pass = 0, fail = 0
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${extra !== undefined ? ' → ' + JSON.stringify(extra) : ''}`) }
}

const EXIT_W = EXIT_DEFS.find((e) => e.key === 'EXIT_W').nodeId
const EXIT_E = EXIT_DEFS.find((e) => e.key === 'EXIT_E').nodeId
const withExit = (key, patch) => EXIT_DEFS.map((e) => (e.key === key ? { ...e, ...patch } : e))

console.log('\n=== P1.8.2 Stage 1 · 出口运行态专项测试 ===\n')

console.log('[1] 默认出口状态')
const def = defaultExitStates()
check('默认状态 = 静态权威定义（数量一致）', def.length === EXIT_DEFS.length, def.length)
check('默认全部 OPEN 且 available', def.every((e) => e.available === true && e.status === EXIT_STATUS.OPEN))
check('capacity 恒为 null（不定义容量，D-7 = A）', def.every((e) => e.capacity === null))
check('返回新数组，不污染 EXIT_DEFS', def !== EXIT_DEFS && def[0] !== EXIT_DEFS[0])
def[0].available = false
check('就地修改默认返回值不影响 EXIT_DEFS', EXIT_DEFS[0].available === true)

console.log('\n[2] 规范化 fail-safe：缺失 / 过期 / 非法 → 回落 + 显式告警')
const miss1 = normalizeExitStates(undefined)
const miss2 = normalizeExitStates(null)
const miss3 = normalizeExitStates([])
check('undefined → degraded=true / reason=missing', miss1.degraded === true && miss1.reason === 'missing')
check('null → degraded=true / reason=missing', miss2.degraded === true && miss2.reason === 'missing')
check('空数组 → degraded=true / reason=missing', miss3.degraded === true && miss3.reason === 'missing')
check('回落结果 = 静态权威定义（全 OPEN，安全基线）',
  miss1.exits.length === EXIT_DEFS.length && miss1.exits.every((e) => e.status === EXIT_STATUS.OPEN))
const invalid = normalizeExitStates([{ foo: 1 }, null, 'x', 42])
check('结构非法 → degraded=true / reason=invalid', invalid.degraded === true && invalid.reason === 'invalid', invalid.reason)
check('结构非法时同样回落到静态默认', invalid.usableNodeIds.length === EXIT_DEFS.length)

console.log('\n[3] 单个出口的 fail-safe 归一化（不确定一律判为不可用）')
const noAvail = normalizeExitStates([{ nodeId: EXIT_W }])
const w1 = noAvail.exits.find((e) => e.nodeId === EXIT_W)
check('缺失 available → 视为 false（不可用）', w1.available === false)
check('缺失 status → 视为 CLOSED', w1.status === EXIT_STATUS.CLOSED)
const badStatus = normalizeExitStates([{ nodeId: EXIT_W, available: true, status: 'WEIRD' }])
check('非枚举 status → 视为 CLOSED',
  badStatus.exits.find((e) => e.nodeId === EXIT_W).status === EXIT_STATUS.CLOSED)
const capOverride = normalizeExitStates([{ nodeId: EXIT_W, available: true, status: 'OPEN', capacity: 999 }])
check('capacity 不接受外部覆盖（恒 null）',
  capOverride.exits.find((e) => e.nodeId === EXIT_W).capacity === null)

console.log('\n[4] 可用性判定（与 floorTopology.isExitUsable 同一口径）')
const openAll = normalizeExitStates(EXIT_DEFS)
check('全 OPEN → 两个出口均可用', openAll.usableNodeIds.length === 2, openAll.usableNodeIds)
const closedE = normalizeExitStates(withExit('EXIT_E', { status: EXIT_STATUS.CLOSED }))
check('EXIT_E CLOSED → 仅 EXIT_W 可用',
  closedE.usableNodeIds.length === 1 && closedE.usableNodeIds[0] === EXIT_W, closedE.usableNodeIds)
const blockedE = normalizeExitStates(withExit('EXIT_E', { status: EXIT_STATUS.BLOCKED }))
check('EXIT_E BLOCKED → 仅 EXIT_W 可用',
  blockedE.usableNodeIds.length === 1 && blockedE.usableNodeIds[0] === EXIT_W, blockedE.usableNodeIds)
const unavailE = normalizeExitStates(withExit('EXIT_E', { available: false }))
check('EXIT_E available=false → 仅 EXIT_W 可用',
  unavailE.usableNodeIds.length === 1 && unavailE.usableNodeIds[0] === EXIT_W, unavailE.usableNodeIds)
check('三种不可用形态与 isExitUsable 口径一致',
  !isExitUsable(EXIT_E, withExit('EXIT_E', { status: EXIT_STATUS.CLOSED }))
  && !isExitUsable(EXIT_E, withExit('EXIT_E', { status: EXIT_STATUS.BLOCKED }))
  && !isExitUsable(EXIT_E, withExit('EXIT_E', { available: false }))
  && isExitUsable(EXIT_E, EXIT_DEFS))
check('usableExitNodeIds 与逐项 isExitUsable 结果一致',
  usableExitNodeIds(closedE.exits).every((id) => isExitUsable(id, closedE.exits))
  && EXIT_DEFS.every((e) => usableExitNodeIds(closedE.exits).includes(e.nodeId) === isExitUsable(e.nodeId, closedE.exits)))

console.log('\n[5] 部分下发：未列出的出口按静态默认补全')
const partial = normalizeExitStates([{ nodeId: EXIT_E, available: false, status: EXIT_STATUS.CLOSED }])
check('补全为全部出口，不漏项', partial.exits.length === EXIT_DEFS.length, partial.exits.length)
check('标记为 partial（非常规运行态，需告警）', partial.degraded === true && partial.reason === 'partial', partial.reason)
check('未下发的 EXIT_W 按静态默认（可用）',
  partial.usableNodeIds.includes(EXIT_W) && !partial.usableNodeIds.includes(EXIT_E), partial.usableNodeIds)

console.log('\n[6] hasUsableExit / 版本指纹')
const allClosed = normalizeExitStates(EXIT_DEFS.map((e) => ({ ...e, status: EXIT_STATUS.CLOSED })))
check('全部关闭 → hasUsableExit=false', hasUsableExit(allClosed.exits) === false)
check('有可用出口 → hasUsableExit=true', hasUsableExit(openAll.exits) === true)
const sigA = exitStatesSignature(openAll.exits)
const sigB = exitStatesSignature(closedE.exits)
check('可用性变化 → 指纹变化（可用于触发重规划）', sigA !== sigB)
check('仅 label 变化 → 指纹不变（不影响可用性）',
  exitStatesSignature(openAll.exits.map((e) => ({ ...e, label: '改个名' }))) === sigA)
check('指纹与顺序无关', exitStatesSignature([...openAll.exits].reverse()) === sigA)

console.log('\n[7] 路径 B 透传：planEvacuationRoutes')
const base = planEvacuationRoutes({ floorId: '5F', zone: 'A区', fireZone: 'A区' })
check('不传 exits → 兼容行为不变（仍有方案）', base.plans.length > 0, base.plans.length)
const withClosed = planEvacuationRoutes({
  floorId: '5F', zone: 'A区', fireZone: 'A区', exits: withExit('EXIT_E', { status: EXIT_STATUS.CLOSED }),
})
check('EXIT_E CLOSED → 全部方案终点为 EXIT_W',
  withClosed.plans.length > 0 && withClosed.plans.every((p) => p.exitId === EXIT_W),
  [...new Set(withClosed.plans.map((p) => p.exitId))])
const withAllClosed = planEvacuationRoutes({
  floorId: '5F', zone: 'A区', fireZone: 'A区', exits: EXIT_DEFS.map((e) => ({ ...e, status: EXIT_STATUS.CLOSED })),
})
check('全部出口关闭 → 不抛错且无方案（不静默产出）',
  Array.isArray(withAllClosed.plans) && withAllClosed.plans.length === 0, withAllClosed.plans.length)
const viaNormalized = planEvacuationRoutes({
  floorId: '5F', zone: 'A区', fireZone: 'A区', exits: closedE.exits,
})
check('传入 normalizeExitStates 结果同样生效（端到端同口径）',
  viaNormalized.plans.length > 0 && viaNormalized.plans.every((p) => p.exitId === EXIT_W),
  [...new Set(viaNormalized.plans.map((p) => p.exitId))])

console.log('\n[8] 出口标识解析：nodeId / key / id 三种形式统一收敛')
check('nodeId 形式 → 解析为规范 nodeId',
  (resolveExitKey({ nodeId: EXIT_W }) || {}).nodeId === EXIT_W)
check('id 形式（与 key 同形）→ 解析为规范 nodeId（修复前被静默丢弃）',
  (resolveExitKey({ id: 'EXIT_W' }) || {}).nodeId === EXIT_W,
  resolveExitKey({ id: 'EXIT_W' }))
check('key 形式 → 解析为规范 nodeId',
  (resolveExitKey({ key: 'EXIT_W' }) || {}).nodeId === EXIT_W)
check('未知 id → null', resolveExitKey({ id: 'EXIT_ZZZ' }) === null)
check('未知 nodeId → null', resolveExitKey({ nodeId: '1F:EXIT_ZZZ' }) === null)
check('非对象 / 空值 → null',
  resolveExitKey(null) === null
  && resolveExitKey('EXIT_W') === null
  && resolveExitKey(42) === null)

console.log('\n[9] 完整且唯一的数组 → degraded=false / reason=null（向后兼容核验）')
const fullA = normalizeExitStates(EXIT_DEFS)
const fullB = normalizeExitStates(withExit('EXIT_E', { status: EXIT_STATUS.CLOSED }))
check('全 OPEN 完整数组 → degraded=false / reason=null',
  fullA.degraded === false && fullA.reason === null, [fullA.degraded, fullA.reason])
check('含关闭项的完整数组 → degraded=false / reason=null',
  fullB.degraded === false && fullB.reason === null, [fullB.degraded, fullB.reason])
check('完整数组无 duplicate / unknown / partial 标记',
  fullA.duplicate === false && fullA.unknown === false && fullA.partial === false)

console.log('\n[10] 重复出口 ID 的保守合并（fail-safe，非 last-wins）')
const dupA = normalizeExitStates([
  { nodeId: EXIT_W, available: false, status: EXIT_STATUS.CLOSED },
  { nodeId: EXIT_W, available: true, status: EXIT_STATUS.OPEN },
])
check('重复 [CLOSED, OPEN] → EXIT_W 不可用',
  isExitUsable(EXIT_W, dupA.exits) === false)
check('重复 [CLOSED, OPEN] → usableExitNodeIds 同样排除（口径一致）',
  !usableExitNodeIds(dupA.exits).includes(EXIT_W), usableExitNodeIds(dupA.exits))
check('duplicate 标志置位', dupA.duplicate === true)

const dupB = normalizeExitStates([
  { nodeId: EXIT_W, available: true, status: EXIT_STATUS.OPEN },
  { nodeId: EXIT_W, available: false, status: EXIT_STATUS.CLOSED },
])
check('重复 [OPEN, CLOSED] → 同样不可用（与顺序无关）',
  isExitUsable(EXIT_W, dupB.exits) === false
  && !usableExitNodeIds(dupB.exits).includes(EXIT_W))

const dupTriple = normalizeExitStates([
  { nodeId: EXIT_W, available: true, status: EXIT_STATUS.OPEN },
  { nodeId: EXIT_W, available: true, status: EXIT_STATUS.BLOCKED },
  { nodeId: EXIT_W, available: false, status: EXIT_STATUS.CLOSED },
])
check('三重复混合 → 不可用且 status 取 BLOCKED（确定优先级）',
  dupTriple.exits.find((e) => e.nodeId === EXIT_W).status === EXIT_STATUS.BLOCKED
  && !dupTriple.usableNodeIds.includes(EXIT_W))

const dupAllOpen = normalizeExitStates([
  { nodeId: EXIT_W, available: true, status: EXIT_STATUS.OPEN },
  { nodeId: EXIT_W, available: true, status: EXIT_STATUS.OPEN },
])
check('重复且全部 OPEN → 仍可用，但 duplicate 置位（需告警）',
  dupAllOpen.duplicate === true && dupAllOpen.usableNodeIds.includes(EXIT_W))

console.log('\n[11] 缺失 / 非法 / 部分 / 未知 的明确语义')
check('缺失（undefined / null / []）→ reason=missing 且回落全 OPEN',
  [undefined, null, []].every((v) => {
    const r = normalizeExitStates(v)
    return r.degraded === true && r.reason === 'missing'
      && r.usableNodeIds.length === EXIT_DEFS.length
  }))
check('非法（全部不可解析）→ reason=invalid 且回落全 OPEN',
  (() => {
    const r = normalizeExitStates([{ foo: 1 }, null, 'x', 42])
    return r.reason === 'invalid' && r.usableNodeIds.length === EXIT_DEFS.length
  })())
check('未知条目 → unknown=true 并记录原始 id（不再静默丢弃）',
  (() => {
    const r = normalizeExitStates([
      { nodeId: EXIT_W, available: false, status: EXIT_STATUS.CLOSED },
      { id: '1F:EXIT_ZZZ', available: false, status: EXIT_STATUS.CLOSED },
    ])
    return r.unknown === true && r.unknownRawIds.includes('1F:EXIT_ZZZ')
  })())
check('已有部分语义不变：reason=partial（既有断言 [5] 已覆盖，此处仅复核保留）',
  partial.degraded === true && partial.reason === 'partial')

// ══════════════════════════════════════
console.log('\n[12] 保留既有覆盖语义（不得为统一口径而破坏 P1.8.1 契约）')
// ══════════════════════════════════════
check('isExitUsable 在空数组下仍回落静态定义（既有行为不变）',
  isExitUsable(EXIT_E, []) === true)
check('isExitUsable 在部分数组下未列出项仍可用（既有行为不变）',
  isExitUsable(EXIT_E, withExit('EXIT_W', { available: false, status: EXIT_STATUS.CLOSED })) === true)
check('isExitUsable 在完整数组下被关闭项不可用（既有行为不变）',
  isExitUsable(EXIT_E, withExit('EXIT_E', { status: EXIT_STATUS.CLOSED })) === false)
check('isExitStatesFull：完整唯一数组为 true',
  isExitStatesFull(fullA.exits) === true && isExitStatesFull(fullB.exits) === true)
check('isExitStatesFull：部分 / 重复 / 非法 / 空均为 false',
  isExitStatesFull([{ nodeId: EXIT_W }]) === false
  && isExitStatesFull([{ nodeId: EXIT_W }, { nodeId: EXIT_W }]) === false
  && isExitStatesFull([{ id: 'EXIT_ZZZ' }]) === false
  && isExitStatesFull([]) === false)

// ══════════════════════════════════════
console.log('\n[13] 归一化返回结构：所有分支字段完整且类型稳定（F-A 回归）')
// ══════════════════════════════════════
const STRUCT_KEYS = [
  'exits', 'usableNodeIds', 'reportedUsableNodeIds', 'degraded', 'reason',
  'duplicate', 'unknown', 'partial', 'unknownRawIds',
]
const fullOpen = EXIT_DEFS.map((e) => ({ ...e, available: true, status: EXIT_STATUS.OPEN }))
const structCases = [
  ['undefined', normalizeExitStates(undefined)],
  ['null', normalizeExitStates(null)],
  ['空数组', normalizeExitStates([])],
  ['全不可解析', normalizeExitStates([{ foo: 1 }, null, 'x', 42])],
  ['部分(1/2)', partial],
  ['完整全OPEN', fullA],
  ['完整含关闭', fullB],
  ['重复矛盾', dupA],
  ['含未知条目', normalizeExitStates([...fullOpen, { id: '1F:EXIT_ZZZ' }])],
]
structCases.forEach(([label, r]) => {
  check(`[${label}] 9 个字段全部存在`,
    STRUCT_KEYS.every((k) => k in r), STRUCT_KEYS.filter((k) => !(k in r)))
  check(`[${label}] exits / usableNodeIds / unknownRawIds 均为数组`,
    Array.isArray(r.exits) && Array.isArray(r.usableNodeIds) && Array.isArray(r.unknownRawIds))
  check(`[${label}] reportedUsableNodeIds 为数组（策略 B 派生源，三分支须恒有值）`,
    Array.isArray(r.reportedUsableNodeIds), r.reportedUsableNodeIds)
  check(`[${label}] degraded / duplicate / unknown / partial 均为布尔`,
    [r.degraded, r.duplicate, r.unknown, r.partial].every((v) => typeof v === 'boolean'))
  check(`[${label}] degraded 与 reason 一致（degraded ⟺ reason≠null）`,
    (r.degraded === true) === (r.reason !== null), [r.degraded, r.reason])
})

// ══════════════════════════════════════
console.log('\n[14] 出口标识：nodeId / key / id 三口径一致（F-B / F-H 回归）')
// ══════════════════════════════════════
check('rawExitIdOf 覆盖 key 形式（修复前未知条目检测漏掉此分支）',
  rawExitIdOf({ key: '1F:EXIT_ZZZ' }) === '1F:EXIT_ZZZ')
check('rawExitIdOf 覆盖 id 形式', rawExitIdOf({ id: 'EXIT_W' }) === 'EXIT_W')
check('rawExitIdOf 覆盖 nodeId 形式', rawExitIdOf({ nodeId: EXIT_W }) === EXIT_W)
check('rawExitIdOf 对非对象 / 空串返回 null',
  rawExitIdOf(null) === null
  && rawExitIdOf('x') === null
  && rawExitIdOf(42) === null
  && rawExitIdOf({ nodeId: '' }) === null)

// ⚠️ F-B 核心回归：未知条目经 key 字段下发时，不得被静默吞掉
const junkViaKey = normalizeExitStates([
  ...fullOpen,
  { key: '1F:EXIT_ZZZ', available: false, status: EXIT_STATUS.CLOSED },
])
check('⚠️ 未知条目经 key 下发 → unknown=true（修复前为 false）', junkViaKey.unknown === true)
check('⚠️ 未知条目经 key 下发 → degraded=true（不再静默）', junkViaKey.degraded === true)
check('⚠️ 未知条目经 key 下发 → reason=unknown', junkViaKey.reason === 'unknown', junkViaKey.reason)
check('未知条目经 key 下发 → 记录原始标识',
  junkViaKey.unknownRawIds.includes('1F:EXIT_ZZZ'), junkViaKey.unknownRawIds)
check('未知条目不污染已识别出口',
  junkViaKey.exits.length === EXIT_DEFS.length
  && junkViaKey.usableNodeIds.length === EXIT_DEFS.length)

// ⚠️ F-H：id 与 nodeId 矛盾时输出必须自洽
const conflictId = normalizeExitStates([
  { nodeId: EXIT_W, id: EXIT_E, available: false, status: EXIT_STATUS.CLOSED },
  { nodeId: EXIT_E, available: true, status: EXIT_STATUS.OPEN },
])
const cw = conflictId.exits.find((e) => e.nodeId === EXIT_W)
check('⚠️ id 与 nodeId 矛盾 → id / key / nodeId 三者自洽',
  cw.id === 'EXIT_W' && cw.key === 'EXIT_W' && cw.nodeId === EXIT_W,
  [cw.id, cw.key, cw.nodeId])
check('⚠️ id 与 nodeId 矛盾 → 可用性仍按 nodeId 判定',
  isExitUsable(EXIT_W, conflictId.exits) === false
  && isExitUsable(EXIT_E, conflictId.exits) === true)

// ══════════════════════════════════════
console.log('\n[15] 路线可用性：状态白名单（F-C 回归，非白名单一律不可用）')
// ══════════════════════════════════════
const U = [EXIT_W]
const usableStatuses = ['NORMAL', 'WARNING', 'CONFIRMED', 'EXECUTING']
usableStatuses.forEach((st) => {
  check(`白名单 status=${st} → 可用`,
    isRouteUsable({ id: 'r', exit: EXIT_W, status: st }, U) === true)
})
const rejectedStatuses = [
  'BLOCKED', 'DONE', 'INVALIDATED', 'FAILED', 'NO_FEASIBLE_ROUTE', 'WEIRD', '', undefined, null,
]
rejectedStatuses.forEach((st) => {
  check(`⚠️ 非白名单 status=${JSON.stringify(st)} → 不可用（fail-safe）`,
    isRouteUsable({ id: 'r', exit: EXIT_W, status: st }, U) === false)
})
check('⚠️ 缺少出口标识 → 默认 fail-closed（判为不可用）',
  isRouteUsable({ id: 'r', status: 'NORMAL' }, U) === false)
check('缺少出口标识 + 显式 fail-open → 可用（仅限不参与疏散决策的展示口径）',
  isRouteUsable({ id: 'r', status: 'NORMAL' }, U, { unknownExitPolicy: 'fail-open' }) === true)
check('出口不在可用列表 → 不可用',
  isRouteUsable({ id: 'r', exit: EXIT_E, status: 'NORMAL' }, U) === false)
check('route 为空 → 不可用', isRouteUsable(null, U) === false)

// ══════════════════════════════════════
console.log('\n[16] exitDiff：changed 与 availabilityChanged 的语义区分（F-I 回归）')
// ══════════════════════════════════════
const openW = [{ nodeId: EXIT_W, available: true, status: EXIT_STATUS.OPEN }]
const closedW = [{ nodeId: EXIT_W, available: false, status: EXIT_STATUS.CLOSED }]
const blockedW = [{ nodeId: EXIT_W, available: false, status: EXIT_STATUS.BLOCKED }]
const dClose = exitDiff(openW, closedW)
const dNonAvailable = exitDiff(closedW, blockedW)
const dSame = exitDiff(openW, openW)
check('OPEN→CLOSED：changed=true 且 availabilityChanged=true',
  dClose.changed === true && dClose.availabilityChanged === true)
check('OPEN→CLOSED：closedNodeIds 含该出口',
  dClose.closedNodeIds.includes(EXIT_W), dClose.closedNodeIds)
check('⚠️ CLOSED→BLOCKED：changed=true 但 availabilityChanged=false（不可当作关闭事件）',
  dNonAvailable.changed === true && dNonAvailable.availabilityChanged === false)
check('CLOSED→BLOCKED：closedNodeIds / openedNodeIds 均为空',
  dNonAvailable.closedNodeIds.length === 0 && dNonAvailable.openedNodeIds.length === 0)
check('无变化：changed=false 且 availabilityChanged=false',
  dSame.changed === false && dSame.availabilityChanged === false)
check('CLOSED→OPEN：openedNodeIds 含该出口',
  exitDiff(closedW, openW).openedNodeIds.includes(EXIT_W))

// ══════════════════════════════════════
console.log('\n[17] N1 回归：出口过滤与标识归一化口径一致')
console.log('     修复前：applyExitInvalidation 直读原始 e.nodeId || e.id，')
console.log('     与 resolveExitKey 的三种合法形式不一致 ⇒ key/id 形式整条被筛掉，')
console.log('     出现「exitNodeIds 非空而 exits 为空」的同对象内部矛盾')
// ══════════════════════════════════════
const N1_OPEN = EXIT_DEFS.map((e) => ({ ...e, available: true, status: EXIT_STATUS.OPEN }))
const N1_CLOSED_E = withExit('EXIT_E', { available: false, status: EXIT_STATUS.CLOSED })
const N1_U = [EXIT_W]
const N1_FORMS = {
  nodeId: N1_CLOSED_E.map((e) => ({ nodeId: e.nodeId, available: e.available, status: e.status })),
  id: N1_CLOSED_E.map((e) => ({ id: e.id, available: e.available, status: e.status })),
  key: N1_CLOSED_E.map((e) => ({ key: e.key, available: e.available, status: e.status })),
}
Object.entries(N1_FORMS).forEach(([form, list]) => {
  const o = applyExitInvalidation({
    routePlans: [], perZone: {}, exits: list, usableNodeIds: N1_U,
  })
  const ids = o.exits.map((e) => e.nodeId)
  check(`⚠️ [${form} 形式] exits 与 exitNodeIds 一致（修复前 key/id 形式 exits 为空）`,
    JSON.stringify(ids) === JSON.stringify(o.exitNodeIds), [ids, o.exitNodeIds])
  check(`[${form} 形式] 仅保留可用出口 EXIT_W`, ids.length === 1 && ids[0] === EXIT_W, ids)
  check(`[${form} 形式] 已关闭 EXIT_E 被剔除`, !ids.includes(EXIT_E), ids)
  check(`[${form} 形式] 输出对象已规范化（nodeId = 1F:key）`,
    o.exits.every((e) => e.nodeId === '1F:' + e.key && e.id === e.key))
})

// ⚠️ N1 关键回归：未知出口标识不得被静默转换为已知出口
//   normalizeExitStates 丢弃未知条目后，其余已知出口按**既有契约**回填静态默认（OPEN），
//   故投影中只会出现真实的已知出口，不会出现由 EXIT_ZZZ 派生的条目。
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
console.log('\n[18] N2 语义边界：失效判定(A层) vs 可用性判定(B层) —— 表驱动')
console.log('     A层 = shouldInvalidateByExits：路线本身是否还成立（成立者保持原状态）')
console.log('     B层 = isRouteUsable：能否作为当前选中 / 推荐 / 备用路线')
console.log('     ⇒ 两者可不同（DONE 是唯一刻意差异），但必须显式且有理由')
// ══════════════════════════════════════
const N2_U = [EXIT_W]
const N2_EXITS = [
  { nodeId: EXIT_W, available: true, status: EXIT_STATUS.OPEN },
  { nodeId: EXIT_E, available: false, status: EXIT_STATUS.CLOSED },
]
// ⚠️ 死数据清理（不改变测试语义）：删除原第 5 列 expectStatus。
//    该列在下方 forEach 中从未被解构、从未参与断言，属纯冗余数据。
//    投影级「协调后 status」的实际断言由 exitConsistency.test.mjs [18] 承担。
//    ── 列定义：[名称, 路线, A层失效?, B层可用?] ──
const N2_CASES = [
  ['NORMAL    / 走可用出口', { id: 'a1', exit: EXIT_W, status: 'NORMAL' }, false, true],
  ['WARNING   / 走可用出口', { id: 'a2', exit: EXIT_W, status: 'WARNING' }, false, true],
  ['CONFIRMED / 走可用出口', { id: 'a3', exit: EXIT_W, status: 'CONFIRMED' }, false, true],
  ['EXECUTING / 走可用出口', { id: 'a4', exit: EXIT_W, status: 'EXECUTING' }, false, true],
  // 出口由 OPEN 变 CLOSED ⇒ 失效
  ['NORMAL    / 出口OPEN→CLOSED', { id: 'a5', exit: EXIT_E, status: 'NORMAL' }, true, false],
  ['EXECUTING / 出口OPEN→CLOSED', { id: 'a6', exit: EXIT_E, status: 'EXECUTING' }, true, false],
  // 已是失效态 ⇒ 保持（幂等）
  ['BLOCKED   / 出口仍可用', { id: 'a7', exit: EXIT_W, status: 'BLOCKED' }, true, false],
  ['BLOCKED   / 出口已关闭', { id: 'a8', exit: EXIT_E, status: 'BLOCKED' }, true, false],
  // ★ DONE：终态保护 —— A 层不失效、B 层不可用（刻意差异，非缺陷）
  ['DONE      / 出口仍可用（终态保护）', { id: 'a9', exit: EXIT_W, status: 'DONE' }, false, false],
  ['DONE      / 出口已关闭（终态保护）', { id: 'a10', exit: EXIT_E, status: 'DONE' }, false, false],
  // 未知 / 缺失 ⇒ 保守
  ['未知状态 / 出口可用', { id: 'a11', exit: EXIT_W, status: 'WEIRD' }, true, false],
  ['缺失状态 / 出口可用', { id: 'a12', exit: EXIT_W }, true, false],
  ['缺失 exit/exitId / NORMAL', { id: 'a13', status: 'NORMAL' }, true, false],
  ['空串出口标识 / NORMAL', { id: 'a14', exit: '', status: 'NORMAL' }, true, false],
  ['未知出口标识 / NORMAL', { id: 'a15', exit: '1F:EXIT_ZZZ', status: 'NORMAL' }, true, false],
]
N2_CASES.forEach(([label, route, expectInvalidate, expectUsable]) => {
  check(`A层 ${label} → 失效=${expectInvalidate}`,
    shouldInvalidateByExits(route, N2_U) === expectInvalidate,
    shouldInvalidateByExits(route, N2_U))
  check(`B层 ${label} → 可用=${expectUsable}`,
    isRouteUsable(route, N2_U) === expectUsable,
    isRouteUsable(route, N2_U))
})

// ══════════════════════════════════════
console.log('\n[19] N3 契约：DONE 不属于「当前可用路线」，但状态不被改写')
// ══════════════════════════════════════
check('白名单不含 DONE（终态已完成，不是"现在可继续用于疏散"的路线）',
  !USABLE_ROUTE_STATUSES.includes(PLAN_STATUS.DONE), USABLE_ROUTE_STATUSES)
check('白名单含 NORMAL / WARNING / CONFIRMED / EXECUTING',
  ['NORMAL', 'WARNING', 'CONFIRMED', 'EXECUTING']
    .every((s) => USABLE_ROUTE_STATUSES.includes(s)))
check('白名单不含 BLOCKED', !USABLE_ROUTE_STATUSES.includes(PLAN_STATUS.BLOCKED))
check('⚠️ isRouteUsable(DONE, 出口可用) = false（不被推荐 / 选中）',
  isRouteUsable({ id: 'd1', exit: EXIT_W, status: PLAN_STATUS.DONE }, [EXIT_W]) === false)

// ★ 安全边界①：DONE 绝不被自动改写为 BLOCKED
const doneOut = applyExitInvalidation({
  routePlans: [{ id: 'd1', exit: EXIT_E, status: PLAN_STATUS.DONE }],
  perZone: {
    'D区': {
      plans: [{ id: 'd1', exit: EXIT_E, status: PLAN_STATUS.DONE }],
      recommendedId: 'd1', backupId: null,
  },
  },
  exits: N2_EXITS,
  usableNodeIds: N2_U,
})
check('⚠️ DONE + 出口已关闭 → routePlans status 保持 DONE（不被改写为 BLOCKED）',
  doneOut.routePlans[0].status === PLAN_STATUS.DONE, doneOut.routePlans[0].status)
check('⚠️ DONE + 出口已关闭 → perZone 同样保持 DONE',
  doneOut.perZone['D区'].plans[0].status === PLAN_STATUS.DONE,
  doneOut.perZone['D区'].plans[0].status)
check('⚠️ DONE 不被推荐（recommendedId 置 null）',
  doneOut.perZone['D区'].recommendedId === null, doneOut.perZone['D区'].recommendedId)
check('⚠️ DONE 不进入 affectedRouteIds（未被标记为失效）',
  !doneOut.affectedRouteIds.includes('d1'), doneOut.affectedRouteIds)

// ══════════════════════════════════════
console.log('\n[20] N1 补充修复：出口标识解析跨形式一致（A 层 / B 层 / 公共辅助函数）')
console.log('     覆盖：规范 nodeId / 裸 key / 裸 id / 混合格式 / 未知 / 缺失 / 空串')
console.log('     ★ 原始缺陷复现：exit="EXIT_W" + usableNodeIds=["1F:EXIT_W"]')
// ══════════════════════════════════════
// ⚠️ 三种形式一律**从真实 EXIT_DEFS 读取**，不得写成相同常量后声称覆盖三种格式。
//    （第二次独立复审 P3-3：原实现把「裸 id」写成与「裸 key」完全相同的 'EXIT_W'，
//     该组用例因此退化为**重复样例**；且一旦某出口 id 与 key 分离，
//     硬编码的用例将无法发现 id 形式失效。）
const D_W = EXIT_DEFS.find((e) => e.key === 'EXIT_W')
const D_E = EXIT_DEFS.find((e) => e.key === 'EXIT_E')
const F_W = D_W.nodeId   // 规范 nodeId 形式
const F_E = D_E.nodeId
const K_W = D_W.key      // 裸 key 形式
const K_E = D_E.key
const I_W = D_W.id       // 裸 id 形式
const I_E = D_E.id

// ── 20.1 ★ 原始缺陷复现：裸 key 形式的合法路线不得「既未失效又不可用」 ──
const REPRO_ROUTE = { id: 'repro', exit: K_W, status: PLAN_STATUS.NORMAL }
const REPRO_USABLE = [F_W]
const reproA = shouldInvalidateByExits(REPRO_ROUTE, REPRO_USABLE)
const reproB = isRouteUsable(REPRO_ROUTE, REPRO_USABLE)
check('⚠️ [原始缺陷] 裸 key 路线 A 层失效=false',
  reproA === false, reproA)
check('⚠️ [原始缺陷] 裸 key 路线 B 层可用=true（修复前为 false）',
  reproB === true, reproB)
check('⚠️ [原始缺陷] A 层与 B 层结论一致（不得 A 不失效却 B 不可用）',
  reproA === !reproB, { A: reproA, B: reproB })

// ── 20.2 三种标识形式 × 状态组合：A 层与 B 层必须逐项一致 ──
const FORMS = [
  ['规范 nodeId', F_W, F_E],
  ['裸 key', K_W, K_E],
  ['裸 id', I_W, I_E],
]
const FORM_STATUSES = [
  PLAN_STATUS.NORMAL, PLAN_STATUS.WARNING, PLAN_STATUS.CONFIRMED,
  PLAN_STATUS.EXECUTING, PLAN_STATUS.BLOCKED, PLAN_STATUS.DONE,
]
FORMS.forEach(([formLabel, idOpen, idClosed]) => {
  // (a) 走可用出口
  FORM_STATUSES.forEach((st) => {
    const r = { id: 'f1', exit: idOpen, status: st }
    const a = shouldInvalidateByExits(r, [F_W])
    const b = isRouteUsable(r, [F_W])
    if (st === PLAN_STATUS.DONE) {
      // DONE 是唯一刻意差异：A 不失效（终态保护）、B 不可用（不参与当前推荐）
      check(`⚠️ ${formLabel} / DONE / 可用出口 → A 不失效 且 B 不可用（终态保护）`,
        a === false && b === false, { A: a, B: b })
    } else if (st === PLAN_STATUS.BLOCKED) {
      check(`⚠️ ${formLabel} / BLOCKED / 可用出口 → A 失效 且 B 不可用（幂等保持）`,
        a === true && b === false, { A: a, B: b })
    } else {
      check(`⚠️ ${formLabel} / ${st} / 可用出口 → A 与 B 互补（不失效 ⇔ 可用）`,
        a === !b, { A: a, B: b })
    }
  })
  // (b) 出口已关闭 ⇒ 一律失效且不可用（DONE 除外，见下）
  FORM_STATUSES
    .filter((st) => st !== PLAN_STATUS.DONE)
    .forEach((st) => {
      const r = { id: 'f2', exit: idClosed, status: st }
      check(`⚠️ ${formLabel} / ${st} / 已关闭出口 → A 层失效`,
        shouldInvalidateByExits(r, [F_W]) === true, shouldInvalidateByExits(r, [F_W]))
      check(`⚠️ ${formLabel} / ${st} / 已关闭出口 → B 层不可用`,
        isRouteUsable(r, [F_W]) === false, isRouteUsable(r, [F_W]))
    })
  // (c) DONE + 已关闭出口 ⇒ 终态保护优先，绝不改写为 BLOCKED
  const doneClosed = { id: 'f3', exit: idClosed, status: PLAN_STATUS.DONE }
  check(`⚠️ ${formLabel} / DONE / 已关闭出口 → A 层仍不失效（不被改写为 BLOCKED）`,
    shouldInvalidateByExits(doneClosed, [F_W]) === false,
    shouldInvalidateByExits(doneClosed, [F_W]))
  check(`⚠️ ${formLabel} / DONE / 已关闭出口 → B 层不可用`,
    isRouteUsable(doneClosed, [F_W]) === false)
})

// ── 20.3 usableNodeIds 输入契约：集合侧三种形式等价 ──
;[
  ['规范 nodeId 集', [F_W]],
  ['裸 key 集', [K_W]],
  ['混合集', [F_W, K_W]],
].forEach(([setLabel, set]) => {
  const r = { id: 'g1', exit: K_W, status: PLAN_STATUS.NORMAL }
  check(`⚠️ ${setLabel} → 裸 key 路线 B 层可用`,
    isRouteUsable(r, set) === true, isRouteUsable(r, set))
  check(`⚠️ ${setLabel} → 裸 key 路线 A 层不失效`,
    shouldInvalidateByExits(r, set) === false, shouldInvalidateByExits(r, set))
  const rc = { id: 'g2', exit: K_E, status: PLAN_STATUS.NORMAL }
  check(`⚠️ ${setLabel} → 走已关闭出口的路线 B 层不可用`,
    isRouteUsable(rc, set) === false, isRouteUsable(rc, set))
  check(`⚠️ ${setLabel} → 走已关闭出口的路线 A 层失效`,
    shouldInvalidateByExits(rc, set) === true, shouldInvalidateByExits(rc, set))
})
check('⚠️ toUsableNodeIdSet 把裸 key 解析为规范 nodeId',
  toUsableNodeIdSet([K_W]).has(F_W), [...toUsableNodeIdSet([K_W])])
check('⚠️ toUsableNodeIdSet 保留规范 nodeId 原值',
  toUsableNodeIdSet([F_W]).has(F_W), [...toUsableNodeIdSet([F_W])])
check('⚠️ toUsableNodeIdSet 剔除 null / undefined / 空串',
  toUsableNodeIdSet([null, undefined, '']).size === 0,
  [...toUsableNodeIdSet([null, undefined, ''])])
check('⚠️ toUsableNodeIdSet 不把未知标识静默猜测为已知出口',
  !toUsableNodeIdSet(['EXIT_ZZZ']).has(F_W) && !toUsableNodeIdSet(['EXIT_ZZZ']).has(F_E),
  [...toUsableNodeIdSet(['EXIT_ZZZ'])])

// ── 20.4 resolveRouteExitNodeId：缺失 / 空串 / 未知 ⇒ null（保守，不静默猜测）──
check('⚠️ 缺失 exit/exitId → null', resolveRouteExitNodeId({ id: 'h1' }) === null)
check('⚠️ 空串出口标识 → null', resolveRouteExitNodeId({ id: 'h2', exit: '' }) === null)
check('⚠️ 未知出口标识 → null（不静默猜测为已知出口）',
  resolveRouteExitNodeId({ id: 'h3', exit: 'EXIT_ZZZ' }) === null,
  resolveRouteExitNodeId({ id: 'h3', exit: 'EXIT_ZZZ' }))
check('⚠️ 规范 nodeId → 自身', resolveRouteExitNodeId({ exit: F_W }) === F_W)
check('⚠️ 裸 key → 规范 nodeId', resolveRouteExitNodeId({ exit: K_W }) === F_W)
check('⚠️ exitId 字段同样解析（后端投影口径）',
  resolveRouteExitNodeId({ exitId: K_W }) === F_W)

// ── 20.5 公共辅助函数同步一致（避免只修一个调用点留下同类缺陷）──
check('⚠️ routesAffectedByExits：裸 key 路线可被识别为受影响',
  JSON.stringify(routesAffectedByExits([{ id: 'i1', exit: K_E }], [F_E]))
    === JSON.stringify(['i1']),
  routesAffectedByExits([{ id: 'i1', exit: K_E }], [F_E]))
check('⚠️ routesAffectedByExits：裸 key 集合入参同样命中',
  JSON.stringify(routesAffectedByExits([{ id: 'i2', exit: F_E }], [K_E]))
    === JSON.stringify(['i2']),
  routesAffectedByExits([{ id: 'i2', exit: F_E }], [K_E]))
check('⚠️ routesAffectedByExits：未知标识不被静默匹配',
  routesAffectedByExits([{ id: 'i3', exit: 'EXIT_ZZZ' }], ['EXIT_ZZZ']).length === 0,
  routesAffectedByExits([{ id: 'i3', exit: 'EXIT_ZZZ' }], ['EXIT_ZZZ']))
check('⚠️ filterExitNodeIds：裸 key 集合入参正确命中',
  JSON.stringify(filterExitNodeIds([F_W, F_E], [K_W])) === JSON.stringify([F_W]),
  filterExitNodeIds([F_W, F_E], [K_W]))

// ── 20.6 出口恢复：已失效路线不复活（裸 key 形式同样适用）──
const recOut = applyExitInvalidation({
  routePlans: [{ id: 'j1', exit: K_E, status: PLAN_STATUS.NORMAL }],
  perZone: { 'R区': { plans: [{ id: 'j1', exit: K_E, status: PLAN_STATUS.NORMAL }], recommendedId: 'j1', backupId: null } },
  usableNodeIds: [F_W],
  activeRoutePlanId: 'j1',
})
check('⚠️ 裸 key 路线走已关闭出口 → 被标记 BLOCKED',
  recOut.routePlans[0].status === PLAN_STATUS.BLOCKED, recOut.routePlans[0].status)
const recBack = applyExitInvalidation({
  routePlans: recOut.routePlans,
  perZone: recOut.perZone,
  usableNodeIds: [F_W, F_E],
  activeRoutePlanId: 'j1',
})
check('⚠️ 出口恢复后已失效路线不自动复活（仍 BLOCKED）',
  recBack.routePlans[0].status === PLAN_STATUS.BLOCKED, recBack.routePlans[0].status)
check('⚠️ 出口恢复后仍不被推荐',
  recBack.perZone['R区'].recommendedId === null, recBack.perZone['R区'].recommendedId)

// ── 20.7 DONE 在裸形式下同样保持完成状态、不被删除、不参与推荐 ──
;[[K_W, '可用出口'], [K_E, '已关闭出口']].forEach(([exitId, desc]) => {
  const doneOut2 = applyExitInvalidation({
    routePlans: [{ id: 'd1', exit: exitId, status: PLAN_STATUS.DONE }],
    perZone: { 'D区': { plans: [{ id: 'd1', exit: exitId, status: PLAN_STATUS.DONE }], recommendedId: 'd1', backupId: null } },
    usableNodeIds: [F_W],
    activeRoutePlanId: 'd1',
  })
  check(`⚠️ 裸形式 / DONE / ${desc} → 状态保持 DONE（未被改写为 BLOCKED）`,
    doneOut2.routePlans[0].status === PLAN_STATUS.DONE, doneOut2.routePlans[0].status)
  check(`⚠️ 裸形式 / DONE / ${desc} → perZone 同样保持 DONE`,
    doneOut2.perZone['D区'].plans[0].status === PLAN_STATUS.DONE,
    doneOut2.perZone['D区'].plans[0].status)
  check(`⚠️ 裸形式 / DONE / ${desc} → 不被推荐（recommendedId 置 null）`,
    doneOut2.perZone['D区'].recommendedId === null, doneOut2.perZone['D区'].recommendedId)
  check(`⚠️ 裸形式 / DONE / ${desc} → 路线未被删除（数组长度保持）`,
    doneOut2.routePlans.length === 1, doneOut2.routePlans.length)
})

// ── 20.8 ★ 原始缺陷的投影级复现：推荐 / 备用 / 当前选中与 routePlans 一致 ──
// 【P2-1 全局策略 B 修订】原用例未传 `exits` ⇒ reason='missing'。按策略 B，
//   missing 时声明集**不得**单独放行 ⇒ 该输入下 k1 将被判 BLOCKED、recommendedId 与
//   activeRoutePlanId 变为 null，本用例的 N1 原意（裸 key 路线可被正确识别）
//   **无法**在此输入下体现。故显式提供真实上报来源（全 OPEN 运行态），并保留
//   `usableNodeIds: [F_W]` 以继续覆盖「上报集 ∩ 声明集」。
//   ⇒ 原意完整保留；「缺 exits + 已声明」分支的覆盖交由下方 [25] 组接管。
const reproReported = EXIT_DEFS.map((e) => ({ ...e, available: true, status: EXIT_STATUS.OPEN }))
const reproOut = applyExitInvalidation({
  routePlans: [{ id: 'k1', exit: K_W, status: PLAN_STATUS.NORMAL }],
  perZone: { 'K区': { plans: [{ id: 'k1', exit: K_W, status: PLAN_STATUS.NORMAL }], recommendedId: 'k1', backupId: null } },
  exits: reproReported,
  usableNodeIds: [F_W],
  activeRoutePlanId: 'k1',
})
check('⚠️ [原始缺陷] 裸 key 路线 status 保持 NORMAL',
  reproOut.routePlans[0].status === PLAN_STATUS.NORMAL, reproOut.routePlans[0].status)
check('⚠️ [原始缺陷] recommendedId 不得为 null（修复前为 null）',
  reproOut.perZone['K区'].recommendedId === 'k1', reproOut.perZone['K区'].recommendedId)
check('⚠️ [原始缺陷] activeRoutePlanId 不得被改选为 null（修复前为 null）',
  reproOut.activeRoutePlanId === 'k1', reproOut.activeRoutePlanId)
check('⚠️ [原始缺陷] exits 与 exitNodeIds 一致',
  JSON.stringify(reproOut.exits.map((e) => e.nodeId))
    === JSON.stringify(reproOut.exitNodeIds),
  [reproOut.exits.map((e) => e.nodeId), reproOut.exitNodeIds])

// ══════════════════════════════════════
console.log('\n[21] 第三批补充修复：blockAll×DONE / 降级可见 / 输出同源 / 入参对称')
console.log('     P2-1: blockAll 不得绕过 DONE 终态保护')
console.log('     P2-2: exitNodeIds 与 exits 同源；冲突仅暴露，不裁定优先级')
console.log('     P2-3: exitStates 透出降级信息')
console.log('     P3  : 三种形式取自真实 EXIT_DEFS；filterExitNodeIds 入参对称')
// ══════════════════════════════════════
const OPEN_EXITS = EXIT_DEFS.map((e) => ({ ...e, available: true, status: EXIT_STATUS.OPEN }))
// 东出口关闭、西出口可用的运行态（用于「两入参一致」场景）
const E_CLOSED = EXIT_DEFS.map((e) => ({
  ...e,
  available: e.nodeId === F_W,
  status: e.nodeId === F_W ? EXIT_STATUS.OPEN : EXIT_STATUS.CLOSED,
}))
// 与上者相反：西出口关闭、东出口可用（用于「两入参矛盾」场景）
const W_CLOSED = EXIT_DEFS.map((e) => ({
  ...e,
  available: e.nodeId === F_E,
  status: e.nodeId === F_E ? EXIT_STATUS.OPEN : EXIT_STATUS.CLOSED,
}))

// ── 21.1 P3-3：三种形式取自真实 EXIT_DEFS，且均解析到同一规范 nodeId ──
check('⚠️ P3-3 规范 nodeId 与 裸 key 是不同字符串（否则多形式用例退化为重复样例）',
  F_W !== K_W && F_E !== K_E, { F_W, K_W })
check('⚠️ P3-3 裸 key / 裸 id 均从 EXIT_DEFS **独立**读取且非空',
  typeof K_W === 'string' && K_W.length > 0
  && typeof I_W === 'string' && I_W.length > 0, { K_W, I_W })
;[[F_W, '规范 nodeId'], [K_W, '裸 key'], [I_W, '裸 id']].forEach(([id, label]) => {
  check(`⚠️ P3-3 ${label} → 解析为规范 nodeId（EXIT_BY_ID 已补齐，不再依赖 id===key 的巧合）`,
    resolveRouteExitNodeId({ exit: id }) === F_W, resolveRouteExitNodeId({ exit: id }))
})

// ── 21.2 P2-1：blockAll 三种情况下 DONE 均保持 DONE、不进入 affected、不被删除 ──
;[
  ['usableNodeIds=[]（自动 blockAll）', { usableNodeIds: [] }],
  ['显式 blockAll=true', { usableNodeIds: [F_W], blockAll: true }],
  ['普通出口变化（非 blockAll）', { usableNodeIds: [F_W] }],
].forEach(([label, extra]) => {
  const donePlan = { id: 'd1', exit: F_E, status: PLAN_STATUS.DONE }
  const normalPlan = { id: 'n1', exit: F_E, status: PLAN_STATUS.NORMAL }
  const out = applyExitInvalidation({
    routePlans: [donePlan, normalPlan],
    perZone: {
      'B区': {
        plans: [{ ...donePlan }, { ...normalPlan }],
        recommendedId: 'd1', backupId: null,
      },
    },
    exits: E_CLOSED,
    activeRoutePlanId: 'd1',
    ...extra,
  })
  check(`⚠️ P2-1 ${label} → DONE 保持 DONE（不被改写为 BLOCKED）`,
    out.routePlans[0].status === PLAN_STATUS.DONE, out.routePlans[0].status)
  check(`⚠️ P2-1 ${label} → perZone 中 DONE 同样保持`,
    out.perZone['B区'].plans[0].status === PLAN_STATUS.DONE, out.perZone['B区'].plans[0].status)
  check(`⚠️ P2-1 ${label} → DONE 不进入 affectedRouteIds`,
    !out.affectedRouteIds.includes('d1'), out.affectedRouteIds)
  check(`⚠️ P2-1 ${label} → DONE 记录未被删除（两个投影长度均保持）`,
    out.routePlans.length === 2 && out.perZone['B区'].plans.length === 2,
    [out.routePlans.length, out.perZone['B区'].plans.length])
  check(`⚠️ P2-1 ${label} → DONE 不被推荐、不被选中`,
    out.perZone['B区'].recommendedId !== 'd1' && out.activeRoutePlanId !== 'd1',
    { rec: out.perZone['B区'].recommendedId, active: out.activeRoutePlanId })
  check(`⚠️ P2-1 ${label} → 非 DONE 路线仍按既有逻辑失效（未误伤）`,
    out.routePlans[1].status === PLAN_STATUS.BLOCKED, out.routePlans[1].status)
})
check('⚠️ P2-1 函数级：blockAll=true 时 DONE 仍返回 false（终态保护先于 blockAll）',
  shouldInvalidateByExits({ id: 'd', exit: F_W, status: PLAN_STATUS.DONE }, [F_W], { blockAll: true }) === false)
check('⚠️ P2-1 函数级：blockAll=true 时 NORMAL / BLOCKED 仍返回 true（未误伤其他状态）',
  shouldInvalidateByExits({ id: 'n', exit: F_W, status: PLAN_STATUS.NORMAL }, [F_W], { blockAll: true }) === true
  && shouldInvalidateByExits({ id: 'b', exit: F_W, status: PLAN_STATUS.BLOCKED }, [F_W], { blockAll: true }) === true)

// ── 21.3 P2-3：出口状态缺失 / 部分 / 重复 时降级信息必须可见 ──
const noExits = applyExitInvalidation({ usableNodeIds: [F_W] })
check('⚠️ P2-3 不传 exits → exitStates.degraded=true（修复前该信息被整体丢弃）',
  noExits.exitStates.degraded === true, noExits.exitStates)
check('⚠️ P2-3 不传 exits → exitStates.reason=missing（可与「确实可用」区分）',
  noExits.exitStates.reason === 'missing', noExits.exitStates.reason)
const fullOut = applyExitInvalidation({ exits: OPEN_EXITS, usableNodeIds: [F_W] })
check('⚠️ P2-3 完整一致的 exits → degraded=false / reason=null',
  fullOut.exitStates.degraded === false && fullOut.exitStates.reason === null, fullOut.exitStates)
const partialOut = applyExitInvalidation({
  exits: [{ nodeId: F_W, available: true, status: EXIT_STATUS.OPEN }],
  usableNodeIds: [F_W],
})
check('⚠️ P2-3 部分下发 → degraded=true / reason=partial',
  partialOut.exitStates.degraded === true && partialOut.exitStates.reason === 'partial',
  partialOut.exitStates)
const dupOut = applyExitInvalidation({
  exits: [
    { nodeId: F_W, available: false, status: EXIT_STATUS.CLOSED },
    { nodeId: F_W, available: true, status: EXIT_STATUS.OPEN },
  ],
  usableNodeIds: [F_W],
})
check('⚠️ P2-3 重复且矛盾 → degraded=true / duplicate=true（保守合并仍生效）',
  dupOut.exitStates.degraded === true && dupOut.exitStates.duplicate === true, dupOut.exitStates)
check('⚠️ P2-3 新增字段为**纯新增**，既有返回字段语义与存在性不变',
  Array.isArray(noExits.routePlans) && Array.isArray(noExits.perZone && Object.keys(noExits.perZone))
  && Array.isArray(noExits.exits) && Array.isArray(noExits.exitNodeIds)
  && Array.isArray(noExits.affectedRouteIds) && typeof noExits.blockedAll === 'boolean'
  && 'activeRoutePlanId' in noExits,
  Object.keys(noExits))

// ── 21.4 P2-2：两个展示输出改为同源；冲突仅暴露，不裁定优先级 ──
const sameSrc = applyExitInvalidation({ exits: OPEN_EXITS, usableNodeIds: [F_W, F_E] })
check('⚠️ P2-2 未传 exitNodeIds → exitNodeIds 恒等于 exits 的 nodeId 列表（同源）',
  JSON.stringify(sameSrc.exitNodeIds) === JSON.stringify(sameSrc.exits.map((e) => e.nodeId)),
  [sameSrc.exitNodeIds, sameSrc.exits.map((e) => e.nodeId)])
const narrowed = applyExitInvalidation({ exits: OPEN_EXITS, usableNodeIds: [F_W, F_E], exitNodeIds: [F_W] })
check('⚠️ P2-2 传入部分 exitNodeIds → 仅作收窄，恒为 exits 的子集（不再各自取不同候选池）',
  JSON.stringify(narrowed.exitNodeIds) === JSON.stringify([F_W]) && narrowed.exits.length === 2,
  [narrowed.exitNodeIds, narrowed.exits.map((e) => e.nodeId)])
// ★ 该项在修复**前**会失败：修复前 exitNodeIds = filter(input.exitNodeIds, usable)，
//   未知名 id 只要同时出现在两个入参中就会被**原样输出**，形成「假可用出口」。
const unknownIdOut = applyExitInvalidation({
  exits: OPEN_EXITS, usableNodeIds: [F_W, 'EXIT_ZZZ'], exitNodeIds: [F_W, 'EXIT_ZZZ'],
})
check('⚠️ P2-2 未知名出口 id 同时出现在两个入参 → exitNodeIds 不得输出它（修复前原样输出）',
  !unknownIdOut.exitNodeIds.includes('EXIT_ZZZ'), unknownIdOut.exitNodeIds)
const agree = applyExitInvalidation({ exits: E_CLOSED, usableNodeIds: [F_W] })
check('⚠️ P2-2 两入参一致 → exitsConflict 为空',
  agree.exitsConflict.length === 0, agree.exitsConflict)
const disagree = applyExitInvalidation({ exits: W_CLOSED, usableNodeIds: [F_W] })
check('⚠️ P2-2 两入参矛盾 → exitsConflict 非空且为**双向对称差**',
  disagree.exitsConflict.includes(F_W) && disagree.exitsConflict.includes(F_E),
  disagree.exitsConflict)
// 【第四批 · D1 已批准】冲突时按**保守取交集**处置（行为**已变更**）：
//   exits 可用集={E}，usableNodeIds={W} ⇒ 交集为空 ⇒ 无可用出口 ⇒ 整批失效（fail-closed）。
//   修复前以 usableNodeIds 为准 ⇒ exitNodeIds=[F_W]、仅 pe 失效；修复后 pw 与 pe 均失效，
//   而 DONE 路线**仍保持 DONE**（终态保护，不受影响）。
check('⚠️ P2-2 D1 已批准：冲突时保守取交集 ⇒ 无共同可用出口 ⇒ 整批失效',
  disagree.blockedAll === true
  && JSON.stringify(disagree.exits) === JSON.stringify([])
  && JSON.stringify(disagree.exitNodeIds) === JSON.stringify([]),
  { blockedAll: disagree.blockedAll, exits: disagree.exits, exitNodeIds: disagree.exitNodeIds })
const noExitsConflict = applyExitInvalidation({ usableNodeIds: [F_W] })
check('⚠️ P2-2 未传 exits（静态默认回落）→ 不误报冲突',
  noExitsConflict.exitsConflict.length === 0, noExitsConflict.exitsConflict)

// ── 21.5 P3-1：filterExitNodeIds 两侧入参归一化对称 ──
check('⚠️ P3-1 ids 侧裸 key × usable 侧规范 nodeId → 正确命中（修复前返回 []）',
  JSON.stringify(filterExitNodeIds([K_W, K_E], [F_W])) === JSON.stringify([F_W]),
  filterExitNodeIds([K_W, K_E], [F_W]))
check('⚠️ P3-1 ids 侧规范 nodeId × usable 侧裸 key → 同样命中（双向对称）',
  JSON.stringify(filterExitNodeIds([F_W, F_E], [K_W])) === JSON.stringify([F_W]),
  filterExitNodeIds([F_W, F_E], [K_W]))
check('⚠️ P3-1 两侧均为裸 key → 命中',
  JSON.stringify(filterExitNodeIds([K_W, K_E], [K_W])) === JSON.stringify([F_W]),
  filterExitNodeIds([K_W, K_E], [K_W]))
check('⚠️ P3-1 未知标识不产生命中（保留原值，不静默猜测为已知出口）',
  filterExitNodeIds(['EXIT_ZZZ'], [F_W]).length === 0, filterExitNodeIds(['EXIT_ZZZ'], [F_W]))
check('⚠️ P3-1 剔除 null / undefined / 空串',
  filterExitNodeIds([null, undefined, ''], [F_W]).length === 0,
  filterExitNodeIds([null, undefined, ''], [F_W]))

// ══════════════════════════════════════
console.log('\n[22] 第四批（G-2）：exits / usableNodeIds 输入组合全覆盖矩阵')
console.log('     T1 仅 exits｜T5 两者均缺失｜T6a/T6b 未知标识｜T7a 部分缺失')
console.log('     D1 保守取交集（已批准）｜D2 partial 不算冲突（已批准）')
// ══════════════════════════════════════
const plans3 = () => [
  { id: 'pw', exit: F_W, status: PLAN_STATUS.NORMAL },
  { id: 'pe', exit: F_E, status: PLAN_STATUS.NORMAL },
  { id: 'pd', exit: F_E, status: PLAN_STATUS.DONE },
]

// ── T1 仅提供 exits：D4 已批准 ⇒ 由 exits 派生 usable，不再静默全量失效 ──
const onlyExits = applyExitInvalidation({ routePlans: plans3(), exits: OPEN_EXITS })
check('⚠️ G-2 T1 仅提供 exits（全 OPEN）→ exits 输出全部出口（修复前为 []）',
  JSON.stringify(onlyExits.exits.map((e) => e.nodeId)) === JSON.stringify([F_W, F_E]),
  onlyExits.exits.map((e) => e.nodeId))
check('⚠️ G-2 T1 → exitNodeIds 与 exits 同源',
  JSON.stringify(onlyExits.exitNodeIds) === JSON.stringify([F_W, F_E]),
  onlyExits.exitNodeIds)
check('⚠️ G-2 T1 → 全出口可用 ⇒ 无路线失效（修复前 affected=["pw","pe"]）',
  JSON.stringify(onlyExits.affectedRouteIds) === JSON.stringify([]),
  onlyExits.affectedRouteIds)
check('⚠️ G-2 T1 → blockedAll=false（修复前为 true）',
  onlyExits.blockedAll === false, onlyExits.blockedAll)
check('⚠️ G-2 T1 → exitStates 未降级（degraded=false / reason=null）',
  onlyExits.exitStates.degraded === false && onlyExits.exitStates.reason === null,
  onlyExits.exitStates)
check('⚠️ G-2 T1 → 未提供 usableNodeIds ⇒ 不判定为入参冲突',
  JSON.stringify(onlyExits.exitsConflict) === JSON.stringify([]), onlyExits.exitsConflict)
check('⚠️ G-2 T1 → DONE 仍保持 DONE 且不进 affected',
  onlyExits.routePlans[2].status === PLAN_STATUS.DONE
  && !onlyExits.affectedRouteIds.includes('pd'), onlyExits.routePlans[2].status)

// ── T5 两者均缺失 ⇒ fail-closed（整批失效），且降级可见 ──
const bothMissing = applyExitInvalidation({ routePlans: plans3() })
check('⚠️ G-2 T5 两者均缺失 → blockedAll=true（fail-closed，保持既有行为）',
  bothMissing.blockedAll === true, bothMissing.blockedAll)
check('⚠️ G-2 T5 → 所有非 DONE 路线失效',
  JSON.stringify(bothMissing.affectedRouteIds) === JSON.stringify(['pw', 'pe']),
  bothMissing.affectedRouteIds)
check('⚠️ G-2 T5 → exits 与 exitNodeIds 同源（均为空）',
  JSON.stringify(bothMissing.exits) === JSON.stringify([])
  && JSON.stringify(bothMissing.exitNodeIds) === JSON.stringify([]), bothMissing.exits)
check('⚠️ G-2 T5 → 降级可见：degraded=true / reason=missing',
  bothMissing.exitStates.degraded === true && bothMissing.exitStates.reason === 'missing',
  bothMissing.exitStates)
check('⚠️ G-2 T5 → DONE 不被改写为 BLOCKED',
  bothMissing.routePlans[2].status === PLAN_STATUS.DONE, bothMissing.routePlans[2].status)

// ── T6a / T6b：未知出口标识不产生「假可用」 ──
const unknownRoute = applyExitInvalidation({
  routePlans: [{ id: 'pz', exit: 'EXIT_ZZZ', status: PLAN_STATUS.NORMAL }],
  exits: OPEN_EXITS,
  usableNodeIds: [F_W],
})
check('⚠️ G-2 T6a 路线侧未知出口 → 该路线失效（不产生假可用）',
  JSON.stringify(unknownRoute.affectedRouteIds) === JSON.stringify(['pz']),
  unknownRoute.affectedRouteIds)
check('⚠️ G-2 T6a → exits / exitNodeIds 不受未知标识污染',
  JSON.stringify(unknownRoute.exits.map((e) => e.nodeId)) === JSON.stringify([F_W])
  && JSON.stringify(unknownRoute.exitNodeIds) === JSON.stringify([F_W]),
  [unknownRoute.exits.map((e) => e.nodeId), unknownRoute.exitNodeIds])
const unknownUsable = applyExitInvalidation({
  routePlans: plans3(), exits: OPEN_EXITS, usableNodeIds: ['EXIT_ZZZ'],
})
check('⚠️ G-2 T6b 集合侧未知出口 → exitNodeIds 不得输出该未知 id',
  !unknownUsable.exitNodeIds.includes('EXIT_ZZZ'), unknownUsable.exitNodeIds)
check('⚠️ G-2 T6b → exitsConflict 双向暴露该未知标识',
  unknownUsable.exitsConflict.includes('EXIT_ZZZ')
  && unknownUsable.exitsConflict.includes(F_W)
  && unknownUsable.exitsConflict.includes(F_E), unknownUsable.exitsConflict)

// ── T7a：部分下发 ⇒ degraded/partial 可见；D2 已批准：partial 不算入参冲突 ──
const partialOnly = applyExitInvalidation({
  routePlans: plans3(),
  exits: [{ ...D_W, available: true, status: EXIT_STATUS.OPEN }],
  usableNodeIds: [F_W],
})
check('⚠️ G-2 T7a 部分下发 → 降级可见：degraded=true / reason=partial / partial=true',
  partialOnly.exitStates.degraded === true
  && partialOnly.exitStates.reason === 'partial'
  && partialOnly.exitStates.partial === true, partialOnly.exitStates)
check('⚠️ G-2 T7a → D2 已批准：partial 不算「入参冲突」⇒ exitsConflict=[]（修复前为 [E]）',
  JSON.stringify(partialOnly.exitsConflict) === JSON.stringify([]),
  partialOnly.exitsConflict)
check('⚠️ G-2 T7a → 未声明可用的出口其路线失效',
  JSON.stringify(partialOnly.affectedRouteIds) === JSON.stringify(['pe']),
  partialOnly.affectedRouteIds)

// ══════════════════════════════════════
console.log('\n[23] P1-1：exits 派生守卫 —— 「非空但零条可解析」必须 fail-closed')
console.log('     守卫由 exitsIn.length > 0 收紧为 norm.reason ∉ {missing, invalid}')
// ══════════════════════════════════════

// ── A. 完全无效输入 ─────────────────────────────────────────────
// 修复前：exits 数组非空 ⇒ 认为「确实提供了 exits」⇒ 由 normalizeExitStates
// 的 usableNodeIds 派生。而此时该函数已回落静态默认（全 OPEN），
// usableNodeIds 全部为本批次未上报的**虚构可用集** ⇒
// blockedAll=false / affected=[] / exits 输出两个真实出口 ⇒ **fail-open**。
const P1_INVALID = [
  ['对象结构非法 [{foo:1}]', [{ foo: 1 }]],
  ['未知 nodeId [{nodeId:ZZZ}]', [{ nodeId: '1F:EXIT_ZZZ', available: true, status: EXIT_STATUS.OPEN }]],
  ['混合标量 [null,"x",42]', [null, 'x', 42]],
]
P1_INVALID.forEach(([label, exits]) => {
  const o = applyExitInvalidation({ routePlans: plans3(), exits })
  check('⚠️ P1-1 ' + label + ' → blockedAll=true（修复前 false ⇒ fail-open）',
    o.blockedAll === true, o.blockedAll)
  check('⚠️ P1-1 ' + label + ' → 所有非 DONE 路线失效（fail-closed）',
    JSON.stringify(o.affectedRouteIds) === JSON.stringify(['pw', 'pe']), o.affectedRouteIds)
  check('⚠️ P1-1 ' + label + ' → exits / exitNodeIds 均为空（不输出伪造可用出口，修复前为两项）',
    JSON.stringify(o.exits) === JSON.stringify([]) && JSON.stringify(o.exitNodeIds) === JSON.stringify([]),
    [o.exits.map((e) => e.nodeId), o.exitNodeIds])
  check('⚠️ P1-1 ' + label + ' → DONE 仍保持 DONE 且不进 affected',
    o.routePlans[2].status === PLAN_STATUS.DONE && !o.affectedRouteIds.includes('pd'),
    [o.routePlans[2].status, o.affectedRouteIds])
  check('⚠️ P1-1 ' + label + ' → 降级可见：reason=invalid / degraded=true',
    o.exitStates.reason === 'invalid' && o.exitStates.degraded === true, o.exitStates)
})

// ── B. 混合输入：部分有效 ⇒ **不一并判为无效**，按实际规范化结果派生 ──
const mixOpen = applyExitInvalidation({
  routePlans: plans3(),
  exits: [{ foo: 1 }, { nodeId: F_W, available: true, status: EXIT_STATUS.OPEN }],
})
check('⚠️ P1-1 混合（垃圾 + W OPEN）→ reason=partial，不判为 invalid',
  mixOpen.exitStates.reason === 'partial', mixOpen.exitStates)
check('⚠️ P1-1 混合 → 已上报且有效的 W 路线保持 NORMAL',
  mixOpen.routePlans[0].status === PLAN_STATUS.NORMAL, mixOpen.routePlans[0].status)
// 【P2-1 策略 B · 已批准】未上报的 E 一律视为不可用
check('⚠️ P2-1 B 混合（垃圾 + W OPEN）→ 未上报的 E 不输出（exits 仅 [W]）',
  JSON.stringify(mixOpen.exits.map((e) => e.nodeId)) === JSON.stringify([F_W]),
  mixOpen.exits.map((e) => e.nodeId))
check('⚠️ P2-1 B 混合（垃圾 + W OPEN）→ 未上报出口的路线失效 ⇒ pe BLOCKED',
  JSON.stringify(mixOpen.affectedRouteIds) === JSON.stringify(['pe']), mixOpen.affectedRouteIds)
const mixClosed = applyExitInvalidation({
  routePlans: plans3(),
  exits: [{ foo: 1 }, { nodeId: F_W, available: false, status: EXIT_STATUS.CLOSED }],
})
// 策略 B：W 已上报但 CLOSED，E 未上报 ⇒ 派生集为空 ⇒ 整批失效（fail-closed）
check('⚠️ P2-1 B 混合（垃圾 + W CLOSED）→ 上报的关闭被采纳 + 未上报的 E 不可用 ⇒ 全失效',
  JSON.stringify(mixClosed.affectedRouteIds) === JSON.stringify(['pw', 'pe']), mixClosed.affectedRouteIds)
check('⚠️ P2-1 B 混合（垃圾 + W CLOSED）→ blockedAll=true（派生集为空）',
  mixClosed.blockedAll === true, mixClosed.blockedAll)
check('⚠️ P2-1 B 混合（垃圾 + W CLOSED）→ DONE 仍保持 DONE 且不进 affected',
  mixClosed.routePlans[2].status === PLAN_STATUS.DONE && !mixClosed.affectedRouteIds.includes('pd'),
  [mixClosed.routePlans[2].status, mixClosed.affectedRouteIds])
// ── B2. 重复上报（duplicate，M17）：仍算「已上报」，按保守合并取「任一不可用 ⇒ 不可用」 ──
const mixDup = applyExitInvalidation({
  routePlans: plans3(),
  exits: [
    { nodeId: F_W, available: true, status: EXIT_STATUS.OPEN },
    { nodeId: F_W, available: false, status: EXIT_STATUS.CLOSED },
  ],
})
check('⚠️ P2-1 B 重复（W OPEN + W CLOSED）→ reason=duplicate，仍算已上报（不判 invalid）',
  mixDup.exitStates.reason === 'duplicate' && mixDup.exitStates.duplicate === true, mixDup.exitStates)
check('⚠️ P2-1 B 重复 → 保守合并 ⇒ W 不可用；E 未上报 ⇒ 也不可用 ⇒ 全失效',
  JSON.stringify(mixDup.affectedRouteIds) === JSON.stringify(['pw', 'pe']), mixDup.affectedRouteIds)
check('⚠️ P2-1 B 重复 → DONE 不受影响',
  mixDup.routePlans[2].status === PLAN_STATUS.DONE && !mixDup.affectedRouteIds.includes('pd'),
  [mixDup.routePlans[2].status, mixDup.affectedRouteIds])
// ── B3. reportedUsableNodeIds（策略 B 的契约新增字段） ──
check('⚠️ P2-1 B 完整下发 → reportedUsableNodeIds 与 usableNodeIds 恒等',
  JSON.stringify(normalizeExitStates(OPEN_EXITS).reportedUsableNodeIds)
  === JSON.stringify(normalizeExitStates(OPEN_EXITS).usableNodeIds),
  normalizeExitStates(OPEN_EXITS).reportedUsableNodeIds)
check('⚠️ P2-1 B 部分下发 → reportedUsableNodeIds 只含已上报项（不含补齐的 E）',
  JSON.stringify(normalizeExitStates([{ nodeId: F_W, available: true, status: EXIT_STATUS.OPEN }]).reportedUsableNodeIds)
  === JSON.stringify([F_W]))
check('⚠️ P2-1 B missing / invalid → reportedUsableNodeIds 恒为空（fail-closed）',
  JSON.stringify(normalizeExitStates().reportedUsableNodeIds) === JSON.stringify([])
  && JSON.stringify(normalizeExitStates([{ foo: 1 }]).reportedUsableNodeIds) === JSON.stringify([]))
const mixUnknown = applyExitInvalidation({
  routePlans: plans3(),
  exits: [{ foo: 1 }, ...OPEN_EXITS, { key: '1F:EXIT_ZZZ', available: true, status: EXIT_STATUS.OPEN }],
})
check('⚠️ P1-1 混合（垃圾 + 完整 exits + 未知 key）→ reason=unknown 仍派生，不判为无效',
  mixUnknown.exitStates.reason === 'unknown' && mixUnknown.blockedAll === false,
  [mixUnknown.exitStates.reason, mixUnknown.blockedAll])

// ── C. 回归守卫：既有已批准行为不得被本次修复改变 ──
check('⚠️ P1-1 回归守卫 → 仅提供有效全 OPEN exits ⇒ D4 派生不变（blockedAll=false）',
  applyExitInvalidation({ routePlans: plans3(), exits: OPEN_EXITS }).blockedAll === false)
check('⚠️ P1-1 回归守卫 → 两者均缺失 ⇒ fail-closed 不变',
  applyExitInvalidation({ routePlans: plans3() }).blockedAll === true)
// ⚠️【旧行为已废止】此前该组合为「仅 E 路线失效 affected=['pe']」，其依据是 D1 的
//   「missing / invalid ⇒ 退化为声明集单方」分支。该分支已由 **P2-1 全局策略 B** 取代：
//   声明集只能**收窄**可用集，**不得**单独放行出口 ⇒ 无 exits 且 reason=missing
//   ⇒ 有效可用集为空 ⇒ 非 DONE 整批失效。旧行为自本批次起废止；新规则由本断言保护，
//   「缺 exits + 已声明」的四种组合由下方 [25] 组全覆盖。
check('⚠️ P2-1 / 策略 B：仅 usableNodeIds=[W] 且无 exits ⇒ 有效可用集为空 ⇒ pw/pe 均失效（旧行为「仅 E 失效」已废止）',
  JSON.stringify(applyExitInvalidation({ routePlans: plans3(), usableNodeIds: [F_W] }).affectedRouteIds)
  === JSON.stringify(['pw', 'pe']),
  applyExitInvalidation({ routePlans: plans3(), usableNodeIds: [F_W] }).affectedRouteIds)
const p1D1 = applyExitInvalidation({ routePlans: plans3(), exits: OPEN_EXITS, usableNodeIds: [F_W] })
check('⚠️ P1-1 回归守卫 → D1 保守交集不变（exits 输出仅 [W]，E 路线失效）',
  JSON.stringify(p1D1.exits.map((e) => e.nodeId)) === JSON.stringify([F_W])
  && JSON.stringify(p1D1.affectedRouteIds) === JSON.stringify(['pe']),
  [p1D1.exits.map((e) => e.nodeId), p1D1.affectedRouteIds])

// ══════════════════════════════════════
console.log('\n[24] 集合恒等判据 = partial（P2-3 补充；不得用 reason 判定）')
// ══════════════════════════════════════
// 集合语义：`usableExitNodeIds` 为 filter → map → filter(Boolean)，**无去重步骤**；
//   reported 侧由 Map 分组恒唯一，usable 侧唯一性依赖「EXIT_DEFS[].nodeId 唯一」
//   ⇒ 一律按**集合**比较，不锁数组顺序（元素顺序属实现观察行为，非契约）。
const sameSet = (a, b) => {
  const A = new Set((a || []).map(String))
  const B = new Set((b || []).map(String))
  return A.size === B.size && [...A].every((x) => B.has(x))
}
const mkSetPool = () => [
  { nodeId: F_W, available: true, status: EXIT_STATUS.OPEN },
  { nodeId: F_W, available: false, status: EXIT_STATUS.CLOSED },
  { key: K_E, available: true, status: EXIT_STATUS.OPEN },
  { nodeId: F_E, available: false, status: EXIT_STATUS.BLOCKED },
  { key: 'EXIT_ZZZ', available: true, status: EXIT_STATUS.OPEN },
  { foo: 1 }, null,
]
const mkSetSeqs = () => {
  const p = mkSetPool()
  const s = [[]]
  p.forEach((a) => s.push([a]))
  p.forEach((a) => p.forEach((b) => s.push([a, b])))
  p.forEach((a) => p.forEach((b) => p.forEach((c) => s.push([a, b, c]))))
  return s
}
const SET_SEQS = mkSetSeqs()
const STATIC_AVAIL = new Set(
  defaultExitStates().filter((e) => e.available).map((e) => String(e.nodeId)),
)
let vDup = 0, vSubset = 0, vEqual = 0, vDiff = 0
let dupCase = null, subsetCase = null, eqCase = null, diffCase = null
SET_SEQS.forEach((seq) => {
  const r = normalizeExitStates(seq)
  const U = r.usableNodeIds.map(String)
  const R = r.reportedUsableNodeIds.map(String)
  const USet = new Set(U)
  const RSet = new Set(R)
  // T0 唯一性：两集合自身均无重复元素（usable 侧无去重步骤，须显式守卫）
  if (USet.size !== U.length || RSet.size !== R.length) {
    vDup += 1
    if (!dupCase) dupCase = {
      input: JSON.parse(JSON.stringify(seq)),
      usableNodeIds: U,
      reportedUsableNodeIds: R,
      dupInUsable: U.filter((x, i) => U.indexOf(x) !== i),
      dupInReported: R.filter((x, i) => R.indexOf(x) !== i),
    }
  }
  // T1 子集不变式：reported ⊆ usable。
  //   首个失败样本须含「不属于 usable 集合的元素」，以便直接定位违反包含关系的成员。
  const offenders = R.filter((x) => !U.includes(x))
  if (offenders.length) {
    vSubset += 1
    if (!subsetCase) subsetCase = {
      input: JSON.parse(JSON.stringify(seq)),
      usableNodeIds: U,
      reportedUsableNodeIds: R,
      notInUsable: offenders,
      partial: r.partial,
      reason: r.reason,
    }
  }
  // T2 恒等判据：两集合恒等 ⇔ partial === false
  const eq = USet.size === RSet.size && [...USet].every((x) => RSet.has(x))
  if (eq !== !r.partial) {
    vEqual += 1
    if (!eqCase) eqCase = {
      input: JSON.parse(JSON.stringify(seq)),
      partial: r.partial,
      usableNodeIds: U,
      reportedUsableNodeIds: R,
    }
  }
  // T3a 差集公式：usable \ reported === 未上报出口 ∩ 静态可用出口
  const diff = [...USet].filter((x) => !RSet.has(x))
  const hit = new Set(seq.map((raw) => {
    const k = resolveExitKey(raw)
    return k ? String(k.nodeId) : null
  }).filter(Boolean))
  const expected = EXIT_DEFS
    .filter((d) => !hit.has(String(d.nodeId)) && STATIC_AVAIL.has(String(d.nodeId)))
    .map((d) => String(d.nodeId))
  if (!sameSet(diff, expected)) {
    vDiff += 1
    if (!diffCase) diffCase = {
      input: JSON.parse(JSON.stringify(seq)),
      diff,
      expected,
    }
  }
})
check('⚠️ P2-3 T0 唯一性：两集合均无重复元素（usableExitNodeIds 无去重步骤，须显式守卫）',
  vDup === 0, dupCase)
check('⚠️ P2-3 T1 子集不变式：reported ⊆ usable（集合语义）',
  vSubset === 0, subsetCase)
check('⚠️ P2-3 T2 恒等判据：两集合恒等 ⇔ partial === false',
  vEqual === 0, eqCase)
// T3a 只验证**差集公式**：静态默认变化时它**不会**失败 ⇒ 必须与 T3b 并存。
check('⚠️ P2-3 T3a 差集公式：usable \\ reported === 未上报出口 ∩ 静态可用出口',
  vDiff === 0, diffCase)
// T3b 是不变式③的**前提断言**：静态默认改为不可用时应**本条先失败**（T2 同时失败），
//   而 T3a 仍通过 ⇒ T3a 不能替代 T3b。
check('⚠️ P2-2 T3b 不变式③前提：静态默认出口全部 available=true 且 status=OPEN',
  defaultExitStates().every((e) => e.available === true && e.status === EXIT_STATUS.OPEN),
  defaultExitStates().map((e) => [String(e.nodeId), e.available, e.status]))

// T4 duplicate + 全覆盖 ⇒ 仍恒等（reason='duplicate' 不可反推差异）
const dupFull = normalizeExitStates([
  { nodeId: F_W, available: true, status: EXIT_STATUS.OPEN },
  { nodeId: F_W, available: true, status: EXIT_STATUS.OPEN },
  { nodeId: F_E, available: true, status: EXIT_STATUS.OPEN },
])
check('⚠️ P2-3 T4 duplicate + 全覆盖 → partial=false 且两集合恒等（reason=duplicate 不可反推差异）',
  dupFull.reason === 'duplicate' && dupFull.duplicate === true && dupFull.partial === false
  && sameSet(dupFull.usableNodeIds, dupFull.reportedUsableNodeIds),
  [dupFull.reason, dupFull.duplicate, dupFull.partial,
    dupFull.usableNodeIds, dupFull.reportedUsableNodeIds])

// T5 / T6：D1 前提（**P2-1 全局策略 B**）—— 集合断言一律用集合语义，不锁顺序。
//   missing / invalid ⇒ 有效可用集为空，声明集**不得**单独放行出口。
const guardInvalid = applyExitInvalidation({
  routePlans: plans3(), exits: [{ foo: 1 }], usableNodeIds: [F_W, F_E],
})
check('⚠️ P2-1 T5 exits 不可派生(invalid) + 已声明 [W,E] ⇒ 有效可用集为空（声明集不得放行）',
  guardInvalid.exitNodeIds.length === 0 && guardInvalid.exits.length === 0
  && guardInvalid.blockedAll === true
  && sameSet(guardInvalid.affectedRouteIds, ['pw', 'pe'])
  && !guardInvalid.affectedRouteIds.includes('pd')
  && guardInvalid.routePlans[2].status === PLAN_STATUS.DONE
  && guardInvalid.exitsConflict.length === 0
  && guardInvalid.exitStates.reason === 'invalid',
  [guardInvalid.exitNodeIds, guardInvalid.exits.map((e) => e.nodeId), guardInvalid.blockedAll,
    guardInvalid.affectedRouteIds, guardInvalid.exitsConflict, guardInvalid.exitStates.reason])
const guardMissing = applyExitInvalidation({
  routePlans: plans3(), exits: [], usableNodeIds: [F_W],
})
check('⚠️ P2-1 T6 exits missing + 已声明 [W] ⇒ 有效可用集为空（声明集不得放行）',
  guardMissing.exitNodeIds.length === 0 && guardMissing.exits.length === 0
  && guardMissing.blockedAll === true
  && sameSet(guardMissing.affectedRouteIds, ['pw', 'pe'])
  && !guardMissing.affectedRouteIds.includes('pd')
  && guardMissing.routePlans[2].status === PLAN_STATUS.DONE
  && guardMissing.exitsConflict.length === 0
  && guardMissing.exitStates.reason === 'missing',
  [guardMissing.exitNodeIds, guardMissing.exits.map((e) => e.nodeId), guardMissing.blockedAll,
    guardMissing.affectedRouteIds, guardMissing.exitsConflict, guardMissing.exitStates.reason])

// ══════════════════════════════════════
console.log('\n[25] P2-1 全局策略 B：missing / invalid 时声明集不得单独放行出口')
console.log('     reportedUsableNodeIds 是运行态出口准入的唯一来源；usableNodeIds 只能收窄')
// ══════════════════════════════════════
// 夹具：pw(W,NORMAL) / pe(E,NORMAL) / pd(E,DONE，携带历史字段) / pb(W,**存量** BLOCKED)
// 推荐 / 备用 / 活动指针的**初始值一律指向 DONE 的 pd**（非 null）⇒ 覆盖「DONE 指针
// 被清除」与「被重选」两条真实路径，避免用初始即为 null 的值形成空覆盖。
const sbPlans = () => [
  { id: 'pw', exit: F_W, status: PLAN_STATUS.NORMAL },
  { id: 'pe', exit: F_E, status: PLAN_STATUS.NORMAL },
  {
    id: 'pd', exit: F_E, status: PLAN_STATUS.DONE,
    completedAt: 1700000000, assignedTo: 'u1', history: [{ t: 1, a: 'DONE' }],
  },
  { id: 'pb', exit: F_W, status: PLAN_STATUS.BLOCKED },
]
const sbInput = (extra) => ({
  routePlans: sbPlans(),
  perZone: {
    'D区': {
      plans: sbPlans().map((p) => ({ ...p })),
      recommendedId: 'pd',
      backupId: 'pd',
      extraKey: 'keep',
    },
  },
  activeRoutePlanId: 'pd',
  ...extra,
})
const sbStat = (r) => JSON.stringify(r.routePlans.map((p) => p.status))
const sbDiag = (r) => [r.exits.map((e) => e.nodeId), r.exitNodeIds, r.blockedAll,
  r.affectedRouteIds, sbStat(r)]

// ── SB-1 ~ SB-4：missing / invalid × 声明集 [W] / [W,E] 四种组合 ──
;[
  ['SB-1 missing + 已声明 [W]', { exits: [], usableNodeIds: [F_W] }],
  ['SB-2 missing + 已声明 [W,E]', { exits: [], usableNodeIds: [F_W, F_E] }],
  ['SB-3 invalid + 已声明 [W]', { exits: [{ foo: 1 }], usableNodeIds: [F_W] }],
  ['SB-4 invalid + 已声明 [W,E]', { exits: [{ foo: 1 }], usableNodeIds: [F_W, F_E] }],
].forEach(([label, extra]) => {
  const r = applyExitInvalidation(sbInput(extra))
  check(`⚠️ 策略 B ${label} ⇒ 有效可用集为空（声明集不得放行）`,
    r.exits.length === 0 && r.exitNodeIds.length === 0
    && r.blockedAll === true
    && sameSet(r.affectedRouteIds, ['pw', 'pe', 'pb'])
    && sbStat(r) === JSON.stringify(['BLOCKED', 'BLOCKED', 'DONE', 'BLOCKED']),
    sbDiag(r))
})
// SB-5：目标规则 6 —— 不得经 `input.exitNodeIds` 入参恢复出口
const sb5 = applyExitInvalidation(sbInput({ exits: [], usableNodeIds: [F_W], exitNodeIds: [F_W] }))
check('⚠️ 策略 B SB-5 missing + 已声明 [W] + exitNodeIds=[W] ⇒ exitNodeIds 仍为空（不得经入参恢复）',
  sb5.exitNodeIds.length === 0 && sb5.exits.length === 0,
  [sb5.exitNodeIds, sb5.exits.map((e) => e.nodeId)])

// ── SB-6：DONE 终态保护六项验收条件（拆为独立断言）+ 夹具自检 ──
const sb6 = applyExitInvalidation(sbInput({ exits: [], usableNodeIds: [F_W] }))
const sb6Before = sbPlans()[2]
const sb6After = sb6.routePlans[2]
check('⚠️ 策略 B SB-6 夹具自检：三指针初始值均指向 DONE 的 pd（非空，非「空覆盖」）',
  sbInput({}).perZone['D区'].recommendedId === 'pd'
  && sbInput({}).perZone['D区'].backupId === 'pd'
  && sbInput({}).activeRoutePlanId === 'pd',
  [sbInput({}).perZone['D区'].recommendedId, sbInput({}).perZone['D区'].backupId,
    sbInput({}).activeRoutePlanId])
check('⚠️ 策略 B SB-6a DONE 状态不被改写（仍为 DONE，非 BLOCKED）',
  sb6After.status === PLAN_STATUS.DONE, sb6After.status)
check('⚠️ 策略 B SB-6b DONE 历史字段不被改写（completedAt / assignedTo / history 原样保留）',
  JSON.stringify(Object.keys(sb6After).sort()) === JSON.stringify(Object.keys(sb6Before).sort())
  && sb6After.completedAt === sb6Before.completedAt
  && sb6After.assignedTo === sb6Before.assignedTo
  && JSON.stringify(sb6After.history) === JSON.stringify(sb6Before.history),
  [sb6After, sb6Before])
check('⚠️ 策略 B SB-6c DONE 不进入 affectedRouteIds',
  !sb6.affectedRouteIds.includes('pd'), sb6.affectedRouteIds)
// ⚠️【Stage 1.1-R P1 收紧】三条断言由「≠ 'pd'」改为「=== null」。预期值不是从实测反推的
//   猜测，而是策略 B 下的**契约推论**，依据如下：
//   · 有效可用集为空 ⇒ isRouteUsable 对**任何**路线均判 false —— `:485` 要求出口在
//     可用集中；DONE 还额外被 `:477` 的 USABLE_ROUTE_STATUSES 白名单排除；
//   ⇒ pickSafeRecommendations 的 safe 为空 ⇒ `:616-617` recommendedId / backupId 恒为 null
//     （其契约约定「无可选时一律返回 null —— 禁止回退到已失效的旧路线」，`exitRuntime.js:596`）；
//   · activeRoutePlanId 的改选线路 `routePlans.find((p) => isRouteUsable(...)) || null`
//     （`exitRuntime.js:889-890`）同样无命中 ⇒ 恒为 null。
//   又：夹具自检已确认三指针**初值**均为 'pd'（非空覆盖），故 `=== null` 确为正差异、非空覆盖。
check('⚠️ 策略 B SB-6d DONE 不参与推荐路线选择（recommendedId 被清除 ⇒ 恒为 null）',
  sb6.perZone['D区'].recommendedId === null, sb6.perZone['D区'].recommendedId)
check('⚠️ 策略 B SB-6e DONE 不参与备用路线选择（backupId 被清除 ⇒ 恒为 null）',
  sb6.perZone['D区'].backupId === null, sb6.perZone['D区'].backupId)
check('⚠️ 策略 B SB-6f DONE 不参与活动路线选择（activeRoutePlanId 被清除 ⇒ 恒为 null）',
  sb6.activeRoutePlanId === null, sb6.activeRoutePlanId)

// ── SB-7：affectedRouteIds 定义（最终 BLOCKED 去重并集，含存量 BLOCKED，不含 DONE）──
const sb7 = applyExitInvalidation(sbInput({ exits: [] }))
check('⚠️ 策略 B SB-7 affectedRouteIds = 最终 BLOCKED 去重并集（含存量 pb，不含 DONE 的 pd）',
  new Set(sb7.affectedRouteIds).size === sb7.affectedRouteIds.length
  && sameSet(sb7.affectedRouteIds, ['pw', 'pe', 'pb'])
  && sb7.affectedRouteIds.includes('pb')
  && !sb7.affectedRouteIds.includes('pd'),
  sb7.affectedRouteIds)

// ── SB-8：已知行为登记（blockedAll 双重语义，本轮只记录不重构）──
const sb8 = applyExitInvalidation(sbInput({ exits: [], usableNodeIds: [F_W], blockAll: false }))
check('⚠️ 策略 B SB-8 已知行为：blockAll:false ⇒ blockedAll=false，但非 DONE 仍全部 BLOCKED',
  sb8.blockedAll === false
  && sbStat(sb8) === JSON.stringify(['BLOCKED', 'BLOCKED', 'DONE', 'BLOCKED']),
  [sb8.blockedAll, sbStat(sb8)])

// ── SB-9 / SB-10：防收窄越界 —— 其余 reason 仍须取交集 ──
const sb9 = applyExitInvalidation(sbInput({
  exits: [{ nodeId: F_W, available: true, status: EXIT_STATUS.OPEN }], usableNodeIds: [F_W, F_E],
}))
check('⚠️ 策略 B SB-9 partial + 已声明 [W,E] ⇒ 交集仍生效（仅 [W]，not 空集）',
  sameSet(sb9.exitNodeIds, [F_W]) && sb9.blockedAll === false
  && sbStat(sb9) === JSON.stringify(['NORMAL', 'BLOCKED', 'DONE', 'BLOCKED']),
  sbDiag(sb9))
const sb10 = applyExitInvalidation(sbInput({
  exits: [
    { nodeId: F_W, available: true, status: EXIT_STATUS.OPEN },
    { key: 'EXIT_ZZZ', available: true, status: EXIT_STATUS.OPEN },
  ],
  usableNodeIds: [F_W, F_E],
}))
check('⚠️ 策略 B SB-10 unknown(部分) + 已声明 [W,E] ⇒ 交集仍生效（仅 [W]）',
  sameSet(sb10.exitNodeIds, [F_W]) && sb10.blockedAll === false
  && sbStat(sb10) === JSON.stringify(['NORMAL', 'BLOCKED', 'DONE', 'BLOCKED']),
  sbDiag(sb10))

// ── SB-11：DONE 指针「被重选」路径（非仅清空）—— 重选结果须为可用且非 DONE ──
const sb11 = applyExitInvalidation(sbInput({
  exits: [{ nodeId: F_W, available: true, status: EXIT_STATUS.OPEN }], usableNodeIds: [F_W, F_E],
}))
check('⚠️ 策略 B SB-11 DONE 指针被重选：recommendedId / activeRoutePlanId 改选为 pw（非 DONE）',
  sb11.perZone['D区'].recommendedId === 'pw'
  && sb11.activeRoutePlanId === 'pw'
  && sb11.routePlans[2].status === PLAN_STATUS.DONE
  && !sb11.affectedRouteIds.includes('pd'),
  [sb11.perZone['D区'].recommendedId, sb11.activeRoutePlanId, sb11.affectedRouteIds])

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`)
process.exit(fail ? 1 : 0)

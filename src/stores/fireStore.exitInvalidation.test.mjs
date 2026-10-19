/**
 * P1.8.2 Stage 1.3：fireStore 出口失效 / 火源状态合并 —— **真实 store 调用链**测试。
 *
 * 设施：沿用既有 `node xxx.test.mjs` 模式（自计数 + process.exit），**不新增测试框架依赖**。
 * 引导方式（已实测可用）：pinia(createPinia/setActivePinia) + 已安装的 vite(middlewareMode)
 *   → ssrLoadModule('/src/stores/fireStore.js') → useFireStore()。
 * 纯 Node 直连不可行：fireStore.js 的相对导入无扩展名，Node ESM 无法解析。
 *
 * 范围声明（不得据此宣称已解决）：
 *   · 本套件验证的是 fireStore 侧「出口准入（路径 A）与规划筛选（路径 B）口径统一」
 *     以及「火源 × 出口」状态合并的确定性；
 *   · **不修改 Worker**，因此「静态默认出口冒充真实上报」（FC-1）**未解决**：
 *     本套件只能构造假输入，无法证明生产链路不存在静态回灌；
 *   · K-1（手动路线 exit:'出口A' 无规范 nodeId ⇒ fail-closed 下 BLOCKED）在此**锁定现状**，
 *     该行为接线前后一致，属已知限制而非本阶段修复项；
 *   · K-2（selectEvacuationPlan / setCurrentRoutePlan 未拦截 DONE）属潜在项，本套件不覆盖。
 */
import { createPinia, setActivePinia } from 'pinia'
import { createServer } from 'vite'
import { EXIT_DEFS, EXIT_STATUS } from '../../shared/evacuation/floorTopology.js'
import { applyExitInvalidation } from '../../shared/evacuation/exitRuntime.js'

let pass = 0
let fail = 0
const check = (label, ok, detail) => {
  if (ok) {
    pass += 1
    console.log(`  ✓ ${label}`)
  } else {
    fail += 1
    console.log(`  ✗ ${label}`, detail === undefined ? '' : JSON.stringify(detail))
  }
}

setActivePinia(createPinia())
const server = await createServer({
  server: { middlewareMode: true, watch: null },
  appType: 'custom',
  logLevel: 'warn',
})
const { useFireStore } = await server.ssrLoadModule('/src/stores/fireStore.js')
const store = useFireStore()

const W = EXIT_DEFS.find((e) => e.key === 'EXIT_W').nodeId
const E = EXIT_DEFS.find((e) => e.key === 'EXIT_E').nodeId
const OPEN = EXIT_STATUS.OPEN
const FIRE = {
  id: 'FE-TEST', buildingId: 'B003', floorId: '5F', zone: 'A区',
  building: '3号楼', floor: '5F', area: 'A区', level: 'danger', status: 'pending',
}

// ── 夹具：三条路线（W / E / E+DONE），另含可切换的火源维度输入 ────────────────────
const makePlans = () => [
  { id: 'pw', exitId: W, exit: W, status: 'NORMAL', startArea: 'A区', floorsPassed: ['5F'],
    path: [{ id: '1F:CORRIDOR_1' }, { id: W }] },
  { id: 'pe', exitId: E, exit: E, status: 'NORMAL', startArea: 'B区', floorsPassed: ['5F'],
    path: [{ id: '1F:CORRIDOR_2' }, { id: E }] },
  { id: 'pd', exitId: E, exit: E, status: 'DONE', startArea: 'C区', floorsPassed: ['5F'],
    path: [{ id: '1F:CORRIDOR_2' }, { id: E }],
    completedAt: 1700000000, assignedTo: 'u1', history: [{ t: 1, a: 'DONE' }] },
]
const makeMatrix = (plans) => ({
  buildingId: 'B003', buildingName: '3号楼', floorId: '5F', areas: ['A区', 'B区', 'C区'], exits: [],
  perZone: {
    A区: { plans: plans.filter((p) => p.id === 'pw').map((p) => ({ ...p })), recommendedId: 'pw', backupId: null },
    B区: { plans: plans.filter((p) => p.id === 'pe').map((p) => ({ ...p })), recommendedId: 'pe', backupId: null },
    C区: { plans: plans.filter((p) => p.id === 'pd').map((p) => ({ ...p })),
      recommendedId: 'pd', backupId: 'pd', extraKey: 'keep' },
  },
})

/**
 * 走**真实生产调用链**：applyExitRuntimeStates(snap.exits) → invalidateRoutesWithUnusableExit()
 * （后者在 Stage 1.3 中委托 reconcileRouteStatuses）。
 */
const run = ({ raw, fire = null, blocked = [], extraPlans = [] } = {}) => {
  const plans = makePlans().concat(extraPlans)
  store.routePlans = plans
  store.routeMatrix = makeMatrix(plans)
  store.activeRoutePlanId = 'pd'
  store.blockedEdgeKeys = []
  store.blockedNodeIds = blocked.slice()
  store.fireEvent = fire
  store.applyExitRuntimeStates(raw)
  const marked = store.invalidateRoutesWithUnusableExit()
  return { ...snap(), marked }
}

const snap = () => {
  const rp = store.routePlans || []
  const byId = new Map()
  rp.forEach((p) => { if (p) byId.set(String(p.id), p) })
  const zById = new Map()
  Object.values(store.routeMatrix && store.routeMatrix.perZone ? store.routeMatrix.perZone : {})
    .forEach((info) => (info.plans || []).forEach((p) => { if (p) zById.set(String(p.id), p) }))
  return {
    byId, zById,
    st: (id) => (byId.get(id) || {}).status,
    zst: (id) => (zById.get(id) || {}).status,
    rec: (z) => (store.routeMatrix && store.routeMatrix.perZone[z]
      ? store.routeMatrix.perZone[z].recommendedId : undefined),
    bac: (z) => (store.routeMatrix && store.routeMatrix.perZone[z]
      ? store.routeMatrix.perZone[z].backupId : undefined),
    zoneKeys: (z) => (store.routeMatrix && store.routeMatrix.perZone[z]
      ? Object.keys(store.routeMatrix.perZone[z]).sort().join(',') : ''),
    active: store.activeRoutePlanId,
    reason: store.exitStateReason,
    degraded: store.exitStateDegraded,
    reported: (store.exitReportedUsableNodeIds || []).slice(),
    rawLen: Array.isArray(store.exitRawStates) ? store.exitRawStates.length : store.exitRawStates,
  }
}
const blockedIds = (s) => {
  const set = new Set()
  s.byId.forEach((p) => { if (p.status === 'BLOCKED') set.add(String(p.id)) })
  s.zById.forEach((p) => { if (p.status === 'BLOCKED') set.add(String(p.id)) })
  return [...set].sort()
}
const pointerIds = (s) => {
  const out = []
  const pz = (store.routeMatrix && store.routeMatrix.perZone) || {}
  Object.keys(pz).forEach((z) => {
    const info = pz[z]
    if (info.recommendedId !== null && info.recommendedId !== undefined) {
      out.push([`recommendedId(${z})`, String(info.recommendedId)])
    }
    if (info.backupId !== null && info.backupId !== undefined) {
      out.push([`backupId(${z})`, String(info.backupId)])
    }
  })
  if (s.active !== null && s.active !== undefined) out.push(['activeRoutePlanId', String(s.active)])
  return out
}
/** 两投影一致性 + DONE 双侧 + 指针不得指向 BLOCKED/DONE + affected == BLOCKED 并集 */
const expectCommon = (label, s) => {
  const marked = s.marked
  check(`${label} 两投影：同一 id 状态一致`,
    ['pw', 'pe', 'pd'].every((id) => s.st(id) === s.zst(id)),
    ['pw', 'pe', 'pd'].map((id) => [id, s.st(id), s.zst(id)]))
  check(`${label} affected 计数 == 两投影 BLOCKED 并集去重数`,
    marked === blockedIds(s).length, { marked, blocked: blockedIds(s) })
  check(`${label} 指针均不指向 BLOCKED / DONE`,
    pointerIds(s).every(([, id]) => s.st(id) !== 'BLOCKED' && s.st(id) !== 'DONE'),
    pointerIds(s).map(([k, id]) => [k, id, s.st(id)]))
  return s
}
const expectDoneIntact = (label, s) => {
  const rp = s.byId.get('pd')
  const zp = s.zById.get('pd')
  check(`${label} DONE：routePlans 侧状态与历史字段不变`,
    rp.status === 'DONE' && rp.completedAt === 1700000000 && rp.assignedTo === 'u1'
    && JSON.stringify(rp.history) === JSON.stringify([{ t: 1, a: 'DONE' }]),
    { status: rp.status, completedAt: rp.completedAt, assignedTo: rp.assignedTo, history: rp.history })
  check(`${label} DONE：perZone 侧状态与历史字段不变`,
    zp.status === 'DONE' && zp.completedAt === 1700000000 && zp.assignedTo === 'u1'
    && JSON.stringify(zp.history) === JSON.stringify([{ t: 1, a: 'DONE' }]),
    { status: zp.status, completedAt: zp.completedAt, assignedTo: zp.assignedTo, history: zp.history })
  check(`${label} DONE：不进入 affectedRouteIds`, !blockedIds(s).includes('pd'), blockedIds(s))
  check(`${label} DONE：不进入推荐/备用/活动指针`,
    pointerIds(s).every(([, id]) => id !== 'pd'), pointerIds(s))
  check(`${label} perZone 额外键保留`, s.zoneKeys('C区') === 'backupId,extraKey,plans,recommendedId',
    s.zoneKeys('C区'))
}

console.log('=== 〇、D1-A：初始化窗口（raw = null）与「已收到但缺失」必须严格区分 ===')
console.log('  ⚠️ 本组必须位于文件最前：exitRawStates 初始为 null，而唯一写入点会把它永久改写为非 null。')
console.log('  ⚠️ 本组**不断言** mock 模式已实现严格 fail-closed —— 恰恰相反：mock / 离线模式下')
console.log('     applyDemoSnapshot 从不被调用 ⇒ raw 恒为 null ⇒ 出口维度全时段不参与判定（兼容行为）。')
{
  check('N-1 初始态：exitRawStates === null（从未收到过任何出口运行态数据）',
    store.exitRawStates === null, store.exitRawStates)
  check('N-1 初始态：exitStateDegraded === true / exitStateReason === "missing"',
    store.exitStateDegraded === true && store.exitStateReason === 'missing',
    [store.exitStateDegraded, store.exitStateReason])
  check('N-1 初始态：exitReportedUsableNodeIds 为空（无真实上报可用集）',
    (store.exitReportedUsableNodeIds || []).length === 0, store.exitReportedUsableNodeIds)

  // N-2 兼容行为：null 窗口下出口维度完全不参与判定
  const nullPlans = () => [
    { id: 'pw', exitId: W, exit: W, status: 'NORMAL', floorsPassed: ['5F'], path: [] },
    { id: 'pe', exitId: E, exit: E, status: 'NORMAL', floorsPassed: ['5F'], path: [] },
  ]
  store.routePlans = nullPlans()
  store.routeMatrix = { buildingId: 'B003', floorId: '5F', areas: ['A区', 'B区'], perZone: {
    'A区': { plans: [{ ...store.routePlans[0] }], recommendedId: 'pw', backupId: null },
    'B区': { plans: [{ ...store.routePlans[1] }], recommendedId: 'pe', backupId: null },
  } }
  store.activeRoutePlanId = 'pw'
  const markedNull = store.invalidateRoutesWithUnusableExit()
  check('N-2 null 窗口：reconcile 不产生出口失效（marked === 0）', markedNull === 0, markedNull)
  check('N-2 null 窗口：路线保持 NORMAL（沿用 Stage 1.3 之前的兼容行为）',
    store.routePlans.every((p) => p.status === 'NORMAL'),
    store.routePlans.map((p) => p.status))
  check('N-2 null 窗口：activeRoutePlanId 不被出口维度改写',
    store.activeRoutePlanId === 'pw', store.activeRoutePlanId)

  // N-3 路径 B 不收窄，且不因静态默认额外准入出口
  check('N-3 null 窗口：usableExitsOf 不收窄候选出口',
    JSON.stringify(store.usableExitsOf([W, E])) === JSON.stringify([W, E]),
    store.usableExitsOf([W, E]))
  check('N-3 null 窗口：候选集合恰好等于输入（无静态补齐扩张）',
    JSON.stringify(store.usableExitsOf([W])) === JSON.stringify([W]),
    store.usableExitsOf([W]))

  // N-4 已收到但缺失 ⇒ Policy B fail-closed（与 null 窗口行为相反）
  store.applyExitRuntimeStates([])
  check('N-4 applyExitRuntimeStates([]) ⇒ exitRawStates 变为 []（**不是** null）',
    Array.isArray(store.exitRawStates) && store.exitRawStates.length === 0,
    store.exitRawStates)
  check('N-4 已收到但缺失 ⇒ reason === "missing" 且 marked === 2（fail-closed）',
    store.exitStateReason === 'missing' && store.invalidateRoutesWithUnusableExit() === 2,
    [store.exitStateReason, store.routePlans.map((p) => p.status)])
  check('N-4 已收到但缺失 ⇒ 非 DONE 整批 BLOCKED',
    store.routePlans.every((p) => p.status === 'BLOCKED'),
    store.routePlans.map((p) => p.status))

  // N-5 快照缺 exits 字段（undefined）同样按「已收到但缺失」处理
  store.routePlans = nullPlans()
  store.applyExitRuntimeStates(undefined)
  check('N-5 applyExitRuntimeStates(undefined) ⇒ exitRawStates 归一为 []（不回到 null）',
    Array.isArray(store.exitRawStates) && store.exitRawStates.length === 0,
    store.exitRawStates)
  check('N-5 undefined ⇒ fail-closed，非 DONE 整批 BLOCKED',
    store.invalidateRoutesWithUnusableExit() === 2
    && store.routePlans.every((p) => p.status === 'BLOCKED'),
    store.routePlans.map((p) => p.status))

  // N-6 单调性：null 只能单向离开，永不回头
  store.applyExitRuntimeStates(null)
  check('N-6 applyExitRuntimeStates(null) ⇒ 仍归一为 []（null 单向不可逆）',
    Array.isArray(store.exitRawStates), store.exitRawStates)
}

console.log('=== 一、出口准入（路径 A：真实调用链 applyExitRuntimeStates → invalidate）===')
{
  const s = expectCommon('T-1 missing', run({ raw: [] }))
  check('T-1 missing：reason = missing', s.reason === 'missing', s.reason)
  check('T-1 missing：非 DONE 整批 BLOCKED，DONE 保持',
    s.st('pw') === 'BLOCKED' && s.st('pe') === 'BLOCKED' && s.st('pd') === 'DONE',
    [s.st('pw'), s.st('pe'), s.st('pd')])
  check('T-1 missing：三指针均为 null',
    s.rec('A区') === null && s.bac('A区') === null && s.active === null,
    [s.rec('A区'), s.bac('A区'), s.active])
  check('T-1 missing：真实上报可用集为空（未被静态补齐扩张）', s.reported.length === 0, s.reported)
  expectDoneIntact('T-1 missing', s)
}
{
  const s = expectCommon('T-2 invalid', run({ raw: [{ foo: 1 }] }))
  check('T-2 invalid：reason = invalid', s.reason === 'invalid', s.reason)
  check('T-2 invalid：非 DONE 整批 BLOCKED',
    s.st('pw') === 'BLOCKED' && s.st('pe') === 'BLOCKED' && s.st('pd') === 'DONE',
    [s.st('pw'), s.st('pe'), s.st('pd')])
  expectDoneIntact('T-2 invalid', s)
}
{
  const s = expectCommon('T-3 partial', run({ raw: [{ nodeId: W, available: true, status: OPEN }] }))
  check('T-3 partial：reason = partial', s.reason === 'partial', s.reason)
  check('T-3 partial：仅上报 W ⇒ pw 保持 NORMAL、pe 被 BLOCKED',
    s.st('pw') === 'NORMAL' && s.st('pe') === 'BLOCKED', [s.st('pw'), s.st('pe')])
  check('T-3 partial：affected 只含 pe', JSON.stringify(blockedIds(s)) === JSON.stringify(['pe']),
    blockedIds(s))
  check('T-3 partial：**接线前翻转** —— 接线前实测 marked=0 且 [NORMAL,NORMAL,DONE]',
    s.marked === 1 && s.st('pe') === 'BLOCKED', { marked: s.marked, pe: s.st('pe') })
  check('T-3 partial：真实上报可用集恰为 [W]',
    JSON.stringify(s.reported) === JSON.stringify([W]), s.reported)
  expectDoneIntact('T-3 partial', s)
}
{
  const s = expectCommon('T-4 unknown',
    run({ raw: [{ nodeId: W, available: true, status: OPEN },
      { nodeId: '1F:EXIT_UNKNOWN', available: true, status: OPEN }] }))
  check('T-4 unknown：未知出口不解锁可用集 ⇒ pe 仍 BLOCKED',
    s.st('pe') === 'BLOCKED' && s.reported.length === 1, [s.st('pe'), s.reported])
  expectDoneIntact('T-4 unknown', s)
}
{
  const s = expectCommon('T-5 duplicate',
    run({ raw: [{ nodeId: W, available: true, status: OPEN },
      { nodeId: W, available: false, status: OPEN }] }))
  check('T-5 duplicate：重复且矛盾 ⇒ 保守判为不可用 ⇒ 非 DONE 整批 BLOCKED',
    s.st('pw') === 'BLOCKED' && s.st('pe') === 'BLOCKED', [s.st('pw'), s.st('pe')])
  expectDoneIntact('T-5 duplicate', s)
}
{
  const s = run({ raw: [{ nodeId: W, available: true, status: OPEN }] })
  const filledHasE = (store.exitRuntimeStates || []).some((e) => e.nodeId === E)
  check('T-6 声明集不得扩张：展示用 exitRuntimeStates 仍含静态补齐项 E（证明其未被当作证据）',
    filledHasE, (store.exitRuntimeStates || []).map((e) => e.nodeId))
  check('T-6 声明集不得扩张：准入集仍只有 W，E 终点路线被 BLOCKED',
    JSON.stringify(s.reported) === JSON.stringify([W]) && s.st('pe') === 'BLOCKED',
    [s.reported, s.st('pe')])
  check('T-6 声明集不得扩张：exitRawStates 为原始上报（长度 1，非补齐后的 2）',
    s.rawLen === 1, s.rawLen)
}

console.log('')
console.log('=== 二、火源 × 出口准入 组合（状态优先级：出口 > 火源 > NORMAL）===')
{
  const s = expectCommon('F-1 无火源 + 两口上报', run({ raw: [
    { nodeId: W, available: true, status: OPEN }, { nodeId: E, available: true, status: OPEN }] }))
  check('F-1：全部 NORMAL，DONE 保持',
    s.st('pw') === 'NORMAL' && s.st('pe') === 'NORMAL' && s.st('pd') === 'DONE',
    [s.st('pw'), s.st('pe'), s.st('pd')])
  expectDoneIntact('F-1', s)
}
{
  const s = expectCommon('F-2 火源 WARNING + 两口上报', run({ raw: [
    { nodeId: W, available: true, status: OPEN },
    { nodeId: E, available: true, status: OPEN }], fire: FIRE, blocked: ['1F:CORRIDOR_1'] }))
  check('F-2：pw 穿封堵 ⇒ BLOCKED；pe 未穿封堵且出口上报 ⇒ WARNING',
    s.st('pw') === 'BLOCKED' && s.st('pe') === 'WARNING', [s.st('pw'), s.st('pe')])
  check('F-2：WARNING 可被推荐（USABLE_ROUTE_STATUSES 含 WARNING）',
    s.rec('B区') === 'pe', s.rec('B区'))
  expectDoneIntact('F-2', s)
}
{
  const s = expectCommon('F-3 火源 WARNING + 仅上报 W', run({
    raw: [{ nodeId: W, available: true, status: OPEN }], fire: FIRE }))
  check('F-3：出口准入 ⇒ pw 保留 WARNING；出口未准入 ⇒ pe 覆盖为 BLOCKED',
    s.st('pw') === 'WARNING' && s.st('pe') === 'BLOCKED', [s.st('pw'), s.st('pe')])
  check('F-3：DONE 不受火源与出口任一维度影响', s.st('pd') === 'DONE', s.st('pd'))
  expectDoneIntact('F-3', s)
}
{
  const s = expectCommon('F-4 火源 WARNING + 出口缺失', run({ raw: [], fire: FIRE }))
  check('F-4：出口缺失 ⇒ 火源结果被覆盖，非 DONE 整批 BLOCKED',
    s.st('pw') === 'BLOCKED' && s.st('pe') === 'BLOCKED', [s.st('pw'), s.st('pe')])
  expectDoneIntact('F-4', s)
}
{
  const s = expectCommon('F-5 火源 WARNING + 两口上报（无封堵）', run({ raw: [
    { nodeId: W, available: true, status: OPEN },
    { nodeId: E, available: true, status: OPEN }], fire: FIRE }))
  check('F-5：两条路线均为 WARNING（火源影响但可用）',
    s.st('pw') === 'WARNING' && s.st('pe') === 'WARNING', [s.st('pw'), s.st('pe')])
  expectDoneIntact('F-5', s)
}

console.log('')
console.log('=== 三、blockedAll 三态（直接驱动协调函数，锁定契约语义）===')
{
  const base = () => {
    const plans = makePlans()
    return { routePlans: plans, perZone: makeMatrix(plans).perZone, activeRoutePlanId: null }
  }
  const b1 = applyExitInvalidation({ ...base(), exits: [] })
  const b2 = applyExitInvalidation({ ...base(), exits: [], blockAll: false })
  const b3 = applyExitInvalidation({ ...base(),
    exits: [{ nodeId: W, available: true, status: OPEN }], blockAll: true })
  const st = (o, id) => (o.routePlans.find((p) => p.id === id) || {}).status
  check('B-1 未提供 blockAll + 可用集为空 ⇒ blockedAll = true', b1.blockedAll === true, b1.blockedAll)
  check('B-2 显式 blockAll=false ⇒ 回显 false，**但非 DONE 仍整批 BLOCKED**（已知行为）',
    b2.blockedAll === false && st(b2, 'pw') === 'BLOCKED' && st(b2, 'pe') === 'BLOCKED',
    { blockedAll: b2.blockedAll, pw: st(b2, 'pw'), pe: st(b2, 'pe') })
  check('B-3 显式 blockAll=true ⇒ 非 DONE 整批 BLOCKED',
    b3.blockedAll === true && st(b3, 'pw') === 'BLOCKED' && st(b3, 'pe') === 'BLOCKED',
    { blockedAll: b3.blockedAll, pw: st(b3, 'pw'), pe: st(b3, 'pe') })
  check('B-4 三种情形下 DONE 均不被阻断',
    [b1, b2, b3].every((o) => st(o, 'pd') === 'DONE'), [b1, b2, b3].map((o) => st(o, 'pd')))
  check('B-5 blockedAll=true 时 affectedRouteIds 仍不含 DONE',
    [b1, b2, b3].every((o) => !o.affectedRouteIds.includes('pd')),
    [b1, b2, b3].map((o) => o.affectedRouteIds))
}

console.log('')
console.log('=== 四、确定性与调用顺序（reconcile 必须是最后写入者）===')
{
  const raw = [{ nodeId: W, available: true, status: OPEN }]
  const a = run({ raw })
  const b = run({ raw })
  const c = run({ raw })
  check('T-O2 重复执行 3 次：状态一致',
    JSON.stringify([a.st('pw'), a.st('pe'), a.st('pd')])
    === JSON.stringify([b.st('pw'), b.st('pe'), b.st('pd')])
    && JSON.stringify([b.st('pw'), b.st('pe'), b.st('pd')])
    === JSON.stringify([c.st('pw'), c.st('pe'), c.st('pd')]),
    [a, b, c].map((s) => [s.st('pw'), s.st('pe'), s.st('pd')]))
  check('T-O2 重复执行 3 次：指针一致',
    JSON.stringify([a.rec('A区'), a.bac('A区'), a.active])
    === JSON.stringify([b.rec('A区'), b.bac('A区'), b.active])
    && JSON.stringify([b.rec('A区'), b.bac('A区'), b.active])
    === JSON.stringify([c.rec('A区'), c.bac('A区'), c.active]),
    [a, b, c].map((s) => [s.rec('A区'), s.bac('A区'), s.active]))
}
{
  // 顺序 1：出口上报 → 火警重规划
  run({ raw: [{ nodeId: W, available: true, status: OPEN }] })
  store.fireEvent = FIRE
  store.replanRoutesForFire()
  const a = snap()
  // 顺序 2：火警重规划 → 出口上报
  const plans = makePlans()
  store.routePlans = plans
  store.routeMatrix = makeMatrix(plans)
  store.activeRoutePlanId = 'pd'
  store.blockedNodeIds = []
  store.blockedEdgeKeys = []
  store.fireEvent = FIRE
  store.replanRoutesForFire()
  store.applyExitRuntimeStates([{ nodeId: W, available: true, status: OPEN }])
  store.invalidateRoutesWithUnusableExit()
  const b = snap()
  check('T-O1 逆序触发：最终状态一致（与触发顺序无关）',
    JSON.stringify([a.st('pw'), a.st('pe'), a.st('pd')])
    === JSON.stringify([b.st('pw'), b.st('pe'), b.st('pd')]),
    [['出口→火警', a.st('pw'), a.st('pe'), a.st('pd')],
      ['火警→出口', b.st('pw'), b.st('pe'), b.st('pd')]])
  check('T-O1 逆序触发：出口失效未被火警重规划抹掉（pe 仍 BLOCKED）',
    a.st('pe') === 'BLOCKED' && b.st('pe') === 'BLOCKED', [a.st('pe'), b.st('pe')])
  check('T-O1 逆序触发：指针均不指向 BLOCKED',
    pointerIds(a).every(([, id]) => a.st(id) !== 'BLOCKED')
    && pointerIds(b).every(([, id]) => b.st(id) !== 'BLOCKED'),
    [pointerIds(a), pointerIds(b)])
}
{
  // T-O3：clearRouteFire 之后出口维度仍须生效（原 :3359 全量 NORMAL 会抹掉出口失效）
  const s1 = run({ raw: [{ nodeId: W, available: true, status: OPEN }], fire: FIRE,
    blocked: ['1F:CORRIDOR_1'] })
  check('T-O3 前置：pw 火源 BLOCKED、pe 出口 BLOCKED',
    s1.st('pw') === 'BLOCKED' && s1.st('pe') === 'BLOCKED', [s1.st('pw'), s1.st('pe')])
  store.clearRouteFire()
  const s2 = snap()
  check('T-O3 clearRouteFire 后：火情清空 ⇒ pw 恢复 NORMAL', s2.st('pw') === 'NORMAL', s2.st('pw'))
  check('T-O3 clearRouteFire 后：出口失效**未被重置** ⇒ pe 仍 BLOCKED（接线前为 NORMAL）',
    s2.st('pe') === 'BLOCKED', s2.st('pe'))
  check('T-O3 clearRouteFire 后：activeRoutePlanId 为 null 且未被 reconcile 覆盖',
    s2.active === null, s2.active)
  check('T-O3 clearRouteFire 后：DONE 仍保持', s2.st('pd') === 'DONE', s2.st('pd'))
  check('T-O3 clearRouteFire 后：两投影一致',
    ['pw', 'pe', 'pd'].every((id) => s2.st(id) === s2.zst(id)),
    ['pw', 'pe', 'pd'].map((id) => [id, s2.st(id), s2.zst(id)]))
}

console.log('')
console.log('=== 五、路径 B（usableExitsOf）与路径 A 同口径 ===')
{
  const raw = [{ nodeId: W, available: true, status: OPEN }]
  store.applyExitRuntimeStates(raw)
  const all = [W, E]
  const filtered = store.usableExitsOf ? store.usableExitsOf(all) : null
  check('B-路径：候选出口按真实上报集收窄 ⇒ 只剩 W',
    filtered !== null && JSON.stringify(filtered) === JSON.stringify([W]),
    { all, filtered })
  store.applyExitRuntimeStates([])
  check('B-路径：出口缺失 ⇒ 候选为空（fail-closed，不回落静态默认）',
    JSON.stringify(store.usableExitsOf(all)) === JSON.stringify([]), store.usableExitsOf(all))
}

console.log('')
console.log('=== 六、K-1 手动路线（已知限制，锁定现状行为）===')
{
  const manual = { id: 'RP-MANUAL-1', name: '自定义方案', type: 'manual', status: 'NORMAL',
    exit: '出口A', exitId: null, exitLabel: '自定义出口', startArea: '手动',
    floorsPassed: ['5F'], path: [] }
  const s = run({ raw: [{ nodeId: W, available: true, status: OPEN },
    { nodeId: E, available: true, status: OPEN }], extraPlans: [manual] })
  check('K-1：手动路线 exit:"出口A" 无规范 nodeId ⇒ fail-closed 下 BLOCKED（接线前后一致）',
    s.st('RP-MANUAL-1') === 'BLOCKED', s.st('RP-MANUAL-1'))
  check('K-1：手动路线不进入任何指针',
    pointerIds(s).every(([, id]) => id !== 'RP-MANUAL-1'), pointerIds(s))
}

console.log('')
console.log('=== 七、K-2：DONE 不得进入 recommendedId / backupId / activeRoutePlanId ===')
{
  // 前置说明：本组用例在**未加 DONE 拦截前必然失败**（先红），修正 selectEvacuationPlan /
  // setCurrentRoutePlan 后转绿。同时用对照用例证明 NORMAL / WARNING 路线原有行为不变。
  const PARTIAL = [{ nodeId: W, available: true, status: OPEN }]

  // K2-1 手动选择 DONE
  {
    const s = run({ raw: PARTIAL })
    store.activeRoutePlanId = 'pw'
    const okSel = store.selectEvacuationPlan('pd')
    check('K2-1 selectEvacuationPlan(DONE) 返回 false', okSel === false, okSel)
    check('K2-1 selectEvacuationPlan(DONE) 不改写 activeRoutePlanId',
      store.activeRoutePlanId === 'pw', store.activeRoutePlanId)
    const pd = s.byId.get('pd')
    check('K2-1 DONE 的 status/completedAt/assignedTo/history 未被改写',
      pd.status === 'DONE' && pd.completedAt === 1700000000 && pd.assignedTo === 'u1'
      && JSON.stringify(pd.history) === JSON.stringify([{ t: 1, a: 'DONE' }]),
      [pd.status, pd.completedAt, pd.assignedTo, pd.history])
  }

  // K2-2 自动推荐：三种失败态 + reconcile 后三指针均不得指向 DONE
  const failStates = [
    ['missing', []],
    ['partial', PARTIAL],
    ['duplicate', [{ nodeId: W, available: true, status: OPEN },
      { nodeId: W, available: false, status: OPEN }]],
  ]
  failStates.forEach(([label, raw]) => {
    run({ raw })
    store.activeRoutePlanId = 'pd'
    store.invalidateRoutesWithUnusableExit()
    const s = snap()
    const ptrs = [s.rec('A区'), s.bac('A区'), s.rec('B区'), s.bac('B区'),
      s.rec('C区'), s.bac('C区'), s.active]
    check(`K2-2 ${label}：recommendedId/backupId/activeRoutePlanId 均不为 DONE`,
      ptrs.every((v) => v !== 'pd'), ptrs)
  })

  // K2-3 出口失效后手动把 DONE 设为当前路线
  {
    run({ raw: [] })
    const before = snap().rec('C区')
    const okSet = store.setCurrentRoutePlan('C区', 'pd')
    check('K2-3 出口失效后 setCurrentRoutePlan(C区, DONE) 返回 false', okSet === false, okSet)
    check('K2-3 出口失效后 recommendedId 未被改写为 DONE',
      snap().rec('C区') !== 'pd', { before, after: snap().rec('C区') })
  }

  // K2-4 重复 reconcile 后仍拒绝，且 DONE 双侧历史字段不变
  {
    const s0 = run({ raw: PARTIAL })
    store.activeRoutePlanId = 'pw'
    for (let i = 0; i < 3; i += 1) store.invalidateRoutesWithUnusableExit()
    check('K2-4 重复 reconcile 3 次后 selectEvacuationPlan(DONE) 仍返回 false',
      store.selectEvacuationPlan('pd') === false)
    check('K2-4 重复 reconcile 3 次后 setCurrentRoutePlan(C区, DONE) 仍返回 false',
      store.setCurrentRoutePlan('C区', 'pd') === false)
    const s = snap()
    check('K2-4 重复 reconcile 3 次后 activeRoutePlanId 仍非 DONE',
      s.active !== 'pd', s.active)
    expectDoneIntact('K2-4 重复 reconcile 3 次后', s)
    check('K2-4 重复 reconcile 3 次后 DONE 未进入 affected（且 s0 侧同样未变）',
      !blockedIds(s).includes('pd') && s0.st('pd') === 'DONE',
      [blockedIds(s), s0.st('pd')])
  }

  // K2-5 对照：NORMAL / WARNING 路线原有选择行为不变（证明未扩大规则、未误伤）
  {
    run({ raw: PARTIAL })
    check('K2-5 对照：NORMAL 路线可被 selectEvacuationPlan 选中',
      store.selectEvacuationPlan('pw') === true && store.activeRoutePlanId === 'pw',
      store.activeRoutePlanId)
    check('K2-5 对照：NORMAL 路线可被 setCurrentRoutePlan 选中',
      store.setCurrentRoutePlan('A区', 'pw') === true && snap().rec('A区') === 'pw',
      snap().rec('A区'))
    const s2 = run({ raw: PARTIAL, fire: FIRE })
    check('K2-5 对照：WARNING 路线（出口已准入）仍可被 selectEvacuationPlan 选中',
      s2.st('pw') === 'WARNING' && store.selectEvacuationPlan('pw') === true,
      [s2.st('pw'), store.activeRoutePlanId])
    check('K2-5 对照：WARNING 路线仍可被 setCurrentRoutePlan 选中',
      store.setCurrentRoutePlan('A区', 'pw') === true && snap().rec('A区') === 'pw',
      snap().rec('A区'))
  }
}

console.log('')
console.log(`=== 结果：${pass} 通过 / ${fail} 失败 ===`)
await server.close()
process.exit(fail ? 1 : 0)

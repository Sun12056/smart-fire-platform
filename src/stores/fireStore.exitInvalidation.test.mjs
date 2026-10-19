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
import { toRaw } from 'vue'
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
console.log('=== 八、K-4：展示层路线状态唯一权威源（reconciledRouteView）===')
console.log('  ⚠️ 走真实生产链：applyBuildingPlans → syncLegacyRouteState（routePlans/perZone + reconcile）')
console.log('  ⚠️ 覆盖 T1-T8：出口 partial/missing、raw-null 兼容、火源维度、DONE 保护、')
console.log('     2D/3D 同源、对象替换、兜底健壮性；并验证**不写** bp.routes / routesByZone / 后端快照对象。')
console.log('  ⚠️ 本组不覆盖 startEvacuationRun(:1479) 与 applyRouteToDevices 的状态门禁（独立遗留项）。')
{
  // ── 夹具：一条整栋楼方案 + 两条路线（W / E），几何含 5F 两节点 + 1F 出口节点 ──
  const mkRoute = (routeId, floorId, zone, exitId, exitLabel, corridorNode) => ({
    routeId, floorId, zone,
    startNode: `${floorId}:A_CENTER`,
    exitId, exitLabel,
    nodes: [`${floorId}:A_CENTER`, corridorNode, exitId],
    points: [{ x: 140, y: 150 }, { x: 140, y: 170 }, { x: 32, y: 170 }],
    distance: 120, estimatedTime: 90, riskLevel: 'low', valid: true, reasons: [],
    floorsPassed: [floorId, '1F'], fireDistance: 10, escapeDistance: 40, exitDistance: 5,
    personCount: 3, sourcePlanId: 'cand-1',
  })
  const mkBuildingPlan = () => {
    const routes = [
      mkRoute('PLAN-A:5F:A区', '5F', 'A区', W, '西侧安全出口', '5F:CORRIDOR_N'),
      mkRoute('PLAN-A:5F:B区', '5F', 'B区', E, '东侧安全出口', '5F:CORRIDOR_S'),
    ]
    return {
      id: 'PLAN-A', name: '策略A', buildingId: 'B003', buildingName: '3号楼',
      scope: 'BUILDING', strategy: 'balanced', strategyLabel: 'A', recommended: true,
      fire: null, summary: { zoneCount: 2, personCount: 6, exits: {}, floors: ['5F'] },
      routes, routesByZone: { '5F:A区': routes[0], '5F:B区': routes[1] },
      status: 'NORMAL', valid: true, reasons: [], createdAt: null,
    }
  }
  const RID_W = 'PLAN-A:5F:A区'
  const RID_E = 'PLAN-A:5F:B区'
  const zoneRoute = (zone) => (store.getAllZoneRoutes() || []).find((z) => z.zone === zone) || null
  const hasStatus = (o) => Object.prototype.hasOwnProperty.call(o, 'status')

  const BP = mkBuildingPlan()
  store.routeFloorId = '5F'
  store.selectedZone = 'A区'
  store.blockedNodeIds = []
  store.blockedEdgeKeys = []
  store.fireEvent = null
  store.applyBuildingPlans({ buildingPlans: [BP], activeBuildingPlanId: 'PLAN-A' })

  // ── K4-0 结构契约：命中路径字段完整，且绝不写 bp.routes / 后端快照对象 ──
  {
    const zr = zoneRoute('A区')
    check('K4-0：getAllZoneRoutes 命中权威投影 ⇒ 与 getRoutePlanById 同一对象',
      !!zr && zr.plan === store.getRoutePlanById(RID_W), zr && zr.plan && zr.plan.id)
    check('K4-0：plan 字段结构完整（几何/楼层/出口/方案归属均在）',
      !!zr && zr.plan.path.length === 3 && zr.plan.startFloor === '5F' && zr.plan.startArea === 'A区'
      && zr.plan.exit === W && zr.plan.exitLabel === '西侧安全出口'
      && zr.plan.buildingPlanId === 'PLAN-A' && zr.plan.strategy === 'balanced'
      && zr.plan.scope === 'BUILDING' && zr.plan.floorsPassed.join(',') === '5F,1F',
      zr && zr.plan && { id: zr.plan.id, startFloor: zr.plan.startFloor, exit: zr.plan.exit })
    check('K4-0：不写 bp.routes（EvacuationRoute 仍无 status 字段）',
      !hasStatus(BP.routes[0]) && !hasStatus(BP.routes[1]),
      BP.routes.map((r) => Object.keys(r).filter((k) => k === 'status')))
    check('K4-0：bp.routes 几何与规划元数据未被改动',
      JSON.stringify(BP.routes[0].nodes) === JSON.stringify(['5F:A_CENTER', '5F:CORRIDOR_N', W])
      && BP.routes[0].points.length === 3 && BP.routes[0].personCount === 3
      && BP.routes[0].valid === true && BP.routes[0].sourcePlanId === 'cand-1')
    check('K4-0：routesByZone 与 routes 仍互为别名（未被替换）',
      BP.routesByZone['5F:A区'] === BP.routes[0] && BP.routesByZone['5F:B区'] === BP.routes[1])
    // ⚠️ store 侧读取经过 Vue 响应式代理，须用 toRaw 穿透后才能与原始快照对象比较身份
    const rawPlans = toRaw(store.buildingEvacuationPlans)
    check('K4-0：后端快照对象身份未被替换（buildingEvacuationPlans 持有原对象，未经克隆）',
      rawPlans[0] === BP && rawPlans[0].routes[0] === BP.routes[0],
      [rawPlans[0] === BP, rawPlans[0].routes[0] === BP.routes[0]])
  }

  // ── T1 出口 partial：仅 W 可用 ⇒ E 路线 BLOCKED，且三处状态一致 ──
  {
    store.selectedZone = 'B区'
    store.applyExitRuntimeStates([{ nodeId: W, available: true, status: OPEN }])
    const marked = store.invalidateRoutesWithUnusableExit()
    const zrE = zoneRoute('B区')
    check('T1 partial：routePlans 中 E 路线为 BLOCKED',
      store.getRoutePlanById(RID_E).status === 'BLOCKED', store.getRoutePlanById(RID_E).status)
    check('T1 partial：getAllZoneRoutes 的 plan.status === BLOCKED（不再静默 NORMAL）',
      !!zrE && zrE.plan.status === 'BLOCKED', zrE && zrE.plan.status)
    check('T1 partial：currentRoutePlan.status === BLOCKED 且与投影同一对象',
      !!store.currentRoutePlan && store.currentRoutePlan.status === 'BLOCKED'
      && store.currentRoutePlan === store.getRoutePlanById(RID_E),
      store.currentRoutePlan && store.currentRoutePlan.status)
    check('T1 partial：W 路线仍为 NORMAL（未误判）',
      zoneRoute('A区').plan.status === 'NORMAL', zoneRoute('A区').plan.status)
    check('T1 partial：affected 计数 == 1（仅 E 失效）', marked === 1, marked)
    check('T1 partial：bp.routes 仍未获得 status', !hasStatus(BP.routes[1]))
  }

  // ── T2 出口 missing：非 DONE 整批 BLOCKED ──
  {
    store.applyExitRuntimeStates([])
    store.invalidateRoutesWithUnusableExit()
    check('T2 missing：两条路线在 getAllZoneRoutes 中均为 BLOCKED',
      ['A区', 'B区'].every((z) => zoneRoute(z).plan.status === 'BLOCKED'),
      ['A区', 'B区'].map((z) => zoneRoute(z).plan.status))
    check('T2 missing：currentRoutePlan 亦为 BLOCKED（未静默降级）',
      store.currentRoutePlan.status === 'BLOCKED', store.currentRoutePlan.status)
    check('T2 missing：routePlans 侧同样 BLOCKED（两处一致）',
      store.getRoutePlanById(RID_W).status === 'BLOCKED' && store.getRoutePlanById(RID_E).status === 'BLOCKED')
    check('T2 missing：bp.routes 仍无 status', !hasStatus(BP.routes[0]) && !hasStatus(BP.routes[1]))
  }

  // ── T3 raw-null 兼容窗口：状态与 routePlans 一致（D1-A 行为锁定，不得宣称 fail-closed） ──
  {
    // 直接复位 ref 以重建「从未收到」窗口：applyExitRuntimeStates(null) 会归一为 []
    // （属「已收到但缺失」，见 D1-A ②），与 null（①）语义不同，故此处不复用该入口。
    store.exitRawStates = null
    store.reconcileRouteStatuses()
    check('T3 raw-null：reconcile 不产生出口失效 ⇒ 两条路线 NORMAL',
      store.getRoutePlanById(RID_W).status === 'NORMAL' && store.getRoutePlanById(RID_E).status === 'NORMAL',
      [store.getRoutePlanById(RID_W).status, store.getRoutePlanById(RID_E).status])
    check('T3 raw-null：getAllZoneRoutes / currentRoutePlan 与 routePlans 状态一致',
      zoneRoute('A区').plan.status === 'NORMAL' && store.currentRoutePlan.status === 'NORMAL',
      [zoneRoute('A区').plan.status, store.currentRoutePlan.status])
    check('T3 raw-null：仍不写 bp.routes', !hasStatus(BP.routes[0]))
  }

  // ── T4 火源维度：WARNING / BLOCKED 传导至展示层，清理后可逆 ──
  {
    store.fireEvent = FIRE
    store.blockedNodeIds = ['5F:CORRIDOR_N'] // W 路线途经被封节点 ⇒ BLOCKED
    store.selectedZone = 'A区'
    store.reconcileRouteStatuses()
    check('T4 火源：W 路线（途经封堵节点）BLOCKED 并传导至 getAllZoneRoutes',
      store.getRoutePlanById(RID_W).status === 'BLOCKED' && zoneRoute('A区').plan.status === 'BLOCKED',
      [store.getRoutePlanById(RID_W).status, zoneRoute('A区').plan.status])
    check('T4 火源：E 路线为 WARNING（楼栋/楼层命中但未途经封堵）',
      store.getRoutePlanById(RID_E).status === 'WARNING' && zoneRoute('B区').plan.status === 'WARNING',
      [store.getRoutePlanById(RID_E).status, zoneRoute('B区').plan.status])
    check('T4 火源：currentRoutePlan 与投影同一对象且状态为 BLOCKED',
      store.currentRoutePlan === store.getRoutePlanById(RID_W) && store.currentRoutePlan.status === 'BLOCKED')
    // 清理火源并恢复出口维度
    store.fireEvent = null
    store.blockedNodeIds = []
    store.applyExitRuntimeStates([
      { nodeId: W, available: true, status: OPEN },
      { nodeId: E, available: true, status: OPEN },
    ])
    store.invalidateRoutesWithUnusableExit()
    check('T4 火源清理后：两条路线恢复 NORMAL（状态可逆、不残留）',
      store.getRoutePlanById(RID_W).status === 'NORMAL' && store.getRoutePlanById(RID_E).status === 'NORMAL',
      [store.getRoutePlanById(RID_W).status, store.getRoutePlanById(RID_E).status])
  }

  // ── T5 DONE 保护 ──
  // ⚠️ 路线级 DONE 当前**无生产生产者**（shared/evacuation/exitRuntime.js 已登记
  //    PLAN_STATUS.DONE/CONFIRMED/EXECUTING 均无使用点）；本组以夹具方式在**两个投影**中
  //    预置 DONE（与既有 makePlans/makeMatrix 同口径），验证展示层不改写、不误判。
  {
    store.selectedZone = 'A区'
    const markDone = (id) => {
      const copies = [store.getRoutePlanById(id)]
        .concat((store.routeMatrix.perZone['A区'].plans || []).filter((p) => p && p.id === id))
      copies.filter(Boolean).forEach((p) => {
        p.status = 'DONE'; p.completedAt = 1700000000; p.assignedTo = 'u1'; p.history = [{ t: 1, a: 'DONE' }]
      })
    }
    markDone(RID_W)
    // 前置态：出口上报缺失（fail-closed）⇒ 非 DONE 路线应整批 BLOCKED，
    // 以此验证 DONE 不被改写、且不计入 affected。
    store.applyExitRuntimeStates([])
    const marked = store.invalidateRoutesWithUnusableExit()
    const donePlan = store.getRoutePlanById(RID_W)
    check('T5 DONE：routePlans 侧保持 DONE 且历史字段不变',
      donePlan.status === 'DONE' && donePlan.completedAt === 1700000000 && donePlan.assignedTo === 'u1'
      && JSON.stringify(donePlan.history) === JSON.stringify([{ t: 1, a: 'DONE' }]),
      { status: donePlan.status, completedAt: donePlan.completedAt, history: donePlan.history })
    check('T5 DONE：getAllZoneRoutes 呈现 DONE（不是 BLOCKED、也不是 NORMAL）',
      zoneRoute('A区').plan.status === 'DONE', zoneRoute('A区').plan.status)
    check('T5 DONE：currentRoutePlan 呈现 DONE 且与投影同一对象',
      store.currentRoutePlan.status === 'DONE' && store.currentRoutePlan === donePlan)
    check('T5 DONE：affected 计数不含 DONE（仅 E 失效）', marked === 1, marked)
    check('T5 DONE：perZone 推荐/备用指针不指向 DONE',
      (() => {
        const pz = store.routeMatrix.perZone
        return Object.keys(pz).every((z) => pz[z].recommendedId !== RID_W && pz[z].backupId !== RID_W)
      })(),
      Object.keys(store.routeMatrix.perZone).map((z) => [z, store.routeMatrix.perZone[z].recommendedId]))
    check('T5 DONE：bp.routes 仍无 status', !hasStatus(BP.routes[0]))
  }

  // ── T7 2D/3D 同源：routeId / 几何与 bp.routes 一致（3D 消费 r.nodes/r.points 不受影响） ──
  {
    const zrW = zoneRoute('A区')
    check('T7 2D/3D 同源：routeId 与 bp.routes 完全一致',
      zrW.routeId === BP.routes[0].routeId && zrW.routeId === RID_W, zrW.routeId)
    check('T7 2D/3D 同源：plan.path 与 bp.routes.nodes 一一对应（几何未被替换）',
      JSON.stringify(zrW.plan.path.map((n) => n.id)) === JSON.stringify(BP.routes[0].nodes))
    check('T7 2D/3D 同源：segment 取自同一几何（5F 两个节点坐标与 points 相同）',
      zrW.segment.length === 2
      && zrW.segment[0].x === BP.routes[0].points[0].x && zrW.segment[0].y === BP.routes[0].points[0].y
      && zrW.segment[1].x === BP.routes[0].points[1].x && zrW.segment[1].y === BP.routes[0].points[1].y,
      zrW.segment)
    check('T7 2D/3D 同源：返回结构 { zone, color, plan, routeId, segment } 字段齐全',
      ['zone', 'color', 'plan', 'routeId', 'segment'].every((k) => k in zrW), Object.keys(zrW))
  }

  // ── T6 路线对象替换：二次快照后返回新投影对象，旧对象不再被返回 ──
  {
    const BP2 = JSON.parse(JSON.stringify(BP))
    BP2.routes[0].nodes = ['5F:A_CENTER', '1F:EXIT_W'] // 几何变更（少一个节点）
    BP2.routes[0].points = [{ x: 140, y: 150 }, { x: 32, y: 170 }]
    BP2.routesByZone['5F:A区'] = BP2.routes[0]
    const oldPlan = store.getRoutePlanById(RID_W)
    store.applyBuildingPlans({ buildingPlans: [BP2], activeBuildingPlanId: 'PLAN-A' })
    const zr = zoneRoute('A区')
    check('T6 替换：getAllZoneRoutes 返回新投影对象（旧对象不再被返回）',
      !!zr && zr.plan !== oldPlan && zr.plan === store.getRoutePlanById(RID_W))
    check('T6 替换：几何随新 bp.routes 更新（path 与新 nodes 一致）',
      zr.plan.path.length === 2
      && JSON.stringify(zr.plan.path.map((n) => n.id)) === JSON.stringify(BP2.routes[0].nodes))
    check('T6 替换：buildingEvacuationPlans 持有 BP2 原对象（未克隆、未写后端对象）',
      toRaw(store.buildingEvacuationPlans)[0] === BP2 && !hasStatus(BP2.routes[0]))
    check('T6 替换：currentRoutePlan 同样切到新投影对象',
      store.currentRoutePlan === store.getRoutePlanById(RID_W))
  }

  // ── T8 兜底健壮性：状态缺失必须表现为「未知」，严禁静默降级为 NORMAL ──
  {
    const bareMatrix = { buildingId: 'B003', buildingName: '3号楼', floorId: '5F', areas: ['A区'], exits: [], perZone: {} }
    const stub = () => {
      const zr = zoneRoute('A区')
      return { ...zr.plan, buildingPlanId: 'PLAN-A' }
    }

    // 8-A 投影尚未生成（routePlans 为空）
    store.routePlans = []
    store.routeMatrix = bareMatrix
    const zrA = zoneRoute('A区')
    check('T8-A 投影缺失：不抛异常且返回几何兜底对象',
      !!zrA && Array.isArray(zrA.plan.path) && zrA.plan.path.length > 0, zrA && zrA.plan.path.length)
    check('T8-A 投影缺失：status === null（状态未知）且**不是** NORMAL',
      zrA.plan.status === null && zrA.plan.status !== 'NORMAL', zrA.plan.status)
    check('T8-A 投影缺失：currentRoutePlan 同样为状态未知（调用方不得误判可用）',
      !!store.currentRoutePlan && store.currentRoutePlan.status === null,
      store.currentRoutePlan && store.currentRoutePlan.status)
    check('T8-A 投影缺失：几何仍可用于绘制（segment 非空）', zrA.segment.length > 0, zrA.segment.length)

    // 8-B 方案归属不符（同 routeId 但 buildingPlanId 不同）⇒ 不得采用
    store.routePlans = [{ ...stub(), id: RID_W, buildingPlanId: 'PLAN-B', status: 'NORMAL' }]
    check('T8-B 方案归属不符：不采用该投影 ⇒ status === null（未知，而非 NORMAL）',
      zoneRoute('A区').plan.status === null, zoneRoute('A区').plan.status)
    check('T8-B 方案归属不符：getRoutePlanById 仍按 id 命中（纯 id 查找，不含归属判据）',
      store.getRoutePlanById(RID_W).buildingPlanId === 'PLAN-B')

    // 8-C 投影含 null 元素 ⇒ 不抛异常，合法条目仍可命中
    store.routePlans = [null, { ...stub(), id: RID_W, status: 'BLOCKED' }, null]
    check('T8-C 含 null 元素：不抛异常且命中合法条目（status === BLOCKED）',
      zoneRoute('A区').plan.status === 'BLOCKED', zoneRoute('A区').plan.status)

    // 8-D 路线 id 不在投影中（路线集合已变更）⇒ 未知，且不得把 BLOCKED 误读为 NORMAL
    store.routePlans = [{ ...stub(), id: 'PLAN-A:5F:Z区', status: 'BLOCKED' }]
    const zrD = zoneRoute('A区')
    check('T8-D 路线 id 缺失：status === null（未知），非 NORMAL 也非 BLOCKED',
      zrD.plan.status === null && zrD.plan.status !== 'NORMAL' && zrD.plan.status !== 'BLOCKED',
      zrD.plan.status)
    check('T8-D 路线 id 缺失：不抛异常且几何兜底可用', zrD.plan.path.length > 0, zrD.plan.path.length)
  }
}

console.log('')
console.log(`=== 结果：${pass} 通过 / ${fail} 失败 ===`)
await server.close()
process.exit(fail ? 1 : 0)

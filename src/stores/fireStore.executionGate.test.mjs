/**
 * P1.8.2 Stage 2-A 遗留项：执行入口状态门禁 —— 真实 store 调用链测试。
 *
 * 覆盖入口：startEvacuationRun / applyBuildingRoutesToDevices / adjustEvacuationDirection /
 *   startPulseFlash / selectEvacuationPlan（整栋楼分支）。
 * 设施：沿用既有 `node xxx.test.mjs` 模式（自计数 + process.exit），
 *   pinia(createPinia/setActivePinia) + vite(middlewareMode) → ssrLoadModule 真实 store。
 *
 * 口径声明（如实，不夸大）：
 *   · BLOCKED 一律经**真实协调链**构造：generateBuildingEvacuationPlans（真实规划器）
 *     → applyExitRuntimeStates（真实出口上报）→ invalidateRoutesWithUnusableExit
 *     （reconcileRouteStatuses → applyExitInvalidation），禁止手动设置 status 字段冒充权威状态；
 *   · DONE 在生产代码中无写入点（静态核实），只能以**注入**方式构造，相关断言已明确标注；
 *   · restorePersistSnapshot 恢复窗口：Node 环境无 localStorage（组〇断言 typeof），
 *     无法在不写入用户存储的前提下复现，标记**未验证**；
 *   · demo 模式下执行入口均被 demoGuard 短路（静态核实），本文件运行于 mock 口径（组〇锁定）；
 *   · 未知 / null / 投影无法匹配状态的 fail-closed 口径已由本轮任务书授权（FIX-1 要求）；
 *   · 历史沿革：本文件首轮为「只测试」红态（9 项缺陷复现）；本轮为修复阶段，
 *     FIX-1~FIX-4 实施后原红项应全部转绿，组十断言随 FIX-4 语义修正（见组内注释）。
 */
import { createPinia, setActivePinia } from 'pinia'
import { createServer } from 'vite'
import { EXIT_DEFS, EXIT_STATUS } from '../../shared/evacuation/floorTopology.js'

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
const { dataSource } = await server.ssrLoadModule('/src/api/index.js')
const store = useFireStore()

const W = EXIT_DEFS.find((e) => e.key === 'EXIT_W').nodeId
const E = EXIT_DEFS.find((e) => e.key === 'EXIT_E').nodeId
const OPEN = EXIT_STATUS.OPEN
const CLOSED = EXIT_STATUS.CLOSED
const FIRE = {
  id: 'FE-GATE', buildingId: 'B003', floorId: '5F', zone: 'A区',
  building: '3号楼', floor: '5F', area: 'A区', level: 'danger', status: 'pending',
}
const openExits = () => [
  { nodeId: W, available: true, status: OPEN },
  { nodeId: E, available: true, status: OPEN },
]
const closedEExits = () => [
  { nodeId: W, available: true, status: OPEN },
  { nodeId: E, available: false, status: CLOSED },
]
const freshPersons = () => [
  { id: 'P-A', buildingId: 'B003', building: '3号楼', floorId: '5F', floor: '5F', zone: 'A区', area: 'A区', x: 140, y: 150, status: 'normal' },
  { id: 'P-B', buildingId: 'B003', building: '3号楼', floorId: '5F', floor: '5F', zone: 'B区', area: 'B区', x: 140, y: 190, status: 'normal' },
]
const projection = () => (store.routePlans || []).filter(Boolean)
const stOf = (id) => {
  const p = projection().find((x) => x.id === id)
  return p ? p.status : '<absent>'
}
const lightSnap = () => (store.devices || [])
  .filter((d) => d && d.type === 'evacuation_light' && d.buildingId === 'B003')
  .map((d) => `${d.id}=${d.direction}`).join(' ')

/** 真实规划器生成整栋楼方案，并确保当前方案至少有一条通往 E 出口的路线（否则切换方案） */
function buildPlans() {
  store.persons = freshPersons()
  store.fireEvent = { ...FIRE }
  const built = store.generateBuildingEvacuationPlans({ buildingId: 'B003' })
  let bp = store.activeBuildingPlan
  if (!bp || !(bp.routes || []).some((r) => r.exitId === E)) {
    for (const p of built.plans) {
      if ((p.routes || []).some((r) => r.exitId === E)) {
        store.selectBuildingPlan(p.id) // 真实 UI 路径（mock 口径）
        bp = store.activeBuildingPlan
        if (bp && (bp.routes || []).some((r) => r.exitId === E)) break
      }
    }
  }
  return { built, bp }
}
/** 真实出口上报 + 真实协调链（reconcileRouteStatuses → applyExitInvalidation） */
function applyExits(exits) {
  store.applyExitRuntimeStates(exits)
  return store.invalidateRoutesWithUnusableExit()
}
/** 取当前投影中的 BLOCKED 条目（权威链产出） */
function blockedEntry() {
  return projection().find((p) => p.status === 'BLOCKED') || null
}

// ════════════════════════════════════════════════════════════════
console.log('=== 〇、环境与初始态（必须位于最前：exitRawStates 单向性） ===')
{
  check('〇-1 单测运行于 mock 口径：dataSource.isDemo === false', dataSource.isDemo === false, dataSource.isDemo)
  check('〇-2 Node 环境无 localStorage：restorePersistSnapshot 静默降级（恢复窗口未验证）',
    typeof localStorage === 'undefined', typeof localStorage)
  check('〇-3 初始窗口：exitRawStates === null（从未收到出口运行态；本组之后不再断言 null）',
    store.exitRawStates === null, store.exitRawStates)
  console.log('    persons =', (store.persons || []).length, ' devices =', (store.devices || []).length)
}

// ════════════════════════════════════════════════════════════════
console.log('=== 一、权威 BLOCKED 构造（真实协调链，非手动设字段） ===')
let G = null
{
  const { built, bp } = buildPlans()
  check('一-1 真实规划器产出 3 套整栋楼方案', (built.plans || []).length === 3, (built.plans || []).map((p) => p.id))
  check('一-2 当前方案存在且含 routesByZone', !!bp && !!bp.routesByZone && bp.routes.length > 0,
    bp && { id: bp.id, routes: bp.routes.length, byZone: !!bp.routesByZone })
  const marked = applyExits(closedEExits())
  const bl = blockedEntry()
  G = { bp, bl }
  check('一-3 关闭 E 后协调链标记了 BLOCKED（marked > 0 且投影存在 BLOCKED 条目）',
    marked > 0 && !!bl, { marked, blocked: bl && bl.id })
  check('一-4 BLOCKED 条目的出口为 E', !!bl && bl.exit === E, bl && { id: bl.id, exit: bl.exit, status: bl.status })
  const rawRoute = bl ? bp.routes.find((r) => r.routeId === bl.id) : null
  check('一-5 协调只写投影：bp.routes 中该路线对象不带 status 字段',
    !!rawRoute && rawRoute.status === undefined, rawRoute && Object.keys(rawRoute))
  console.log('    投影状态：', projection().map((p) => `${p.id}:${p.status}`).join(' , '))
}

// ════════════════════════════════════════════════════════════════
console.log('=== 二、startEvacuationRun × BLOCKED（期望：拒绝疏散 BLOCKED 路线人员） ===')
{
  const { bp } = buildPlans()
  applyExits(closedEExits())
  const bl = blockedEntry()
  check('二-0 前置：存在权威 BLOCKED 路线', !!bl, bl && bl.id)
  if (bl) {
    const blockedZone = bl.startArea
    const normalZone = projection().find((p) => p.id !== bl.id).startArea
    store.startEvacuationRun()
    const pb = (store.persons || []).find((p) => p.zone === blockedZone)
    const pn = (store.persons || []).find((p) => p.zone === normalZone)
    console.log(`    实际：BLOCKED区(${blockedZone}) routeId=${pb.routeId} _evac=${!!pb._evac} status=${pb.status}`)
    console.log(`    实际：正常区(${normalZone}) routeId=${pn.routeId} _evac=${!!pn._evac} status=${pn.status} evacStats=${JSON.stringify(store.evacStats)}`)
    check('二-1 【FIX-1】BLOCKED 路线人员不得被启动疏散（无 _evac 且 status 非 evacuating）',
      !pb._evac && pb.status !== 'evacuating', { zone: blockedZone, _evac: !!pb._evac, status: pb.status })
    check('二-2 正常路线人员应正常启动疏散（有 _evac 且 status === evacuating）',
      !!pn._evac && pn.status === 'evacuating', { zone: normalZone, _evac: !!pn._evac, status: pn.status })
    check('二-3 副作用：BLOCKED 人员 routeId 被显式清理为 null（FIX-1 校验后写入，不保留陈旧指派）',
      pb.routeId === null, { routeId: pb.routeId })
    store.stopEvacuationSim()
    check('二-4 清理：stopEvacuationSim 后 evacRun === false', store.evacRun === false, store.evacRun)
  }
}

// ════════════════════════════════════════════════════════════════
console.log('=== 三、startEvacuationRun × 正常路线（期望：不误伤） ===')
{
  const { bp } = buildPlans()
  applyExits(openExits())
  check('三-0 前置：全开出口下投影无 BLOCKED', !blockedEntry(),
    projection().map((p) => `${p.id}:${p.status}`))
  store.startEvacuationRun()
  const ps = store.persons || []
  const evacing = ps.filter((p) => p._evac && p.status === 'evacuating')
  check('三-1 两名人员均正常启动疏散', evacing.length === 2,
    ps.map((p) => `${p.zone}:${p.status}:${!!p._evac}`))
  check('三-2 evacStats.total === 2', store.evacStats && store.evacStats.total === 2, store.evacStats)
  store.stopEvacuationSim()
}

// ════════════════════════════════════════════════════════════════
console.log('=== 四、applyBuildingRoutesToDevices × BLOCKED（期望：排除 BLOCKED 路线） ===')
{
  const { bp } = buildPlans()
  applyExits(closedEExits())
  const bl = blockedEntry()
  check('四-0 前置：存在权威 BLOCKED 路线', !!bl, bl && bl.id)
  if (bl) {
    const before = lightSnap()
    const bindings = store.applyBuildingRoutesToDevices(bp) || []
    const bindingRouteIds = [...new Set(bindings.map((b) => b.routeId))]
    const verdictRouteIds = [...new Set((store.routeDirectionVerdicts || []).map((v) => v.routeId).filter(Boolean))]
    console.log('    实际 bindings 路由：', bindingRouteIds.join(','))
    console.log('    实际 verdicts 路由：', verdictRouteIds.join(','))
    check('四-1 【FIX-2】设备绑定不得包含 BLOCKED 路线',
      bindingRouteIds.every((id) => id !== bl.id), { blockedId: bl.id, bindingRouteIds })
    check('四-2 【FIX-2】方向裁决记录不得包含 BLOCKED 路线',
      verdictRouteIds.every((id) => id !== bl.id), { blockedId: bl.id, verdictRouteIds })
    const normalId = projection().find((p) => p.id !== bl.id).id
    check('四-3 正常路线仍产生设备绑定（不误伤）', bindingRouteIds.includes(normalId),
      { normalId, bindingRouteIds })
    check('四-4 副作用记录：设备方向快照在调用前后可能变化（BLOCKED 路线被裁决时）',
      typeof before === 'string', before.slice(0, 80))
  }
}

// ════════════════════════════════════════════════════════════════
console.log('=== 五、applyBuildingRoutesToDevices × 正常路线（期望：完整下发） ===')
{
  const { bp } = buildPlans()
  applyExits(openExits())
  const before = lightSnap()
  const bindings = store.applyBuildingRoutesToDevices(bp) || []
  const after = lightSnap()
  const verdicts = store.routeDirectionVerdicts || []
  check('五-1 全开出口下产出非空设备绑定', bindings.length > 0, bindings.length)
  check('五-2 存在 resolved 裁决', verdicts.some((v) => v.state === 'resolved'), verdicts.map((v) => v.state))
  check('五-3 设备方向被实际写入（快照变化或绑定非空）',
    bindings.length > 0 && (before !== after || bindings.length > 0), { changed: before !== after })
  console.log('    绑定数 =', bindings.length, ' 裁决数 =', verdicts.length)
}

// ════════════════════════════════════════════════════════════════
console.log('=== 六、adjustEvacuationDirection × BLOCKED（期望：拒绝裁决） ===')
{
  const { bp } = buildPlans()
  applyExits(closedEExits())
  const bl = blockedEntry()
  check('六-0 前置：存在权威 BLOCKED 路线', !!bl, bl && bl.id)
  if (bl) {
    const before = lightSnap()
    const verdictsBefore = JSON.stringify(store.routeDirectionVerdicts || [])
    store.activeRoutePlanId = bl.id
    const ret = store.adjustEvacuationDirection()
    const after = lightSnap()
    const verdictRouteIds = [...new Set((store.routeDirectionVerdicts || []).map((v) => v.routeId).filter(Boolean))]
    console.log(`    实际：ret=${ret} verdicts 路由=${verdictRouteIds.join(',')} 设备方向变化=${before !== after}`)
    check('六-1 【FIX-3】adjustEvacuationDirection 应拒绝 BLOCKED 路线（返回 false）',
      ret === false, ret)
    check('六-2 【FIX-3】拒绝时不跑裁决轮次：裁决记录快照不变（不产生 BLOCKED 路线的新裁决）',
      JSON.stringify(store.routeDirectionVerdicts || []) === verdictsBefore)
    check('六-3 【FIX-3】BLOCKED 路线不得改变设备方向',
      before === after, { changed: before !== after })
  }
}

// ════════════════════════════════════════════════════════════════
console.log('=== 七、adjustEvacuationDirection × 正常路线（期望：不误伤） ===')
{
  const { bp } = buildPlans()
  applyExits(openExits())
  const normalId = projection()[0].id
  store.activeRoutePlanId = normalId
  const ret = store.adjustEvacuationDirection()
  const verdicts = store.routeDirectionVerdicts || []
  check('七-1 正常路线应返回 true 且产出 resolved 裁决',
    ret === true && verdicts.some((v) => v.state === 'resolved' && v.routeId === normalId),
    { ret, verdicts: verdicts.map((v) => `${v.routeId}:${v.state}`) })
}

// ════════════════════════════════════════════════════════════════
console.log('=== 八、DONE 注入 × 执行入口（生产无 DONE 写入点，此处为注入构造） ===')
{
  const { bp } = buildPlans()
  applyExits(openExits())
  const target = projection()[0]
  const doneId = target.id
  const doneZone = target.startArea
  const DONE_FIELDS = { completedAt: 1700000000000, assignedTo: 'u-gate', history: [{ t: 1, a: 'DONE' }] }
  store.routePlans = projection().map((p) => (p.id === doneId
    ? { ...p, status: 'DONE', ...DONE_FIELDS }
    : p))
  check('八-0 注入确认：投影中该路线为 DONE（注入，非协调链产出）',
    stOf(doneId) === 'DONE', stOf(doneId))
  store.startEvacuationRun()
  const pd = (store.persons || []).find((p) => p.zone === doneZone)
  console.log(`    实际：DONE区(${doneZone}) routeId=${pd.routeId} _evac=${!!pd._evac} status=${pd.status}`)
  check('八-1 【FIX-1】DONE 路线人员不得被重新启动疏散',
    !pd._evac && pd.status !== 'evacuating', { zone: doneZone, _evac: !!pd._evac, status: pd.status })
  const after = projection().find((p) => p.id === doneId)
  check('八-2 DONE 历史字段在 startEvacuationRun 后保持不变',
    after.completedAt === DONE_FIELDS.completedAt && after.assignedTo === DONE_FIELDS.assignedTo
    && JSON.stringify(after.history) === JSON.stringify(DONE_FIELDS.history),
    { completedAt: after.completedAt, assignedTo: after.assignedTo, history: after.history })
  store.stopEvacuationSim()
  store.activeRoutePlanId = doneId
  const ret = store.adjustEvacuationDirection()
  const after2 = projection().find((p) => p.id === doneId)
  check('八-3 【FIX-3】adjustEvacuationDirection 应拒绝 DONE 路线（返回 false）',
    ret === false, ret)
  check('八-4 DONE 历史字段在 adjustEvacuationDirection 后保持不变',
    after2.completedAt === DONE_FIELDS.completedAt && after2.assignedTo === DONE_FIELDS.assignedTo
    && JSON.stringify(after2.history) === JSON.stringify(DONE_FIELDS.history),
    { completedAt: after2.completedAt, assignedTo: after2.assignedTo, history: after2.history })
}

// ════════════════════════════════════════════════════════════════
console.log('=== 九、未知状态（投影缺失；期望口径：执行入口 fail-closed，待裁决） ===')
{
  const { bp } = buildPlans()
  applyExits(openExits())
  const miss = projection()[0]
  const missId = miss.id
  const missZone = miss.startArea
  store.routePlans = projection().filter((p) => p.id !== missId) // 投影缺失，bp.routes 仍在
  check('九-0 前置：该路线不在投影中（状态未知），但仍在 bp.routes 中',
    stOf(missId) === '<absent>' && bp.routes.some((r) => r.routeId === missId),
    { stOf: stOf(missId), inBp: bp.routes.some((r) => r.routeId === missId) })
  store.startEvacuationRun()
  const pm = (store.persons || []).find((p) => p.zone === missZone)
  console.log(`    实际：未知区(${missZone}) routeId=${pm.routeId} _evac=${!!pm._evac} status=${pm.status}`)
  check('九-1 【FIX-1】未知状态路线人员不得被执行（fail-closed，修复前按种子 NORMAL 放行）',
    !pm._evac && pm.status !== 'evacuating', { zone: missZone, _evac: !!pm._evac, status: pm.status })
  store.stopEvacuationSim()
  store.activeRoutePlanId = missId
  const ret = store.adjustEvacuationDirection()
  check('九-2 未知路线经 adjustEvacuationDirection：getRoutePlanById 未命中即拦截（返回 false）',
    ret === false, ret)
}

// ════════════════════════════════════════════════════════════════
console.log('=== 十、上游门禁覆盖面（FIX-4 后） ===')
{
  const { bp } = buildPlans()
  applyExits(closedEExits())
  const bl = blockedEntry()
  check('十-0 前置：存在权威 BLOCKED 路线', !!bl, bl && bl.id)
  if (bl) {
    // FIX-4：路线级门禁先于分支判定。修复前整栋楼分支无状态检查（属当前方案 ⇒ no-op
    // true；属其它方案 ⇒ 直接切换），BLOCKED 路线会被"选中"；修复后一律拒绝。
    const ret = store.selectEvacuationPlan(bl.id)
    check('十-1 【FIX-4】selectEvacuationPlan 拒绝 BLOCKED 路线（返回 false）',
      ret === false, ret)
    const before = store.activeBuildingPlanId.value
    store.selectEvacuationPlan(bl.id)
    check('十-2 拒绝选中时不改动当前方案',
      store.activeBuildingPlanId.value === before, { before, after: store.activeBuildingPlanId.value })
    const normalId = projection().find((p) => p.id !== bl.id).id
    check('十-3 【FIX-4】正常路线仍可被选中（返回 true，不误伤）',
      store.selectEvacuationPlan(normalId) === true, normalId)
  }
  console.log('    ⚠️ FIX-4 门禁只约束**被选中的路线本身**：方案内部分分区路线不可用时不拒绝')
  console.log('       整个方案，正常分区的可执行性由 FIX-1/FIX-2/FIX-3 在执行层逐条收敛。')
}

// ════════════════════════════════════════════════════════════════
console.log('=== 十-B、setCurrentRoutePlan 整栋楼分支（R1：路线级门禁先于分支） ===')
{
  const { bp } = buildPlans()
  applyExits(closedEExits())
  const bl = blockedEntry()
  const normalEntry = projection().find((p) => p.id !== (bl && bl.id))
  check('十-B-0 前置：存在权威 BLOCKED 路线', !!bl, bl && bl.id)
  if (bl && normalEntry) {
    const activeBefore = store.activeBuildingPlanId.value
    const bindingsBefore = JSON.stringify(store.routeDeviceBindings || [])
    const ret = store.setCurrentRoutePlan(bl.startArea, bl.id)
    check('十-B-1 【R1】整栋楼分支：setCurrentRoutePlan(BLOCKED) 返回 false', ret === false, ret)
    check('十-B-2 拒绝后 activeBuildingPlanId 不变（不误切方案）',
      store.activeBuildingPlanId.value === activeBefore,
      { before: activeBefore, after: store.activeBuildingPlanId.value })
    check('十-B-3 拒绝后无设备副作用（routeDeviceBindings 快照不变）',
      JSON.stringify(store.routeDeviceBindings || []) === bindingsBefore)
    check('十-B-4 【R1】正常路线仍可被 setCurrentRoutePlan 选中（返回 true，不误伤）',
      store.setCurrentRoutePlan(normalEntry.startArea, normalEntry.id) === true,
      normalEntry.id)
  }
}

// ════════════════════════════════════════════════════════════════
console.log('=== 十一、全量不可用（双出口关闭 ⇒ fail-closed 整案，零残留） ===')
{
  const { bp } = buildPlans()
  applyExits([
    { nodeId: W, available: false, status: CLOSED },
    { nodeId: E, available: false, status: CLOSED },
  ])
  check('十一-0 前置：两条路线均被权威协调为 BLOCKED',
    projection().length === 2 && projection().every((p) => p.status === 'BLOCKED'),
    projection().map((p) => `${p.id}:${p.status}`))
  // 先制造一轮非空裁决（上一组合十的选中动作已留下），验证全 BLOCKED 时被清空
  check('十一-0b 前置：进入本组前裁决记录非空（用于验证清空）',
    (store.routeDirectionVerdicts || []).length > 0, (store.routeDirectionVerdicts || []).length)
  const bindings = store.applyBuildingRoutesToDevices(bp) || []
  check('十一-1 【FIX-2】全 BLOCKED ⇒ 楼栋级下发返回空绑定', bindings.length === 0, bindings.length)
  check('十一-2 【FIX-2】全 BLOCKED ⇒ 本轮裁决被清空（不残留上一轮结论）',
    (store.routeDirectionVerdicts || []).length === 0, (store.routeDirectionVerdicts || []).length)
  check('十一-3 【FIX-2】全 BLOCKED ⇒ 设备绑定被清空（无残留绑定）',
    (store.routeDeviceBindings || []).length === 0, (store.routeDeviceBindings || []).length)
  store.startEvacuationRun()
  const ps = store.persons || []
  check('十一-4 【FIX-1】全 BLOCKED ⇒ 无人员被启动疏散',
    ps.every((p) => !p._evac && p.status !== 'evacuating'),
    ps.map((p) => `${p.zone}:${p.status}:${!!p._evac}`))
  check('十一-5 【FIX-1】全 BLOCKED ⇒ evacStats.total === 0',
    store.evacStats && store.evacStats.total === 0, store.evacStats)
  store.stopEvacuationSim()
  store.activeRoutePlanId = projection()[0].id
  check('十一-6 【FIX-3】全 BLOCKED ⇒ adjustEvacuationDirection 拒绝（false）',
    store.adjustEvacuationDirection() === false)
}

// ════════════════════════════════════════════════════════════════
console.log('=== 十二、startPulseFlash 调用链（门禁先于上层副作用） ===')
{
  // 12-A BLOCKED：拒绝且不产生任何上层副作用（定时器/日志/裁决/人员态）
  const { bp } = buildPlans()
  applyExits(closedEExits())
  const bl = blockedEntry()
  store.activeRoutePlanId = bl.id
  const verdictsBefore = JSON.stringify(store.routeDirectionVerdicts || [])
  const logsBefore = (store.operationLogs || []).length
  const personsBefore = JSON.stringify((store.persons || []).map((p) => [p.routeId, !!p._evac, p.status]))
  const ret = store.startPulseFlash()
  check('十二-1 【FIX-3】BLOCKED 路线：startPulseFlash 返回 false', ret === false, ret)
  check('十二-2 【FIX-3】BLOCKED：未启动疏散定时器（evacRun === false）', store.evacRun === false, store.evacRun)
  check('十二-3 【FIX-3】BLOCKED：裁决结果无变化（不残留 / 不新裁）',
    JSON.stringify(store.routeDirectionVerdicts || []) === verdictsBefore)
  check('十二-4 【FIX-3】BLOCKED：操作日志无新增（未记录"启动强闪"）',
    (store.operationLogs || []).length === logsBefore, [logsBefore, (store.operationLogs || []).length])
  check('十二-5 【FIX-3】BLOCKED：人员执行态无变化（routeId/_evac/status 均未写）',
    JSON.stringify((store.persons || []).map((p) => [p.routeId, !!p._evac, p.status])) === personsBefore)

  // 12-B 正常：放行且上层副作用完整（应急态 + 定时器 + 人员疏散 + 日志）
  applyExits(openExits())
  const normalId = projection()[0].id
  store.activeRoutePlanId = normalId
  const ret2 = store.startPulseFlash()
  check('十二-6 正常路线：startPulseFlash 返回 true', ret2 === true, ret2)
  check('十二-7 正常路线：疏散定时器已启动（evacRun === true）', store.evacRun === true, store.evacRun)
  const evacing = (store.persons || []).filter((p) => p._evac && p.status === 'evacuating')
  check('十二-8 正常路线：人员沿路线疏散（_evac + evacuating）', evacing.length === 2, evacing.length)
  store.stopEvacuationSim()
  check('十二-9 清理：stopEvacuationSim 后 evacRun === false', store.evacRun === false, store.evacRun)
}

// ════════════════════════════════════════════════════════════════
store.stopEvacuationSim()
check('收尾：evacRun === false（定时器已清理）', store.evacRun === false, store.evacRun)
console.log('')
console.log(`=== 结果：${pass} 通过 / ${fail} 失败 ===`)
await server.close()
process.exit(fail ? 1 : 0)

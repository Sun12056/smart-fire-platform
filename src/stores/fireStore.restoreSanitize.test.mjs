/**
 * RW-2：restorePersistSnapshot 路线投影恢复清洗 —— 真实恢复链 + 门禁行为测试。
 *
 * 设施：沿用既有 `node xxx.test.mjs` 模式（自计数 + process.exit），
 *   pinia(createPinia/setActivePinia) + vite(middlewareMode) → ssrLoadModule 加载**真实 store**。
 * 关键差异：本文件在 store 模块执行前安装 localStorage 垫片并预置快照，
 *   使 restorePersistSnapshot → sanitizeRouteProjection 走**真实恢复链**，
 *   而不是对独立清洗函数做脱离调用链的测试。
 *
 * 口径声明（如实，不夸大）：
 *   · 未知 / 缺失 status 一律归一为 null（**不是 NORMAL**），执行门禁继续拒绝（fail-closed）；
 *   · DONE 及 completedAt / assignedTo / history 原样保留；
 *   · exitRawStates 不被恢复 / 清洗触碰（D1-A 语义不变）；
 *   · 不做历史格式迁移猜测：无法识别的结构按「剔除（结构损坏）/ 降级（状态未知）」处理；
 *   · 局部容错：单条坏路线不波及有效路线与无关业务状态。
 */
import { createPinia, setActivePinia } from 'pinia'
import { createServer } from 'vite'
import { buildBuildingGraph, dijkstra } from '../../shared/evacuation/routeGraph.js'

// ── 在 store 模块执行前安装 localStorage 垫片（真实恢复链的前提） ──
const PERSIST_KEY = 'fireStore.demoState.v1'
const mem = new Map()
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => { mem.set(k, String(v)) },
  removeItem: (k) => { mem.delete(k) },
}

const okPath = () => [
  { id: '5F:A_CENTER', floorId: '5F', key: 'A_CENTER', x: 140, y: 150, type: 'room' },
  { id: '1F:EXIT_W', floorId: '1F', key: 'EXIT_W', x: 72, y: 280, type: 'exit' },
]

// RP-GOOD 用真实图算法生成几何（与 deviceDirection 测试同法）—— 保证「NORMAL 路线
// 正常下发」断言考察的是门禁不误伤，而非稀疏夹具导致的零绑定。
const graph = buildBuildingGraph(6)
const best = dijkstra(graph, '5F:A_CENTER', '1F:EXIT_W', new Set(), new Set())
const realPath = best.path.map((id) => ({
  id,
  floorId: graph.nodes[id].floorId,
  key: graph.nodes[id].key,
  x: graph.nodes[id].x,
  y: graph.nodes[id].y,
  type: graph.nodes[id].type,
}))
const realFloors = [...new Set(best.path.map((id) => graph.nodes[id].floorId))]

// 预置快照：覆盖「缺 path / 缺 id / 缺 status / 未知 status / DONE / 悬空指针 /
// 区候选（不在 routePlans 的合法形态）/ perZone 额外键」全部缺陷类。
const SEED = {
  emergencyStage: 3,
  fireEvent: {
    id: 'FE-RW2', buildingId: 'B003', floorId: '5F', zone: 'A区',
    building: '3号楼', floor: '5F', area: 'A区',
  },
  routeBuildingId: 'B003',
  routeFloorId: '5F',
  routePlans: [
    { id: 'RP-GOOD', status: 'NORMAL', buildingId: 'B003', buildingName: '3号楼', exit: '1F:EXIT_W', exitId: '1F:EXIT_W', startArea: 'A区', floorsPassed: realFloors, path: realPath },
    { id: 'RP-BROKEN', status: 'NORMAL' },                                  // 缺 path ⇒ 剔除
    { status: 'NORMAL', path: okPath() },                                   // 缺 id ⇒ 剔除
    { id: 'RP-NOSTATUS', path: okPath() },                                  // 缺 status ⇒ 保留，status=null
    { id: 'RP-WEIRD', status: 'WEIRD', path: okPath() },                    // 未知 status ⇒ 保留，status=null
    { id: 'RP-DONE', status: 'DONE', completedAt: 1700000000, assignedTo: 'u1', history: [{ t: 1, a: 'DONE' }], path: okPath() },
  ],
  activeRoutePlanId: 'RP-GHOST',                                            // 悬空 ⇒ null
  routeMatrix: {
    buildingId: 'B003', buildingName: '3号楼', floorId: '5F',
    // RW-3：整栋楼投影标记（仅 syncLegacyRouteState 写入；legacy generateRoutePlans 无此字段）
    scope: 'BUILDING',
    areas: ['A区'],
    perZone: {
      'A区': {
        plans: [
          { id: 'RP-GOOD', status: 'NORMAL', path: okPath() },
          { id: 'RP-PZ-ONLY', status: 'WEIRD', path: okPath() },            // 区候选（不在 routePlans）⇒ status=null 保留
          { id: 'RP-PZ-BROKEN', status: 'NORMAL' },                         // 缺 path ⇒ 从区候选剔除
        ],
        recommendedId: 'RP-PZ-ONLY',   // 区候选内合法 ⇒ 保留（不得误清合法形态）
        backupId: 'RP-GHOST',          // 双跨皆无 ⇒ null
        extraKey: 'keep',              // 额外键保留
      },
    },
  },
}
mem.set(PERSIST_KEY, JSON.stringify(SEED))

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

const byId = (id) => (store.routePlans || []).find((p) => p && p.id === id) || null
const ids = () => (store.routePlans || []).map((p) => p.id)

// ════════════════════════════════════════════════════════════════
console.log('=== 一、真实恢复链：restorePersistSnapshot → sanitizeRouteProjection ===')
{
  check('一-1 routePlans：结构损坏剔除（RP-BROKEN 缺 path；缺 id 条目），保留 4 条',
    ids().length === 4 && !ids().includes('RP-BROKEN'), ids())
  check('一-2 缺 id 条目被剔除（不产生匿名路线）',
    (store.routePlans || []).every((p) => typeof p.id === 'string' && p.id), ids())
  check('一-3 缺失 status ⇒ 归一 null（不是 NORMAL）',
    byId('RP-NOSTATUS') && byId('RP-NOSTATUS').status === null, byId('RP-NOSTATUS') && byId('RP-NOSTATUS').status)
  check('一-4 未知 status（WEIRD）⇒ 归一 null（不是 NORMAL）',
    byId('RP-WEIRD') && byId('RP-WEIRD').status === null, byId('RP-WEIRD') && byId('RP-WEIRD').status)
  check('一-5 合法状态原样保留（NORMAL）',
    byId('RP-GOOD') && byId('RP-GOOD').status === 'NORMAL', byId('RP-GOOD') && byId('RP-GOOD').status)
  const d = byId('RP-DONE')
  check('一-6 DONE 及历史字段原样保留（completedAt/assignedTo/history）',
    d && d.status === 'DONE' && d.completedAt === 1700000000 && d.assignedTo === 'u1'
    && JSON.stringify(d.history) === JSON.stringify([{ t: 1, a: 'DONE' }]),
    d && { status: d.status, completedAt: d.completedAt, assignedTo: d.assignedTo, history: d.history })
  check('一-7 悬空 activeRoutePlanId ⇒ null', store.activeRoutePlanId === null, store.activeRoutePlanId)
  const m = store.routeMatrix
  const zp = m && m.perZone && m.perZone['A区']
  check('一-8 perZone 候选清洗：RP-PZ-BROKEN 剔除、RP-PZ-ONLY 保留（status=null）',
    !!zp && zp.plans.length === 2
    && zp.plans.some((p) => p.id === 'RP-PZ-ONLY' && p.status === null)
    && !zp.plans.some((p) => p.id === 'RP-PZ-BROKEN'),
    zp && zp.plans.map((p) => `${p.id}:${p.status}`))
  check('一-9 悬空 backupId ⇒ null；区候选内合法 recommendedId 保留（不误清）',
    !!zp && zp.backupId === null && zp.recommendedId === 'RP-PZ-ONLY',
    zp && { recommendedId: zp.recommendedId, backupId: zp.backupId })
  check('一-10 perZone 额外键保留', !!zp && zp.extraKey === 'keep', zp && zp.extraKey)
  const rep = store.routeProjectionRestoreReport
  check('一-11 恢复报告已记录（含 MISSING_PATH / MISSING_ID / ACTIVE_POINTER_DANGLING）',
    Array.isArray(rep) && rep.length >= 4
    && rep.some((x) => x.reason === 'MISSING_PATH')
    && rep.some((x) => x.reason === 'MISSING_ID')
    && rep.some((x) => x.reason === 'ACTIVE_POINTER_DANGLING'),
    rep)
  let zr = null
  let threw = null
  try { zr = store.getAllZoneRoutes() } catch (e) { threw = e }
  check('一-12 展示链 getAllZoneRoutes 不抛异常且返回数组',
    threw === null && Array.isArray(zr), threw && threw.message)
  check('一-13 D1-A：恢复后 exitRawStates 仍为 null（清洗不改写出口原始状态）',
    store.exitRawStates === null, store.exitRawStates)
  check('一-14 局部容错：无关业务状态保留（fireEvent / emergencyStage）',
    store.fireEvent && store.fireEvent.id === 'FE-RW2' && store.emergencyStage === 3,
    { fire: store.fireEvent && store.fireEvent.id, stage: store.emergencyStage })
  check('一-15 RW-3：真实恢复链下历史路线标志为 true（整栋楼投影 + 无当前方案）',
    store.hasStaleRoutesWithoutActivePlan === true, store.hasStaleRoutesWithoutActivePlan)
}

// ════════════════════════════════════════════════════════════════
console.log('=== 二、恢复后状态 × 执行门禁（真实调用链） ===')
{
  store.setSelectedZone('A区')
  check('二-1 FIX-4：selectEvacuationPlan(缺失 status ⇒ null) 返回 false',
    store.selectEvacuationPlan('RP-NOSTATUS') === false, store.activeRoutePlanId)
  check('二-2 FIX-4：selectEvacuationPlan(未知 status ⇒ null) 返回 false',
    store.selectEvacuationPlan('RP-WEIRD') === false, store.activeRoutePlanId)
  check('二-3 FIX-4：selectEvacuationPlan(DONE) 返回 false',
    store.selectEvacuationPlan('RP-DONE') === false, store.activeRoutePlanId)
  check('二-4 FIX-4：NORMAL 路线仍可选中（不误伤）',
    store.selectEvacuationPlan('RP-GOOD') === true, store.activeRoutePlanId)
  store.activeRoutePlanId = 'RP-NOSTATUS'
  check('二-5 FIX-3：adjustEvacuationDirection(null status) 返回 false',
    store.adjustEvacuationDirection() === false)
  const outNull = store.applyRouteToDevices(byId('RP-NOSTATUS'))
  check('二-6 R3：applyRouteToDevices(null status) 拒绝且返回空数组',
    Array.isArray(outNull) && outNull.length === 0, outNull)
  const outGood = store.applyRouteToDevices(byId('RP-GOOD'))
  check('二-7 R3：NORMAL 路线正常下发（不误伤）',
    Array.isArray(outGood) && outGood.length > 0, outGood && outGood.length)
}

// ════════════════════════════════════════════════════════════════
console.log('=== 三、sanitizeRouteProjection 粒度规则（直调真实函数） ===')
{
  // 3-A routeMatrix 兜底
  store.routeMatrix = null
  let r = store.sanitizeRouteProjection()
  check('三-1 routeMatrix=null ⇒ 保持 null', r.matrix === null && store.routeMatrix === null, r.matrix)
  store.routeMatrix = { buildingId: 'B003' } // 缺 areas / perZone
  r = store.sanitizeRouteProjection()
  check('三-2 routeMatrix 缺 areas/perZone ⇒ 兜底为空结构（消费链不崩）',
    !!r.matrix && Array.isArray(r.matrix.areas) && r.matrix.areas.length === 0
    && !!r.matrix.perZone && Object.keys(r.matrix.perZone).length === 0,
    r.matrix && { areas: r.matrix.areas, perZone: r.matrix.perZone })
  store.routeMatrix = { perZone: { 'B区': { plans: [{ id: 'X', status: 'NORMAL', path: okPath() }] } } } // 缺 areas
  r = store.sanitizeRouteProjection()
  check('三-3 routeMatrix 缺 areas ⇒ 由 perZone 键派生',
    Array.isArray(r.matrix.areas) && r.matrix.areas[0] === 'B区', r.matrix.areas)

  // 3-B 指针
  store.routePlans = [{ id: 'KEEP', status: 'NORMAL', path: okPath() }]
  store.activeRoutePlanId = 'KEEP'
  store.sanitizeRouteProjection()
  check('三-4 合法 activeRoutePlanId 保留', store.activeRoutePlanId === 'KEEP', store.activeRoutePlanId)
  store.activeRoutePlanId = 'GONE'
  store.sanitizeRouteProjection()
  check('三-5 悬空 activeRoutePlanId ⇒ null', store.activeRoutePlanId === null, store.activeRoutePlanId)

  // 3-C DONE 保护 + 局部容错 + 无关状态
  store.routePlans = [
    { id: 'D1', status: 'DONE', completedAt: 42, assignedTo: 'u9', history: [{ t: 2, a: 'DONE' }], path: okPath() },
    { id: 'BAD' },                 // 缺 path ⇒ 剔除
    null,                          // 非对象 ⇒ 剔除
    { id: 'OK', status: 'NORMAL', path: okPath() },
  ]
  store.activeRoutePlanId = null
  store.routeMatrix = null
  const feBefore = JSON.stringify(store.fireEvent)
  const stageBefore = store.emergencyStage
  r = store.sanitizeRouteProjection()
  const d1 = byId('D1')
  check('三-6 DONE 历史字段清洗前后一致',
    !!d1 && d1.completedAt === 42 && d1.assignedTo === 'u9'
    && JSON.stringify(d1.history) === JSON.stringify([{ t: 2, a: 'DONE' }]),
    d1 && { completedAt: d1.completedAt, assignedTo: d1.assignedTo, history: d1.history })
  check('三-7 局部容错：单条坏路线（缺 path / null）不影响其他路线',
    ids().join(',') === 'D1,OK', ids())
  check('三-8 无关业务状态不被清洗触碰（fireEvent / emergencyStage）',
    JSON.stringify(store.fireEvent) === feBefore && store.emergencyStage === stageBefore,
    { stage: store.emergencyStage })
  check('三-9 清洗不触碰 exitRawStates（D1-A）', store.exitRawStates === null, store.exitRawStates)
  check('三-10 清洗不触碰 manualExecutableRoutes',
    Array.isArray(store.manualExecutableRoutes), typeof store.manualExecutableRoutes)
}

// ════════════════════════════════════════════════════════════════
console.log('=== 四、RW-3 派生状态：hasStaleRoutesWithoutActivePlan ===')
{
  const okPlan = () => ({ id: 'STALE-1', status: 'NORMAL', path: okPath() })

  // 4-A legacy 投影（matrix 无 scope）⇒ false：legacy 路线是当前有效路线，不得误标
  store.routePlans = [okPlan()]
  store.buildingEvacuationPlans = []
  store.activeBuildingPlanId = null
  store.routeMatrix = { buildingId: 'B003', floorId: '5F', areas: ['A区'], perZone: {} }
  check('四-1 legacy 投影（matrix 无 scope）⇒ false（不误标 legacy 路线）',
    store.hasStaleRoutesWithoutActivePlan === false, store.hasStaleRoutesWithoutActivePlan)

  // 4-B 整栋楼投影标记 + 无方案 ⇒ true
  store.routeMatrix = { buildingId: 'B003', floorId: '5F', scope: 'BUILDING', areas: ['A区'], perZone: {} }
  check('四-2 scope=BUILDING 且无当前方案 ⇒ true（历史整栋楼路线）',
    store.hasStaleRoutesWithoutActivePlan === true, store.hasStaleRoutesWithoutActivePlan)

  // 4-C 存在当前方案 ⇒ false（重建后标记消失）
  const bp = { id: 'BP-RW3', scope: 'BUILDING', routes: [] }
  store.buildingEvacuationPlans = [bp]
  store.activeBuildingPlanId = 'BP-RW3'
  check('四-3 存在当前方案 ⇒ false（重建后标记消失）',
    store.hasStaleRoutesWithoutActivePlan === false, store.hasStaleRoutesWithoutActivePlan)
  store.buildingEvacuationPlans = []
  store.activeBuildingPlanId = null

  // 4-D routePlans 为空 ⇒ false
  store.routePlans = []
  check('四-4 routePlans 为空 ⇒ false（无历史路线）',
    store.hasStaleRoutesWithoutActivePlan === false, store.hasStaleRoutesWithoutActivePlan)

  // 4-E routeMatrix 为 null ⇒ false（无法证明是整栋楼投影）
  store.routePlans = [okPlan()]
  store.routeMatrix = null
  check('四-5 routeMatrix=null ⇒ false（无法证明是整栋楼投影）',
    store.hasStaleRoutesWithoutActivePlan === false, store.hasStaleRoutesWithoutActivePlan)

  // 4-F 纯展示态：读取标志零副作用
  store.routeMatrix = { buildingId: 'B003', floorId: '5F', scope: 'BUILDING', areas: ['A区'], perZone: {} }
  const plansBefore = JSON.stringify(store.routePlans)
  const fireBefore = JSON.stringify(store.fireEvent)
  void store.hasStaleRoutesWithoutActivePlan
  check('四-6 读取标志零副作用（不写 routePlans / fireEvent）',
    JSON.stringify(store.routePlans) === plansBefore && JSON.stringify(store.fireEvent) === fireBefore)
}

console.log('')
console.log(`=== 结果：${pass} 通过 / ${fail} 失败 ===`)
await server.close()
process.exit(fail ? 1 : 0)

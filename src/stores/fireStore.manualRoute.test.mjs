/**
 * K-1B.2 专项测试：权威图统一暴露 + 沿权威图选点 + 独立手动可执行路线生命周期。
 *
 * 设施：沿用既有 `node xxx.test.mjs` 模式（自计数 + process.exit），不新增测试框架依赖。
 * 引导方式与 fireStore.exitInvalidation.test.mjs 一致：pinia + vite(middlewareMode)
 *   → ssrLoadModule('/src/stores/fireStore.js') → useFireStore()。
 *
 * 范围声明（如实，不夸大）：
 *   · localStorage 在 Node 下不可用，恢复快照的 localStorage 集成不在此执行；
 *     本套件直接驱动导出的 sanitizeManualExecutableRoutes / 各生命周期函数验证核心语义。
 *   · 不修改 Worker / 共享拓扑 / routeValidator / Dijkstra / Yen（K-1B.3 / K-1B.4 未实施）。
 */
import { createPinia, setActivePinia } from 'pinia'
import { createServer } from 'vite'
import { buildBuildingGraph } from '../../shared/evacuation/routeGraph.js'
import { EXIT_NODE_IDS } from '../../shared/evacuation/floorTopology.js'

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

const W = '1F:EXIT_W'
const E = '1F:EXIT_E'

/** B003 权威图（与 store 内部 getBuildingFloors('B003') 同源） */
const b003 = store.buildings.find((x) => x.id === 'B003')
const b003Floors = b003 && b003.floors ? b003.floors : 6
const expectedGraph = buildBuildingGraph(b003Floors)

// ── 一条合法的完整路径：5F A区 → 走廊 → 西北楼梯 → 逐层下降到 1F → 西出口 ──
const FULL_PATH = [
  '5F:A_CENTER', '5F:CORRIDOR_N', '5F:CORRIDOR_W', '5F:STAIR_NW',
  '4F:STAIR_NW', '3F:STAIR_NW', '2F:STAIR_NW', '1F:STAIR_NW',
  '1F:CORRIDOR_W', W,
]
// ── 一条通往东出口的合法完整路径：5F A区 → 走廊 → 东北楼梯（NE 全层可用）→ 1F → 东出口 ──
const PATH_TO_E = [
  '5F:A_CENTER', '5F:CORRIDOR_N', '5F:CORRIDOR_CENTER', '5F:CORRIDOR_S', '5F:CORRIDOR_E',
  '5F:STAIR_NE', '4F:STAIR_NE', '3F:STAIR_NE', '2F:STAIR_NE', '1F:STAIR_NE', E,
]

console.log('=== 一、权威图构建与当前楼栋上下文（K-1B.2 要求 1）===')
{
  store.routeBuildingId = 'B003'
  const g = store.authoritativeRouteGraph
  check('B003：authoritativeRouteGraph 非空', !!g, g && Object.keys(g.nodes).length)
  check('B003：图结构与 buildBuildingGraph(floors) 一致（节点数相同）',
    !!g && Object.keys(g.nodes).length === Object.keys(expectedGraph.nodes).length,
    { got: g && Object.keys(g.nodes).length, want: Object.keys(expectedGraph.nodes).length })
  check('B003：maxFloor 与楼栋层数一致',
    !!g && g.maxFloor === Number(b003Floors), { got: g && g.maxFloor, want: b003Floors })
  check('B003：邻接表结构一致（5F:A_CENTER 只接门厅）',
    !!g && JSON.stringify(g.adj['5F:A_CENTER'].map((e) => e.to)) === JSON.stringify(['5F:CORRIDOR_N']),
    g && g.adj['5F:A_CENTER'])

  // 明确失败：无法识别的楼栋必须返回 null，不得静默回退
  store.routeBuildingId = 'B999'
  check('不存在的楼栋 B999：authoritativeRouteGraph === null（明确失败，不静默回退）',
    store.authoritativeRouteGraph === null, store.authoritativeRouteGraph)
  store.routeBuildingId = ''
  check('空楼栋 id：authoritativeRouteGraph === null',
    store.authoritativeRouteGraph === null, store.authoritativeRouteGraph)
  store.routeBuildingId = 'B003'
}

console.log('=== 二、起点类型限制（K-1B.2 要求 2）===')
{
  store.resetAuthGraphSelection()
  check('ROOM 节点 5F:A_CENTER 可作起点', store.isAuthStartNode('5F:A_CENTER') === true)
  check('CORRIDOR 节点 5F:CORRIDOR_N 不可作起点', store.isAuthStartNode('5F:CORRIDOR_N') === false)
  check('STAIR 节点 5F:STAIR_NW 不可作起点', store.isAuthStartNode('5F:STAIR_NW') === false)
  check('EXIT 节点 1F:EXIT_W 不可作起点', store.isAuthStartNode('1F:EXIT_W') === false)

  check('pickAuthGraphStart(ROOM) 成功', store.pickAuthGraphStart('5F:A_CENTER') === true)
  check('选中后 authGraphPath == [5F:A_CENTER]',
    JSON.stringify(store.authGraphPath) === JSON.stringify(['5F:A_CENTER']), store.authGraphPath)
  check('pickAuthGraphStart(CORRIDOR) 被拒绝', store.pickAuthGraphStart('5F:CORRIDOR_N') === false)
  check('拒绝后 authGraphPath 不变',
    JSON.stringify(store.authGraphPath) === JSON.stringify(['5F:A_CENTER']), store.authGraphPath)
  store.resetAuthGraphSelection()
}

console.log('=== 三、只能沿真实邻接选点（K-1B.2 要求 3）===')
{
  store.pickAuthGraphStart('5F:A_CENTER')
  check('5F:A_CENTER 的真实邻接恰为 [5F:CORRIDOR_N]',
    JSON.stringify(store.authAdjacentNodeIds('5F:A_CENTER')) === JSON.stringify(['5F:CORRIDOR_N']),
    store.authAdjacentNodeIds('5F:A_CENTER'))
  check('appendAuthGraphNode(邻接节点) 成功', store.appendAuthGraphNode('5F:CORRIDOR_N') === true)
  check('appendAuthGraphNode(非邻接节点 CORRIDOR_S) 被拒绝',
    store.appendAuthGraphNode('5F:CORRIDOR_S') === false)
  check('拒绝后 authGraphPath 长度仍为 2',
    store.authGraphPath.length === 2 && store.authGraphPath[1] === '5F:CORRIDOR_N', store.authGraphPath)
  check('authGraphError 记录 NOT_ADJACENT', store.authGraphError === 'NOT_ADJACENT', store.authGraphError)
  check('撤销上一步回到仅起点', store.undoAuthGraphStep() === true && store.authGraphPath.length === 1)
  store.resetAuthGraphSelection()
}

console.log('=== 四、非法跨层路径不可选 / 上升边不可选（K-1B.2 要求 4）===')
{
  check('5F:A_CENTER → 4F:A_CENTER 无邻接边', store.canAuthStep('5F:A_CENTER', '4F:A_CENTER') === false)
  check('5F:CORRIDOR_W → 4F:CORRIDOR_W 无邻接边（走廊不跨层直连）',
    store.canAuthStep('5F:CORRIDOR_W', '4F:CORRIDOR_W') === false)
  // 下降边单向：只能下不能上
  check('5F:STAIR_NW → 4F:STAIR_NW 存在合法下降边', store.canAuthStep('5F:STAIR_NW', '4F:STAIR_NW') === true)
  check('4F:STAIR_NW → 5F:STAIR_NW 上升边不可选', store.canAuthStep('4F:STAIR_NW', '5F:STAIR_NW') === false)
}

console.log('=== 五、不存在的楼梯下降边不可选（K-1B.2 要求 5）===')
{
  // 6F STAIR_NW（S-A）检修停用 ⇒ 无 6F→5F 下降边（即便 6F:STAIR_NW 节点仍存在）
  check('6F:STAIR_NW 节点存在（楼梯实体保留）', !!store.authoritativeRouteGraph.nodes['6F:STAIR_NW'])
  check('6F:STAIR_NW → 5F:STAIR_NW 下降边不可选（S-A 6F 停用）',
    store.canAuthStep('6F:STAIR_NW', '5F:STAIR_NW') === false)
  // 对照：6F STAIR_SE（S-D）在 6F 可用 ⇒ 下降边存在
  check('6F:STAIR_SE → 5F:STAIR_SE 下降边可选（S-D 6F 可用）',
    store.canAuthStep('6F:STAIR_SE', '5F:STAIR_SE') === true)
}

console.log('=== 六、终点必须属于规范出口节点集合（K-1B.2 要求 6）===')
{
  check('EXIT_NODE_IDS 恰为 [1F:EXIT_W, 1F:EXIT_E]',
    JSON.stringify(EXIT_NODE_IDS.slice().sort()) === JSON.stringify([W, E].sort()),
    EXIT_NODE_IDS)
  check('1F:EXIT_W 是规范出口', store.isAuthExitNode(W) === true)
  check('1F:EXIT_E 是规范出口', store.isAuthExitNode(E) === true)
  check('5F:CORRIDOR_N 不是规范出口', store.isAuthExitNode('5F:CORRIDOR_N') === false)
  check('5F:STAIR_NW 不是规范出口', store.isAuthExitNode('5F:STAIR_NW') === false)
}

console.log('=== 七、exitId 与选定终点一致 + 全路径构建（K-1B.2 要求 7）===')
{
  const built = store.buildManualExecutableRoute(FULL_PATH)
  check('全路径构建成功', built.ok === true, built)
  check('exitId === 终点节点 1F:EXIT_W', built.route.exitId === W, built.route.exitId)
  check('nodes 末位 === exitId', built.route.nodes[built.route.nodes.length - 1] === W)
  check('startNode === 首节点 5F:A_CENTER', built.route.startNode === '5F:A_CENTER')
  check('points 从权威图节点数据派生（与 nodes 等长且含 floorId）',
    built.route.points.length === built.route.nodes.length
    && built.route.points.every((p) => typeof p.x === 'number' && typeof p.y === 'number' && typeof p.floorId === 'string'))
  check('floorsPassed 从权威图推导为 5F→4F→3F→2F→1F',
    JSON.stringify(built.route.floorsPassed) === JSON.stringify(['5F', '4F', '3F', '2F', '1F']),
    built.route.floorsPassed)
  check('不携带 validated / reachable / status 等可信运行时结论',
    !('validated' in built.route) && !('reachable' in built.route) && !('status' in built.route)
    && !('valid' in built.route), Object.keys(built.route))

  // 非法终点：相邻但末位不是规范出口节点
  const bad = store.buildManualExecutableRoute(['5F:A_CENTER', '5F:CORRIDOR_N'])
  check('以非出口节点结尾被拒绝（INVALID_EXIT）', bad.ok === false && bad.reason === 'INVALID_EXIT', bad)

  // 非法跳点：去掉中间下降边（A_CENTER 直接到 CORRIDOR_W，不邻接）
  const jump = store.buildManualExecutableRoute(['5F:A_CENTER', '5F:CORRIDOR_W', W])
  check('存在不邻接跳点被拒绝（NOT_ADJACENT）', jump.ok === false && jump.reason === 'NOT_ADJACENT', jump)
}

console.log('=== 八、保存 / 按 ID 替换 / 删除 / 重复 ID 防护（K-1B.2 要求 8、9）===')
{
  store.manualExecutableRoutes = []
  const created = store.createManualExecutableRoute({
    id: 'RP-MANUAL-TEST-1', type: 'manual-executable', buildingId: 'B003',
    startNode: '5F:A_CENTER', exitId: W, nodes: FULL_PATH.slice(), points: [], floorsPassed: [],
  })
  check('创建成功且 id 保留', created.ok === true && created.route.id === 'RP-MANUAL-TEST-1')
  check('创建后派生字段由权威数据生成（points 与 nodes 等长、floorsPassed 正确）',
    created.route.points.length === created.route.nodes.length
    && JSON.stringify(created.route.floorsPassed) === JSON.stringify(['5F', '4F', '3F', '2F', '1F']))
  check('集合长度为 1', store.manualExecutableRoutes.length === 1)
  // 重复 ID：使用合法路线但重复 id，必须被 DUPLICATE_ID 拒绝（而非因路径非法）
  const dup = store.createManualExecutableRoute({ id: 'RP-MANUAL-TEST-1', nodes: FULL_PATH.slice() })
  check('重复 ID 创建被拒绝（DUPLICATE_ID）', dup.ok === false && dup.reason === 'DUPLICATE_ID', dup)
  check('重复创建后集合长度仍为 1', store.manualExecutableRoutes.length === 1)

  // 按 ID 替换（编辑保存）：用合法通往东出口的路径替换，保留 id / createdAt
  const replaced = store.replaceManualExecutableRoute('RP-MANUAL-TEST-1', { id: 'RP-MANUAL-TEST-1', nodes: PATH_TO_E.slice() })
  check('替换返回 true', replaced === true)
  check('替换后集合长度仍为 1（不累积重复项）', store.manualExecutableRoutes.length === 1)
  check('替换后 exitId 更新为 1F:EXIT_E', store.manualExecutableRoutes[0].exitId === E)
  check('替换后 id 保持 RP-MANUAL-TEST-1', store.manualExecutableRoutes[0].id === 'RP-MANUAL-TEST-1')
  check('替换后 createdAt 语义保留（仍为原创建时间）',
    store.manualExecutableRoutes[0].createdAt === created.route.createdAt,
    [store.manualExecutableRoutes[0].createdAt, created.route.createdAt])
  check('替换后 updatedAt 已更新', store.manualExecutableRoutes[0].updatedAt >= store.manualExecutableRoutes[0].createdAt)

  // 删除
  check('删除不存在 id 返回 false', store.deleteManualExecutableRoute('RP-MANUAL-NOPE') === false)
  check('按 ID 删除成功', store.deleteManualExecutableRoute('RP-MANUAL-TEST-1') === true)
  check('删除后集合为空', store.manualExecutableRoutes.length === 0)

  // 未显式提供 id 时生成唯一 RP-MANUAL- 前缀 id
  const gen = store.createManualExecutableRoute({ exitId: W, nodes: FULL_PATH.slice() })
  check('未提供 id 时生成 RP-MANUAL- 前缀 id',
    gen.ok === true && /^RP-MANUAL-/.test(gen.route.id), gen.route.id)
  store.manualExecutableRoutes = []
}

console.log('=== 九、自由绘制草稿不进入独立路线集合（K-1B.2 要求 10）===')
{
  store.manualExecutableRoutes = []
  store.routeNodes = [{ id: 'MN-1', x: 100, y: 100, type: 'waypoint' }]
  store.routeEdges = [['MN-1']]
  const draft = store.saveManualRoute()
  check('自由绘制生成草稿（id 前缀 RP-MANUAL-DRAFT-）', /^RP-MANUAL-DRAFT-/.test(draft.id), draft.id)
  check('草稿进入 manualRouteDrafts 集合', store.manualRouteDrafts.some((d) => d.id === draft.id))
  check('草稿**不**进入 manualExecutableRoutes 集合', store.manualExecutableRoutes.length === 0)
  check('草稿**不**进入 routePlans 集合', !store.routePlans.some((p) => p && p.id === draft.id),
    store.routePlans.map((p) => p && p.id))
  store.deleteManualRouteDraft(draft.id)
  check('草稿删除后 manualRouteDrafts 为空', store.manualRouteDrafts.length === 0)
  store.routeNodes = []
  store.routeEdges = []
}

console.log('=== 十、旧持久化快照缺少新字段 → 空集合默认值（K-1B.2 要求 11）===')
{
  check('缺字段（undefined）→ clean 为空、dropped 为空',
    (() => { const r = store.sanitizeManualExecutableRoutes(undefined); return r.clean.length === 0 && r.dropped.length === 0 })(),
    store.sanitizeManualExecutableRoutes(undefined))
  check('缺字段（null）→ clean 为空、dropped 为空',
    (() => { const r = store.sanitizeManualExecutableRoutes(null); return r.clean.length === 0 && r.dropped.length === 0 })(),
    store.sanitizeManualExecutableRoutes(null))
  check('初始 manualExecutableRoutes 为空集合', Array.isArray(store.manualExecutableRoutes) && store.manualExecutableRoutes.length === 0)
}

console.log('=== 十一、结构损坏与拓扑失效处理区分（K-1B.2 要求 12）===')
{
  const mixed = [
    null,                                                   // 结构损坏：非对象
    { id: 123, exitId: W, nodes: [] },                      // 结构损坏：id 非字符串
    { id: 'a', exitId: W, nodes: 'not-array' },             // 结构损坏：nodes 非数组
    { id: 'b', exitId: W, nodes: [1, 2] },                  // 结构损坏：nodes 元素非字符串
    { id: 'c', exitId: 7, nodes: ['5F:A_CENTER'] },         // 结构损坏：exitId 非字符串
    { id: 'd', exitId: W, nodes: ['5F:A_CENTER', W] },      // 结构完整但拓扑失效（A_CENTER 与 W 不邻接）
  ]
  const r = store.sanitizeManualExecutableRoutes(mixed)
  check('结构损坏记录被剔除（dropped = 5 条）', r.dropped.length === 5, r.dropped)
  check('剔除结果可诊断（含 reason）', r.dropped.every((d) => typeof d.reason === 'string'), r.dropped)
  check('结构完整但拓扑失效的记录被保留（clean 含 d）',
    r.clean.length === 1 && r.clean[0].id === 'd', r.clean.map((x) => x.id))
  check('保留记录未被写回 validated / valid / status 等结论字段',
    r.clean.every((x) => !('validated' in x) && !('valid' in x) && !('status' in x)))
  // 对照：同一拓扑失效路径在「新建校验」时被拒绝，证明「保留 ≠ 有效」
  const build = store.buildManualExecutableRoute(['5F:A_CENTER', W])
  check('拓扑失效路径在新建校验时被拒绝（NOT_ADJACENT）',
    build.ok === false && build.reason === 'NOT_ADJACENT', build)
}

console.log('=== 十二、不修改自动路线 / 区域指针 / activeBuildingPlan.routes（K-1B.2 要求 13）===')
{
  const mkRoute = (routeId, floorId, zone, exitId) => ({
    routeId, floorId, zone, startNode: `${floorId}:A_CENTER`, exitId, exitLabel: exitId,
    nodes: [`${floorId}:A_CENTER`, exitId], points: [{ x: 0, y: 0 }, { x: 0, y: 0 }],
    distance: 10, estimatedTime: 8, riskLevel: 'low', valid: true, reasons: [],
    floorsPassed: [floorId], fireDistance: 10, escapeDistance: 5, exitDistance: 1,
    personCount: 1, sourcePlanId: 'cand-1',
  })
  const BP = {
    id: 'PLAN-A', name: '策略A', buildingId: 'B003', buildingName: '3号楼',
    scope: 'BUILDING', strategy: 'balanced', strategyLabel: 'A', recommended: true,
    fire: null, summary: { zoneCount: 1, personCount: 1, exits: {}, floors: ['5F'] },
    routes: [mkRoute('PLAN-A:5F:A区', '5F', 'A区', W)],
    routesByZone: { '5F:A区': mkRoute('PLAN-A:5F:A区', '5F', 'A区', W) },
    status: 'NORMAL', valid: true, reasons: [], createdAt: null,
  }
  store.routeFloorId = '5F'
  store.selectedZone = 'A区'
  store.applyBuildingPlans({ buildingPlans: [BP], activeBuildingPlanId: 'PLAN-A' })

  const rpBefore = JSON.stringify(store.routePlans)
  const rmBefore = JSON.stringify(store.routeMatrix)
  const bpRoutesBefore = JSON.stringify(store.activeBuildingPlan.routes)

  store.manualExecutableRoutes = []
  store.createManualExecutableRoute({
    id: 'RP-MANUAL-ISO-1', exitId: W, nodes: FULL_PATH.slice(), buildingId: 'B003',
  })
  store.replaceManualExecutableRoute('RP-MANUAL-ISO-1', { exitId: E, nodes: PATH_TO_E.slice(), buildingId: 'B004' })
  store.deleteManualExecutableRoute('RP-MANUAL-ISO-1')

  check('routePlans 未被改动', JSON.stringify(store.routePlans) === rpBefore)
  check('routeMatrix（perZone 指针）未被改动', JSON.stringify(store.routeMatrix) === rmBefore)
  check('activeBuildingPlan.routes 未被改动', JSON.stringify(store.activeBuildingPlan.routes) === bpRoutesBefore)
}

console.log('=== 十三、端到端：沿权威图逐节点选点 → 保存（exitId 一致）===')
{
  store.routeBuildingId = 'B003'
  store.manualExecutableRoutes = []
  store.resetAuthGraphSelection()
  let ok = store.pickAuthGraphStart(FULL_PATH[0])
  for (let i = 1; i < FULL_PATH.length; i++) {
    ok = ok && store.appendAuthGraphNode(FULL_PATH[i])
  }
  check('逐节点选点全链路成功', ok === true, store.authGraphPath)
  check('保存前 isPathComplete 为真（终点为规范出口）',
    store.authGraphPath.length >= 2 && store.isAuthExitNode(store.authGraphPath[store.authGraphPath.length - 1]))
  const saved = store.saveAuthGraphRoute()
  check('保存成功', saved.ok === true, saved)
  check('保存后 manualExecutableRoutes 含 1 条且 exitId === 1F:EXIT_W',
    store.manualExecutableRoutes.length === 1 && store.manualExecutableRoutes[0].exitId === W,
    store.manualExecutableRoutes[0] && store.manualExecutableRoutes[0].exitId)
  check('保存后编辑态复位（authGraphPath 为空、draftId 为 null）',
    store.authGraphPath.length === 0 && store.authGraphDraftId === null)
  // 编辑保存：载入 → 换终点 → 保存 → 按 ID 替换
  const rid = store.manualExecutableRoutes[0].id
  store.loadAuthGraphRouteForEdit(rid)
  check('载入既有路线进入替换模式（draftId === 该 id）', store.authGraphDraftId === rid, store.authGraphDraftId)
  store.resetAuthGraphSelection(rid)
  store.pickAuthGraphStart(PATH_TO_E[0])
  for (let i = 1; i < PATH_TO_E.length; i++) {
    const okStep = store.appendAuthGraphNode(PATH_TO_E[i])
    if (!okStep) break
  }
  const saved2 = store.saveAuthGraphRoute()
  check('编辑保存成功且 exitId 更新为 1F:EXIT_E', saved2.ok === true && saved2.route.exitId === E, saved2.route && saved2.route.exitId)
  check('编辑保存后集合仍为 1 条（按 ID 替换，不累积）', store.manualExecutableRoutes.length === 1)
  store.manualExecutableRoutes = []
}

console.log('=== 十四、F1：公开写入口强制校验（直接调用 create / replace）===')
{
  store.routeBuildingId = 'B003'
  store.manualExecutableRoutes = []

  // 1. 非法起点被拒绝
  const badStart = store.createManualExecutableRoute({
    nodes: ['5F:CORRIDOR_N', '5F:CORRIDOR_W', '5F:STAIR_NW', '4F:STAIR_NW', '3F:STAIR_NW', '2F:STAIR_NW', '1F:STAIR_NW', '1F:CORRIDOR_W', W],
  })
  check('F1 非法起点（CORRIDOR）被拒绝', badStart.ok === false && badStart.reason === 'INVALID_START_TYPE', badStart)

  // 2. 非法邻接被拒绝
  const badAdj = store.createManualExecutableRoute({ nodes: ['5F:A_CENTER', '5F:CORRIDOR_S', W] })
  check('F1 非法邻接被拒绝（NOT_ADJACENT）', badAdj.ok === false && badAdj.reason === 'NOT_ADJACENT', badAdj)

  // 3. 非法出口终点被拒绝
  const badExit = store.createManualExecutableRoute({ nodes: ['5F:A_CENTER', '5F:CORRIDOR_N'] })
  check('F1 非法出口终点被拒绝（INVALID_EXIT）', badExit.ok === false && badExit.reason === 'INVALID_EXIT', badExit)

  // 4. 上升边被拒绝（下降方向约束）
  const badAscent = store.createManualExecutableRoute({
    nodes: ['5F:A_CENTER', '5F:CORRIDOR_W', '5F:STAIR_NW', '4F:STAIR_NW', '5F:STAIR_NW'],
  })
  check('F1 上升边被拒绝（NOT_ADJACENT）', badAscent.ok === false && badAscent.reason === 'NOT_ADJACENT', badAscent)

  // 5. exitId 与末节点不一致 → 由权威数据重新派生（忽略调用方 exitId）
  const mismatch = store.createManualExecutableRoute({ id: 'RP-MANUAL-MM-1', exitId: W, nodes: PATH_TO_E.slice() })
  check('F1 调用方 exitId 与末节点不一致 → 以末节点派生（exitId === 1F:EXIT_E）',
    mismatch.ok === true && mismatch.route.exitId === E, mismatch.route && mismatch.route.exitId)
  check('F1 exitId 恒等于 nodes 末位',
    mismatch.ok === true && mismatch.route.exitId === mismatch.route.nodes[mismatch.route.nodes.length - 1])

  // 6. 运行时字段注入被剥离
  const inject = store.createManualExecutableRoute({
    id: 'RP-MANUAL-INJ-1', nodes: FULL_PATH.slice(),
    validated: true, reachable: true, status: 'EXECUTING', valid: true,
  })
  check('F1 注入 validated/reachable/status/valid 被剥离（不写入）',
    inject.ok === true
    && !('validated' in inject.route) && !('reachable' in inject.route)
    && !('status' in inject.route) && !('valid' in inject.route),
    Object.keys(inject.route))

  // 7. 伪造 points / floorsPassed 被忽略（由权威数据派生）
  const forged = store.createManualExecutableRoute({
    id: 'RP-MANUAL-FORGED-1', nodes: FULL_PATH.slice(),
    points: [{ id: 'FAKE', x: 0, y: 0 }], floorsPassed: ['9F'],
  })
  check('F1 伪造 points 被忽略（长度与 nodes 一致且首点 id 为权威节点）',
    forged.ok === true && forged.route.points.length === forged.route.nodes.length
    && forged.route.points[0].id === forged.route.nodes[0],
    forged.route && forged.route.points)
  check('F1 伪造 floorsPassed 被忽略（派生为 5F→1F）',
    forged.ok === true && JSON.stringify(forged.route.floorsPassed) === JSON.stringify(['5F', '4F', '3F', '2F', '1F']),
    forged.route && forged.route.floorsPassed)

  // 8. replace 对非法输入同样拒绝（不写入）
  store.manualExecutableRoutes = []
  store.createManualExecutableRoute({ id: 'RP-MANUAL-REP-1', nodes: FULL_PATH.slice() })
  const badReplace = store.replaceManualExecutableRoute('RP-MANUAL-REP-1', { nodes: ['5F:A_CENTER', W] })
  check('F1 replace 对非法邻接同样拒绝（返回 false 且原数据不变）',
    badReplace === false && store.manualExecutableRoutes[0].exitId === W,
    store.manualExecutableRoutes[0] && store.manualExecutableRoutes[0].exitId)

  // 9. replace 跨楼栋替换时保留原 buildingId（不随当前楼栋重派生、不信任调用方）
  store.manualExecutableRoutes = []
  store.routeBuildingId = 'B003'
  store.createManualExecutableRoute({ id: 'RP-MANUAL-BID-1', nodes: FULL_PATH.slice() })
  store.routeBuildingId = 'B004' // 直接切楼栋（触发 F2 重置，但不影响 manualExecutableRoutes）
  store.replaceManualExecutableRoute('RP-MANUAL-BID-1', { nodes: PATH_TO_E.slice(), buildingId: 'B004' })
  check('F1 replace 跨楼栋替换时保留原 buildingId（B003 不被改写成 B004）',
    store.manualExecutableRoutes[0].buildingId === 'B003', store.manualExecutableRoutes[0].buildingId)
  store.routeBuildingId = 'B003'
  store.manualExecutableRoutes = []
}

console.log('=== 十五、F2：楼栋上下文变化重置选点编辑态 ===')
{
  store.routeBuildingId = 'B003'
  store.manualExecutableRoutes = []
  store.resetAuthGraphSelection()
  store.pickAuthGraphStart('5F:A_CENTER')
  store.appendAuthGraphNode('5F:CORRIDOR_N')
  check('F2 前置：选点已建立（path 长度 2）', store.authGraphPath.length === 2)

  // 1. store 内部直接改 routeBuildingId（非 UI 路径）→ 编辑态被重置
  store.routeBuildingId = 'B004'
  check('F2 直接改 routeBuildingId → authGraphPath 被清空', store.authGraphPath.length === 0, store.authGraphPath)
  check('F2 直接改 routeBuildingId → authGraphDraftId 被清空', store.authGraphDraftId === null)

  // 2. 编辑态（draftId）同样随楼栋切换复位
  store.routeBuildingId = 'B003'
  store.resetAuthGraphSelection()
  store.pickAuthGraphStart('5F:A_CENTER')
  store.authGraphDraftId = 'RP-MANUAL-X' // 模拟已载入编辑
  store.routeBuildingId = 'B004'
  check('F2 楼栋切换 → authGraphDraftId 复位为 null', store.authGraphDraftId === null)

  // 3. 楼栋未变化时正常选点/保存不受影响
  store.routeBuildingId = 'B003'
  store.resetAuthGraphSelection()
  let ok = store.pickAuthGraphStart(FULL_PATH[0])
  for (let i = 1; i < FULL_PATH.length; i++) ok = ok && store.appendAuthGraphNode(FULL_PATH[i])
  check('F2 楼栋未变化时选点正常（全链路成功）', ok === true)
  const saved = store.saveAuthGraphRoute()
  check('F2 楼栋未变化时保存正常（buildingId === B003）',
    saved.ok === true && saved.route.buildingId === 'B003', saved.route && saved.route.buildingId)

  // 4. 旧楼栋路径不能以新楼栋 buildingId 被直接保存
  store.manualExecutableRoutes = []
  store.routeBuildingId = 'B003'
  store.resetAuthGraphSelection()
  store.pickAuthGraphStart(FULL_PATH[0])
  for (let i = 1; i < FULL_PATH.length; i++) store.appendAuthGraphNode(FULL_PATH[i])
  store.routeBuildingId = 'B004' // 切楼栋 → 编辑态被清空
  const stale = store.saveAuthGraphRoute()
  check('F2 切楼栋后旧路径不可直接保存（PATH_TOO_SHORT，不产生新路线）',
    stale.ok === false && store.manualExecutableRoutes.length === 0,
    { ok: stale.ok, reason: stale.reason, count: store.manualExecutableRoutes.length })
  store.routeBuildingId = 'B003'
  store.manualExecutableRoutes = []
}

console.log('=== 十六、K-1B.3：安全准入（拓扑）与只读状态投影 ===')
{
  store.routeBuildingId = 'B003'
  store.manualExecutableRoutes = []

  // 1. 合法路线在原所属楼栋中通过
  const validRoute = { id: 'R-VALID', buildingId: 'B003', exitId: W, nodes: FULL_PATH.slice() }
  check('K1B3 合法路线在原所属楼栋通过（VALID）',
    store.validateManualRouteTopology(validRoute).status === 'VALID',
    store.validateManualRouteTopology(validRoute))

  // 2. 未知节点 / 非法邻接 / 非法起点 / 非法终点
  check('K1B3 未知节点 → INVALID(UNKNOWN_NODE)',
    store.validateManualRouteTopology({ id: 'R-U', buildingId: 'B003', exitId: W, nodes: ['5F:A_CENTER', '5F:NO_SUCH', W] }).reason === 'UNKNOWN_NODE')
  check('K1B3 非法邻接 → INVALID(NOT_ADJACENT)',
    store.validateManualRouteTopology({ id: 'R-A', buildingId: 'B003', exitId: W, nodes: ['5F:A_CENTER', '5F:CORRIDOR_S', W] }).reason === 'NOT_ADJACENT')
  check('K1B3 非法起点 → INVALID(INVALID_START_TYPE)',
    store.validateManualRouteTopology({ id: 'R-S', buildingId: 'B003', exitId: W, nodes: ['5F:CORRIDOR_N', W] }).reason === 'INVALID_START_TYPE')
  check('K1B3 非法终点 → INVALID(INVALID_EXIT)',
    store.validateManualRouteTopology({ id: 'R-X', buildingId: 'B003', exitId: '5F:CORRIDOR_N', nodes: ['5F:A_CENTER', '5F:CORRIDOR_N'] }).reason === 'INVALID_EXIT')

  // 3. 跨层上升 / 楼梯不可用不能通过拓扑准入
  check('K1B3 跨层上升 → INVALID(NOT_ADJACENT)',
    store.validateManualRouteTopology({ id: 'R-UP', buildingId: 'B003', exitId: W,
      nodes: ['5F:A_CENTER', '5F:CORRIDOR_W', '5F:STAIR_NW', '4F:STAIR_NW', '5F:STAIR_NW'] }).reason === 'NOT_ADJACENT')
  check('K1B3 楼梯不可用（6F STAIR_NW 无下降边）→ INVALID(NOT_ADJACENT)',
    store.validateManualRouteTopology({ id: 'R-ST', buildingId: 'B003', exitId: W,
      nodes: ['6F:A_CENTER', '6F:CORRIDOR_W', '6F:STAIR_NW', '5F:STAIR_NW', '4F:STAIR_NW', '3F:STAIR_NW', '2F:STAIR_NW', '1F:STAIR_NW', '1F:CORRIDOR_W', W] }).reason === 'NOT_ADJACENT')

  // 4. 所属楼栋 ≠ 当前 UI 楼栋：仍按所属楼栋验证
  store.routeBuildingId = 'B999' // 当前 UI 楼栋设为无效
  check('K1B3 当前 UI 楼栋 B999 无效，但所属楼栋 B003 有效 → 仍 VALID',
    store.validateManualRouteTopology({ id: 'R-OWN', buildingId: 'B003', exitId: W, nodes: FULL_PATH.slice() }).status === 'VALID')
  store.routeBuildingId = 'B003'

  // 5. 所属楼栋不可用 → 明确诊断
  const noBld = store.validateManualRouteTopology({ id: 'R-NF', buildingId: 'B999', exitId: W, nodes: FULL_PATH.slice() })
  check('K1B3 所属楼栋不存在 → BUILDING_UNAVAILABLE(BUILDING_NOT_FOUND)',
    noBld.status === 'BUILDING_UNAVAILABLE' && noBld.reason === 'BUILDING_NOT_FOUND', noBld)
  check('K1B3 所属楼栋缺失 → BUILDING_UNAVAILABLE(BUILDING_MISSING)',
    store.validateManualRouteTopology({ id: 'R-NM', buildingId: '', exitId: W, nodes: FULL_PATH.slice() }).reason === 'BUILDING_MISSING')

  // 6. 拓扑失效路线仍被保留（不被自动删除）
  store.manualExecutableRoutes = [{ id: 'RP-MANUAL-STALE-1', buildingId: 'B003', exitId: W, nodes: ['5F:A_CENTER', W] }]
  const staleEntry = store.manualRouteStatusView.find((x) => x.id === 'RP-MANUAL-STALE-1')
  check('K1B3 拓扑失效路线投影为 INVALID', !!staleEntry && staleEntry.topologyStatus === 'INVALID', staleEntry)
  check('K1B3 拓扑失效路线仍被保留（未删除）', store.manualExecutableRoutes.some((r) => r.id === 'RP-MANUAL-STALE-1'))

  // 7. 出口运行时缺失不被误判为拓扑无效（须在 applyExitRuntimeStates 之前：exitRawStates 初始为 null）
  const v7 = store.validateManualRouteTopology(validRoute)
  const e7 = store.manualRouteExitVerdict(validRoute)
  check('K1B3 出口运行时缺失：拓扑仍 VALID（不误判）', v7.status === 'VALID', v7)
  check('K1B3 出口运行时缺失：exitStatus === UNKNOWN', e7.status === 'UNKNOWN' && e7.reason === 'NO_EXIT_RUNTIME', e7)

  // 出口运行时可用性（独立维度）：上报 W 后
  store.applyExitRuntimeStates([{ nodeId: W, available: true, status: 'OPEN' }])
  const rw = { id: 'R-W', buildingId: 'B003', exitId: W, nodes: FULL_PATH.slice() }
  const re = { id: 'R-E', buildingId: 'B003', exitId: E, nodes: PATH_TO_E.slice() }
  check('K1B3 出口 W 已上报可用 → AVAILABLE', store.manualRouteExitVerdict(rw).status === 'AVAILABLE',
    store.manualRouteExitVerdict(rw))
  check('K1B3 出口 E 未上报 → UNAVAILABLE', store.manualRouteExitVerdict(re).status === 'UNAVAILABLE',
    store.manualRouteExitVerdict(re))

  // exitId 与末节点不一致 → 拓扑 INVALID（EXIT_ID_MISMATCH）
  check('K1B3 exitId 与末节点不一致 → INVALID(EXIT_ID_MISMATCH)',
    store.validateManualRouteTopology({ id: 'R-MM', buildingId: 'B003', exitId: E, nodes: FULL_PATH.slice() }).reason === 'EXIT_ID_MISMATCH')

  // 投影结构：两个独立维度字段齐全
  store.manualExecutableRoutes = [{ id: 'R-PROJ', buildingId: 'B003', exitId: W, nodes: FULL_PATH.slice() }]
  const proj = store.manualRouteStatusView.find((x) => x.id === 'R-PROJ')
  check('K1B3 投影含 topologyStatus / topologyReason / exitStatus / exitReason 四字段',
    !!proj && 'topologyStatus' in proj && 'topologyReason' in proj && 'exitStatus' in proj && 'exitReason' in proj,
    proj)
  check('K1B3 投影不回写路线对象（路线仍无 validated/status 字段）',
    store.manualExecutableRoutes[0] && !('validated' in store.manualExecutableRoutes[0]) && !('status' in store.manualExecutableRoutes[0]),
    Object.keys(store.manualExecutableRoutes[0] || {}))

  store.manualExecutableRoutes = []
  store.exitRawStates = null // 复位，避免污染后续（本测试文件尾部无更多用例）
}

console.log('')
console.log(`=== 结果：${pass} 通过 / ${fail} 失败 ===`)
await server.close()
process.exit(fail ? 1 : 0)

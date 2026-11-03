/**
 * 疏散灯方向联动 —— 走真实 store 调用链的集成验证（P1.8.2）
 *
 * ⚠️ 走真实生产链：buildBuildingGraph + dijkstra 生成真实路线几何
 *    → applyBuildingPlans（真实投影链：syncLegacyRouteState + reconcileRouteStatuses）
 *    → applyBuildingRoutesToDevices（Stage 2-A 起经 reconciledRouteView 核验状态）
 *    → resolveDeviceDirections → devices
 *
 * 本组只验证「方向不再由最后一条路线决定」与「绑定唯一」；
 * 不覆盖浏览器端渲染、demo 后端方向下发、真实设备下发。
 */
import { createPinia, setActivePinia } from 'pinia'
import { createServer } from 'vite'
import { readFile } from 'node:fs/promises'
import { buildBuildingGraph, dijkstra } from '../../shared/evacuation/routeGraph.js'
import { resolveDirectionDisplay } from '../../shared/evacuation/deviceDirection.js'

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

const graph = buildBuildingGraph(6)
const EMPTY = new Set()
const ZONE_KEY = { 'A区': 'A_CENTER', 'B区': 'B_CENTER', 'C区': 'C_CENTER', 'D区': 'D_CENTER' }

function mkRoute(zone) {
  const start = `5F:${ZONE_KEY[zone]}`
  const rw = dijkstra(graph, start, '1F:EXIT_W', EMPTY, EMPTY)
  const re = dijkstra(graph, start, '1F:EXIT_E', EMPTY, EMPTY)
  const best = rw.cost <= re.cost ? rw : re
  const nodes = best.path
  return {
    routeId: `R-${zone}`,
    floorId: '5F',
    zone,
    startNode: start,
    exitId: nodes[nodes.length - 1],
    exitLabel: /EXIT_E/.test(nodes[nodes.length - 1]) ? '东侧安全出口' : '西侧安全出口',
    floorsPassed: [...new Set(nodes.map((id) => graph.nodes[id].floorId))],
    nodes,
    points: nodes.map((id) => ({ x: graph.nodes[id].x, y: graph.nodes[id].y })),
    riskLevel: 'LOW',
    distance: best.cost,
    estimatedTime: 0,
    personCount: 1,
  }
}
const mkBp = (routes) => ({
  id: 'BP-TEST',
  buildingId: 'B003',
  buildingName: '3号楼',
  name: '测试方案',
  strategy: 'BALANCED',
  scope: 'BUILDING',
  recommended: true,
  summary: {
    zoneCount: routes.length,
    personCount: routes.length,
    routeCount: routes.length,
    exitLabels: ['西侧安全出口', '东侧安全出口'],
    maxEstimatedTime: 0,
  },
  routes,
})

/**
 * Stage 2-A 修复后：applyBuildingRoutesToDevices 会经 reconciledRouteView 核验权威
 * 协调状态，未进入 routePlans 投影的路线（status 未知）将被拒绝。故本组先经**真实
 * 投影链**布置方案（applyBuildingPlans → syncLegacyRouteState + reconcileRouteStatuses，
 * 与生产链 generateEvacuationOptions / confirmEvacuationPlan 一致），再调用楼栋级
 * 下发入口 —— 保证测试走的是与生产相同的状态来源，而非绕过投影直喂路线。
 */
const applyBpRoutes = (routes) => {
  const bp = mkBp(routes)
  store.applyBuildingPlans({ buildingPlans: [bp], activeBuildingPlanId: bp.id, evacuationScope: 'BUILDING' })
  return store.applyBuildingRoutesToDevices(store.activeBuildingPlan)
}

/** 指定出口的路线：用于构造 BALANCED 负载均衡下的「同层混合出口」⇒ 等距反向冲突 */
function mkRouteTo(zone, exit) {
  const start = `5F:${ZONE_KEY[zone]}`
  const r = dijkstra(graph, start, exit, EMPTY, EMPTY)
  const nodes = r.path
  return {
    routeId: `R-${zone}-${/EXIT_E/.test(exit) ? 'E' : 'W'}`,
    floorId: '5F',
    zone,
    startNode: start,
    exitId: nodes[nodes.length - 1],
    exitLabel: /EXIT_E/.test(nodes[nodes.length - 1]) ? '东侧安全出口' : '西侧安全出口',
    floorsPassed: [...new Set(nodes.map((id) => graph.nodes[id].floorId))],
    nodes,
    points: nodes.map((id) => ({ x: graph.nodes[id].x, y: graph.nodes[id].y })),
    riskLevel: 'LOW',
    distance: r.cost,
    estimatedTime: 0,
    personCount: 1,
  }
}

const ROUTES = ['A区', 'B区', 'C区', 'D区'].map(mkRoute)
console.log('    路线出口：', ROUTES.map((r) => `${r.routeId}→${r.exitId}`).join(' , '))

const lights5F = () =>
  (store.devices || []).filter(
    (d) => d && d.type === 'evacuation_light' && d.floorId === '5F' && d.buildingId === 'B003',
  )
const lights4F = () =>
  (store.devices || []).filter(
    (d) => d && d.type === 'evacuation_light' && d.floorId === '4F' && d.buildingId === 'B003',
  )
const snap = (list) => list.map((d) => `${d.id.slice(-7)}=${d.direction}`).join(' ')
const resetDevices = () => {
  if (typeof store.resetEmergencyFlow === 'function') store.resetEmergencyFlow()
}

console.log('')
console.log('=== 一、5F 双出口并存：不再整层统一 ===')
{
  resetDevices()
  const before = snap(lights5F())
  const bindings = applyBpRoutes(ROUTES)
  const after = lights5F()
  console.log('    before:', before)
  console.log('    after :', snap(after))
  const dirs = new Set(after.map((d) => d.direction))
  check('5F 疏散灯同时存在 left 与 right', dirs.has('left') && dirs.has('right'), [...dirs])
  const west = after.find((d) => d.id.endsWith('5F-01'))
  const east = after.find((d) => d.id.endsWith('5F-13'))
  check('西端 EL-5F-01(x=72) 保持 left（未被末条东向路线覆盖）', west.direction === 'left', west.direction)
  check('东端 EL-5F-13(x=477) 为 right', east.direction === 'right', east.direction)
  // 整栋楼方案途经 5F→1F，绑定含首层等有水平走向的楼层；此处只约束 5F 不超量
  const b5 = bindings.filter((b) => b.deviceId.includes('-5F-'))
  check('5F 绑定数 ≤ 5F 灯具数（不再 11 台 × 4 条路线）', b5.length <= after.length, [b5.length, after.length])
}

console.log('')
console.log('=== 二、遍历顺序无关（正序 / 逆序一致）===')
{
  resetDevices()
  applyBpRoutes(ROUTES)
  const fwd = snap(lights5F())
  resetDevices()
  applyBpRoutes([...ROUTES].reverse())
  const rev = snap(lights5F())
  check('正序与逆序最终方向完全一致', fwd === rev, [fwd, rev])
}

console.log('')
console.log('=== 三、绑定唯一性（同设备无冲突方向）===')
{
  resetDevices()
  applyBpRoutes(ROUTES)
  const bs = store.routeDeviceBindings
  const ids = bs.map((b) => b.deviceId)
  check('deviceId 无重复', new Set(ids).size === ids.length, ids)
  const byDev = new Map()
  bs.forEach((b) => {
    if (!byDev.has(b.deviceId)) byDev.set(b.deviceId, [])
    byDev.get(b.deviceId).push(b.direction)
  })
  check('不存在同设备多方向冲突记录', [...byDev.values()].every((v) => v.length === 1), [...byDev])
  check('绑定条数远小于「设备数 × 路线数」', bs.length < lights5F().length * ROUTES.length, [bs.length, lights5F().length * ROUTES.length])
}

console.log('')
console.log('=== 四、跨层：4F 疏散灯方向不被改写 ===')
{
  resetDevices()
  const before = snap(lights4F())
  applyBpRoutes(ROUTES)
  const after = snap(lights4F())
  check('4F 疏散灯方向保持原值', before === after, [before, after])
  check('绑定中不混入 4F 设备', !store.routeDeviceBindings.some((b) => b.deviceId.includes('-4F-')), store.routeDeviceBindings.map((b) => b.deviceId))
}

console.log('')
console.log('=== 五、既有行为保持：途经楼层应急照明灯进入强闪 ===')
{
  resetDevices()
  applyBpRoutes(ROUTES)
  const em = (store.devices || []).filter(
    (d) => d && d.type === 'emergency_light' && d.floorId === '5F' && d.buildingId === 'B003',
  )
  check('5F 应急照明灯全部进入 emergency 模式', em.length > 0 && em.every((d) => d.currentMode === 'emergency'), em.map((d) => d.currentMode))
}

console.log('')
console.log('=== 六、楼梯口灯具（垂直段）保持原值，不被 exitSide 覆盖 ===')
{
  resetDevices()
  const stair1 = (store.devices || []).find((d) => d && d.type === 'evacuation_light' && d.floorId === '5F' && d.buildingId === 'B003' && d.area === '楼梯1')
  const seed = stair1.direction
  applyBpRoutes(ROUTES) // 末条路线为东出口
  check('楼梯1 灯具未被末条东向路线改成 right', stair1.direction === seed, [seed, stair1.direction])
  check('楼梯1 灯具未进入绑定（未定）', !store.routeDeviceBindings.some((b) => b.deviceId === stair1.id), store.routeDeviceBindings.map((b) => b.deviceId))
}

console.log('')
console.log('=== 七、demo 模式边界（本轮不修复后端方向下发，仅锁定不写本地）===')
{
  const orig = dataSource.mode
  resetDevices()
  const before = snap(lights5F())
  dataSource.mode = 'demo'
  let out = null
  try {
    out = applyBpRoutes(ROUTES)
  } finally {
    dataSource.mode = orig
  }
  check('demo 模式下返回空绑定', Array.isArray(out) && out.length === 0, out)
  check('demo 模式下不改写设备方向', snap(lights5F()) === before, [before, snap(lights5F())])
}

console.log('')
console.log('=== 八、单路线入口 applyRouteToDevices 契约不变 ===')
{
  resetDevices()
  store.routeDeviceBindings = []
  const plan = {
    id: 'P-ONE',
    buildingId: 'B003',
    buildingName: '3号楼',
    floorsPassed: ['5F'],
    exitSide: 'right',
    // R3：单路线入口自身持有状态安全契约 —— 夹具须显式携带可信 status
    status: 'NORMAL',
    path: ROUTES[0].points.map((p, i) => ({
      id: ROUTES[0].nodes[i],
      floorId: graph.nodes[ROUTES[0].nodes[i]].floorId,
      x: p.x,
      y: p.y,
    })),
  }
  const out = store.applyRouteToDevices(plan)
  check('返回数组', Array.isArray(out), typeof out)
  check('写入 routeDeviceBindings', Array.isArray(store.routeDeviceBindings), typeof store.routeDeviceBindings)
  check('单路线下仍按几何裁决（西向路线 ⇒ 西端 left）',
    (lights5F().find((d) => d.id.endsWith('5F-01')) || {}).direction === 'left',
    (lights5F().find((d) => d.id.endsWith('5F-01')) || {}).direction)
}

console.log('')
console.log('=== 八-B、单路线入口状态门禁（R3 纵深防御：拒绝时零副作用） ===')
{
  resetDevices()
  const mkSingle = (status) => {
    const p = {
      id: 'P-ONE',
      buildingId: 'B003',
      buildingName: '3号楼',
      floorsPassed: ['5F'],
      exitSide: 'right',
      path: ROUTES[0].points.map((pt, i) => ({
        id: ROUTES[0].nodes[i],
        floorId: graph.nodes[ROUTES[0].nodes[i]].floorId,
        x: pt.x,
        y: pt.y,
      })),
    }
    if (status !== '<absent>') p.status = status
    return p
  }
  const dirSnap = () => lights5F().map((d) => `${d.id}=${d.direction}`).join(' ')

  // ① 对照：NORMAL 路线正常下发（门禁不误伤，与组八同一语义）
  store.routeDeviceBindings = []
  const okOut = store.applyRouteToDevices(mkSingle('NORMAL'))
  check('R3 对照：NORMAL 路线正常下发（返回非空数组）',
    Array.isArray(okOut) && okOut.length > 0, okOut && okOut.length)

  // ② BLOCKED / DONE / null / 未知 / status 缺失：一律拒绝，且绑定/裁决/设备方向零变化
  const cases = [
    ['BLOCKED', 'BLOCKED'],
    ['DONE', 'DONE'],
    ['null', null],
    ['未知状态 WEIRD', 'WEIRD'],
    ['status 缺失（无法验证）', '<absent>'],
  ]
  cases.forEach(([label, status]) => {
    resetDevices()
    store.routeDeviceBindings = []
    store.routeDirectionVerdicts = []
    const before = dirSnap()
    const verdictsBefore = (store.routeDirectionVerdicts || []).length
    const out = store.applyRouteToDevices(mkSingle(status))
    check(`R3 拒绝 ${label}：返回空数组`, Array.isArray(out) && out.length === 0, out)
    check(`R3 拒绝 ${label}：设备方向零变化`, before === dirSnap(), { changed: before !== dirSnap() })
    check(`R3 拒绝 ${label}：裁决结果零变化（无新裁决）`,
      (store.routeDirectionVerdicts || []).length === verdictsBefore,
      [verdictsBefore, (store.routeDirectionVerdicts || []).length])
    check(`R3 拒绝 ${label}：routeDeviceBindings 保持空（无残留绑定）`,
      (store.routeDeviceBindings || []).length === 0, store.routeDeviceBindings)
  })
}

console.log('')
console.log('=== 九、写入确已发生且随路线而变（对照种子方向，排除「什么都没做」假通过）===')
{
  resetDevices()
  const west = lights5F().find((d) => d.id.endsWith('5F-01'))
  const seedDir = west.direction
  // 只保留东出口路线：西端灯应被改写成 right，证明方向来自路线而非种子/位置
  applyBpRoutes([ROUTES[2], ROUTES[3]])
  const eastOnlyDir = west.direction
  check('仅有东出口路线时西端灯被改写为 right（≠ 种子值）', eastOnlyDir === 'right' && eastOnlyDir !== seedDir, [seedDir, eastOnlyDir])
  // 恢复完整方案：西端灯应回到 left
  resetDevices()
  applyBpRoutes(ROUTES)
  check('完整方案下西端灯回到 left（随路线而变，非固定值）', west.direction === 'left', [eastOnlyDir, west.direction])
}

console.log('')
console.log('=== 十、拐角误判与几何归因（Store 侧，P1.8.2 第二阶段 问题 B）===')
{
  resetDevices()
  const rAW = mkRouteTo('A区', '1F:EXIT_W')
  const rBE = mkRouteTo('B区', '1F:EXIT_E')
  const dev3 = lights5F().find((d) => d.id.endsWith('5F-03'))
  const dev5 = lights5F().find((d) => d.id.endsWith('5F-05'))
  // 预置成与「拐角出边方向」不同的值，以便区分"被写入"与"未写"：
  // EL-5F-03 旧逻辑会被出边判成 left；EL-5F-05 预置 left，正确归属应改写为 right
  dev3.direction = 'right'
  dev3.recommendedDirection = 'right'
  dev5.direction = 'left'
  dev5.recommendedDirection = 'left'
  applyBpRoutes([rAW, rBE])
  const v3 = store.getRouteDirectionVerdict(dev3.id)
  const v5 = store.getRouteDirectionVerdict(dev5.id)

  check('★ EL-5F-03 裁决状态 = undetermined（不再是"冲突"，更不是出边的 left）', v3 && v3.state === 'undetermined', v3)
  check('EL-5F-03 降级原因 = corner-vertical-in-edge', v3 && v3.reason === 'corner-vertical-in-edge', v3 && v3.reason)
  check('EL-5F-03 方向未被写入（保持预置 right）', dev3.direction === 'right', dev3.direction)
  check('EL-5F-03 不在 routeDeviceBindings 中', !store.routeDeviceBindings.some((b) => b.deviceId === dev3.id), store.routeDeviceBindings.map((b) => b.deviceId))

  check('★ EL-5F-05 归属几何更贴近的东向路线 ⇒ resolved / right', v5 && v5.state === 'resolved' && v5.direction === 'right', v5)
  check('EL-5F-05 方向被改写为 right（由预置 left 变更而来 ⇒ 确已写入）', dev5.direction === 'right', dev5.direction)
  check(
    '该真实场景下 Store 不产生任何冲突（旧的两个"冲突"均为归因错误）',
    (store.routeDirectionVerdicts || []).every((v) => v.state !== 'conflict'),
    (store.routeDirectionVerdicts || []).filter((v) => v.state === 'conflict').map((v) => v.deviceId),
  )
}

console.log('')
console.log('=== 十-B、真实冲突（构造：同一走廊被两条反向路线共用）⇒ Store 仍不写方向 ===')
{
  resetDevices()
  // ⚠️ 构造夹具（明确标注）：真实最短路不会让两条路线在同一走廊段反向共行，
  //    故用线性路线复现；nodeId 前缀 5F: 保证 routeToRenderable 解析出正确 floorId。
  const linear = (id, from, to, exit) => ({
    routeId: id,
    floorId: '5F',
    zone: '走廊',
    startNode: '5F:CORRIDOR_CENTER',
    exitId: exit,
    exitLabel: '测试出口',
    floorsPassed: ['5F'],
    nodes: ['5F:N1', '5F:N2'],
    points: [{ x: from, y: 170 }, { x: to, y: 170 }],
    riskLevel: 'LOW',
    distance: Math.abs(to - from),
    estimatedTime: 0,
    personCount: 1,
  })
  const dev = lights5F().find((d) => d.id.endsWith('5F-07')) // x=280，位于两条路线走廊段之间
  const seed = dev.direction
  applyBpRoutes([linear('R-W', 400, 200, '1F:EXIT_W'), linear('R-E', 200, 400, '1F:EXIT_E')])
  const v = store.getRouteDirectionVerdict(dev.id)
  check('★ 等距反向 ⇒ 裁决状态 = conflict', v && v.state === 'conflict', v)
  check('★ 冲突设备不产出方向绑定', !store.routeDeviceBindings.some((b) => b.deviceId === dev.id), store.routeDeviceBindings.map((b) => b.deviceId))
  check('★ 冲突设备方向未被写入（保持种子值）', dev.direction === seed, [seed, dev.direction])
  check('冲突记录含两条反向候选 + 路线负载诊断', !!v && v.candidates.length === 2 && v.candidates.every((c) => Number.isFinite(c.load)), v && v.candidates)
  check('冲突候选方向为 left 与 right', !!v && v.candidates.some((c) => c.direction === 'left') && v.candidates.some((c) => c.direction === 'right'), v && v.candidates.map((c) => c.direction))
}

console.log('')
console.log('=== 十一、未定方向：裁决状态为 undetermined，旧值不得冒充本轮结果 ===')
{
  resetDevices()
  const stair1 = (store.devices || []).find((d) => d && d.type === 'evacuation_light' && d.floorId === '5F' && d.buildingId === 'B003' && d.area === '楼梯1')
  stair1.direction = 'right'
  applyBpRoutes(ROUTES)
  const v = store.getRouteDirectionVerdict(stair1.id)
  check('未定设备裁决状态 = undetermined', v && v.state === 'undetermined', v)
  check('未定设备方向未被写入', stair1.direction === 'right', stair1.direction)
  check('未定设备不在 routeDeviceBindings 中', !store.routeDeviceBindings.some((b) => b.deviceId === stair1.id), store.routeDeviceBindings.map((b) => b.deviceId))
  check('未定裁决不含 direction 字段（不得伪造方向）', v && v.direction === undefined, v)
}

console.log('')
console.log('=== 十二、手动路线无 path ⇒ 未联动、绑定为空、不恢复整层统一写入 ===')
{
  resetDevices()
  const manual = {
    id: 'RP-MANUAL-1',
    name: '自定义方案',
    buildingId: 'B003',
    buildingName: '3号楼',
    type: 'manual',
    status: 'NORMAL',
    floorsPassed: ['5F'],
    exit: '出口A',
    exitSide: 'right', // 旧实现会据此把整层写成 right
    manualNodes: [
      { id: 'n1', x: 140, y: 150, type: 'room' },
      { id: 'n2', x: 140, y: 170, type: 'corridor' },
    ],
    manualEdges: [],
  }
  const before = snap(lights5F())
  store.applyRouteToDevices(manual)
  check('手动路线不产出绑定', store.routeDeviceBindings.length === 0, store.routeDeviceBindings.length)
  check('方向全部保持原值（未恢复整层统一 right）', snap(lights5F()) === before, [before, snap(lights5F())])
  check('并非全部变为 right（整层统一写入未被恢复）', new Set(lights5F().map((d) => d.direction)).size > 1, lights5F().map((d) => d.direction))
  check('本轮裁决状态全部为 unlinked', lights5F().every((d) => (store.getRouteDirectionVerdict(d.id) || {}).state === 'unlinked'), lights5F().map((d) => (store.getRouteDirectionVerdict(d.id) || {}).state))
  check('routeNoPathRouteIds 记录缺 path 的路线', (store.routeNoPathRouteIds || []).includes('RP-MANUAL-1'), store.routeNoPathRouteIds)
  const em = (store.devices || []).filter((d) => d && d.type === 'emergency_light' && d.floorId === '5F' && d.buildingId === 'B003')
  check('应急照明仍进入 emergency（未因方向未联动而回退）', em.length > 0 && em.every((d) => d.currentMode === 'emergency'), em.map((d) => d.currentMode))
}

console.log('')
console.log('=== 十三、本轮裁决状态独立于设备旧 direction ===')
{
  resetDevices()
  applyBpRoutes(ROUTES)
  const ok = lights5F().find((d) => d.id.endsWith('5F-05'))
  const v = store.getRouteDirectionVerdict(ok.id)
  check('已裁决设备 verdict = resolved', v && v.state === 'resolved', v)
  check('已裁决设备的 verdict.direction 与设备一致', v && v.direction === ok.direction, [v && v.direction, ok.direction])
  // ★ 规则乙（产品决策 Q1）：落在「走廊端头→楼梯」垂直引入段上的灯不再被裁决
  const corner = lights5F().find((d) => d.id.endsWith('5F-01'))
  const vc = store.getRouteDirectionVerdict(corner.id)
  check('★ 规则乙（Store 侧）：EL-5F-01 状态 = undetermined', vc && vc.state === 'undetermined', vc)
  check('★ 规则乙（Store 侧）：EL-5F-01 原因 = corner-vertical-out-edge', vc && vc.reason === 'corner-vertical-out-edge', vc && vc.reason)
  check('规则乙：EL-5F-01 本轮未写入方向（保持种子 left）', corner.direction === 'left', corner.direction)
  check('未参与本轮的设备无裁决记录 ⇒ UI 显示「暂无本轮裁决」', store.getRouteDirectionVerdict('B003-EL-9F-99') === null, store.getRouteDirectionVerdict('B003-EL-9F-99'))
  resetDevices()
  check('复位后本轮裁决状态被清空（不残留上一轮结论）', (store.routeDirectionVerdicts || []).length === 0, (store.routeDirectionVerdicts || []).length)
}

console.log('')
console.log('=== 十四、无真实下发通道 ⇒ UI 不得宣称下发成功（源码级可观察检查）===')
{
  const src = await readFile(new URL('../views/EvacuationView.vue', import.meta.url), 'utf8')
  check('不再出现「正在下发指令」', !src.includes('正在下发指令'))
  check('不再出现「方向切换成功」', !src.includes('方向切换成功'))
  check('不再把 switchResult 置为 success', !/switchResult\.value\s*=\s*'success'/.test(src))
  check('明示「未下发设备」', src.includes('未下发设备'))
  check('存在远程可用开关且默认为 false', /const remoteDispatchAvailable = false/.test(src))
}

console.log('')
console.log('=== 十五、手动切换后裁决状态一致（问题 C）===')
{
  resetDevices()
  applyBpRoutes(ROUTES)
  const dev = lights5F().find((d) => d.id.endsWith('5F-05'))
  const before = store.getRouteDirectionVerdict(dev.id)
  check('切换前裁决状态 = resolved', before && before.state === 'resolved', before)
  const target = before.direction === 'left' ? 'right' : 'left'
  store.switchEvacuationDirection(dev.id, target, '测试手动切换')
  const after = store.getRouteDirectionVerdict(dev.id)
  check('★ 手动切换后裁决状态 = overridden（旧的 resolved 不再残留）', after && after.state === 'overridden', after)
  check('overridden 记录携带实际方向与覆盖来源', after && after.direction === target && after.overrideSource === 'manual', after)
  check('设备方向已被写入', dev.direction === target, dev.direction)
  const disp = resolveDirectionDisplay(after, dev.direction)
  check('★ UI 判定：overridden 时 isValidRouteGuidance=false（不算本轮路线裁决）', disp.isValidRouteGuidance === false && disp.isManualOverride === true, disp)
  check('UI 判定：overridden 仍渲染箭头（本地明确设定，且非路线裁决）', disp.showArrow === true, disp)

  // 再次跑一轮路线裁决 ⇒ 应重新回到 resolved，不得停留在 overridden
  resetDevices()
  applyBpRoutes(ROUTES)
  const again = store.getRouteDirectionVerdict(dev.id)
  check('重新执行路线裁决后回到 resolved（overridden 被本轮覆盖）', again && again.state === 'resolved', again)
}

console.log('')
console.log('=== 十六、无当前裁决时不得渲染旧箭头（问题 A）===')
{
  // ⚠️ 限制说明：本测试架构不挂载 Vue 组件，故以「纯判定函数 + 源码级断言」验证箭头显示逻辑。
  // ① 无任何本轮裁决（复位）+ 设备仍保留 direction 值
  resetDevices()
  const dev = lights5F().find((d) => d.id.endsWith('5F-01'))
  check('复位后设备仍保留 direction 字段（未强行删除历史字段）', dev.direction === 'left' || dev.direction === 'right', dev.direction)
  check('复位后无本轮裁决 ⇒ getRouteDirectionVerdict 返回 null', store.getRouteDirectionVerdict(dev.id) === null, store.getRouteDirectionVerdict(dev.id))
  const d1 = resolveDirectionDisplay(store.getRouteDirectionVerdict(dev.id), dev.direction)
  check('★ UI 判定：无裁决 + 有历史值 ⇒ 不渲染箭头、direction 输出为 null', d1.showArrow === false && d1.direction === null, d1)
  check('★ UI 判定：该情形 stale=true（界面须提示不得当作有效指引）', d1.stale === true, d1)
  check('历史值仍可读取（供展示 / 审计）', d1.storedDirection === dev.direction, d1)

  // ② 本轮存在 undetermined / unlinked 时同样不得渲染
  applyBpRoutes(ROUTES)
  const und = (store.routeDirectionVerdicts || []).find((v) => v.state === 'undetermined')
  check('本轮存在 undetermined 设备', !!und, (store.routeDirectionVerdicts || []).map((v) => v.state))
  if (und) {
    const dU = resolveDirectionDisplay(und, 'left')
    check('★ undetermined + 历史值 ⇒ 不渲染箭头且 stale=true', dU.showArrow === false && dU.stale === true && dU.direction === null, dU)
  }
  resetDevices()
  const manual2 = {
    id: 'RP-M2', buildingId: 'B003', buildingName: '3号楼', type: 'manual', status: 'NORMAL',
    floorsPassed: ['5F'], exit: '出口A', exitSide: 'right',
    manualNodes: [{ id: 'n1', x: 140, y: 150, type: 'room' }], manualEdges: [],
  }
  store.applyRouteToDevices(manual2)
  const vUn = store.getRouteDirectionVerdict(dev.id)
  check('手动路线 ⇒ unlinked', vUn && vUn.state === 'unlinked', vUn)
  const dUn = resolveDirectionDisplay(vUn, dev.direction)
  check('★ unlinked + 历史值 ⇒ 不渲染箭头且 stale=true', dUn.showArrow === false && dUn.stale === true, dUn)

  // ③ 源码级：确认 EvacuationView 的箭头 / 方向文字确实由该判定函数驱动，而非直接读 device.direction
  const src = await readFile(new URL('../views/EvacuationView.vue', import.meta.url), 'utf8')
  check('EvacuationView 引入 resolveDirectionDisplay', src.includes('resolveDirectionDisplay'))
  check('★ 大箭头渲染条件绑定 directionDisplay.showArrow', /arrow-invalid': !directionDisplay\.showArrow/.test(src))
  check('★ 方向文字取自 directionDisplay.direction（不再直接读 device.direction）', /const d = directionDisplay\.value\.direction/.test(src))
  check('方向键 active 绑定 directionDisplay.direction（左/右）', /active: directionDisplay\.direction === 'left'/.test(src) && /active: directionDisplay\.direction === 'right'/.test(src))
  check('★ 模板中方向标签不再直接渲染 currentDevice.direction', !/\{\{\s*evacStore\.currentDevice\.direction\s*\}\}/.test(src))
}

console.log('')
console.log('=== 十七、无效状态不显示带朝向的箭头（源码级显示一致性核查）===')
{
  // ⚠️ 限制说明：本测试架构不挂载 Vue 组件（EvacuationView 依赖 Pinia / Element Plus / 路由），
  //    因此以下为**源码级**断言，验证"无效状态不会渲染指向某个方向的箭头"这一显示契约；
  //    它验证的是模板结构，不等于浏览器渲染结果（局限见交付报告）。
  const src = await readFile(new URL('../views/EvacuationView.vue', import.meta.url), 'utf8')

  // ① 带朝向的箭头必须包在 v-if="directionDisplay.showArrow" 内 ⇒ 无效状态根本不渲染。
  //    改用**位置断言**（而非贪婪正则）：指向 path 必须位于 v-if 分支标记之后、
  //    且在 v-else 占位分支标记之前；占位分支之后不得再出现任何指向 path。
  const vifIdx = src.indexOf('<div v-if="directionDisplay.showArrow" class="arrow-wrapper"')
  const phIdx = src.indexOf('class="arrow-placeholder"')
  const pathIdx = src.indexOf('M 15 50 L 75 50')
  check('★ 存在 v-if="directionDisplay.showArrow" 的箭头分支标记', vifIdx >= 0)
  check('★ 指向 path 位于 v-if 分支内、且在占位分支之前（不属于 v-else）', vifIdx >= 0 && pathIdx > vifIdx && phIdx >= 0 && pathIdx < phIdx, [vifIdx, pathIdx, phIdx])
  check('★ 占位分支之后不再出现指向 path（箭头唯一归属 v-if 分支）', vifIdx >= 0 && phIdx >= 0 && src.indexOf('M 15 50 L 75 50', phIdx) === -1)
  // ② 存在 v-else 的无方向性占位图形
  check('★ 存在无方向性占位图形分支（v-else / arrow-placeholder）', /v-else class="arrow-placeholder"/.test(src))
  check('占位图形不含指向性箭头 path', !/arrow-placeholder[\s\S]{0,600}M 15 50 L 75 50/.test(src))
  // ③ 不再用透明度 / 灰度弱化真实箭头来表示无效
  check('★ 不再以 opacity/grayscale 弱化箭头来表示无效（已改为不渲染）', !/\.arrow-display\.arrow-invalid\s*\{[^}]*(opacity|grayscale)/.test(src))
  // ④ 旋转角不再跟随设备历史方向
  check('★ 旋转角 watch 源为 directionDisplay.direction（不再跟随设备历史 direction）', /watch\(\s*\n?\s*\(\)\s*=>\s*directionDisplay\.value\.direction/.test(src) || /\(\)\s*=>\s*directionDisplay\.value\.direction/.test(src))
  check('不再 watch evacStore.currentDevice?.direction 作为角度来源', !/\(\)\s*=>\s*evacStore\.currentDevice\?\.direction/.test(src))
  // ⑤ 方向键 / 文字 / 箭头 / 状态标签使用同一判定，无效时不得高亮任一方向
  check('★ 方向键 active 仅由 directionDisplay.direction 决定（无效时两个都不高亮）', /active: directionDisplay\.direction === 'left'/.test(src) && /active: directionDisplay\.direction === 'right'/.test(src))
  check('方向键 unverified 条件与箭头可见性一致（!directionDisplay.showArrow）', /unverified: !directionDisplay\.showArrow/.test(src))
  check('无效状态方向文字为「—」（directionDisplay.direction 为 null 时回落）', /const d = directionDisplay\.value\.direction[\s\S]{0,160}\?\s*directionMap\[d\]\s*:\s*'—'/.test(src))
  // ⑥ 历史字段保留（不得因显示整改而删除）
  check('保留 storedDirectionLabel（历史值仍可展示/审计）', /const storedDirectionLabel = computed/.test(src))
  check('保留 overrideSourceLabel（本机覆盖须标注来源）', /const overrideSourceLabel = computed/.test(src))
  check('未删除设备 direction 字段的读取（仅用于历史展示）', /currentDevice\.value\?\.direction/.test(src))
}

console.log('')
console.log('=== 十八、Demo 快照裁决投影 / 索引 / 覆盖写不可变（R-11）===')
{
  const origMode = dataSource.mode
  const dtoOf = (d, direction) => ({ id: d.id, type: d.type, direction })
  const runSnap = (devices) => store.applyDemoSnapshot({ devices })
  const lights = lights5F()

  // ── S11 非 demo 路线裁决不产出 remote（两写者互斥）──
  // ⚠️ 顺序约束：必须在任何 demo 快照介入之前执行。demo 快照会让方案投影切到 demo
  //    语义，随后 applyBuildingPlans 的路线校验不再通过；这是「运行期切换数据源」的
  //    测试态产物，生产环境 dataSource.mode 启动后不再变化。
  resetDevices()
  applyBpRoutes(ROUTES)
  const routeStates = new Set((store.routeDirectionVerdicts || []).map((v) => v.state))
  check('S11 非 demo 路线裁决不产出 remote 且存在路线裁决状态',
    !routeStates.has('remote') && (routeStates.has('resolved') || routeStates.has('undetermined')), [...routeStates])

  try {
    // ── S1 投影正确：命中快照的灯具全部 remote，方向取 DTO 原值 ──
    dataSource.mode = 'demo'
    const s1 = lights.map((d, i) => dtoOf(d, i % 2 === 0 ? 'left' : 'right'))
    runSnap(s1)
    check('S1 裁决表条目数 = 命中快照的灯具数', store.routeDirectionVerdicts.length === lights.length, [store.routeDirectionVerdicts.length, lights.length])
    check('S1 条目全部为 remote', store.routeDirectionVerdicts.every((v) => v.state === 'remote'), store.routeDirectionVerdicts.map((v) => v.state))
    check('S1 方向取自 DTO 原值（首台 left）', (store.getRouteDirectionVerdict(lights[0].id) || {}).direction === 'left', store.getRouteDirectionVerdict(lights[0].id))
    check('S1 索引与裁决表同源', store.directionVerdictIndex.get(lights[0].id)?.state === 'remote', store.directionVerdictIndex.size)

    // ── S2 非法方向：不产出方向，记 backend-direction-invalid ──
    runSnap([dtoOf(lights[0], 'up'), dtoOf(lights[1], 'left')])
    const v2 = store.getRouteDirectionVerdict(lights[0].id)
    check('S2 非法方向 ⇒ undetermined + backend-direction-invalid', v2?.state === 'undetermined' && v2?.reason === 'backend-direction-invalid', v2)
    check('S2 非法方向条目不携带 direction', v2 && v2.direction === undefined, v2)
    // 上游 directionOf() 对任意非空字符串原样放行 ⇒ 设备字段会留下 'up'，这正是显示层必须做白名单的原因
    check('S2 设备字段保留非法原值 up（上游放行，故显示层必须靠白名单拦住）', lights[0].direction === 'up', lights[0].direction)

    // ── S3 缺失方向：防御分支（当前链路不可达，仍须 fail-closed） ──
    runSnap([{ id: lights[2].id, type: lights[2].type }])
    const v3 = store.getRouteDirectionVerdict(lights[2].id)
    check('S3 缺失方向 ⇒ undetermined + backend-direction-missing', v3?.state === 'undetermined' && v3?.reason === 'backend-direction-missing', v3)
    check('S3 缺失方向条目不携带 direction', v3 && v3.direction === undefined, v3)

    // ── S4 反向守卫：非 demo 模式绝不写裁决表 ──
    dataSource.mode = 'demo'
    runSnap([dtoOf(lights[0], 'left')])
    const refBeforeGuard = store.routeDirectionVerdicts
    dataSource.mode = origMode
    runSnap([dtoOf(lights[1], 'right')])
    check('S4 非 demo 模式不写裁决表（引用未变）', store.routeDirectionVerdicts === refBeforeGuard, store.routeDirectionVerdicts.length)
    check('S4 非 demo 模式条目数不变', store.routeDirectionVerdicts.length === refBeforeGuard.length)

    // ── S5 设备移出快照 ⇒ 条目消失（覆盖式，不残留） ──
    dataSource.mode = 'demo'
    runSnap([dtoOf(lights[0], 'left'), dtoOf(lights[1], 'right'), dtoOf(lights[2], 'left')])
    check('S5 三台设备进入裁决表', store.routeDirectionVerdicts.length === 3, store.routeDirectionVerdicts.length)
    runSnap([dtoOf(lights[0], 'left')])
    check('S5 移出快照的设备条目消失', store.getRouteDirectionVerdict(lights[1].id) === null, store.routeDirectionVerdicts.map((v) => v.deviceId))

    // ── S6 签名幂等：相同快照不换引用，内容变化必换 ──
    const s6 = [dtoOf(lights[0], 'left'), dtoOf(lights[1], 'right')]
    runSnap(s6)
    const refA = store.routeDirectionVerdicts
    runSnap(s6)
    check('S6 相同快照重复 ⇒ 数组引用不变（签名幂等）', store.routeDirectionVerdicts === refA)
    runSnap([dtoOf(lights[0], 'right'), dtoOf(lights[1], 'right')])
    check('S6 内容变化 ⇒ 数组引用改变', store.routeDirectionVerdicts !== refA)

    // ── S7 快照覆盖本机覆盖：manual 生命周期 ≤ 1 个快照周期 ──
    // ★ S2.1 强化：第二次使用**完全相同**的快照内容（旧版换了内容，会掩盖签名脱节）
    dataSource.mode = 'demo'
    const s7 = [dtoOf(lights[0], 'right'), dtoOf(lights[1], 'right')]
    runSnap(s7)
    store.switchEvacuationDirection(lights[0].id, 'left')
    check('S7 手动切换后条目为 overridden', store.getRouteDirectionVerdict(lights[0].id)?.state === 'overridden', store.getRouteDirectionVerdict(lights[0].id))
    runSnap(s7)
    check('S7 相同快照再次到达 ⇒ 覆盖回 remote', store.getRouteDirectionVerdict(lights[0].id)?.state === 'remote', store.getRouteDirectionVerdict(lights[0].id))
    check('S7 恢复后的方向等于后端下发值', store.getRouteDirectionVerdict(lights[0].id)?.direction === 'right', store.getRouteDirectionVerdict(lights[0].id))

    // ── S8 覆盖写不可变：整表替换，同设备仅 1 条 ──
    const refB = store.routeDirectionVerdicts
    const lenB = refB.length
    store.switchEvacuationDirection(lights[1].id, 'left')
    check('S8 覆盖写 ⇒ 数组引用改变（不可变整表替换）', store.routeDirectionVerdicts !== refB)
    check('S8 同设备不产生重复条目（长度不变或 +1）', store.routeDirectionVerdicts.length === lenB || store.routeDirectionVerdicts.length === lenB + 1, [lenB, store.routeDirectionVerdicts.length])
    check('S8 被覆盖设备仅 1 条', store.routeDirectionVerdicts.filter((v) => v.deviceId === lights[1].id).length === 1)

    // ── S9 复位清空裁决表与索引（复位须在非 demo 模式下执行，否则被 demoGuard 拦截） ──
    dataSource.mode = origMode
    resetDevices()
    check('S9 复位后裁决表为空', store.routeDirectionVerdicts.length === 0, store.routeDirectionVerdicts.length)
    check('S9 复位后索引为空', store.directionVerdictIndex.size === 0, store.directionVerdictIndex.size)

    // ── S10 非灯具不产生条目 ──
    dataSource.mode = 'demo'
    const nonLight = (store.devices || []).find((d) => d && d.type === 'smoke_detector')
    if (nonLight) {
      runSnap([{ id: nonLight.id, type: nonLight.type, direction: 'left' }])
      check('S10 非灯具不产生裁决条目', store.routeDirectionVerdicts.length === 0, store.routeDirectionVerdicts.map((v) => v.deviceId))
    } else {
      check('S10 非灯具样本存在（用于断言）', false, '未找到 smoke_detector')
    }

    // ── S12 索引唯一且与表同源 ──
    dataSource.mode = 'demo'
    runSnap([dtoOf(lights[0], 'left'), dtoOf(lights[1], 'right')])
    const idx = store.directionVerdictIndex
    check('S12 索引键数 = 裁决表条目数（2 台样本）', idx.size === 2 && idx.size === store.routeDirectionVerdicts.length, [idx.size, store.routeDirectionVerdicts.length])
    check('S12 索引值均为表内对象', [...idx.values()].every((v) => (store.routeDirectionVerdicts || []).includes(v)))

    // ── S13 替换式清空后索引同步 ──
    store.routeDirectionVerdicts = []
    check('S13 替换式清空（=[]）后索引为空', store.directionVerdictIndex.size === 0, store.directionVerdictIndex.size)

    // ── S14 连续两次覆盖同一设备 ──
    dataSource.mode = 'demo'
    runSnap([dtoOf(lights[0], 'left')])
    const r1 = store.routeDirectionVerdicts
    store.switchEvacuationDirection(lights[0].id, 'right')
    const r2 = store.routeDirectionVerdicts
    store.switchEvacuationDirection(lights[0].id, 'left')
    const r3 = store.routeDirectionVerdicts
    check('S14 连续两次覆盖：引用每次都变', r1 !== r2 && r2 !== r3)
    check('S14 连续两次覆盖：同设备仅 1 条', store.routeDirectionVerdicts.filter((v) => v.deviceId === lights[0].id).length === 1)
    check('S14 最后一条为最新覆盖方向', store.getRouteDirectionVerdict(lights[0].id)?.direction === 'left', store.getRouteDirectionVerdict(lights[0].id))
  } finally {
    dataSource.mode = origMode
    store.routeDirectionVerdicts = []
    store.routeDeviceBindings = []
  }
}

console.log('')
console.log('=== 十九、N-5 幂等基准取自当前表（投影→清空→重投影 / 覆盖→重投影）===')
{
  const origMode = dataSource.mode
  const dtoOf = (d, direction) => ({ id: d.id, type: d.type, direction })
  const runSnap = (devices) => store.applyDemoSnapshot({ devices })
  const flush = () => new Promise((r) => setTimeout(r, 0))
  const lights = lights5F()
  const A = [dtoOf(lights[0], 'left'), dtoOf(lights[1], 'right')]
  const isAllRemote = () => store.routeDirectionVerdicts.length === A.length
    && store.routeDirectionVerdicts.every((v) => v.state === 'remote')

  try {
    // ── N5-1 投影 A → 清空 → 再投影同一 A（核心回归）──
    dataSource.mode = 'demo'
    store.routeDirectionVerdicts = []
    runSnap(A)
    check('N5-1-① 首次投影建立裁决表（2 条 remote）', isAllRemote(), store.routeDirectionVerdicts)
    const refCleared = (store.routeDirectionVerdicts = [])
    check('N5-1-② 清空后表为空', store.routeDirectionVerdicts.length === 0)
    runSnap(A)
    check('N5-1-③ 清空后相同快照必须重建裁决表', isAllRemote(), store.routeDirectionVerdicts)
    check('N5-1-④ 重建写入的是新数组（未复用空数组引用）', store.routeDirectionVerdicts !== refCleared)
    check('N5-1-⑤ 索引同步重建', store.directionVerdictIndex.size === A.length, store.directionVerdictIndex.size)

    // ── N5-2 无清空、内容不变 ⇒ 引用不变（且连续两次）──
    const refStable = store.routeDirectionVerdicts
    runSnap(A)
    runSnap(A)
    check('N5-2-① 无清空且内容不变 ⇒ 连续重复投影引用不变', store.routeDirectionVerdicts === refStable)

    // ── N5-6 内容变化 ⇒ 必须换引用 ──
    const B = [dtoOf(lights[0], 'right'), dtoOf(lights[1], 'left')]
    runSnap(B)
    check('N5-6-① 内容变化 ⇒ 数组引用改变', store.routeDirectionVerdicts !== refStable)
    check('N5-6-② 表内容跟随新投影', store.getRouteDirectionVerdict(lights[0].id)?.direction === 'right', store.getRouteDirectionVerdict(lights[0].id))
    runSnap(A)
    check('N5-6-③ 回到原内容 ⇒ 再次换引用并恢复 A', store.routeDirectionVerdicts !== refStable && isAllRemote())

    // ── N5-5 非法方向：清空重投影后仍 fail-closed（签名基于内容）──
    const bad = [dtoOf(lights[0], 'up'), dtoOf(lights[1], 'right')]
    runSnap(bad)
    const vBad = store.getRouteDirectionVerdict(lights[0].id)
    check('N5-5-① 非法方向仍 fail-closed（undetermined + 无方向）',
      vBad?.state === 'undetermined' && vBad?.reason === 'backend-direction-invalid' && vBad?.direction === undefined, vBad)
    store.routeDirectionVerdicts = []
    runSnap(bad)
    const vBad2 = store.getRouteDirectionVerdict(lights[0].id)
    check('N5-5-② 清空后重投影非法内容仍为 undetermined（未退化成 remote）',
      vBad2?.state === 'undetermined' && vBad2?.reason === 'backend-direction-invalid', vBad2)

    // ── P1 切换楼栋（W3 :3858 真实触发）→ 相同快照必须重建 ──
    dataSource.mode = 'demo'
    store.routeDirectionVerdicts = []
    runSnap(A)
    const buildingBefore = store.dashboardView.selectedBuildingId
    store.dashboardView.selectedBuildingId = 'B001'
    await flush()
    check('P1-① 切换楼栋后裁决表被清空（真实触发 activateBuildingPlansFor）',
      store.routeDirectionVerdicts.length === 0, store.routeDirectionVerdicts.length)
    runSnap(A)
    check('P1-② 修复后：相同快照重建裁决表', isAllRemote(), store.routeDirectionVerdicts)
    store.dashboardView.selectedBuildingId = buildingBefore || 'B003'
    await flush()

    // ── P2 IDLE 快照（applyDemoPlans 先清空 :404，④ 再投影）──
    dataSource.mode = 'demo'
    store.routeDirectionVerdicts = []
    runSnap(A)
    const idleSnap = { buildingPlans: [], devices: A }
    store.applyDemoSnapshot(idleSnap)
    check('P2-① IDLE 快照（同轮清空 + 投影）后裁决表仍存在', isAllRemote(), store.routeDirectionVerdicts)
    store.applyDemoSnapshot(idleSnap)
    check('P2-② 重复相同 IDLE 快照不再出现「先清后空」', isAllRemote(), store.routeDirectionVerdicts)

    // ── P3 manual 覆盖后收到完全相同快照 ⇒ 恢复 remote ──
    dataSource.mode = 'demo'
    store.routeDirectionVerdicts = []
    runSnap(A)
    store.switchEvacuationDirection(A[0].id, 'right')
    check('P3-① 覆盖后条目为 overridden', store.getRouteDirectionVerdict(A[0].id)?.state === 'overridden', store.getRouteDirectionVerdict(A[0].id))
    runSnap(A)
    check('P3-② 相同快照到达 ⇒ 恢复 remote', store.getRouteDirectionVerdict(A[0].id)?.state === 'remote', store.getRouteDirectionVerdict(A[0].id))
    check('P3-③ 恢复后的方向等于后端下发值 left', store.getRouteDirectionVerdict(A[0].id)?.direction === 'left', store.getRouteDirectionVerdict(A[0].id))
    check('P3-④ 表中不残留 overridden 条目', store.routeDirectionVerdicts.every((v) => v.state === 'remote'), store.routeDirectionVerdicts.map((v) => v.state))
  } finally {
    dataSource.mode = origMode
    store.routeDirectionVerdicts = []
    store.routeDeviceBindings = []
  }
}

await server.close()
console.log('')
console.log(`=== 结果：${pass} 通过 / ${fail} 失败 ===`)
if (fail) process.exit(1)

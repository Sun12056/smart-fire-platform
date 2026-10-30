/**
 * 疏散指示灯方向裁决 —— 单元验证（P1.8.2）
 *
 * 路线几何取自**真实拓扑**（buildBuildingGraph + dijkstra），设备坐标取自**真实设备源**
 * （generateFloorDevices），不自建几何、不伪造映射。
 *
 * 本组不覆盖：浏览器端渲染、demo 后端方向下发、真实设备下发。
 */
import {
  resolveDeviceDirections,
  routeDirectionAtDevice,
  resolveDirectionDisplay,
  DIRECTION_MIN_DX,
  DIRECTION_VERDICT,
} from './deviceDirection.js'
import { buildBuildingGraph, dijkstra } from './routeGraph.js'
// 规则乙复核用：真实整栋楼规划器（与手写 dijkstra 夹具互为交叉验证，见第十六组）
import { planZoneRoutes, pickRouteByStrategy } from './buildingEvacuationPlanner.js'
import { STRATEGY } from './buildingEvacuationTypes.js'
import { generateFloorDevices } from '../../src/mock/floorPlanData.js'

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
const dirOf = (bindings, id) => {
  const b = bindings.find((x) => x.deviceId === id)
  return b ? b.direction : null
}

const graph = buildBuildingGraph(6)
const EMPTY = new Set()
const ZONE_KEY = { 'A区': 'A_CENTER', 'B区': 'B_CENTER', 'C区': 'C_CENTER', 'D区': 'D_CENTER' }

/** 真实最短路 → 路线几何（与 fireStore.routeToRenderable 的 path 形状一致） */
function buildRoute(zone) {
  const start = `5F:${ZONE_KEY[zone]}`
  const rw = dijkstra(graph, start, '1F:EXIT_W', EMPTY, EMPTY)
  const re = dijkstra(graph, start, '1F:EXIT_E', EMPTY, EMPTY)
  const best = rw.cost <= re.cost ? rw : re
  return {
    id: `R-${zone}`,
    path: best.path.map((id) => ({
      id,
      floorId: graph.nodes[id].floorId,
      x: graph.nodes[id].x,
      y: graph.nodes[id].y,
    })),
  }
}

/** 指定出口的路线（用于构造 BALANCED 负载均衡下的「同层混合出口」场景） */
function buildRouteTo(zone, exit) {
  const start = `5F:${ZONE_KEY[zone]}`
  const r = dijkstra(graph, start, exit, EMPTY, EMPTY)
  return {
    id: `R-${zone}-${/EXIT_E/.test(exit) ? 'E' : 'W'}`,
    path: r.path.map((id) => ({
      id,
      floorId: graph.nodes[id].floorId,
      x: graph.nodes[id].x,
      y: graph.nodes[id].y,
    })),
  }
}

const ROUTES = ['A区', 'B区', 'C区', 'D区'].map(buildRoute)
const DEV_5F = generateFloorDevices('5F', 'B003').filter((d) => d.type === 'evacuation_light')
// generateFloorDevices 产出的是不带楼栋前缀的 id（store 内由 buildSeedDevices 补 B003- 前缀）
const ID = (name) => `EL-5F-${name}`

console.log('=== 一、5F 双出口并存：方向不再整层统一 ===')
{
  const { bindings, undetermined } = resolveDeviceDirections(DEV_5F, ROUTES)
  console.log('    路线出口：', ROUTES.map((r) => `${r.id}→${r.path[r.path.length - 1].id}`).join(' , '))
  console.log('    绑定：', bindings.map((b) => `${b.deviceId.slice(-7)}=${b.direction}`).join(' '))
  console.log('    未定：', undetermined.map((u) => `${u.deviceId.slice(-7)}(${u.reason})`).join(' '))
  const dirs = new Set(bindings.map((b) => b.direction))
  check('走廊灯同时存在 left 与 right（未整层统一）', dirs.has('left') && dirs.has('right'), [...dirs])
  // ★ 规则乙（产品决策 Q1）：EL-01 / EL-13 位于「走廊端头→楼梯」的垂直引入段上
  //   （EL-01 在 CORRIDOR_W(72,170)→STAIR_NW(72,45)；EL-13 在 CORRIDOR_E→STAIR_NE），
  //   现有数据无法可靠区分走廊指示与楼梯指示 ⇒ 保守判为未定，**不再**产出 left/right。
  const u01 = undetermined.find((u) => u.deviceId === ID('01'))
  const u13 = undetermined.find((u) => u.deviceId === ID('13'))
  check('★ 西端 EL-01(x=72) 由 left 变为未定（corner-vertical-out-edge）', dirOf(bindings, ID('01')) === null && !!u01 && u01.reason === 'corner-vertical-out-edge', u01)
  check('★ 东端 EL-13(x=477) 由 right 变为未定（corner-vertical-out-edge）', dirOf(bindings, ID('13')) === null && !!u13 && u13.reason === 'corner-vertical-out-edge', u13)
  check('中段 EL-05(x=205) 朝左（离西出口更近）', dirOf(bindings, ID('05')) === 'left', dirOf(bindings, ID('05')))
  check('中段 EL-09(x=355) 朝右（离东出口更近）', dirOf(bindings, ID('09')) === 'right', dirOf(bindings, ID('09')))
  check('规则乙下仍未整层统一（仍有 left 与 right 的裁决设备）', dirs.has('left') && dirs.has('right'), [...dirs])
}

console.log('')
console.log('=== 二、遍历顺序无关（正序 / 逆序结果一致）===')
{
  const fwdRes = resolveDeviceDirections(DEV_5F, ROUTES)
  const revRes = resolveDeviceDirections(DEV_5F, [...ROUTES].reverse())
  const fwd = fwdRes.bindings
  const rev = revRes.bindings
  const key = (arr) => arr.map((b) => `${b.deviceId}:${b.direction}`).sort().join('|')
  check('正序与逆序绑定集合完全相同', key(fwd) === key(rev), [key(fwd), key(rev)])
  // ★ 规则乙：EL-01 / EL-13 在两个顺序下都必须是未定，不得因遍历顺序被改成某个方向
  const u01f = fwdRes.undetermined.find((u) => u.deviceId === ID('01'))
  const u01r = revRes.undetermined.find((u) => u.deviceId === ID('01'))
  const u13f = fwdRes.undetermined.find((u) => u.deviceId === ID('13'))
  const u13r = revRes.undetermined.find((u) => u.deviceId === ID('13'))
  const outEdge = (u) => !!u && u.reason === 'corner-vertical-out-edge'
  check('西端灯不因逆序被改成 right（两序均为未定 corner-vertical-out-edge）', dirOf(rev, ID('01')) === null && dirOf(fwd, ID('01')) === null && outEdge(u01f) && outEdge(u01r), [u01f, u01r])
  check('东端灯不因逆序被改成 left（两序均为未定 corner-vertical-out-edge）', dirOf(rev, ID('13')) === null && dirOf(fwd, ID('13')) === null && outEdge(u13f) && outEdge(u13r), [u13f, u13r])
}

console.log('')
console.log('=== 三、绑定唯一性（同一设备不产出多条）===')
{
  const { bindings } = resolveDeviceDirections(DEV_5F, ROUTES)
  const ids = bindings.map((b) => b.deviceId)
  check('deviceId 无重复', new Set(ids).size === ids.length, ids)
  check('绑定条数 ≤ 设备数（不再 11 台 × 4 条路线 = 44 条）', bindings.length <= DEV_5F.length, [bindings.length, DEV_5F.length])
  const byDev = new Map()
  bindings.forEach((b) => {
    if (!byDev.has(b.deviceId)) byDev.set(b.deviceId, [])
    byDev.get(b.deviceId).push(b.direction)
  })
  check('不存在同设备多方向的冲突记录', [...byDev.values()].every((v) => v.length === 1), [...byDev])
}

console.log('')
console.log('=== 四、楼梯口垂直段判为未定（不伪造方向）===')
{
  const { bindings, undetermined } = resolveDeviceDirections(DEV_5F, ROUTES)
  const stair1 = DEV_5F.find((d) => d.area === '楼梯1')
  const stair2 = DEV_5F.find((d) => d.area === '楼梯2')
  check('楼梯1 灯具不产生方向绑定', dirOf(bindings, stair1.id) === null, stair1.id)
  check('楼梯2 灯具不产生方向绑定', dirOf(bindings, stair2.id) === null, stair2.id)
  check('楼梯1/2 被记入 undetermined', undetermined.some((u) => u.deviceId === stair1.id) && undetermined.some((u) => u.deviceId === stair2.id), undetermined)
  check('undetermined 的 dx 绝对值小于阈值', undetermined.every((u) => Math.abs(u.dx) < DIRECTION_MIN_DX), undetermined)
}

console.log('')
console.log('=== 五、方向来自路线几何，而非设备位置的静态启发式 ===')
{
  const eastOnly = [ROUTES[2], ROUTES[3]] // 只有 C区/D区（东出口）路线
  const westOnly = [ROUTES[0], ROUTES[1]] // 只有 A区/B区（西出口）路线
  const bEast = resolveDeviceDirections(DEV_5F, eastOnly).bindings
  const bWest = resolveDeviceDirections(DEV_5F, westOnly).bindings
  check('仅有东出口路线时，西端灯 EL-01(x=72) 朝右', dirOf(bEast, ID('01')) === 'right', dirOf(bEast, ID('01')))
  check('仅有西出口路线时，东端灯 EL-13(x=477) 朝左', dirOf(bWest, ID('13')) === 'left', dirOf(bWest, ID('13')))
  check('同一台灯在不同路线集下方向不同 ⇒ 非位置启发式', dirOf(bEast, ID('01')) !== dirOf(bWest, ID('01')), [dirOf(bEast, ID('01')), dirOf(bWest, ID('01'))])
}

console.log('')
console.log('=== 六、跨层隔离（不同楼层节点不得混用）===')
{
  const dev4F = generateFloorDevices('4F', 'B003').filter((d) => d.type === 'evacuation_light')
  const westRoute = ROUTES[0]
  const { bindings, undetermined } = resolveDeviceDirections(dev4F, [westRoute])
  // 4F 路径上只有楼梯竖井节点，4F 灯具不应被 5F 走廊节点（坐标极近）误匹配
  const nearest = routeDirectionAtDevice(dev4F.find((d) => d.x === 72 && d.area === '走廊'), westRoute)
  check('4F 走廊灯匹配到的是 4F 节点而非 5F 节点', nearest && nearest.distance > 100, nearest)
  check('4F 灯具全部未定（路径在该层为纯竖井）', bindings.length === 0 && undetermined.length > 0, [bindings.length, undetermined.length])
}

console.log('')
console.log('=== 七、边界健壮性 ===')
{
  const r = resolveDeviceDirections([{}, null, undefined, { id: 'x' }], ROUTES)
  check('残缺设备不抛异常且不产生绑定', r.bindings.length === 0, r.bindings)
  const r2 = resolveDeviceDirections(DEV_5F, [])
  check('空路线集不抛异常且不产生绑定', r2.bindings.length === 0, r2.bindings)
  check('routeDirectionAtDevice 对空路线返回 null', routeDirectionAtDevice(DEV_5F[0], null) === null)
}

console.log('')
console.log('=== 八、拐角误判与几何归因错误（真实路线 A区→西 / B区→东）===')
{
  // 真实拓扑：A区走西出口、B区走东出口（BALANCED 负载均衡可产生该组合）
  const rAW = buildRouteTo('A区', '1F:EXIT_W')
  const rBE = buildRouteTo('B区', '1F:EXIT_E')
  const dev3 = DEV_5F.find((d) => d.id === ID('03'))
  const dev5 = DEV_5F.find((d) => d.id === ID('05'))
  const c3 = routeDirectionAtDevice(dev3, rAW)
  const c5w = routeDirectionAtDevice(dev5, rAW)
  const c5e = routeDirectionAtDevice(dev5, rBE)
  const r = resolveDeviceDirections(DEV_5F, [rAW, rBE])

  // ① EL-5F-03(140,162) 落在垂直入边 A_CENTER(140,150)→CORRIDOR_N(140,170) 上
  check('EL-5F-03 与西向路线的关联距离为 0（确实落在路径段上）', !!c3 && c3.distance === 0, c3)
  check('EL-5F-03 最近节点是拐角 CORRIDOR_N（节点距 8）', !!c3 && c3.nodeDistance === 8, c3 && c3.nodeDistance)
  check('该拐角处中心差分的水平分量全部来自出边（dxCentered=-68）', !!c3 && c3.dxCentered === -68, c3 && c3.dxCentered)
  check('★ EL-5F-03 不再被赋予出边方向 left（保守降级为未定）', !!c3 && c3.direction === null, c3 && c3.direction)
  check('降级原因标明 corner-vertical-in-edge', !!c3 && c3.reason === 'corner-vertical-in-edge', c3 && c3.reason)
  check('EL-5F-03 不产出方向绑定', dirOf(r.bindings, ID('03')) === null, dirOf(r.bindings, ID('03')))
  check('EL-5F-03 记入 undetermined', r.undetermined.some((u) => u.deviceId === ID('03')), r.undetermined.map((u) => u.deviceId))

  // ② EL-5F-05(205,162)：旧的「等距冲突」实为几何归因错误
  check(
    '两条路线到最近节点的距离相同 ⇒ 旧规则会据此判为等距冲突',
    !!c5w && !!c5e && c5w.nodeDistance === c5e.nodeDistance,
    [c5w && c5w.nodeDistance, c5e && c5e.nodeDistance],
  )
  check(
    '但到路线折线的关联距离不同（西 65 / 东 8）⇒ 设备明显更贴近东向路线',
    !!c5w && !!c5e && c5e.distance < c5w.distance,
    [c5w && c5w.distance, c5e && c5e.distance],
  )
  check('★ EL-5F-05 按几何关联归属东向路线 ⇒ right（不再是冲突）', dirOf(r.bindings, ID('05')) === 'right', dirOf(r.bindings, ID('05')))
  check('EL-5F-05 不出现在 conflicts', !r.conflicts.some((c) => c.deviceId === ID('05')), r.conflicts.map((c) => c.deviceId))
  check('该真实场景下不产生任何冲突（旧的两个"冲突"均为归因错误）', r.conflicts.length === 0, r.conflicts)
}

console.log('')
console.log('=== 九、冲突结果顺序无关（正序 / 逆序一致）===')
{
  const rAW = buildRouteTo('A区', '1F:EXIT_W')
  const rBE = buildRouteTo('B区', '1F:EXIT_E')
  const fwd = resolveDeviceDirections(DEV_5F, [rAW, rBE])
  const rev = resolveDeviceDirections(DEV_5F, [rBE, rAW])
  const norm = (r) => JSON.stringify({
    b: r.bindings.map((x) => `${x.deviceId}:${x.direction}`).sort(),
    c: r.conflicts.map((x) => `${x.deviceId}|${x.candidates.map((y) => y.routeId + ':' + y.direction).sort().join(',')}`).sort(),
    u: r.undetermined.map((x) => x.deviceId).sort(),
  })
  check('正序与逆序的 bindings/conflicts/undetermined 完全一致', norm(fwd) === norm(rev), [norm(fwd), norm(rev)])
  check('冲突设备在两个顺序下都不产出绑定', dirOf(fwd.bindings, ID('03')) === null && dirOf(rev.bindings, ID('03')) === null, [dirOf(fwd.bindings, ID('03')), dirOf(rev.bindings, ID('03'))])
}

console.log('')
console.log('=== 十、同方向候选不得被误判为冲突 ===')
{
  const { bindings, conflicts, undetermined } = resolveDeviceDirections(DEV_5F, ROUTES)
  check('既有路线集（A/B→西、C/D→东）不产生冲突', conflicts.length === 0, conflicts)
  // EL-5F-01 到 R-A区 / R-B区 关联距离相等（均落在同一条垂直出边上）⇒ 多候选不得被误判为冲突
  const u01 = undetermined.find((u) => u.deviceId === ID('01'))
  check('等距多候选不得被误判为冲突（EL-01 记入 undetermined 而非 conflicts）', dirOf(bindings, ID('01')) === null && !!u01, [dirOf(bindings, ID('01')), u01])
  check('等距设备不出现在 conflicts', !conflicts.some((c) => c.deviceId === ID('01')), conflicts.map((c) => c.deviceId))

  // ★「等距且同向仍正常产出方向」这一安全属性需要一个**并列且方向一致非空**的样本。
  //   规则乙下真实拓扑中已不存在这样的设备（并列样本 EL-01/13/19/20 的方向集均为 [null]），
  //   故此处用**最小构造夹具**复现该形态并明确标注，不冒充真实规划器结论。
  const flatTie = (id, pts) => ({ id, path: pts.map((p, i) => ({ id: `${id}-${i}`, floorId: '5F', x: p[0], y: p[1] })) })
  const upper = flatTie('R-UP', [[100, 160], [300, 160]])
  const lower = flatTie('R-LOW', [[100, 180], [300, 180]])
  const tieDev = [{ id: 'EL-5F-TIE', x: 200, y: 170, floorId: '5F' }]
  const cUp = routeDirectionAtDevice(tieDev[0], upper)
  const cLow = routeDirectionAtDevice(tieDev[0], lower)
  check('夹具前提：两条路线关联距离相等（确为等距）', !!cUp && !!cLow && cUp.distance === cLow.distance && cUp.direction === cLow.direction, [cUp, cLow])
  const tie = resolveDeviceDirections(tieDev, [upper, lower])
  check('★ 等距且同向 ⇒ 正常产出方向，不得报冲突', dirOf(tie.bindings, 'EL-5F-TIE') === 'right' && tie.conflicts.length === 0, [dirOf(tie.bindings, 'EL-5F-TIE'), tie.conflicts.length])
}

console.log('')
console.log('=== 十一、真实冲突：等距反向 ⇒ 不产出方向；路线负载只作诊断 ===')
{
  // ⚠️ 构造夹具（明确标注）：真实拓扑下最短路不会让两条路线在同一走廊段反向共行，
  //    因此无法用真实路线产出"真实冲突"。这里构造最小几何复现该形态：
  //    两条路线共用 y=170 的同一段走廊，一条向西、一条向东；设备位于走廊北侧 8 处。
  const west = {
    id: 'R-W',
    path: [
      { id: 'w1', floorId: '5F', x: 300, y: 170 },
      { id: 'w2', floorId: '5F', x: 100, y: 170 },
    ],
  }
  const east = {
    id: 'R-E',
    path: [
      { id: 'e1', floorId: '5F', x: 100, y: 170 },
      { id: 'e2', floorId: '5F', x: 300, y: 170 },
    ],
  }
  const dev = [{ id: 'EL-5F-X', x: 200, y: 162, floorId: '5F' }]
  // 给西向路线压倒性的人数权重：若权重参与裁决，就会被"裁决出" left
  const r = resolveDeviceDirections(dev, [{ ...west, weight: 999 }, { ...east, weight: 1 }])
  const c = r.conflicts.find((x) => x.deviceId === 'EL-5F-X')
  check('等距反向 ⇒ 产生冲突记录', !!c, r.conflicts)
  check('两条候选关联距离相等（确为等距，非归因错误）', !!c && c.candidates[0].distance === c.candidates[1].distance, c && c.candidates.map((x) => x.distance))
  check('冲突候选含 left 与 right', !!c && c.candidates.some((x) => x.direction === 'left') && c.candidates.some((x) => x.direction === 'right'), c && c.candidates.map((x) => x.direction))
  check('★ 冲突设备不产出任何方向绑定', dirOf(r.bindings, 'EL-5F-X') === null, dirOf(r.bindings, 'EL-5F-X'))
  check('★ 人数权重不把冲突压成唯一方向（仍是冲突、仍无绑定）', r.conflicts.length === 1 && r.bindings.length === 0, [r.conflicts.length, r.bindings.length])
  check('负载值作为诊断信息进入 candidates', !!c && c.candidates.some((x) => x.load === 999) && c.candidates.some((x) => x.load === 1), c && c.candidates.map((x) => x.load))
  check('冲突记录含 routeId / distance / dxCentered 可审计', !!c && c.candidates.every((x) => x.routeId !== undefined && Number.isFinite(x.distance) && Number.isFinite(x.dxCentered)), c && c.candidates)
}

console.log('')
console.log('=== 十二、无 path 的路线（手动路线）⇒ 未联动，不得静默 ===')
{
  const noPath = [
    { id: 'R-MANUAL-1' },
    { id: 'R-MANUAL-2', path: [] },
  ]
  const { bindings, unlinked, noPathRoutes, conflicts, undetermined } = resolveDeviceDirections(DEV_5F, noPath)
  check('缺 path 的路线记入 noPathRoutes', noPathRoutes.length === 2 && noPathRoutes.includes('R-MANUAL-1') && noPathRoutes.includes('R-MANUAL-2'), noPathRoutes)
  check('全部设备标记为未联动', unlinked.length === DEV_5F.length, [unlinked.length, DEV_5F.length])
  check('未联动设备不产出绑定', bindings.length === 0, bindings.length)
  check('未联动不产生冲突/未定误判', conflicts.length === 0 && undetermined.length === 0, [conflicts.length, undetermined.length])
  check('未联动原因标明为 no-path-route', unlinked.every((u) => u.reason === 'no-path-route'), unlinked[0])
}

console.log('')
console.log('=== 十三、四种几何形态的分类验证（拐角 / 垂直 / 冲突 / 普通水平）===')
{
  const flat = (id, pts) => ({ id, path: pts.map((p, i) => ({ id: id + '-' + i, floorId: '5F', x: p[0], y: p[1] })) })
  // ① 拐角：房间(140,150) → 走廊拐角(140,170) → 向西(72,170)；设备落在垂直入边上
  const corner = flat('R-CORNER', [[140, 150], [140, 170], [72, 170]])
  const onInEdge = { id: 'D-CORNER', x: 140, y: 162, floorId: '5F' }
  const rc = routeDirectionAtDevice(onInEdge, corner)
  check('① 拐角：设备落在垂直入边 ⇒ 未定，不产出方向', !!rc && rc.direction === null && rc.reason === 'corner-vertical-in-edge', rc)
  check('① 拐角：未定条目的 dx 为 0（不得残留出边的 dx 冒充水平走向）', !!rc && rc.dx === 0, rc && rc.dx)

  // ② 垂直路线：整条路线是竖井（楼梯），无水平位移
  const shaft = flat('R-SHAFT', [[72, 170], [72, 45]])
  const onShaft = { id: 'D-SHAFT', x: 72, y: 100, floorId: '5F' }
  const rs = routeDirectionAtDevice(onShaft, shaft)
  check('② 垂直路线：不产出方向', !!rs && rs.direction === null, rs)
  check('② 垂直路线：关联距离为 0（确实落在竖井上）', !!rs && rs.distance === 0, rs && rs.distance)
  const rsAll = resolveDeviceDirections([onShaft], [shaft])
  check('② 垂直路线：记入 undetermined', rsAll.undetermined.some((u) => u.deviceId === 'D-SHAFT'), rsAll.undetermined)

  // ③ 冲突：见第十一组（等距反向）；此处确认「未定 + 同距」不会被误判为冲突
  const rw = flat('R-W', [[300, 170], [100, 170]])
  const re = flat('R-E', [[100, 170], [300, 170]])
  const mid = { id: 'D-MID', x: 200, y: 162, floorId: '5F' }
  const rConf = resolveDeviceDirections([mid], [rw, re])
  check('③ 冲突：等距反向 ⇒ 冲突，无绑定', rConf.conflicts.length === 1 && rConf.bindings.length === 0, [rConf.conflicts.length, rConf.bindings.length])

  // ④ 普通水平路线：设备贴近水平走廊 ⇒ 正常产出方向
  const hall = flat('R-HALL', [[100, 170], [300, 170]])
  const nearHall = { id: 'D-HALL', x: 200, y: 162, floorId: '5F' }
  const rh = routeDirectionAtDevice(nearHall, hall)
  check('④ 普通水平：正常产出 right', !!rh && rh.direction === 'right', rh)
  const rHall = resolveDeviceDirections([nearHall], [hall])
  check('④ 普通水平：产出绑定且无冲突/未定', rHall.bindings.length === 1 && rHall.conflicts.length === 0 && rHall.undetermined.length === 0, [rHall.bindings.length, rHall.conflicts.length, rHall.undetermined.length])
}

console.log('')
console.log('=== 十四、UI 方向显示判定（不得拿历史 direction 冒充本轮有效指引）===')
{
  // ⚠️ 限制说明：本测试架构不挂载 Vue 组件（EvacuationView 依赖 Pinia / Element Plus / 路由），
  //    因此把「箭头是否渲染」的判定抽成纯函数 resolveDirectionDisplay 并在此直接验证；
  //    另有一组源码级断言确认 EvacuationView 的箭头/标签确实由该函数驱动。
  const v = (state, direction) => ({ state, direction })

  const none = resolveDirectionDisplay(null, 'left')
  check('① 无裁决(verdict=null) + 历史值 left ⇒ 不渲染箭头', none.showArrow === false, none)
  check('① 无裁决时 direction 输出为 null（不得透出历史值）', none.direction === null, none)
  check('① 无裁决但存有历史值 ⇒ stale=true（界面须提示）', none.stale === true, none)
  check('① 无裁决 ⇒ 不是本轮有效路线指引', none.isValidRouteGuidance === false, none)
  check('① 历史值仍被保留供显示/审计（不删除字段）', none.storedDirection === 'left', none)

  for (const st of [DIRECTION_VERDICT.CONFLICT, DIRECTION_VERDICT.UNDETERMINED, DIRECTION_VERDICT.UNLINKED]) {
    const d = resolveDirectionDisplay(v(st), 'left')
    check(`② ${st} + 历史值 left ⇒ 不渲染箭头且 stale=true`, d.showArrow === false && d.stale === true && d.direction === null, d)
  }

  const ok = resolveDirectionDisplay(v(DIRECTION_VERDICT.RESOLVED, 'right'), 'left')
  check('③ resolved ⇒ 渲染箭头、非 stale、是本轮有效指引', ok.showArrow === true && ok.stale === false && ok.isValidRouteGuidance === true, ok)
  check('③ resolved 时输出的是裁决方向而非历史值', ok.direction === 'right', ok)

  const manual = resolveDirectionDisplay({ state: DIRECTION_VERDICT.OVERRIDDEN, direction: 'right', overrideSource: 'manual' }, 'left')
  check('④ 本机覆盖 ⇒ 渲染箭头但**不算**本轮路线裁决', manual.showArrow === true && manual.isValidRouteGuidance === false && manual.isManualOverride === true, manual)

  const noHistory = resolveDirectionDisplay(null, null)
  check('⑤ 无裁决且设备无历史值 ⇒ 不渲染箭头且 stale=false', noHistory.showArrow === false && noHistory.stale === false, noHistory)
}

console.log('')
console.log('=== 十五、规则乙（对称拐角：入边水平 / 出边垂直）专项验证 ===')
{
  const { bindings, undetermined, conflicts } = resolveDeviceDirections(DEV_5F, ROUTES)
  const undOf = (n) => undetermined.find((u) => u.deviceId === ID(n))
  const devOf = (n) => DEV_5F.find((d) => d.id === ID(n))
  const reasonOf = (n) => {
    const u = undOf(n)
    return u ? u.reason : null
  }

  // EL-5F-01(72,162)：入边 CORRIDOR_N(140,170)→CORRIDOR_W(72,170) 水平；出边 CORRIDOR_W→STAIR_NW(72,45) 垂直
  const c01 = routeDirectionAtDevice(devOf('01'), ROUTES[0])
  check('EL-5F-01 最近节点为 CORRIDOR_W，节点距 8', !!c01 && c01.nodeDistance === 8, c01 && c01.nodeDistance)
  check('EL-5F-01 落在垂直出边上（关联距 0）', !!c01 && c01.distance === 0, c01 && c01.distance)
  check('EL-5F-01 中心差分水平分量全部来自入边（dxCentered=-68）', !!c01 && c01.dxCentered === -68, c01 && c01.dxCentered)
  check('★ EL-5F-01 规则乙 ⇒ 未定 corner-vertical-out-edge', !!c01 && c01.direction === null && c01.reason === 'corner-vertical-out-edge', c01)
  check('EL-5F-01 未定条目 dx 归零（不得残留入边的 -68）', !!c01 && c01.dx === 0, c01 && c01.dx)

  // EL-5F-13(477,162)：入边 CORRIDOR_S→CORRIDOR_E 水平(+62)；出边 CORRIDOR_E→STAIR_NE(477,45) 垂直
  const c13 = routeDirectionAtDevice(devOf('13'), ROUTES[2])
  check('EL-5F-13 落在垂直出边上（关联距 0）', !!c13 && c13.distance === 0, c13 && c13.distance)
  check('EL-5F-13 中心差分水平分量全部来自入边（dxCentered=62）', !!c13 && c13.dxCentered === 62, c13 && c13.dxCentered)
  check('★ EL-5F-13 规则乙 ⇒ 未定 corner-vertical-out-edge', !!c13 && c13.direction === null && c13.reason === 'corner-vertical-out-edge', c13)

  // 既有语义保留
  check('EL-5F-03 仍为未定 corner-vertical-in-edge（入边垂直的拐角语义不变）', dirOf(bindings, ID('03')) === null && reasonOf('03') === 'corner-vertical-in-edge', reasonOf('03'))
  check('EL-5F-05 仍正常裁决为 left', dirOf(bindings, ID('05')) === 'left', dirOf(bindings, ID('05')))
  check('规则乙下仍无冲突', conflicts.length === 0, conflicts)

  // 规则乙不得被路线权重 / 人数 / 拥堵翻转
  const heavy = resolveDeviceDirections(DEV_5F, [{ ...ROUTES[0], weight: 999 }, ROUTES[1], ROUTES[2], ROUTES[3]])
  check('★ 给路线压倒性权重也不能把对称拐角"裁决出"方向', dirOf(heavy.bindings, ID('01')) === null, dirOf(heavy.bindings, ID('01')))
  check('权重场景下 EL-01 仍记入 undetermined', heavy.undetermined.some((u) => u.deviceId === ID('01') && u.reason === 'corner-vertical-out-edge'), heavy.undetermined.map((u) => u.deviceId))

  // 核心几何回归：仅东出口 / 仅西出口
  const eastOnly = [buildRouteTo('C区', '1F:EXIT_E'), buildRouteTo('D区', '1F:EXIT_E')]
  const westOnly = [buildRouteTo('A区', '1F:EXIT_W'), buildRouteTo('B区', '1F:EXIT_W')]
  const rE = resolveDeviceDirections(DEV_5F, eastOnly)
  const rW = resolveDeviceDirections(DEV_5F, westOnly)
  check('★ 规则乙未破坏核心回归：仅东出口时 EL-01 仍为 right', dirOf(rE.bindings, ID('01')) === 'right', dirOf(rE.bindings, ID('01')))
  check('★ 规则乙未破坏核心回归：仅西出口时 EL-13 仍为 left', dirOf(rW.bindings, ID('13')) === 'left', dirOf(rW.bindings, ID('13')))
  check('仅东出口时 EL-13 为未定（仍在楼梯引入段上）', dirOf(rE.bindings, ID('13')) === null, dirOf(rE.bindings, ID('13')))
  check('仅西出口时 EL-01 为未定（仍在楼梯引入段上）', dirOf(rW.bindings, ID('01')) === null, dirOf(rW.bindings, ID('01')))
  check('仅东 / 仅西出口场景方向仍然相反（未退化为整层统一）', dirOf(rE.bindings, ID('01')) !== dirOf(rW.bindings, ID('01')), [dirOf(rE.bindings, ID('01')), dirOf(rW.bindings, ID('01'))])
}

console.log('')
console.log('=== 十六、真实规划器（planZoneRoutes + BALANCED）路径复核 ===')
{
  // ⚠️ 路线来源说明（必读）：本文件其余各组的 ROUTES 由 dijkstra 直接构造，**并非**
  //    真实规划器输出 —— 实测 R-B区 两条路径不同：
  //      dijkstra    : B_CENTER → CORRIDOR_N → CORRIDOR_W
  //      BALANCED规划器: B_CENTER → CORRIDOR_W（直连）
  //    因此这里用真实规划器复核四台目标设备，避免把手写夹具结论当成规划器的完整证明。
  const g = buildBuildingGraph(6)
  const routes = []
  for (const z of ['A区', 'B区', 'C区', 'D区']) {
    const res = planZoneRoutes({ graph: g, floorId: '5F', zone: z, fire: null, personCount: 0 })
    const pick = pickRouteByStrategy(res.candidates, STRATEGY.BALANCED, {})
    routes.push({
      id: `R-${z}`,
      path: pick.nodes.map((n, i) => ({ id: n, floorId: String(n).split(':')[0], x: pick.points[i].x, y: pick.points[i].y })),
    })
  }
  console.log('    规划器选中出口：', routes.map((r) => `${r.id}→${r.path[r.path.length - 1].id}`).join(' , '))
  const r = resolveDeviceDirections(DEV_5F, routes)
  const undOf = (n) => r.undetermined.find((u) => u.deviceId === ID(n))
  const reasonOf = (n) => {
    const u = undOf(n)
    return u ? u.reason : null
  }
  console.log('    绑定：', r.bindings.map((b) => `${b.deviceId.slice(-7)}=${b.direction}`).join(' '))
  console.log('    未定：', r.undetermined.map((u) => `${u.deviceId.slice(-7)}(${u.reason})`).join(' '))

  check('规划器出口组合与夹具一致（A/B→西、C/D→东）', routes[0].path[routes[0].path.length - 1].id === '1F:EXIT_W' && routes[2].path[routes[2].path.length - 1].id === '1F:EXIT_E', routes.map((x) => x.path[x.path.length - 1].id))
  check('★ 真实 BALANCED：EL-01 未定 corner-vertical-out-edge', dirOf(r.bindings, ID('01')) === null && reasonOf('01') === 'corner-vertical-out-edge', reasonOf('01'))
  check('★ 真实 BALANCED：EL-13 未定 corner-vertical-out-edge', dirOf(r.bindings, ID('13')) === null && reasonOf('13') === 'corner-vertical-out-edge', reasonOf('13'))
  check('★ 真实 BALANCED：EL-03 未定 corner-vertical-in-edge', dirOf(r.bindings, ID('03')) === null && reasonOf('03') === 'corner-vertical-in-edge', reasonOf('03'))
  check('★ 真实 BALANCED：EL-05 仍裁决为 left（规则乙不影响中段灯）', dirOf(r.bindings, ID('05')) === 'left', dirOf(r.bindings, ID('05')))
  check('真实 BALANCED 方案下无冲突', r.conflicts.length === 0, r.conflicts)
  const dirs = new Set(r.bindings.map((b) => b.direction))
  check('真实 BALANCED 下仍同时存在 left 与 right（未整层统一）', dirs.has('left') && dirs.has('right'), [...dirs])
}

console.log('')
console.log(`=== 结果：${pass} 通过 / ${fail} 失败 ===`)
if (fail) process.exit(1)

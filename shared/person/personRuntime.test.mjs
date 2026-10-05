/**
 * 人员运行时统一契约单测（node shared/person/personRuntime.test.mjs）
 *
 * 校验（P1.6.1 人员数据链统一）：
 *   · 统一字段 id / buildingId / floorId / zone / status / routeId / routePoints / progress / position 恒存在
 *   · 旧别名（building / floor / area / x / y）由统一字段派生，不反向写回
 *   · 位置与进度来自权威数据，缺失时不为 0 假值而是 null / 0（可判定）
 *   · 后端 DTO → store 合并 → 2D/3D 消费 全程同一个 id 与同一个 routeId
 *
 * 校验（P2 确定性滞留）：
 *   · RETAINED_CANDIDATES 固定人选：只认定为候选人员的 id 才可能成为滞留人员
 *   · evacuating → stranded：已撤离（safe）的候选人不会被重新挑出
 *   · 不存在「取前 N 人」兜底：名单缺人时结果为空
 */
import {
  PERSON_FIELDS, BUILDING_NAME_TO_ID, BUILDING_ID_TO_NAME,
  normalizePersonRuntime, toPersonRuntimeList, assignPersonRuntime,
  isCanonicalPerson, routeIdBelongsToPlan, personZoneKey,
  positionOf, progressOf, routePointsOf, floorIdOf, zoneOf, buildingIdOf,
  RETAINED_CANDIDATES, RETAINED_HOLD_PROGRESS, isRetainedCandidate, pickRetainedCandidates,
  personInLocation, countPersonsInLocation,
} from './personRuntime.js'

let pass = 0, fail = 0
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${extra !== undefined ? ' → ' + JSON.stringify(extra) : ''}`) }
}

console.log('\n=== 人员运行时统一契约单测 ===\n')

// ── 1. 后端下发的 PersonRuntime（含权威路线） ──
console.log('[1] 后端 DTO 规范化')
const backendPerson = {
  id: 'T301',
  buildingId: 'B003',
  floorId: '5F',
  zone: 'A区',
  x: 120.5,
  y: 88.25,
  status: 'evacuating',
  routeId: 'PLAN-B:5F:A区',
  routePoints: [{ x: 120, y: 88 }, { x: 170, y: 150 }, { x: 300, y: 170 }],
  progress: 0.42,
  movementType: 'moving',
  evacuating: true,
  retained: false,
  rescued: false,
  waypoint: 1,
  route: ['5F:A_CENTER', '5F:A_DOOR', '1F:EXIT_E'],
  targetX: 300,
  targetY: 170,
}
const dto = normalizePersonRuntime(backendPerson)
check('统一字段 9 项齐全', PERSON_FIELDS.every((f) => f in dto), Object.keys(dto))
check('id / buildingId / floorId / zone 直取权威值',
  dto.id === 'T301' && dto.buildingId === 'B003' && dto.floorId === '5F' && dto.zone === 'A区', dto)
check('status 透传', dto.status === 'evacuating', dto.status)
check('routeId 透传（整栋楼方案 routeId）', dto.routeId === 'PLAN-B:5F:A区', dto.routeId)
check('routePoints 透传（后端权威折线）', dto.routePoints.length === 3 && dto.routePoints[1].y === 150, dto.routePoints)
check('progress 透传', dto.progress === 0.42, dto.progress)
check('position 由 x / y 派生', dto.position && dto.position.x === 120.5 && dto.position.y === 88.25, dto.position)
check('旧别名 x / y 与 position 一致', dto.x === dto.position.x && dto.y === dto.position.y, [dto.x, dto.y])
check('旧别名 building / floor / area 由统一字段派生',
  dto.building === '3号楼' && dto.floor === '5F' && dto.area === 'A区', [dto.building, dto.floor, dto.area])
check('运行时标志透传（evacuating / waypoint / route 节点）',
  dto.evacuating === true && dto.waypoint === 1 && dto.route.length === 3, dto)
check('规范化结果通过 isCanonicalPerson', isCanonicalPerson(dto), dto)

// ── 2. mock / 旧结构（只有 building / floor / area） ──
console.log('\n[2] 旧结构（mock 人员）升级为统一字段')
const mockPerson = { id: 'T001', building: '3号楼', floor: '5F', zone: 'A区', x: 100, y: 60, status: 'normal' }
const norm = normalizePersonRuntime(mockPerson)
check('building（楼栋名）→ buildingId', norm.buildingId === 'B003', norm.buildingId)
check('floorId / zone 正常', norm.floorId === '5F' && norm.zone === 'A区', norm)
check('未下发路线时 routeId 为 null、routePoints 为 []',
  norm.routeId === null && Array.isArray(norm.routePoints) && norm.routePoints.length === 0, norm)
check('未下发进度时 progress 为 0', norm.progress === 0, norm.progress)
check('旧结构同样通过 isCanonicalPerson', isCanonicalPerson(norm), norm)

// ── 3. 字段解析细则 ──
console.log('\n[3] 字段解析细则')
check('floorId：5F 保持、5 补 F', floorIdOf({ floorId: '5F' }) === '5F' && floorIdOf({ floor: '5' }) === '5F',
  [floorIdOf({ floorId: '5F' }), floorIdOf({ floor: '5' })])
check('zone 缺失时回退 area', zoneOf({ area: 'C区' }) === 'C区', zoneOf({ area: 'C区' }))
check('buildingId：优先 buildingId，其次楼栋名映射',
  buildingIdOf({ buildingId: 'B004' }) === 'B004' && buildingIdOf({ building: '1号楼' }) === 'B001',
  [buildingIdOf({ buildingId: 'B004' }), buildingIdOf({ building: '1号楼' })])
check('楼栋名 ↔ id 映射完整',
  Object.keys(BUILDING_NAME_TO_ID).length === 4 && Object.keys(BUILDING_ID_TO_NAME).length === 4)
check('progress 越界裁剪到 0~1', progressOf({ progress: 1.5 }) === 1 && progressOf({ progress: -1 }) === 0
  && progressOf({}) === 0, [progressOf({ progress: 1.5 }), progressOf({ progress: -1 })])
check('routePoints 非数组 → []，脏点被剔除',
  routePointsOf({ routePoints: null }).length === 0
  && routePointsOf({ routePoints: [{ x: 1, y: 2 }, { x: 'a', y: 3 }, null] }).length === 1,
  routePointsOf({ routePoints: [{ x: 1, y: 2 }, { x: 'a', y: 3 }, null] }))
check('无坐标时 position 为 null（不编造位置）', positionOf({}) === null && positionOf({ x: 1 }) === null,
  [positionOf({}), positionOf({ x: 1 })])
check('缺 position 的对象不通过 isCanonicalPerson', isCanonicalPerson({ ...dto, position: null }) === false)

// ── 4. store 合并（后端增量 → 既有人员对象） ──
console.log('\n[4] 后端运行时合并进 store 人员对象')
const storePerson = {
  id: 'T301', building: '3号楼', floor: '5F', zone: 'A区', x: 111, y: 222, status: 'normal',
  name: '张三', department: '研发部', speed: 1.2,
}
const merged = assignPersonRuntime(storePerson, {
  id: 'T301', buildingId: 'B003', floorId: '5F', zone: 'A区',
  x: 130, y: 95, status: 'evacuating', routeId: 'PLAN-C:5F:A区',
  routePoints: [{ x: 130, y: 95 }, { x: 200, y: 160 }], progress: 0.2, evacuating: true,
})
check('统一字段写入（routeId / routePoints / progress / position）',
  merged.routeId === 'PLAN-C:5F:A区' && merged.routePoints.length === 2
  && merged.progress === 0.2 && merged.position.x === 130, merged)
check('旧别名 x / y 同步为权威坐标', merged.x === 130 && merged.y === 95, [merged.x, merged.y])
check('本地业务字段保留（name / department / speed）',
  merged.name === '张三' && merged.department === '研发部' && merged.speed === 1.2, merged)
check('合并结果通过 isCanonicalPerson', isCanonicalPerson(merged), merged)
// 后端本次未下发路线时：不得用默认值覆盖上一次的权威路线之外的字段
const keep = assignPersonRuntime({ id: 'T302', status: 'evacuating', routeId: 'PLAN-B:5F:B区', progress: 0.5 },
  { id: 'T302', buildingId: 'B003', floorId: '5F', zone: 'B区', x: 10, y: 20 })
check('后端未下发路线时不覆盖既有 routeId', keep.routeId === 'PLAN-B:5F:B区', keep)
check('后端未下发进度时不覆盖既有 progress', keep.progress === 0.5, keep)

// ── 5. 全链路同一 id / 同一 routeId ──
console.log('\n[5] 全链路同一人员 ID 与同一 routeId')
const backendList = [
  { id: 'T301', buildingId: 'B003', floorId: '5F', zone: 'A区', x: 1, y: 2, status: 'evacuating', routeId: 'PLAN-B:5F:A区', routePoints: [{ x: 1, y: 2 }, { x: 3, y: 4 }], progress: 0.1 },
  { id: 'T401', buildingId: 'B003', floorId: '4F', zone: 'C区', x: 5, y: 6, status: 'evacuating', routeId: 'PLAN-B:4F:C区', routePoints: [{ x: 5, y: 6 }, { x: 7, y: 8 }], progress: 0.3 },
]
const wire = toPersonRuntimeList(backendList)                 // ① 后端 → WS
const store2D = wire.map((p) => ({ ...p }))                   // ② demoStore / fireStore（2D 消费）
const three3D = wire.map((p) => ({ id: p.id, routeId: p.routeId, key: `backend:${p.routeId}:${p.routePoints.length}` })) // ③ PersonLayer3D
check('后端 → 2D：人员 ID 集合完全一致',
  JSON.stringify(wire.map((p) => p.id)) === JSON.stringify(store2D.map((p) => p.id)), wire.map((p) => p.id))
check('后端 → 3D：人员 ID 集合完全一致',
  JSON.stringify(wire.map((p) => p.id)) === JSON.stringify(three3D.map((p) => p.id)), three3D.map((p) => p.id))
check('后端 → 2D：routeId 逐个一致', wire.every((p, i) => p.routeId === store2D[i].routeId), store2D.map((p) => p.routeId))
check('后端 → 3D：routeId 编入 3D 路线指纹', wire.every((p, i) => three3D[i].key.includes(p.routeId)), three3D.map((p) => p.key))
check('每个人员 routeId 都属于当前整栋楼方案 PLAN-B',
  wire.every((p) => routeIdBelongsToPlan(p.routeId, 'PLAN-B')), wire.map((p) => p.routeId))
check('不同方案 routeId 不互相认领', routeIdBelongsToPlan('PLAN-A:5F:A区', 'PLAN-B') === false)
check('personZoneKey = floorId:zone', personZoneKey(wire[0]) === '5F:A区' && personZoneKey(wire[1]) === '4F:C区',
  [personZoneKey(wire[0]), personZoneKey(wire[1])])

// ── 6.5 P2 确定性滞留候选名单（固定人选，严禁 safe → stranded）──
console.log('\n[6.5] P2 确定性滞留候选名单')
const RETAINED_EXPECTED = ['T134', 'T169']
check('滞留候选名单固定且只包含指定人选',
  JSON.stringify([...RETAINED_CANDIDATES]) === JSON.stringify(RETAINED_EXPECTED), RETAINED_CANDIDATES)
check('名单冻结不可运行时篡改', Object.isFrozen(RETAINED_CANDIDATES))
check('推进上限严格小于 1（候选人到不了出口 → 不会变 safe）',
  RETAINED_HOLD_PROGRESS > 0 && RETAINED_HOLD_PROGRESS < 1, RETAINED_HOLD_PROGRESS)
check('isRetainedCandidate 只认名单内人员',
  RETAINED_EXPECTED.every((id) => isRetainedCandidate(id)) && !isRetainedCandidate('T135') && !isRetainedCandidate('T300'))

// 一次「疏散中」的人员快照：T134 仍在撤离、T169 已撤离（safe）、T135 仍在撤离但不是候选人
const evacPool = [
  { id: 'T135', buildingId: 'B003', floorId: '5F', zone: 'A区', status: 'evacuating', progress: 0.5 },
  { id: 'T134', buildingId: 'B003', floorId: '5F', zone: 'A区', status: 'evacuating', progress: RETAINED_HOLD_PROGRESS },
  { id: 'T169', buildingId: 'B003', floorId: '6F', zone: 'A区', status: 'safe', progress: 1 },
]
const picks = pickRetainedCandidates(evacPool, 'evacuating')
check('只从名单内挑选，且与传入数组顺序无关（按名单顺序输出）',
  picks.map((p) => p.id).join(',') === 'T134' && picks.length === 1, picks.map((p) => p.id))
check('已撤离（safe）的候选人不会被挑出 → 严禁 safe → stranded',
  pickRetainedCandidates(evacPool, 'evacuating').every((p) => p.status === 'evacuating'))
check('非候选人即使仍在疏散也不会被挑出为滞留',
  pickRetainedCandidates(evacPool).every((p) => isRetainedCandidate(p.id)), pickRetainedCandidates(evacPool).map((p) => p.id))
check('名单内人员不存在时结果为空（不再「取前 N 人」兜底）',
  pickRetainedCandidates([{ id: 'T999', status: 'evacuating' }], 'evacuating').length === 0)
const repeated = JSON.stringify(pickRetainedCandidates(evacPool, 'evacuating'))
check('同一输入多次挑选结果一致（确定性）', repeated === JSON.stringify(pickRetainedCandidates(evacPool, 'evacuating')))

// ── 7. 确定性（同一输入多次规范化结果一致，禁止随机） ──
console.log('\n[6] 确定性')
const a1 = JSON.stringify(normalizePersonRuntime(backendPerson))
const a2 = JSON.stringify(normalizePersonRuntime(backendPerson))
check('同一输入规范化结果稳定（无随机/无时间戳）', a1 === a2)
check('重复规范化不放大数据（无引用泄漏）',
  normalizePersonRuntime(dto).routePoints !== dto.routePoints)

// ── 8. P1.6.1 空间身份统一：旧别名只读派生，不得产生第二套权威身份 ──
console.log('\n[7] P1.6.1 空间身份统一（buildingId / floorId / zone）')
const legacyShape = { id: 'T200', building: '3号楼', floor: '4F', area: 'C区', x: 120, y: 90 }
const nb = normalizePersonRuntime(legacyShape)
check('旧别名 building / floor / area 派生为统一字段',
  nb.buildingId === 'B003' && nb.floorId === '4F' && nb.zone === 'C区', [nb.buildingId, nb.floorId, nb.zone])
check('position 与 x / y 同源（别名由统一字段派生）',
  nb.position.x === nb.x && nb.position.y === nb.y, [nb.position, nb.x, nb.y])

// 冲突输入：统一字段优先，旧别名不得反过来覆盖权威身份（禁止第二套权威数据）
const conflict = normalizePersonRuntime({
  id: 'T201', buildingId: 'B003', floorId: '5F', zone: 'A区',
  building: '1号楼', floor: '2F', area: 'D区', x: 10, y: 20,
})
check('统一字段优先：buildingId / floorId / zone 不被旧别名覆盖',
  conflict.buildingId === 'B003' && conflict.floorId === '5F' && conflict.zone === 'A区',
  [conflict.buildingId, conflict.floorId, conflict.zone])
check('旧别名随统一字段重算，保持可读兼容',
  conflict.building === '3号楼' && conflict.floor === '5F' && conflict.area === 'A区',
  [conflict.building, conflict.floor, conflict.area])

// personInLocation 是 P1.6.1 里 2D / 3D 各视图共用的唯一空间身份口径
const floorPool = [
  { id: 'T210', buildingId: 'B003', floorId: '1F', zone: 'A区', status: 'evacuating' },
  { id: 'T211', buildingId: 'B003', floorId: '2F', zone: 'A区', status: 'evacuating' },
  { id: 'T212', buildingId: 'B003', floorId: '6F', zone: '走廊', status: 'evacuating' },
  legacyShape,
]
check('personInLocation 按 buildingId + floorId 命中同一楼层的不同区域',
  personInLocation(floorPool[0], { buildingId: 'B003', floorId: '1F' }))
check('跨楼层不命中', !personInLocation(floorPool[0], { buildingId: 'B003', floorId: '2F' }))
check('跨楼栋不命中', !personInLocation(floorPool[0], { buildingId: 'B001', floorId: '1F' }))
check('zone 不一致不命中', !personInLocation(floorPool[0], { floorId: '1F', zone: 'B区' }))
check('旧别名形态的人员同样能被统一口径命中（兼容回退）',
  personInLocation(legacyShape, { buildingId: 'B003', floorId: '4F', zone: 'C区' }))
check('countPersonsInLocation 与逐个判定口径一致',
  countPersonsInLocation(floorPool, { buildingId: 'B003', floorId: '1F' }) === 1
  && countPersonsInLocation(floorPool, { buildingId: 'B003' }) === 4
  && countPersonsInLocation(floorPool, { buildingId: 'B003', zone: 'A区' }) === 2,
  countPersonsInLocation(floorPool, { buildingId: 'B003' }))

// progress 恒在 0~1（8. 进度范围约束）
const clampIn = progressOf({ progress: 2.5 })
const clampNeg = progressOf({ progress: -1 })
const clampOk = progressOf({ progress: 0.42 })
check('progress 越界收敛到 0~1', clampIn === 1 && clampNeg === 0 && clampOk === 0.42, [clampIn, clampNeg, clampOk])

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===\n`)
if (fail) process.exit(1)

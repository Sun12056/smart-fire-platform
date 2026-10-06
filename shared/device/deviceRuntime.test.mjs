/**
 * 设备运行时统一契约单测（node shared/device/deviceRuntime.test.mjs）
 *
 * 校验（P1.6.2 设备数据链统一）：
 *   · 统一字段 id / type / buildingId / floorId / zone / status / currentMode / direction / brightness / emergencyFlash 恒存在
 *   · buildingId / floorId / zone 来自 D1 devices（唯一权威），WS 快照可凭 (buildingId, floorId) 准确定位楼层
 *   · 从不当 floorId 缺失时编造楼层；旧别名 building / floor / area 由统一字段派生
 *   · 后端 DTO → store 合并 → 2D/3D 全程同一个设备 id 与同一个楼层归属
 *   · 楼层分组 / 筛选能力（整栋楼设备联动的楼层定位依据）
 */
import {
  DEVICE_FIELDS, LINKAGE_DEVICE_TYPES,
  normalizeDeviceRuntime, toDeviceRuntimeList, assignDeviceRuntime,
  isCanonicalDevice, deviceZoneKey, deviceFloorIndex,
  deviceInBuilding, deviceOnFloor, devicesInBuilding, devicesOnFloor,
  groupDevicesByFloor, floorsOfDevices, zoneFromRow,
} from './deviceRuntime.js'

let pass = 0, fail = 0
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${extra !== undefined ? ' → ' + JSON.stringify(extra) : ''}`) }
}

console.log('\n=== 设备运行时统一契约单测 ===\n')

// ── 1. 后端 DeviceRuntime（含楼层归属三元组） ──
console.log('[1] 后端 DeviceRuntime → 统一契约')
const backendDevice = {
  id: 'B003-EL-5F-01',
  type: 'evacuation_light',
  buildingId: 'B003',
  floorId: '5F',
  zone: '走廊',
  status: 'emergency',
  currentMode: 'emergency',
  direction: 'left',
  brightness: 100,
  emergencyFlash: true,
}
const dto = normalizeDeviceRuntime(backendDevice)
check('统一字段 10 项齐全', DEVICE_FIELDS.every((f) => f in dto), Object.keys(dto))
check('id / type 透传', dto.id === 'B003-EL-5F-01' && dto.type === 'evacuation_light', [dto.id, dto.type])
check('楼层归属三元组透传（buildingId / floorId / zone）',
  dto.buildingId === 'B003' && dto.floorId === '5F' && dto.zone === '走廊', [dto.buildingId, dto.floorId, dto.zone])
check('运行时状态透传（status / currentMode / direction / brightness / emergencyFlash）',
  dto.status === 'emergency' && dto.currentMode === 'emergency' && dto.direction === 'left'
  && dto.brightness === 100 && dto.emergencyFlash === true, dto)
check('旧别名 building / floor / area 由统一字段派生',
  dto.building === '3号楼' && dto.floor === '5F' && dto.area === '走廊', [dto.building, dto.floor, dto.area])

// ── 2. D1 行（snake_case）→ 统一契约 ──
console.log('\n[2] D1 devices 行 → 统一契约')
const row = {
  id: 'B003-SD-5F-09', type: 'smoke_detector', building_id: 'B003', floor_id: '5F', zone: 'A区',
  status: 'warning', current_mode: 'daily', direction: 'right', brightness: 60, emergency_flash: 0,
}
const fromRow = normalizeDeviceRuntime({
  id: row.id, type: row.type, buildingId: row.building_id, floorId: row.floor_id, zone: row.zone,
  status: row.status, currentMode: row.current_mode, direction: row.direction,
  brightness: row.brightness, emergencyFlash: Number(row.emergency_flash) === 1,
})
check('D1 行 → buildingId / floorId / zone', fromRow.buildingId === 'B003' && fromRow.floorId === '5F' && fromRow.zone === 'A区', fromRow)
check('D1 行 → emergency_flash 转布尔', fromRow.emergencyFlash === false, fromRow.emergencyFlash)
check('zoneFromRow 取 zone 列（D1 列名即 area 语义）', zoneFromRow(row) === 'A区', zoneFromRow(row))
check('烟感属于联动设备类型', LINKAGE_DEVICE_TYPES.includes(fromRow.type), fromRow.type)

// ── 3. 缺省值与边界（禁止编造楼层/亮度） ──
console.log('\n[3] 缺省值 / 边界')
const empty = normalizeDeviceRuntime({ id: 'X-1', type: 'emergency_light' })
check('设备缺楼层归属时不编造（buildingId / floorId / zone 为空串）',
  empty.buildingId === '' && empty.floorId === '' && empty.zone === '', empty)
check('缺省 status / currentMode / direction 由契约给定',
  empty.status === 'normal' && empty.currentMode === 'daily' && empty.direction === 'right', empty)
check('缺省 brightness = 60，emergencyFlash = false',
  empty.brightness === 60 && empty.emergencyFlash === false, empty)
check('楼层别名在缺 floorId 时不产出 floor', empty.floor === undefined, empty.floor)
const clamped = normalizeDeviceRuntime({ id: 'X-2', brightness: 320 })
check('亮度裁剪到 0~100', clamped.brightness === 100, clamped.brightness)
const legacy = normalizeDeviceRuntime({ id: 'X-3', building: '3号楼', floor: 5, area: 'B区' })
check('旧中文楼栋名 → buildingId 归一', legacy.buildingId === 'B003', legacy.buildingId)
check('数字楼层 → floorId（5 → 5F）', legacy.floorId === '5F', legacy.floorId)
check('area → zone 归一', legacy.zone === 'B区', legacy.zone)

// ── 4. 楼层定位（WS 快照 → 楼层） ──
console.log('\n[4] 楼层定位（WS 快照准确定位到楼层）')
// 模拟 B003 整栋楼快照：6 层 × (5 疏散指示灯 + 5 应急照明 + 4 烟感 + 2 雷达)
const snapshot = []
const FLOORS = ['1F', '2F', '3F', '4F', '5F', '6F']
FLOORS.forEach((fid, fi) => {
  for (let i = 1; i <= 5; i++) {
    snapshot.push({ id: `B003-EL-${fid}-${String(i).padStart(2, '0')}`, type: 'evacuation_light', buildingId: 'B003', floorId: fid, zone: '走廊', status: 'emergency', currentMode: 'emergency', direction: fid === '5F' ? 'left' : 'right', brightness: 100, emergencyFlash: true })
    snapshot.push({ id: `B003-EM-${fid}-${String(i).padStart(2, '0')}`, type: 'emergency_light', buildingId: 'B003', floorId: fid, zone: '走廊', status: 'emergency', currentMode: 'emergency', direction: 'right', brightness: 100, emergencyFlash: true })
  }
  ;['A区', 'B区', 'C区', 'D区'].forEach((z, zi) => {
    snapshot.push({ id: `B003-SD-${fid}-${String(zi + 1).padStart(2, '0')}`, type: 'smoke_detector', buildingId: 'B003', floorId: fid, zone: z, status: fi === 4 ? 'warning' : 'normal', currentMode: 'daily', direction: 'right', brightness: 60, emergencyFlash: false })
  })
  snapshot.push({ id: `B003-RD-${fid}-01`, type: 'radar_sensor', buildingId: 'B003', floorId: fid, zone: '走廊', status: 'normal', currentMode: 'daily', direction: 'right', brightness: 60, emergencyFlash: false })
})
const list = toDeviceRuntimeList(snapshot)
check('快照设备全部符合统一契约', list.every(isCanonicalDevice), list.filter((d) => !isCanonicalDevice(d)).slice(0, 2))
const grouped = groupDevicesByFloor(list, 'B003')
check('按楼层分组覆盖 6 层', grouped.size === 6, [...grouped.keys()])
check('楼层分组顺序为 1F → 6F 升序', floorsOfDevices(list, 'B003').join(',') === '1F,2F,3F,4F,5F,6F', floorsOfDevices(list, 'B003'))
check('每层设备数一致（整栋楼联动覆盖所有楼层）',
  [...grouped.values()].every((arr) => arr.length === grouped.get('5F').length), [...grouped].map(([f, a]) => [f, a.length]))
check('5F 设备可精确定位（只含 5F 设备）',
  devicesOnFloor(list, 'B003', '5F').every((d) => d.floorId === '5F') && devicesOnFloor(list, 'B003', '5F').length === 15,
  devicesOnFloor(list, 'B003', '5F').length)
check('6F 与 5F 不串层', devicesOnFloor(list, 'B003', '6F').every((d) => !devicesOnFloor(list, 'B003', '5F').includes(d)))
check('其他楼栋不串入 B003', devicesInBuilding(list, 'B001').length === 0, devicesInBuilding(list, 'B001').length)
check('deviceOnFloor 支持 buildingId 限定',
  deviceOnFloor(list[0], '1F', 'B003') === true && deviceOnFloor(list[0], '1F', 'B001') === false)
check('deviceInBuilding 同时支持 buildingId 与中文楼栋名',
  deviceInBuilding(list[0], 'B003') === true && deviceInBuilding(list[0], '3号楼') === true && deviceInBuilding(list[0], 'B001') === false)
check('楼层入参 `5` 归一为 `5F` 后仍能命中', deviceOnFloor(list[0], '1', 'B003') === true, deviceOnFloor(list[0], '1', 'B003'))
check('deviceFloorIndex 解析楼层高度', deviceFloorIndex({ floorId: '5F' }) === 5, deviceFloorIndex({ floorId: '5F' }))
check('非法楼层返回 null 而非猜测值', deviceFloorIndex({ floorId: '地下' }) === null, deviceFloorIndex({ floorId: '地下' }))
check('deviceZoneKey = `${floorId}:${zone}`', deviceZoneKey({ floorId: '5F', zone: 'A区' }) === '5F:A区', deviceZoneKey({ floorId: '5F', zone: 'A区' }))

// ── 5. store 合并（后端 DTO → 既有台账） ──
console.log('\n[5] 后端快照 → store 设备合并')
const storeDevice = {
  id: 'B003-EL-5F-01', planId: 'EL-5F-01', name: '3号楼5F走廊疏散指示灯', type: 'evacuation_light',
  building: '3号楼', buildingId: 'B003', floor: '5F', floorId: '5F', area: '走廊',
  x: 72, y: 162, status: 'normal', direction: 'right', recommendedDirection: 'right',
  brightness: 60, currentMode: 'daily', battery: 88, controllable: true, emergencyFlash: false,
}
const merged = assignDeviceRuntime({ ...storeDevice }, dto)
check('按 id 合并：设备 id 不变', merged.id === 'B003-EL-5F-01', merged.id)
check('楼层归属与后端一致', merged.buildingId === 'B003' && merged.floorId === '5F' && merged.zone === '走廊', merged)
check('运行状态取后端权威值', merged.status === 'emergency' && merged.currentMode === 'emergency' && merged.brightness === 100, merged)
check('方向联动写入 direction 与 recommendedDirection',
  merged.direction === 'left' && merged.recommendedDirection === 'left', [merged.direction, merged.recommendedDirection])
check('强闪标志写入', merged.emergencyFlash === true, merged.emergencyFlash)
check('本地台账字段不丢失（x / y / battery / name）',
  merged.x === 72 && merged.y === 162 && merged.battery === 88 && merged.name.includes('疏散指示灯'), merged)
check('旧别名同步为统一字段值', merged.floor === merged.floorId && merged.area === merged.zone, merged)
const noPush = assignDeviceRuntime({ ...storeDevice }, { id: 'B003-EL-5F-01', status: 'offline' })
check('后端未下发的字段保留本地值（不被默认值覆盖）',
  noPush.brightness === 60 && noPush.currentMode === 'daily' && noPush.direction === 'right', noPush)
const legacyStore = assignDeviceRuntime({ id: 'B003-EM-2F-02', type: 'emergency_light', building: '3号楼', floor: '2F' }, { id: 'B003-EM-2F-02', status: 'emergency' })
check('旧格式台账缺 buildingId/floorId 时由别名补齐',
  legacyStore.buildingId === 'B003' && legacyStore.floorId === '2F', legacyStore)

// ── 6. 整栋楼联动的楼层覆盖判定 ──
console.log('\n[6] 整栋楼设备联动（楼层覆盖校验）')
const emergency = list.filter((d) => d.currentMode === 'emergency')
const covered = floorsOfDevices(emergency, 'B003')
check('应急联动设备覆盖全部 6 层（不是只联动火警楼层）',
  covered.length === 6, covered)
check('每层都有应急照明/疏散指示灯联动',
  covered.every((fid) => devicesOnFloor(emergency, 'B003', fid).some((d) => d.type === 'evacuation_light')
    && devicesOnFloor(emergency, 'B003', fid).some((d) => d.type === 'emergency_light')), covered)
check('火警楼层 5F 烟感为 warning，其余楼层仍为 normal',
  devicesOnFloor(list, 'B003', '5F').filter((d) => d.type === 'smoke_detector').every((d) => d.status === 'warning')
  && devicesOnFloor(list, 'B003', '1F').filter((d) => d.type === 'smoke_detector').every((d) => d.status === 'normal'))

// ── 7. P1.7.3-B3：canonical 与旧别名冲突时以 canonical 为准 ──
console.log('\n[7] B3 canonical 优先（设备归属）')
const devConflict = {
  id: 'B003-EL-5F-01',
  type: 'evacuation_light',
  buildingId: 'B003', building: '2号楼',
  floorId: '5F', floor: '4F',
  zone: 'A区', area: 'D区',
  status: 'emergency', currentMode: 'emergency', direction: 'left', brightness: 100, emergencyFlash: false,
}
const devNorm = normalizeDeviceRuntime(devConflict)
check('设备 canonical 优先：buildingId=B003 / floorId=5F / zone=A区',
  devNorm.buildingId === 'B003' && devNorm.floorId === '5F' && devNorm.zone === 'A区',
  [devNorm.buildingId, devNorm.floorId, devNorm.zone])
check('设备别名随 canonical 重算（building=3号楼 / floor=5F / area=A区）',
  devNorm.building === '3号楼' && devNorm.floor === '5F' && devNorm.area === 'A区',
  [devNorm.building, devNorm.floor, devNorm.area])
check('deviceInBuilding：canonical 命中，别名口径（B002）不命中',
  deviceInBuilding(devNorm, 'B003') && !deviceInBuilding(devNorm, 'B002'))
check('deviceInBuilding：按中文名入参反查 canonical（3号楼命中 / 2号楼不命中）',
  deviceInBuilding(devNorm, '3号楼') && !deviceInBuilding(devNorm, '2号楼'))
check('deviceOnFloor：只看 canonical floorId（5F 命中 / 别名 4F 不命中）',
  deviceOnFloor(devNorm, '5F', 'B003') && !deviceOnFloor(devNorm, '4F', 'B003'))
check('deviceZoneKey：按 canonical 生成（5F:A区，不是 4F:D区）',
  deviceZoneKey(devNorm) === '5F:A区', deviceZoneKey(devNorm))
check('未知楼栋不得静默归当前楼栋（B099 / 9号楼 均不命中）',
  !deviceInBuilding(devNorm, 'B099') && !deviceInBuilding(devNorm, '9号楼'))

// ── 8. B3-03：deviceInBuilding 的 canonical-first 语义（与 personInLocation 对称）──
console.log('\n[8] B3-03 deviceInBuilding canonical-first（禁止别名反向覆盖）')
const devAlias = { id: 'X-1', type: 'smoke_detector', building: '2号楼', floor: '4F', area: 'D区', status: 'normal' }
const devNoId = normalizeDeviceRuntime(devAlias)
check('canonical 缺失时才允许别名兜底（无 buildingId 设备按 2号楼 命中）',
  deviceInBuilding(devNoId, '2号楼') === true && deviceInBuilding(devNoId, 'B002') === true)
check('canonical 存在时别名入参不得反向命中（B003 设备不认 2号楼 / B002）',
  deviceInBuilding(devNorm, '2号楼') === false && deviceInBuilding(devNorm, 'B002') === false)
check('canonical 存在时中文名只认 canonical 反查得到的那一栋（3号楼命中）',
  deviceInBuilding(devNorm, '3号楼') === true && deviceInBuilding(devNorm, 'B003') === true)
check('devicesInBuilding / devicesOnFloor 继承同一口径（冲突设备不进 B002 分组）',
  devicesInBuilding([devNorm, devNoId], 'B002').every((d) => d.id !== devNorm.id)
  && devicesInBuilding([devNorm, devNoId], 'B003').some((d) => d.id === devNorm.id))
check('空 / 非法入参一律 false（不静默归当前楼栋）',
  deviceInBuilding(devNorm, '') === false && deviceInBuilding(null, 'B003') === false)

// ── 9. B3-03：riskArea / 新建对象的 canonical 完整性（对称 personRuntime 口径）──
console.log('\n[9] B3-03 对称回归：规范化后 canonical 三元组齐备')
;[devNorm, devNoId].forEach((d, i) => {
  const tag = i === 0 ? '冲突设备' : '别名设备'
  check(`${tag}：normalize 后 buildingId / floorId / zone 齐全`,
    Boolean(d.buildingId) && Boolean(d.floorId) && d.zone !== undefined && d.zone !== null, d)
  check(`${tag}：别名 area 由 canonical zone 派生（不是第二套区域口径）`,
    d.area === d.zone, [d.zone, d.area])
})

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===\n`)
process.exit(fail ? 1 : 0)

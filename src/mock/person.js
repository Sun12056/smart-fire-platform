/**
 * 人员感知 Mock 数据
 * 纯本地模拟，不接真实接口
 *
 * 层级模型：Building → Floor → Area(Zone) → Person
 * 人员坐标基于真实楼层几何分布（房间内部 / 走廊通道），
 * zone 名与 floorPlanData 房间区域名完全一致（A区/B区/C区/D区/走廊），
 * 保证火灾联动(triggerFireScenario 按 zone 标红)、雷达感知匹配、热力图统计全部打通。
 * 固定种子伪随机，每次初始化数据一致。
 */

import { devices } from './devices'
// P1.6.3 C5：人员种子必须自带 canonical 身份字段（buildingId / floorId），
// 取值与全链路同口径（shared 契约），旧别名 building / floor 只作只读兼容，不再充当权威来源
import { buildingIdOf, floorIdOf } from '../../shared/person/personRuntime.js'

// 楼层房间几何（与 floorPlanData.js 完全一致；只读共享，勿改）
// A区 大厅/办公 (90,28,105,122) | B区 (90,210,105,70)
// C区 (375,28,80,122)          | D区 (375,210,80,70)
// 走廊带 y150~190（中心线 y170）
const ZONE_RECT = {
  'A区': { x: 90, y: 28, w: 105, h: 122 },
  'B区': { x: 90, y: 210, w: 105, h: 70 },
  'C区': { x: 375, y: 28, w: 80, h: 122 },
  'D区': { x: 375, y: 210, w: 80, h: 70 },
}

// 各楼栋楼层人数（4 栋均 6 层；3号楼5F=35 人为火灾演示高密度层）
const FLOOR_PERSON_COUNT = {
  '1号楼-1F': 6, '1号楼-2F': 9, '1号楼-3F': 8, '1号楼-4F': 7, '1号楼-5F': 5, '1号楼-6F': 6,
  '2号楼-1F': 7, '2号楼-2F': 10, '2号楼-3F': 6, '2号楼-4F': 9, '2号楼-5F': 7, '2号楼-6F': 8,
  '3号楼-1F': 8, '3号楼-2F': 11, '3号楼-3F': 14, '3号楼-4F': 12, '3号楼-5F': 35, '3号楼-6F': 9,
  '4号楼-1F': 5, '4号楼-2F': 8, '4号楼-3F': 7, '4号楼-4F': 10, '4号楼-5F': 6, '4号楼-6F': 7,
}

// 区域人数权重（按房间用途 + 面积综合）
const ZONE_WEIGHTS = [
  { zone: 'A区', w: 0.34 },
  { zone: 'B区', w: 0.24 },
  { zone: 'C区', w: 0.20 },
  { zone: 'D区', w: 0.14 },
  { zone: '走廊', w: 0.08 },
]

let _pSeed = 20260905
function _prand() {
  _pSeed = (_pSeed * 9301 + 49297) % 233280
  return _pSeed / 233280
}
function _pInt(min, max) {
  return Math.floor(_prand() * (max - min + 1)) + min
}

// 房间内撒点（离墙 3~5px，避免贴墙）
function pointInRoom(zone) {
  const r = ZONE_RECT[zone]
  if (!r) return { x: 280, y: 170 }
  const m = 5
  return {
    x: Math.round(r.x + m + _prand() * (r.w - m * 2)),
    y: Math.round(r.y + m + _prand() * (r.h - m * 2)),
  }
}
// 走廊人员：沿中心线 ±6px 行走
function pointInCorridor() {
  return {
    x: Math.round(46 + _prand() * 468),
    y: Math.round(164 + _prand() * 12),
  }
}
function samplePoint(zone) {
  return zone === '走廊' ? pointInCorridor() : pointInRoom(zone)
}

// ==================== 生成人员 ====================
let idCounter = 1
const persons = []

Object.entries(FLOOR_PERSON_COUNT).forEach(([key, totalCount]) => {
  const [building, floor] = key.split('-')
  // 按权重分配各区域人数（整数分配，余数给 A区）
  const zoneCounts = {}
  let remaining = totalCount
  ZONE_WEIGHTS.forEach(({ zone, w }, idx) => {
    if (idx === ZONE_WEIGHTS.length - 1) {
      zoneCounts[zone] = remaining
    } else {
      const c = Math.min(Math.round(totalCount * w), remaining)
      zoneCounts[zone] = c
      remaining -= c
    }
  })

  Object.entries(zoneCounts).forEach(([zone, count]) => {
    for (let i = 0; i < count; i++) {
      const isStatic = _prand() > 0.7
      const movementType = isStatic ? 'static' : 'moving'
      const pos = samplePoint(zone)
      persons.push({
        id: `T${String(idCounter++).padStart(3, '0')}`,
        // canonical 身份三元组（权威）：由同一份 shared 契约解析，与 REST / WS / Store 完全同口径
        buildingId: buildingIdOf({ building }),
        floorId: floorIdOf({ floorId: floor }),
        zone, // zone = 平面图房间区域名（A区/B区/C区/D区/走廊）
        building,
        floor,
        x: pos.x,
        y: pos.y,
        status: isStatic ? 'static' : 'normal',
        speed: isStatic ? 0 : +(0.5 + _prand() * 2.5).toFixed(2),
        direction: isStatic ? 0 : Math.floor(_prand() * 360),
        distance: +(1 + _prand() * 8).toFixed(1),
        detectedAt: new Date(Date.now() - Math.floor(_prand() * 3600000)).toLocaleString('zh-CN'),
        movementType,
      })
    }
  })
})

// ==================== 人员统计（派生自 persons） ====================
const personStats = {
  totalPersons: persons.length,
  activeTargets: persons.filter((p) => p.movementType === 'moving').length,
  staticTargets: persons.filter((p) => p.movementType === 'static').length,
  riskZones: 0,
  sensorDevices: devices.filter((d) => d.type === 'radar_sensor').length,
  buildingDistribution: {
    '1号楼': persons.filter((p) => p.building === '1号楼').length,
    '2号楼': persons.filter((p) => p.building === '2号楼').length,
    '3号楼': persons.filter((p) => p.building === '3号楼').length,
    '4号楼': persons.filter((p) => p.building === '4号楼').length,
  },
  // 按楼层分布（取人数 TOP 6 楼层）
  floorDistribution: Object.fromEntries(
    [...persons.reduce((acc, p) => {
      const k = `${p.building}-${p.floor}`
      acc.set(k, (acc.get(k) || 0) + 1)
      return acc
    }, new Map()).entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
  ),
  statusDistribution: {
    normal: persons.filter((p) => p.status === 'normal').length,
    warning: persons.filter((p) => p.status === 'warning').length,
    static: persons.filter((p) => p.movementType === 'static').length,
  },
}

// ==================== 24小时趋势 ====================
const personTrend = {
  hours: ['00:00', '02:00', '04:00', '06:00', '08:00', '10:00', '12:00', '14:00', '16:00', '18:00', '20:00', '22:00', '24:00'],
  values: (() => {
    const total = persons.length
    return [3, 2, 1, 2, Math.round(total * 0.18), Math.round(total * 0.42), Math.round(total * 0.58),
            Math.round(total * 0.72), Math.round(total * 0.85), Math.round(total * 0.52),
            Math.round(total * 0.28), Math.round(total * 0.14), 5].map(v => Math.max(1, v))
  })(),
}

// ==================== 区域热力图（雷达视角聚合） ====================
const radarNodes = devices.filter((d) => d.type === 'radar_sensor')
const zoneHeatmap = []
radarNodes.forEach((node) => {
  const zonePersons = persons.filter(
    (p) => p.building === node.building && p.floor === node.floor && p.zone === node.area
  )
  const count = zonePersons.length
  let riskLevel = 'low'
  if (count >= 5) riskLevel = 'high'
  else if (count >= 2) riskLevel = 'medium'
  zoneHeatmap.push({
    name: `${node.building}-${node.floor}-${node.area}`,
    building: node.building,
    floor: node.floor,
    zone: node.area,
    density: count * 25,
    personCount: count,
    riskLevel,
    sourceDeviceId: node.id,
  })
})

export { persons, personStats, personTrend, zoneHeatmap }

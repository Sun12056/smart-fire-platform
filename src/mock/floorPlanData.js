/**
 * 建筑空间模型 —— 6 层楼消防平面图真实空间数据
 *
 * 核心原则：设备坐标来自建筑结构（走廊中心线/门口/楼梯/出口），不随机。
 * 每层楼有不同的房间布局、设备数量、设备位置。
 * 路线规划系统与此共享同一套坐标。
 *
 * SVG viewBox: 560 × 300
 * 建筑外框: x 40~520, y 20~300
 * 走廊带: y 150~190, 中心线 y=170
 *
 * P1.8.1 边界：本文件只负责 2D 渲染几何（房间/门/走廊/楼梯/出口的画法与设备布点）。
 *   疏散拓扑（节点/边/墙体/楼梯可用状态/出口实体）唯一定义在
 *   shared/evacuation/floorTopology.js —— 本文件不再构建第二张图。
 */
import { activePlanStairIdsForFloor } from '../../shared/evacuation/floorTopology.js'

export const SVG_W = 560
export const SVG_H = 300

// ══════════════════════════════════════
// 墙体（不可通行实体）
// ══════════════════════════════════════
export const WALLS = [
  // 房间实体（用于路线合法性校验：路线不得穿过房间内部）
  { x: 90, y: 28, w: 105, h: 120, type: 'room' },   // A区
  { x: 90, y: 210, w: 105, h: 70, type: 'room' },    // B区
  { x: 375, y: 28, w: 80, h: 120, type: 'room' },   // C区
  { x: 375, y: 210, w: 80, h: 70, type: 'room' },   // D区
  // 内部隔墙（用于可视化与校验）
  { x: 195, y: 20, w: 6, h: 130, type: 'inner' },   // A/C 左墙
  { x: 355, y: 20, w: 6, h: 130, type: 'inner' },   // A/C 右墙
  { x: 195, y: 190, w: 6, h: 110, type: 'inner' },  // B/D 左墙
  { x: 355, y: 190, w: 6, h: 110, type: 'inner' },  // B/D 右墙
]

// ══════════════════════════════════════
// 房间（建筑空间）
// ══════════════════════════════════════
const ROOM_DEFS = [
  { id: 'A', name: 'A区', x: 90, y: 28, w: 105, h: 122, label: '办公区', doorX: 140, doorSide: 'top' },
  { id: 'B', name: 'B区', x: 90, y: 210, w: 105, h: 70, label: '会议室', doorX: 140, doorSide: 'bottom' },
  { id: 'C', name: 'C区', x: 375, y: 28, w: 80, h: 122, label: '设备间', doorX: 415, doorSide: 'top' },
  { id: 'D', name: 'D区', x: 375, y: 210, w: 80, h: 70, label: '储藏室', doorX: 415, doorSide: 'bottom' },
]

// ══════════════════════════════════════
// 走廊（疏散通道）
// ══════════════════════════════════════
export const CORRIDOR = {
  x: 40, y: 150, w: 480, h: 40,
  centerX: 280, centerY: 170,
  // 走廊节点链（沿中心线 y=170）
  nodes: [45, 72, 140, 205, 280, 355, 415, 477, 510],
}

// ══════════════════════════════════════
// 楼梯（跨楼层连接）
// ══════════════════════════════════════
export const STAIRS = [
  { id: 'S-A', name: '楼梯1', x: 50, y: 28, w: 45, h: 35, corridorX: 72, corridorY: 170, side: 'left-top' },
  { id: 'S-B', name: '楼梯2', x: 455, y: 28, w: 45, h: 35, corridorX: 477, corridorY: 170, side: 'right-top' },
  { id: 'S-C', name: '楼梯3', x: 50, y: 255, w: 45, h: 35, corridorX: 72, corridorY: 170, side: 'left-bottom' },
  { id: 'S-D', name: '楼梯4', x: 455, y: 255, w: 45, h: 35, corridorX: 477, corridorY: 170, side: 'right-bottom' },
]

// ══════════════════════════════════════
// 安全出口（仅 1F 有效，其他楼层为楼梯出口标识）
// ══════════════════════════════════════
export const EXITS = [
  { id: '出口A', name: '安全出口', x: 528, y: 170, side: 'right', label: '安全出口', w: 46, h: 20 },
  { id: '出口B', name: '安全出口', x: 32, y: 170, side: 'left', label: '安全出口', w: 46, h: 20 },
]

// ══════════════════════════════════════
// 门（房间 ↔ 走廊 连接点）
// ══════════════════════════════════════
export const DOORS = ROOM_DEFS.map(r => ({
  id: `door-${r.id}`,
  zone: r.name,
  x: r.doorX,
  y: r.doorSide === 'top' ? 150 : 190,  // 门在走廊边缘
  roomSide: { x: r.doorX, y: r.doorSide === 'top' ? 148 : 212 },
  corridorSide: { x: r.doorX, y: 170 },
}))

// ══════════════════════════════════════
// 每层楼差异化定义
// ══════════════════════════════════════
// 每层房间用途/标签不同，设备数量不同
// P1.8.1：楼梯「逐层可用 / 检修停用」状态已收编为唯一数据源 ——
//   shared/evacuation/floorTopology.js 的 STAIR_ACTIVE_FLOORS（算法权威）。
//   本文件不再各自维护 stairsActive，2D 渲染经 activeStairsForFloor() 反向取同一份状态。
export const FLOOR_CONFIG = {
  '1F': {
    rooms: [
      { id: 'A', name: 'A区', label: '大厅' },
      { id: 'B', name: 'B区', label: '接待室' },
      { id: 'C', name: 'C区', label: '安保室' },
      { id: 'D', name: 'D区', label: '储物间' },
    ],
    deviceCount: 12,
    note: '底层大厅，设备最密集',
  },
  '2F': {
    rooms: [
      { id: 'A', name: 'A区', label: '办公区' },
      { id: 'B', name: 'B区', label: '会议室' },
      { id: 'C', name: 'C区', label: '设备间' },
      { id: 'D', name: 'D区', label: '储藏室' },
    ],
    deviceCount: 10,
    note: '标准办公层',
  },
  '3F': {
    rooms: [
      { id: 'A', name: 'A区', label: '实验室' },
      { id: 'B', name: 'B区', label: '准备间' },
      { id: 'C', name: 'C区', label: '仪器室' },
      { id: 'D', name: 'D区', label: '仓库' },
    ],
    deviceCount: 14,
    // 楼梯4(S-D) 检修停用 → 3F 人群只能走楼梯1/2/3（状态见 floorTopology.STAIR_ACTIVE_FLOORS）
    note: '实验层，设备多',
  },
  '4F': {
    rooms: [
      { id: 'A', name: 'A区', label: '研发区' },
      { id: 'B', name: 'B区', label: '讨论室' },
      { id: 'C', name: 'C区', label: '服务器房' },
      { id: 'D', name: 'D区', label: '杂物间' },
    ],
    deviceCount: 11,
    // 楼梯3(S-C) 检修停用（状态见 floorTopology.STAIR_ACTIVE_FLOORS）
    note: '研发层',
  },
  '5F': {
    rooms: [
      { id: 'A', name: 'A区', label: '实验区(火灾演示)' },
      { id: 'B', name: 'B区', label: '休息室' },
      { id: 'C', name: 'C区', label: '配电室' },
      { id: 'D', name: 'D区', label: '走廊储物' },
    ],
    deviceCount: 13,
    note: '火灾演示层',
  },
  '6F': {
    rooms: [
      { id: 'A', name: 'A区', label: '顶层办公' },
      { id: 'B', name: 'B区', label: '档案室' },
      { id: 'C', name: 'C区', label: '通风机房' },
      { id: 'D', name: 'D区', label: '天台通道' },
    ],
    deviceCount: 12,
    // 楼梯1(S-A) 检修停用（状态见 floorTopology.STAIR_ACTIVE_FLOORS）
    note: '顶层',
  },
}

// 本层可用楼梯（未启用 = 检修停用，不参与路网/布点/疏散）
// P1.8.1：状态取自唯一权威拓扑，与疏散算法同一份数据（避免 2D 显示停用、算法照走）
export function activeStairsForFloor(floorId) {
  const ids = activePlanStairIdsForFloor(floorId)
  return STAIRS.filter((s) => ids.includes(s.id))
}

// ══════════════════════════════════════
// 设备布点规则 —— 基于建筑结构，非随机
// ══════════════════════════════════════
// 设备沿走廊中心线分布，间距均匀；楼梯口/出口额外布点

/**
 * 为指定楼层生成设备位置列表
 * 返回: [{ id, type, x, y, area, direction, floorId, buildingId }]
 */
export function generateFloorDevices(floorId, buildingId = 'B003') {
  const cfg = FLOOR_CONFIG[floorId]
  if (!cfg) return []

  const devices = []
  let idx = 1

  // 走廊疏散指示灯：沿走廊中心线均匀分布
  const corridorSpots = [
    { x: 72, y: 170, area: '走廊', near: '楼梯1' },
    { x: 140, y: 170, area: '走廊', near: 'A区门口' },
    { x: 205, y: 170, area: '走廊', near: '中段' },
    { x: 280, y: 170, area: '走廊', near: '中央' },
    { x: 355, y: 170, area: '走廊', near: '中段' },
    { x: 415, y: 170, area: '走廊', near: 'C区门口' },
    { x: 477, y: 170, area: '走廊', near: '楼梯2' },
  ]

  // 根据楼层数量选取走廊布点（不同楼层不同数量）
  const spotCount = cfg.deviceCount <= 10 ? 5 : cfg.deviceCount <= 12 ? 6 : 7
  const selectedSpots = corridorSpots.slice(0, spotCount)

  selectedSpots.forEach((spot) => {
    // 疏散指示灯（带方向）——朝走廊分界点(280)同侧的最近疏散楼梯/出口方向
    devices.push({
      id: `EL-${floorId}-${pad(idx++)}`,
      type: 'evacuation_light',
      x: spot.x,
      y: spot.y - 8,  // 略高于中心线，模拟吸顶安装
      area: spot.area,
      direction: spot.x < 280 ? 'left' : 'right',  // 左半区朝西侧出口(左)，右半区朝东侧出口(右)
      floorId,
      buildingId,
    })
    // 应急照明灯（同位置，略偏）
    devices.push({
      id: `EM-${floorId}-${pad(idx++)}`,
      type: 'emergency_light',
      x: spot.x,
      y: spot.y + 8,  // 略低于中心线
      area: spot.area,
      floorId,
      buildingId,
    })
  })

  // 房间门口烟感（每区1个，area 用房间区域名，便于与人员 zone / 火灾联动匹配）
  DOORS.forEach((door) => {
    devices.push({
      id: `SD-${floorId}-${pad(idx++)}`,
      type: 'smoke_detector',
      x: door.x,
      y: door.roomSide.y,
      area: door.zone,
      zoneName: door.zone,
      doorId: door.id,
      floorId,
      buildingId,
    })
  })

  // 楼梯口疏散指示灯（仅本层可用楼梯；检修停用的楼梯不放灯也不进路网）
  // 坐标放在楼梯间中心 (corridorX, stair.y + h/2)，避免与走廊中心线布点灯（EL y162 / EM y178）在 x=72/477 处三灯重叠
  activeStairsForFloor(floorId).forEach((stair) => {
    devices.push({
      id: `EL-${floorId}-${pad(idx++)}`,
      type: 'evacuation_light',
      x: stair.corridorX,
      y: stair.y + stair.h / 2,
      area: stair.name,
      stairId: stair.id,
      direction: stair.corridorX < 280 ? 'left' : 'right',  // 朝楼梯方向（外侧出口）
      floorId,
      buildingId,
    })
  })

  // 1F 额外加安全出口标识
  if (floorId === '1F') {
    EXITS.forEach((exit) => {
      devices.push({
        id: `EXIT-${floorId}-${pad(idx++)}`,
        type: 'exit_sign',
        x: exit.x,
        y: exit.y,
        area: exit.name,
        floorId,
        buildingId,
        exitId: exit.id,
      })
    })
  }

  // 雷达感知终端（走廊关键位置，每层2个）
  const radarSpots = selectedSpots.filter(s => s.near.includes('门口') || s.near.includes('中央'))
  radarSpots.forEach((spot) => {
    devices.push({
      id: `RD-${floorId}-${pad(idx++)}`,
      type: 'radar_sensor',
      x: spot.x + 15,
      y: 170,
      area: spot.area,
      floorId,
      buildingId,
    })
  })

  return devices
}

function pad(n, len = 2) {
  return String(n).padStart(len, '0')
}

// P1.8.1（D4）：原「第二套拓扑」构建函数已删除 ——
//   getFloorPlanNodes / getFloorPlanEdges / buildPlanGraph / edgeKey 全仓零引用，
//   且与 shared/evacuation/floorTopology.js 存在节点 id 命名空间（5F-A区 vs 5F:A_CENTER）、
//   走廊粒度（9 vs 5）、楼梯可用状态、跨层权重（3.5 vs 6）四处冲突。
//   疏散图唯一来源：shared/evacuation/floorTopology.js + topologyGraphAdapter.js。

// ══════════════════════════════════════
// 可疏散区域
// ══════════════════════════════════════
export const ROOM_AREAS = ['A区', 'B区', 'C区', 'D区']

// P1.8.1（D4）：EXIT_NODES 已删除（全仓零引用，且与 2F~6F 无出口节点的事实矛盾）。
//   出口的唯一权威定义在 shared/evacuation/floorTopology.js 的 EXIT_DEFS。

// 区域配色
export const ZONE_COLORS = {
  'A区': '#4361EE',
  'B区': '#4361EE',
  'C区': '#4CC9F0',
  'D区': '#F59E0B',
}

// 物理常量
export const FLOOR_HEIGHT_M = 3.5
export const EVAC_SPEED = 1.2
export const STAIR_PENALTY_S = 5

// ══════════════════════════════════════
// 房间定义（导出供视图渲染用）
// ══════════════════════════════════════
export const ROOMS = ROOM_DEFS

// P1.8.1（D4）：floorPlanData 的 getFloorTopology 已删除（全仓零引用）。
//   注意 src/mock/routeGraph.js 另有同名 getFloorTopology，返回的是 shared 权威图，
//   调试层（DashboardView / RoutePlanView）用的正是那一个，不是此处这个。

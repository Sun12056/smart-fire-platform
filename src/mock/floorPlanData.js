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
 */

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
    // 本层可用楼梯（其余楼梯显示为检修停用，疏散自动绕行）
    stairsActive: ['S-A', 'S-B', 'S-C', 'S-D'],
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
    stairsActive: ['S-A', 'S-B', 'S-C', 'S-D'],
  },
  '3F': {
    rooms: [
      { id: 'A', name: 'A区', label: '实验室' },
      { id: 'B', name: 'B区', label: '准备间' },
      { id: 'C', name: 'C区', label: '仪器室' },
      { id: 'D', name: 'D区', label: '仓库' },
    ],
    deviceCount: 14,
    note: '实验层，设备多',
    // 楼梯4(S-D) 检修停用 → 3F 人群只能走楼梯1/2/3
    stairsActive: ['S-A', 'S-B', 'S-C'],
  },
  '4F': {
    rooms: [
      { id: 'A', name: 'A区', label: '研发区' },
      { id: 'B', name: 'B区', label: '讨论室' },
      { id: 'C', name: 'C区', label: '服务器房' },
      { id: 'D', name: 'D区', label: '杂物间' },
    ],
    deviceCount: 11,
    note: '研发层',
    // 楼梯3(S-C) 检修停用
    stairsActive: ['S-A', 'S-B', 'S-D'],
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
    stairsActive: ['S-A', 'S-B', 'S-C', 'S-D'],
  },
  '6F': {
    rooms: [
      { id: 'A', name: 'A区', label: '顶层办公' },
      { id: 'B', name: 'B区', label: '档案室' },
      { id: 'C', name: 'C区', label: '通风机房' },
      { id: 'D', name: 'D区', label: '天台通道' },
    ],
    deviceCount: 12,
    note: '顶层',
    // 楼梯1(S-A) 检修停用
    stairsActive: ['S-B', 'S-C', 'S-D'],
  },
}

// 本层可用楼梯（未启用 = 检修停用，不参与路网/布点/疏散）
export function activeStairsForFloor(floorId) {
  const cfg = FLOOR_CONFIG[floorId]
  const ids = cfg && Array.isArray(cfg.stairsActive) ? cfg.stairsActive : STAIRS.map((s) => s.id)
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

// ══════════════════════════════════════
// 路网节点（与设备共享坐标）
// ══════════════════════════════════════


export function getFloorPlanNodes(floorId) {
  const nodes = []
  const add = (id, x, y, type, key, label, extra) => {
    nodes.push({ id: `${floorId}-${id}`, floorId, key, x, y, type, label: label || key, ...(extra || {}) })
  }

  // 房间门口节点 —— id 用区域名（A区/B区/C区/D区），保证与生成路线的起点 zone 精确匹配；
  // 房间只能经门口接入走廊（门 = 真实通行连接点）
  DOORS.forEach(d => add(d.zone, d.x, d.y, 'room', d.zone, d.zone, { doorId: d.id }))

  // 走廊节点（沿中心线 y=170）
  CORRIDOR.nodes.forEach(cx => add(`C-${cx}`, cx, 170, 'corridor', `C-${cx}`))

  // 楼梯节点（仅可用楼梯；检修停用楼梯不参与疏散路网）
  activeStairsForFloor(floorId).forEach(s => add(s.id, s.corridorX, s.corridorY, 'stair', s.id, s.name))

  // 出口节点（仅 1F 直达室外；其他楼层经楼梯下行）
  if (floorId === '1F') {
    EXITS.forEach(e => add(e.id, e.x, e.y, 'exit', e.id, e.name))
  }

  return nodes
}

// ══════════════════════════════════════
// 路网边（真实可通行连接）
// ══════════════════════════════════════
export function getFloorPlanEdges(floorId) {
  const edges = []
  const link = (from, to) => {
    edges.push({ from: `${floorId}-${from}`, to: `${floorId}-${to}` })
  }

  // 走廊水平链路
  const cn = CORRIDOR.nodes
  for (let i = 0; i < cn.length - 1; i++) {
    link(`C-${cn[i]}`, `C-${cn[i + 1]}`)
  }

  // 房间(门口) → 走廊
  DOORS.forEach(d => link(d.zone, `C-${d.x}`))

  // 楼梯 → 走廊（仅可用楼梯）
  activeStairsForFloor(floorId).forEach(s => link(s.id, `C-${s.corridorX}`))

  // 走廊末端 → 出口（仅 1F）
  if (floorId === '1F') {
    link('C-45', '出口B')
    link('C-510', '出口A')
  }

  return edges
}

// ══════════════════════════════════════
// 完整楼栋图（含跨楼层楼梯边）
// ══════════════════════════════════════
export function buildPlanGraph(maxFloor = 6) {
  const nodes = {}
  const adj = {}
  const n = parseInt(String(maxFloor).replace('F', ''), 10) || 6

  for (let f = n; f >= 1; f--) {
    const fid = `${f}F`
    const fNodes = getFloorPlanNodes(fid)
    const fEdges = getFloorPlanEdges(fid)

    fNodes.forEach(nd => {
      nodes[nd.id] = nd
      adj[nd.id] = []
    })

    fEdges.forEach(e => {
      const ek = edgeKey(e.from, e.to)
      const na = nodes[e.from], nb = nodes[e.to]
      if (!na || !nb) return
      const w = Math.round(Math.sqrt((na.x - nb.x) ** 2 + (na.y - nb.y) ** 2) / 10 * 100) / 100
      adj[e.from].push({ to: e.to, w, ek })
      adj[e.to].push({ to: e.from, w, ek })
    })
  }

  // 跨楼层楼梯下降边（仅两端节点都存在时连接：某层楼梯检修停用则该跨层通道自动失效）
  STAIRS.forEach(s => {
    for (let f = n; f >= 2; f--) {
      const up = `${f}F-${s.id}`
      const down = `${f - 1}F-${s.id}`
      if (!nodes[up] || !nodes[down]) continue
      const ek = edgeKey(up, down)
      adj[up].push({ to: down, w: 3.5, ek })
      adj[down].push({ to: up, w: 3.5, ek })
    }
  })

  return { nodes, adj, maxFloor: n }
}

export function edgeKey(a, b) {
  return [a, b].sort().join('|')
}

// ══════════════════════════════════════
// 可疏散区域
// ══════════════════════════════════════
export const ROOM_AREAS = ['A区', 'B区', 'C区', 'D区']

// ══════════════════════════════════════
// 安全出口节点（路网用）
// ══════════════════════════════════════
export const EXIT_NODES = [
  { id: '出口A', x: 528, y: 170, side: 'right', label: '安全出口(东侧)' },
  { id: '出口B', x: 32, y: 170, side: 'left', label: '安全出口(西侧)' },
]

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

// ══════════════════════════════════════
// 调试拓扑（供调试层用）
// ══════════════════════════════════════
export function getFloorTopology(floorId = '1F') {
  return {
    floorId,
    nodes: getFloorPlanNodes(floorId),
    edges: getFloorPlanEdges(floorId),
    walls: WALLS,
    doors: DOORS,
    stairs: activeStairsForFloor(floorId),
    exits: EXITS,
    rooms: ROOMS,
    corridor: CORRIDOR,
  }
}

/**
 * 空间拓扑与出口模型 —— P1.8.1
 *
 * 定位：楼层空间的**唯一权威拓扑数据源**。
 *   楼层 → 区域 Zone → 走廊 Corridor → 拓扑节点 Node → 可通行边 Edge → 楼梯 Stair → 安全出口 Exit
 *
 * 设计约束（严格遵守，避免制造第三套数据）：
 *   ① 本文件是拓扑数据的唯一定义处；`routeGraph.js` 只做算法与兼容重导出，不再自带蓝图；
 *   ② `src/mock/floorPlanData.js` 只保留 2D 渲染几何（房间/门/走廊/楼梯/出口的画法），
 *      其旧图构建函数已删除；楼梯逐层可用状态反向取自本文件，避免两处各写一份；
 *   ③ 不重写 Dijkstra / Yen / 评分 / 校验几何 —— 本文件只出数据，不出算法；
 *   ④ 坐标沿用建筑平面图 SVG 560×300 空间（1m = 10px），与设备/人员/3D 模型同源。
 *
 * 楼层平面（与 src/mock/floorPlanData.js 同源）：
 *   ┌──────────┬──────────┐
 *   │    A     │    C     │    ← 北排房间（门在 y=150）
 *   ├──────────┼──────────┤    ← 主走廊 y=150~190，中心线 y=170
 *   │    B     │    D     │    ← 南排房间（门在 y=190）
 *   └──────────┴──────────┘
 *   四角设楼梯（NW/NE/SW/SE），1F 走廊两端设西侧/东侧安全出口。
 */
import { NODE_TYPE, ROUTE_CONST } from './routeTypes.js'

const { PX_PER_M, STAIR_DESCENT_M } = ROUTE_CONST

// ══════════════════════════════════════
// ① 基础工具（拓扑层自持，避免与 routeGraph 循环依赖）
// ══════════════════════════════════════

/** `${floorId}:${key}` —— 跨楼层节点唯一 id */
export function nodeId(floorId, key) {
  return `${floorId}:${key}`
}

/** '5F' → 5 */
export function floorNum(floorId) {
  return parseInt(String(floorId).replace('F', ''), 10) || 1
}

/** 无向边的稳定 id（两端节点 id 排序拼接）—— 与既有 blockedEdges 口径一致 */
export function edgeKey(a, b) {
  return [a, b].sort().join('|')
}

/** 平面欧氏距离（px） */
export function euclid(a, b) {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2)
}

/** px → m（保留 2 位） */
export function pxToM(px) {
  return Math.round((px / PX_PER_M) * 100) / 100
}

// ══════════════════════════════════════
// ② 枚举
// ══════════════════════════════════════

/** 边类型：表达「这条边是什么性质的通行关系」 */
export const EDGE_TYPE = {
  ROOM_DOOR: 'room_door',       // 房间门口 ↔ 走廊门厅
  CORRIDOR: 'corridor',         // 走廊段
  STAIR_ACCESS: 'stair_access', // 走廊 ↔ 楼梯间
  STAIR_DESCENT: 'stair_descent', // 楼梯跨层下降
  EXIT_ACCESS: 'exit_access',   // 走廊/楼梯 ↔ 安全出口
}

/** 安全出口状态 */
export const EXIT_STATUS = {
  OPEN: 'OPEN',
  CLOSED: 'CLOSED',   // 人为关闭/不可用
  BLOCKED: 'BLOCKED', // 被火灾阻断
}

/** 楼梯逐层状态（D2：楼梯实体保留，停用只影响跨层边是否参与寻路） */
export const STAIR_STATUS = {
  ACTIVE: 'ACTIVE',
  OUT_OF_SERVICE: 'OUT_OF_SERVICE',
}

// ══════════════════════════════════════
// ③ 墙体（不可通行实体）—— 全系统唯一定义
// ══════════════════════════════════════
export const WALLS = [
  { x: 90, y: 28, w: 105, h: 120, type: 'room' },   // A区
  { x: 90, y: 210, w: 105, h: 70, type: 'room' },   // B区
  { x: 375, y: 28, w: 80, h: 120, type: 'room' },   // C区
  { x: 375, y: 210, w: 80, h: 70, type: 'room' },   // D区
  { x: 195, y: 20, w: 6, h: 130, type: 'inner' },   // A/C 左墙
  { x: 355, y: 20, w: 6, h: 130, type: 'inner' },   // A/C 右墙
  { x: 195, y: 190, w: 6, h: 110, type: 'inner' },  // B/D 左墙
  { x: 355, y: 190, w: 6, h: 110, type: 'inner' },  // B/D 右墙
]

// ══════════════════════════════════════
// ④ 区域 Zone 定义
// ══════════════════════════════════════

/**
 * 区域 → 门口节点 → 火灾蔓延判定门厅（hallKey）。
 *
 * D3 修正（P1.8.0 F-18）：原设计 A/B 共用 CORRIDOR_N、C/D 共用 CORRIDOR_S，
 *   导致「火源门厅」同时也是邻接区唯一出口通道 —— 封则邻接区困死，不封则邻接区
 *   必须贴着火源房间门口通过。
 *
 *   修正方式：每区声明**互不相同**的 hallKey（A/B、C/D 不再共门厅），
 *   同时为 B/D 增加一条通往远端门厅的备选边（见 FLOOR_EDGE_DEFS），
 *   使其在本区门厅被封时仍有通路 —— 而不是被封死。
 *
 * hallKey 语义：仅用于「火灾蔓延到走廊时封锁哪个门厅节点」的判定
 *   （routePlanner:startHall/fireHall、buildingEvacuationPlanner:fireBlockSets）。
 */
export const ZONE_DEFS = [
  { zone: 'A区', doorKey: 'A_CENTER', hallKey: 'CORRIDOR_N' },
  { zone: 'B区', doorKey: 'B_CENTER', hallKey: 'CORRIDOR_W' },
  { zone: 'C区', doorKey: 'C_CENTER', hallKey: 'CORRIDOR_S' },
  { zone: 'D区', doorKey: 'D_CENTER', hallKey: 'CORRIDOR_E' },
]

/** 区域 → 起点节点 key（兼容既有引用） */
export const ZONE_NODE_KEY = Object.fromEntries(
  ZONE_DEFS.map((z) => [z.zone, z.doorKey]),
)

/** 房间节点 key → 其接入的门厅节点 key（兼容既有引用） */
export const ZONE_CORRIDOR_KEY = Object.fromEntries(
  ZONE_DEFS.map((z) => [z.doorKey, z.hallKey]),
)

/** 可疏散区域列表 */
export const ZONE_IDS = ZONE_DEFS.map((z) => z.zone)

// ══════════════════════════════════════
// ⑤ 拓扑节点（单层蓝本，13 个）
// ══════════════════════════════════════

/**
 * 说明：房间的疏散起点取「门口」而非房间几何中心 —— 房间只有通过门才能进入走廊，
 *      这样既符合真实通行约束，也保证路线第一段不会从房间内部穿出。
 */
export const FLOOR_NODES = [
  { key: 'A_CENTER', x: 140, y: 150, type: NODE_TYPE.ROOM, zone: 'A区', label: 'A区门口' },
  { key: 'B_CENTER', x: 140, y: 190, type: NODE_TYPE.ROOM, zone: 'B区', label: 'B区门口' },
  { key: 'C_CENTER', x: 415, y: 150, type: NODE_TYPE.ROOM, zone: 'C区', label: 'C区门口' },
  { key: 'D_CENTER', x: 415, y: 190, type: NODE_TYPE.ROOM, zone: 'D区', label: 'D区门口' },

  { key: 'CORRIDOR_N', x: 140, y: 170, type: NODE_TYPE.CORRIDOR, label: 'A区门厅' },
  { key: 'CORRIDOR_CENTER', x: 280, y: 170, type: NODE_TYPE.CORRIDOR, label: '主走廊中心' },
  { key: 'CORRIDOR_S', x: 415, y: 170, type: NODE_TYPE.CORRIDOR, label: 'C区门厅' },
  { key: 'CORRIDOR_W', x: 72, y: 170, type: NODE_TYPE.CORRIDOR, label: '西端楼梯厅' },
  { key: 'CORRIDOR_E', x: 477, y: 170, type: NODE_TYPE.CORRIDOR, label: '东端楼梯厅' },

  { key: 'STAIR_NW', x: 72, y: 45, type: NODE_TYPE.STAIR, label: '西北楼梯' },
  { key: 'STAIR_NE', x: 477, y: 45, type: NODE_TYPE.STAIR, label: '东北楼梯' },
  { key: 'STAIR_SW', x: 72, y: 272, type: NODE_TYPE.STAIR, label: '西南楼梯' },
  { key: 'STAIR_SE', x: 477, y: 272, type: NODE_TYPE.STAIR, label: '东南楼梯' },
]

/** 节点 key → 蓝本 */
export const NODE_BLUEPRINT_BY_KEY = Object.fromEntries(
  FLOOR_NODES.map((n) => [n.key, n]),
)

// ══════════════════════════════════════
// ⑥ 楼梯 Stair 模型
// ══════════════════════════════════════

/**
 * 楼梯实体。planStairId 对应 src/mock/floorPlanData.js 的 STAIRS[].id，
 * 用于把「2D 画哪些楼梯」与「算法能走哪些楼梯」对齐到同一份数据。
 */
export const STAIR_DEFS = [
  { key: 'STAIR_NW', planStairId: 'S-A', x: 72, y: 45, label: '西北楼梯' },
  { key: 'STAIR_NE', planStairId: 'S-B', x: 477, y: 45, label: '东北楼梯' },
  { key: 'STAIR_SW', planStairId: 'S-C', x: 72, y: 272, label: '西南楼梯' },
  { key: 'STAIR_SE', planStairId: 'S-D', x: 477, y: 272, label: '东南楼梯' },
]

export const STAIR_KEYS = STAIR_DEFS.map((s) => s.key)

/**
 * 楼梯逐层可用状态（D2）。
 * 语义：某楼梯在某层「检修停用」时 —— **楼梯节点保留**，但涉及该层的跨层下降边不参与寻路。
 * 取值与 src/mock/floorPlanData.js 原 FLOOR_CONFIG.stairsActive 一致（已收编到此处，不再两处维护）。
 */
export const STAIR_ACTIVE_FLOORS = {
  '1F': ['STAIR_NW', 'STAIR_NE', 'STAIR_SW', 'STAIR_SE'],
  '2F': ['STAIR_NW', 'STAIR_NE', 'STAIR_SW', 'STAIR_SE'],
  '3F': ['STAIR_NW', 'STAIR_NE', 'STAIR_SW'], // S-D 停用
  '4F': ['STAIR_NW', 'STAIR_NE', 'STAIR_SE'], // S-C 停用
  '5F': ['STAIR_NW', 'STAIR_NE', 'STAIR_SW', 'STAIR_SE'],
  '6F': ['STAIR_NE', 'STAIR_SW', 'STAIR_SE'], // S-A 停用
}

/** 某层可用的楼梯 key 列表（未登记楼层默认全部可用） */
export function activeStairKeysForFloor(floorId) {
  return STAIR_ACTIVE_FLOORS[floorId] || STAIR_KEYS
}

/** 某层可用的楼梯在 floorPlanData 中的 id 列表（供 2D 渲染复用同一份状态） */
export function activePlanStairIdsForFloor(floorId) {
  const keys = activeStairKeysForFloor(floorId)
  return STAIR_DEFS.filter((s) => keys.includes(s.key)).map((s) => s.planStairId)
}

/** 某楼梯在某层是否可用 */
export function isStairActiveOnFloor(stairKey, floorId) {
  return activeStairKeysForFloor(floorId).includes(stairKey)
}

/** 楼梯在某层的状态枚举 */
export function stairStatusOnFloor(stairKey, floorId) {
  return isStairActiveOnFloor(stairKey, floorId) ? STAIR_STATUS.ACTIVE : STAIR_STATUS.OUT_OF_SERVICE
}

// ══════════════════════════════════════
// ⑦ 安全出口 Exit 模型
// ══════════════════════════════════════

/**
 * 真实安全出口只有 2 个，且都位于 1F（D1：不为了模型完整凭空增加建筑出口）。
 * 出口在此成为**可被路径算法消费的实体**，而不只是一个 UI 图标。
 *
 * 字段说明：
 *   id / key       出口标识（EXIT_W / EXIT_E）
 *   buildingId     拓扑与楼栋无关（同一平面模型被多栋楼复用），楼栋归属由运行态决定，故为 null
 *   floorId / nodeId  所在楼层与对应拓扑节点 id —— 回答「这个出口连接哪个拓扑节点」
 *   type           NODE_TYPE.EXIT
 *   available      是否可用 —— 回答「当前是否可用」
 *   status         OPEN / CLOSED / BLOCKED
 *   capacity       容量上限；**null 表示「容量未知 / 未配置」**，不表示无限容量。
 *                  当前不执行任何容量约束（P1.8.2 启用容量模型前保持 null）。
 */
export const EXIT_DEFS = [
  {
    id: 'EXIT_W', key: 'EXIT_W', buildingId: null, floorId: '1F', nodeId: nodeId('1F', 'EXIT_W'),
    type: NODE_TYPE.EXIT, label: '西侧安全出口', side: 'left', x: 32, y: 170,
    available: true, status: EXIT_STATUS.OPEN, capacity: null,
  },
  {
    id: 'EXIT_E', key: 'EXIT_E', buildingId: null, floorId: '1F', nodeId: nodeId('1F', 'EXIT_E'),
    type: NODE_TYPE.EXIT, label: '东侧安全出口', side: 'right', x: 528, y: 170,
    available: true, status: EXIT_STATUS.OPEN, capacity: null,
  },
]

/** 出口 key → 出口实体 */
export const EXIT_BY_KEY = Object.fromEntries(EXIT_DEFS.map((e) => [e.key, e]))

/** 出口节点 id → 出口实体 */
export const EXIT_BY_NODE_ID = Object.fromEntries(EXIT_DEFS.map((e) => [e.nodeId, e]))

/** 全部出口节点 id */
export const EXIT_NODE_IDS = EXIT_DEFS.map((e) => e.nodeId)

/**
 * 出口实体的可用性判定 —— **单一谓词**，`availableExitNodeIds` 与 `isExitUsable` 共用。
 * 三者均视为不可用：available 为假、status 为 CLOSED、status 为 BLOCKED。
 */
function exitIsUsable(exit) {
  if (!exit) return false
  return Boolean(exit.available)
    && exit.status !== EXIT_STATUS.BLOCKED
    && exit.status !== EXIT_STATUS.CLOSED
}

/** 当前可用的出口节点 id（与 isExitUsable 同一判定口径） */
export function availableExitNodeIds(exits = EXIT_DEFS) {
  return (exits || []).filter((e) => exitIsUsable(e)).map((e) => e.nodeId)
}

/**
 * 出口是否可作为疏散目标。
 * 优先采用传入的 exits（运行态可覆盖 available/status），缺省才回落到静态定义。
 */
export function isExitUsable(exitNodeId, exits = EXIT_DEFS) {
  const e = (exits || []).find((x) => x.nodeId === exitNodeId) || EXIT_BY_NODE_ID[exitNodeId]
  return exitIsUsable(e)
}

// ══════════════════════════════════════
// ⑧ 可通行边 Edge 定义（单层）
// ══════════════════════════════════════

/**
 * 每条边表达：from / to / type。
 * distance 由坐标推导（跨层用 STAIR_DESCENT_M），不手写距离，避免与坐标脱节。
 *
 * D3 修正：为 B/D 各增加一条通往**远端门厅**的备选边（B↔CORRIDOR_W、D↔CORRIDOR_E），
 *   同时保留其近端门厅边（B↔CORRIDOR_N、D↔CORRIDOR_S）。
 *   · 必要性：B 与 A、D 与 C 原本共用门厅，本区门厅被火势封锁时无路可走；
 *   · 为什么不直接把 B/D 改接到远端门厅：实测会使 D 区绕行增加约 10.7m
 *     （D 门在 x=415，却被迫先向东到 x=477 再折返西向出口）。保留近端边后
 *     D 区西行距离与修正前一致（40.3m），东行反而更短。
 *   · 新线段仍落在走廊带 y=150~190 内，不穿墙（见 topology.test.mjs T6）。
 */
export const FLOOR_EDGE_DEFS = [
  { from: 'A_CENTER', to: 'CORRIDOR_N', type: EDGE_TYPE.ROOM_DOOR },
  { from: 'B_CENTER', to: 'CORRIDOR_N', type: EDGE_TYPE.ROOM_DOOR },
  { from: 'B_CENTER', to: 'CORRIDOR_W', type: EDGE_TYPE.ROOM_DOOR },
  { from: 'C_CENTER', to: 'CORRIDOR_S', type: EDGE_TYPE.ROOM_DOOR },
  { from: 'D_CENTER', to: 'CORRIDOR_S', type: EDGE_TYPE.ROOM_DOOR },
  { from: 'D_CENTER', to: 'CORRIDOR_E', type: EDGE_TYPE.ROOM_DOOR },

  { from: 'CORRIDOR_N', to: 'CORRIDOR_CENTER', type: EDGE_TYPE.CORRIDOR },
  { from: 'CORRIDOR_S', to: 'CORRIDOR_CENTER', type: EDGE_TYPE.CORRIDOR },
  { from: 'CORRIDOR_N', to: 'CORRIDOR_W', type: EDGE_TYPE.CORRIDOR },
  { from: 'CORRIDOR_S', to: 'CORRIDOR_E', type: EDGE_TYPE.CORRIDOR },

  { from: 'CORRIDOR_W', to: 'STAIR_NW', type: EDGE_TYPE.STAIR_ACCESS },
  { from: 'CORRIDOR_W', to: 'STAIR_SW', type: EDGE_TYPE.STAIR_ACCESS },
  { from: 'CORRIDOR_E', to: 'STAIR_NE', type: EDGE_TYPE.STAIR_ACCESS },
  { from: 'CORRIDOR_E', to: 'STAIR_SE', type: EDGE_TYPE.STAIR_ACCESS },
]

/** 1F 专有：走廊末端 / 四角楼梯 → 安全出口 */
export const EXIT_EDGE_DEFS = [
  { from: 'CORRIDOR_W', to: 'EXIT_W', type: EDGE_TYPE.EXIT_ACCESS },
  { from: 'STAIR_NW', to: 'EXIT_W', type: EDGE_TYPE.EXIT_ACCESS },
  { from: 'STAIR_SW', to: 'EXIT_W', type: EDGE_TYPE.EXIT_ACCESS },
  { from: 'CORRIDOR_E', to: 'EXIT_E', type: EDGE_TYPE.EXIT_ACCESS },
  { from: 'STAIR_NE', to: 'EXIT_E', type: EDGE_TYPE.EXIT_ACCESS },
  { from: 'STAIR_SE', to: 'EXIT_E', type: EDGE_TYPE.EXIT_ACCESS },
]

/** 单层的全部边定义（1F 追加出口边） */
export function floorEdgeDefsOf(floorId) {
  return floorNum(floorId) === 1
    ? FLOOR_EDGE_DEFS.concat(EXIT_EDGE_DEFS)
    : FLOOR_EDGE_DEFS
}

/**
 * 跨层下降边（D2：仅当楼梯在**上下两层都可用**时才生成）。
 * 楼梯节点本身始终存在；停用只让跨层边不进入图。
 */
export function stairDescentEdgeDefs(maxFloor = 6) {
  const n = floorNum(`${maxFloor}F`)
  const out = []
  STAIR_KEYS.forEach((key) => {
    for (let f = n; f >= 2; f--) {
      const upFloor = `${f}F`
      const downFloor = `${f - 1}F`
      if (!isStairActiveOnFloor(key, upFloor)) continue
      if (!isStairActiveOnFloor(key, downFloor)) continue
      out.push({
        fromFloor: upFloor, toFloor: downFloor, from: key, to: key,
        type: EDGE_TYPE.STAIR_DESCENT,
      })
    }
  })
  return out
}

/** 跨层下降的等效步行距离（m） */
export function stairDescentDistance() {
  return STAIR_DESCENT_M
}

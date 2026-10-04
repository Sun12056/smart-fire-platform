/**
 * 疏散路线统一数据结构 —— 前端（Vue/3D）与 Worker（Demo Engine）共用
 *
 * 唯一出口：A/B/C 三套候选方案全部由 shared/evacuation/routePlanner.js 产出，
 * 任何页面与后端都不得各自手写「房间→出口」的连线逻辑。
 *
 * @typedef {'room'|'door'|'corridor'|'stair'|'exit'} NodeType
 * @typedef {'LOW'|'MEDIUM'|'HIGH'} RiskLevel
 * @typedef {'NORMAL'|'WARNING'|'BLOCKED'|'CONFIRMED'|'EXECUTING'|'DONE'} PlanStatus
 */

/** 节点类型 */
export const NODE_TYPE = {
  ROOM: 'room',
  DOOR: 'door',
  CORRIDOR: 'corridor',
  STAIR: 'stair',
  EXIT: 'exit',
}

/** 风险等级（风险由「路线与火源的距离」推导，不主观指定） */
export const RISK_LEVEL = { LOW: 'LOW', MEDIUM: 'MEDIUM', HIGH: 'HIGH' }
export const RISK_LEVEL_LABEL = { LOW: '低', MEDIUM: '中', HIGH: '高' }

/** 方案状态：EvacuationPlan 生命周期（与 Demo 六阶段严格区分） */
export const PLAN_STATUS = {
  NORMAL: 'NORMAL',
  WARNING: 'WARNING',
  BLOCKED: 'BLOCKED',
  CONFIRMED: 'CONFIRMED',
  EXECUTING: 'EXECUTING',
  DONE: 'DONE',
}

/** 物理常量（与建筑模型同源：SVG 平面图 560×300，1m = 10px） */
export const ROUTE_CONST = {
  SVG_W: 560,
  SVG_H: 300,
  PX_PER_M: 10,        // 10px = 1m
  EVAC_SPEED: 1.2,     // 行走速度 m/s
  STAIR_PENALTY_S: 5,  // 每下降一层额外耗时（s）
  STAIR_DESCENT_M: 6,  // 每下降一层等效步行距离（m）
  RISK_FAR_M: 30,      // 距火源 ≥30m 视为低风险
  RISK_NEAR_M: 15,     // 距火源 <15m 视为高风险
}

/** 方案命名：A / B / C */
export const PLAN_LABELS = ['A', 'B', 'C']

/** `${floorId}:${key}` —— 跨楼层节点唯一 id */
export function nodeId(floorId, key) {
  return `${floorId}:${key}`
}

/** 空方案骨架（保证前端/3D 读字段不会 undefined） */
export function emptyPlan(overrides = {}) {
  return {
    id: '',
    name: '',
    startZones: [],
    startNode: '',
    exitId: '',
    exitLabel: '',
    distance: 0,
    estimatedTime: 0,
    riskLevel: RISK_LEVEL.LOW,
    fireDistance: Infinity,
    exitDistance: 0,
    floorsPassed: [],
    nodes: [],
    points: [],
    congestion: 0,
    score: 0,
    recommended: false,
    status: PLAN_STATUS.NORMAL,
    valid: true,
    reasons: [],
    ...overrides,
  }
}

/**
 * 整栋楼疏散方案（BuildingEvacuationPlan）数据结构
 *
 * 关键语义变更（相对旧的「单起点 A/B/C 三条路线」）：
 *   · fireEvent 只描述「火灾位置」（buildingId + floorId + zone）
 *   · evacuationScope = BUILDING —— 一次火灾 = 一栋楼的一次整体疏散任务
 *   · PLAN-A/B/C 是「整栋楼的三种疏散策略」，不再是某个区域的三条路线
 *   · 每个策略内部必须为每个「有人员的 floorId + zone」生成一条 EvacuationRoute
 *
 * 本文件只定义结构与常量，不含算法（算法见 buildingEvacuationPlanner.js）。
 */
import { PLAN_STATUS, RISK_LEVEL } from './routeTypes.js'

/** 疏散范围：火灾位置与疏散范围分离 */
export const EVACUATION_SCOPE = {
  FLOOR: 'FLOOR',       // 仅本层（旧模型，保留兼容）
  BUILDING: 'BUILDING', // 整栋楼
}

/** 整栋楼疏散策略：PLAN-A/B/C 的语义 */
export const STRATEGY = {
  BALANCED: 'BALANCED', // A = 均衡疏散（出口负载均衡 + 综合评分）
  FASTEST: 'FASTEST',   // B = 快速疏散（整栋楼总耗时最短）
  SAFEST: 'SAFEST',     // C = 安全优先（远离火源 / 风险最低）
}

export const STRATEGY_META = {
  [STRATEGY.BALANCED]: { label: 'A', name: '均衡疏散', desc: '按出口负载分流，兼顾时间与风险' },
  [STRATEGY.FASTEST]: { label: 'B', name: '快速疏散', desc: '每个区域取耗时最短的路线' },
  [STRATEGY.SAFEST]: { label: 'C', name: '安全优先', desc: '每个区域取远离火源、风险最低的路线' },
}

/** 风险等级排序权重（越小越安全） */
export const RISK_RANK = {
  [RISK_LEVEL.LOW]: 0,
  [RISK_LEVEL.MEDIUM]: 1,
  [RISK_LEVEL.HIGH]: 2,
}

/** 区域唯一键：`5F:A区` —— 前端 routesByZone / 3D 人员取路线都用这个键 */
export function zoneKeyOf(floorId, zone) {
  return `${floorId}:${zone}`
}

/** 单条疏散路线骨架 */
export function emptyRoute(overrides = {}) {
  return {
    routeId: '',
    floorId: '',
    zone: '',
    startNode: '',
    exitId: '',
    exitLabel: '',
    nodes: [],
    points: [],
    distance: 0,
    estimatedTime: 0,
    riskLevel: RISK_LEVEL.LOW,
    valid: true,
    reasons: [],
    // ── 附加指标（均来自 shared/evacuation 规划器，不重新计算） ──
    floorsPassed: [],
    fireDistance: Infinity,
    escapeDistance: Infinity,
    exitDistance: 0,
    personCount: 0,
    sourcePlanId: '',   // 该路线取自哪个候选方案（A/B/C 内部候选）
    ...overrides,
  }
}

/** 整栋楼方案骨架 */
export function emptyBuildingPlan(overrides = {}) {
  return {
    id: '',
    name: '',
    buildingId: '',
    buildingName: '',
    scope: EVACUATION_SCOPE.BUILDING,
    strategy: STRATEGY.BALANCED,
    strategyLabel: 'A',
    fire: null,          // { buildingId, floorId, zone } —— 只描述火灾位置
    summary: emptySummary(),
    routes: [],
    routesByZone: {},    // { '5F:A区': EvacuationRoute }
    status: PLAN_STATUS.NORMAL,
    valid: true,
    reasons: [],
    createdAt: null,
    ...overrides,
  }
}

/** 汇总信息（UI 直接展示） */
export function emptySummary(overrides = {}) {
  return {
    zoneCount: 0,        // 需要疏散的区域数（floorId + zone）
    routeCount: 0,       // 已生成路线数
    validRouteCount: 0,  // 通过校验的路线数
    personCount: 0,      // 纳入疏散的总人数
    floors: [],          // 涉及楼层（由高到低）
    exits: {},           // { exitId: 使用人数 }
    exitLabels: [],      // 出口名称（去重）
    totalDistance: 0,    // 各区域路线距离之和（m）
    maxEstimatedTime: 0, // 全楼最慢区域耗时（s）≈ 整栋楼清空时间
    avgEstimatedTime: 0,
    riskLevel: RISK_LEVEL.LOW, // 全楼最高风险
    stairRouteCount: 0,  // 需要跨层下楼梯的路线数
    ...overrides,
  }
}

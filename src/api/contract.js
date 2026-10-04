// ================== API Contract（代码级唯一事实来源） ==================
// 与 docs/API_CONTRACT.md 同步维护；前后端字段均以本文件枚举为准
// 阶段一：REST 契约 + 双数据源；阶段二在此扩展 WS 消息类型与 /simulations 资源

export const API_PREFIX = '/api/v1'

// ── 端点定义 ──────────────────────────────────────────────
export const endpoints = {
  health: '/healthz',
  buildingList: `${API_PREFIX}/buildings`,
  buildingDetail: (id) => `${API_PREFIX}/buildings/${id}`,
  deviceList: `${API_PREFIX}/devices`,
  deviceDetail: (id) => `${API_PREFIX}/devices/${id}`,
  deviceUpdate: (id) => `${API_PREFIX}/devices/${id}`,
  telemetryList: `${API_PREFIX}/telemetry`,
  telemetryCreate: `${API_PREFIX}/telemetry`,
  telemetryBatch: `${API_PREFIX}/telemetry/batch`,
  alarmList: `${API_PREFIX}/alarms`,
  alarmCreate: `${API_PREFIX}/alarms`,
  alarmDetail: (id) => `${API_PREFIX}/alarms/${id}`,
  alarmUpdate: (id) => `${API_PREFIX}/alarms/${id}`,
  inspectionList: `${API_PREFIX}/inspections`,
  inspectionCreate: `${API_PREFIX}/inspections`,
  evacuationPlanList: `${API_PREFIX}/evacuation-plans`,
  evacuationPlanCreate: `${API_PREFIX}/evacuation-plans`,
  evacuationPlanDetail: (id) => `${API_PREFIX}/evacuation-plans/${id}`,
  evacuationPlanUpdate: (id) => `${API_PREFIX}/evacuation-plans/${id}`,
  personPresenceList: `${API_PREFIX}/person-presence`,
  personPresenceStats: `${API_PREFIX}/person-presence/stats`,
  personPresenceHeatmap: `${API_PREFIX}/person-presence/heatmap`,
  personPresenceBatch: `${API_PREFIX}/person-presence/batch`,
  operationLogList: `${API_PREFIX}/operation-logs`,
  operationLogCreate: `${API_PREFIX}/operation-logs`,
  adminSeed: `${API_PREFIX}/admin/seed`,
  // ── 阶段二：Demo 六阶段状态机（REST + WebSocket） ──
  demoState: `${API_PREFIX}/demo/state`,
  demoTransitions: `${API_PREFIX}/demo/transitions`,
  demoCommand: `${API_PREFIX}/demo/command`,
  demoReset: `${API_PREFIX}/demo/reset`,
  demoWs: (sessionId = 'default') => `${API_PREFIX}/demo/ws?sessionId=${encodeURIComponent(sessionId)}`,
}

// ── Demo 六阶段状态机（唯一定义，与 worker/src/demo/stages.ts 同步） ──
export const DEMO_STAGES = [
  'IDLE',
  'FIRE_DETECTED',
  'EMERGENCY_RESPONSE',
  'ROUTE_PLANNING',
  'SMART_EVACUATION',
  'RETAINED_PERSONS',
  'RESCUE_COORDINATION',
  'COMPLETED',
]
export const DEMO_COMMANDS = [
  'START_FIRE',
  'ACTIVATE_RESPONSE',
  'PLAN_ROUTES',
  'CONFIRM_ROUTE',
  'COMPLETE_EVACUATION',
  'CONFIRM_RETAINED',
  'COMPLETE_RESCUE',
  'RESET',
]
/** 与 Alarm 七步四态、EvacuationPlan 生命周期互不覆盖的转移表 */
export const DEMO_TRANSITIONS = {
  IDLE: { START_FIRE: 'FIRE_DETECTED' },
  FIRE_DETECTED: { ACTIVATE_RESPONSE: 'EMERGENCY_RESPONSE', RESET: 'IDLE' },
  EMERGENCY_RESPONSE: { PLAN_ROUTES: 'ROUTE_PLANNING', RESET: 'IDLE' },
  ROUTE_PLANNING: { CONFIRM_ROUTE: 'SMART_EVACUATION', RESET: 'IDLE' },
  SMART_EVACUATION: { COMPLETE_EVACUATION: 'RETAINED_PERSONS', RESET: 'IDLE' },
  RETAINED_PERSONS: { CONFIRM_RETAINED: 'RESCUE_COORDINATION', RESET: 'IDLE' },
  RESCUE_COORDINATION: { COMPLETE_RESCUE: 'COMPLETED', RESET: 'IDLE' },
  COMPLETED: { RESET: 'IDLE' },
}
export const STAGE_LABELS = {
  IDLE: '正常状态',
  FIRE_DETECTED: '发现火灾',
  EMERGENCY_RESPONSE: '启动应急响应',
  ROUTE_PLANNING: '疏散路径规划',
  SMART_EVACUATION: '智能疏散',
  RETAINED_PERSONS: '滞留人员识别',
  RESCUE_COORDINATION: '协同消防救援',
  COMPLETED: '处置完成',
}

export const DEMO_FLOW_STAGES = [
  'FIRE_DETECTED',
  'EMERGENCY_RESPONSE',
  'ROUTE_PLANNING',
  'SMART_EVACUATION',
  'RETAINED_PERSONS',
  'RESCUE_COORDINATION',
]

// ── WebSocket 消息类型（阶段二实时协调） ──
export const WS_MSG = {
  SNAPSHOT: 'demo.snapshot',   // 服务端→客户端：全量快照
  STAGE: 'demo.stage',         // 服务端→客户端：阶段变化（含全量快照）
  TICK: 'demo.tick',           // 服务端→客户端：疏散实时推进（人员位置 + 指标）
  EVENT: 'demo.event',         // 服务端→客户端：事件流水
  PONG: 'demo.pong',           // 服务端→客户端：心跳应答
  PING: 'demo.ping',           // 客户端→服务端：心跳
  SYNC: 'demo.sync',           // 客户端→服务端：请求全量快照（重连后补齐）
}

// ── 枚举 ──────────────────────────────────────────────────
export const ENUMS = {
  buildingStatus: ['normal', 'warning', 'emergency'],
  deviceType: ['evacuation_light', 'emergency_light', 'smoke_detector', 'radar_sensor', 'exit_sign'],
  deviceStatus: ['normal', 'warning', 'fault', 'emergency'],
  communication: ['online', 'offline'],
  currentMode: ['daily', 'offline', 'emergency'], // 日常节点亮 / 离线 / 应急强闪
  direction: ['left', 'right'],
  telemetryKind: ['battery', 'temperature', 'signal', 'voltage', 'brightness', 'personCount', 'status', 'direction', 'mode', 'heartbeat'],
  alarmLevel: ['danger', 'warning', 'info'],
  alarmStatus: ['pending', 'processing', 'reviewing', 'resolved'],
  alarmProgress: { pending: 10, processing: 30, reviewing: 60, resolved: 100 }, // 七步处置四态映射
  inspectionResult: ['pass', 'warning', 'fail'],
  planStatus: ['NORMAL', 'WARNING', 'BLOCKED', 'CONFIRMED', 'EXECUTING', 'DONE'],
  planType: ['auto', 'manual'],
  personStatus: ['normal', 'static', 'warning', 'evacuating', 'safe', 'stranded', 'located', 'rescued'],
  movementType: ['static', 'moving'],
  logModule: ['device', 'alarm', 'evacuation', 'inspection', 'route', 'lighting', 'person', 'system', '综合'],
  logLevel: ['info', 'success', 'warning', 'danger'],
  // Demo 状态机枚举（独立于 alarmStatus 与 planStatus）
  demoStage: DEMO_STAGES,
  demoCommand: DEMO_COMMANDS,
  // 三种运行模式
  runMode: ['mock', 'api', 'demo'],
}

// ── 通用工具 ──────────────────────────────────────────────
export function buildQuery(params = {}) {
  const q = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '' && !(typeof v === 'boolean' && !v && v !== 0))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
  return q.length ? `?${q.join('&')}` : ''
}

// ── Repository 接口（Mock 与 Api 双实现，方法签名一一对应） ──
// buildings:       { list(params?) }
// devices:         { list(params?), update(id, patch) }
// telemetry:       { list(params?), create(entry), createBatch(entries) }
// alarms:          { list(params?), get(id), create(alarm), update(id, patch) }
// inspections:     { list(params?), create(result) }
// evacuationPlans: { list(params?), get(id), create(plan), update(id, patch) }
// personPresence:  { list(params?), stats(), heatmap(), upsertBatch(persons) }
// operationLogs:   { list(params?), create(log) }

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

// ================== Demo 六阶段状态机（唯一定义） ==================
// 与 Alarm 七步事件流（pending→processing→reviewing→resolved）和
// EvacuationPlan 生命周期（NORMAL|WARNING|BLOCKED→CONFIRMED→EXECUTING→DONE）严格区分：
//   - 本状态机描述「一次消防处置演示的推进阶段」，属于 Demo Simulation Engine 的概念层；
//   - 阶段推进时会在 D1 中写入对应的 Alarm / EvacuationPlan / OperationLog 业务记录，
//     但三者状态字段各自独立，不互相覆盖。

export const DEMO_STAGES = [
  'IDLE',
  'FIRE_DETECTED',
  'EMERGENCY_RESPONSE',
  'ROUTE_PLANNING',
  'SMART_EVACUATION',
  'RETAINED_PERSONS',
  'RESCUE_COORDINATION',
  'COMPLETED',
] as const
export type DemoStage = (typeof DEMO_STAGES)[number]

export const DEMO_COMMANDS = [
  'START_FIRE',
  'ACTIVATE_RESPONSE',
  'PLAN_ROUTES',
  'CONFIRM_ROUTE',
  'COMPLETE_EVACUATION',
  'CONFIRM_RETAINED',
  'COMPLETE_RESCUE',
  'RESET',
] as const
export type DemoCommand = (typeof DEMO_COMMANDS)[number]

/** 状态转移表：当前阶段 → 允许的命令 → 目标阶段（未列出的组合一律视为非法转换） */
export const DEMO_TRANSITIONS: Record<DemoStage, Partial<Record<DemoCommand, DemoStage>>> = {
  IDLE: { START_FIRE: 'FIRE_DETECTED' },
  FIRE_DETECTED: { ACTIVATE_RESPONSE: 'EMERGENCY_RESPONSE', RESET: 'IDLE' },
  EMERGENCY_RESPONSE: { PLAN_ROUTES: 'ROUTE_PLANNING', RESET: 'IDLE' },
  ROUTE_PLANNING: { CONFIRM_ROUTE: 'SMART_EVACUATION', RESET: 'IDLE' },
  SMART_EVACUATION: { COMPLETE_EVACUATION: 'RETAINED_PERSONS', RESET: 'IDLE' },
  RETAINED_PERSONS: { CONFIRM_RETAINED: 'RESCUE_COORDINATION', RESET: 'IDLE' },
  RESCUE_COORDINATION: { COMPLETE_RESCUE: 'COMPLETED', RESET: 'IDLE' },
  COMPLETED: { RESET: 'IDLE' },
}

export interface StageMeta {
  id: DemoStage
  index: number          // 0=IDLE … 6=RESCUE_COORDINATION, 7=COMPLETED
  label: string          // 中文名（前端展示）
  command: DemoCommand | null  // 推进到下一阶段的命令
  next: DemoStage | null
  legacyStage: number    // 映射到前端既有 emergencyStage（0~6），仅用于兼容展示
}

export const STAGE_META: Record<DemoStage, StageMeta> = {
  IDLE: { id: 'IDLE', index: 0, label: '正常状态', command: 'START_FIRE', next: 'FIRE_DETECTED', legacyStage: 0 },
  FIRE_DETECTED: { id: 'FIRE_DETECTED', index: 1, label: '发现火灾', command: 'ACTIVATE_RESPONSE', next: 'EMERGENCY_RESPONSE', legacyStage: 1 },
  EMERGENCY_RESPONSE: { id: 'EMERGENCY_RESPONSE', index: 2, label: '启动应急响应', command: 'PLAN_ROUTES', next: 'ROUTE_PLANNING', legacyStage: 2 },
  ROUTE_PLANNING: { id: 'ROUTE_PLANNING', index: 3, label: '疏散路径规划', command: 'CONFIRM_ROUTE', next: 'SMART_EVACUATION', legacyStage: 3 },
  SMART_EVACUATION: { id: 'SMART_EVACUATION', index: 4, label: '智能疏散', command: 'COMPLETE_EVACUATION', next: 'RETAINED_PERSONS', legacyStage: 4 },
  RETAINED_PERSONS: { id: 'RETAINED_PERSONS', index: 5, label: '滞留人员识别', command: 'CONFIRM_RETAINED', next: 'RESCUE_COORDINATION', legacyStage: 5 },
  RESCUE_COORDINATION: { id: 'RESCUE_COORDINATION', index: 6, label: '协同消防救援', command: 'COMPLETE_RESCUE', next: 'COMPLETED', legacyStage: 6 },
  COMPLETED: { id: 'COMPLETED', index: 7, label: '处置完成', command: null, next: null, legacyStage: 6 },
}

/** 演示主流程（不含 IDLE / COMPLETED），供前端渲染六阶段进度条 */
export const DEMO_FLOW_STAGES: DemoStage[] = [
  'FIRE_DETECTED',
  'EMERGENCY_RESPONSE',
  'ROUTE_PLANNING',
  'SMART_EVACUATION',
  'RETAINED_PERSONS',
  'RESCUE_COORDINATION',
]

export function stageIndex(stage: DemoStage): number {
  return STAGE_META[stage]?.index ?? 0
}

export function availableCommands(stage: DemoStage): DemoCommand[] {
  return Object.keys(DEMO_TRANSITIONS[stage] ?? {}) as DemoCommand[]
}

export function nextStage(stage: DemoStage, command: DemoCommand): DemoStage | null {
  return DEMO_TRANSITIONS[stage]?.[command] ?? null
}

export function isLegalTransition(stage: DemoStage, command: DemoCommand): boolean {
  return Boolean(DEMO_TRANSITIONS[stage]?.[command])
}

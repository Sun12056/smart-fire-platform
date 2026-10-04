// ================== DemoRoom（Durable Object） ==================
// 职责边界：
//   ✅ 实时状态协调（六阶段状态机 + 人员/设备/灯光运行时）与 WebSocket 广播
//   ❌ 不做历史数据总线 —— 业务与历史数据由 D1 持久化（Alarm / EvacuationPlan / OperationLog / demo_*）
import { DurableObject } from 'cloudflare:workers'
import type { Env } from '../types'
import { availableCommands, isLegalTransition, nextStage, STAGE_META, DEMO_COMMANDS, type DemoCommand, type DemoStage } from '../demo/stages'
import {
  applyStageEffects, createWorld, resetWorld, retainedPersons, tickWorld,
  validateConfirmedBuildingPlan,
} from '../demo/engine'
import type { DemoBaseline, DemoWorld } from '../demo/world'
import type { DeviceRuntime, PersonRuntime } from '../demo/world'
import { fmtSH } from '../db'
// 人员运行时统一契约（P1.6.1）：后端 → WS → 2D/3D 同一套字段
import { normalizePersonRuntime } from '../../../shared/person/personRuntime.js'
// 设备运行时统一契约（P1.6.2）：后端 → WS → 2D/3D 同一套设备 id 与楼层归属
import { normalizeDeviceRuntime } from '../../../shared/device/deviceRuntime.js'

const TICK_MS = 1000
// v3：基线覆盖整栋楼各楼层（scope = BUILDING）且设备带 buildingId/floorId/zone，
// 旧缓存（v2）设备缺楼层归属字段，需失效重建
const BASELINE_KEY = 'baseline.v3'
const WORLD_KEY = 'world'
const DEFAULT_SCENARIO = { buildingId: 'B003', floorId: '5F', zone: 'A区' }

export class DemoRoom extends DurableObject<Env> {
  private world: DemoWorld | null = null
  private baseline: DemoBaseline | null = null

  // ── 生命周期 ──
  private async loadBaseline(): Promise<DemoBaseline> {
    if (this.baseline) return this.baseline
    const cached = await this.ctx.storage.get<DemoBaseline>(BASELINE_KEY)
    if (cached && cached.persons?.length) { this.baseline = cached; return cached }
    const db = this.env.DB
    const bld = await db.prepare('SELECT id, name FROM buildings WHERE id = ?').bind(DEFAULT_SCENARIO.buildingId).first<{ id: string; name: string }>()
    // 整栋楼疏散（scope = BUILDING）：基线必须覆盖整栋楼各楼层的人员与联动设备，
    // 否则「火灾在 5F、疏散只覆盖 5F」会与业务需求相悖。
    const personRows = await db.prepare(
      `SELECT id, building_id, floor_id, zone, x, y, status, movement_type FROM person_presence
       WHERE building_id = ? ORDER BY floor_id, id LIMIT 400`,
    ).bind(DEFAULT_SCENARIO.buildingId).all<Record<string, unknown>>()
    const deviceRows = await db.prepare(
      `SELECT id, type, building_id, floor_id, zone, status, current_mode, direction, brightness, emergency_flash FROM devices
       WHERE building_id = ? AND type IN ('evacuation_light','emergency_light','smoke_detector','radar_sensor') ORDER BY id LIMIT 600`,
    ).bind(DEFAULT_SCENARIO.buildingId).all<Record<string, unknown>>()

    const persons: PersonRuntime[] = (personRows.results ?? []).map((r) => ({
      id: String(r.id),
      buildingId: String(r.building_id),
      floorId: String(r.floor_id),
      zone: String(r.zone ?? ''),
      x: Number(r.x ?? 0),
      y: Number(r.y ?? 0),
      status: String(r.status ?? 'normal'),
      movementType: String(r.movement_type ?? 'static'),
      progress: 0,
      targetX: 840,
      targetY: 150,
      // 统一字段初始化：基线人员尚未分配路线
      routeId: null,
      route: [],
      routePoints: [],
      waypoint: 0,
      evacuating: false,
      retained: false,
      rescued: false,
    }))
    const devices: DeviceRuntime[] = (deviceRows.results ?? []).map((r) => ({
      id: String(r.id),
      type: String(r.type),
      // 楼层归属三元组（P1.6.2）：D1 devices.building_id / floor_id / zone 是唯一权威来源
      buildingId: String(r.building_id ?? DEFAULT_SCENARIO.buildingId),
      floorId: String(r.floor_id ?? ''),
      zone: String(r.zone ?? ''),
      status: String(r.status ?? 'normal'),
      currentMode: String(r.current_mode ?? 'daily'),
      direction: String(r.direction ?? 'right'),
      brightness: Number(r.brightness ?? 60),
      emergencyFlash: Number(r.emergency_flash ?? 0) === 1,
    }))
    this.baseline = { persons, devices }
    await this.ctx.storage.put(BASELINE_KEY, this.baseline)
    return this.baseline
  }

  private async loadWorld(): Promise<DemoWorld> {
    if (this.world) return this.world
    const stored = await this.ctx.storage.get<DemoWorld>(WORLD_KEY)
    if (stored?.sessionId) { this.world = stored; return stored }
    const baseline = await this.loadBaseline()
    const bld = await this.env.DB.prepare('SELECT name FROM buildings WHERE id = ?').bind(DEFAULT_SCENARIO.buildingId).first<{ name: string }>()
    const world = createWorld(this.ctx.id.toString(), {
      buildingId: DEFAULT_SCENARIO.buildingId,
      buildingName: bld?.name ?? DEFAULT_SCENARIO.buildingId,
      floorId: DEFAULT_SCENARIO.floorId,
      zone: DEFAULT_SCENARIO.zone,
    }, baseline, fmtSH())
    this.world = world
    await this.ctx.storage.put(WORLD_KEY, world)
    return world
  }

  private async saveWorld() {
    if (this.world) await this.ctx.storage.put(WORLD_KEY, this.world)
  }

  // ── HTTP / WebSocket 入口 ──
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const path = url.pathname.replace(/\/+$/, '')

    if (path.endsWith('/ws')) return this.handleWebSocketUpgrade(request)
    if (request.method === 'GET' && path.endsWith('/state')) {
      const world = await this.loadWorld()
      return json(this.snapshot(world))
    }
    if (request.method === 'POST' && path.endsWith('/command')) {
      const body = await request.json<{ command?: string; payload?: Record<string, unknown> }>().catch(() => ({}))
      return this.handleCommand(String(body.command ?? ''), body.payload ?? {})
    }
    if (request.method === 'POST' && path.endsWith('/reset')) {
      return this.handleCommand('RESET', {})
    }
    return json({ error: 'DemoRoom: 不支持的路径' }, 404)
  }

  private async handleWebSocketUpgrade(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return json({ error: '需要 WebSocket 升级请求' }, 426)
    }
    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket]
    this.ctx.acceptWebSocket(server)
    const world = await this.loadWorld()
    // 建立连接即下发全量快照，保证后加入的客户端状态一致
    server.send(JSON.stringify({ type: 'demo.snapshot', ...this.snapshot(world) }))
    return new Response(null, { status: 101, webSocket: client })
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (typeof message !== 'string') return
    let parsed: { type?: string } = {}
    try { parsed = JSON.parse(message) } catch { return }
    if (parsed.type === 'demo.ping') {
      ws.send(JSON.stringify({ type: 'demo.pong', at: fmtSH() }))
    } else if (parsed.type === 'demo.sync') {
      const world = await this.loadWorld()
      ws.send(JSON.stringify({ type: 'demo.snapshot', ...this.snapshot(world) }))
    }
  }

  async webSocketClose() { /* 连接关闭无需处理，重连由客户端负责 */ }
  async webSocketError() { /* 同上 */ }

  // ── 命令（状态机唯一入口） ──
  private async handleCommand(command: string, payload: Record<string, unknown>): Promise<Response> {
    const world = await this.loadWorld()
    if (!isCommand(command)) {
      return json({ error: `未知命令：${command}`, allowed: availableCommands(world.stage as DemoStage) }, 400)
    }
    const current = world.stage as DemoStage
    if (!isLegalTransition(current, command)) {
      return json({
        error: `非法状态转换：当前阶段 ${current} 不接受命令 ${command}`,
        stage: current,
        stageLabel: STAGE_META[current]?.label,
        allowed: availableCommands(current),
      }, 409)
    }
    // 阶段语义强校验：ROUTE_PLANNING 只能由 CONFIRM_ROUTE 推进到 SMART_EVACUATION，
    // 且必须是基于已生成的方案确认 —— 不允许「选择阶段」直接跳到疏散执行。
    const guard = this.guardCommand(current, command, world, payload)
    if (guard) return guard

    const target = nextStage(current, command) as DemoStage
    const at = fmtSH()

    // RESET 特殊处理：直接以基线重建世界（不进入阶段效果推导）
    if (command === 'RESET') {
      const base = await this.loadBaseline()
      this.world = resetWorld(world, base, at)
      await this.saveWorld()
      await this.env.DB.prepare('INSERT INTO operation_logs (module, action, detail, operator, level, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .bind('演示流程', '重置演示', '六阶段演示流程回到正常状态', '系统', 'info', at).run()
      await this.env.DB.prepare('INSERT INTO demo_events (session_id, seq, stage, action, detail, level, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(world.sessionId, this.world.seq + 1, 'IDLE', '重置演示', '状态机回到 IDLE', 'info', at).run()
      await this.env.DB.prepare('UPDATE demo_sessions SET stage = ?, updated_at = ?, completed = 0 WHERE id = ?')
        .bind('IDLE', at, world.sessionId).run()
      await this.ctx.storage.deleteAlarm()
      this.broadcast({ type: 'demo.stage', stage: 'IDLE', ...this.snapshot(this.world) })
      return json({ ok: true, ...this.snapshot(this.world), events: [] })
    }

    // ① 业务数据落 D1（Alarm / EvacuationPlan / OperationLog / demo_*）
    const sideEffect = await this.persistTransition(world, target, command, at, payload)

    // ② 内存态推进（仿真引擎）
    world.stage = target
    world.enteredAt = at
    const events = applyStageEffects(world, target, at, { ...payload, ...sideEffect })
    // 方案在引擎生成后落 D1（A/B/C 与执行中的方案都来自同一套规划器结果）
    await this.persistPlans(world, target, at)
    // 人员级操作在引擎推演之后补写 operationLogs（逐人 id / 位置 / 状态迁移与实际一致）
    await this.persistRetainedLogs(world, command, at)
    await this.saveWorld()

    // ③ 广播全量快照（阶段变化）
    this.broadcast({ type: 'demo.stage', stage: target, ...this.snapshot(world) })

    // ④ 疏散阶段开启定时器，进入实时动态推进
    if (target === 'SMART_EVACUATION') {
      await this.ctx.storage.setAlarm(Date.now() + TICK_MS)
    } else {
      await this.ctx.storage.deleteAlarm()
    }

    return json({ ok: true, ...this.snapshot(world), events })
  }

  // ── 定时推进（仅 SMART_EVACUATION 阶段，实时位置不落 D1） ──
  async alarm(): Promise<void> {
    const world = await this.loadWorld()
    if (!world) return
    if (world.stage !== 'SMART_EVACUATION') { await this.ctx.storage.deleteAlarm(); return }
    const moved = tickWorld(world, fmtSH())
    await this.saveWorld()
    if (moved) {
      this.broadcast({
        type: 'demo.tick',
        seq: world.seq,
        stage: world.stage,
        // 与 snapshot 同一套人员契约（同一 id / 同一 routeId）
        persons: personDTOs(world),
        metrics: world.metrics,
        evacuationSettled: world.evacuationSettled,
        at: world.updatedAt,
      })
    }
    if (world.stage === 'SMART_EVACUATION') {
      await this.ctx.storage.setAlarm(Date.now() + TICK_MS)
    }
  }

  /**
   * 疏散方案落库（引擎生成之后调用）：
   * 方案内容完全来自 shared/evacuation 规划器 —— exit_id / 距离 / 路径节点均为真实规划结果。
   */
  private async persistPlans(world: DemoWorld, target: DemoStage, at: string): Promise<void> {
    const db = this.env.DB
    const sc = world.scenario
    /**
     * ⚠️ LEGACY 落库：旧「单火灾区域 A/B/C 方案」只作为历史记录写入（type='zone'），
     * 不参与任何疏散决策；整栋楼方案见 upsertBuildingPlans（type='building'）。
     */
    const upsert = async (plan: DemoWorld['legacyPlans'][number], status: string) => {
      await db.prepare(`INSERT OR REPLACE INTO evacuation_plans
        (id, name, building_id, building_name, start_floor, start_area, exit_id, exit_label, type, status, recommended,
         floors_passed, path, extra, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(
          plan.id,
          `【LEGACY·单区域】演示${plan.name}·${sc.buildingName}${sc.floorId}`,
          sc.buildingId,
          sc.buildingName,
          sc.floorId,
          plan.startZones?.[0] || sc.zone,
          plan.exitId,
          plan.exitLabel,
          'zone',
          status,
          plan.recommended ? 1 : 0,
          JSON.stringify(plan.floorsPassed || [sc.floorId]),
          JSON.stringify(plan.nodes || []),
          JSON.stringify({
            distance: plan.distance,
            estimatedTime: plan.estimatedTime,
            riskLevel: plan.riskLevel,
            fireDistance: plan.fireDistance,
            escapeDistance: plan.escapeDistance,
            exitDistance: plan.exitDistance,
            congestion: plan.congestion,
            score: plan.score,
            points: plan.points || [],
          }),
          at,
          at,
        ).run()
    }

    if (target === 'ROUTE_PLANNING') {
      // LEGACY 历史（不参与决策）
      for (const plan of world.legacyPlans) await upsert(plan, 'NORMAL')
      await this.upsertBuildingPlans(world, at, 'NORMAL')
    } else if (target === 'SMART_EVACUATION') {
      for (const plan of world.legacyPlans) {
        await upsert(plan, plan.id === world.legacyActivePlanId ? 'EXECUTING' : 'NORMAL')
      }
      await this.upsertBuildingPlans(world, at, (bp) => (bp.id === world.activeBuildingPlanId ? 'EXECUTING' : 'NORMAL'))
    } else if (target === 'RETAINED_PERSONS' && world.activeBuildingPlanId) {
      for (const plan of world.legacyPlans) {
        await upsert(plan, plan.id === world.legacyActivePlanId ? 'DONE' : 'NORMAL')
      }
      await this.upsertBuildingPlans(world, at, (bp) => (bp.id === world.activeBuildingPlanId ? 'DONE' : 'NORMAL'))
    }
  }

  /**
   * 整栋楼方案落库（权威）：一行 = 一栋楼的一套策略（routes / routesByZone / summary 存 extra）。
   * type = 'building'，供 GET /api/v1/building-evacuation-plans 读取；
   * 旧的 GET /api/v1/evacuation-plans（legacy）会排除这些行，两者不再混在一起。
   */
  private async upsertBuildingPlans(
    world: DemoWorld,
    at: string,
    statusOf: string | ((bp: DemoWorld['buildingPlans'][number]) => string),
  ): Promise<void> {
    const db = this.env.DB
    const sc = world.scenario
    const statusVal = (bp: DemoWorld['buildingPlans'][number]) =>
      (typeof statusOf === 'string' ? statusOf : statusOf(bp))
    for (const bp of world.buildingPlans) {
      await db.prepare(`INSERT OR REPLACE INTO evacuation_plans
        (id, name, building_id, building_name, start_floor, start_area, exit_id, exit_label, type, status, recommended,
         floors_passed, path, extra, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(
          bp.id,
          `${bp.name}·${sc.buildingName}整栋楼疏散（${bp.summary.zoneCount}区/${bp.summary.personCount}人）`,
          sc.buildingId,
          sc.buildingName,
          sc.floorId,
          sc.zone,
          Object.keys(bp.summary?.exits || {}).join(','),
          (bp.summary?.exitLabels || []).join('、'),
          'building',
          statusVal(bp),
          bp.recommended ? 1 : 0,
          JSON.stringify(bp.summary?.floors || [sc.floorId]),
          JSON.stringify((bp.routes || []).map((r) => r.nodes)),
          JSON.stringify({
            scope: bp.scope,
            strategy: bp.strategy,
            strategyLabel: bp.strategyLabel,
            evacuationScope: bp.scope,
            summary: bp.summary,
            routes: bp.routes,
            routesByZone: Object.keys(bp.routesByZone || {}),
            fire: bp.fire,
          }),
          at,
          at,
        ).run()
    }
  }

  /**
   * 命令前置校验（阶段语义，而非转移表）：
   *   - CONFIRM_ROUTE 必须先有方案，且指定方案必须存在（禁止凭空进入 SMART_EVACUATION）
   */
  private guardCommand(
    stage: DemoStage,
    command: DemoCommand,
    world: DemoWorld,
    payload: Record<string, unknown>,
  ): Response | null {
    if (command === 'CONFIRM_ROUTE') {
      // ① 必须有整栋楼方案（旧 legacyPlans 不再作为门禁）
      if (!world.buildingPlans.length) {
        return json({
          error: '当前没有可执行的整栋楼疏散方案，请先完成路线规划',
          stage,
          stageLabel: STAGE_META[stage]?.label,
          allowed: availableCommands(stage),
        }, 409)
      }
      // ② 必须显式携带 buildingPlanId（禁止只确认火源区 / 只确认某楼层 / 只确认 A 区）
      const buildingPlanId = payload.buildingPlanId ? String(payload.buildingPlanId) : null
      if (!buildingPlanId) {
        return json({
          error: 'CONFIRM_ROUTE 必须携带 buildingPlanId（PLAN-A/B/C 整栋楼方案）',
          stage,
          stageLabel: STAGE_META[stage]?.label,
          allowed: availableCommands(stage),
          buildingPlans: world.buildingPlans.map((p) => ({ id: p.id, name: p.name, scope: p.scope, strategy: p.strategy })),
        }, 409)
      }
      const exact = world.buildingPlans.find((p) => p.id === buildingPlanId)
      if (!exact) {
        return json({
          error: `整栋楼方案 ${buildingPlanId} 不存在，请从 PLAN-A/B/C 中选择`,
          stage,
          stageLabel: STAGE_META[stage]?.label,
          allowed: availableCommands(stage),
          buildingPlans: world.buildingPlans.map((p) => ({ id: p.id, name: p.name, scope: p.scope, strategy: p.strategy })),
        }, 409)
      }
      // ③ evacuationScope 必须为 BUILDING（火灾只描述位置，疏散范围恒为整栋楼）
      if (exact.scope !== 'BUILDING' || world.evacuationScope !== 'BUILDING') {
        return json({
          error: `疏散范围必须为 BUILDING，实际为 ${exact.scope}`,
          stage,
          stageLabel: STAGE_META[stage]?.label,
          allowed: availableCommands(stage),
        }, 409)
      }
      // ④ buildingId 一致 + 所有有人 floor+zone 都有合法 route（逐条过 routeValidator）
      const v = validateConfirmedBuildingPlan(world, exact)
      if (!v.ok) {
        return json({
          error: v.error,
          detail: v.detail,
          stage,
          stageLabel: STAGE_META[stage]?.label,
          allowed: availableCommands(stage),
          buildingPlans: world.buildingPlans.map((p) => ({ id: p.id, name: p.name, scope: p.scope, strategy: p.strategy })),
        }, 409)
      }
    }
    return null
  }

  // ── D1 落库：业务数据与历史（不做实时状态存储） ──
  private async persistTransition(
    world: DemoWorld,
    target: DemoStage,
    command: DemoCommand,
    at: string,
    payload: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    const db = this.env.DB
    const extra: Record<string, unknown> = {}
    const sc = world.scenario
    const log = (action: string, detail: string, level = 'info') =>
      db.prepare('INSERT INTO operation_logs (module, action, detail, operator, level, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .bind('演示流程', action, detail, '系统', level, at).run()
    const evt = (action: string, detail: string, level = 'info', stage = target) =>
      db.prepare('INSERT INTO demo_events (session_id, seq, stage, action, detail, level, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(world.sessionId, world.seq + 1, stage, action, detail, level, at).run()

    // 会话历史
    await db.prepare(`INSERT INTO demo_sessions (id, stage, building_id, floor_id, zone, started_at, updated_at, completed)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET stage = excluded.stage, updated_at = excluded.updated_at,
        completed = excluded.completed, started_at = CASE WHEN excluded.stage = 'IDLE' THEN excluded.updated_at ELSE demo_sessions.started_at END`)
      .bind(world.sessionId, target, sc.buildingId, sc.floorId, sc.zone, at, at, target === 'COMPLETED' ? 1 : 0).run()

    switch (command) {
      case 'START_FIRE': {
        const alarmId = `AL-${Date.now()}-DEMO`
        extra.alarmId = alarmId
        await db.prepare(`INSERT OR REPLACE INTO alarms (id, device_id, building_id, floor_id, zone, type, level, status, progress, description, occurred_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .bind(alarmId, 'FN-GROUP', sc.buildingId, sc.floorId, sc.zone, '模拟火灾告警', 'danger', 'pending', 10,
            `${sc.buildingName}${sc.floorId}${sc.zone}检测到火情，烟感探测器触发告警`, at, at, at).run()
        await log('发现火灾', `${sc.buildingName} ${sc.floorId}-${sc.zone} 感知设备上报火情`, 'danger')
        await evt('发现火灾', `${sc.buildingName} ${sc.floorId}-${sc.zone}`, 'danger')
        break
      }
      case 'ACTIVATE_RESPONSE': {
        if (world.alarmId) {
          await db.prepare('UPDATE alarms SET status = ?, progress = ?, updated_at = ? WHERE id = ?')
            .bind('processing', 30, at, world.alarmId).run()
        }
        await log('启动应急响应', '应急照明强闪、疏散指示反向、标记风险人员', 'warning')
        await evt('启动应急响应', '联动应急照明与疏散指示', 'warning')
        break
      }
      case 'PLAN_ROUTES': {
        // 方案由仿真引擎（shared/evacuation 规划器）生成后落库，见 persistPlans()
        await log('生成疏散方案', '系统自动生成多套合法疏散方案', 'success')
        await evt('生成疏散方案', '多套疏散方案已生成', 'success')
        break
      }
      case 'CONFIRM_ROUTE': {
        // 权威：整栋楼方案（buildingPlans + activeBuildingPlanId）
        const bp = world.buildingPlans.find((p) => p.id === world.activeBuildingPlanId) || null
        await log(
          '确认疏散路径',
          bp
            ? `执行整栋楼方案「${bp.name}」（scope=${bp.scope}）：${bp.summary.zoneCount} 个区域 / ${bp.summary.personCount} 人 / ${bp.summary.routeCount} 条路线，出口 ${bp.summary.exitLabels.join('、') || '安全出口'}`
            : '执行整栋楼疏散方案',
          'danger',
        )
        await evt('确认疏散路径', `管理员确认执行整栋楼方案 ${bp?.name ?? ''}（${bp?.id ?? ''}）`, 'danger')
        break
      }
      case 'COMPLETE_EVACUATION': {
        // 方案生命周期置为 DONE（EvacuationPlan 生命周期，与 Demo 阶段互相独立）
        // 操作日志（含逐人 id / 位置 / 状态迁移）在 applying stage effects 后补写，见 persistRetainedLogs()
        await evt('识别滞留人员', '进入 RETAINED_PERSONS 阶段', 'warning')
        break
      }
      case 'CONFIRM_RETAINED': {
        await evt('确认滞留人员位置', `${retainedPersons(world).length} 人待救援`, 'warning')
        break
      }
      case 'COMPLETE_RESCUE': {
        if (world.alarmId) {
          await db.prepare('UPDATE alarms SET status = ?, progress = ?, handled_at = ?, handled_by = ?, updated_at = ? WHERE id = ?')
            .bind('resolved', 100, at, '消防救援队', at, world.alarmId).run()
        }
        await evt('协同救援完成', '处置闭环', 'success')
        break
      }
    }
    return extra
  }

  /**
   * P2 确定性滞留：人员级操作必须在「仿真引擎推演出真实结果」之后写 operation_logs，
   * 这样日志里的逐人 id / 楼层位置 / 状态迁移与实际完全一致（全部操作进 operationLogs）。
   */
  private async persistRetainedLogs(world: DemoWorld, command: DemoCommand, at: string): Promise<void> {
    const db = this.env.DB
    const write = (action: string, detail: string, level: string, operator: string) =>
      db.prepare('INSERT INTO operation_logs (module, action, detail, operator, level, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .bind('演示流程', action, detail, operator, level, at).run()
    const people = (list: PersonRuntime[]) =>
      list.map((p) => `${p.id}（${p.floorId}-${p.zone}）`).join('、') || '无'

    if (command === 'COMPLETE_EVACUATION') {
      const stranded = retainedPersons(world)
      await write(
        '识别滞留人员',
        stranded.length
          ? `疏散结束：${stranded.length} 名滞留人员 ${people(stranded)}，状态 evacuating → stranded，位置冻结等待管理员确认`
          : '疏散结束：固定候选名单内无滞留人员，全部人员已安全撤离',
        stranded.length ? 'warning' : 'success',
        '系统',
      )
    }
    if (command === 'CONFIRM_RETAINED') {
      const located = retainedPersons(world).filter((p) => p.status === 'located')
      await write(
        '确认滞留人员位置',
        `管理员确认 ${located.length} 名滞留人员位置：${people(located)}，状态 stranded → located`,
        'warning',
        '管理员',
      )
    }
    if (command === 'COMPLETE_RESCUE') {
      const rescued = Object.values(world.persons).filter((p) => p.rescued)
      await write(
        '协同救援完成',
        `滞留人员 ${rescued.length} 人已救出：${people(rescued)}，状态 located → rescued`,
        'success',
        '消防救援队',
      )
    }
  }

  // ── 广播 / 快照 ──
  private broadcast(message: Record<string, unknown>) {
    const payload = JSON.stringify(message)
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(payload) } catch { /* 单个连接异常不影响其他连接 */ }
    }
  }

  private snapshot(world: DemoWorld) {
    const meta = STAGE_META[world.stage as DemoStage] ?? STAGE_META.IDLE
    return {
      sessionId: world.sessionId,
      seq: world.seq,
      stage: world.stage,
      stageIndex: meta.index,
      stageLabel: meta.label,
      nextCommand: meta.command,
      nextStage: meta.next,
      allowedCommands: availableCommands(world.stage as DemoStage),
      fire: world.fire,
      alarmId: world.alarmId,
      // ⚠️ LEGACY：旧单区域方案（仅历史/旧接口兼容，前端不得用它做疏散决策）
      plans: world.legacyPlans,
      activePlanId: world.legacyActivePlanId,
      // 权威：整栋楼疏散方案（scope = BUILDING）：前端 2D/3D 与人员路线都以此为准
      buildingPlans: world.buildingPlans,
      activeBuildingPlanId: world.activeBuildingPlanId,
      evacuationScope: world.evacuationScope,
      lighting: world.lighting,
      metrics: world.metrics,
      rescue: world.rescue,
      // 人员：统一契约（id/buildingId/floorId/zone/status/routeId/routePoints/progress/position）
      persons: personDTOs(world),
      // 设备：统一契约（id/type/buildingId/floorId/zone/status/currentMode/direction/brightness/emergencyFlash）
      devices: deviceDTOs(world),
      eventLog: world.eventLog.slice(0, 30),
      evacuationSettled: world.evacuationSettled,
      tick: world.tick,
      enteredAt: world.enteredAt,
      updatedAt: world.updatedAt,
      serverTime: fmtSH(),
    }
  }
}

/**
 * 人员运行时 → 统一 wire 结构（P1.6.1）
 * 后端是唯一权威：routeId / routePoints / progress / position 全部来自 PersonRuntime，
 * 经 shared/person/personRuntime 规范化后下发，2D（fireStore）与 3D（PersonLayer3D）直接消费。
 */
function personDTOs(world: DemoWorld) {
  return Object.values(world.persons).map((p) => normalizePersonRuntime(p, {
    buildingId: p.buildingId || world.scenario.buildingId,
    floorId: p.floorId,
    zone: p.zone,
  }))
}

/**
 * 设备运行时 → 统一 wire 结构（P1.6.2）
 * 后端是唯一权威：buildingId / floorId / zone 来自 D1 devices（设备的楼层归属），
 * status / currentMode / direction / brightness 来自 DeviceRuntime 当前状态；
 * 前端（fireStore）凭 (buildingId, floorId) 即可把快照设备准确定位到楼层。
 */
function deviceDTOs(world: DemoWorld) {
  return Object.values(world.devices).map((d) => normalizeDeviceRuntime(d, {
    buildingId: d.buildingId || world.scenario.buildingId,
    floorId: d.floorId,
    zone: d.zone,
  }))
}

function isCommand(v: string): v is DemoCommand {
  return (DEMO_COMMANDS as readonly string[]).includes(v)
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  })
}

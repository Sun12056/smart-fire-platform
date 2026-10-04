// ================== DemoRoom（Durable Object） ==================
// 职责边界：
//   ✅ 实时状态协调（六阶段状态机 + 人员/设备/灯光运行时）与 WebSocket 广播
//   ❌ 不做历史数据总线 —— 业务与历史数据由 D1 持久化（Alarm / EvacuationPlan / OperationLog / demo_*）
import { DurableObject } from 'cloudflare:workers'
import type { Env } from '../types'
import { availableCommands, isLegalTransition, nextStage, STAGE_META, DEMO_COMMANDS, type DemoCommand, type DemoStage } from '../demo/stages'
import { applyStageEffects, createWorld, resetWorld, retainedPersons, tickWorld } from '../demo/engine'
import type { DemoBaseline, DemoWorld } from '../demo/world'
import type { DeviceRuntime, PersonRuntime } from '../demo/world'
import { fmtSH } from '../db'

const TICK_MS = 1000
const BASELINE_KEY = 'baseline'
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
    const personRows = await db.prepare(
      `SELECT id, building_id, floor_id, zone, x, y, status, movement_type FROM person_presence
       WHERE building_id = ? AND floor_id = ? ORDER BY id LIMIT 400`,
    ).bind(DEFAULT_SCENARIO.buildingId, DEFAULT_SCENARIO.floorId).all<Record<string, unknown>>()
    const deviceRows = await db.prepare(
      `SELECT id, type, status, current_mode, direction, brightness, emergency_flash FROM devices
       WHERE building_id = ? AND floor_id = ? AND type IN ('evacuation_light','emergency_light','smoke_detector','radar_sensor') ORDER BY id LIMIT 400`,
    ).bind(DEFAULT_SCENARIO.buildingId, DEFAULT_SCENARIO.floorId).all<Record<string, unknown>>()

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
      evacuating: false,
      retained: false,
      rescued: false,
    }))
    const devices: DeviceRuntime[] = (deviceRows.results ?? []).map((r) => ({
      id: String(r.id),
      type: String(r.type),
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
    const sideEffect = await this.persistTransition(world, target, command, at)

    // ② 内存态推进（仿真引擎）
    world.stage = target
    world.enteredAt = at
    const events = applyStageEffects(world, target, at, { ...payload, ...sideEffect })
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
        persons: Object.values(world.persons),
        metrics: world.metrics,
        evacuationSettled: world.evacuationSettled,
        at: world.updatedAt,
      })
    }
    if (world.stage === 'SMART_EVACUATION') {
      await this.ctx.storage.setAlarm(Date.now() + TICK_MS)
    }
  }

  // ── D1 落库：业务数据与历史（不做实时状态存储） ──
  private async persistTransition(
    world: DemoWorld,
    target: DemoStage,
    command: DemoCommand,
    at: string,
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
        // 方案由引擎生成后落库（此处先按三出口生成占位，状态 NORMAL）
        await log('生成疏散方案', '系统自动生成多套合法疏散方案', 'success')
        await evt('生成疏散方案', '多套疏散方案已生成', 'success')
        break
      }
      case 'CONFIRM_ROUTE': {
        await log('确认疏散路径', `执行方案，出口 ${world.plans.find((p) => p.recommended)?.exitLabel ?? '安全出口'}`, 'danger')
        await evt('确认疏散路径', '管理员确认执行疏散方案', 'danger')
        break
      }
      case 'COMPLETE_EVACUATION': {
        if (world.activePlanId) {
          await db.prepare(`INSERT OR REPLACE INTO evacuation_plans
            (id, name, building_id, building_name, start_floor, start_area, exit_id, exit_label, type, status, recommended,
             floors_passed, path, extra, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .bind(world.activePlanId, `演示方案·${sc.buildingName}${sc.floorId}`, sc.buildingId, sc.buildingName, sc.floorId, sc.zone,
              'EXIT-E', '东侧安全出口', 'auto', 'DONE', 1, JSON.stringify([sc.floorId]), JSON.stringify([]), JSON.stringify({}), at, at).run()
        }
        await log('识别滞留人员', '疏散完成，自动识别滞留人员', 'warning')
        await evt('识别滞留人员', '进入 RETAINED_PERSONS 阶段', 'warning')
        break
      }
      case 'CONFIRM_RETAINED': {
        const retained = retainedPersons(world)
        await log('确认滞留人员位置', `已锁定 ${retained.length} 名滞留人员`, 'warning')
        await evt('确认滞留人员位置', `${retained.length} 人待救援`, 'warning')
        break
      }
      case 'COMPLETE_RESCUE': {
        if (world.alarmId) {
          await db.prepare('UPDATE alarms SET status = ?, progress = ?, handled_at = ?, handled_by = ?, updated_at = ? WHERE id = ?')
            .bind('resolved', 100, at, '消防救援队', at, world.alarmId).run()
        }
        await log('协同救援完成', '滞留人员全部救出，处置闭环完成', 'success')
        await evt('协同救援完成', '处置闭环', 'success')
        break
      }
    }
    return extra
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
      plans: world.plans,
      activePlanId: world.activePlanId,
      lighting: world.lighting,
      metrics: world.metrics,
      rescue: world.rescue,
      persons: Object.values(world.persons),
      devices: Object.values(world.devices),
      eventLog: world.eventLog.slice(0, 30),
      evacuationSettled: world.evacuationSettled,
      tick: world.tick,
      enteredAt: world.enteredAt,
      updatedAt: world.updatedAt,
      serverTime: fmtSH(),
    }
  }
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

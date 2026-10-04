// ================== Demo Simulation Engine ==================
// 纯函数层：只负责「给定阶段，推导世界状态与事件」，不含 IO。
// Durable Object 负责调用本引擎并广播；D1 负责业务与历史落库。
import { STAGE_META, type DemoStage } from './stages'
import type {
  DemoEvent, DemoPlan, DemoWorld, DeviceRuntime, PersonRuntime, BuildingEvacuationPlan,
} from './world'
// 疏散路线唯一算法来源（与前端、3D 共用同一份）：shared/evacuation
import { planEvacuationRoutes } from '../../../shared/evacuation/routePlanner.js'
import { buildBuildingGraph } from '../../../shared/evacuation/routeGraph.js'
// 整栋楼疏散：一次火灾 = 一栋楼的一次整体疏散任务（火灾只描述位置，不改变疏散范围）
import {
  planBuildingStrategies, routeOfPerson, groupPersonsByZone, resolvePlanningZone,
} from '../../../shared/evacuation/buildingEvacuationPlanner.js'
import { zoneKeyOf } from '../../../shared/evacuation/buildingEvacuationTypes.js'

// ── 确定性伪随机（同一 session 可复现，避免演示每次不一样） ──
function seededRand(seedStr: string) {
  let h = 2166136261
  for (let i = 0; i < seedStr.length; i++) { h ^= seedStr.charCodeAt(i); h = Math.imul(h, 16777619) }
  return () => { h = Math.imul(h ^ (h >>> 15), 2246822507); h ^= h >>> 13; return (h >>> 0) / 4294967296 }
}

/** 楼层拓扑与路线算法一律来自 shared/evacuation，后端不再自带出口常量 */
const MAX_FLOOR = 6

export interface DemoBaseline {
  persons: PersonRuntime[]
  devices: DeviceRuntime[]
}

export function createWorld(sessionId: string, scenario: DemoWorld['scenario'], baseline: DemoBaseline, at: string): DemoWorld {
  const persons: Record<string, PersonRuntime> = {}
  for (const p of baseline.persons) {
    persons[p.id] = {
      ...p,
      progress: 0,
      targetX: p.x,
      targetY: p.y,
      // 统一字段初始化（P1.6.1）：未下发方案时 routeId 恒为 null，routePoints 恒为 []
      routeId: null,
      route: [],
      routePoints: [],
      waypoint: 0,
      evacuating: false,
      retained: false,
      rescued: false,
    }
  }
  const devices: Record<string, DeviceRuntime> = {}
  for (const d of baseline.devices) devices[d.id] = { ...d }

  return {
    sessionId,
    seq: 0,
    stage: 'IDLE',
    scenario,
    fire: null,
    alarmId: null,
    // ⚠️ LEGACY：仅历史/旧接口兼容，不参与疏散决策
    legacyPlans: [],
    legacyActivePlanId: null,
    buildingPlans: [],
    activeBuildingPlanId: null,
    evacuationScope: 'BUILDING',
    persons,
    devices,
    lighting: { mode: 'daily', brightness: 60, pulse: false, updatedAt: at },
    metrics: { total: Object.keys(persons).length, evacuating: 0, evacuated: 0, retained: 0, rescued: 0, riskZones: 0 },
    rescue: { active: false, completed: false, task: null },
    eventLog: [],
    tick: 0,
    evacuationSettled: false,
    enteredAt: at,
    updatedAt: at,
  }
}

/** 重置到 IDLE，并基于基线恢复人员/设备 */
export function resetWorld(world: DemoWorld, baseline: DemoBaseline, at: string): DemoWorld {
  const fresh = createWorld(world.sessionId, world.scenario, baseline, at)
  fresh.seq = world.seq
  return fresh
}

function pushEvent(world: DemoWorld, action: string, detail: string, level: DemoEvent['level'], at: string) {
  world.seq += 1
  world.eventLog.unshift({ id: `EV-${world.sessionId}-${world.seq}`, seq: world.seq, at, stage: world.stage, action, detail, level })
  if (world.eventLog.length > 200) world.eventLog.pop()
}

/**
 * 应用阶段转移后的世界状态（仅内存态）；返回本次产生的事件列表，供 DO 落库与广播。
 * 注意：本函数不修改 stage，stage 由状态机（stages.ts）决定。
 */
export function applyStageEffects(
  world: DemoWorld,
  stage: DemoStage,
  at: string,
  payload: Record<string, unknown> = {},
): DemoEvent[] {
  const before = world.eventLog.length
  const scenario = world.scenario
  const personList = () => Object.values(world.persons)
  const floorPersons = () => personList().filter((p) => p.buildingId === scenario.buildingId && p.floorId === scenario.floorId)
  const fireZonePersons = () => floorPersons().filter((p) => p.zone === scenario.zone)
  const floorDevices = () => Object.values(world.devices).filter((d) => true)

  switch (stage) {
    case 'IDLE':
      break

    case 'FIRE_DETECTED': {
      world.fire = {
        id: `FE-${Date.now()}`,
        buildingId: scenario.buildingId,
        buildingName: scenario.buildingName,
        floorId: scenario.floorId,
        zone: scenario.zone,
        level: 'danger',
        detectedAt: at,
      }
      world.alarmId = payload.alarmId ? String(payload.alarmId) : world.alarmId
      for (const d of floorDevices()) {
        if (d.type === 'smoke_detector') { d.status = 'warning'; d.currentMode = 'daily' }
      }
      world.metrics.riskZones = 1
      pushEvent(world, '发现火灾', `${scenario.buildingName} ${scenario.floorId}-${scenario.zone} 感知设备上报火情`, 'danger', at)
      break
    }

    case 'EMERGENCY_RESPONSE': {
      const rand = seededRand(world.sessionId + scenario.zone)
      for (const d of floorDevices()) {
        if (d.type !== 'emergency_light' && d.type !== 'evacuation_light') continue
        d.status = 'emergency'
        d.currentMode = 'emergency'
        d.brightness = 100
        d.emergencyFlash = true
        // 指向火源的疏散指示灯自动反向（确定性：按 id 奇偶决定初始朝向）
        if (d.type === 'evacuation_light') {
          const headingToFire = rand() > 0.5
          if (headingToFire) d.direction = d.direction === 'left' ? 'right' : 'left'
        }
      }
      fireZonePersons().forEach((p) => { p.status = 'warning'; p.movementType = 'static' })
      world.lighting = { mode: 'emergency', brightness: 100, pulse: true, updatedAt: at }
      pushEvent(world, '启动应急响应', '应急照明强闪+疏散指示反向，火源区人员标记为风险', 'warning', at)
      break
    }

    case 'ROUTE_PLANNING': {
      // ⚠️ LEGACY：火源区域的 A/B/C 候选路线，只写 world.legacyPlans（历史/旧接口），
      // 不再作为任何决策依据；整栋楼方案的唯一来源是下面的 buildingPlans。
      const congestion = fireZonePersons().length || floorPersons().length
      const { plans } = planEvacuationRoutes({
        floorId: scenario.floorId,
        zone: scenario.zone,
        fireZone: scenario.zone,
        maxFloor: MAX_FLOOR,
        congestion,
        limit: 3,
        idPrefix: `PLAN-${world.sessionId}`,
      })
      world.legacyPlans = plans as DemoPlan[]
      // 整栋楼疏散方案（scope = BUILDING）：火灾只作为动态障碍，疏散范围始终是一栋楼
      // PLAN-A/B/C = 均衡 / 快速 / 安全，每套覆盖全部「有人员的 floorId + zone」
      const buildingRes = planBuildingStrategies({
        buildingId: scenario.buildingId,
        buildingName: scenario.buildingName,
        persons: buildingPersons(world).map((p) => ({
          id: p.id, buildingId: p.buildingId, floorId: p.floorId, zone: p.zone, status: p.status,
        })),
        fire: { buildingId: scenario.buildingId, floorId: scenario.floorId, zone: scenario.zone },
        maxFloor: MAX_FLOOR,
        idPrefix: 'PLAN',
      })
      world.buildingPlans = buildingRes.plans as unknown as BuildingEvacuationPlan[]
      world.activeBuildingPlanId = (world.buildingPlans.find((p) => p.recommended) || world.buildingPlans[0])?.id ?? null
      world.evacuationScope = 'BUILDING'
      if (!world.buildingPlans.length) {
        pushEvent(
          world,
          '整栋楼路线规划失败',
          '未找到覆盖全部有人区域的合法路线，请检查火情与人员分布',
          'danger',
          at,
        )
        break
      }
      {
        const a = world.buildingPlans[0]
        pushEvent(
          world,
          '生成整栋楼疏散方案',
          `${scenario.buildingName} 整体疏散（火灾 ${scenario.floorId}-${scenario.zone}）：`
            + `PLAN-A/B/C = 均衡/快速/安全，覆盖 ${a.summary.zoneCount} 个有人区域 / ${a.summary.personCount} 人，`
            + `最慢 ${a.summary.maxEstimatedTime}s，出口 ${a.summary.exitLabels.join('、') || '—'}`,
          'success',
          at,
        )
      }
      break
    }

    case 'SMART_EVACUATION': {
      // ── 唯一权威：整栋楼方案 ──
      // 确认的永远是 PLAN-A/B/C 整栋楼策略；旧 world.legacyPlans 只做历史镜像，
      // 绝不用它补路线（禁止「只确认火源区 / 只确认 5F / 只确认 A 区」）。
      const bp = resolveBuildingPlan(
        world,
        payload.buildingPlanId ? String(payload.buildingPlanId) : (payload.planId ? String(payload.planId) : null),
      )
      if (!bp) {
        pushEvent(
          world,
          '确认疏散路径失败',
          '未指定可执行的整栋楼疏散方案（CONFIRM_ROUTE 必须携带 buildingPlanId）',
          'danger',
          at,
        )
        break
      }
      world.activeBuildingPlanId = bp.id
      world.evacuationScope = 'BUILDING'
      world.buildingPlans.forEach((p) => { p.status = p.id === bp.id ? 'EXECUTING' : 'NORMAL' })
      // ⚠️ LEGACY 镜像：仅让旧结构的状态字段跟随（历史展示），不影响任何路线计算
      const legacyMirror = world.legacyPlans.find((p) => p.name?.endsWith(bp.strategyLabel))
        || world.legacyPlans.find((p) => p.recommended)
        || world.legacyPlans[0]
        || null
      if (legacyMirror) {
        world.legacyActivePlanId = legacyMirror.id
        world.legacyPlans.forEach((p) => { p.status = p.id === legacyMirror.id ? 'EXECUTING' : 'NORMAL' })
      }

      // 整栋楼人员：每人按自己 floorId+zone 的路线撤离（火灾只影响路线走向，不影响参与范围）
      const bg = buildBuildingGraph(MAX_FLOOR)
      buildingPersons(world).forEach((p) => {
        // 走廊等公共区域没有房间节点 → 与规划阶段同一套归属规则，保证人人取到路线
        const zone = resolvePlanningZone(bg, p)
        const route = routeOfPerson(bp, { floorId: p.floorId, zone })
        p.evacuating = true
        p.status = 'evacuating'
        p.movementType = 'moving'
        p.progress = 0
        if (route) {
          // routeId = `${planId}:${floorId}:${zone}` —— 2D / 3D / 后端同一个 id
          p.routeId = route.routeId
          p.route = route.nodes
          p.routePoints = route.points.map((pt) => ({ x: pt.x, y: pt.y }))
        } else {
          // 整栋楼方案已校验过「所有有人区域都有路线」，这里理论上不可达
          p.routeId = null
          p.route = []
          p.routePoints = []
        }
        p.waypoint = 0
        const last = p.routePoints[p.routePoints.length - 1]
        if (last) { p.targetX = last.x; p.targetY = last.y }
      })
      world.metrics.evacuating = buildingPersons(world).length
      world.evacuationSettled = false
      pushEvent(
        world,
        '确认疏散路径',
        `执行整栋楼方案「${bp.name}」（${bp.strategyLabel}·${bp.strategy}）：`
          + `${bp.summary.zoneCount} 个区域 / ${bp.summary.personCount} 人 / ${bp.summary.routeCount} 条路线，`
          + `最慢 ${bp.summary.maxEstimatedTime}s，出口 ${bp.summary.exitLabels.join('、') || '—'}`,
        'danger',
        at,
      )
      break
    }

    case 'RETAINED_PERSONS': {
      // 整栋楼疏散：未完成撤离的人员来自全楼（不再只看火警楼层）
      const unfinished = buildingPersons(world).filter((p) => p.evacuating && p.progress < 1)
      let retained = unfinished
      // 若所有人都已撤离，则按确定性规则在火源区保留人员，保证救援阶段有真实对象
      if (!retained.length) {
        retained = (fireZonePersons().length ? fireZonePersons() : buildingPersons(world)).slice(0, 2)
      }
      retained.forEach((p) => {
        p.evacuating = false
        p.retained = true
        p.status = 'stranded'
        p.movementType = 'static'
      })
      // 整栋楼方案：执行结束置 DONE（EvacuationPlan 生命周期，与阶段互相独立）
      world.buildingPlans.forEach((p) => { if (p.status === 'EXECUTING') p.status = 'DONE' })
      // ⚠️ LEGACY 镜像：旧结构状态置 DONE（历史），不影响任何路线计算
      world.legacyPlans.forEach((p) => { if (p.status === 'EXECUTING') p.status = 'DONE' })
      recomputeMetrics(world)
      pushEvent(world, '识别滞留人员', `识别滞留人员 ${retained.length} 人，等待确认位置后协同救援`, 'warning', at)
      break
    }

    case 'RESCUE_COORDINATION': {
      retainedPersons(world).forEach((p) => { p.status = 'located' })
      world.rescue = {
        active: true,
        completed: false,
        task: {
          id: `RT-${Date.now()}`,
          teams: ['微型消防站', '消防巡逻队', '疏散引导员'],
          targetZone: `${scenario.buildingName} ${scenario.floorId}-${scenario.zone}`,
          status: '救援进行中',
          startedAt: at,
        },
      }
      recomputeMetrics(world)
      pushEvent(world, '确认滞留人员位置', `已锁定 ${retainedPersons(world).length} 名滞留人员位置，救援力量出动`, 'warning', at)
      break
    }

    case 'COMPLETED': {
      retainedPersons(world).forEach((p) => { p.status = 'rescued'; p.rescued = true })
      if (world.rescue.task) {
        world.rescue.task.status = '救援完成'
        world.rescue.completed = true
      }
      recomputeMetrics(world)
      pushEvent(world, '协同救援完成', '滞留人员全部救出，处置闭环完成', 'success', at)
      break
    }
  }

  world.updatedAt = at
  return world.eventLog.slice(0, world.eventLog.length - before)
}

function routeLength(pts: Array<{ x: number; y: number }>): number {
  let s = 0
  for (let i = 0; i < pts.length - 1; i++) {
    s += Math.sqrt((pts[i + 1].x - pts[i].x) ** 2 + (pts[i + 1].y - pts[i].y) ** 2)
  }
  return Math.max(s, 1)
}

/** 当前位置到路线终点的剩余长度 */
function remainingLength(pts: Array<{ x: number; y: number }>, waypoint: number, x: number, y: number): number {
  const nextIdx = waypoint + 1
  let s = 0
  if (pts[nextIdx]) s += Math.sqrt((pts[nextIdx].x - x) ** 2 + (pts[nextIdx].y - y) ** 2)
  for (let i = nextIdx; i < pts.length - 1; i++) {
    s += Math.sqrt((pts[i + 1].x - pts[i].x) ** 2 + (pts[i + 1].y - pts[i].y) ** 2)
  }
  return s
}

export function retainedPersons(world: DemoWorld): PersonRuntime[] {
  return Object.values(world.persons).filter((p) => p.retained && !p.rescued)
}

/** 整栋楼参与疏散的人员（疏散范围 = BUILDING，与火灾所在楼层无关） */
export function buildingPersons(world: DemoWorld): PersonRuntime[] {
  return Object.values(world.persons).filter((p) => p.buildingId === world.scenario.buildingId)
}

/**
 * 解析「要执行的整栋楼方案」：优先精确匹配 planId，
 * 其次把旧的火源区方案 id（...-A/B/C）映射到同策略的整栋楼方案，最后回退推荐方案。
 */
export function resolveBuildingPlan(world: DemoWorld, requestedId?: string | null): BuildingEvacuationPlan | null {
  const list = world.buildingPlans || []
  if (!list.length) return null
  if (requestedId) {
    const exact = list.find((p) => p.id === requestedId)
    if (exact) return exact
    const m = /(?:^|[-_])([ABC])$/.exec(String(requestedId))
    if (m) {
      const byLabel = list.find((p) => p.strategyLabel === m[1] || p.id === `PLAN-${m[1]}`)
      if (byLabel) return byLabel
    }
  }
  return list.find((p) => p.recommended) || list[0] || null
}

/**
 * CONFIRM_ROUTE 的整栋楼校验（阶段 3 → 4 的前置条件）：
 *   · plan.scope === BUILDING
 *   · buildingId 与火灾楼栋一致
 *   · 所有「有人员的 floorId + zone」都存在合法 route
 *   · 每条 route 都通过 shared/evacuation 的 validateRoute
 */
export function validateConfirmedBuildingPlan(
  world: DemoWorld,
  plan: BuildingEvacuationPlan | null,
): { ok: boolean; error?: string; detail?: Record<string, unknown> } {
  if (!world.buildingPlans.length) {
    return { ok: false, error: '当前没有整栋楼疏散方案，请先完成路线规划' }
  }
  if (!plan) return { ok: false, error: '未找到可执行的整栋楼方案（PLAN-A/B/C）' }
  if (plan.scope !== 'BUILDING') {
    return { ok: false, error: `疏散范围必须为 BUILDING，实际为 ${plan.scope}` }
  }
  if (String(plan.buildingId) !== String(world.scenario.buildingId)) {
    return { ok: false, error: `方案楼栋 ${plan.buildingId} 与火情楼栋 ${world.scenario.buildingId} 不一致` }
  }
  const groups = groupPersonsByZone(buildingPersons(world).map((p) => ({
    id: p.id, buildingId: p.buildingId, floorId: p.floorId, zone: p.zone, status: p.status, x: p.x, y: p.y,
  })), { buildingId: world.scenario.buildingId, graph: buildBuildingGraph(MAX_FLOOR) })
  const missing = groups.filter((g) => !plan.routesByZone || !plan.routesByZone[zoneKeyOf(g.floorId, g.zone)])
  const invalid = (plan.routes || []).filter((r) => !r.valid)
  if (missing.length || invalid.length) {
    return {
      ok: false,
      error: `整栋楼方案不完整：${missing.length} 个有人区域缺少路线、${invalid.length} 条路线未通过校验`,
      detail: {
        missing: missing.map((g) => g.zoneKey),
        invalid: invalid.map((r) => r.routeId),
      },
    }
  }
  return { ok: true }
}

export function recomputeMetrics(world: DemoWorld) {
  const list = Object.values(world.persons)
  world.metrics.total = list.length
  world.metrics.evacuating = list.filter((p) => p.evacuating).length
  world.metrics.evacuated = list.filter((p) => p.progress >= 1 && !p.retained).length
  world.metrics.retained = list.filter((p) => p.retained && !p.rescued).length
  world.metrics.rescued = list.filter((p) => p.rescued).length
}

/**
 * 一个仿真 tick：仅在 SMART_EVACUATION 阶段推进人员位置（实时动态），
 * 位置数据只存在于 DO 内存并经 WS 广播，不写入 D1。
 */
export function tickWorld(world: DemoWorld, at: string): boolean {
  if (world.stage !== 'SMART_EVACUATION') return false
  world.tick += 1
  const rand = seededRand(`${world.sessionId}-${world.tick}`)
  let moving = 0
  for (const p of Object.values(world.persons)) {
    if (!p.evacuating) continue
    // 沿规划路线的折线推进（waypoint 逐段前进），不再是「直线穿墙扑向出口」
    const pts = p.routePoints && p.routePoints.length ? p.routePoints : null
    if (pts) {
      // 演示节奏：每 tick（1s）推进约 55px，整条路线约 8~12s 走完
      const step = 55 + rand() * 20
      let remain = step
      while (remain > 0 && p.waypoint < pts.length - 1) {
        const cur = { x: p.x, y: p.y }
        const next = pts[p.waypoint + 1]
        const dx = next.x - cur.x
        const dy = next.y - cur.y
        const d = Math.sqrt(dx * dx + dy * dy)
        if (d <= 0.5) { p.waypoint += 1; continue }
        if (d <= remain) {
          p.x = next.x
          p.y = next.y
          p.waypoint += 1
          remain -= d
        } else {
          p.x = Number((cur.x + (dx / d) * remain).toFixed(1))
          p.y = Number((cur.y + (dy / d) * remain).toFixed(1))
          remain = 0
        }
      }
      const total = routeLength(pts)
      const walked = total - remainingLength(pts, p.waypoint, p.x, p.y)
      p.progress = Math.min(1, Number((walked / Math.max(total, 1)).toFixed(3)))
      if (p.waypoint >= pts.length - 1) p.progress = 1
    } else {
      p.progress = Math.min(1, p.progress + 0.08 + rand() * 0.06)
      p.x = Number((p.x + (p.targetX - p.x) * 0.12).toFixed(1))
      p.y = Number((p.y + (p.targetY - p.y) * 0.12).toFixed(1))
    }
    if (p.progress >= 1) {
      p.evacuating = false
      p.status = 'safe'
      p.movementType = 'static'
    } else {
      moving += 1
    }
  }
  recomputeMetrics(world)
  world.updatedAt = at
  world.evacuationSettled = moving === 0
  world.seq += 1
  return true
}

/** 阶段推进时的补充上下文（前端展示用） */
export function stageSnapshotMeta(world: DemoWorld) {
  const meta = STAGE_META[world.stage as DemoStage] ?? STAGE_META.IDLE
  return {
    stage: world.stage,
    stageIndex: meta.index,
    stageLabel: meta.label,
    nextCommand: meta.command,
    nextStage: meta.next,
  }
}

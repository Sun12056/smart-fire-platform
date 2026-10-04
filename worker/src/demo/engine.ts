// ================== Demo Simulation Engine ==================
// 纯函数层：只负责「给定阶段，推导世界状态与事件」，不含 IO。
// Durable Object 负责调用本引擎并广播；D1 负责业务与历史落库。
import { STAGE_META, type DemoStage } from './stages'
import type {
  DemoEvent, DemoPlan, DemoWorld, DeviceRuntime, PersonRuntime,
} from './world'

// ── 确定性伪随机（同一 session 可复现，避免演示每次不一样） ──
function seededRand(seedStr: string) {
  let h = 2166136261
  for (let i = 0; i < seedStr.length; i++) { h ^= seedStr.charCodeAt(i); h = Math.imul(h, 16777619) }
  return () => { h = Math.imul(h ^ (h >>> 15), 2246822507); h ^= h >>> 13; return (h >>> 0) / 4294967296 }
}

const EXIT_NODES: Array<{ id: string; label: string; x: number; y: number }> = [
  { id: 'EXIT-E', label: '东侧安全出口', x: 840, y: 150 },
  { id: 'EXIT-W', label: '西侧安全出口', x: 60, y: 150 },
  { id: 'EXIT-N', label: '北侧安全出口', x: 450, y: 60 },
]

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
      targetX: EXIT_NODES[0].x,
      targetY: EXIT_NODES[0].y,
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
    plans: [],
    activePlanId: null,
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
      world.plans = EXIT_NODES.map((n, i) => ({
        id: `PLAN-${world.sessionId}-${i + 1}`,
        name: `方案${i + 1}·经${n.label}`,
        exitId: n.id,
        exitLabel: n.label,
        distance: Number((28 + i * 9.5).toFixed(1)),
        estimatedTime: 42 + i * 11,
        congestion: Math.max(1, Math.round(floorPersons().length * (0.5 - i * 0.12))),
        recommended: i === 0,
        status: 'NORMAL' as const,
      }))
      pushEvent(world, '生成疏散方案', `已生成 ${world.plans.length} 套合法疏散方案，推荐：${world.plans[0].name}`, 'success', at)
      break
    }

    case 'SMART_EVACUATION': {
      const requested = payload.planId ? String(payload.planId) : null
      const plan = world.plans.find((p) => p.id === requested) || world.plans.find((p) => p.recommended)
      if (plan) {
        world.activePlanId = plan.id
        world.plans.forEach((p) => { p.status = p.id === plan.id ? 'EXECUTING' : 'NORMAL' })
      }
      const exitNode = EXIT_NODES.find((n) => n.id === plan?.exitId) || EXIT_NODES[0]
      floorPersons().forEach((p) => {
        p.evacuating = true
        p.status = 'evacuating'
        p.movementType = 'moving'
        p.progress = 0
        p.targetX = exitNode.x
        p.targetY = exitNode.y
      })
      world.metrics.evacuating = floorPersons().length
      world.evacuationSettled = false
      pushEvent(world, '确认疏散路径', `执行方案「${plan?.name ?? '推荐方案'}」，出口 ${plan?.exitLabel ?? exitNode.label}`, 'danger', at)
      break
    }

    case 'RETAINED_PERSONS': {
      const unfinished = floorPersons().filter((p) => p.progress < 1)
      let retained = unfinished
      // 若所有人都已撤离，则按确定性规则在火源区保留人员，保证救援阶段有真实对象
      if (!retained.length) {
        retained = fireZonePersons().slice(0, 2)
      }
      retained.forEach((p) => {
        p.evacuating = false
        p.retained = true
        p.status = 'stranded'
        p.movementType = 'static'
      })
      world.plans.forEach((p) => { if (p.status === 'EXECUTING') p.status = 'DONE' })
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

export function retainedPersons(world: DemoWorld): PersonRuntime[] {
  return Object.values(world.persons).filter((p) => p.retained && !p.rescued)
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
    p.progress = Math.min(1, p.progress + 0.08 + rand() * 0.06)
    // 沿直线向出口插值
    p.x = Number((p.x + (p.targetX - p.x) * 0.12).toFixed(1))
    p.y = Number((p.y + (p.targetY - p.y) * 0.12).toFixed(1))
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

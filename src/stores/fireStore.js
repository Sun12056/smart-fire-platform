import { defineStore } from 'pinia'
import { ref, computed, watch } from 'vue'
import { buildings as initialBuildings, updateBuildingStatus } from '../mock/buildings'
import {
  devices as initialDevices,
  getDeviceStats,
  getDeviceTypeStats,
  nodeTypes,
  directionMap,
} from '../mock/devices'
import { alarms as initialAlarms, getAlarmStats } from '../mock/alarms'
import { statistics as initialStats } from '../mock/statistics'
import { rescueResources, emergencySteps } from '../mock/rescue'
import {
  persons as initialPersons,
  personStats as initialPersonStats,
  personTrend,
  zoneHeatmap,
} from '../mock/person'
import {
  lightingModes,
  lightingDevices as initialLightingDevices,
  defaultLighting as initialLightingStatus,
  brightnessHistory as initialBrightnessHistory,
} from '../mock/lighting'
import {
  inspectionItems,
  inspectionSteps as initialInspectionSteps,
  inspectionHistory as initialInspectionHistory,
  inspectionDevices as initialInspectionDevices,
  generateInspectionResult,
} from '../mock/inspection'
import {
  evacuationDevices as initialEvacuationDevices,
  initialEvacuationLogs,
} from '../mock/evacuation'
// 建筑拓扑唯一数据源：shared/evacuation（与 Worker Demo Engine、3D 同一张图）
// ⚠️ mock/routeGraph.js 只是旧签名兼容层，不要再从中取拓扑
import {
  buildBuildingGraph, kShortestPaths, dijkstra, edgeKey, nodeId as sharedNodeId,
  exitIdsOf, ZONE_NODE_KEY,
} from '../../shared/evacuation/routeGraph.js'
// 整栋楼疏散（scope = BUILDING）：一次火灾 = 一栋楼的一次整体疏散任务
import {
  planBuildingStrategies, routeOfPerson as buildingRouteOfPerson, validateBuildingEvacuationPlan,
  resolvePlanningZone,
} from '../../shared/evacuation/buildingEvacuationPlanner.js'
import { EVACUATION_SCOPE, STRATEGY, zoneKeyOf } from '../../shared/evacuation/buildingEvacuationTypes.js'
// 人员运行时统一契约（P1.6.1）：后端 / 2D / 3D 同一个 id、同一个 routeId
import {
  normalizePersonRuntime, assignPersonRuntime, isCanonicalPerson, pickRetainedCandidates,
} from '../../shared/person/personRuntime.js'
// 设备运行时统一契约（P1.6.2）：后端 / 2D / 3D 同一个设备 id、同一个楼层归属（buildingId/floorId/zone）
import {
  normalizeDeviceRuntime, assignDeviceRuntime, isCanonicalDevice,
  devicesOnFloor, floorsOfDevices, deviceInBuilding,
} from '../../shared/device/deviceRuntime.js'
import {
  ROOM_AREAS,
  ZONE_COLORS,
  FLOOR_HEIGHT_M,
  EVAC_SPEED,
  STAIR_PENALTY_S,
  validateRoute,
} from '../mock/routeGraph'
import { generateFloorDevices, FLOOR_CONFIG, ROOMS as PLAN_ROOMS, STAIRS as PLAN_STAIRS, DOORS as PLAN_DOORS } from '../mock/floorPlanData'
import { buildSeedDevices } from '../mock/deviceSeed'
// 双数据源（mock / api）与 Service 层 —— 见 docs/API_CONTRACT.md
import { dataSource } from '../api'
import { buildingService } from '../services/buildingService'
import { deviceService } from '../services/deviceService'
import { alarmService } from '../services/alarmService'
import { inspectionService } from '../services/inspectionService'
import { personPresenceService } from '../services/personPresenceService'
import { operationLogService } from '../services/operationLogService'
// P1.7.2 / P1-04：demo 模式下业务按钮只派发命令给后端状态机（demoStore），不在前端自行推进阶段。
// 反向依赖仅在函数体内使用（demoStore → fireStore 的存在性依赖在主 Store 建立时已解析）。
import { useDemoStore } from './demoStore'

export const useFireStore = defineStore('fire', () => {
  // ================== State ==================
  const buildings = ref(Array.isArray(initialBuildings) ? [...initialBuildings] : [])
  // 设备统一来自平面空间数据（floorPlanData 生成，4 栋 × 6 层，含坐标/方向/所属区域），不再使用旧 mock 台账
  // 统一契约（P1.6.2）：每台设备都有 buildingId / floorId / zone，可与后端 WS 快照按 id 对齐
  const devices = ref(normalizeDevices(buildSeedDevices()))
  const alarms = ref(Array.isArray(initialAlarms) ? [...initialAlarms] : [])
  const stats = ref(initialStats && typeof initialStats === 'object' ? { ...initialStats } : {})
  const selectedBuilding = ref(null)
  const selectedDevice = ref(null)
  const currentEmergency = ref(null)
  const rescueList = ref(Array.isArray(rescueResources) ? [...rescueResources] : [])
  const emergencyStepList = ref(Array.isArray(emergencySteps) ? [...emergencySteps] : [])
  const notifications = ref([])
  const demoMode = ref(false)
  const updateTime = ref(new Date().toLocaleString('zh-CN'))

  // 人员感知（统一契约：id/buildingId/floorId/zone/status/routeId/routePoints/progress/position）
  // 旧的 building / floor / area / x / y 只是只读别名，由统一字段派生（兼容旧组件与 SVG 模板）
  const persons = ref(normalizePersons(initialPersons))
  const personStats = ref(initialPersonStats && typeof initialPersonStats === 'object' ? { ...initialPersonStats } : {})
  // 人员初始坐标/状态基线（重置演示后恢复；不对外导出）
  let personsOrigin = normalizePersons(initialPersons)

  /** 批量规范化人员（统一字段 + 只读别名），mock 与远端数据一律经过这里 */
  function normalizePersons(list) {
    return (Array.isArray(list) ? list : []).map((p) => normalizePersonRuntime(p))
  }

  /** 批量规范化设备（统一字段 + 只读取别名），mock 与远端数据一律经过这里 */
  function normalizeDevices(list) {
    return (Array.isArray(list) ? list : []).map((d) => normalizeDeviceRuntime(d))
  }

  /**
   * 设备楼层归属（P1.6.2 核心能力）：WS 快照 / REST / mock 三种来源都按 buildingId + floorId 定位。
   * 返回 [{ floorId, count }]，楼层按 1F → 6F 升序。
   */
  function deviceFloorsOfBuilding(buildingId) {
    return floorsOfDevices(devices.value, buildingId).map((floorId) => ({
      floorId,
      count: devicesOnFloor(devices.value, buildingId, floorId).length,
    }))
  }

  /** 统一字段完整性自检（E2E 用）：返回不符合设备契约的设备数 */
  function countNonCanonicalDevices() {
    return asArray(devices.value).filter((d) => !isCanonicalDevice(d)).length
  }

  /** 位置同步：x / y（旧别名）↔ position（统一字段），2D/3D 读到的始终是同一份坐标 */
  function syncPersonPosition(p) {
    if (!p) return p
    if (Number.isFinite(p.x) && Number.isFinite(p.y)) p.position = { x: p.x, y: p.y }
    return p
  }

  // ── 远程数据源（api / demo 模式经 Service 层加载 Workers/D1 数据） ──
  // 重要：远端失败时【不静默回退 mock】，必须显式置位 remoteError / dataSourceDegraded 交由 UI 告警，
  // 避免真实系统出现“数据假象”。
  const remoteReady = ref(false)
  const remoteError = ref(null)
  const dataSourceDegraded = ref(false)
  async function initFromRemote() {
    if (!dataSource.isRemote || remoteReady.value) return false
    try {
      const [blds, devs, alms, insps, ppl, logs] = await Promise.all([
        buildingService.list(),
        deviceService.list(),
        alarmService.list(),
        inspectionService.list(),
        personPresenceService.list(),
        operationLogService.list({ limit: 200 }),
      ])
      if (Array.isArray(blds) && blds.length) buildings.value = blds
      // 远端设备同样升级为统一字段（D1 行已含 buildingId / floorId / zone，与后端 DeviceRuntime 同一套 id）
      if (Array.isArray(devs) && devs.length) devices.value = normalizeDevices(devs)
      if (Array.isArray(alms) && alms.length) alarms.value = alms
      if (Array.isArray(insps) && insps.length) inspectionHistory.value = insps
      if (Array.isArray(ppl) && ppl.length) {
        // 远端人员同样升级为统一字段（D1 行含 buildingId/floorId/zone，与后端 PersonRuntime 同一套 id）
        persons.value = normalizePersons(ppl)
        personsOrigin = JSON.parse(JSON.stringify(persons.value))
      }
      if (Array.isArray(logs) && logs.length) {
        operationLogs.value = logs
      }
      refreshBuildings()
      refreshStats()
      refreshPersonStats()
      remoteReady.value = true
      remoteError.value = null
      dataSourceDegraded.value = false
      console.info('[fireStore] 远程数据源初始化完成（Workers → D1）')
      return true
    } catch (err) {
      // 不静默回退：记录错误并标记降级，由 UI 明确提示当前数据并非真实后端数据
      remoteReady.value = false
      dataSourceDegraded.value = true
      remoteError.value = err?.message || String(err)
      console.error('[fireStore] 远程数据源初始化失败，未加载真实数据：', err?.message || err)
      return false
    }
  }

  // ── 阶段二：应用后端 Demo 状态机快照（前端不自行推演，仅镜像后端状态） ──
  const STAGE_TO_LEGACY = { IDLE: 0, FIRE_DETECTED: 1, EMERGENCY_RESPONSE: 2, ROUTE_PLANNING: 3, SMART_EVACUATION: 4, RETAINED_PERSONS: 5, RESCUE_COORDINATION: 6, COMPLETED: 6 }

  const RISK_CN = { LOW: '低', MEDIUM: '中', HIGH: '高' }

  /** 后端方案（shared/evacuation 规划器输出）→ 前端渲染结构（含 3D 使用的 path） */
  function toRenderablePlan(plan, ctx) {
    const path = (plan.points || []).map((pt, i) => {
      const id = (plan.nodes || [])[i] || ''
      const [floorId, key] = String(id).split(':')
      return {
        id,
        floorId: floorId || ctx.floorId,
        key: key || '',
        x: pt.x,
        y: pt.y,
        type: /^EXIT_/.test(key) ? 'exit'
          : /^STAIR_/.test(key) ? 'stair'
            : /^CORRIDOR/.test(key) ? 'corridor' : 'room',
      }
    })
    return {
      ...plan,
      buildingId: ctx.buildingId,
      buildingName: ctx.buildingName,
      startFloor: ctx.floorId,
      startArea: (plan.startZones && plan.startZones[0]) || ctx.zone,
      exit: plan.exitId,
      exitSide: /EXIT_E/.test(plan.exitId) ? 'right' : 'left',
      corridor: '走廊',
      stair: (plan.nodes || []).find((n) => /STAIR_/.test(n)) || '楼梯',
      floorsPassed: plan.floorsPassed || [ctx.floorId],
      riskLevel: RISK_CN[plan.riskLevel] || '低',
      type: 'auto',
      zoneColor: ZONE_COLORS[(plan.startZones && plan.startZones[0]) || ctx.zone] || '#4361EE',
      deviceCount: 0,
      path,
    }
  }

  /**
   * 清空疏散方案与疏散运行时（后端 RESET → IDLE 时调用）。
   * 下一轮演练不允许继承上一轮的疏散方案：方案集合 / activeBuildingPlanId /
   * 楼栋方案缓存 / 疏散执行态 / 滞留与救援状态 / 路线-设备联动 全部回到初始值。
   */
  function clearEvacuationRuntime() {
    stopEvacuationSim()
    if (rescueTimer) { clearTimeout(rescueTimer); rescueTimer = null }
    buildingEvacuationPlans.value = []
    activeBuildingPlanId.value = null
    buildingPlanCache.value = {}
    buildingPlanActiveCache.value = {}
    activeRoutePlanId.value = null
    routePlans.value = []
    routeMatrix.value = null
    routeDeviceBindings.value = []
    routeFireAutoSwitch.value = false
    routeDecisionConfirmed.value = false
    evacRun.value = false
    evacStats.value = { total: 0, evacuated: 0, remaining: 0, pct: 0 }
    strandedPersons.value = []
    rescueState.value = false
    rescueTask.value = null
    strandedLocated.value = false
    rescueCompleted.value = false
    setEmergencyMode(false)
  }

  /** 用后端方案刷新前端路线矩阵（平面图 2D / 3D 都读这里） */
  function applyDemoPlans(snap) {
    // 权威：后端下发的是「整栋楼」方案（scope=BUILDING），包含每个有人区域的路线
    if (Array.isArray(snap.buildingPlans) && snap.buildingPlans.length) {
      applyBuildingPlans(snap)
      return
    }
    // 后端明确「没有整栋楼方案」（RESET → IDLE）：清空上一轮方案，禁止继承
    if (Array.isArray(snap.buildingPlans) && snap.buildingPlans.length === 0) {
      clearEvacuationRuntime()
      return
    }
    // ⚠️ LEGACY 兜底：仅当后端未下发整栋楼方案（旧版本后端）时才走旧的火源区投影，
    // 这里产生的 routeMatrix.perZone 只是只读展示，不参与疏散决策。
    const zone = snap.fire?.zone || 'A区'
    const floorId = snap.fire?.floorId || routeFloorId.value || '5F'
    const ctx = {
      floorId,
      zone,
      buildingId: snap.fire?.buildingId || 'B003',
      buildingName: snap.fire?.buildingName || '3号楼',
    }
    routePlans.value = (snap.plans || []).map((p) => toRenderablePlan(p, ctx))
    const activeId = snap.activePlanId
      || (routePlans.value.find((p) => p.recommended) || {}).id
      || routePlans.value[0]?.id
      || null
    activeRoutePlanId.value = activeId
    routeMatrix.value = {
      buildingId: ctx.buildingId,
      buildingName: ctx.buildingName,
      floorId,
      areas: [zone],
      exits: [...new Set(routePlans.value.map((p) => p.exitId))],
      perZone: {
        [zone]: {
          plans: routePlans.value,
          recommendedId: activeId,
          backupId: routePlans.value[1]?.id || null,
        },
      },
    }
  }

  // ══════════ 用户确认语义（P1.7.2 / P0-01）══════════
  // 「已查看火情」「已确认火情」是管理员的业务动作，不是阶段，也不是 WS 的镜像字段。
  // 一次火情实例 = 后端 fire.id（每次 START_FIRE 由状态机生成新的 FE-<ts>）：
  //   · 同一实例内 —— 用户关掉/确认过的弹窗，后续 WS 快照不得重新打开；
  //   · 换一次实例（新一轮演示）或 RESET 回 IDLE —— 记账自动失效，第二轮弹窗正常出现。
  const alertAckFireId = ref(null)
  const alertViewed = ref(false)
  const fireAcknowledged = ref(false)

  /** ① 用户点「查看火情」：弹窗①关闭，本次火情实例内不再由快照重新弹出 */
  function dismissFireAlert() {
    const fe = fireEvent.value
    if (!fe) return false
    alertAckFireId.value = String(fe.id || '')
    alertViewed.value = true
    fireAlertVisible.value = false
    addOperationLog('查看火情', '演示流程', `${fe.building} ${fe.floor} ${fe.area}`, 'info')
    return true
  }

  /**
   * ② 用户点「确认火情」：显式业务确认（非 Toast），写后台日志，不改变任何阶段。
   * demo 模式下没有「确认火情」这个后端命令（六阶段状态迁移由 ACTIVATE_RESPONSE 承担），
   * 因此这里只记录确认语义，阶段仍以后端 snapshot 为准。
   */
  function confirmFireAcknowledged() {
    const fe = fireEvent.value
    if (!fe) return false
    alertAckFireId.value = String(fe.id || '')
    alertViewed.value = true
    fireAlertVisible.value = false
    fireAcknowledged.value = true
    fireConfirmed.value = true
    addOperationLog('确认火情', '演示流程', `管理员已确认 ${fe.building} ${fe.floor} ${fe.area} 发生真实火情`, 'danger')
    return true
  }

  /**
   * demo 模式统一派发入口（P1.7.2 / P1-04）：
   * 业务按钮 → demoStore command → WebSocket → Durable Object → snapshot。
   * ① 后端当前阶段不允许该命令时直接忽略（禁止前端撬动阶段，也避免重复点击造成非法转换）；
   * ② 非 demo 模式返回 null，交给原有本地业务实现处理。
   */
  function dispatchDemoCommand(command, runner) {
    if (!dataSource.isDemo) return null
    const demo = useDemoStore()
    if (!(demo.allowedCommands || []).includes(command)) {
      console.warn(`[fireStore] demo 模式忽略指令 ${command}：当前阶段 ${demo.stage} 不允许该命令`)
      return Promise.resolve(null)
    }
    return typeof runner === 'function' ? runner(demo) : Promise.resolve(null)
  }

  function applyDemoSnapshot(snap) {
    if (!snap) return
    // ① 阶段：唯一来源是后端状态机
    if (snap.stage) {
      const legacy = STAGE_TO_LEGACY[snap.stage] ?? 0
      // 用户确认语义按「火情实例」记账：新实例 → 重新弹一次；老实例 → 以用户动作为准
      const fid = snap.fire ? String(snap.fire.id || '') : null
      if (fid !== alertAckFireId.value) {
        alertAckFireId.value = fid
        alertViewed.value = false
        fireAcknowledged.value = false
      }
      emergencyStage.value = legacy
      fireAlertVisible.value = legacy >= 1 && !alertViewed.value
      fireConfirmed.value = fireAcknowledged.value || legacy >= 2
      emergencyResponseConfirmed.value = legacy >= 2
      routeDecisionConfirmed.value = legacy >= 4
    }
    // ② 火情
    if (snap.fire) {
      // canonical 三元组是唯一权威：buildingId / floorId / zone
      // building / floor / area 只是由 canonical 派生的只读别名（供旧 UI 读，禁止反向写回）
      const fireBuildingId = snap.fire.buildingId || buildingIdFromName(snap.fire.buildingName)
      const fireFloorId = snap.fire.floorId
      const fireZone = snap.fire.zone
      fireEvent.value = {
        id: snap.fire.id,
        buildingId: fireBuildingId,
        floorId: fireFloorId,
        zone: fireZone,
        building: snap.fire.buildingName || snap.fire.buildingId,
        floor: fireFloorId,
        area: fireZone,
        level: snap.fire.level || 'danger',
        time: snap.fire.detectedAt,
        status: (STAGE_TO_LEGACY[snap.stage] ?? 0) >= 2 ? 'active' : 'pending',
      }
    } else if (snap.stage === 'IDLE') {
      fireEvent.value = null
      fireAlertVisible.value = false
      fireConfirmed.value = false
      emergencyResponseConfirmed.value = false
      routeDecisionConfirmed.value = false
      emergencyStage.value = 0
      // 清空后端运行时路线，人员回到基线位置（避免残留 routePoints 导致复位后仍沿旧路线）
      // 统一字段：复位只清空「值」，不删除字段（否则 2D/3D 读到的不再是统一契约）
      asArray(persons.value).forEach((p) => {
        if (!p) return
        delete p.route
        delete p.waypoint
        delete p.evacuating
        delete p.retained
        delete p.rescued
        // P1.6.1：_evac / _evacDone 是 mock 本地疏散运行态，复位时必须一并清掉，
        // 否则 demo 模式下 3D（路线优先级 ②mock _evac）会残留本地模拟路线
        delete p._evac
        delete p._evacDone
        p.routePoints = []
        p.progress = 0
        p.routeId = null
        p._stranded = false
      })
    }
    // ②·补充：疏散方案 —— 前端/3D 直接复用后端规划器的结果（同一套路线，不再各算一套）
    // 后端「没有方案」同样是权威信息（RESET → IDLE），必须触发前端方案复位
    if (Array.isArray(snap.plans) || Array.isArray(snap.buildingPlans)) applyDemoPlans(snap)
    // ③ 人员（按 id 合并后端运行时）
    if (Array.isArray(snap.persons)) applyDemoPersons(snap.persons)
    // ④ 设备（按 id 合并后端运行时：状态 / 模式 / 方向 / 亮度 + 楼层归属 buildingId/floorId/zone）
    if (Array.isArray(snap.devices)) {
      const dmap = new Map(snap.devices.map((d) => [String(d.id), d]))
      asArray(devices.value).forEach((d) => {
        const r = dmap.get(String(d.id))
        if (!r) return
        assignDeviceRuntime(d, r)
      })
    }
    // ⑤ 照明
    if (snap.lighting) {
      lightingStatus.value = {
        ...lightingStatus.value,
        brightness: snap.lighting.brightness ?? lightingStatus.value?.brightness,
        currentMode: snap.lighting.mode === 'emergency'
          ? (lightingModes.emergency || lightingStatus.value?.currentMode)
          : lightingStatus.value?.currentMode,
      }
      emergencyMode.value = snap.lighting.mode === 'emergency'
    }
    // ⑥ 疏散指标
    if (snap.metrics) {
      const m = snap.metrics
      evacStats.value = {
        total: m.total ?? 0,
        evacuated: m.evacuated ?? 0,
        remaining: (m.evacuating ?? 0) + (m.retained ?? 0),
        pct: m.total ? Math.round(((m.evacuated ?? 0) / m.total) * 100) : 0,
      }
      evacRun.value = (m.evacuating ?? 0) > 0
    }
    // ⑦ 滞留人员与协同救援
    const retained = asArray(persons.value).filter((p) => ['stranded', 'located'].includes(p.status))
    strandedPersons.value = retained
    if (snap.rescue) {
      rescueState.value = !!snap.rescue.active
      rescueCompleted.value = !!snap.rescue.completed
      rescueTask.value = snap.rescue.task
      strandedLocated.value = !!snap.rescue.active
    }
    // ⑧ 事件流水 → 后台日志（按事件 id 去重）
    if (Array.isArray(snap.eventLog)) {
      const known = new Set(asArray(evacuationLogs.value).map((l) => l.id))
      snap.eventLog.forEach((e) => {
        if (known.has(e.id)) return
        evacuationLogs.value.unshift({
          id: e.id,
          time: String(e.at || '').slice(11) || new Date().toLocaleTimeString('zh-CN'),
          action: e.action,
          detail: e.detail,
          operator: '后端状态机',
          level: e.level,
        })
      })
      if (evacuationLogs.value.length > 200) evacuationLogs.value.length = 200
    }
    refreshBuildings()
    refreshStats()
    refreshPersonStats()
  }

  /**
   * 后端人员运行时 → 2D 人员对象（P1.6.1 统一契约）
   * 按 id 合并（后端 / 2D / 3D 同一个人员 id），只写后端下发的权威字段：
   * routeId / routePoints / progress / position 一律来自后端，前端不推导。
   */
  function applyDemoPersons(list) {
    const pmap = new Map((Array.isArray(list) ? list : []).map((p) => [String(p.id), p]))
    asArray(persons.value).forEach((p) => {
      const r = pmap.get(String(p.id))
      if (!r) return
      assignPersonRuntime(p, r)
      if (r.retained) p._stranded = true
      if (r.rescued) p._stranded = false
    })
  }

  /** 当前整栋楼方案下某人员的权威 routeId（2D/3D/后端同一个；方案未定时为 null） */
  function personRouteId(person) {
    const p = typeof person === 'string' ? asArray(persons.value).find((x) => x && String(x.id) === String(person)) : person
    if (!p) return null
    if (p.routeId) return p.routeId
    const bp = activeBuildingPlan.value
    if (!bp) return null
    const route = buildingRouteOfPerson(bp, { floorId: p.floorId || p.floor, zone: p.zone || p.area })
    return route ? route.routeId : null
  }

  /** 2D/3D 消费用的统一人员视图（只暴露统一字段 + 只读别名） */
  const personRuntimes = computed(() => asArray(persons.value).map((p) => ({
    id: p.id,
    buildingId: p.buildingId,
    floorId: p.floorId,
    zone: p.zone,
    status: p.status,
    routeId: p.routeId !== undefined ? p.routeId : null,
    routePoints: Array.isArray(p.routePoints) ? p.routePoints : [],
    progress: typeof p.progress === 'number' ? p.progress : 0,
    position: p.position || (Number.isFinite(p.x) && Number.isFinite(p.y) ? { x: p.x, y: p.y } : null),
  })))

  /** 统一字段完整性自检（E2E 用）：返回不符合契约的人员数 */
  function countNonCanonicalPersons() {
    return asArray(persons.value).filter((p) => !isCanonicalPerson(p)).length
  }

  // 实时疏散推进（仅人员位置与指标，不重复刷新整表）
  function applyDemoTick(msg) {
    if (Array.isArray(msg.persons)) applyDemoPersons(msg.persons)
    if (msg.metrics) {
      const m = msg.metrics
      evacStats.value = {
        total: m.total ?? 0,
        evacuated: m.evacuated ?? 0,
        remaining: (m.evacuating ?? 0) + (m.retained ?? 0),
        pct: m.total ? Math.round(((m.evacuated ?? 0) / m.total) * 100) : 0,
      }
      evacRun.value = (m.evacuating ?? 0) > 0
    }
    strandedPersons.value = asArray(persons.value).filter((p) => ['stranded', 'located'].includes(p.status))
    refreshPersonStats()
  }

  // ══════════ 六阶段演示流程状态（统一单一数据源；0=正常 / 1=发现火灾 / 2=启动应急响应 / 3=疏散路径 / 4=智能疏散 / 5=滞留人员识别 / 6=协同救援） ══════════
  const emergencyStage = ref(0)
  const fireAlertVisible = ref(false)
  const fireConfirmed = ref(false)
  const emergencyResponseConfirmed = ref(false)
  const routeDecisionConfirmed = ref(false)
  const activeRoutePlanId = ref(null)
  const evacRun = ref(false)
  const evacStats = ref({ total: 0, evacuated: 0, remaining: 0, pct: 0 })
  // 滞留人员 / 协同救援
  const strandedPersons = ref([])   // 疏散完成后仍滞留建筑内部的人员
  const rescueState = ref(false)    // 协同救援是否已启动
  const rescueTask = ref(null)      // 当前协同救援任务 { building, floor, area, persons:[], status }
  const strandedLocated = ref(false) // 管理员是否已确认滞留人员位置
  const rescueCompleted = ref(false)  // 协同救援是否已完成（滞留人员已救出）

  // 照明
  const lightingStatus = ref(
    initialLightingStatus && typeof initialLightingStatus === 'object'
      ? { ...initialLightingStatus, currentMode: lightingModes?.daily || {} }
      : { currentMode: lightingModes?.daily || {} }
  )
  const lightingDevices = ref(Array.isArray(initialLightingDevices) ? [...initialLightingDevices] : [])
  const brightnessHistory = ref({
    time: Array.isArray(initialBrightnessHistory?.time) ? [...initialBrightnessHistory.time] : [],
    values: Array.isArray(initialBrightnessHistory?.values) ? [...initialBrightnessHistory.values] : [],
  })
  const lightingEnergy = ref({ today: 42.6, month: 1285.3, saved: 186.8, savedPercent: 31 })

  // 巡检
  const inspectionResult = ref(null)
  const inspectionHistory = ref(Array.isArray(initialInspectionHistory) ? [...initialInspectionHistory] : [])
  const inspectionSteps = ref(Array.isArray(initialInspectionSteps) ? JSON.parse(JSON.stringify(initialInspectionSteps)) : [])
  const inspectionDevices = ref(Array.isArray(initialInspectionDevices) ? [...initialInspectionDevices] : [])
  const inspectionInProgress = ref(false)

  // 疏散
  const evacuationDevices = ref(Array.isArray(initialEvacuationDevices) ? [...initialEvacuationDevices] : [])
  const evacuationLogs = ref(Array.isArray(initialEvacuationLogs) ? [...initialEvacuationLogs] : [])

  // 统一火灾事件
  const fireEvent = ref(null)

  // 风险区域
  const riskAreas = ref([])

  // 应急疏散模式（全局）
  const emergencyMode = ref(false)

  // ── 综合主页视图状态（持久化当前选择，刷新/切换后恢复） ──
  const dashboardView = ref({
    selectedBuildingId: 'B003',
    selectedFloorId: null,       // null=楼栋总览，'1F'/'2F' 等=楼层
    viewMode: 'buildings',       // 'buildings' | 'floors' | 'floorplan'
    selectedZone: 'A区',
    selectedDeviceId: null,
    fireBuilding: null,          // 火灾楼栋名
    fireFloor: null,             // 火灾楼层
    fireArea: null,              // 火灾区域
    emergencyStage: 0,
    demoModeActive: false,
  })
  // 操作日志（综合主页/演示流程/设备控制等统一记录）
  const operationLogs = ref([])  // [{ id, time, action, module, detail, level }]

  function saveDashboardViewState({ buildingId, floorId, viewMode, zone, deviceId }) {
    if (buildingId !== undefined) dashboardView.value.selectedBuildingId = buildingId
    if (floorId !== undefined) dashboardView.value.selectedFloorId = floorId
    if (viewMode !== undefined) dashboardView.value.viewMode = viewMode
    if (zone !== undefined) dashboardView.value.selectedZone = zone
    if (deviceId !== undefined) dashboardView.value.selectedDeviceId = deviceId
  }
  function restoreDashboardView() {
    return { ...dashboardView.value }
  }
  function setDashboardFire(building, floor, area) {
    dashboardView.value.fireBuilding = building
    dashboardView.value.fireFloor = floor
    dashboardView.value.fireArea = area
  }
  function clearDashboardFire() {
    dashboardView.value.fireBuilding = null
    dashboardView.value.fireFloor = null
    dashboardView.value.fireArea = null
  }
  function addOperationLog(action, module = '综合', detail = '', level = 'info') {
    const now = new Date()
    const time = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}`
    operationLogs.value.unshift({
      id: `OP-${Date.now()}-${Math.floor(Math.random()*1000)}`,
      time,
      action,
      module,
      detail,
      level,
    })
    if (operationLogs.value.length > 200) {
      operationLogs.value = operationLogs.value.slice(0, 200)
    }
    // 远端模式（api / demo）：异步落库（fire-and-forget，失败不影响本地）
    if (dataSource.isRemote) {
      operationLogService.create({ action, module, detail, level }).catch(() => {})
    }
  }

  // ================== 疏散路线规划 ==================
  const routePlans = ref([]) // 全部生成的候选方案（所有区域 × 所有出口）
  const currentRoutePlanId = ref(null)
  const routeMode = ref('auto') // 'auto' | 'manual'
  const routeBuildingId = ref('B003')
  const routeFloorId = ref('5F') // 规划分析的目标楼层
  const routeStartArea = ref('') // '' = 全区域自动（不再强制选择起始区域）
  const routeTargetExit = ref('') // '' = 自动选择
  const routeNodes = ref([]) // 手动模式节点
  const routeEdges = ref([]) // 手动模式连线
  const routeDeviceBindings = ref([]) // 路线-设备方向绑定
  const routeFireAutoSwitch = ref(false) // 火灾是否触发过自动重规划
  /**
   * ⚠️ COMPAT ONLY
   * routeMatrix.perZone is a read-only compatibility projection and must not be used as
   * authoritative evacuation state.（P1.5.5）
   *
   * 它只能：旧组件兼容 / 当前楼层局部展示 / 旧页面过渡；
   * 它不能：决定当前疏散方案、决定人员 routeId、决定后端执行路线、
   *         修改 buildingEvacuationPlans、修改 activeBuildingPlanId、驱动 3D 人员路线。
   * 唯一权威顺序：buildingEvacuationPlans > activeBuildingPlanId > person.routeId/routePoints
   */
  const routeMatrix = ref(null) // { buildingId, buildingName, floorId, areas, exits, perZone:{ zone:{plans,recommendedId,backupId} } }
  // ── 整栋楼疏散方案（新模型） ──
  // fireEvent 只描述火灾位置；evacuationScope 永远 = BUILDING
  // PLAN-A/B/C = 三种「整栋楼」策略：均衡 / 快速 / 安全（不再是某区域的三条路线）
  const buildingEvacuationPlans = ref([]) // BuildingEvacuationPlan[]（scope=BUILDING）
  const activeBuildingPlanId = ref(null) // 当前确认/预览的整栋楼方案 id
  // 楼栋方案隔离：每栋楼各自持有一套方案（PLAN-A/B/C）与自己的「当前方案」，
  // 切换楼栋时只在该楼栋自己的方案集合内切换，绝不继承别的楼栋的方案（P1.6.3 E1）
  const buildingPlanCache = ref({}) // { [buildingId]: BuildingEvacuationPlan[] }
  const buildingPlanActiveCache = ref({}) // { [buildingId]: planId }
  const evacuationScope = ref(EVACUATION_SCOPE.BUILDING)
  const selectedZone = ref('A区') // 当前查看/操作的区域
  const routeDebug = ref(false) // 调试模式：显示路网节点/边/墙
  const blockedNodeIds = ref([]) // 火灾封堵节点 id
  const blockedEdgeKeys = ref([]) // 火灾封堵边 key
  let routeGraphCache = null // 最近一次构建的整栋楼路网（供火灾封堵计算）

  // 批量切换疏散方向
  // filters: { building, floors: [], areas: [], deviceTypes: [] }
  function batchSwitchEvacuationDirection(filters, newDirection, reason = '管理员批量切换') {
    addOperationLog('批量调整疏散灯方向', '设备控制', reason + ' ' + newDirection)
    const devs = asArray(devices.value).filter((d) => {
      if (!d || d.type !== 'evacuation_light') return false
      if (filters.buildingId && d.buildingId !== filters.buildingId) return false
      if (filters.building && d.building !== filters.building) return false
      if (filters.floors && filters.floors.length > 0 && !filters.floors.includes(d.floorId) && !filters.floors.includes(d.floor)) return false
      if (filters.areas && filters.areas.length > 0 && !filters.areas.includes(d.area) && !filters.areas.includes(d.zone)) return false
      return true
    })

    const oldDirections = devs.map((d) => d.direction)
    const updatedIds = []
    devs.forEach((d) => {
      d.direction = newDirection
      d.recommendedDirection = newDirection
      updatedIds.push(d.id)
    })

    if (updatedIds.length > 0) {
      const floors = [...new Set(devs.map((d) => d.floor))]
      const building = filters.building || '3号楼'
      evacuationLogs.value.unshift({
        id: `LOG-${Date.now()}`,
        time: new Date().toLocaleTimeString('zh-CN'),
        action: reason,
        detail: `批量调整 ${building} ${floors.join('、')} 共${updatedIds.length}台疏散指示灯方向，由向左调整为${directionMap[newDirection] || newDirection}`,
        operator: '管理员',
        floors,
        building,
        fromDirection: 'left',
        toDirection: newDirection,
        deviceCount: updatedIds.length,
        result: '执行成功',
        level: 'warning',
      })

      addNotification({
        title: '批量方向切换',
        message: `已批量切换 ${floors.join('、')} 共${updatedIds.length}台疏散指示灯方向`,
        level: 'warning',
        time: new Date().toLocaleTimeString('zh-CN'),
      })
    }

    return { count: updatedIds.length, ids: updatedIds, oldDirections }
  }

  // 启动应急疏散模式
  function setEmergencyMode(active) {
    emergencyMode.value = active
    asArray(devices.value).forEach((d) => {
      if (d.type === 'emergency_light' || d.type === 'evacuation_light') {
        if (active) {
          d.status = 'emergency'
          if (d.type === 'emergency_light') {
            d.brightness = 100
            d.currentMode = 'emergency'
          }
        }
      }
    })
    // 应急灯强闪状态标记
    if (active) {
      asArray(devices.value).forEach((d) => {
        if (d && (d.type === 'emergency_light' || d.type === 'evacuation_light')) {
          d.emergencyFlash = true
        }
      })
    }
    addOperationLog(active ? '启动应急联动' : '解除应急联动', '应急模式', active ? '应急照明强闪' : '恢复正常')

    addNotification({
      title: active ? '应急疏散模式启动' : '应急疏散模式解除',
      message: active ? '所有消防应急救援灯已切换至应急模式，灯光全亮' : '消防应急救援灯已恢复正常',
      level: active ? 'danger' : 'info',
      time: new Date().toLocaleTimeString('zh-CN'),
    })
  }

  // 恢复疏散指示灯默认方向（按走廊分界点 x=280：左半区朝西侧出口(左)，右半区朝东侧出口(右)）
  function resetEvacLightDirections() {
    asArray(devices.value).forEach((d) => {
      if (d && d.type === 'evacuation_light' && typeof d.x === 'number') {
        const nd = d.x < 280 ? 'left' : 'right'
        d.direction = nd
        d.recommendedDirection = nd
      }
    })
  }

  // 清除火灾场景
  function clearFireScenario() {
    stopEvacuationSim()
    addOperationLog('解除火情', '演示流程', '恢复正常状态', 'success')
    fireEvent.value = null
    riskAreas.value = []
    emergencyMode.value = false
    asArray(devices.value).forEach((d) => {
      if (d.type === 'emergency_light' || d.type === 'evacuation_light') {
        d.status = 'normal'
        if (d.type === 'emergency_light') {
          d.brightness = 60
          d.currentMode = 'daily'
        }
      }
      if (d.type === 'smoke_detector' || d.type === 'temperature_sensor') {
        d.status = 'normal'
        if (d.type === 'temperature_sensor') d.temperature = 20 + Math.floor(Math.random() * 10)
      }
    })
    // 疏散指示灯方向复位：自动联动/应急批量切换过的灯回到按位置默认方向
    resetEvacLightDirections()
    // 清除应急灯强闪标记
    asArray(devices.value).forEach((d) => {
      if (d) d.emergencyFlash = false
    })
    asArray(persons.value).forEach((p) => {
      if (!p) return
      // 仅清除风险标记，static 人员保持静态状态
      if (p.status === 'warning' || p.status === 'emergency') {
        p.status = p.movementType === 'static' ? 'static' : 'normal'
      }
    })
    refreshStats()
    refreshPersonStats()
  }


  // ════════════════════════════════════════════════════════════
  // 六阶段应急处置流程（首页演示主控：状态集中在 fireStore）
  // emergencyStage: 0=正常 / 1=发现火灾 / 2=启动应急响应 / 3=疏散路径 / 4=智能疏散 / 5=滞留人员识别 / 6=协同救援
  // 设计：detectFireScenario 仅产生「发现火灾」产物；灯/人员/路线联动在管理员启动应急响应后由 activateEmergencyResponse 触发
  // ════════════════════════════════════════════════════════════
  let evacTimer = null

  // 火警楼栋 id（按名称反查，支持任意楼栋演示）
  function fireBuildingId(name) {
    const b = asArray(buildings.value).find((x) => x && x.name === name)
    return b ? b.id : routeBuildingId.value
  }

  // ── 阶段 1：检测发现火情（仅产生发现产物；灯/人员联动等待管理员确认） ──
  function detectFireScenario(building = '3号楼', floor = '5F', area = 'A区') {
    // 已有火情（含外部页面触发残留）时先整体复位，保证演示从干净状态开始
    if (fireEvent.value) resetEmergencyFlow()
    addOperationLog('发现火灾', '演示流程', `${building} ${floor}-${area}`, 'warning')
    const now = new Date()
    fireEvent.value = {
      id: `FE-${Date.now()}`
      // canonical 三元组（权威）→ 别名只做只读派生
      , buildingId: buildingIdFromName(building)
      , floorId: floor
      , zone: area
      , building
      , floor
      , area
      , level: 'danger'
      , time: now.toLocaleString('zh-CN')
      , status: 'pending' // pending=待启动应急响应 / active=应急响应已启动
    }
    // ① 同区烟感/温感先告警（感知层）
    asArray(devices.value).forEach((d) => {
      if (d && d.building === building && d.floor === floor && d.area === area && ['smoke_detector', 'temperature_sensor'].includes(d.type)) {
        d.status = 'warning'
        if (d.type === 'temperature_sensor') d.temperature = 45 + Math.floor(Math.random() * 15)
      }
    })
    // ② 生成待处理告警（真实台账，resolveAlarm 可处置）
    const alarm = {
      id: `AL-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(alarms.value.length + 1).padStart(3, '0')}`
      , time: now.toLocaleString('zh-CN')
      , building
      , floor
      , area
      , device: `${building}${floor}${area}消防设备群`
      , deviceId: 'FN-GROUP'
      , type: '模拟火灾告警'
      , level: 'danger'
      , status: 'pending'
      , progress: 10
      , description: `${building}${floor}${area}检测到火情，烟感探测器与温感探测器同时触发告警`
    }
    alarms.value.unshift(alarm)
    stats.value.todayAlarms++
    refreshBuildings()
    refreshPersonStats()
    refreshStats()
    // ③ 流程推进：阶段 1（发现火情）
    emergencyStage.value = 1
    fireConfirmed.value = false
    fireAlertVisible.value = true
    evacuationLogs.value.unshift({
      id: `LOG-${Date.now()}`
      , time: now.toLocaleTimeString('zh-CN')
      , action: '发现火灾'
      , detail: `${building} ${floor}-${area} 感知设备上报火情，等待启动应急响应`
      , operator: '系统'
      , level: 'danger'
    })
    addNotification({
      title: '发现火灾'
      , message: `${building} ${floor}-${area} 感知设备上报火情，请启动应急响应`
      , level: 'danger'
      , time: now.toLocaleTimeString('zh-CN')
    })
    return fireEvent.value
  }

  // ── 阶段 1 → 2：管理员启动应急响应（区域级联动 + 路线系统自动计算） ──
  // 发现火灾后由管理员一键启动：确认火情、锁定位置、标记危险区/风险人员、联动应急灯、自动生成疏散方案
  function activateEmergencyResponse() {
    // demo 模式：只派发 ACTIVATE_RESPONSE，阶段迁移由后端 snapshot 回来（禁止前端自行改 stage）
    const cmd = dispatchDemoCommand('ACTIVATE_RESPONSE', (d) => d.activateResponse())
    if (cmd) return cmd
    const fe = fireEvent.value
    if (!fe || emergencyStage.value !== 1) return false
    addOperationLog('启动应急响应', '演示流程', '联动应急灯+生成路线')
    emergencyResponseConfirmed.value = true
    fe.status = 'active'
    const building = fe.building
    const floor = fe.floor
    const area = fe.area
    // ① 火源房门对应走廊 x：距门 ≤110px 的灯进入 emergency；指向火源门的疏散灯自动反向
    const fireDoorX = PLAN_DOORS.find((dd) => dd.zone === area)?.x ?? 140
    asArray(devices.value).forEach((d) => {
      if (!d || d.building !== building || d.floor !== floor) return
      if (d.type !== 'emergency_light' && d.type !== 'evacuation_light') return
      if (typeof d.x !== 'number' || Math.abs(d.x - fireDoorX) > 110) return
      d.status = 'emergency'
      if (d.type === 'emergency_light') {
        d.brightness = 100
        d.currentMode = 'emergency'
      } else {
        const headingToFire = (d.x < fireDoorX && d.direction === 'right') || (d.x >= fireDoorX && d.direction === 'left')
        if (headingToFire) {
          const nd = d.direction === 'left' ? 'right' : 'left'
          d.direction = nd
          d.recommendedDirection = nd
        }
      }
    })
    // ② 风险人员标记（同区）
    asArray(persons.value)
      .filter((p) => p && p.building === building && p.floor === floor && p.zone === area)
      .forEach((p) => { p.status = 'warning' })
    // ③ 风险区域
    riskAreas.value.push({
      id: `RA-${String(riskAreas.value.length + 1).padStart(3, '0')}`
      , building
      , floor
      , zone: area
      , level: 'high'
      , type: '火灾风险'
      , description: `${building}${floor}${area}已确认真实火情，启动应急响应`
      , time: new Date().toLocaleString('zh-CN')
    })
    // ④ 应急事件（沿用现有 currentEmergency，不另建第二套）
    currentEmergency.value = {
      id: `EM-${Date.now()}`
      , alarmId: alarms.value[0] ? alarms.value[0].id : ''
      , building
      , floor
      , area
      , level: 'danger'
      , time: new Date().toLocaleString('zh-CN')
      , status: 'active'
      , steps: emergencySteps.map((s) => ({ ...s, status: 'pending' }))
    }
    // ⑤ 照明状态聚合
    const affectedLight = devices.value.find((d) => d.building === building && d.floor === floor && d.type === 'emergency_light')
    if (affectedLight) {
      lightingStatus.value.currentDevice = affectedLight
      lightingStatus.value.currentMode = lightingModes.emergency
      lightingStatus.value.brightness = 100
      lightingStatus.value.mode = 'emergency'
    }
    // ⑥ 疏散日志 + 统计 + 通知
    evacuationLogs.value.unshift({
      id: `LOG-${Date.now()}`
      , time: new Date().toLocaleTimeString('zh-CN')
      , action: '启动应急响应'
      , detail: `已启动应急响应：${building} ${floor} ${area} —— 确认火灾事件、锁定危险区域、分析人员分布、获取安全出口与楼梯，自动生成疏散方案`
      , operator: '管理员'
      , level: 'danger'
    })
    refreshBuildings()
    refreshPersonStats()
    refreshStats()
    addNotification({
      title: '应急响应已启动'
      , message: `${building} ${floor}-${area} 应急联动已启动：危险区域已标记，疏散路线开始计算`
      , level: 'danger'
      , time: new Date().toLocaleTimeString('zh-CN')
    })
    // ⑦ 阶段 2 自动完成：确认事件/锁定位置/分析人员/获取出口楼梯后，随即自动生成疏散方案进入阶段 3
    fireConfirmed.value = true
    emergencyStage.value = 2
    generateEvacuationOptions()
    return true
  }

  // ── 阶段 4 准备：路线计算（封堵火源 → 受影响区域局部重规划 → 推荐高亮 → 疏散灯按推荐方向联动） ──
  function generateEvacuationOptions() {
    const fe = fireEvent.value
    if (!fe) return []
    addOperationLog('生成疏散路线', '疏散规划', '整栋楼各楼层/区域生成整体疏散方案')
    // ① 整栋楼方案（scope=BUILDING）：A/B/C = 均衡 / 快速 / 安全三种整栋楼策略（唯一权威）
    const built = generateBuildingEvacuationPlans({ buildingId: fireBuildingId(fe.building) })
    if (!built.plans.length) {
      // 整栋楼规划失败时回退旧的单楼层矩阵（仅用于页面展示，不是权威方案）
      generateRoutePlans({ buildingId: fireBuildingId(fe.building), floorId: fe.floor })
      applyFireBlocking(fe)
      replanRoutesForFire()
    }
    const bp = activeBuildingPlan.value
    // ② 疏散灯：整栋楼所有路线统一联动（火灾只影响路线走向，不影响参与范围）
    if (bp) {
      const bindings = []
      ;(bp.routes || []).forEach((r) => applyRouteToDevices(routeToRenderable(bp, r), bindings))
      routeDeviceBindings.value = bindings
    }
    const scopeText = bp
      ? `整栋楼 ${bp.summary.zoneCount} 个有人区域 / ${bp.summary.personCount} 人 / ${bp.summary.routeCount} 条路线`
      : `${fe.floor}-${fe.area}`
    evacuationLogs.value.unshift({
      id: `LOG-${Date.now()}`
      , time: new Date().toLocaleTimeString('zh-CN')
      , action: '生成疏散方案'
      , detail: `系统为 ${fe.building}（火灾位置 ${fe.floor}-${fe.area}，疏散范围 BUILDING）生成 ${built.plans.length} 套整栋楼疏散方案，覆盖 ${scopeText}${bp ? `，推荐方案「${bp.name}」已高亮` : ''}`
      , operator: '系统'
      , level: 'warning'
    })
    addNotification({
      title: '整栋楼疏散方案已生成'
      , message: `已为 ${fe.building} 生成 ${built.plans.length} 套整栋楼方案（${scopeText}），推荐方案已自动高亮`
      , level: 'success'
      , time: new Date().toLocaleTimeString('zh-CN')
    })
    emergencyStage.value = 3
    routeDecisionConfirmed.value = false
    return built.plans
  }

  // ── 阶段 4：管理员预览/切换方案 ──
  // 切换的是「整栋楼方案」：任何一条区域路线都携带 buildingPlanId，点选即全楼切换。
  function selectEvacuationPlan(planId) {
    const plan = getRoutePlanById(planId)
    if (!plan) return false
    if (plan.buildingPlanId && buildingEvacuationPlans.value.some((p) => p.id === plan.buildingPlanId)) {
      if (activeBuildingPlanId.value !== plan.buildingPlanId) return setActiveBuildingPlan(plan.buildingPlanId)
      return true
    }
    // ⚠️ LEGACY：非整栋楼方案（旧单区域结构）仅本地预览，不改变权威方案
    if (plan.status === 'BLOCKED') return false
    activeRoutePlanId.value = planId
    applyRouteToDevices(plan)
    return true
  }
  // 返回方案列表：重新回到当前整栋楼方案
  function backToPlanList() {
    if (activeBuildingPlanId.value) return setActiveBuildingPlan(activeBuildingPlanId.value)
    return false
  }

  // ── 阶段 4 → 5：确认执行整栋楼疏散方案（开始逃生） ──
  function confirmEvacuationPlan() {
    // demo 模式：只派发 CONFIRM_ROUTE（整栋楼方案，后端校验 buildingPlanId），路线/阶段均由后端下发
    const cmd = dispatchDemoCommand('CONFIRM_ROUTE', (d) => d.confirmRoute(d.selectedPlanId || d.activeBuildingPlanId))
    if (cmd) return cmd
    const fe = fireEvent.value
    if (!fe || emergencyStage.value !== 3) return false
    addOperationLog('确认疏散方案', '演示流程', '启动整栋楼智能疏散')
    // 权威：唯一当前方案 = activeBuildingPlanId 对应的整栋楼方案
    // （routeMatrix.perZone 只是只读投影，不得在此决定执行方案）
    const bp = activeBuildingPlan.value
    if (!bp) return false
    routeDecisionConfirmed.value = true
    // 疏散灯统一沿整栋楼每条路线方向 + 途经楼层应急照明进入应急强闪
    const bindings = []
    ;(bp.routes || []).forEach((r) => applyRouteToDevices(routeToRenderable(bp, r), bindings))
    routeDeviceBindings.value = bindings
    addOperationLog(
      '调整疏散指示方向',
      '演示流程',
      `疏散指示灯方向已按整栋楼方案「${bp.name}」统一指向出口 ${bp.summary.exitLabels.join('、') || '安全出口'}`,
      'warning',
    )
    evacuationLogs.value.unshift({
      id: `LOG-${Date.now()}`
      , time: new Date().toLocaleTimeString('zh-CN')
      , action: '确认执行整栋楼疏散方案'
      , detail: `管理员确认执行「${bp.name}」（scope=${bp.scope}）：${bp.summary.zoneCount} 个区域 / ${bp.summary.personCount} 人 / ${bp.summary.routeCount} 条路线，出口 ${bp.summary.exitLabels.join('、') || '—'}，最慢 ${bp.summary.maxEstimatedTime}s`
      , operator: '管理员'
      , level: 'danger'
    })
    refreshBuildings()
    refreshPersonStats()
    refreshStats()
    addNotification({
      title: '开始整栋楼疏散'
      , message: `开始执行 ${fe.building} 整栋楼方案「${bp.name}」：${bp.summary.personCount} 人 / ${bp.summary.routeCount} 条路线 · 最慢 ${bp.summary.maxEstimatedTime}s`
      , level: 'danger'
      , time: new Date().toLocaleTimeString('zh-CN')
    })
    emergencyStage.value = 4
    // ④ 智能疏散立即生效：应急灯脉冲强闪 + 整栋楼人员沿各自路线动态撤离
    startPulseFlash()
    startEvacuationRun()
    return true
  }

  // ── 疏散执行模拟：人员沿合法路线节点移动（房间→门→走廊→楼梯），数据仍来自 persons 同源，不穿墙 ──
  // 权威入口：整栋楼方案（activeBuildingPlanId）→ 每人 routeId / routePoints
  function startEvacuationRun() {
    const fe = fireEvent.value
    if (!fe) return
    stopEvacuationSim()
    addOperationLog('启动智能疏散', '演示流程', '整栋楼多楼层同步疏散', 'warning')
    // P1.6.1：demo 模式下人员的路线 / 位置 / 进度 / 状态一律以后端 WebSocket 广播为唯一权威。
    // ⚠️ 必须在写任何本地运行态之前返回 —— 一旦本地写 routeId / status / _evac，
    //    就会与后端 PersonRuntime 形成「两套互相竞争的位置来源」（2D / 3D 只消费后端人员快照）。
    if (dataSource.isDemo) {
      evacRun.value = true
      return true
    }
    // 以下为 mock / 离线模式的本地模拟（p._evac = 本地运行态，非权威数据）
    const bp = activeBuildingPlan.value
    if (!bp) return false
    // 统一字段：按 buildingId 判定参与范围（与后端 PersonRuntime 同一个 id / 同一套字段）
    const feBuildingId = fireBuildingId(fe.building)
    let total = 0
    asArray(persons.value).forEach((p) => {
      if (!p || (p.buildingId || fireBuildingId(p.building)) !== feBuildingId) return
      delete p._evacDone
      delete p._evac
      // 走廊等公共区域没有房间节点 → 与规划阶段同一套归属规则，保证人人有路线
      let route = buildingRouteOfPerson(bp, { floorId: p.floorId, zone: p.zone })
      if (!route && p.zone) {
        if (!routeGraphCache) routeGraphCache = buildBuildingGraph(getBuildingFloors(bp.buildingId))
        route = buildingRouteOfPerson(bp, {
          floorId: p.floorId,
          zone: resolvePlanningZone(routeGraphCache, {
            floorId: p.floorId, zone: p.zone, x: p.x, y: p.y,
          }),
        })
      }
      const plan = route ? routeToRenderable(bp, route) : null
      const ownFloor = p.floorId
      // routeId = `${planId}:${floorId}:${zone}` —— 2D / 3D / 后端同一个 id
      p.routeId = route ? route.routeId : null
      if (!plan || plan.status === 'BLOCKED') return
      const pts = []
      // 房间人员：先到本区门口走廊中心点，再沿走廊/楼梯节点（走廊人员直接从走廊节点出发）
      if (p.zone && p.zone !== '走廊') {
        const door = PLAN_DOORS.find((dd) => dd.zone === p.zone)
        if (door && door.corridorSide) pts.push({ x: door.corridorSide.x, y: door.corridorSide.y })
      }
      let last = null
      plan.path.forEach((n) => {
        if (n.floorId !== ownFloor || (n.type !== 'corridor' && n.type !== 'stair')) return
        if (!last || Math.abs(n.x - last.x) + Math.abs(n.y - last.y) > 4) {
          pts.push({ x: n.x, y: n.y })
          last = n
        }
      })
      if (pts.length) {
        p._evac = { pts, idx: 0 }
        p.status = 'evacuating'
        total++
      }
    })
    // ── 以下仅 mock / 离线模式：P2 确定性滞留，与后端共用同一份固定候选名单 RETAINED_CANDIDATES ──
    // 只允许 evacuating → stranded —— 严禁把已撤离或未参与疏散的人重新标记为滞留，
    // 也不再按「火源区第一个 / C区第一个」这种顺序取人（否则同一份场景每次跑出来的人不一样）
    const strandedPicks = pickRetainedCandidates(
      asArray(persons.value).filter((p) => p && (p.buildingId || fireBuildingId(p.building)) === feBuildingId),
      'evacuating',
    )
    strandedPicks.forEach((p) => {
      p._stranded = true
      p.status = 'stranded'
      delete p._evac
      p._evacDone = false
    })
    // 重新统计实际参与疏散动画的人数（滞留人员已从 _evac 中移除）
    total = asArray(persons.value).filter((p) => p && p._evac).length
    evacStats.value = { total, evacuated: 0, remaining: total, pct: 0 }
    evacRun.value = true
    evacTimer = setInterval(() => {
      try {
        advanceEvacuationSim()
      } catch (err) {
        console.warn('[fireStore] 疏散模拟异常：', err)
      }
    }, 300)
  }

  // 疏散完成：统一计算滞留人员并进入阶段5（滞留人员识别）
  function finishEvacuation() {
    const fe = fireEvent.value
    if (!fe) return
    stopEvacuationSim()
    const feBuildingId = fireBuildingId(fe.building)
    // P2 确定性滞留：滞留名单来自整栋楼固定候选（可能是火警楼层之外的楼层），
    // 因此这里按「火警楼栋」而不是「火警楼层」取，保证 2D 名单与 3D / 后端同一批人
    const floorPersons = asArray(persons.value)
      .filter((p) => p && (p.buildingId || fireBuildingId(p.building)) === feBuildingId)
    const stranded = floorPersons.filter((p) => p._stranded)
    // P1.6.1：滞留名单同样携带统一空间身份（buildingId / floorId / zone），2D 只读统一字段
    strandedPersons.value = stranded.map((p) => ({
      id: p.id,
      name: p.name,
      buildingId: p.buildingId,
      building: p.building,
      floorId: p.floorId,
      floor: p.floor,
      zone: p.zone,
      area: p.area,
      x: p.x,
      y: p.y,
      status: p.status,
      located: false,
    }))
    const totalFloor = floorPersons.length
    const strandedCount = stranded.length
    evacStats.value = {
      total: totalFloor,
      evacuated: totalFloor - strandedCount,
      remaining: strandedCount,
      pct: totalFloor > 0 ? Math.round(((totalFloor - strandedCount) / totalFloor) * 100) : 100,
    }
    if (strandedCount > 0) {
      addOperationLog('发现滞留人员', '演示流程',
        `${fe.building} 发现滞留人员 ${strandedCount} 人：${stranded.map((p) => `${p.id}（${p.floorId}-${p.zone}）`).join('、')}`, 'danger')
    } else {
      addOperationLog('人员疏散完成', '演示流程', `${fe.building} 全部人员安全撤离，未发现滞留人员`, 'success')
    }
    emergencyStage.value = 5
    refreshPersonStats()
    refreshStats()
  }

  function advanceEvacuationSim() {
    const fe = fireEvent.value
    if (!fe) {
      stopEvacuationSim()
      return
    }
    const s = evacStats.value
    let evacuated = 0
    asArray(persons.value).forEach((p) => {
      if (!p || !p._evac) return
      if (p._evacDone) {
        evacuated++
        return
      }
      const pts = p._evac.pts
      const idx = p._evac.idx
      if (!pts || idx >= pts.length) {
        p._evacDone = true
        p.status = 'safe'
        evacuated++
        return
      }
      const t = pts[idx]
      const dx = t.x - p.x
      const dy = t.y - p.y
      const dist = Math.sqrt(dx * dx + dy * dy)
      const sp = Math.min(8, 2.2 + (typeof p.speed === 'number' ? p.speed * 1.6 : 2.2))
      if (dist <= sp) {
        p.x = t.x
        p.y = t.y
        syncPersonPosition(p)
        p._evac.idx++
        if (p._evac.idx >= pts.length) {
          p._evacDone = true
          p.status = 'safe'
          evacuated++
        }
      } else {
        p.x += (dx / dist) * sp
        p.y += (dy / dist) * sp
        syncPersonPosition(p)
        if (p.movementType === 'static') p.movementType = 'moving'
      }
    })
    s.evacuated = evacuated
    s.remaining = Math.max(0, s.total - evacuated)
    s.pct = s.total > 0 ? Math.round((evacuated / s.total) * 100) : 0
    if (s.remaining === 0) {
      finishEvacuation()
    }
  }

  function stopEvacuationSim() {
    if (evacTimer) {
      clearInterval(evacTimer)
      evacTimer = null
    }
    evacRun.value = false
  }

  // ── 重置演示：整体复位（清除火情/路线/应急照明、人员坐标恢复、流程归零） ──
  function resetEmergencyFlow() {
    // clearRouteFire 内部依次：clearFireScenario → 清封堵/方案复位/解除应急模式 → 停疏散动画 → 人员坐标恢复 → 流程归零
    clearRouteFire()
    asArray(persons.value).forEach((p) => { delete p._stranded; if (p.status === 'stranded' || p.status === 'located') p.status = 'normal' })
    return true
  }

  // ── 外部页面直接触发火灾（triggerFireScenario/simulateFireAlarm）后回到首页：同步为「疏散方案决策」阶段 ──
  function syncStageAfterExternalFire() {
    const fe = fireEvent.value
    if (!fe) return false
    // 等待态（0/1/2/3）→ 完整联动已发生 → 直接进入方案决策；执行中不打断
    if (emergencyStage.value === 4 || emergencyStage.value === 5) return true
    generateEvacuationOptions()
    return true
  }
  // 按楼栋+楼层+类型筛选设备
  // P1.6.2：统一字段（buildingId / floorId / zone）优先，旧中文名 / 旧 area 过滤器仍兼容
  function getDevicesFiltered(filters = {}) {
    return asArray(devices.value).filter((d) => {
      if (!d) return false
      if (filters.buildingId && d.buildingId !== filters.buildingId) return false
      if (filters.building && d.building !== filters.building) return false
      if (filters.floorId && d.floorId !== filters.floorId) return false
      if (filters.floor && d.floor !== filters.floor) return false
      if (filters.floors && filters.floors.length > 0 && !filters.floors.includes(d.floorId) && !filters.floors.includes(d.floor)) return false
      if (filters.zone && d.zone !== filters.zone && d.area !== filters.zone) return false
      if (filters.area && d.area !== filters.area) return false
      if (filters.type && d.type !== filters.type) return false
      if (filters.types && filters.types.length > 0 && !filters.types.includes(d.type)) return false
      if (filters.controllable !== undefined && d.controllable !== filters.controllable) return false
      return true
    })
  }

  // 设备配置
  const deviceConfig = ref({})

  // demo
  const demoStep = ref(0)
  const demoStepList = ref([])

  // ================== Safe Access Helpers ==================
  function asArray(v) {
    return Array.isArray(v) ? v : []
  }
  function asObject(v) {
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {}
  }

  // ================== Computed ==================
  // 传入当前真实数据数组，防止 mock 函数拿到空引用
  const deviceStats = computed(() => {
    try { return getDeviceStats(devices.value) } catch { return {} }
  })
  const deviceTypeStats = computed(() => {
    try { return getDeviceTypeStats(devices.value) } catch { return [] }
  })
  const alarmStats = computed(() => {
    try { return getAlarmStats(alarms.value) } catch { return {} }
  })

  const onlineSensorCount = computed(() => {
    return asArray(devices.value).filter((d) => d && d.status !== 'fault').length
  })

  const riskAreaCount = computed(() => asArray(riskAreas.value).length)

  const deviceHealthScore = computed(() => {
    const list = asArray(devices.value)
    const total = list.length
    if (total === 0) return 100
    const normal = list.filter((d) => d && d.status === 'normal').length
    const warning = list.filter((d) => d && d.status === 'warning').length
    const fault = list.filter((d) => d && d.status === 'fault').length
    const emergency = list.filter((d) => d && d.status === 'emergency').length
    return Math.round(((normal * 1 + warning * 0.6 + fault * 0 + emergency * 0.3) / total) * 100)
  })

  // ================== Helpers ==================

  function refreshBuildings() {
    if (!Array.isArray(buildings.value)) return
    buildings.value.forEach((b) => {
      if (!b) return
      const devs = asArray(devices.value)
      const bldDevs = devs.filter((d) => d && d.building === b.name)
      b.deviceCount = bldDevs.length
      b.online = bldDevs.filter((d) => d && d.status !== 'fault').length
      b.abnormal = bldDevs.filter((d) => d && (d.status === 'warning' || d.status === 'emergency')).length
      b.offline = bldDevs.filter((d) => d && d.status === 'fault').length
      const hasEmergency = bldDevs.some((d) => d && d.status === 'emergency')
      const hasWarning = bldDevs.some((d) => d && (d.status === 'warning' || d.status === 'fault'))
      b.status = hasEmergency ? 'emergency' : hasWarning ? 'warning' : 'normal'
    })
  }

  function refreshPersonStats() {
    const ps = asObject(personStats.value)
    const pers = asArray(persons.value)
    const devs = asArray(devices.value)
    const risks = asArray(riskAreas.value)
    ps.totalPersons = pers.length
    ps.activeTargets = pers.filter((p) => p && p.movementType === 'moving').length
    ps.staticTargets = pers.filter((p) => p && p.movementType === 'static').length
    ps.riskZones = risks.length
    ps.sensorDevices = devs.filter((d) => d && d.type === 'radar_sensor').length
    ps.buildingDistribution = {
      '1号楼': pers.filter((p) => p && p.building === '1号楼').length,
      '2号楼': pers.filter((p) => p && p.building === '2号楼').length,
      '3号楼': pers.filter((p) => p && p.building === '3号楼').length,
      '4号楼': pers.filter((p) => p && p.building === '4号楼').length,
    }
    ps.statusDistribution = {
      normal: pers.filter((p) => p && p.status === 'normal').length,
      warning: pers.filter((p) => p && p.status === 'warning').length,
      static: pers.filter((p) => p && p.movementType === 'static').length,
    }
  }

  function refreshStats() {
    try {
      const devs = asArray(devices.value)
      const ds = getDeviceStats(devs)
      const ts = getDeviceTypeStats(devs)
      stats.value = asObject(stats.value)
      stats.value.totalDevices = ds.total || 0
      stats.value.onlineDevices = ds.online || 0
      stats.value.abnormalDevices = (ds.warning || 0) + (ds.fault || 0)
      stats.value.offlineDevices = ds.fault || 0
      stats.value.deviceStatus = { normal: ds.normal || 0, warning: ds.warning || 0, fault: ds.fault || 0, emergency: ds.emergency || 0 }
      stats.value.deviceTypes = ts || []
      stats.value.updateTime = new Date().toLocaleString('zh-CN')
      updateTime.value = stats.value.updateTime
    } catch (e) {
      console.warn('[fireStore] refreshStats error:', e)
    }
  }

  function refreshZoneHeatmap() {
    const radarNodes = devices.value.filter((d) => d.type === 'radar_sensor')
    // zoneHeatmap 是 mock 导入的常量，这里只更新 persons 相关统计即可；页面可动态计算
  }

  // 通知自动关闭计时器映射
  const notificationTimers = new Map()
  const NOTIFICATION_DURATION = {
    success: 3000,
    info: 3000,
    warning: 5000,
    danger: 0,
  }

  function addNotification(notif) {
    notif.id = `N${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    notif.createdAt = Date.now()
    notif.autoClose = notif.level === 'danger' ? false : (notif.autoClose !== false)
    notif.duration = notif.duration || NOTIFICATION_DURATION[notif.level] || 3000
    notif.dismissing = false
    notifications.value.unshift(notif)
    if (notifications.value.length > 10) {
      const removed = notifications.value.pop()
      if (removed && removed.id) clearNotificationTimer(removed.id)
    }
    if (notif.autoClose && notif.duration > 0) scheduleAutoDismiss(notif.id, notif.duration)
  }

  function clearNotificationTimer(id) {
    const timer = notificationTimers.get(id)
    if (timer) {
      clearTimeout(timer)
      notificationTimers.delete(id)
    }
  }

  function scheduleAutoDismiss(id, delay) {
    clearNotificationTimer(id)
    const timer = setTimeout(() => dismissNotificationWithFade(id), delay)
    notificationTimers.set(id, timer)
  }

  function dismissNotificationWithFade(id) {
    const notif = notifications.value.find((n) => n.id === id)
    if (notif && !notif.dismissing) {
      notif.dismissing = true
      setTimeout(() => {
        notifications.value = notifications.value.filter((n) => n.id !== id)
        notificationTimers.delete(id)
      }, 400)
    }
  }

  function removeNotification(id) {
    clearNotificationTimer(id)
    notifications.value = notifications.value.filter((n) => n.id !== id)
  }

  function dismissNotification(id) {
    dismissNotificationWithFade(id)
  }

  // ================== Actions ==================
  function selectBuilding(building) {
    selectedBuilding.value = building
    addOperationLog('选择楼栋', '综合', building ? (building.name || building) : '')
  }

  function selectDevice(device) {
    selectedDevice.value = device
  }

  // 楼层选择（楼宇态势 3D 数字孪生联动；仅改 dashboardView，不引入独立状态）
  function selectFloor(floorId) {
    dashboardView.value.selectedFloorId = floorId
    addOperationLog('选择楼层', '楼宇态势', floorId || '楼栋总览')
  }
  // 区域选择（A区/B区/C区/D区）—— 同步 dashboardView 与路线规划视角
  function selectZone(zone) {
    if (!zone) return
    dashboardView.value.selectedZone = zone
    if (typeof setSelectedZone === 'function') setSelectedZone(zone)
    addOperationLog('选择区域', '楼宇态势', zone)
  }

  // 区域级火灾联动
  // ⚠️ demo 模式禁止使用：火情必须经后端六阶段状态机（START_FIRE）产生，
  //    本地直接改状态会绕过状态机，导致阶段与真实状态不一致。
  function triggerFireScenario(building = '3号楼', floor = '5F', area = 'A区') {
    if (dataSource.isDemo) {
      console.error('[fireStore] demo 模式禁止本地模拟火灾，请通过后端状态机 START_FIRE 触发')
      return false
    }
    fireEvent.value = {
      id: `FE-${Date.now()}`,
      // canonical 三元组（权威）→ 别名只做只读派生
      buildingId: buildingIdFromName(building),
      floorId: floor,
      zone: area,
      building,
      floor,
      area,
      level: 'danger',
      time: new Date().toLocaleString('zh-CN'),
      status: 'active',
    }

    // 1. 影响附近检测设备：烟感/温感 warning
    const smokeAndTempDevs = asArray(devices.value).filter(
      (d) => d && d.building === building && d.floor === floor && d.area === area && ['smoke_detector', 'temperature_sensor'].includes(d.type)
    )
    smokeAndTempDevs.forEach((d) => {
      d.status = 'warning'
      if (d.type === 'temperature_sensor') d.temperature = 45 + Math.floor(Math.random() * 15)
    })

    // 2+3. 火源房门对应的走廊 x，按几何距离联动灯光：
    //   - 距房门 ≤110px 的应急照明/疏散灯进入 emergency（灯光全亮）；
    //   - 疏散灯若当前指向火源房门（朝危险区）则自动反向，其余保持指向安全方向
    const fireDoorX = PLAN_DOORS.find((dd) => dd.zone === area)?.x ?? 140
    asArray(devices.value).forEach((d) => {
      if (!d || d.building !== building || d.floor !== floor) return
      if (d.type !== 'emergency_light' && d.type !== 'evacuation_light') return
      if (typeof d.x !== 'number') return
      const near = Math.abs(d.x - fireDoorX) <= 110
      if (!near) return
      d.status = 'emergency'
      if (d.type === 'emergency_light') {
        d.brightness = 100
        d.currentMode = 'emergency'
      } else {
        // 指向火源（朝门方向）的疏散灯反向，其余保持指向安全方向
        const headingToFire = (d.x < fireDoorX && d.direction === 'right') || (d.x >= fireDoorX && d.direction === 'left')
        if (headingToFire) {
          const nd = d.direction === 'left' ? 'right' : 'left'
          d.direction = nd
          d.recommendedDirection = nd
        }
      }
    })

    // 4. 人员风险标记
    asArray(persons.value)
      .filter((p) => p && p.building === building && p.floor === floor && p.zone === area)
      .forEach((p) => { p.status = 'warning' })

    // 5. 风险区域
    riskAreas.value.push({
      id: `RA-${String(riskAreas.value.length + 1).padStart(3, '0')}`,
      building,
      floor,
      zone: area,
      level: 'high',
      type: '火灾风险',
      description: `${building}${floor}${area}检测到火情风险`,
      time: new Date().toLocaleString('zh-CN'),
    })

    // 6. 生成告警
    const alarm = {
      id: `AL-2026-0905-${String(alarms.value.length + 1).padStart(3, '0')}`,
      time: new Date().toLocaleString('zh-CN'),
      building,
      floor,
      area,
      device: `${building}${floor}${area}消防设备群`,
      deviceId: 'FN-GROUP',
      type: '模拟火灾告警',
      level: 'danger',
      status: 'pending',
      progress: 10,
      description: `${building}${floor}${area}检测到火情，烟感探测器与温感探测器同时触发告警`,
    }
    alarms.value.unshift(alarm)

    // 7. 创建应急事件
    currentEmergency.value = {
      id: `EM-2026-0905-001`,
      alarmId: alarm.id,
      building,
      floor,
      area,
      level: 'danger',
      time: new Date().toLocaleString('zh-CN'),
      status: 'active',
      steps: emergencySteps.map((s) => ({ ...s, status: 'pending' })),
    }

    // 8. 同步疏散日志
    evacuationLogs.value.unshift({
      id: `LOG-${Date.now()}`,
      time: new Date().toLocaleTimeString('zh-CN'),
      action: '火灾联动自动切换疏散方向',
      detail: `${building}${floor}${area}附近疏散指示灯已自动避开火源`,
      operator: '系统',
      level: 'danger',
    })

    // 9. 照明状态聚合
    const affectedLight = devices.value.find((d) => d.building === building && d.floor === floor && d.type === 'emergency_light')
    if (affectedLight) {
      lightingStatus.value.currentDevice = affectedLight
      lightingStatus.value.currentMode = lightingModes.emergency
      lightingStatus.value.brightness = 100
      lightingStatus.value.mode = 'emergency'
    }

    // 10. 统计刷新
    stats.value.todayAlarms++
    refreshBuildings()
    refreshPersonStats()
    refreshStats()

    addNotification({
      title: '火灾联动触发',
      message: `${building}${floor}${area} 区域级消防联动已启动`,
      level: 'danger',
      time: new Date().toLocaleTimeString('zh-CN'),
    })

    // 若存在已规划路线，自动封堵危险区域/通道并重新推荐
    if (asArray(routePlans.value).length) {
      applyFireBlocking(fireEvent.value)
      replanRoutesForFire()
    }

    return fireEvent.value
  }

  function simulateAlarm(opts = {}) {
    const targetBuilding = opts.building || buildings.value[Math.floor(Math.random() * buildings.value.length)]
    const targetFloor = opts.floor || `${randInt(1, 6)}F`
    const targetDevice = opts.device || devices.value.find(
      (d) => d.building === targetBuilding.name && d.floor === targetFloor
    ) || devices.value[Math.floor(Math.random() * devices.value.length)]

    if (targetDevice) {
      targetDevice.status = 'warning'
      targetDevice.temperature = 40 + Math.floor(Math.random() * 20)
      targetDevice.battery = Math.max(10, targetDevice.battery - 20)
    }

    const bld = buildings.value.find((b) => b.id === targetBuilding.id)
    if (bld) {
      bld.status = 'warning'
      bld.abnormal++
      bld.online--
    }

    const alarmTypes = ['通信异常', '温度异常', '烟感异常', '设备故障', '模拟火灾告警']
    const levels = ['warning', 'danger', 'danger', 'warning', 'danger']
    const typeIdx = opts.type ? Math.max(0, alarmTypes.indexOf(opts.type)) : Math.floor(Math.random() * alarmTypes.length)

    const newAlarm = {
      id: `AL-2026-0905-${String(alarms.value.length + 1).padStart(3, '0')}`,
      time: new Date().toLocaleString('zh-CN'),
      building: targetBuilding.name,
      floor: targetFloor,
      area: targetDevice?.area || 'A区',
      device: targetDevice ? targetDevice.name : `${targetBuilding.name}${targetFloor}消防设备`,
      deviceId: targetDevice ? targetDevice.id : 'FN-XXX',
      type: opts.type || alarmTypes[typeIdx],
      level: opts.level || levels[typeIdx],
      status: 'pending',
      progress: 10,
      description: opts.description || `检测到${targetBuilding.name}${targetFloor}设备异常，需要立即处置`,
    }

    alarms.value.unshift(newAlarm)
    stats.value.todayAlarms++
    refreshStats()

    addNotification({
      title: '新告警事件',
      message: `${targetBuilding.name} ${targetFloor} ${newAlarm.type}`,
      level: newAlarm.level,
      time: new Date().toLocaleTimeString('zh-CN'),
    })

    return newAlarm
  }

  function simulateFireAlarm() {
    addOperationLog('模拟火灾', '演示流程', '3号楼 5F A区', 'danger')
    return detectFireScenario('3号楼', '5F', 'A区')
  }

  function updateDeviceStatus(deviceId, status) {
    const dev = devices.value.find((d) => d.id === deviceId)
    if (dev) {
      dev.status = status
      if (status === 'normal') {
        dev.temperature = 20 + Math.floor(Math.random() * 10)
        dev.battery = Math.min(100, dev.battery + 30)
      }
      refreshBuildings()
      refreshStats()
    }
  }

  function resolveAlarm(alarmId) {
    const alarm = alarms.value.find((a) => a.id === alarmId)
    if (alarm) {
      alarm.status = 'resolved'
      alarm.progress = 100
      // 远端模式：异步落库（fire-and-forget）
      if (dataSource.isRemote) {
        alarmService.update(alarmId, { status: 'resolved', progress: 100 }).catch(() => {})
      }
    }
  }

  function startEmergency() {
    if (currentEmergency.value) {
      currentEmergency.value.status = 'active'
      currentEmergency.value.steps[0].status = 'processing'
    }
  }

  function advanceEmergencyStep() {
    if (!currentEmergency.value) return
    const steps = currentEmergency.value.steps
    const currentIdx = steps.findIndex((s) => s.status === 'processing')
    if (currentIdx >= 0) {
      steps[currentIdx].status = 'done'
      if (currentIdx + 1 < steps.length) {
        steps[currentIdx + 1].status = 'processing'
      } else {
        currentEmergency.value.status = 'resolved'
      }
    } else {
      const firstPending = steps.findIndex((s) => s.status === 'pending')
      if (firstPending >= 0) steps[firstPending].status = 'processing'
    }
  }

  function completeEmergency() {
    if (currentEmergency.value) {
      currentEmergency.value.status = 'resolved'
      currentEmergency.value.steps.forEach((s) => (s.status = 'done'))
    }
  }

  function toggleDemoMode() {
    demoMode.value = !demoMode.value
  }

  function resetDemoState() {
    // demo 模式（P1.7.2 / P1-05）：「正常状态」就是 RESET —— 只派发 RESET 命令，
    // 后端回到 IDLE 后由 snapshot 统一清理前端（火情/方案/路线/救援/设备/人员）。
    // 严禁在这里把 demoMode 置 false：演示控制台必须能继续用于下一轮演示。
    const cmd = dispatchDemoCommand('RESET', (d) => d.reset())
    if (cmd) return cmd
    // 重置设备为初始状态（平面空间数据源重新生成，保证与首页平面图同源；统一字段规范化）
    devices.value = normalizeDevices(buildSeedDevices())
    // 重置建筑聚合
    buildings.value = JSON.parse(JSON.stringify(initialBuildings))
    // 重置告警
    alarms.value = JSON.parse(JSON.stringify(initialAlarms))
    // 重置人员（统一契约规范化，保证 2D/3D 读到的仍是同一套字段）
    persons.value = normalizePersons(initialPersons)
    personStats.value = JSON.parse(JSON.stringify(initialPersonStats))
    // 重置风险区域
    riskAreas.value = []
    // 重置火灾事件
    fireEvent.value = null
    // 重置应急事件
    currentEmergency.value = null
    emergencyStepList.value = [...emergencySteps]
    // 重置照明
    lightingStatus.value = { ...initialLightingStatus, currentMode: lightingModes.daily }
    lightingDevices.value = JSON.parse(JSON.stringify(initialLightingDevices))
    brightnessHistory.value = {
      time: [...initialBrightnessHistory.time],
      values: [...initialBrightnessHistory.values],
    }
    // 重置疏散
    evacuationDevices.value = JSON.parse(JSON.stringify(initialEvacuationDevices))
    evacuationLogs.value = [...initialEvacuationLogs]
    // 重置巡检
    inspectionResult.value = null
    inspectionInProgress.value = false
    inspectionSteps.value = JSON.parse(JSON.stringify(initialInspectionSteps))
    inspectionHistory.value = [...initialInspectionHistory]
    inspectionDevices.value = [...initialInspectionDevices]
    // 重置统计
    stats.value = JSON.parse(JSON.stringify(initialStats))
    updateTime.value = new Date().toLocaleString('zh-CN')
    // 重置 demo
    demoStep.value = 0
    demoStepList.value = []
    demoMode.value = false
    // 清除通知与计时器
    notificationTimers.forEach((timer) => clearTimeout(timer))
    notificationTimers.clear()
    notifications.value = []

    addNotification({
      title: '系统重置',
      message: '演示状态已恢复到初始状态',
      level: 'info',
      time: new Date().toLocaleTimeString('zh-CN'),
    })
  }

  function updateRandomData() {
    refreshStats()
    const randomDev = devices.value[Math.floor(Math.random() * devices.value.length)]
    if (randomDev && randomDev.status !== 'fault') {
      randomDev.battery = Math.max(10, Math.min(100, randomDev.battery + Math.floor(Math.random() * 3) - 1))
    }
  }

  // ================== 人员相关 ==================
  function simulatePerson() {
    const names = ['陈八', '周九', '吴十', '郑十一', '王十二']
    const departments = ['研发部', '运营部', '安保部', '行政部', '财务部']
    const buildingsList = ['1号楼', '2号楼', '3号楼', '4号楼']
    const floorsList = ['1F', '2F', '3F', '4F', '5F', '6F']
    const zonesList = ['A区', 'B区', 'C区', 'D区']
    const zoneRects = {
      'A区': { x: 90, y: 28, w: 105, h: 122 },
      'B区': { x: 90, y: 210, w: 105, h: 70 },
      'C区': { x: 375, y: 28, w: 80, h: 122 },
      'D区': { x: 375, y: 210, w: 80, h: 70 },
    }
    const zone = zonesList[Math.floor(Math.random() * zonesList.length)]
    const zr = zoneRects[zone] || zoneRects['A区']
    const posX = Math.round(zr.x + 5 + Math.random() * (zr.w - 10))
    const posY = Math.round(zr.y + 5 + Math.random() * (zr.h - 10))

    const newPerson = {
      id: `P${String(persons.value.length + 1).padStart(3, '0')}`,
      name: names[Math.floor(Math.random() * names.length)],
      department: departments[Math.floor(Math.random() * departments.length)],
      building: buildingsList[Math.floor(Math.random() * buildingsList.length)],
      floor: floorsList[Math.floor(Math.random() * floorsList.length)],
      zone: zone,
      x: posX,
      y: posY,
      enterTime: new Date().toLocaleString('zh-CN'),
      status: 'normal',
      position: { x: Math.floor(Math.random() * 80) + 10, y: Math.floor(Math.random() * 80) + 10 },
      movementType: Math.random() > 0.3 ? 'moving' : 'static',
      speed: 0,
      direction: 0,
      distance: 0,
      detectedAt: new Date().toLocaleString('zh-CN'),
    }
    if (newPerson.movementType === 'moving') {
      newPerson.speed = +(0.5 + Math.random() * 2).toFixed(2)
      newPerson.direction = Math.floor(Math.random() * 360)
      newPerson.distance = +(1 + Math.random() * 6).toFixed(1)
    }

    persons.value.push(newPerson)
    refreshPersonStats()

    addNotification({
      title: '人员进入',
      message: `${newPerson.name}（${newPerson.department}）进入${newPerson.building}${newPerson.floor}`,
      level: 'info',
      time: new Date().toLocaleTimeString('zh-CN'),
    })

    return newPerson
  }

  function simulateRisk(building, floor, zone) {
    const targetBuilding = building || ['1号楼', '2号楼', '3号楼', '4号楼'][Math.floor(Math.random() * 4)]
    const targetFloor = floor || `${Math.floor(Math.random() * 7) + 1}F`
    const targetZone = zone || ['A区', 'B区', 'C区'][Math.floor(Math.random() * 3)]

    const riskArea = {
      id: `RA-${String(riskAreas.value.length + 1).padStart(3, '0')}`,
      building: targetBuilding,
      floor: targetFloor,
      zone: targetZone,
      level: 'high',
      type: '火灾风险',
      description: `${targetBuilding}${targetFloor}${targetZone}检测到风险`,
      time: new Date().toLocaleString('zh-CN'),
    }

    riskAreas.value.push(riskArea)
    refreshPersonStats()

    addNotification({
      title: '风险区域预警',
      message: `${targetBuilding}${targetFloor}${targetZone} - 火灾风险`,
      level: 'warning',
      time: new Date().toLocaleTimeString('zh-CN'),
    })

    return riskArea
  }

  // ================== 巡检相关 ==================
  function startInspection(deviceId) {
    const dev = inspectionDevices.value.find((d) => d.id === deviceId)
    const deviceName = dev ? dev.name : deviceId

    inspectionInProgress.value = true
    inspectionResult.value = null
    inspectionSteps.value = JSON.parse(JSON.stringify(initialInspectionSteps))
    inspectionSteps.value[0].status = 'processing'

    addNotification({
      title: '远程巡检',
      message: `已启动对 ${deviceName} 的远程巡检`,
      level: 'info',
      time: new Date().toLocaleTimeString('zh-CN'),
    })

    return { deviceId, deviceName }
  }

  function advanceInspectionStep() {
    const idx = inspectionSteps.value.findIndex((s) => s.status === 'processing')
    if (idx >= 0) {
      inspectionSteps.value[idx].status = 'done'
      if (idx + 1 < inspectionSteps.value.length) {
        inspectionSteps.value[idx + 1].status = 'processing'
        return false
      } else {
        return true
      }
    }
    return false
  }

  function completeInspection(result) {
    inspectionInProgress.value = false
    inspectionResult.value = result

    inspectionHistory.value.unshift(result)
    if (inspectionHistory.value.length > 20) inspectionHistory.value.pop()

    // 远端模式：巡检结果异步归档（fire-and-forget）
    if (dataSource.isRemote && result) {
      inspectionService.create(result).catch(() => {})
    }

    addNotification({
      title: '巡检完成',
      message: `${result.device} 巡检结果: ${result.result === 'pass' ? '通过' : result.result === 'warning' ? '警告' : '异常'}`,
      level: result.result === 'fail' ? 'warning' : 'success',
      time: new Date().toLocaleTimeString('zh-CN'),
    })

    return result
  }

  function resetInspection() {
    inspectionInProgress.value = false
    inspectionResult.value = null
    inspectionSteps.value = JSON.parse(JSON.stringify(initialInspectionSteps))
  }

  // ================== 照明相关 ==================
  function switchLightingMode(mode) {
    const config = lightingModes[mode] || lightingModes.daily
    lightingStatus.value.mode = mode
    lightingStatus.value.brightness = config.brightness
    lightingStatus.value.currentMode = config

    const dev = lightingDevices.value.find((d) => d.id === (lightingStatus.value.currentDevice?.id || lightingDevices.value[0]?.id))
    if (dev) {
      dev.currentMode = mode
      dev.brightness = config.brightness
      dev.status = mode === 'emergency' ? 'emergency' : 'normal'
      lightingStatus.value.currentDevice = dev
    }

    const now = new Date()
    const label = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
    brightnessHistory.value.time.push(label)
    brightnessHistory.value.values.push(config.brightness)
    if (brightnessHistory.value.time.length > 30) {
      brightnessHistory.value.time.shift()
      brightnessHistory.value.values.shift()
    }

    refreshBuildings()
    refreshStats()

    addNotification({
      title: '照明模式切换',
      message: `已切换至${config.name}模式`,
      level: mode === 'emergency' ? 'warning' : 'info',
      time: new Date().toLocaleTimeString('zh-CN'),
    })

    return lightingStatus.value
  }

  function simulatePersonEnter() {
    const newPerson = simulatePerson()

    const targetLight = lightingDevices.value.find(
      (d) => d.building === newPerson.building && d.floor === newPerson.floor
    )

    if (targetLight) {
      const oldBrightness = targetLight.brightness
      targetLight.status = 'normal'
      targetLight.brightness = Math.min(100, targetLight.brightness + 30)
      targetLight.currentMode = 'induction'
      targetLight.detectedPerson = true
      lightingStatus.value.brightness = targetLight.brightness
      lightingStatus.value.mode = 'induction'
      lightingStatus.value.currentMode = lightingModes.induction
      lightingStatus.value.currentDevice = targetLight
      lightingStatus.value.detectedPerson = true

      addNotification({
        title: '照明联动',
        message: `${targetLight.name} 亮度 ${oldBrightness}% → ${targetLight.brightness}%（人员触发）`,
        level: 'info',
        time: new Date().toLocaleTimeString('zh-CN'),
      })
    }

    refreshBuildings()
    refreshStats()
    return newPerson
  }

  // ================== 疏散相关 ==================
  function switchEvacuationDirection(deviceId, newDirection, reason = '管理员手动切换') {
    const dev = devices.value.find((d) => d.id === deviceId && d.type === 'evacuation_light')
    if (!dev) return null

    addOperationLog('切换疏散灯方向', '设备控制', deviceId + '→' + newDirection)
    const oldDirection = dev.direction
    dev.direction = newDirection
    dev.recommendedDirection = newDirection

    evacuationLogs.value.unshift({
      id: `LOG-${Date.now()}`,
      time: new Date().toLocaleTimeString('zh-CN'),
      action: reason,
      detail: `${dev.name} ${directionMap[oldDirection]} → ${directionMap[newDirection]}`,
      operator: '管理员',
      floor: dev.floor,
      device: dev.name,
      fromDirection: oldDirection,
      toDirection: newDirection,
      result: '执行成功',
      level: 'warning',
    })

    addNotification({
      title: '疏散方向切换',
      message: `${dev.name} 已切换至${directionMap[newDirection]}`,
      level: 'warning',
      time: new Date().toLocaleTimeString('zh-CN'),
    })

    return dev
  }

  function addEvacuationLog(log) {
    evacuationLogs.value.unshift({
      id: `LOG-${Date.now()}`,
      time: new Date().toLocaleTimeString('zh-CN'),
      ...log,
    })
  }

  // ================== 设备配置 ==================
  function updateDeviceConfig(config) {
    deviceConfig.value = {
      ...deviceConfig.value,
      ...config,
      updateTime: new Date().toLocaleString('zh-CN'),
    }

    if (config.deviceId) {
      const dev = devices.value.find((d) => d.id === config.deviceId)
      if (dev) {
        if (config.threshold !== undefined) dev.threshold = config.threshold
        if (config.sensitivity !== undefined) dev.sensitivity = config.sensitivity
        if (config.status !== undefined) {
          dev.status = config.status
          refreshBuildings()
          refreshStats()
        }
      }
    }

    addNotification({
      title: '配置下发',
      message: config.deviceId ? `设备 ${config.deviceId} 配置已更新` : '批量设备配置已下发',
      level: 'success',
      time: new Date().toLocaleTimeString('zh-CN'),
    })

    return deviceConfig.value
  }

  // ================== 六阶段演示流程（真实改变平台状态，统一单一数据源） ==================
  // 0=正常 / 1=发现火灾 / 2=启动应急响应 / 3=疏散路径 / 4=智能疏散 / 5=滞留人员识别 / 6=协同救援
  function startDemoFlow() {
    resetEmergencyFlow()
    demoMode.value = true
    return detectFireScenario('3号楼', '5F', 'A区') // ① 发现火灾
  }

  // 推进一步：根据当前阶段执行对应的真实状态变更（供演示面板「下一步」调用）
  // 六阶段：0=正常 / 1=发现火灾 / 2=启动应急响应 / 3=疏散路径 / 4=智能疏散 / 5=滞留人员识别 / 6=协同救援
  function advanceDemoStage() {
    const s = emergencyStage.value
    if (s === 0) return startDemoFlow()                    // ① 发现火灾 → emergencyStage=1
    if (s === 1) return activateEmergencyResponse()        // ② 启动应急响应 → emergencyStage=2
    if (s === 2) return generateEvacuationOptions()        // ③ 自动生成疏散路径 → emergencyStage=3
    if (s === 3) return confirmEvacuationPlan()            // ④ 确认疏散路径 → emergencyStage=4
    if (s === 4) {                                         // ④ 智能疏散：调整方向 + 启动脉冲强闪（疏散完成后自动进阶段5）
      adjustEvacuationDirection()
      return startPulseFlash()
    }
    if (s === 5) return confirmStrandedLocation()          // ⑤ 确认滞留人员位置 → emergencyStage=6 协同救援
    if (s === 6) return dispatchRescueTeam()               // ⑥ 派遣救援队伍 → 救援完成
    return false
  }

  function resetDemoFlow() {
    resetEmergencyFlow()
    demoMode.value = false
  }

  // 阶段4：管理员调整疏散指示灯方向（按当前推荐/已选方案联动所有 evacuation_light）
  function adjustEvacuationDirection() {
    const plan = getRoutePlanById(activeRoutePlanId.value)
    if (!plan) return false
    applyRouteToDevices(plan)
    addOperationLog('调整指示方向', '演示流程', '应急疏散指示灯方向已按疏散方案统一调整', 'warning')
    return true
  }

  // 阶段4：启动疏散指示灯脉冲强闪（应急强闪）+ 开始人员疏散动态模拟
  function startPulseFlash() {
    const plan = getRoutePlanById(activeRoutePlanId.value)
    if (!plan) return false
    setEmergencyMode(true)
    startEvacuationRun(plan)
    addOperationLog('启动疏散指示灯脉冲强闪', '演示流程', '应急疏散灯进入脉冲强闪，人员沿疏散路线动态撤离', 'warning')
    return true
  }

  // 阶段6：管理员确认滞留人员位置 → 建立协同救援任务
  function confirmStrandedLocation() {
    // demo 模式：只派发 CONFIRM_RETAINED（后端负责生成救援任务并建立协同救援）
    const cmd = dispatchDemoCommand('CONFIRM_RETAINED', (d) => d.confirmRetained())
    if (cmd) return cmd
    const fe = fireEvent.value
    if (!fe || strandedPersons.value.length === 0) return false
    strandedLocated.value = true
    strandedPersons.value.forEach((p) => { p.located = true })
    asArray(persons.value).forEach((p) => { if (p._stranded) p.status = 'located' })
    rescueState.value = true
    rescueTask.value = {
      id: `RSC-${Date.now()}`,
      building: fe.building,
      floor: fe.floor,
      area: fe.area,
      persons: strandedPersons.value.map((p) => ({ id: p.id, name: p.name, zone: p.zone, located: true })),
      firefighterContacted: true,
      teamDispatched: true,
      channelPlanned: true,
      status: '协同救援已启动',
    }
    emergencyStage.value = 6
    addOperationLog('确认滞留人员位置', '演示流程', `已确认 ${strandedPersons.value.length} 名滞留人员位置（${strandedPersons.value.map((p) => `${p.building}/${p.floor}/${p.zone}`).join('、')}），已生成救援任务`, 'danger')
    refreshPersonStats()
    refreshStats()
    return true
  }

  // 用户要求导出名为 confirmRetainedPersonnel；内部等价于 confirmStrandedLocation
  function confirmRetainedPersonnel() {
    return confirmStrandedLocation()
  }

  // 阶段 6：派出救援队伍 → 滞留人员 warning→rescued，救援完成
  let rescueTimer = null
  function dispatchRescueTeam() {
    // demo 模式：救援完成同样由后端状态机推进 COMPLETE_RESCUE
    const cmd = dispatchDemoCommand('COMPLETE_RESCUE', (d) => d.completeRescue())
    if (cmd) return cmd
    const fe = fireEvent.value
    if (!fe || rescueState.value !== true || rescueCompleted.value) return false
    addOperationLog('启动消防救援', '演示流程', `消防救援力量已出动，前往 ${fe.building} ${fe.floor} 救援 ${strandedPersons.value.length} 名滞留人员`, 'danger')
    if (rescueTask.value) {
      rescueTask.value.status = '救援进行中'
    }
    // 模拟救援过程：短暂延时后滞留人员全部救出
    if (rescueTimer) clearTimeout(rescueTimer)
    rescueTimer = setTimeout(() => {
      rescueTimer = null
      // 滞留人员状态：warning/located → rescued（人员已救出）
      asArray(persons.value).forEach((p) => { if (p._stranded) p.status = 'rescued' })
      strandedPersons.value.forEach((p) => { p.status = 'rescued' })
      if (rescueTask.value) {
        rescueTask.value.status = '救援完成'
        rescueTask.value.rescueCompleted = true
      }
      rescueCompleted.value = true
      addOperationLog('救援完成', '演示流程', `消防救援任务完成，滞留人员已救出`, 'success')
      refreshPersonStats()
      refreshStats()
    }, 5000)
    refreshPersonStats()
    refreshStats()
    return true
  }

  // ================== 疏散路线规划方法（全楼层/全区域自动路径规划） ==================
  // 管理员只需选择楼栋 + 点击「自动规划」，系统自动完成：
  // 读取所有区域 × 所有安全出口 → 建立可通行路网 → 为每个区域生成多条候选路径
  // → 过滤危险路线 → 计算安全评分 → 选择推荐 + 备用 → 同步消防应急灯方向。

  /**
   * 当前查看区域在当前整栋楼方案里的那条路线（只读展示用）
   * ⚠️ 不读 routeMatrix.perZone —— perZone 只是兼容投影；权威来源是 activeBuildingPlan。
   */
  const currentRoutePlan = computed(() => {
    const bp = activeBuildingPlan.value
    if (bp && bp.routes && bp.routes.length) {
      const route = bp.routes.find((r) => r.zone === selectedZone.value)
        || buildingRouteOfPerson(bp, { floorId: routeFloorId.value, zone: selectedZone.value })
      if (route) return routeToRenderable(bp, route)
      return null
    }
    // ⚠️ LEGACY：无整栋楼方案时的旧投影（只读）
    const m = routeMatrix.value
    if (!m || !m.perZone) return null
    const recId = m.perZone[selectedZone.value] && m.perZone[selectedZone.value].recommendedId
    return asArray(routePlans.value).find((p) => p.id === recId) || null
  })

  function getRouteBuildingName(id) {
    const b = asArray(buildings.value).find((x) => x.id === id)
    return b ? b.name : '3号楼'
  }
  /** 中文楼栋名 → canonical buildingId（fireEvent 必须携带 canonical 三元组） */
  function buildingIdFromName(name) {
    if (!name) return ''
    const b = asArray(buildings.value).find((x) => x && x.name === name)
    return b ? String(b.id) : ''
  }
  function getBuildingFloors(buildingId) {
    const b = asArray(buildings.value).find((x) => x.id === buildingId)
    return b && b.floors ? b.floors : 7
  }
  function personCountAt(buildingName, floorId, zone) {
    return asArray(persons.value).filter(
      (p) => p && p.building === buildingName && p.floor === floorId && (p.zone || p.area) === zone
    ).length
  }

  function blockNodeSet() {
    return new Set(blockedNodeIds.value)
  }
  function blockEdgeSet() {
    return new Set(blockedEdgeKeys.value)
  }
  function planUsesBlocked(plan) {
    for (const n of plan.path) if (blockedNodeIds.value.includes(n.id)) return true
    for (let i = 0; i < plan.path.length - 1; i++) {
      if (blockedEdgeKeys.value.includes(edgeKey(plan.path[i].id, plan.path[i + 1].id))) return true
    }
    return false
  }

  // 由路径结果构建方案对象
  function buildPlanFromPath(pathResult, buildingId, buildingName, floorId, zone, exit, idx) {
    const nodeObjs = pathResult.path.map((id) => routeGraphCache.nodes[id])
    const stair = nodeObjs.find((n) => n.type === 'stair')
    const corridor = nodeObjs.find((n) => n.type === 'corridor' && n.floorId === floorId)
    // 出口信息直接取 shared 拓扑节点（唯一数据源），不再查 mock 的 EXIT_NODES 常量
    const exitNode = routeGraphCache.nodes[exit] || { label: exit, side: /EXIT_E/.test(exit) ? 'right' : 'left' }
    const startNum = parseInt(String(floorId).replace('F', ''), 10) || 1
    const floorsPassed = []
    for (let i = startNum; i >= 1; i--) floorsPassed.push(`${i}F`)
    const distance = Math.round(pathResult.cost * 10) / 10
    const estimatedTime = Math.round(distance / EVAC_SPEED + (startNum - 1) * STAIR_PENALTY_S)
    const congestion = personCountAt(buildingName, floorId, zone)
    return {
      id: `RP-${buildingId}-${floorId}-${zone}-${exit}-${idx}-${Date.now().toString(36)}`,
      name: `${zone}→${exitNode.label}`,
      buildingId,
      buildingName,
      startFloor: floorId,
      startArea: zone,
      corridor: corridor ? corridor.key : '走廊',
      stair: stair ? stair.key : '楼梯',
      exit,
      exitLabel: exitNode.label,
      exitSide: exitNode.side,
      type: 'auto',
      status: 'NORMAL',
      recommended: false,
      floorsPassed,
      riskLevel: '低',
      score: 0,
      distance,
      estimatedTime,
      deviceCount: 0,
      congestion,
      zoneColor: ZONE_COLORS[zone] || '#4361EE',
      path: nodeObjs.map((n) => ({ id: n.id, floorId: n.floorId, key: n.key, x: n.x, y: n.y, type: n.type })),
    }
  }

  // 去重（按节点集合）+ 评分（安全>风险>时间>距离）+ 取前 3 条不同路径
  function dedupeAndScore(zonePlans) {
    const seen = new Set()
    const unique = []
    zonePlans.forEach((p) => {
      const key = p.path.map((n) => n.id).join('>')
      if (!seen.has(key)) {
        seen.add(key)
        unique.push(p)
      }
    })
    const maxDist = Math.max(...unique.map((p) => p.distance), 1)
    const maxTime = Math.max(...unique.map((p) => p.estimatedTime), 1)
    const maxCong = Math.max(...unique.map((p) => p.congestion), 1)
    unique.forEach((p) => {
      const risk = p.status === 'BLOCKED' ? 0 : p.status === 'WARNING' ? 0.4 : 1
      const normDist = 1 - p.distance / maxDist
      const normTime = 1 - p.estimatedTime / maxTime
      const normCong = 1 - p.congestion / maxCong
      const raw = risk * 0.4 + normTime * 0.2 + normDist * 0.15 + normCong * 0.1 + 0.05
      p.score = Math.round(raw * 100)
      p.riskLevel = p.status === 'BLOCKED' ? '高' : p.status === 'WARNING' ? '中' : '低'
    })
    unique.sort((a, b) => b.score - a.score)
    zonePlans.length = 0
    unique.slice(0, 3).forEach((p) => zonePlans.push(p))
  }

  // 为一栋楼某楼层所有区域 × 所有出口自动生成候选路线矩阵
  function generateRoutePlans(opts = {}) {
    const buildingId = opts.buildingId || routeBuildingId.value
    const floorId = opts.floorId || routeFloorId.value
    routeBuildingId.value = buildingId
    routeFloorId.value = floorId
    const buildingName = getRouteBuildingName(buildingId)
    const maxF = getBuildingFloors(buildingId)
    routeGraphCache = buildBuildingGraph(maxF)
    const areas = ROOM_AREAS
    const exits = exitIdsOf(routeGraphCache, '1F') // shared 拓扑里的安全出口（1F 直通室外）
    // 合法性校验用的边集合（任意相邻节点必须是图中合法边，禁止穿墙/房间直连）
    const edgeSet = new Set()
    Object.values(routeGraphCache.adj).forEach((arr) => arr.forEach((e) => edgeSet.add(e.ek)))
    const allPlans = []
    const perZone = {}
    areas.forEach((zone) => {
      const zonePlans = []
      const startId = sharedNodeId(floorId, ZONE_NODE_KEY[zone])
      if (!routeGraphCache.nodes[startId]) return
      exits.forEach((exit) => {
        const paths = kShortestPaths(
          routeGraphCache,
          startId,
          exit,
          blockNodeSet(),
          blockEdgeSet(),
          3
        )
        paths.forEach((p, idx) => {
          const plan = buildPlanFromPath(p, buildingId, buildingName, floorId, zone, exit, idx)
          // 关键防线：任何穿墙/穿房间/非法跳跃/未到出口的路线一律不展示
          if (!validateRoute(plan.path, { edgeSet }).valid) return
          zonePlans.push(plan)
          allPlans.push(plan)
        })
      })
      dedupeAndScore(zonePlans)
      perZone[zone] = {
        plans: zonePlans,
        recommendedId: zonePlans[0] ? zonePlans[0].id : null,
        backupId: zonePlans[1] ? zonePlans[1].id : null,
      }
    })
    routePlans.value = areas.flatMap((z) => perZone[z].plans)
    routeMatrix.value = { buildingId, buildingName, floorId, areas, exits, perZone }
    selectedZone.value = areas[0]
    if (fireEvent.value && fireEvent.value.building === buildingName) replanRoutesForFire()
    return routeMatrix.value
  }

  // ══════════════════════════════════════════════════════
  // 整栋楼疏散方案（scope = BUILDING）
  //   火灾只描述位置（buildingId + floorId + zone），疏散范围永远是整栋楼；
  //   PLAN-A/B/C 是三种整栋楼策略，每套内部为每个「有人员的 floorId+zone」生成一条路线。
  //   路线仍然来自 shared/evacuation（findPaths + validateRoute），前端不另算一套。
  // ══════════════════════════════════════════════════════

  /** 节点 id → 类型（与 toRenderablePlan 口径一致） */
  function nodeTypeOfKey(key) {
    return /^EXIT_/.test(key) ? 'exit'
      : /^STAIR_/.test(key) ? 'stair'
        : /^CORRIDOR/.test(key) ? 'corridor' : 'room'
  }

  /** 整栋楼方案中的一条路线 → 2D/3D 现有渲染结构（字段与 toRenderablePlan 对齐） */
  function routeToRenderable(bp, route) {
    const path = (route.points || []).map((pt, i) => {
      const id = (route.nodes || [])[i] || ''
      const [floorId, key] = String(id).split(':')
      return {
        id, floorId: floorId || route.floorId, key: key || '',
        x: pt.x, y: pt.y, type: nodeTypeOfKey(key || ''),
      }
    })
    return {
      id: route.routeId, // `${planId}:${floorId}:${zone}` —— 2D/3D/后端同一个 routeId
      name: `${route.floorId}-${route.zone} · ${bp.name}`,
      buildingId: bp.buildingId,
      buildingName: bp.buildingName,
      startFloor: route.floorId,
      startArea: route.zone,
      exit: route.exitId,
      exitLabel: route.exitLabel,
      exitSide: /EXIT_E/.test(route.exitId) ? 'right' : 'left',
      corridor: '走廊',
      stair: (route.nodes || []).find((n) => /STAIR_/.test(n)) || '楼梯',
      floorsPassed: route.floorsPassed || [route.floorId],
      riskLevel: RISK_CN[route.riskLevel] || '低',
      type: 'auto',
      status: 'NORMAL',
      recommended: Boolean(bp.recommended),
      score: 0,
      distance: route.distance,
      estimatedTime: route.estimatedTime,
      congestion: route.personCount || 0,
      zoneColor: ZONE_COLORS[route.zone] || '#4361EE',
      deviceCount: 0,
      path,
      // 整栋楼方案反向引用（UI 展示策略语义用）
      buildingPlanId: bp.id,
      strategy: bp.strategy,
      scope: bp.scope,
    }
  }

  /** 火灾上下文：只描述位置，不含疏散范围 */
  function buildingFireContext() {
    const fe = fireEvent.value
    if (!fe) return null
    return { buildingId: fireBuildingId(fe.building), floorId: fe.floor, zone: fe.area }
  }

  /** store 人员 → 规划器入参（buildingId + floorId + zone） */
  function buildingPlanningPersons(buildingId, buildingName) {
    return asArray(persons.value)
      .filter((p) => p && (!buildingName || p.building === buildingName))
      .map((p) => ({
        id: p.id, buildingId, floorId: p.floor, zone: p.zone || p.area, status: p.status, x: p.x, y: p.y,
      }))
      .filter((p) => p.floorId && p.zone)
  }

  /**
   * 整栋楼方案 → 旧结构投影（单向，read-only projection）：
   * buildingEvacuationPlans / activeBuildingPlanId  ──▶  routePlans / routeMatrix.perZone / activeRoutePlanId
   *
   * ⚠️ 只能由整栋楼方案向下投影，绝不能反向把 perZone 的改动写回 buildingEvacuationPlans
   *    或 activeBuildingPlanId；perZone 仅供旧组件与「当前楼层局部展示」使用。
   */
  function syncLegacyRouteState(plans, activeId) {
    buildingEvacuationPlans.value = plans || []
    const list = buildingEvacuationPlans.value
    const active = list.find((p) => p.id === activeId)
      || list.find((p) => p.recommended)
      || list[0]
      || null
    activeBuildingPlanId.value = active ? active.id : null
    if (!active) return null

    // routePlans：整栋楼全部区域的路线（每个区域一条，routeId 唯一）
    routePlans.value = (active.routes || []).map((r) => routeToRenderable(active, r))

    // routeMatrix：保持旧结构，perZone 用「当前查看楼层」的纯区域名做键（2D 平面图按楼层展示）
    const floorId = routeFloorId.value || (fireEvent.value && fireEvent.value.floor) || '5F'
    const areas = [...new Set((active.routes || []).filter((r) => r.floorId === floorId).map((r) => r.zone))]
    const perZone = {}
    areas.forEach((zone) => {
      const zk = zoneKeyOf(floorId, zone)
      // 同一区域在 A/B/C 三套整栋楼策略下各有一条路线 → 旧 UI 的「候选方案列表」
      const candidates = []
      list.forEach((bp) => {
        const r = bp.routesByZone && bp.routesByZone[zk]
        if (r) candidates.push(routeToRenderable(bp, r))
      })
      const rec = candidates.find((p) => p.buildingPlanId === active.id) || candidates[0] || null
      perZone[zone] = {
        plans: candidates,
        recommendedId: rec ? rec.id : null,
        backupId: candidates[1] ? candidates[1].id : null,
      }
    })
    routeMatrix.value = {
      buildingId: active.buildingId,
      buildingName: active.buildingName,
      floorId,
      scope: EVACUATION_SCOPE.BUILDING,
      areas,
      zones: (active.routes || []).map((r) => zoneKeyOf(r.floorId, r.zone)),
      exits: [...new Set((active.routes || []).map((r) => r.exitId))],
      perZone,
      summary: active.summary,
    }
    // activeRoutePlanId 指向「火源区域」的那条路线（2D 高亮 / 3D 路线层用）
    const fire = active.fire
    const focus = fire && active.routesByZone[zoneKeyOf(fire.floorId, fire.zone)]
      ? active.routesByZone[zoneKeyOf(fire.floorId, fire.zone)]
      : (active.routes || [])[0]
    activeRoutePlanId.value = focus ? focus.routeId : null
    selectedZone.value = areas[0] || selectedZone.value
    return active
  }

  /** 本地（mock / 无后端）生成整栋楼三套方案 */
  function generateBuildingEvacuationPlans(opts = {}) {
    const buildingId = opts.buildingId || routeBuildingId.value
    const buildingName = getRouteBuildingName(buildingId)
    const maxFloor = getBuildingFloors(buildingId)
    const fire = opts.fire !== undefined ? opts.fire : buildingFireContext()
    const res = planBuildingStrategies({
      buildingId,
      buildingName,
      persons: buildingPlanningPersons(buildingId, buildingName),
      fire,
      maxFloor,
      strategies: [STRATEGY.BALANCED, STRATEGY.FASTEST, STRATEGY.SAFEST],
    })
    const active = syncLegacyRouteState(res.plans, opts.activePlanId || null)
    if (!res.plans.length) {
      addNotification({
        title: '整栋楼疏散方案生成失败',
        message: '未找到覆盖全部有人区域的合法路线，请检查火情与人员分布',
        level: 'danger',
        time: new Date().toLocaleTimeString('zh-CN'),
      })
    }
    return { plans: res.plans, groups: res.groups, active }
  }

  /** 后端快照 → 整栋楼方案（后端是权威，前端只镜像） */
  function applyBuildingPlans(snap) {
    if (!snap || !Array.isArray(snap.buildingPlans) || !snap.buildingPlans.length) return null
    if (snap.evacuationScope) evacuationScope.value = snap.evacuationScope
    const plans = snap.buildingPlans
    const bid = String(plans[0].buildingId || currentPlanBuildingId.value || routeBuildingId.value)
    // 后端方案是权威：先按所属楼栋归档，之后切回该楼栋时直接恢复，不再重新生成
    buildingPlanCache.value[bid] = plans.slice()
    const activeId = snap.activeBuildingPlanId
      || (plans.find((p) => p.recommended) || {}).id
      || plans[0].id
    buildingPlanActiveCache.value[bid] = activeId
    // 后端 DO 只演练一栋楼：方案到达时把「当前查看楼栋」对齐到方案所属楼栋，
    // 否则 2D/3D 会拿别的楼栋的方案去渲染（跨楼栋串方案）
    if (dashboardView.value && String(dashboardView.value.selectedBuildingId || '') !== bid) {
      dashboardView.value.selectedBuildingId = bid
    }
    const active = syncLegacyRouteState(plans, activeId)
    if (active && !active.valid) {
      console.warn('[fireStore] 后端整栋楼方案校验未通过：', active.reasons)
    }
    return active
  }

  /** 切换整栋楼方案（A/B/C）—— 全楼人员路线同步切换 */
  function setActiveBuildingPlan(planId) {
    if (!buildingEvacuationPlans.value.some((p) => p.id === planId)) return false
    const active = syncLegacyRouteState(buildingEvacuationPlans.value, planId)
    if (!active) return false
    // 疏散灯沿每条路线方向联动（整栋楼：所有楼层参与）
    const bindings = []
    ;(active.routes || []).forEach((r) => applyRouteToDevices(routeToRenderable(active, r), bindings))
    routeDeviceBindings.value = bindings
    // 正在执行疏散时：整栋楼所有人改按新方案的各自路线走（A→B→C 全楼同步）
    if (evacRun.value) startEvacuationRun()
    addNotification({
      title: '整栋楼疏散方案已切换',
      message: `${active.name}（${active.summary.zoneCount}个区域 / ${active.summary.personCount}人）`,
      level: 'success',
      time: new Date().toLocaleTimeString('zh-CN'),
    })
    return true
  }

  /** 当前整栋楼方案（2D/3D/后端共用一个源） */
  const activeBuildingPlan = computed(() => (
    buildingEvacuationPlans.value.find((p) => p.id === activeBuildingPlanId.value) || null
  ))

  // ── 楼栋方案隔离（P1.6.3 E1）：方案永远属于某一栋楼，切换楼栋不得串用 ──
  /** 当前方案集合所属楼栋（空集合时为空串） */
  const currentPlanBuildingId = computed(() => {
    const first = buildingEvacuationPlans.value[0]
    return first ? String(first.buildingId || '') : ''
  })
  const preferredPlanIdOf = (list) => (list.find((p) => p.recommended) || {}).id || (list[0] || {}).id || null

  /** 归档：把当前方案集合存回所属楼栋（切换楼栋前调用） */
  function archiveBuildingPlans() {
    const bid = currentPlanBuildingId.value
    if (!bid || !buildingEvacuationPlans.value.length) return
    buildingPlanCache.value[bid] = buildingEvacuationPlans.value.slice()
    if (activeBuildingPlanId.value) buildingPlanActiveCache.value[bid] = activeBuildingPlanId.value
  }

  /**
   * 切换到某栋楼自己的方案：
   *   ① 该楼栋已有方案（后端下发 / 本地已生成）→ 恢复它上次选中的方案；
   *   ② 该楼栋还没有方案 → 用同一套策略本地生成三套，并选中默认方案；
   *   ③ 任何情况下都不把别的楼栋的方案当作当前方案。
   */
  function activateBuildingPlansFor(buildingId) {
    const bid = String(buildingId || '')
    if (!bid || currentPlanBuildingId.value === bid) return false
    archiveBuildingPlans()
    const cached = buildingPlanCache.value[bid]
    if (cached && cached.length) {
      syncLegacyRouteState(cached, buildingPlanActiveCache.value[bid] || preferredPlanIdOf(cached))
      routeBuildingId.value = bid
      return true
    }
    const res = generateBuildingEvacuationPlans({ buildingId: bid })
    const plans = (res && res.plans) || []
    buildingPlanCache.value[bid] = plans.slice()
    buildingPlanActiveCache.value[bid] = activeBuildingPlanId.value
    routeBuildingId.value = bid
    return plans.length > 0
  }

  // 切换「当前查看楼栋」即切换到该楼栋自己的方案（UI 选择 / 直接改 dashboardView 都走这里）
  watch(
    () => (dashboardView.value ? dashboardView.value.selectedBuildingId : null),
    (bid) => { if (bid) activateBuildingPlansFor(String(bid)) },
  )

  // 火灾：封堵火源房间通往其推荐出口方向的那条走廊边（受影响通道），
  // 房间其余侧通路保留作为备用，从而实现「原推荐方案 BLOCKED → 自动切换备用方案」的局部重规划。
  // 火灾封堵：仅封「火源房间门口后的第一条走廊段」（危险缓冲区膨胀），
  // 房间→走廊的门保持开放，房间其余侧通路保留为备用，
  // 从而实现「原推荐方案因该段被封而需绕行/切换备用」的局部重规划，且不困死火源房间。
  function applyFireBlocking(fe) {
    // ⚠️ LEGACY 路径：仅在「没有整栋楼方案」时用于旧单楼层展示；
    // 整栋楼模式下火源由规划器（blockedNodes）统一避让，不再依赖这里的投影。
    if (activeBuildingPlan.value) return
    const m = routeMatrix.value
    const info = m && m.perZone && m.perZone[fe.area]
    const recId = info && info.recommendedId
    const rec = asArray(routePlans.value).find((p) => p.id === recId)
    const bNode = new Set(blockedNodeIds.value)
    const bEdge = new Set(blockedEdgeKeys.value)
    if (rec && rec.path && rec.path.length >= 3) {
      const idxRoom = rec.path.findIndex((n) => n.type === 'room' || n.type === 'door')
      const ci = rec.path.findIndex((n, i) => i > idxRoom && n.type === 'corridor')
      if (ci > 0 && ci + 1 < rec.path.length) {
        const a = rec.path[ci]
        const b = rec.path[ci + 1]
        bEdge.add(edgeKey(a.id, b.id)) // 封该走廊段（火灾缓冲区）
        bNode.add(b.id) // 危险区域膨胀：封该节点
      }
    }
    blockedNodeIds.value = [...bNode]
    blockedEdgeKeys.value = [...bEdge]
  }

  function toggleRouteDebug() {
    routeDebug.value = !routeDebug.value
    return routeDebug.value
  }

  function evaluatePlanFire(plan) {
    const fe = fireEvent.value
    if (!fe || fe.building !== plan.buildingName) return 'NORMAL'
    if (plan.floorsPassed.indexOf(fe.floor) < 0) return 'NORMAL'
    return planUsesBlocked(plan) ? 'BLOCKED' : 'WARNING'
  }

  // 火灾后：仅对受影响（使用被封堵节点的）区域重新寻路，未受影响区域保持原路线
  function replanRoutesForFire() {
    const fe = fireEvent.value
    if (!fe) return
    // ⚠️ LEGACY 路径：整栋楼模式下路线由 buildingEvacuationPlanner 统一避让火源，
    // 不做「按区域局部重规划」—— 那会把 routeMatrix.perZone 变成业务状态。
    if (activeBuildingPlan.value) return
    routeFireAutoSwitch.value = true
    const buildingName = fe.building
    const buildingId = routeBuildingId.value
    const maxF = getBuildingFloors(buildingId)
    routeGraphCache = buildBuildingGraph(maxF)
    const affectedZones = new Set()
    routePlans.value.forEach((p) => {
      p.status = evaluatePlanFire(p)
      if (p.status === 'BLOCKED') affectedZones.add(p.startArea)
    })
    affectedZones.forEach((zone) => {
      const exits = exitIdsOf(routeGraphCache, '1F')
      const startId = sharedNodeId(fe.floor, ZONE_NODE_KEY[zone])
      if (!routeGraphCache.nodes[startId]) return
      const newPlans = []
      exits.forEach((exit) => {
        const paths = kShortestPaths(
          routeGraphCache,
          startId,
          exit,
          blockNodeSet(),
          blockEdgeSet(),
          3
        )
        paths.forEach((p, idx) => {
          const plan = buildPlanFromPath(p, buildingId, buildingName, fe.floor, zone, exit, idx)
          plan.status = 'NORMAL'
          newPlans.push(plan)
        })
      })
      dedupeAndScore(newPlans)
      routePlans.value = routePlans.value.filter((p) => p.startArea !== zone)
      newPlans.forEach((p) => routePlans.value.push(p))
      if (routeMatrix.value && routeMatrix.value.perZone[zone]) {
        routeMatrix.value.perZone[zone].plans = newPlans
        routeMatrix.value.perZone[zone].recommendedId = newPlans[0] ? newPlans[0].id : null
        routeMatrix.value.perZone[zone].backupId = newPlans[1] ? newPlans[1].id : null
      }
    })
    recomputeRecommendations()
    const rec = currentRoutePlan.value
    if (rec) {
      addNotification({
        title: '路线自动重规划完成',
        message: `已识别火灾区域并自动重新规划受影响的 ${affectedZones.size} 个区域疏散路线，推荐方案已更新`,
        level: 'warning',
        time: new Date().toLocaleTimeString('zh-CN'),
      })
    }
  }

  // 重新计算每个区域的推荐 / 备用方案（排除被封堵路线）
  function recomputeRecommendations() {
    if (!routeMatrix.value) return
    Object.entries(routeMatrix.value.perZone).forEach(([zone, info]) => {
      const safe = info.plans.filter((p) => p.status !== 'BLOCKED')
      info.recommendedId = safe[0] ? safe[0].id : null
      info.backupId = safe[1] ? safe[1].id : null
    })
  }

  function setSelectedZone(zone) {
    selectedZone.value = zone
  }
  function setCurrentRoutePlan(zone, planId) {
    // 整栋楼语义：点选某条区域路线 = 切换到它所属的整栋楼方案（全楼同步）
    const plan = getRoutePlanById(planId)
    if (plan && plan.buildingPlanId && buildingEvacuationPlans.value.some((p) => p.id === plan.buildingPlanId)) {
      return setActiveBuildingPlan(plan.buildingPlanId)
    }
    // ⚠️ LEGACY：仅旧单区域结构的本地投影，不改变权威方案
    if (!routeMatrix.value) return false
    const info = routeMatrix.value.perZone[zone || selectedZone.value]
    if (!info) return false
    info.recommendedId = planId
    addNotification({
      title: '当前路线已设定',
      message: `${zone || selectedZone.value} 推荐路线已更新（legacy 投影）`,
      level: 'success',
      time: new Date().toLocaleTimeString('zh-CN'),
    })
    return true
  }
  function getRoutePlanById(id) {
    return asArray(routePlans.value).find((p) => p.id === id) || null
  }

  // 取方案在指定楼层的绘制线段
  function getRouteSegmentForFloor(plan, floorId) {
    if (!plan) return []
    if (plan.type === 'manual' && Array.isArray(plan.manualNodes) && plan.manualNodes.length) {
      return plan.manualNodes.map((n) => ({ x: n.x, y: n.y, type: n.type }))
    }
    return plan.path.filter((n) => n.floorId === floorId).map((n) => ({ x: n.x, y: n.y, type: n.type }))
  }

  // 取当前规划楼层所有区域的推荐路线（用于首页平面图同时显示多区域）
  function getAllZoneRoutes() {
    // 整栋楼方案优先：直接取当前方案中「本楼层各区域」的路线（2D 与 3D 同源）
    const bp = activeBuildingPlan.value
    if (bp && bp.routes && bp.routes.length) {
      const floorId = routeFloorId.value
      return bp.routes
        .filter((r) => r.floorId === floorId)
        .map((r) => {
          const plan = routeToRenderable(bp, r)
          return {
            zone: r.zone,
            color: ZONE_COLORS[r.zone] || '#4361EE',
            plan,
            routeId: r.routeId,
            segment: getRouteSegmentForFloor(plan, floorId),
          }
        })
    }
    const m = routeMatrix.value
    if (!m) return []
    return m.areas.map((zone) => {
      const recId = m.perZone[zone] && m.perZone[zone].recommendedId
      let plan = asArray(routePlans.value).find((p) => p.id === recId) || null
      // 方案↔平面图实时联动：管理员点选的方案（activeRoutePlanId）优先于推荐方案渲染
      const actId = activeRoutePlanId.value
      if (actId) {
        const actPlan = asArray(routePlans.value).find((p) => p.id === actId && p.startArea === zone)
        if (actPlan) plan = actPlan
      }
      return {
        zone,
        color: ZONE_COLORS[zone] || '#4361EE',
        plan,
        segment: plan ? getRouteSegmentForFloor(plan, m.floorId) : [],
      }
    })
  }

  // 根据路线出口方向自动联动沿途疏散灯
  // P1.6.2：楼层归属用统一三元组判定 —— buildingId（兼容旧 buildingName）+ floorId + 路线途经楼层
  function applyRouteToDevices(plan, bindingsAcc) {
    if (!plan) return
    const buildingKey = plan.buildingId || plan.buildingName
    const floorsPassed = plan.floorsPassed || []
    const bindings = bindingsAcc || []
    asArray(devices.value).forEach((d) => {
      if (
        d &&
        deviceInBuilding(d, buildingKey) &&
        floorsPassed.includes(d.floorId || d.floor) &&
        (d.type === 'evacuation_light' || d.type === 'emergency_light')
      ) {
        if (d.type === 'evacuation_light') {
          const dir = plan.exitSide === 'right' ? 'right' : 'left'
          d.direction = dir
          d.recommendedDirection = dir
          bindings.push({ routeId: plan.id, deviceId: d.id, direction: dir })
        } else {
          d.status = 'emergency'
          d.brightness = 100
          d.currentMode = 'emergency'
        }
      }
    })
    if (!bindingsAcc) routeDeviceBindings.value = bindings
    return bindings
  }

  function simulateRouteFire(building = '3号楼', floor = '5F', area = 'A区') {
    // demo 模式：火情由后端状态机驱动，本地不模拟（返回 false 由调用方提示）
    if (dataSource.isDemo) {
      console.error('[fireStore] demo 模式禁止本地模拟火灾，请通过后端状态机 START_FIRE 触发')
      return false
    }
    // triggerFireScenario 内部已对已有路线做 applyFireBlocking + replanRoutesForFire，
    // 此处只触发一次，避免重复重规划导致封堵边被二次改写、丢失火灾效果。
    return triggerFireScenario(building, floor, area)
  }

  function clearRouteFire() {
    clearFireScenario()
    routeFireAutoSwitch.value = false
    blockedNodeIds.value = []
    blockedEdgeKeys.value = []
    routePlans.value.forEach((p) => (p.status = 'NORMAL'))
    recomputeRecommendations()
    // 消防应急灯恢复常态
    setEmergencyMode(false)
    // ---- 六阶段应急处置流程复位：停疏散动画 / 人员坐标恢复 / 阶段归零（重置演示共用） ----
    stopEvacuationSim()
    if (rescueTimer) { clearTimeout(rescueTimer); rescueTimer = null }
    persons.value = JSON.parse(JSON.stringify(personsOrigin))
    emergencyStage.value = 0
    fireAlertVisible.value = false
    fireConfirmed.value = false
    emergencyResponseConfirmed.value = false
    routeDecisionConfirmed.value = false
    activeRoutePlanId.value = null
    buildingEvacuationPlans.value = []
    activeBuildingPlanId.value = null
    evacRun.value = false
    evacStats.value = { total: 0, evacuated: 0, remaining: 0, pct: 0 }
    strandedPersons.value = []
    rescueState.value = false
    rescueTask.value = null
    strandedLocated.value = false
    rescueCompleted.value = false
  }

  // -------- 手动模式（不影响自动算法，仅人工覆盖/编辑） --------
  function addManualNode(x, y, type = 'waypoint') {
    routeNodes.value.push({ id: `MN-${Date.now()}-${routeNodes.value.length}`, x, y, type, floor: routeFloorId.value })
  }
  function toggleManualEdge(nodeId) {
    const last = routeEdges.value[routeEdges.value.length - 1]
    if (last && last.length === 1) routeEdges.value[routeEdges.value.length - 1].push(nodeId)
    else routeEdges.value.push([nodeId])
  }
  function setManualStart(nodeId) {
    routeNodes.value.forEach((n) => (n.isStart = n.id === nodeId))
  }
  function setManualExit(nodeId) {
    routeNodes.value.forEach((n) => (n.isExit = n.id === nodeId))
  }
  function saveManualRoute() {
    const buildingName = getRouteBuildingName(routeBuildingId.value)
    const plan = {
      id: `RP-MANUAL-${Date.now()}`,
      name: '自定义方案',
      buildingId: routeBuildingId.value,
      buildingName,
      startFloor: routeFloorId.value,
      startArea: '手动',
      corridor: '走廊',
      stair: '楼梯',
      exit: '出口A',
      exitLabel: '自定义出口',
      exitSide: 'right',
      desc: '管理员手动规划路线',
      type: 'manual',
      status: 'NORMAL',
      recommended: false,
      floorsPassed: [routeFloorId.value],
      riskLevel: '低',
      score: 90,
      distance: 0,
      estimatedTime: 0,
      deviceCount: 0,
      congestion: 0,
      manualNodes: JSON.parse(JSON.stringify(routeNodes.value)),
      manualEdges: JSON.parse(JSON.stringify(routeEdges.value)),
    }
    routePlans.value.push(plan)
    addNotification({
      title: '手动路线已保存',
      message: '自定义疏散方案已加入候选列表',
      level: 'success',
      time: new Date().toLocaleTimeString('zh-CN'),
    })
    return plan
  }
  function clearManualRoute() {
    routeNodes.value = []
    routeEdges.value = []
  }

  // ================== 状态持久化（页面切换/刷新不丢演示状态） ==================
  // 仅持久化可安全恢复的快照字段；运行中的疏散动画在恢复后定格为暂停态（evacRun=false），
  // 用户可通过「重置演示」或 EvacuationView 的启动按钮继续。
  const PERSIST_KEY = 'fireStore.demoState.v1'
  const persistRefs = {
    fireEvent,
    emergencyStage,
    fireAlertVisible,
    fireConfirmed,
    emergencyResponseConfirmed,
    routeDecisionConfirmed,
    activeRoutePlanId,
    routePlans,
    routeMatrix,
    routeBuildingId,
    routeFloorId,
    currentRoutePlanId,
    evacStats,
    strandedPersons,
    strandedLocated,
    rescueState,
    rescueTask,
    rescueCompleted,
    persons,
    devices,
    dashboardView,
    operationLogs,
  }

  let persistTimer = null
  function writePersistSnapshot() {
    try {
      const snapshot = {}
      for (const [k, r] of Object.entries(persistRefs)) snapshot[k] = r.value
      // 运行态动画标志不持久化，恢复后为暂停/定格
      snapshot.evacRun = false
      localStorage.setItem(PERSIST_KEY, JSON.stringify(snapshot))
    } catch (e) {
      // 存储不可用（隐私模式/超配额）时静默降级，不影响演示
    }
  }

  function restorePersistSnapshot() {
    try {
      const raw = localStorage.getItem(PERSIST_KEY)
      if (!raw) return
      const snapshot = JSON.parse(raw)
      for (const [k, r] of Object.entries(persistRefs)) {
        if (snapshot[k] !== undefined) r.value = snapshot[k]
      }
      // 若恢复到了疏散进行中的阶段，定格为暂停（动画定时器无法跨刷新存活）
      if (emergencyStage.value >= 4) evacRun.value = false
    } catch (e) {
      // 快照损坏则丢弃
      try { localStorage.removeItem(PERSIST_KEY) } catch (_) {}
    }
  }

  restorePersistSnapshot()
  // 持久化快照可能是旧格式：恢复后统一升级为「人员统一契约」（保证 2D/3D 字段齐全）
  persons.value = normalizePersons(persons.value)

  watch(
    Object.values(persistRefs),
    () => {
      clearTimeout(persistTimer)
      persistTimer = setTimeout(writePersistSnapshot, 400)
    },
    { deep: true }
  )

  return {
    buildings,
    devices,
    alarms,
    stats,
    selectedBuilding,
    selectedDevice,
    currentEmergency,
    rescueList,
    emergencyStepList,
    notifications,
    demoMode,
    updateTime,
    deviceStats,
    deviceTypeStats,
    alarmStats,
    selectBuilding,
    selectDevice,
    selectFloor,
    selectZone,
    addNotification,
    removeNotification,
    dismissNotification,
    simulateAlarm,
    simulateFireAlarm,
    triggerFireScenario,
    updateDeviceStatus,
    resolveAlarm,
    startEmergency,
    advanceEmergencyStep,
    completeEmergency,
    toggleDemoMode,
    resetDemoState,
    updateRandomData,
    initFromRemote,
    remoteReady,
    remoteError,
    dataSourceDegraded,
    applyDemoSnapshot,
    applyDemoTick,
    persons,
    personStats,
    lightingStatus,
    lightingDevices,
    brightnessHistory,
    lightingEnergy,
    inspectionResult,
    inspectionHistory,
    inspectionSteps,
    inspectionDevices,
    inspectionInProgress,
    evacuationDevices,
    evacuationLogs,
    fireEvent,
    riskAreas,
    deviceConfig,
    demoStep,
    demoStepList,
    personTrend,
    zoneHeatmap,
    // ── 人员统一数据链（P1.6.1）：后端 / 2D / 3D 同一 id、同一 routeId ──
    personRuntimes,
    personRouteId,
    countNonCanonicalPersons,
    // ── 设备统一数据链（P1.6.2）：后端 / 2D / 3D 同一设备 id、同一楼层归属 ──
    deviceFloorsOfBuilding,
    countNonCanonicalDevices,
    onlineSensorCount,
    riskAreaCount,
    deviceHealthScore,
    refreshBuildings,
    refreshPersonStats,
    refreshStats,
    simulatePerson,
    simulateRisk,
    startInspection,
    completeInspection,
    advanceInspectionStep,
    resetInspection,
    switchLightingMode,
    simulatePersonEnter,
    switchEvacuationDirection,
    addEvacuationLog,
    batchSwitchEvacuationDirection,
    setEmergencyMode,
    clearFireScenario,
    getDevicesFiltered,
    updateDeviceConfig,
    startDemoFlow,
    advanceDemoStage,
    resetDemoFlow,
    strandedPersons,
    rescueState,
    rescueTask,
    strandedLocated,
    rescueCompleted,
    confirmStrandedLocation,
    confirmRetainedPersonnel,
    dispatchRescueTeam,
    adjustEvacuationDirection,
    startPulseFlash,
    nodeTypes,
    lightingModes,
    emergencyMode,
    // ── 五阶段应急处置流程（首页演示主控，状态集中于此） ──

    emergencyStage,
    fireAlertVisible,
    fireConfirmed,
    emergencyResponseConfirmed,
    routeDecisionConfirmed,
    activeRoutePlanId,
    evacRun,
    evacStats,
    detectFireScenario,
    activateEmergencyResponse,
    // P1.7.2：用户确认语义（查看火情 / 确认火情），WS 快照无权覆盖
    dismissFireAlert,
    confirmFireAcknowledged,
    generateEvacuationOptions,
    selectEvacuationPlan,
    backToPlanList,
    confirmEvacuationPlan,
    startEvacuationRun,
    stopEvacuationSim,
    resetEmergencyFlow,
    syncStageAfterExternalFire,
    routePlans,
    currentRoutePlanId,
    currentRoutePlan,
    routeMatrix,
    selectedZone,
    blockedNodeIds,
    blockedEdgeKeys,
    routeMode,
    routeDebug,
    routeBuildingId,
    routeFloorId,
    routeStartArea,
    routeTargetExit,
    routeNodes,
    routeEdges,
    routeDeviceBindings,
    routeFireAutoSwitch,
    generateRoutePlans,
    // ── 整栋楼疏散（scope = BUILDING） ──
    buildingEvacuationPlans,
    activeBuildingPlanId,
    activeBuildingPlan,
    evacuationScope,
    generateBuildingEvacuationPlans,
    setActiveBuildingPlan,
    applyBuildingPlans,
    buildingRouteOfPerson,
    toggleRouteDebug,
    setCurrentRoutePlan,
    setSelectedZone,
    getRoutePlanById,
    getRouteSegmentForFloor,
    getAllZoneRoutes,
    applyRouteToDevices,
    simulateRouteFire,
    clearRouteFire,
    replanRoutesForFire,
    addManualNode,
    toggleManualEdge,
    setManualStart,
    setManualExit,
    saveManualRoute,
    clearManualRoute,
    dashboardView,
    saveDashboardViewState,
    restoreDashboardView,
    setDashboardFire,
    clearDashboardFire,
    operationLogs,
    addOperationLog,
  }
})

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
  defaultLighting as initialLightingStatus,
  brightnessHistory as initialBrightnessHistory,
} from '../mock/lighting'
// P1.7.3-B4-02：不再从 mock/lighting 导入「第二份灯具台账」。
// 灯具设备的唯一权威 = devices（Backend / WS → demoStore → fireStore.devices），
// lightingDevices 只是它的只读派生投影（见下方定义）。
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
  exitIdsOf, ZONE_NODE_KEY, NODE_TYPE, floorNum,
} from '../../shared/evacuation/routeGraph.js'
// K-1B.2：规范出口节点集合（唯一权威 = floorTopology.EXIT_NODE_IDS）
import { EXIT_NODE_IDS } from '../../shared/evacuation/floorTopology.js'
// 整栋楼疏散（scope = BUILDING）：一次火灾 = 一栋楼的一次整体疏散任务
import {
  planBuildingStrategies, routeOfPerson as buildingRouteOfPerson, validateBuildingEvacuationPlan,
  resolvePlanningZone,
} from '../../shared/evacuation/buildingEvacuationPlanner.js'
import { EVACUATION_SCOPE, STRATEGY, zoneKeyOf } from '../../shared/evacuation/buildingEvacuationTypes.js'
// P1.8.2 Stage 1：出口运行态统一契约层（与后端共用同一份规范化 / 可用性判定）
// P1.8.2 Stage 1.3：出口失效的唯一权威 = applyExitInvalidation（fireStore 不再自实现判据），
// 故不再导入 usableExitNodeIds / hasUsableExit —— 它们只在 shared 层使用，
// 在此处使用会把「含静态补齐项」的宽口径重新引入生产（P1-1 根因）。
import {
  defaultExitStates, normalizeExitStates, applyExitInvalidation,
  // Stage 2-A：路线「可执行状态」白名单 —— 与 isRouteUsable / shouldInvalidateByExits
  // 同一来源，避免执行入口另立一套状态口径（BLOCKED/DONE/null/未知一律不在白名单 ⇒ fail-closed）
  USABLE_ROUTE_STATUSES,
} from '../../shared/evacuation/exitRuntime.js'
// 路线状态枚举唯一来源（RW-2 恢复清洗用于识别合法状态：缺失/未知一律归一为 null，绝不放行）
import { PLAN_STATUS } from '../../shared/evacuation/routeTypes.js'
// 人员运行时统一契约（P1.6.1）：后端 / 2D / 3D 同一个 id、同一个 routeId
import {
  normalizePersonRuntime, assignPersonRuntime, isCanonicalPerson, pickRetainedCandidates,
  BUILDING_ID_TO_NAME,
} from '../../shared/person/personRuntime.js'
// 设备运行时统一契约（P1.6.2）：后端 / 2D / 3D 同一个设备 id、同一个楼层归属（buildingId/floorId/zone）
import {
  normalizeDeviceRuntime, assignDeviceRuntime, isCanonicalDevice,
  devicesOnFloor, floorsOfDevices, deviceInBuilding,
  // P1.7.3-B3：canonical 归属解析（person / device 共用同一套；别名只在 canonical 缺失时兜底）
  buildingIdOf, floorIdOf, zoneOf, buildingNameOf,
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
// P1.8.2：疏散灯方向按「路线路径几何 + 设备位置」逐台裁决（取代整层统一的 exitSide）
// P1.8.2 第一阶段：裁决结果状态词汇（resolved / conflict / undetermined / unlinked）
import { resolveDeviceDirections, DIRECTION_VERDICT, validDisplayDirection } from '../../shared/evacuation/deviceDirection.js'
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
    // P1.8.2 第一阶段：复位时清除本轮裁决状态，避免上一轮结论残留
    routeDirectionVerdicts.value = []
    routeNoPathRouteIds.value = []
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
  /**
   * P1.8.2 Stage 1：应用后端下发的出口运行态。
   *
   * 缺失 / 过期 / 结构非法时：回落到**静态权威定义**并置 degraded 标志 + console 告警，
   * **绝不静默回退为「已知不安全的可用状态」** —— 即不使用陈旧的运行态
   * （陈旧状态可能把已关闭的出口误报为可用）。
   */
  function applyExitRuntimeStates(raw) {
    const n = normalizeExitStates(raw)
    exitRuntimeStates.value = n.exits
    // Stage 1.3：落盘「原始上报」与「真实上报可用集」。
    //   · n.exits **含静态补齐项**，永远不得作为「上报是否完整」的证据；
    //   · 唯一准入来源 = n.reportedUsableNodeIds（仅含已上报且可解析的条目）。
    //
    // 【D1-A 语义约定（已裁决，禁止擅自扩大）】两种输入必须严格区分：
    //   ① raw = null ⇒ **从未收到过任何出口运行态数据**。
    //      mock（离线）模式下 applyDemoSnapshot 从不被调用，该状态是**永久态**而非瞬时窗口；
    //      此时沿用 Stage 1.3 之前的兼容行为：出口维度不参与判定、usableExitsOf 不收窄。
    //      这是「无数据源」，**不是**「把缺失输入当成完整上报」，也**不得**据此宣称
    //      mock 模式已实现严格 fail-closed。
    //   ② raw = [] / undefined / 非数组 / 结构非法 / 条目不可解析 ⇒ **已收到但缺失或无效**，
    //      按既定 Policy B 处理：归一化为 missing/invalid，有效可用集取「已上报且可解析」的
    //      子集（可能为空）⇒ fail-closed。
    //   因此本行把 undefined/null 一律落为 `[]`，使 ② 与 ① 在数据层不再混淆。
    //   ⚠️ 已知不一致（登记在案、不在本阶段修复）：① 状态下诊断位
    //      exitStateDegraded = true / exitStateReason = 'missing'（来自 ref 初始值），
    //      但行为是 fail-open；读取诊断位时不得反推「已 fail-closed」。
    exitRawStates.value = raw === undefined || raw === null ? [] : raw
    exitReportedUsableNodeIds.value = n.reportedUsableNodeIds
    exitStateDegraded.value = n.degraded
    exitStateReason.value = n.reason
    if (n.degraded) {
      console.warn(
        `[fireStore] 出口运行态${n.reason === 'missing' ? '缺失' : n.reason === 'invalid' ? '结构非法' : '不完整'}`
        + `，已回落到静态权威定义（全 OPEN）并告警，不作为可信运行态`,
      )
    }
  }

  /**
   * P1.8.2 Stage 1.3：路线状态的**唯一收口函数**（路径 A 出口 / 路径 C 火源 统一在此）。
   *
   * 两个维度都是当前 store 状态的纯函数 ⇒ 每一步都**全量重算**（不是增量累加）：
   *   ① 火源维度：p.status = evaluatePlanFire(p)，DONE 跳过；且**同时作用于两个投影**
   *   ② 出口维度：委托 applyExitInvalidation（唯一权威；内部保护 DONE、以对象展开保留历史字段）。
   * ⇒ 幂等，且与触发顺序无关（这是本阶段要解决的路径 A/C 互相覆盖问题）。
   *
   * 优先级：出口失效 > 火源结果（NORMAL / WARNING / BLOCKED）> NORMAL；**DONE 永不改写**。
   *
   * ⚠️ 必须整体采纳 out.routePlans / out.perZone / out.activeRoutePlanId：
   *   两投影各自成对象，部分采纳会出现「同一 id 两投影状态不一致」。
   *
   * ⚠️ exitRawStates === null（**从未收到过任何出口运行态数据**）：不做出口维度判定 ——
   *   既不把静态默认当作真实上报，也不做「无数据即整批阻断」的误判。
   *   【D1-A】这是「初始化前 / 无数据源」的兼容行为：mock（离线）模式下
   *   applyDemoSnapshot 从不被调用，该状态为**永久态**（非瞬时窗口），
   *   因此 mock 模式**不实现**严格 fail-closed，不得反向宣称。
   *   一旦收到过任何一次上报（即使是空数组 / 非法结构）即进入 fail-closed。
   *   ⚠️ 该状态下诊断位 exitStateDegraded=true / exitStateReason='missing' 与
   *   fail-open 行为并存（已知不一致，登记在案，不在本阶段修复）。
   *
   * @returns {number} 协调后处于 BLOCKED 的路线 id 数（去重；恒不含 DONE）
   *
   * ⚠️【P1.8.2 Stage 2-A / K-4 · 状态权威源边界】本函数**只**写 routePlans 与
   *    routeMatrix.perZone 两个投影，**从不写** activeBuildingPlan.routes ——
   *    EvacuationRoute 无 status 字段，且 buildingEvacuationPlans 直接持有后端快照对象
   *    （applyBuildingPlans 不克隆；buildingPlanCache 为浅拷贝；routesByZone 与 routes
   *    互为别名），前端改写即污染后端数据。⇒ 展示层（getAllZoneRoutes / currentRoutePlan）
   *    必须经 reconciledRouteView() 从 routePlans 取状态；bp.routes 只提供几何与规划元数据。
   *    ⚠️ 本函数**不覆盖全部业务行为**：startEvacuationRun(:1479) 与
   *    applyRouteToDevices(:1339/:1407/:3095) 仍各自直接 routeToRenderable(bp, route)，
   *    其状态门禁问题属**独立遗留项**，不因 K-4 上线而被视为已修复。
   */
  function reconcileRouteStatuses() {
    // ① 火源维度：必须同时作用于 **两个投影**。
    //   routePlans 与 perZone[].plans 在 generateRoutePlans 中是同一批对象（别名），
    //   但在 syncLegacyRouteState / legacy 投影中是两条**独立对象链** ——
    //   只改 routePlans 会出现「routePlans=WARNING 而 perZone 仍 NORMAL」的两投影矛盾。
    //   evaluatePlanFire 是 store 状态的纯函数 ⇒ 重复作用幂等，别名情形无副作用。
    const applyFireDimension = (list) => (list || []).forEach((p) => {
      if (!p || p.status === 'DONE') return
      p.status = evaluatePlanFire(p)
    })
    applyFireDimension(routePlans.value)
    if (routeMatrix.value && routeMatrix.value.perZone) {
      Object.values(routeMatrix.value.perZone).forEach((info) => applyFireDimension(info.plans))
    }
    const list = asArray(routePlans.value).filter(Boolean)
    if (exitRawStates.value === null || exitRawStates.value === undefined) {
      recomputeRecommendations()
      return list.filter((p) => p.status === 'BLOCKED').length
    }
    const out = applyExitInvalidation({
      exits: exitRawStates.value,
      routePlans: routePlans.value,
      perZone: routeMatrix.value && routeMatrix.value.perZone ? routeMatrix.value.perZone : {},
      activeRoutePlanId: activeRoutePlanId.value,
    })
    routePlans.value = out.routePlans
    if (routeMatrix.value) routeMatrix.value.perZone = out.perZone
    activeRoutePlanId.value = out.activeRoutePlanId
    exitStateDegraded.value = out.exitStates.degraded
    exitStateReason.value = out.exitStates.reason
    return (out.affectedRouteIds || []).length
  }

  /**
   * P1.8.2 Stage 1 目标 6：出口关闭后，已有路线不得继续被当作当前有效路线。
   *
   * Stage 1.3：判据不再在此自实现 —— 统一委托 reconcileRouteStatuses（单一权威）。
   * 保留函数名与「返回被标记数量」语义，导出契约（下方 exports）不变。
   * @returns {number} 协调后处于 BLOCKED 的路线 id 数（去重；恒不含 DONE）
   */
  function invalidateRoutesWithUnusableExit() {
    return reconcileRouteStatuses()
  }

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

  /**
   * P1.7.3-B1：demo 模式本地写入守卫。
   * demo 模式下 Backend / DemoWorld 是业务状态唯一权威，写入链只能是
   *   DemoRoom → DemoWorld → WebSocket → demoStore → fireStore。
   * fireStore 里遗留的本地业务写入（阶段 / 设备 / 方案 / 灯光）一律禁止，
   * 命中返回 true（表示「已拦截」），mock / api 模式不受影响。
   */
  function demoGuard(apiName) {
    if (!dataSource.isDemo) return false
    console.warn(`[fireStore] demo 模式禁止本地业务写入：${apiName}（请通过后端状态机 / WebSocket 快照驱动）`)
    return true
  }

  function applyDemoSnapshot(snap) {
    if (!snap) return
    // P1.7.3-B3-05（P0-01）：绑定 demo 方案意向 → fireStore 的单向投影（幂等）
    bindPlanSelectionProjection()
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
      const fireFloorId = floorIdOf({ floorId: snap.fire.floorId })
      const fireZone = zoneOf(snap.fire)
      fireEvent.value = {
        id: snap.fire.id,
        buildingId: fireBuildingId,
        floorId: fireFloorId,
        zone: fireZone,
        // P1.7.3-B3：别名由 canonical 派生（buildingName 与 buildingId 冲突时以 canonical 为准）
        building: BUILDING_ID_TO_NAME[fireBuildingId] || snap.fire.buildingName || snap.fire.buildingId || '',
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
      const authoritative = dataSource.isDemo
      const demoVerdicts = []
      asArray(devices.value).forEach((d) => {
        if (!d) return
        captureBusinessSeed(d, DEVICE_BUSINESS_FIELDS)
        const r = dmap.get(String(d.id))
        if (!r) {
          // demo 模式：本次快照未下发 = 不由后端托管 → 只能保持静态结构
          if (authoritative) restoreBusinessSeed(d, DEVICE_BUSINESS_FIELDS)
          return
        }
        assignDeviceRuntime(d, r)
        if (authoritative) applyStrictDeviceRuntime(d, r)
        // R-11：只为「本次快照命中的灯具」投影裁决；未命中的设备天然无条目（回落 none）
        if (authoritative && (d.type === 'evacuation_light' || d.type === 'emergency_light')) {
          demoVerdicts.push(demoDirectionVerdictOf(d, r))
        }
      })
      if (authoritative) projectDemoDirectionVerdicts(demoVerdicts)
    }
    // ⑤ 照明
    if (snap.lighting) {
      // P1.7.3-B4-03：snap.lighting 只是「全局阶段标志」（整栋楼是否处于应急联动），
      // 它不是设备运行态来源 —— brightness / currentMode / emergencyFlash 的唯一权威是 ④ 已合并的 devices。
      // lightingStatus 降级为「选中设备的展示镜像」，避免它成为 2D / 3D / LightingView 之外的第二份运行态。
      emergencyMode.value = snap.lighting.mode === 'emergency'
      const mirror = (lightingDevices.value || []).find(
        (d) => d && String(d.id) === String(lightingStatus.value?.currentDevice?.id),
      ) || (lightingDevices.value || []).find(
        (d) => d && String(d.buildingId) === String(snap.fire?.buildingId || ''),
      ) || lightingDevices.value[0] || null
      if (mirror) {
        lightingStatus.value = {
          ...lightingStatus.value,
          currentDevice: mirror,
          brightness: mirror.brightness,
          currentMode: lightingModes[mirror.currentMode] || lightingStatus.value?.currentMode,
          mode: mirror.currentMode || 'daily',
          status: mirror.status,
        }
      }
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
    // ⑨ 出口运行态（P1.8.2 Stage 1，D-1 = B）：后端是唯一权威来源
    applyExitRuntimeStates(snap.exits)
    // 目标 6：出口可用性变化后，已有路线不得继续被当作「当前有效路线」
    invalidateRoutesWithUnusableExit()
    refreshBuildings()
    refreshStats()
    refreshPersonStats()
  }

  // ════════ P1.7.3-B3-05（P1-01）：Demo 模式下「人员 / 设备业务状态」的唯一权威 ════════
  // Backend DemoWorld → DemoRoom snapshot/tick → demoStore → fireStore。
  // 本地 seed（static persons / initialDevices …）只允许提供「初始静态结构」：
  //   ① 出现在本次后端运行时的对象  → 业务字段一律以后端下发为准；后端没给的字段
  //                                   落「契约默认值」（normalize*Runtime 的输出），
  //                                   禁止用本地 seed 值做隐式补全；
  //   ② 没出现在本次运行时的对象    → 一律回到 seed 基线，不允许残留上一轮 demo 的业务状态。
  const PERSON_BUSINESS_FIELDS = [
    'status', 'movementType', 'routeId', 'routePoints', 'progress',
    'position', 'x', 'y', 'evacuating', 'retained', 'rescued', 'waypoint', 'route',
  ]
  const DEVICE_BUSINESS_FIELDS = [
    'status', 'currentMode', 'direction', 'recommendedDirection', 'brightness', 'emergencyFlash',
  ]
  const businessSeed = new WeakMap()
  const cloneValue = (v) => (
    Array.isArray(v) ? v.slice()
      : (v && typeof v === 'object' ? { ...v } : v)
  )
  /** 首次接触对象时留一份「静态基线」快照（只有我来写，业务链路不得引用它做决策） */
  function captureBusinessSeed(obj, fields) {
    if (!obj || businessSeed.has(obj)) return
    const base = {}
    fields.forEach((f) => {
      if (!(f in obj)) { base[f] = undefined; return }
      base[f] = cloneValue(obj[f])
    })
    businessSeed.set(obj, base)
  }
  /** 把「非后端托管」对象还原成纯静态结构（去掉所有业务状态残留） */
  function restoreBusinessSeed(obj, fields) {
    const base = businessSeed.get(obj)
    if (!base) return
    fields.forEach((f) => {
      if (base[f] === undefined) { delete obj[f]; return }
      obj[f] = cloneValue(base[f])
    })
    // mock / 本地疏散运行态：非后端托管对象同样不得残留（否则 3D 会走它的本地路线优先级）
    delete obj._evac
    delete obj._evacDone
  }
  /** 人员：后端运行时「整字段覆盖」（后端缺省 → 契约默认值，不用 seed 值补全） */
  function applyStrictPersonRuntime(target, source) {
    const n = normalizePersonRuntime(source)
    target.status = n.status
    target.routeId = n.routeId
    target.routePoints = n.routePoints
    target.progress = n.progress
    if (n.position) { target.position = n.position; target.x = n.position.x; target.y = n.position.y }
    else if (!('position' in target)) target.position = null
    if (n.movementType) target.movementType = n.movementType
    else delete target.movementType
    if (typeof n.evacuating === 'boolean') target.evacuating = n.evacuating
    else delete target.evacuating
    if (typeof n.retained === 'boolean') target.retained = n.retained
    else delete target.retained
    if (typeof n.rescued === 'boolean') target.rescued = n.rescued
    else delete target.rescued
    if (typeof n.waypoint === 'number') target.waypoint = n.waypoint
    else delete target.waypoint
    if (Array.isArray(n.route)) target.route = n.route.slice()
    else delete target.route
  }
  /** 设备：后端运行时「整字段覆盖」（同上） */
  function applyStrictDeviceRuntime(target, source) {
    const n = normalizeDeviceRuntime(source)
    target.status = n.status
    target.currentMode = n.currentMode
    target.direction = n.direction
    if ('recommendedDirection' in target) target.recommendedDirection = n.direction
    target.brightness = n.brightness
    target.emergencyFlash = n.emergencyFlash
  }

  /**
   * R-11：demo 快照 → 方向裁决投影的**单台设备**映射。
   * 权威输入：`deviceId` 取 store 设备 id（与快照按 String(id) 对齐）；
   * 方向取 **DTO 原值 `dto.direction`**（不是已过 directionOf 默认值的 target.direction）；
   * 非法/缺失一律不产出方向（fail-closed），只记入 undetermined 供审计。
   */
  function demoDirectionVerdictOf(device, dto) {
    const raw = dto ? dto.direction : undefined
    const dir = validDisplayDirection(raw)
    const deviceId = String(device.id)
    if (dir) {
      return { deviceId, state: DIRECTION_VERDICT.REMOTE, direction: dir, source: 'demo-backend' }
    }
    const missing = raw === undefined || raw === null || raw === ''
    return {
      deviceId,
      state: DIRECTION_VERDICT.UNDETERMINED,
      source: 'demo-backend',
      reason: missing ? 'backend-direction-missing' : 'backend-direction-invalid',
    }
  }

  /** 裁决表内容签名：demo 投影的幂等基准（取自当前表，不设影子状态） */
  function directionVerdictSignature(list) {
    return (Array.isArray(list) ? list : [])
      .map((v) => `${v.deviceId}|${v.state}|${v.direction || ''}|${v.reason || ''}`)
      .sort()
      .join('\n')
  }

  /**
   * R-11：把 demo 快照投影写入裁决表。
   * 契约：仅 demo 模式（反向守卫）、**整表替换**、与当前表内容相同则跳过。
   */
  function projectDemoDirectionVerdicts(entries) {
    if (!dataSource.isDemo) return
    const list = Array.isArray(entries) ? entries : []
    // 幂等基准取自当前表：表被清空或改写（含 manual 覆盖）后，相同快照必须重新写入
    if (directionVerdictSignature(list) === directionVerdictSignature(routeDirectionVerdicts.value)) return
    routeDirectionVerdicts.value = list
  }

  /**
   * 后端人员运行时 → 2D 人员对象（P1.6.1 统一契约）
   * 按 id 合并（后端 / 2D / 3D 同一个人员 id），只写后端下发的权威字段：
   * routeId / routePoints / progress / position 一律来自后端，前端不推导。
   */
  function applyDemoPersons(list) {
    const source = Array.isArray(list) ? list : []
    const pmap = new Map(source.map((p) => [String(p.id), p]))
    const authoritative = dataSource.isDemo
    asArray(persons.value).forEach((p) => {
      if (!p) return
      captureBusinessSeed(p, PERSON_BUSINESS_FIELDS)
      const r = pmap.get(String(p.id))
      if (!r) {
        // demo 模式：后端本次运行时的「成员名单」即权威边界，名单外一律保持静态结构
        if (authoritative) restoreBusinessSeed(p, PERSON_BUSINESS_FIELDS)
        return
      }
      assignPersonRuntime(p, r)
      if (authoritative) applyStrictPersonRuntime(p, r)
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
    // P1.7.3-B3：canonical 归属（floorId / zone）
    const route = buildingRouteOfPerson(bp, { floorId: floorIdOf(p), zone: zoneOf(p) })
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
  // P1.7.3-B4-02：灯具设备**不再独立维护第二份集合**。
  // 唯一权威链：Backend / WS → demoStore.devices → fireStore.devices →（本投影）→ LightingView。
  // 只读派生：LightingView / 各消费方只能读它，禁止写回；成员集合恒等于 devices 里的 emergency_light。
  const lightingDevices = computed(
    () => asArray(devices.value).filter((d) => d && d.type === 'emergency_light'),
  )
  // 聚合态里的「当前设备」也必须与统一集合同源（旧台账对象已退休）
  if (lightingStatus.value) lightingStatus.value.currentDevice = lightingDevices.value[0] || null
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

  /**
   * P2-03：后端 operation_logs 是操作日志的唯一权威。
   * 此前只在 initFromRemote 就读过一次，之后后端（含 demo 六阶段）写入的记录前端永不回读，
   * 于是「后台日志」页看不到演示流程的阶段记录。这里提供主动回读入口。
   */
  async function refreshOperationLogs() {
    if (!dataSource.isRemote) return false
    try {
      const remote = await operationLogService.list({ limit: 200 })
      if (Array.isArray(remote) && remote.length) operationLogs.value = remote
      return true
    } catch {
      return false
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
  /**
   * P1.8.2 Stage 1（D-1 = B）：出口运行态 —— 后端（Worker DO）是唯一持有方。
   *
   * 来源优先级：后端快照 snap.exits > 静态权威默认 EXIT_DEFS。
   * 缺失 / 过期 / 结构非法时回落到静态默认并置 exitStateDegraded = true（**显式告警，不静默**），
   * 绝不把「陈旧的运行态」当作可用 —— 陈旧状态可能把已关闭的出口误报为可用。
   * 本阶段不接外部状态源（D-6 = A），容量不参与任何计算（D-7 = A）。
   */
  // 初始值 = 静态权威定义（安全基线）：degraded=true 表示「尚未收到后端权威运行态」
  const exitRuntimeStates = ref(defaultExitStates()) // ExitRuntimeState[]（含静态补齐，仅供展示）
  const exitStateDegraded = ref(true) // true = 当前用的是回落默认值，非后端权威状态
  const exitStateReason = ref('missing') // 'missing' | 'invalid' | 'partial' | null
  /**
   * P1.8.2 Stage 1.3：策略 B 的两个输入态。
   *
   * · exitRawStates：**原始**上报（未经过静态补齐）。
   *   - null ⇒ 从未收到过任何上报 ⇒ 出口维度不参与判定（既不把静态默认当真实上报，
   *     也不做「无数据即整批阻断」的误判）。
   *     【D1-A】applyExitRuntimeStates 的唯一调用源是 applyDemoSnapshot（= demoStore），
   *     因此 **mock / 离线模式下该状态为永久态**，属「初始化前的兼容行为」，
   *     不得宣称 mock 模式已实现严格 fail-closed。
   *   - [] / undefined / 非法结构 / 部分 ⇒ 已收到上报但不完整 ⇒ normalize 判
   *     missing/invalid/partial ⇒ 有效可用集为「已上报且可解析」的子集，fail-closed。
   *   每当收到新快照即**整体替换**，永不与上一次合并（不复用过期出口状态）。
   * · exitReportedUsableNodeIds：真实上报可用集，是路径 A（失效）与路径 B（规划筛选）
   *   **唯一**的准入来源；n.exits 与 usableNodeIds 含静态补齐项，一律不得用于准入。
   */
  const exitRawStates = ref(null) // null = 从未收到过上报
  const exitReportedUsableNodeIds = ref([]) // 真实上报且可解析的出口 nodeId
  const routeNodes = ref([]) // 手动模式节点
  const routeEdges = ref([]) // 手动模式连线
  const routeDeviceBindings = ref([]) // 路线-设备方向绑定
  /**
   * P1.8.2：**方向裁决表**（按设备），是「当前方向能否作为指引显示」的唯一依据。
   * 两个主写者互斥：非 demo 模式 = 路线裁决（applyRoutesToDevices）；
   * demo 模式 = 后端运行时投影（projectDemoDirectionVerdicts）。
   *
   * ⚠️ 不得再用设备旧有的 `direction` 字段反推本轮结果：未产出裁决时设备保持旧值，
   *    旧值只代表上一次写入，**不是**本轮有效指引。
   * ⚠️ 写入契约：只允许**整表替换**（引用变化是唯一失效信号）；就地改写会让显示层漏检。
   * 元素形状：{deviceId, state, routeId?, direction?, distance?, dx?, candidates?, reason?, overrideSource?, source?}
   */
  const routeDirectionVerdicts = ref([])
  /** 裁决表索引（deviceId → verdict）：显示层 O(1) 查询，随整表替换自动失效 */
  const directionVerdictIndex = computed(() => new Map(routeDirectionVerdicts.value.map((v) => [v.deviceId, v])))
  /** 本轮因缺少 path 几何而未参与裁决的路线（典型：手动路线），非空时 UI 须明示「未联动」 */
  const routeNoPathRouteIds = ref([])
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

  // ════════════════════════════════════════════════════════════════════
  // K-1B.2：权威图统一暴露 + 独立手动可执行路线（沿权威图逐节点选点）
  // ════════════════════════════════════════════════════════════════════
  // 独立数据源：不并入 routePlans / routeMatrix.perZone / activeBuildingPlan.routes。
  const manualExecutableRoutes = ref([]) // 手动可执行路线（仅含权威图选出的路线）
  const manualRouteDrafts = ref([])      // 自由绘制草稿（不可执行，仅草稿）
  // 权威图选点编辑态（区别于自由绘制草稿的 routeNodes/routeEdges）
  const authGraphPath = ref([])          // 已选节点 id 序列（权威图节点 id）
  const authGraphDraftId = ref(null)     // null=新建；否则=正在替换的既有路线 id
  const authGraphError = ref(null)       // 最近一次选点/保存失败原因（可诊断）
  // 恢复时的结构损坏剔除诊断（仅记录，不删除拓扑失效路线）
  const manualRoutesRestoreReport = ref([])

  /** 当前路线规划楼栋（可靠识别；识别失败返回 null，禁止静默回退到其它楼栋） */
  function currentManualBuilding() {
    const bid = String(routeBuildingId.value || '')
    if (!bid) return null
    return asArray(buildings.value).find((x) => x && String(x.id) === bid) || null
  }

  /**
   * 权威图：UI 选点与后续校验共享同一构建规则（buildBuildingGraph + 真实现有 getBuildingFloors）。
   * 当前楼栋无法可靠识别 / 层数非法 / 建图异常时返回 null（明确失败），绝不静默回退。
   */
  const authoritativeRouteGraph = computed(() => {
    const b = currentManualBuilding()
    if (!b) return null
    const floors = Number(getBuildingFloors(String(b.id)))
    if (!Number.isFinite(floors) || floors <= 0) return null
    try {
      return buildBuildingGraph(floors)
    } catch (_) {
      return null
    }
  })

  /** 稳定且唯一的 RP-MANUAL-… 前缀 ID */
  function genManualRouteId() {
    return `RP-MANUAL-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  }

  /** 权威图中的节点实体（不存在返回 null） */
  function authGraphNode(nodeId) {
    const g = authoritativeRouteGraph.value
    return g && g.nodes ? g.nodes[nodeId] || null : null
  }

  /** 起点约束：仅 type 为 ROOM 或 DOOR */
  function isAuthStartNode(nodeId) {
    const n = authGraphNode(nodeId)
    return !!n && (n.type === NODE_TYPE.ROOM || n.type === NODE_TYPE.DOOR)
  }

  /** 当前节点的真实邻接节点 id 列表（graph.adj[currentNodeId]；跨层仅保留下降方向） */
  function authAdjacentNodeIds(nodeId) {
    const g = authoritativeRouteGraph.value
    if (!g || !g.adj || !g.adj[nodeId] || !g.nodes) return []
    const cur = g.nodes[nodeId]
    if (!cur) return []
    return g.adj[nodeId]
      .map((e) => e.to)
      .filter((to) => {
        const n = g.nodes[to]
        if (!n) return false
        if (cur.floorId !== n.floorId) return floorNum(cur.floorId) > floorNum(n.floorId)
        return true
      })
  }

  /** 任意图上：只能沿真实邻接边步进（含跨层下降边；上升边/不存在的边均不可选） */
  function canStepInGraph(graph, fromId, toId) {
    if (!graph || !graph.adj || !graph.nodes) return false
    if (!(graph.adj[fromId] || []).some((e) => e.to === toId)) return false
    const a = graph.nodes[fromId]
    const b = graph.nodes[toId]
    if (!a || !b) return false
    // 跨层只允许沿下降方向（更高楼层 → 更低楼层）；同层无方向约束
    if (a.floorId !== b.floorId) return floorNum(a.floorId) > floorNum(b.floorId)
    return true
  }
  /** 只能沿真实邻接边步进（当前权威图；含跨层下降边；上升边/不存在的边均不可选） */
  function canAuthStep(fromId, toId) {
    return canStepInGraph(authoritativeRouteGraph.value, fromId, toId)
  }

  /** 终点约束：必须属于规范出口节点集合 EXIT_NODE_IDS */
  function isAuthExitNode(nodeId) {
    return EXIT_NODE_IDS.includes(nodeId)
  }

  /**
   * 纯函数：对任意图校验节点序列的拓扑合法性（不依赖当前 UI 选点状态）。
   * 校验项：结构 / 起点类型 / 节点存在 / 逐段真实邻接 + 下降 / 终点为规范出口。
   * 返回 { ok, reason, [node/from/to/exitId] } 或 { ok:true, ids }。
   */
  function validateManualRouteNodes(nodes, graph) {
    if (!graph || !graph.nodes) return { ok: false, reason: 'AUTH_GRAPH_UNAVAILABLE' }
    const ids = Array.isArray(nodes) ? nodes.filter((x) => typeof x === 'string' && x) : []
    if (ids.length < 2) return { ok: false, reason: 'PATH_TOO_SHORT' }
    const start = graph.nodes[ids[0]]
    if (!start || (start.type !== NODE_TYPE.ROOM && start.type !== NODE_TYPE.DOOR)) {
      return { ok: false, reason: 'INVALID_START_TYPE' }
    }
    for (let i = 1; i < ids.length; i++) {
      const a = ids[i - 1]
      const b = ids[i]
      if (!graph.nodes[b]) return { ok: false, reason: 'UNKNOWN_NODE', node: b }
      if (!canStepInGraph(graph, a, b)) return { ok: false, reason: 'NOT_ADJACENT', from: a, to: b }
    }
    const exitId = ids[ids.length - 1]
    if (!EXIT_NODE_IDS.includes(exitId)) return { ok: false, reason: 'INVALID_EXIT', exitId }
    return { ok: true, ids }
  }

  /**
   * 由权威图节点 id 序列构建手动可执行路线（校验 + 派生 points/floorsPassed）。
   * points / floorsPassed 只从当前权威图节点数据推导，绝不接受用户自由填写。
   */
  function buildManualExecutableRoute(pathIds, editId = null) {
    const g = authoritativeRouteGraph.value
    const v = validateManualRouteNodes(pathIds, g)
    if (!v.ok) return v
    const ids = v.ids
    const b = currentManualBuilding()
    const buildingId = b ? String(b.id) : ''
    const points = ids.map((id) => {
      const n = g.nodes[id]
      return { id, x: n.x, y: n.y, floorId: n.floorId }
    })
    const floorsPassed = []
    ids.forEach((id) => {
      const fid = g.nodes[id].floorId
      if (floorsPassed[floorsPassed.length - 1] !== fid) floorsPassed.push(fid)
    })
    const now = Date.now()
    return {
      ok: true,
      route: {
        id: editId || genManualRouteId(),
        type: 'manual-executable',
        buildingId,
        startNode: ids[0],
        exitId: ids[ids.length - 1],
        nodes: ids.slice(),
        points,
        floorsPassed,
        createdAt: now,
        updatedAt: now,
      },
    }
  }

  /**
   * 恢复数据清洗：**结构损坏**与**拓扑失效**严格分开。
   *   · 结构损坏（非对象 / id 缺失 / nodes 类型错 / exitId 类型错）→ 剔除并记录可诊断结果；
   *   · 结构完整但可能因拓扑变化不再合法 → **保留**（不可执行的历史/待编辑路线），
   *     绝不因校验失败静默删除（后续由 K-1B.3 / K-1B.4 决定展示与重验证）。
   */
  function sanitizeManualExecutableRoutes(value) {
    const src = Array.isArray(value) ? value : []
    const clean = []
    const dropped = []
    src.forEach((r, i) => {
      if (!r || typeof r !== 'object' || Array.isArray(r)) {
        dropped.push({ index: i, reason: 'NOT_OBJECT' })
        return
      }
      if (typeof r.id !== 'string' || !r.id) {
        dropped.push({ index: i, reason: 'MISSING_ID' })
        return
      }
      if (!Array.isArray(r.nodes) || r.nodes.some((n) => typeof n !== 'string')) {
        dropped.push({ index: i, id: r.id, reason: 'INVALID_NODES' })
        return
      }
      if (typeof r.exitId !== 'string' || !r.exitId) {
        dropped.push({ index: i, id: r.id, reason: 'INVALID_EXIT_ID' })
        return
      }
      clean.push(r)
    })
    return { clean, dropped }
  }

  // ── RW-2：持久化恢复时的路线投影数据清洗（routePlans / routeMatrix） ──
  // 模式对齐 sanitizeManualExecutableRoutes：区分「结构损坏（剔除）」与「状态未知
  // （保留几何、status 归一为 null）」。归一目标**是 null 而不是 NORMAL** —— 未知状态
  // 路线保留可展示几何，但执行门禁（USABLE_ROUTE_STATUSES 白名单）继续拒绝，fail-closed。
  // ⚠️ 不触碰 DONE 及其 completedAt / assignedTo / history（合法状态原样保留）；
  // ⚠️ 不改 exitRawStates（D1-A 语义不变）、不改任何门禁判据、不做历史格式迁移猜测；
  // ⚠️ 局部容错：单条坏路线不波及有效路线与无关业务状态（fireEvent / persons / 阶段等）。
  const routeProjectionRestoreReport = ref(null)

  function sanitizeRouteEntry(entry) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return { ok: false, reason: 'NOT_OBJECT' }
    }
    if (typeof entry.id !== 'string' || !entry.id) {
      return { ok: false, reason: 'MISSING_ID' }
    }
    // path 是 2D/3D 展示与 getRouteSegmentForFloor 的必需字段：缺失即结构损坏（剔除）
    if (!Array.isArray(entry.path)) {
      return { ok: false, reason: 'MISSING_PATH' }
    }
    if (typeof entry.status === 'string' && Object.values(PLAN_STATUS).includes(entry.status)) {
      return { ok: true, entry } // 合法状态原样保留（含 BLOCKED / DONE 及历史字段）
    }
    // 缺失 / 非字符串 / 未知枚举值 ⇒ 归一为 null（状态未知），**绝不归一为 NORMAL**
    return { ok: true, entry: { ...entry, status: null } }
  }

  /**
   * 恢复后的路线投影清洗（仅在 restorePersistSnapshot 赋值之后调用一次）：
   *   · routePlans：结构损坏剔除并记录 {index,id,reason}；未知 status 归一 null；
   *   · routeMatrix：缺 perZone / areas 时有界兜底；perZone.plans 同样清洗；
   *     recommendedId / backupId 悬空（既不在 routePlans、也不在该区 candidates 中）⇒ null；
   *   · activeRoutePlanId 悬空 ⇒ null；
   *   · 有效路线与无关业务状态原样保留（局部容错，不整体丢弃快照）。
   * @returns {{plans:Array, matrix:object|null, dropped:Array}}
   */
  function sanitizeRouteProjection() {
    const dropped = []
    const plans = []
    asArray(routePlans.value).forEach((p, i) => {
      const r = sanitizeRouteEntry(p)
      if (r.ok) {
        plans.push(r.entry)
      } else {
        dropped.push({ index: i, id: p && typeof p.id === 'string' ? p.id : null, reason: r.reason })
      }
    })
    routePlans.value = plans
    const planIds = new Set(plans.map((p) => p.id))

    let matrix = routeMatrix.value
    if (matrix && typeof matrix === 'object' && !Array.isArray(matrix)) {
      const perZoneIn = (matrix.perZone && typeof matrix.perZone === 'object' && !Array.isArray(matrix.perZone))
        ? matrix.perZone
        : {}
      const perZone = {}
      Object.keys(perZoneIn).forEach((zone) => {
        const info = perZoneIn[zone]
        if (!info || typeof info !== 'object' || Array.isArray(info)) return
        const zonePlans = []
        asArray(info.plans).forEach((p, i) => {
          const r = sanitizeRouteEntry(p)
          if (r.ok) zonePlans.push(r.entry)
          else dropped.push({ zone, index: i, id: p && typeof p.id === 'string' ? p.id : null, reason: r.reason })
        })
        const zoneIds = new Set(zonePlans.map((p) => p.id))
        // 指针合法 = 指向 routePlans 中的路线，或该区 candidates 中的路线
        // （整栋楼模式下 perZone.plans 含非当前方案的候选，属合法形态，不得误清）
        const validPtr = (v) => {
          if (v === null || v === undefined) return null
          return planIds.has(v) || zoneIds.has(v) ? v : null
        }
        perZone[zone] = {
          ...info,
          plans: zonePlans,
          recommendedId: validPtr(info.recommendedId),
          backupId: validPtr(info.backupId),
        }
      })
      const areas = Array.isArray(matrix.areas) && matrix.areas.length ? matrix.areas : Object.keys(perZone)
      matrix = { ...matrix, areas, perZone }
    } else {
      matrix = null
    }
    routeMatrix.value = matrix

    const active = activeRoutePlanId.value
    if (active !== null && active !== undefined && !planIds.has(active)) {
      activeRoutePlanId.value = null
      dropped.push({ id: active, reason: 'ACTIVE_POINTER_DANGLING' })
    }
    return { plans, matrix, dropped }
  }

  // ── 权威图选点交互（继续 / 撤销 / 取消 / 重新选点 / 更换终点） ──
  function resetAuthGraphSelection(draftId = null) {
    authGraphPath.value = []
    authGraphDraftId.value = draftId || null
    authGraphError.value = null
  }
  function pickAuthGraphStart(nodeId) {
    if (!authoritativeRouteGraph.value) {
      authGraphError.value = 'AUTH_GRAPH_UNAVAILABLE'
      return false
    }
    if (!isAuthStartNode(nodeId)) {
      authGraphError.value = 'INVALID_START_TYPE'
      return false
    }
    authGraphPath.value = [nodeId]
    authGraphError.value = null
    return true
  }
  /** 追加下一节点：只能来自当前节点真实邻接列表（含合法下降边） */
  function appendAuthGraphNode(nodeId) {
    if (!authoritativeRouteGraph.value) {
      authGraphError.value = 'AUTH_GRAPH_UNAVAILABLE'
      return false
    }
    const path = authGraphPath.value
    if (!path.length) return pickAuthGraphStart(nodeId)
    const last = path[path.length - 1]
    if (!canAuthStep(last, nodeId)) {
      authGraphError.value = 'NOT_ADJACENT'
      return false
    }
    authGraphPath.value = [...path, nodeId]
    authGraphError.value = null
    return true
  }
  /** 撤销上一步（至少保留起点） */
  function undoAuthGraphStep() {
    if (authGraphPath.value.length <= 1) return false
    authGraphPath.value = authGraphPath.value.slice(0, -1)
    authGraphError.value = null
    return true
  }
  /** 取消当前编辑 */
  function cancelAuthGraphSelection() {
    resetAuthGraphSelection(null)
  }
  /** 载入既有路线到编辑态（替换模式） */
  function loadAuthGraphRouteForEdit(routeId) {
    const r = manualExecutableRoutes.value.find((x) => x && x.id === routeId)
    if (!r) return false
    authGraphDraftId.value = r.id
    authGraphPath.value = Array.isArray(r.nodes) ? r.nodes.slice() : []
    authGraphError.value = null
    return true
  }
  /** 保存：新建（防重复 ID）或按 ID 替换 */
  function saveAuthGraphRoute() {
    const built = buildManualExecutableRoute(authGraphPath.value, authGraphDraftId.value)
    if (!built.ok) {
      authGraphError.value = built.reason
      return { ok: false, reason: built.reason }
    }
    if (authGraphDraftId.value) {
      const replaced = replaceManualExecutableRoute(authGraphDraftId.value, built.route)
      if (!replaced) return { ok: false, reason: 'REPLACE_NOT_FOUND' }
    } else {
      const created = createManualExecutableRoute(built.route)
      if (!created.ok) return created
    }
    resetAuthGraphSelection(null)
    return { ok: true, route: built.route }
  }

  /**
   * 创建：新增时防止重复 ID，并**强制基于当前权威图重新校验 + 重新派生**路线字段。
   * 只信任受控输入（route.nodes 节点序列 + 可选 route.id）；调用方传入的
   * points / floorsPassed / exitId / buildingId / validated / reachable / status 等
   * 派生字段或运行时结论一律忽略，由 buildManualExecutableRoute 重新生成。
   */
  function createManualExecutableRoute(route) {
    if (!route || typeof route !== 'object') return { ok: false, reason: 'INVALID_ROUTE' }
    const requestedId = typeof route.id === 'string' && route.id ? route.id : null
    // 校验对象 = 待写入路线的 nodes（而非当前 UI 选点状态），并重新派生全部可信字段
    const built = buildManualExecutableRoute(route.nodes, requestedId)
    if (!built.ok) return built
    const routeId = built.route.id
    const exists = manualExecutableRoutes.value.some((x) => x && x.id === routeId)
    if (exists) return { ok: false, reason: 'DUPLICATE_ID', id: routeId }
    manualExecutableRoutes.value.push(built.route)
    return { ok: true, route: built.route }
  }
  /** 替换：按 ID 替换；同样基于权威图重新校验 + 重新派生，保留原 id / buildingId / createdAt。 */
  function replaceManualExecutableRoute(routeId, route) {
    const idx = manualExecutableRoutes.value.findIndex((x) => x && x.id === routeId)
    if (idx < 0) return false
    const prev = manualExecutableRoutes.value[idx]
    const built = buildManualExecutableRoute(route && route.nodes, routeId)
    if (!built.ok) return false
    manualExecutableRoutes.value[idx] = {
      ...built.route,
      buildingId: prev && prev.buildingId ? prev.buildingId : built.route.buildingId,
      createdAt: prev && prev.createdAt != null ? prev.createdAt : built.route.createdAt,
      updatedAt: Date.now(),
    }
    return true
  }
  /** 删除：显式按 ID 移除 */
  function deleteManualExecutableRoute(routeId) {
    const before = manualExecutableRoutes.value.length
    manualExecutableRoutes.value = manualExecutableRoutes.value.filter((x) => !x || x.id !== routeId)
    return manualExecutableRoutes.value.length < before
  }

  // ════════════════════════════════════════════════════════════════════
  // K-1B.3：安全准入（拓扑）+ 只读状态投影
  //  · 拓扑有效性独立于出口运行时可用性，二者不合并为单一布尔；
  //  · 投影是 computed 只读派生，不回写路线对象、不持久化、不删除路线；
  //  · 执行状态 / 设备下发不属于本阶段结论，投影不表达「可执行」。
  // ════════════════════════════════════════════════════════════════════

  /** 按指定楼栋建图（非当前 UI 楼栋）；楼栋缺失/层数非法/建图失败给出明确原因 */
  function graphForBuilding(buildingId) {
    const bid = String(buildingId || '')
    if (!bid) return { ok: false, graph: null, reason: 'BUILDING_MISSING' }
    const b = asArray(buildings.value).find((x) => x && String(x.id) === bid)
    if (!b) return { ok: false, graph: null, reason: 'BUILDING_NOT_FOUND' }
    const floors = Number(getBuildingFloors(bid))
    if (!Number.isFinite(floors) || floors <= 0) return { ok: false, graph: null, reason: 'BUILDING_FLOORS_INVALID' }
    try {
      return { ok: true, graph: buildBuildingGraph(floors), reason: null }
    } catch (_) {
      return { ok: false, graph: null, reason: 'BUILDING_GRAPH_FAILED' }
    }
  }

  /**
   * 拓扑安全准入：对已保存路线用**其所属楼栋**的权威图重新验证（非当前 UI 楼栋）。
   * 返回 { status: 'VALID' | 'INVALID' | 'BUILDING_UNAVAILABLE', reason }。
   * 不得因出口运行时数据缺失而判 INVALID（出口可用性是独立维度）。
   */
  function validateManualRouteTopology(route) {
    if (!route || typeof route !== 'object') return { status: 'INVALID', reason: 'INVALID_ROUTE_OBJECT' }
    const res = graphForBuilding(route.buildingId)
    if (!res.ok) return { status: 'BUILDING_UNAVAILABLE', reason: res.reason }
    const v = validateManualRouteNodes(route.nodes, res.graph)
    if (!v.ok) return { status: 'INVALID', reason: v.reason }
    if (String(route.exitId) !== v.ids[v.ids.length - 1]) {
      return { status: 'INVALID', reason: 'EXIT_ID_MISMATCH' }
    }
    return { status: 'VALID', reason: null }
  }

  /**
   * 出口运行时可用性（独立于拓扑）：基于真实上报可用集。
   *  · exitRawStates === null（从未收到上报）⇒ UNKNOWN（无法得出可用性结论）；
   *  · 否则按 exitReportedUsableNodeIds 判 AVAILABLE / UNAVAILABLE。
   */
  function manualRouteExitVerdict(route) {
    const exitId = route && typeof route.exitId === 'string' ? route.exitId : ''
    if (!exitId) return { status: 'UNKNOWN', reason: 'NO_EXIT_ID' }
    if (exitRawStates.value === null || exitRawStates.value === undefined) {
      return { status: 'UNKNOWN', reason: 'NO_EXIT_RUNTIME' }
    }
    const reported = exitReportedUsableNodeIds.value
    if (!Array.isArray(reported)) return { status: 'UNKNOWN', reason: 'NO_EXIT_RUNTIME' }
    return reported.some((id) => String(id) === exitId)
      ? { status: 'AVAILABLE', reason: null }
      : { status: 'UNAVAILABLE', reason: 'EXIT_NOT_REPORTED_USABLE' }
  }

  /**
   * 只读状态投影：为每条手动路线派生「拓扑准入」与「出口可用性」两个独立维度。
   * 不写回 manualExecutableRoutes / 路线对象，不持久化。
   */
  const manualRouteStatusView = computed(() => {
    return manualExecutableRoutes.value
      .filter((r) => r && typeof r === 'object')
      .map((route) => {
        const topo = validateManualRouteTopology(route)
        const exit = manualRouteExitVerdict(route)
        return {
          id: route.id,
          topologyStatus: topo.status,
          topologyReason: topo.reason,
          exitStatus: exit.status,
          exitReason: exit.reason,
        }
      })
  })

  // ── F2：楼栋上下文变化时，统一重置权威图选点编辑态 ──
  // routeBuildingId 是「当前路线规划楼栋」的唯一权威；所有切换路径（RoutePlanView 下拉、
  // generateRoutePlans、activateBuildingPlansFor 等）最终都改写 routeBuildingId，
  // 因此在此统一 watch 即可覆盖全部入口，避免各入口各自实现不一致的清理逻辑。
  // flush:'sync'：切换楼栋后立即清空旧选点态，杜绝「旧路径 + 新楼栋 buildingId」的窗口。
  // 仅在实际变化时重置（同值重赋值不重置）；初始化/恢复快照时的赋值不会误清（编辑态本为空）。
  watch(routeBuildingId, (next, prev) => {
    if (next === prev) return
    resetAuthGraphSelection(null)
  }, { flush: 'sync' })

  // 批量切换疏散方向
  // filters: { building, floors: [], areas: [], deviceTypes: [] }
  function batchSwitchEvacuationDirection(filters, newDirection, reason = '管理员批量切换') {
    // B1-02：demo 模式下设备方向只能来自 DemoWorld.devices → WS → store
    if (demoGuard('batchSwitchEvacuationDirection')) return { count: 0, ids: [], oldDirections: [] }
    addOperationLog('批量调整疏散灯方向', '设备控制', reason + ' ' + newDirection)
    // P1.7.3-B3：canonical 筛选（buildingId / floorId / zone）；别名只在 canonical 缺失时兜底
    const wantBid = filters.buildingId || buildingIdFromName(filters.building)
    const wantFloors = (filters.floors || []).map((f) => floorIdOf({ floorId: f }))
    const wantZones = filters.areas || []
    const devs = asArray(devices.value).filter((d) => {
      if (!d || d.type !== 'evacuation_light') return false
      if (wantBid && buildingIdOf(d) !== wantBid) return false
      if (!wantBid && filters.building && buildingNameOf(d) !== filters.building) return false
      if (wantFloors.length > 0 && !wantFloors.includes(floorIdOf(d))) return false
      if (wantZones.length > 0 && !wantZones.includes(zoneOf(d))) return false
      return true
    })

    const oldDirections = devs.map((d) => d.direction)
    const updatedIds = []
    devs.forEach((d) => {
      d.direction = newDirection
      d.recommendedDirection = newDirection
      // 问题 C：批量手动覆盖同样作废上一轮的路线裁决结论
      markDirectionOverridden(d.id, newDirection, 'manual')
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
    // B1-02：demo 模式下 emergencyMode / 设备应急态来自 DemoWorld.lighting → WS → store
    if (demoGuard('setEmergencyMode')) return
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
    // B1-02：demo 模式下疏散灯方向只来自 DemoWorld.devices → WS → store
    if (demoGuard('resetEvacLightDirections')) return
    // P1.8.2 第一阶段：方向复位到位置默认值 ⇒ 本轮路线裁决结论一律作废，
    // 否则上一轮的 resolved / conflict / undetermined 会残留并被误认为仍然有效。
    routeDirectionVerdicts.value = []
    routeNoPathRouteIds.value = []
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
  // P1.7.3-B3：查不到时必须返回 '' —— 禁止回退「当前楼栋」，否则未知楼栋会被静默归到当前楼栋（跨楼栋串用）
  function fireBuildingId(name) {
    const b = asArray(buildings.value).find((x) => x && x.name === name)
    return b ? String(b.id) : ''
  }

  /**
   * P1.7.3-B3：火灾三元组（canonical 唯一权威）。
   * 顺序：fire.buildingId / floorId / zone → 缺失时才用别名反查；别名与 canonical 冲突时以 canonical 为准。
   */
  function fireLocation(fe) {
    const f = fe || {}
    return {
      buildingId: buildingIdOf(f) || fireBuildingId(f.building) || '',
      floorId: floorIdOf(f),
      zone: zoneOf(f),
    }
  }

  // ── 阶段 1：检测发现火情（仅产生发现产物；灯/人员联动等待管理员确认） ──
  function detectFireScenario(building = '3号楼', floor = '5F', area = 'A区') {
    // B1-01：demo 模式下火情由后端状态机 START_FIRE 产生，禁止本地构造 fireEvent / 推进 emergencyStage
    if (demoGuard('detectFireScenario')) return false
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
    // P1.7.3-B3：按 canonical 三元组匹配（buildingId / floorId / zone），别名不再参与判定
    const fireBid = buildingIdOf({ buildingId: buildingIdFromName(building), building })
    const fireFid = floorIdOf({ floorId: floor })
    const fireZone = zoneOf({ zone: area })
    asArray(devices.value).forEach((d) => {
      if (d && buildingIdOf(d) === fireBid && floorIdOf(d) === fireFid && zoneOf(d) === fireZone && ['smoke_detector', 'temperature_sensor'].includes(d.type)) {
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
    // P1.7.3-B3：canonical 三元组（权威）；building/floor/area 只保留给文案使用
    const loc = fireLocation(fe)
    const building = fe.building // 仅用于日志/告警文案
    const floor = fe.floor       // 仅用于日志/告警文案
    const area = fe.area         // 仅用于日志/告警文案
    // ① 火源房门对应走廊 x：距门 ≤110px 的灯进入 emergency；指向火源门的疏散灯自动反向
    const fireDoorX = PLAN_DOORS.find((dd) => dd.zone === loc.zone)?.x ?? 140
    asArray(devices.value).forEach((d) => {
      if (!d || buildingIdOf(d) !== loc.buildingId || floorIdOf(d) !== loc.floorId) return
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
          // 问题 C：避火自动反向也不是路线裁决，裁决状态同步作废
          markDirectionOverridden(d.id, nd, 'fire-avoidance')
        }
      }
    })
    // ② 风险人员标记（同区）
    asArray(persons.value)
      .filter((p) => p && buildingIdOf(p) === loc.buildingId && floorIdOf(p) === loc.floorId && zoneOf(p) === loc.zone)
      .forEach((p) => { p.status = 'warning' })
    // ③ 风险区域（canonical 三元组 + 只读别名：下游判定一律用 canonical）
    riskAreas.value.push({
      id: `RA-${String(riskAreas.value.length + 1).padStart(3, '0')}`
      , buildingId: loc.buildingId
      , floorId: loc.floorId
      , zone: loc.zone
      , building
      , floor
      , area
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
    // ⑤ 照明状态聚合（canonical 判定）
    const affectedLight = devices.value.find((d) => d && buildingIdOf(d) === loc.buildingId && floorIdOf(d) === loc.floorId && d.type === 'emergency_light')
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
    // B1-01：demo 模式下阶段与方案均由后端下发，本地不得自算并写 emergencyStage
    if (demoGuard('generateEvacuationOptions')) return []
    const fe = fireEvent.value
    if (!fe) return []
    addOperationLog('生成疏散路线', '疏散规划', '整栋楼各楼层/区域生成整体疏散方案')
    // P1.7.3-B3：canonical 三元组（fire.buildingId / floorId / zone）
    const floc = fireLocation(fe)
    // ① 整栋楼方案（scope=BUILDING）：A/B/C = 均衡 / 快速 / 安全三种整栋楼策略（唯一权威）
    const built = generateBuildingEvacuationPlans({ buildingId: floc.buildingId })
    if (!built.plans.length) {
      // 整栋楼规划失败时回退旧的单楼层矩阵（仅用于页面展示，不是权威方案）
      generateRoutePlans({ buildingId: floc.buildingId, floorId: floc.floorId })
      applyFireBlocking(fe)
      replanRoutesForFire()
    }
    const bp = activeBuildingPlan.value
    // ② 疏散灯：整栋楼所有路线**一次性**裁决后联动（禁止逐条覆盖）
    if (bp) applyBuildingRoutesToDevices(bp)
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
    // B1-03：demo 模式下方案选择只走 demoStore.selectedPlanId（见 setActiveBuildingPlan）
    if (demoGuard('selectEvacuationPlan')) return false
    const plan = getRoutePlanById(planId)
    if (!plan) return false
    // FIX-4（Stage 2-A 遗留项）：路线级门禁**先于分支判定**，整栋楼分支与 legacy 分支
    // 适用同一口径 —— BLOCKED / DONE / 未知（含投影未命中的 null）一律拒绝选中，
    // 不得对不可用路线无条件返回 true（修复前整栋楼分支无任何状态检查：
    // 属当前方案 ⇒ no-op true；属其它方案 ⇒ 直接切换）。
    // ⚠️ 门禁只约束**被选中的路线本身**：方案内其它分区路线不可用时不拒绝整个方案，
    //    部分分区不可用下正常分区的可执行性由 FIX-1/FIX-2/FIX-3 在执行层逐条收敛。
    // ⚠️ 只读判定，不改写 status / completedAt / assignedTo / history 等历史字段。
    if (!USABLE_ROUTE_STATUSES.includes(plan.status)) {
      console.warn('[fireStore] 拒绝选中不可执行路线：', { id: planId, status: plan.status })
      return false
    }
    if (plan.buildingPlanId && buildingEvacuationPlans.value.some((p) => p.id === plan.buildingPlanId)) {
      if (activeBuildingPlanId.value !== plan.buildingPlanId) return setActiveBuildingPlan(plan.buildingPlanId)
      return true
    }
    // ⚠️ LEGACY：非整栋楼方案（旧单区域结构）仅本地预览，不改变权威方案
    // （状态门禁已由上方统一执行；原 legacy 分支内的 BLOCKED/DONE 双查被白名单判据覆盖）
    activeRoutePlanId.value = planId
    applyRouteToDevices(plan)
    return true
  }
  // 返回方案列表：重新回到当前整栋楼方案
  function backToPlanList() {
    // P1.7.3-B3-05（P0-01）：demo 模式下不得把 fireStore 的投影值反向写回意向槽
    // （否则 activeBuildingPlanId 会重新变成第二个「Demo 意向源」）。
    if (demoGuard('backToPlanList')) return Boolean(activeBuildingPlanId.value)
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
    // 疏散灯沿整栋楼每条路线的实际走向逐台联动 + 途经楼层应急照明进入应急强闪
    applyBuildingRoutesToDevices(bp)
    addOperationLog(
      '调整疏散指示方向',
      '演示流程',
      `疏散指示灯方向已按整栋楼方案「${bp.name}」各区域实际路线逐段指向出口 ${bp.summary.exitLabels.join('、') || '安全出口'}`,
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
    // P1.7.3-B3：canonical 唯一权威，别名（p.building）不再作为第二套身份来源
    const feBuildingId = buildingIdOf(fe) || fireBuildingId(fe.building)
    let total = 0
    const skipped = [] // FIX-1：被门禁拒绝的路线 id（用于诊断告警）
    asArray(persons.value).forEach((p) => {
      if (!p || buildingIdOf(p) !== feBuildingId) return
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
      // FIX-1（Stage 2-A 遗留项）：执行入口必须消费**权威协调状态**
      // （reconcileRouteStatuses 产出，见 reconciledRouteView 契约）。修复前此处用
      // routeToRenderable 的种子 'NORMAL'，会把 BLOCKED / DONE 静默抹掉；投影未命中
      // / 跨方案时 reconciledRouteView 返回 status === null（未知）。
      const plan = route ? reconciledRouteView(bp, route) : null
      const ownFloor = p.floorId
      // FIX-1：**先校验、后写入**。BLOCKED / DONE / null / 未知状态一律 fail-closed；
      // 被拒人员显式清理陈旧 routeId 指派，不保留上一轮路线引用，也不写 _evac / status。
      // （上方 delete p._evacDone / p._evac 是「重跑即复位」语义，属清理而非新的执行态写入）
      if (!plan || !USABLE_ROUTE_STATUSES.includes(plan.status)) {
        if (route) skipped.push(route.routeId)
        p.routeId = null
        return
      }
      // routeId = `${planId}:${floorId}:${zone}` —— 2D / 3D / 后端同一个 id
      p.routeId = route.routeId
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
    if (skipped.length) {
      console.warn('[fireStore] 启动疏散时跳过不可执行路线（BLOCKED/DONE/未知）：', [...new Set(skipped)])
    }
    // ── 以下仅 mock / 离线模式：P2 确定性滞留，与后端共用同一份固定候选名单 RETAINED_CANDIDATES ──
    // 只允许 evacuating → stranded —— 严禁把已撤离或未参与疏散的人重新标记为滞留，
    // 也不再按「火源区第一个 / C区第一个」这种顺序取人（否则同一份场景每次跑出来的人不一样）
    const strandedPicks = pickRetainedCandidates(
      asArray(persons.value).filter((p) => p && buildingIdOf(p) === feBuildingId),
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
    // B1-01：demo 模式下疏散进度由后端 tick 驱动，本地不得结算并写 emergencyStage
    if (demoGuard('finishEvacuation')) return
    const fe = fireEvent.value
    if (!fe) return
    stopEvacuationSim()
    const feBuildingId = buildingIdOf(fe) || fireBuildingId(fe.building)
    // P2 确定性滞留：滞留名单来自整栋楼固定候选（可能是火警楼层之外的楼层），
    // 因此这里按「火警楼栋」而不是「火警楼层」取，保证 2D 名单与 3D / 后端同一批人
    const floorPersons = asArray(persons.value)
      .filter((p) => p && buildingIdOf(p) === feBuildingId)
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
    // B1-01：demo 模式下复位由 RESET 命令 → 后端 snapshot 完成，禁止本地清零 emergencyStage / 人员坐标
    if (demoGuard('resetEmergencyFlow')) return false
    // clearRouteFire 内部依次：clearFireScenario → 清封堵/方案复位/解除应急模式 → 停疏散动画 → 人员坐标恢复 → 流程归零
    clearRouteFire()
    asArray(persons.value).forEach((p) => { delete p._stranded; if (p.status === 'stranded' || p.status === 'located') p.status = 'normal' })
    return true
  }

  // ── 外部页面直接触发火灾（triggerFireScenario/simulateFireAlarm）后回到首页：同步为「疏散方案决策」阶段 ──
  function syncStageAfterExternalFire() {
    // B1-01：demo 模式下不存在「外部页面本地触发火灾」，火情只来自后端 START_FIRE
    if (demoGuard('syncStageAfterExternalFire')) return false
    const fe = fireEvent.value
    if (!fe) return false
    // 等待态（0/1/2/3）→ 完整联动已发生 → 直接进入方案决策；执行中不打断
    if (emergencyStage.value === 4 || emergencyStage.value === 5) return true
    generateEvacuationOptions()
    return true
  }
  // 按楼栋+楼层+类型筛选设备
  // P1.6.2：统一字段（buildingId / floorId / zone）优先
  // P1.7.3-B3：canonical 唯一权威 —— 中文名 / 旧 area 过滤器只在 canonical 缺失时兜底，
  //   且 canonical 与别名冲突时以 canonical 为准（禁止别名成为第二套筛选口径）
  function getDevicesFiltered(filters = {}) {
    const wantBid = filters.buildingId || buildingIdFromName(filters.building)
    const wantFid = floorIdOf({ floorId: filters.floorId || filters.floor })
    const wantFloors = (filters.floors || []).map((f) => floorIdOf({ floorId: f }))
    const wantZone = zoneOf({ zone: filters.zone || filters.area })
    return asArray(devices.value).filter((d) => {
      if (!d) return false
      if (wantBid && buildingIdOf(d) !== wantBid) return false
      if (!wantBid && filters.building && buildingNameOf(d) !== filters.building) return false
      if (wantFid && floorIdOf(d) !== wantFid) return false
      if (wantFloors.length > 0 && !wantFloors.includes(floorIdOf(d))) return false
      if (wantZone && zoneOf(d) !== wantZone) return false
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
      // P1.7.3-B3：楼栋归属按 canonical buildingId（b.id），别名中文名不再参与统计
      const bldDevs = devs.filter((d) => d && buildingIdOf(d) === String(b.id))
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
    // P1.7.3-B3：按 canonical buildingId 统计（展示 key 仍是中文楼栋名）
    ps.buildingDistribution = {
      '1号楼': pers.filter((p) => p && buildingIdOf(p) === 'B001').length,
      '2号楼': pers.filter((p) => p && buildingIdOf(p) === 'B002').length,
      '3号楼': pers.filter((p) => p && buildingIdOf(p) === 'B003').length,
      '4号楼': pers.filter((p) => p && buildingIdOf(p) === 'B004').length,
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
    // P1.7.3-B3：canonical 三元组匹配（buildingId / floorId / zone）
    const tloc = fireLocation(fireEvent.value)
    const smokeAndTempDevs = asArray(devices.value).filter(
      (d) => d && buildingIdOf(d) === tloc.buildingId && floorIdOf(d) === tloc.floorId && zoneOf(d) === tloc.zone && ['smoke_detector', 'temperature_sensor'].includes(d.type)
    )
    smokeAndTempDevs.forEach((d) => {
      d.status = 'warning'
      if (d.type === 'temperature_sensor') d.temperature = 45 + Math.floor(Math.random() * 15)
    })

    // 2+3. 火源房门对应的走廊 x，按几何距离联动灯光：
    //   - 距房门 ≤110px 的应急照明/疏散灯进入 emergency（灯光全亮）；
    //   - 疏散灯若当前指向火源房门（朝危险区）则自动反向，其余保持指向安全方向
    const fireDoorX = PLAN_DOORS.find((dd) => dd.zone === tloc.zone)?.x ?? 140
    asArray(devices.value).forEach((d) => {
      if (!d || buildingIdOf(d) !== tloc.buildingId || floorIdOf(d) !== tloc.floorId) return
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
          // 问题 C：避火自动反向也不是路线裁决，裁决状态同步作废
          markDirectionOverridden(d.id, nd, 'fire-avoidance')
        }
      }
    })

    // 4. 人员风险标记
    asArray(persons.value)
      .filter((p) => p && buildingIdOf(p) === tloc.buildingId && floorIdOf(p) === tloc.floorId && zoneOf(p) === tloc.zone)
      .forEach((p) => { p.status = 'warning' })

    // 5. 风险区域（canonical 三元组 + 只读别名）
    riskAreas.value.push({
      id: `RA-${String(riskAreas.value.length + 1).padStart(3, '0')}`,
      buildingId: tloc.buildingId,
      floorId: tloc.floorId,
      zone: tloc.zone,
      building,
      floor,
      area,
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

    // 9. 照明状态聚合（canonical 判定）
    const affectedLight = devices.value.find((d) => d && buildingIdOf(d) === tloc.buildingId && floorIdOf(d) === tloc.floorId && d.type === 'emergency_light')
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
    // P1.7.3-B3：canonical 归属匹配（buildingId / floorId）
    const targetBid = buildingIdOf(targetBuilding) || buildingIdFromName(targetBuilding && targetBuilding.name)
    const targetFid = floorIdOf({ floorId: targetFloor })
    const targetDevice = opts.device || devices.value.find(
      (d) => d && buildingIdOf(d) === targetBid && floorIdOf(d) === targetFid
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
    // B1-02：demo 模式下设备状态只来自 DemoWorld.devices → WS → store
    if (demoGuard('updateDeviceStatus')) return
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

  /**
   * AUTH-8：demoMode 仅为「演示控制台面板」的显隐开关。
   * 与用户身份、角色、授权**完全无关**——不得据此判断管理员权限，
   * 也不得在任何 UI 中把它显示成"管理员"。真实身份见 authStore。
   */
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
    // 重置照明（P1.7.3-B4-02：灯具集合不再单独重置 —— 上面 devices 已重建，
    // lightingDevices 是它的派生投影会随之收敛；这里只重置聚合态与历史）
    lightingStatus.value = { ...initialLightingStatus, currentMode: lightingModes.daily }
    lightingStatus.value.currentDevice = lightingDevices.value[0] || null
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

    const newBuilding = buildingsList[Math.floor(Math.random() * buildingsList.length)]
    const newFloor = floorsList[Math.floor(Math.random() * floorsList.length)]
    const newPerson = {
      id: `P${String(persons.value.length + 1).padStart(3, '0')}`,
      name: names[Math.floor(Math.random() * names.length)],
      department: departments[Math.floor(Math.random() * departments.length)],
      // P1.7.3-B3-03：canonical 三元组必须自带（buildingId / floorId / zone），
      // building / floor 降级为派生展示别名（与 Airlock PersonRuntime 同一套字段）
      buildingId: buildingIdFromName(newBuilding),
      floorId: floorIdOf({ floorId: newFloor }),
      zone: zone,
      building: newBuilding,
      floor: newFloor,
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

    // P1.7.3-B3-03：riskArea 同样必须自带 canonical 三元组
    // （与 :riskAreas.push 的另两处口径一致，下游判定不再需要 alias 兜底分支）
    const riskArea = {
      id: `RA-${String(riskAreas.value.length + 1).padStart(3, '0')}`,
      buildingId: buildingIdFromName(targetBuilding),
      floorId: floorIdOf({ floorId: targetFloor }),
      zone: targetZone,
      building: targetBuilding,
      floor: targetFloor,
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
    // B1-04：demo 模式下灯光模式只来自 DemoWorld.lighting → WS → store
    if (demoGuard('switchLightingMode')) return lightingStatus.value
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
    // B1-04：demo 模式下设备人员感应 / 亮度联动由 DemoEngine 驱动
    if (demoGuard('simulatePersonEnter')) return null
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
    // 问题 C：本地手动覆盖后，上一轮的 resolved 不得继续被当作「路线已裁决」的依据
    markDirectionOverridden(deviceId, newDirection, 'manual')

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
    // B1-01：demo 模式的「发现火灾」必须经后端 START_FIRE（由 platformStore 派发）
    if (demoGuard('startDemoFlow')) return false
    resetEmergencyFlow()
    demoMode.value = true
    return detectFireScenario('3号楼', '5F', 'A区') // ① 发现火灾
  }

  // 推进一步：根据当前阶段执行对应的真实状态变更（供演示面板「下一步」调用）
  // 六阶段：0=正常 / 1=发现火灾 / 2=启动应急响应 / 3=疏散路径 / 4=智能疏散 / 5=滞留人员识别 / 6=协同救援
  function advanceDemoStage() {
    // B1-01：demo 模式的阶段推进由后端状态机负责，本地不得按 emergencyStage 自行迁移
    if (demoGuard('advanceDemoStage')) return false
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
    // B1-02：demo 模式下疏散灯方向联动由 DemoEngine 下发
    if (demoGuard('adjustEvacuationDirection')) return false
    const plan = getRoutePlanById(activeRoutePlanId.value)
    // FIX-3（Stage 2-A 遗留项）：方向修改前核验权威协调状态；BLOCKED / DONE /
    // 未知（投影未命中/非白名单）一律拒绝，不得把路线几何派发给设备。
    if (!plan || !USABLE_ROUTE_STATUSES.includes(plan.status)) {
      console.warn('[fireStore] 拒绝调整疏散灯方向：当前路线不可执行',
        { id: activeRoutePlanId.value, status: plan ? plan.status : '<absent>' })
      return false
    }
    applyRouteToDevices(plan)
    addOperationLog('调整指示方向', '演示流程', '应急疏散指示灯方向已按疏散方案统一调整', 'warning')
    return true
  }

  // 阶段4：启动疏散指示灯脉冲强闪（应急强闪）+ 开始人员疏散动态模拟
  function startPulseFlash() {
    // B1-02：demo 模式下应急灯强闪来自 DemoWorld.lighting / devices，不由前端启动
    if (demoGuard('startPulseFlash')) return false
    const plan = getRoutePlanById(activeRoutePlanId.value)
    // FIX-3：门禁必须位于一切副作用**之前** —— setEmergencyMode 会写设备应急态 /
    // 通知 / 操作日志，startEvacuationRun 会写人员执行态并启动疏散定时器。
    // BLOCKED / DONE / 未知一律拒绝，避免"只拦底层、放过上层副作用"。
    if (!plan || !USABLE_ROUTE_STATUSES.includes(plan.status)) {
      console.warn('[fireStore] 拒绝启动脉冲强闪：当前路线不可执行',
        { id: activeRoutePlanId.value, status: plan ? plan.status : '<absent>' })
      return false
    }
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
      // P1.7.3-B3：canonical 三元组（权威）+ 只读别名（展示）
      buildingId: buildingIdOf(fe) || fireBuildingId(fe.building),
      floorId: floorIdOf(fe),
      zone: zoneOf(fe),
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
   *
   * P1.8.2 Stage 2-A（K-4）：返回对象的**字段结构与 routeToRenderable 完全一致**
   *    （命中与未命中两条路径都由 routeToRenderable 构造 ⇒ 几何 / 楼层 / 出口标识 /
   *    方案归属等字段逐一对齐，**不存在字段差异**，也不会因 routePlans 未生成 /
   *    正在替换而返回结构不完整的对象）；唯一差别是 `status`：
   *      · 命中权威投影 ⇒ 与 getRoutePlanById(id) **同一对象**（状态与对象身份一致）；
   *      · 未命中 ⇒ status === null（状态未知），**不是** NORMAL；
   *        调用方不得据此判定路线可用 / 不可用。
   *    本函数只读，不写 bp.routes / routesByZone / 后端快照对象。
   */
  const currentRoutePlan = computed(() => {
    const bp = activeBuildingPlan.value
    if (bp && bp.routes && bp.routes.length) {
      const route = bp.routes.find((r) => r.zone === selectedZone.value)
        || buildingRouteOfPerson(bp, { floorId: routeFloorId.value, zone: selectedZone.value })
      if (route) return reconciledRouteView(bp, route)
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
  /**
   * P1.7.3-B3：按 canonical 三元组统计人员（buildingId / floorId / zone）。
   * 兼容旧入参：传中文楼栋名时先反查成 buildingId；查不到返回 0（禁止按别名兜底，防跨楼栋串用）。
   */
  function personCountAt(buildingIdOrName, floorId, zone) {
    const bid = buildingIdOf({ buildingId: /^B\d{3}$/.test(String(buildingIdOrName || '')) ? buildingIdOrName : '', building: buildingIdOrName })
      || buildingIdFromName(buildingIdOrName)
    const fid = floorIdOf({ floorId })
    const zid = zoneOf({ zone })
    if (!bid || !fid || !zid) return 0
    return asArray(persons.value).filter(
      (p) => p && buildingIdOf(p) === bid && floorIdOf(p) === fid && zoneOf(p) === zid
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

  /**
   * P1.8.2 Stage 1（D-3 = A）：按当前出口运行态筛选可用出口。
   *
   * 替代原先的「无状态出口 id 列表」口径 —— 出口实体已有 available / status，
   * 候选目标必须与后端规划器（findPaths → isExitUsable）同一判定口径。
   *
   * Stage 1.3（路径 B 与路径 A 统一口径）：
   *   · 唯一准入来源 = exitReportedUsableNodeIds（真实上报可用集）；
   *   · 不再读 exitRuntimeStates —— 它含静态补齐项，会把「未上报」的出口当作可用（P1-1 根因）；
   *   · exitRawStates === null（从未收到过上报）⇒ 不做收窄，与既有行为一致（无新阻断）。
   *     【D1-A】mock（离线）模式下该状态为永久态 ⇒ mock 模式不实现严格 fail-closed，
   *     不得反向宣称；
   *     只要收到过一次上报（含空数组 / 非法结构）即按真实上报集收窄，fail-closed。
   */
  function usableExitsOf(allExitIds) {
    const ids = Array.isArray(allExitIds) ? allExitIds : []
    if (exitRawStates.value === null || exitRawStates.value === undefined) return ids
    const reported = exitReportedUsableNodeIds.value
    if (!Array.isArray(reported)) return ids
    const ok = new Set(reported.map(String))
    return ids.filter((id) => ok.has(String(id)))
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
    // P1.8.2 Stage 1：shared 拓扑里的安全出口（1F 直通室外）→ 再按运行态可用性筛选
    const exits = usableExitsOf(exitIdsOf(routeGraphCache, '1F'))
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
    // P1.7.3-B3-03：是否重规划只看 canonical buildingId（别名中文名不再参与）
    const feBid = fireEvent.value ? buildingIdOf(fireEvent.value) : ''
    if (feBid && feBid === buildingId) replanRoutesForFire()
    // Stage 1.3：生成后统一收口 —— 新生成的路线同样必须按「真实出口上报」复核，
    // 否则会出现「刚生成即已失效」的窗口。本行之后只有 return，故 reconcile 是最后写入者。
    reconcileRouteStatuses()
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

  /**
   * 整栋楼方案中的一条路线 → 2D/3D 现有渲染结构（字段与 toRenderablePlan 对齐）
   *
   * P1.8.2 Stage 2-A（K-4）：`status` 改为**由调用方显式传入**，不再无条件写死 'NORMAL'。
   *   · 投影种子（syncLegacyRouteState:2945 / :2958）用默认值 'NORMAL' —— 紧随其后的
   *     reconcileRouteStatuses() 会以出口 / 火源维度整体覆盖，种子值不对外可见；
   *   · 展示兜底（reconciledRouteView 未命中权威投影）传 null ——
   *     `status === null` ⟺ **状态未知**（未取得权威投影），语义上**严格区别于**
   *     'NORMAL'（正常可用）；调用方**不得**把 null 当作可用 / 不可用判据；
   *   · 其余调用点（设备联动 :1339/:1407/:3095、本地疏散模拟 :1475）不读 status，
   *     沿用默认值，行为与 K-4 之前完全一致。
   */
  function routeToRenderable(bp, route, status = 'NORMAL') {
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
      status,
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

  /**
   * P1.8.2 Stage 2-A（K-4）：展示层路线状态的**唯一权威源**解析。
   *
   * 背景：reconcileRouteStatuses 只协调 routePlans / routeMatrix.perZone 两个投影，
   * **从不写** activeBuildingPlan.routes —— EvacuationRoute 没有 status 字段
   * （shared/evacuation/buildingEvacuationTypes.js: emptyRoute），且 buildingEvacuationPlans
   * 直接持有后端快照对象（applyBuildingPlans 不克隆，buildingPlanCache 为浅拷贝，
   * routesByZone 与 routes 互为别名），前端不得改写。
   * ⇒ 展示层若直接 routeToRenderable(bp, route) 只会拿到种子 / 兜底状态，
   * 会把出口 / 火源失效结果静默抹掉；故状态必须从 routePlans 取。
   *
   * 契约（调用方必须遵守）：
   *   · **命中**：返回 routePlans 中**同一对象**（与 getRoutePlanById(id) 同一引用），
   *     其 status 已由 reconcileRouteStatuses 协调；几何 / 楼层 / 出口 / 方案归属
   *     与 bp.routes 同源（同一条 route 经 routeToRenderable 派生，字段结构一致）。
   *   · **未命中**（routePlans 尚未生成 / 正在替换 / 该路线不在投影中 / 方案归属不符）：
   *     返回 routeToRenderable(bp, route, null) —— **几何照常可用于绘制**，
   *     但 status === null ⟺ **状态未知**；
   *     ⚠️ 调用方**不得**把该对象当作「已协调完成的路线状态」使用，
   *        也不得把 null 解释为「正常可用」（严禁静默降级为 NORMAL）。
   *   · 本函数只做**状态寻源**，不写 bp.routes / routesByZone / 后端快照对象。
   *
   * ⚠️ 覆盖边界（遗留项，不在 K-4 范围）：本函数只服务展示层
   *    （getAllZoneRoutes / currentRoutePlan）。startEvacuationRun(:1479) 与
   *    applyRouteToDevices(:1339/:1407/:3095) 仍各自直接 routeToRenderable(bp, route)，
   *    其状态门禁问题须作为**独立任务**处理，不得因本函数上线而被视为已修复。
   *
   * @param {object} bp    当前整栋楼方案（activeBuildingPlan）
   * @param {object} route bp.routes 中的一条路线
   * @returns {object|null} 渲染对象；bp / route 无效时返回 null
   */
  function reconciledRouteView(bp, route) {
    if (!bp || !route) return null
    const routeId = String(route.routeId || '')
    // 命中判据 = 路线 id 一致 **且** 方案归属一致（防止跨方案 / 跨楼栋误配）
    const hit = routeId ? getRoutePlanById(routeId) : null
    if (hit && hit.buildingPlanId === bp.id) return hit
    return routeToRenderable(bp, route, null)
  }

  /** 火灾上下文：只描述位置，不含疏散范围（P1.7.3-B3：canonical 唯一权威） */
  function buildingFireContext() {
    const fe = fireEvent.value
    if (!fe) return null
    const loc = fireLocation(fe)
    return { buildingId: loc.buildingId, floorId: loc.floorId, zone: loc.zone }
  }

  /** store 人员 → 规划器入参（buildingId + floorId + zone） */
  function buildingPlanningPersons(buildingId, buildingName) {
    const bid = buildingId || buildingIdFromName(buildingName)
    return asArray(persons.value)
      // P1.7.3-B3：canonical 判定（别名 p.building 只在 buildingId 缺失时兜底）
      .filter((p) => p && (!bid || buildingIdOf(p) === bid))
      .map((p) => ({
        id: p.id, buildingId: bid, floorId: floorIdOf(p), zone: zoneOf(p), status: p.status, x: p.x, y: p.y,
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
    // P1.7.3-B3-03：该键进入 zoneKeyOf(floorId, zone)，必须取 canonical floorId
    const floorId = routeFloorId.value || (fireEvent.value ? floorIdOf(fireEvent.value) : '') || '5F'
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
    // Stage 1.3：投影刷新后统一收口。本投影的 plans 与 routePlans 是两条**独立对象链**，
    // 必须一起由 reconcile 复核并整体采纳，否则会出现「同一 id 两投影状态不一致」。
    reconcileRouteStatuses()
    return active
  }

  /** 本地（mock / 无后端）生成整栋楼三套方案 */
  function generateBuildingEvacuationPlans(opts = {}) {
    // B1-03：demo 模式下疏散方案唯一权威是 Backend DemoEngine 生成的 buildingPlans
    // （DemoRoom/engine → WS snapshot → demoStore → fireStore），禁止前端本地再生成一套 A/B/C
    if (demoGuard('generateBuildingEvacuationPlans')) return { plans: [], groups: [], active: null }
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

  // ── P1.7.3-B3-05（P0-01）：方案选择的单一业务权威 ──
  // demo 模式下「管理员选了哪套方案」只有一个可写槽：demoStore.selectedPlanId。
  // fireStore.activeBuildingPlanId 不再被 View 直接写，而是它的**单向投影**
  // （intent > executed：选过就用选的，没选就用后端快照里的执行方案）。
  const planProjectionBound = ref(false)
  /** demo 侧「已选方案」意向（自动限制在当前方案集合内，跨楼栋不生效） */
  function demoSelectedPlanId(plans) {
    if (!dataSource.isDemo) return null
    const list = Array.isArray(plans) && plans.length ? plans : buildingEvacuationPlans.value
    try {
      const id = useDemoStore().selectedPlanId
      if (!id) return null
      return list.some((p) => p.id === id) ? id : null
    } catch (_) {
      return null
    }
  }
  /**
   * demoStore.selectedPlanId → fireStore 的单向投影（2D / 3D / 后端三者同源）。
   * flush: 'sync' —— 保证选择动作同步驱动 2D/3D，不引入异步第二态。
   */
  function bindPlanSelectionProjection() {
    if (planProjectionBound.value || !dataSource.isDemo) return false
    try {
      const demo = useDemoStore()
      watch(() => demo.selectedPlanId, (id) => {
        if (!id || id === activeBuildingPlanId.value) return
        if (!buildingEvacuationPlans.value.some((p) => p.id === id)) return
        applyBuildingPlanSelection(id)
      }, { flush: 'sync' })
      planProjectionBound.value = true
      return true
    } catch (_) {
      return false
    }
  }

  /** 后端快照 → 整栋楼方案（后端是权威，前端只镜像） */
  function applyBuildingPlans(snap) {
    if (!snap || !Array.isArray(snap.buildingPlans) || !snap.buildingPlans.length) return null
    if (snap.evacuationScope) evacuationScope.value = snap.evacuationScope
    const plans = snap.buildingPlans
    const bid = String(plans[0].buildingId || currentPlanBuildingId.value || routeBuildingId.value)
    // 后端方案是权威：先按所属楼栋归档，之后切回该楼栋时直接恢复，不再重新生成
    buildingPlanCache.value[bid] = plans.slice()
    // P0-01：demo 模式已选意向优先于「后端当前执行/推荐」方案（未选时才用后者的值）
    const selectedId = demoSelectedPlanId(plans)
    const activeId = selectedId
      || snap.activeBuildingPlanId
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

  /**
   * 方案投影落地：只在两条链路里被调用 ——
   *   ① 后端快照（applyBuildingPlans）；② demoStore.selectedPlanId 的单向投影。
   * 其他任何地方都不得直接改 activeBuildingPlanId（P1.7.3-B3-05 P0-01）。
   */
  function applyBuildingPlanSelection(planId) {
    if (!buildingEvacuationPlans.value.some((p) => p.id === planId)) return false
    const active = syncLegacyRouteState(buildingEvacuationPlans.value, planId)
    if (!active) return false
    // 疏散灯沿每条路线方向联动（整栋楼：所有楼层参与，一次性裁决）
    applyBuildingRoutesToDevices(active)
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

  /**
   * P1.7.3-B3-05（P0-01）：View / 面板选择整栋楼方案的**唯一入口**。
   *   · demo 模式：只写 demoStore.selectedPlanId（唯一意向权威），
   *     fireStore / 2D / 3D 通过单向投影跟随 —— 不再出现「View 直接改本地业务状态」；
   *   · mock / api 模式：保留原有本地预览行为（不做任何改动）。
   */
  function selectBuildingPlan(planId) {
    if (!buildingEvacuationPlans.value.some((p) => p.id === planId)) return false
    bindPlanSelectionProjection()
    if (dataSource.isDemo) {
      const bound = planProjectionBound.value
      useDemoStore().selectPlan(planId)
      // 极端环境下投影未绑定成功时兜底同步一次，保证 2D/3D 仍然同源
      if (!bound && planId !== activeBuildingPlanId.value) applyBuildingPlanSelection(planId)
      return true
    }
    return applyBuildingPlanSelection(planId)
  }

  /** 兼容入口：历史调用方（含既有 E2E）继续可用；demo 模式下同样不再写本地第二份状态 */
  function setActiveBuildingPlan(planId) {
    return selectBuildingPlan(planId)
  }

  /** 当前整栋楼方案（2D/3D/后端共用一个源） */
  const activeBuildingPlan = computed(() => (
    buildingEvacuationPlans.value.find((p) => p.id === activeBuildingPlanId.value) || null
  ))

  /**
   * RW-3（方案 B 最小版，**展示层专用**）：刷新后「仅存整栋楼路线投影、当前方案上下文已丢失」。
   * 条件（第二轮只读核实结论）：
   *   · routePlans 非空 —— 恢复的旧路线仍在展示；
   *   · activeBuildingPlan 为空 —— buildingEvacuationPlans / activeBuildingPlanId 不持久化；
   *   · routeMatrix.scope === EVACUATION_SCOPE.BUILDING —— 仅 syncLegacyRouteState:3587 写入
   *     该标记；generateRoutePlans 的 legacy matrix（:3406）无 scope ⇒ legacy 路线不误标。
   * ⚠️ 纯派生展示态：不参与任何执行门禁、不写业务状态、不触发重规划/自动清理/自动准入。
   */
  const hasStaleRoutesWithoutActivePlan = computed(() => (
    asArray(routePlans.value).length > 0
    && !activeBuildingPlan.value
    && !!routeMatrix.value
    && routeMatrix.value.scope === EVACUATION_SCOPE.BUILDING
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
    // B1-03：demo 模式下禁止本地生成方案；改为清空当前方案集合，
    // 避免「没有该楼栋的方案」时继续渲染上一栋楼的方案（跨楼栋串用）。
    if (dataSource.isDemo) {
      buildingEvacuationPlans.value = []
      activeBuildingPlanId.value = null
      activeRoutePlanId.value = null
      routePlans.value = []
      routeMatrix.value = null
      routeDeviceBindings.value = []
      routeDirectionVerdicts.value = []
      routeNoPathRouteIds.value = []
      routeBuildingId.value = bid
      return false
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
    // P1.7.3-B3：火源区域取 canonical zone（fe.area 只是只读别名）
    const info = m && m.perZone && m.perZone[zoneOf(fe)]
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
    if (!fe) return 'NORMAL'
    // P1.7.3-B3：canonical 比较（buildingId / floorId），别名不参与
    const loc = fireLocation(fe)
    const planBid = buildingIdOf(plan) || buildingIdFromName(plan.buildingName)
    if (loc.buildingId && planBid && loc.buildingId !== planBid) return 'NORMAL'
    if (!loc.buildingId && !planBid && fe.building !== plan.buildingName) return 'NORMAL'
    if (plan.floorsPassed.indexOf(loc.floorId) < 0) return 'NORMAL'
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
    // P1.7.3-B3：canonical 三元组（别名仅留给文案与 plan.buildingName 展示）
    const floc2 = fireLocation(fe)
    const buildingName = fe.building
    const buildingId = floc2.buildingId || routeBuildingId.value
    const maxF = getBuildingFloors(buildingId)
    routeGraphCache = buildBuildingGraph(maxF)
    const affectedZones = new Set()
    routePlans.value.forEach((p) => {
      // Stage 1.3：状态**不再**在此直接落盘 —— 原实现的 `p.status = evaluatePlanFire(p)`
      // 是无条件写入，会覆盖上一轮出口失效产生的 BLOCKED（实测：BLOCKED → WARNING，
      // 且 activeRoutePlanId 仍指向该条已失效路线）。
      // 此处只判定受影响区域，最终 status 由本函数尾部的 reconcileRouteStatuses() 统一收口。
      if (p.status === 'DONE') return
      if (evaluatePlanFire(p) === 'BLOCKED') affectedZones.add(p.startArea)
    })
    // P1.8.2 Stage 1（D-5 = A）：与路径 C 同一口径的合法性校验边集合
    // 任意相邻节点必须是图中合法边，禁止穿墙 / 房间直连
    const edgeSet = new Set()
    Object.values(routeGraphCache.adj).forEach((arr) => arr.forEach((e) => edgeSet.add(e.ek)))
    affectedZones.forEach((zone) => {
      // P1.8.2 Stage 1：出口候选按运行态可用性筛选（与路径 C / 后端规划器同一口径）
      const exits = usableExitsOf(exitIdsOf(routeGraphCache, '1F'))
      const startId = sharedNodeId(floc2.floorId, ZONE_NODE_KEY[zone])
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
          const plan = buildPlanFromPath(p, buildingId, buildingName, floc2.floorId, zone, exit, idx)
          // P1.8.2 Stage 1：补齐路线合法性校验（此前路径 D 缺此防线，与路径 C 不一致）
          // 关键防线：任何穿墙 / 穿房间 / 非法跳跃 / 未到出口的路线一律不写入规划结果
          if (!validateRoute(plan.path, { edgeSet }).valid) return
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
    // Stage 1.3：由 reconcileRouteStatuses 取代 recomputeRecommendations ——
    // 前者同时覆盖火源与出口两个维度，并用 isRouteUsable 口径过滤指针（排除 BLOCKED 与 DONE）。
    // 本处之后只剩只读取值与通知，故 reconcile 是整条链的最后一个写入者。
    reconcileRouteStatuses()
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
      // Stage 1.3：DONE 豁免 —— 与 applyExitInvalidation 内 isRouteUsable 的白名单口径对齐，
      // 保证即使走本函数（未收到过出口上报的窗口），指针也不会指向 DONE 路线。
      const safe = info.plans.filter((p) => p.status !== 'BLOCKED' && p.status !== 'DONE')
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
    // R1（Stage 2-A 补充收口）：路线级门禁**先于分支判定**，与 selectEvacuationPlan
    // （FIX-4）同一白名单口径（USABLE_ROUTE_STATUSES）。修复前本函数整栋楼分支无任何
    // 状态检查、legacy 分支仅拦 DONE，且投影未命中（plan=null）时会把未知 id 写入
    // perZone.recommendedId。BLOCKED / DONE / null / 未知 / 投影未命中一律拒绝，
    // 且拒绝时**不改任何指针**（activeRoutePlanId / perZone.recommendedId 均不动）。
    // ⚠️ 只约束**被选中的路线本身**：方案内其它分区路线不可用不拒绝整个方案，
    //    正常分区的可执行性由 FIX-1/FIX-2/FIX-3 在执行层逐条收敛。
    // ⚠️ 只读判定，不触碰路线的历史字段（completedAt / assignedTo / history）。
    if (!plan || !USABLE_ROUTE_STATUSES.includes(plan.status)) {
      console.warn('[fireStore] 拒绝设定当前路线：路线状态不可执行',
        { id: planId, status: plan ? plan.status : '<absent>' })
      return false
    }
    if (plan.buildingPlanId && buildingEvacuationPlans.value.some((p) => p.id === plan.buildingPlanId)) {
      return setActiveBuildingPlan(plan.buildingPlanId)
    }
    // ⚠️ LEGACY：仅旧单区域结构的本地投影，不改变权威方案
    if (!routeMatrix.value) return false
    const info = routeMatrix.value.perZone[zone || selectedZone.value]
    if (!info) return false
    // （状态门禁已由上方统一执行；原 legacy 分支内的 DONE 单查被白名单判据覆盖）
    info.recommendedId = planId
    addNotification({
      title: '当前路线已设定',
      message: `${zone || selectedZone.value} 推荐路线已更新（legacy 投影）`,
      level: 'success',
      time: new Date().toLocaleTimeString('zh-CN'),
    })
    return true
  }
  // P1.8.2 Stage 2-A（K-4）：applyExitInvalidation 明确保留数组长度、null 元素原样返回
  // （shared/evacuation/exitRuntime.js 的「保持数组长度」契约），故谓词必须 null 安全，
  // 否则路由表含 null 时本函数与 reconciledRouteView 会抛 TypeError。
  function getRoutePlanById(id) {
    return asArray(routePlans.value).find((p) => p && p.id === id) || null
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
  // P1.8.2 Stage 2-A（K-4）：本函数只改**状态寻源**，几何仍直接取 bp.routes：
  //   · 遍历 / 过滤 / segment 仍用 bp.routes（与 3D RouteLayer3D 的 r.nodes / r.points 同源）；
  //   · plan.status 经 reconciledRouteView 从 routePlans 取（权威投影），
  //     未命中时为 null（状态未知），**不**回退 NORMAL；
  //   · 返回结构 { zone, color, plan, routeId, segment } 与之前逐字段一致。
  function getAllZoneRoutes() {
    // 整栋楼方案优先：直接取当前方案中「本楼层各区域」的路线（2D 与 3D 同源）
    const bp = activeBuildingPlan.value
    if (bp && bp.routes && bp.routes.length) {
      const floorId = routeFloorId.value
      return bp.routes
        .filter((r) => r.floorId === floorId)
        .map((r) => {
          const plan = reconciledRouteView(bp, r)
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

  // 根据路线方向自动联动沿途疏散灯
  // P1.6.2：楼层归属用统一三元组判定 —— buildingId（兼容旧 buildingName）+ floorId + 路线途经楼层
  //
  // ⚠️ P1.8.2：方向不再取整层统一的 exitSide。旧实现按 `plan.exitSide` 把途经楼层
  //    的**全部**疏散灯改写成同一个方向，整栋楼方案又是逐条路线调用本函数，
  //    于是最终全场方向由「最后一条被遍历的路线」单方面决定（已验证缺陷）。
  //    现在改为按路线路径几何逐台裁决，详见 shared/evacuation/deviceDirection.js。
  //
  // ⚠️ 整栋楼方案必须走 applyBuildingRoutesToDevices()（一次性传入全部路线裁决）。
  //    禁止再写成 forEach(route => applyRouteToDevices(route))。
  function applyRouteToDevices(plan, bindingsAcc) {
    // B1-02：demo 模式下设备方向 / 应急态来自 DemoWorld.devices → WS → store
    if (demoGuard('applyRouteToDevices')) return bindingsAcc || []
    if (!plan) return
    // R3（Stage 2-A 补充收口）：本入口自身持有状态安全契约，不再依赖调用方自律 ——
    // 它是导出 API（store 导出面），历史上出现过无门禁直调（DashboardView.pickPlan，
    // 已只读复核确认为死代码）。BLOCKED / DONE / null / 未知 / status 缺失（无法验证
    // 状态）一律拒绝，且在 applyRoutesToDevices（设备绑定 / 方向裁决 / 方向写入的
    // 唯一执行体）**之前**返回 ⇒ 拒绝时零副作用（不写绑定、不写裁决、不改设备方向）。
    // 上层门禁（FIX-3 adjustEvacuationDirection / FIX-4 selectEvacuationPlan）保留，
    // 本处为纵深防御，两者判据同源（USABLE_ROUTE_STATUSES）。
    // ⚠️ 兼容边界：合法路线视图必携 status（routeToRenderable 恒产出该字段；
    //    reconciledRouteView 未命中时为 null）⇒「缺失即拒绝」不影响任何生产调用方；
    //    测试 / E2E 夹具须显式携带可信 status（demo 短路先于本门禁，不受影响）。
    if (!USABLE_ROUTE_STATUSES.includes(plan.status)) {
      console.warn('[fireStore] 拒绝设备方向下发：路线状态不可执行',
        { id: plan.id, status: plan.status === undefined ? '<absent>' : plan.status })
      return bindingsAcc || []
    }
    const bindings = bindingsAcc || []
    applyRoutesToDevices([plan], bindings)
    if (!bindingsAcc) routeDeviceBindings.value = bindings
    return bindings
  }

  /**
   * 整栋楼方案的**唯一**设备联动入口：先把全部路线一次性裁决，再写设备。
   * 逐条调用 applyRouteToDevices 会让后一条路线覆盖前一条，故此处禁止那样写。
   * @param {object} bp 整栋楼方案（activeBuildingPlan 形状）
   * @returns {Array<{routeId:string,deviceId:string,direction:string}>}
   */
  function applyBuildingRoutesToDevices(bp) {
    if (demoGuard('applyRouteToDevices')) return []
    if (!bp) return []
    // FIX-2（Stage 2-A 遗留项）：设备绑定 / 方向裁决 / 方向写入之前必须核验权威协调
    // 状态。修复前此处用 routeToRenderable 的种子 'NORMAL'，BLOCKED / DONE / 未知
    // （投影未命中 ⇒ reconciledRouteView 返回 null 状态）都会被静默放行。
    // ⚠️ 只剔除不可执行路线：部分分区不可用时正常分区照常下发，不无理由阻断整案。
    const routes = (bp.routes || [])
      .map((r) => reconciledRouteView(bp, r))
      .filter((p) => p && USABLE_ROUTE_STATUSES.includes(p.status))
    const bindings = []
    if (!routes.length) {
      // 全部路线不可执行：不得产生任何设备更新 / 残留绑定 / 陈旧裁决（裁决为覆盖式，
      // 不重写会残留上一轮结论），也不启动应急灯强闪（无途经楼层）。
      routeDeviceBindings.value = []
      routeDirectionVerdicts.value = []
      routeNoPathRouteIds.value = []
      console.warn('[fireStore] 楼栋级设备下发中止：当前方案无可执行路线（BLOCKED/DONE/未知）')
      return bindings
    }
    applyRoutesToDevices(routes, bindings)
    routeDeviceBindings.value = bindings
    return bindings
  }

  /**
   * 内部实现（不单独做 demo 守卫，由上面的入口统一拦截）。
   *   ① 应急照明灯：途经楼层全部进入应急强闪 —— 与方向无关，维持既有行为，
   *      且**不因方向未定/冲突而回退**；
   *   ② 疏散指示灯：按路线几何逐台裁决，**每台设备只写一次、只留一条绑定**。
   *
   * ⚠️ P1.8.2 第一阶段：只有 state === resolved 的设备才被写入方向。
   *    conflict / undetermined / unlinked 一律**不写** d.direction（也不写 recommendedDirection），
   *    并登记到 routeDirectionVerdicts —— 调用方（UI）必须据此显示「冲突 / 未裁决 / 未联动」，
   *    **不得**把设备保留的旧 direction 当作本轮有效指引。
   */
  function applyRoutesToDevices(routes, bindingsAcc) {
    const list = (routes || []).filter(Boolean)
    if (!list.length) return bindingsAcc
    const buildingKey = list[0].buildingId || list[0].buildingName
    const floorsPassed = [...new Set(list.flatMap((r) => r.floorsPassed || []))]
    const targets = asArray(devices.value).filter(
      (d) =>
        d &&
        deviceInBuilding(d, buildingKey) &&
        // P1.7.3-B3：楼层只看 canonical floorId（别名 d.floor 不再作为第二套口径）
        floorsPassed.includes(floorIdOf(d)) &&
        (d.type === 'evacuation_light' || d.type === 'emergency_light'),
    )
    // ① 应急照明灯（与方向裁决结果无关，不受未定/冲突影响）
    targets.forEach((d) => {
      if (d.type !== 'emergency_light') return
      d.status = 'emergency'
      d.brightness = 100
      d.currentMode = 'emergency'
    })
    // ② 疏散指示灯
    const lights = targets.filter((d) => d.type === 'evacuation_light')
    const result = resolveDeviceDirections(
      lights.map((d) => ({ id: d.id, x: d.x, y: d.y, floorId: floorIdOf(d) })),
      // weight 只作为诊断信息进入 conflicts.candidates，不参与方向裁决
      list.map((r) => ({ id: r.id, path: r.path, weight: r.congestion ?? r.personCount ?? null })),
    )
    const { bindings, undetermined, conflicts, unlinked, noPathRoutes } = result

    // 登记本轮裁决状态（覆盖式：本轮结果不残留上一轮结论）
    const verdicts = []
    bindings.forEach((b) => {
      verdicts.push({
        deviceId: b.deviceId,
        state: DIRECTION_VERDICT.RESOLVED,
        routeId: b.routeId,
        direction: b.direction,
        distance: b.distance,
        dx: b.dx,
      })
    })
    undetermined.forEach((u) => {
      verdicts.push({
        deviceId: u.deviceId,
        state: DIRECTION_VERDICT.UNDETERMINED,
        routeId: u.routeId,
        distance: u.distance,
        dx: u.dx,
        // P1.8.2 第二阶段：降级原因（corner-vertical-in-edge / no-horizontal-movement）
        reason: u.reason || null,
      })
    })
    conflicts.forEach((c) => {
      verdicts.push({
        deviceId: c.deviceId,
        state: DIRECTION_VERDICT.CONFLICT,
        distance: c.distance,
        reason: c.reason,
        candidates: c.candidates,
      })
    })
    unlinked.forEach((u) => {
      verdicts.push({ deviceId: u.deviceId, state: DIRECTION_VERDICT.UNLINKED, reason: u.reason })
    })
    routeDirectionVerdicts.value = verdicts
    routeNoPathRouteIds.value = (noPathRoutes || []).filter((x) => x !== null && x !== undefined)

    // 只有 resolved 才写设备；其余保持原值但**不被视为本轮结果**
    const lightById = new Map(lights.map((d) => [d.id, d]))
    bindings.forEach((b) => {
      const d = lightById.get(b.deviceId)
      if (!d) return
      d.direction = b.direction
      d.recommendedDirection = b.direction
      // routeDeviceBindings 保持既有形状 {routeId, deviceId, direction}
      if (!bindingsAcc.some((x) => x.deviceId === b.deviceId)) {
        bindingsAcc.push({ routeId: b.routeId, deviceId: b.deviceId, direction: b.direction })
      }
    })
    return bindingsAcc
  }

  /** 取某台设备的本轮路线裁决状态；未参与本轮裁决返回 null（UI 应显示"暂无本轮裁决"）。 */
  function getRouteDirectionVerdict(deviceId) {
    return routeDirectionVerdicts.value.find((v) => v.deviceId === deviceId) || null
  }

  /**
   * P1.8.2 第二阶段（问题 C）：方向被**非路线途径**改写时，把该设备的裁决状态标记为
   * `overridden`，使界面无法再把上一轮的 `resolved` 当作「当前方向有效」的依据。
   *
   * ⚠️ 只改前端裁决状态，**不新增设备协议字段、不下发任何远程命令**。
   * ⚠️ 写入方式为**整表替换**（过滤同 deviceId 后追加），不得就地改写：显示层的缓存失效
   *    与 E2E 采集都以「数组引用变化」为信号。
   * @param {string} deviceId
   * @param {string} direction 实际写入设备的方向
   * @param {'manual'|'fire-avoidance'} source 覆盖来源
   */
  function markDirectionOverridden(deviceId, direction, source) {
    const entry = {
      deviceId,
      state: DIRECTION_VERDICT.OVERRIDDEN,
      direction,
      overrideSource: source,
    }
    routeDirectionVerdicts.value = [
      ...routeDirectionVerdicts.value.filter((v) => v.deviceId !== deviceId),
      entry,
    ]
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
    // Stage 1.3：删除原「全量 status = 'NORMAL'」—— 它会把出口失效产生的 BLOCKED 一并抹掉
    // （实测：r2 BLOCKED → NORMAL）。火情清空后的状态由本函数末尾的 reconcile 统一收口。
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
    // Stage 1.3：收口必须在本函数**最末尾** —— 下方 activeRoutePlanId 的清空在本行之前，
    // 若把 reconcile 放在原 recomputeRecommendations() 的位置，它就不是最后一个写入者。
    // 此刻：火情已清空 ⇒ 火源维度全 NORMAL；出口维度按最后一次真实上报判定；DONE 不受影响；
    // activeRoutePlanId 此刻为 null，applyExitInvalidation 对 null 不做提升 ⇒ 保持 null。
    reconcileRouteStatuses()
  }

  // -------- 自由绘制（草稿，不影响自动算法，也不进入独立可执行路线集合） --------
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
  // K-1B.2：自由绘制只生成草稿（manualRouteDrafts），不再注入 routePlans 候选列表，
  // 也不得进入 manualExecutableRoutes（独立可执行路线）。
  function saveManualRoute() {
    const draft = {
      id: `RP-MANUAL-DRAFT-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      name: '自由绘制草稿',
      type: 'manual-draft',
      buildingId: routeBuildingId.value,
      startFloor: routeFloorId.value,
      createdAt: Date.now(),
      manualNodes: JSON.parse(JSON.stringify(routeNodes.value)),
      manualEdges: JSON.parse(JSON.stringify(routeEdges.value)),
    }
    manualRouteDrafts.value.push(draft)
    addNotification({
      title: '草稿已保存',
      message: '自由绘制内容已保存为草稿（不可执行）',
      level: 'success',
      time: new Date().toLocaleTimeString('zh-CN'),
    })
    return draft
  }
  function deleteManualRouteDraft(draftId) {
    const before = manualRouteDrafts.value.length
    manualRouteDrafts.value = manualRouteDrafts.value.filter((x) => !x || x.id !== draftId)
    return manualRouteDrafts.value.length < before
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
    // K-1B.2：独立手动可执行路线（仅持久化原始路线数据，草稿不持久化）
    manualExecutableRoutes,
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
  // K-1B.2：恢复后对独立手动路线做结构清洗 —— 区分「结构损坏（剔除）」与「拓扑失效（保留）」。
  // 旧快照缺少 manualExecutableRoutes 字段时，restorePersistSnapshot 不写入，此处按空集合处理。
  {
    const sanitized = sanitizeManualExecutableRoutes(manualExecutableRoutes.value)
    manualExecutableRoutes.value = sanitized.clean
    if (sanitized.dropped.length) {
      manualRoutesRestoreReport.value = sanitized.dropped
      console.warn('[fireStore] 手动路线恢复：已剔除结构损坏记录（拓扑失效路线保留）', sanitized.dropped)
    }
  }
  // RW-2：路线投影恢复清洗（结构剔除 + 未知 status 归一 null + 悬空引用清除 + routeMatrix 兜底）。
  // 位置约束：必须在 restorePersistSnapshot 赋值之后、持久化 watch 注册之前 ——
  // 避免清洗赋值触发防抖回写（watch 此时尚未注册）。
  {
    const sanitized = sanitizeRouteProjection()
    if (sanitized.dropped.length) {
      routeProjectionRestoreReport.value = sanitized.dropped
      console.warn('[fireStore] 路线投影恢复：已剔除/降级无效数据（未知状态路线保留几何但不可执行）', sanitized.dropped)
    }
  }

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
    // P2-03：从后端 operation_logs 回读权威日志（含 demo 六阶段记录）
    refreshOperationLogs,
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
    // P1.8.2：方向裁决表（resolved / remote / conflict / undetermined / unlinked / overridden）
    routeDirectionVerdicts,
    directionVerdictIndex,
    getRouteDirectionVerdict,
    routeNoPathRouteIds,
    routeFireAutoSwitch,
    generateRoutePlans,
    // ── P1.8.2 Stage 1：出口运行态（后端唯一权威；导出供 UI 展示与验证注入） ──
    exitRuntimeStates,
    exitStateDegraded,
    exitStateReason,
    applyExitRuntimeStates,
    invalidateRoutesWithUnusableExit,
    // ── P1.8.2 Stage 1.3：状态收口与策略 B 输入态（导出供测试与诊断读取） ──
    reconcileRouteStatuses,
    exitRawStates,
    exitReportedUsableNodeIds,
    usableExitsOf,
    // ── 整栋楼疏散（scope = BUILDING） ──
    buildingEvacuationPlans,
    activeBuildingPlanId,
    activeBuildingPlan,
    // RW-3（方案 B）：刷新后仅存整栋楼路线投影、无当前方案上下文的展示态标志
    hasStaleRoutesWithoutActivePlan,
    evacuationScope,
    generateBuildingEvacuationPlans,
    setActiveBuildingPlan,
    // P1.7.3-B3-05（P0-01）：View 层方案选择的唯一入口
    selectBuildingPlan,
    applyBuildingPlans,
    buildingRouteOfPerson,
    toggleRouteDebug,
    setCurrentRoutePlan,
    setSelectedZone,
    getRoutePlanById,
    getRouteSegmentForFloor,
    getAllZoneRoutes,
    applyRouteToDevices,
    // P1.8.2：整栋楼方案的疏散灯联动唯一入口（多路线一次性裁决）
    applyBuildingRoutesToDevices,
    simulateRouteFire,
    clearRouteFire,
    replanRoutesForFire,
    addManualNode,
    toggleManualEdge,
    setManualStart,
    setManualExit,
    saveManualRoute,
    clearManualRoute,
    deleteManualRouteDraft,
    // ── K-1B.2：权威图统一暴露 + 独立手动可执行路线 ──
    manualExecutableRoutes,
    manualRouteDrafts,
    manualRoutesRestoreReport,
    authoritativeRouteGraph,
    authGraphPath,
    authGraphDraftId,
    authGraphError,
    authAdjacentNodeIds,
    isAuthStartNode,
    isAuthExitNode,
    canAuthStep,
    pickAuthGraphStart,
    appendAuthGraphNode,
    undoAuthGraphStep,
    cancelAuthGraphSelection,
    resetAuthGraphSelection,
    loadAuthGraphRouteForEdit,
    saveAuthGraphRoute,
    createManualExecutableRoute,
    replaceManualExecutableRoute,
    deleteManualExecutableRoute,
    buildManualExecutableRoute,
    sanitizeManualExecutableRoutes,
    // ── RW-2：持久化恢复时的路线投影清洗（结构剔除 / 未知状态归一 null / 悬空引用清除） ──
    routeProjectionRestoreReport,
    sanitizeRouteProjection,
    // ── K-1B.3：安全准入（拓扑）+ 只读状态投影 ──
    graphForBuilding,
    validateManualRouteTopology,
    manualRouteExitVerdict,
    manualRouteStatusView,
    dashboardView,
    saveDashboardViewState,
    restoreDashboardView,
    setDashboardFire,
    clearDashboardFire,
    operationLogs,
    addOperationLog,
  }
})

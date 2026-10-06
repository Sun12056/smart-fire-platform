// ================== Demo Store ==================
// 后端六阶段状态机（Demo Simulation Engine）在前端的唯一镜像。
// 前端不自行推演阶段：只发送业务指令，状态一律以服务端广播为准。
import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { DemoSocket } from '../api/demoClient'
import { demoService } from '../services/demoService'
import { useFireStore } from './fireStore'
import { WS_MSG, DEMO_FLOW_STAGES } from '../api/contract'
import { dataSource } from '../api'
// 人员运行时统一契约（P1.6.1）：后端 → demoStore → fireStore → 2D/3D 同一套字段
import { normalizePersonRuntime } from '../../shared/person/personRuntime.js'
// 设备运行时统一契约（P1.6.2）：后端 → demoStore → fireStore → 2D/3D 同一套设备 id 与楼层归属
import { normalizeDeviceRuntime } from '../../shared/device/deviceRuntime.js'

export const useDemoStore = defineStore('demo', () => {
  // ── 状态（全部来自后端） ──
  const stage = ref('IDLE')
  const stageIndex = ref(0)
  const stageLabel = ref('正常状态')
  const nextCommand = ref('START_FIRE')
  const allowedCommands = ref(['START_FIRE'])
  const fire = ref(null)
  /**
   * ⚠️ LEGACY：旧「单火灾区域 A/B/C 方案」镜像，仅用于历史展示/兼容，
   * 不得用于人员路线、当前方案、2D/3D 路线或任何疏散决策（见 P1.5.5）。
   */
  const plans = ref([])
  const activePlanId = ref(null)
  /** 权威：整栋楼疏散方案（scope=BUILDING）与当前执行方案 id */
  const buildingPlans = ref([])
  const activeBuildingPlanId = ref(null)
  const evacuationScope = ref('BUILDING')
  /** 管理员在 ROUTE_PLANNING 阶段点选的整栋楼方案（确认后成为 activeBuildingPlanId） */
  const selectedPlanId = ref(null)
  const lighting = ref(null)
  const metrics = ref({ total: 0, evacuating: 0, evacuated: 0, retained: 0, rescued: 0, riskZones: 0 })
  const rescue = ref({ active: false, completed: false, task: null })
  const persons = ref([])
  const devices = ref([])
  const eventLog = ref([])
  const evacuationSettled = ref(false)
  const seq = ref(0)
  /** P1.7.3-B2：requestSync 发送次数（重连是否真的发起全量同步，可观测） */
  const syncCount = ref(0)

  // ── 连接与错误 ──
  const wsStatus = ref('idle')     // idle | connecting | open | reconnecting | closed | error
  const connected = computed(() => wsStatus.value === 'open')
  const error = ref(null)          // 指令错误（含非法状态转换）
  const pending = ref(false)
  const transitions = ref(null)

  let socket = null
  let fireStoreRef = null

  const flowSteps = computed(() =>
    DEMO_FLOW_STAGES.map((id, i) => ({
      id,
      index: i,
      name: stageName(id),
      done: stageIndex.value > i + 1 || stage.value === 'COMPLETED',
      active: stageIndex.value === i + 1,
    })),
  )
  const progress = computed(() => {
    if (stage.value === 'IDLE') return 0
    if (stage.value === 'COMPLETED') return 100
    return Math.round(((stageIndex.value - 1) / DEMO_FLOW_STAGES.length) * 100)
  })

  function stageName(id) {
    return {
      FIRE_DETECTED: '发现火灾',
      EMERGENCY_RESPONSE: '启动应急响应',
      ROUTE_PLANNING: '疏散路径规划',
      SMART_EVACUATION: '智能疏散',
      RETAINED_PERSONS: '滞留人员识别',
      RESCUE_COORDINATION: '协同消防救援',
    }[id] || id
  }

  /**
   * P1.7.3-B2-02：单一版本仲裁。
   * DemoWorld.seq 是会话级单调递增（RESET 保留 seq），snapshot / stage / tick /
   * REST 响应共用同一个 seq 语义 —— 因此「更旧的版本」一律丢弃：
   *   旧 snapshot 不得覆盖新 tick，旧 tick 不得覆盖新 snapshot，晚到的 REST 响应不得覆盖更新的 WS 状态。
   * seq 缺失（老版本后端 / 本地构造消息）按既有行为放行，不改变 mock / api 语义。
   */
  function isStale(incomingSeq) {
    if (incomingSeq === undefined || incomingSeq === null) return false
    const n = Number(incomingSeq)
    if (!Number.isFinite(n)) return false
    return n < seq.value
  }

  // ── 应用服务端快照（并同步进 fireStore 供既有页面渲染） ──
  function applySnapshot(snap) {
    if (!snap) return false
    // B2-02：过期版本一律拒绝（返回 false 供调用方/测试判定）
    if (isStale(snap.seq)) {
      console.warn(`[demoStore] 丢弃过期快照：incoming.seq=${snap.seq} < local.seq=${seq.value}`)
      return false
    }
    if (snap.stage) {
      stage.value = snap.stage
      stageIndex.value = snap.stageIndex ?? 0
      stageLabel.value = snap.stageLabel || stage.value
      nextCommand.value = snap.nextCommand ?? null
      allowedCommands.value = snap.allowedCommands ?? []
    }
    if (snap.seq !== undefined) seq.value = snap.seq
    if (snap.fire !== undefined) fire.value = snap.fire
    if (snap.plans !== undefined) plans.value = snap.plans || []
    if (snap.activePlanId !== undefined) activePlanId.value = snap.activePlanId
    // 整栋楼疏散方案（scope = BUILDING）：PLAN-A/B/C = 三种整栋楼策略
    if (snap.buildingPlans !== undefined) buildingPlans.value = snap.buildingPlans || []
    if (snap.activeBuildingPlanId !== undefined) activeBuildingPlanId.value = snap.activeBuildingPlanId
    if (snap.evacuationScope !== undefined) evacuationScope.value = snap.evacuationScope
    if (snap.lighting !== undefined) lighting.value = snap.lighting
    if (snap.metrics !== undefined) metrics.value = snap.metrics
    if (snap.rescue !== undefined) rescue.value = snap.rescue
    // 人员：统一契约（后端权威的 id / routeId / routePoints / progress / position）
    if (snap.persons !== undefined) {
      persons.value = (snap.persons || []).map((p) => normalizePersonRuntime(p))
    }
    // 设备：统一契约（后端权威的 buildingId / floorId / zone → 楼层归属）
    if (snap.devices !== undefined) {
      devices.value = (snap.devices || []).map((d) => normalizeDeviceRuntime(d))
    }
    if (snap.eventLog !== undefined) eventLog.value = snap.eventLog || []
    if (snap.evacuationSettled !== undefined) evacuationSettled.value = snap.evacuationSettled

    // 同步到既有 fireStore（页面读取 fireStore 渲染，避免双份数据源）
    if (fireStoreRef) fireStoreRef.applyDemoSnapshot(snap)
    return true
  }

  function handleMessage(msg) {
    switch (msg.type) {
      case WS_MSG.SNAPSHOT:
      case WS_MSG.STAGE:
        applySnapshot(msg)
        break
      case WS_MSG.TICK:
        // B2-02：过期 tick 不得覆盖已收到的更新状态（含重放 / 乱序）
        if (isStale(msg.seq)) {
          console.warn(`[demoStore] 丢弃过期 tick：incoming.seq=${msg.seq} < local.seq=${seq.value}`)
          break
        }
        if (msg.seq !== undefined) seq.value = msg.seq
        // 实时疏散动态：只更新人员与指标（人员同样按统一契约规范化）
        if (msg.persons) persons.value = msg.persons.map((p) => normalizePersonRuntime(p))
        // 设备状态变化同样可能随 tick 下发（当前后端只在 snapshot/stage 带设备，这里做兼容）
        if (msg.devices) devices.value = msg.devices.map((d) => normalizeDeviceRuntime(d))
        if (msg.metrics) metrics.value = msg.metrics
        if (msg.evacuationSettled !== undefined) evacuationSettled.value = msg.evacuationSettled
        if (fireStoreRef) fireStoreRef.applyDemoTick(msg)
        break
      case WS_MSG.PONG:
        break
      default:
        break
    }
  }

  async function connect() {
    if (!dataSource.isDemo) return
    if (!fireStoreRef) fireStoreRef = useFireStore()
    // 首次拉取全量快照（REST），随后由 WS 推送增量
    try {
      const snap = await demoService.getState()
      applySnapshot(snap)
      error.value = null
    } catch (err) {
      error.value = `无法连接后端状态机：${err.message}`
    }
    if (!transitions.value) {
      try { transitions.value = await demoService.getTransitions() } catch { /* 元信息失败不阻塞 */ }
    }
    if (socket) socket.close()
    socket = new DemoSocket({
      sessionId: demoService.sessionId,
      onMessage: handleMessage,
      onStatus: (s) => { wsStatus.value = s },
      onSync: () => { syncCount.value += 1 },
    })
    socket.connect()
  }

  function disconnect() {
    if (socket) { socket.close(); socket = null }
    wsStatus.value = 'closed'
  }

  /** P1.7.3-B2-05：主动请求全量快照（重连后补齐断线窗口的状态） */
  function requestSync() {
    if (socket) socket.requestSync()
  }

  // ── 业务指令（前端只发起，结果由后端广播回来） ──
  async function sendCommand(command, payload = {}) {
    if (!dataSource.isDemo) return null
    pending.value = true
    error.value = null
    try {
      const snap = await demoService.sendCommand(command, payload)
      applySnapshot(snap)
      return snap
    } catch (err) {
      // 非法/重复操作：后端返回 409，前端显式提示（不静默忽略）
      error.value = err.payload?.error || err.message
      return null
    } finally {
      pending.value = false
    }
  }

  const startFire = () => sendCommand('START_FIRE')
  const activateResponse = () => sendCommand('ACTIVATE_RESPONSE')
  const planRoutes = () => sendCommand('PLAN_ROUTES')

  /** 管理员点选方案（仅本地选择，不推进阶段） */
  function selectPlan(planId) {
    selectedPlanId.value = planId || null
  }

  /**
   * 确认疏散路径：ROUTE_PLANNING → SMART_EVACUATION 的唯一入口。
   * 确认的永远是「整栋楼方案」：buildingPlanId = PLAN-A/B/C（后端强制校验 scope + buildingId + 全楼路线覆盖）。
   * 不再接受仅传旧 planId（legacy zone plan）的确认。
   */
  function confirmRoute(planId) {
    const bpId = buildingPlans.value.find((p) => p.id === planId)?.id
      || buildingPlans.value.find((p) => p.id === selectedPlanId.value)?.id
      || buildingPlans.value.find((p) => p.id === activeBuildingPlanId.value)?.id
      || buildingPlans.value.find((p) => p.recommended)?.id
      || null
    if (!bpId) {
      error.value = '当前没有可执行的整栋楼疏散方案，请先完成路线规划'
      return Promise.resolve(null)
    }
    selectedPlanId.value = bpId
    return sendCommand('CONFIRM_ROUTE', { buildingPlanId: bpId })
  }

  const completeEvacuation = () => sendCommand('COMPLETE_EVACUATION')
  const confirmRetained = () => sendCommand('CONFIRM_RETAINED')
  const completeRescue = () => sendCommand('COMPLETE_RESCUE')
  async function reset() {
    selectedPlanId.value = null
    return sendCommand('RESET')
  }

  /** 推进到下一阶段（后端决定下一步是什么，前端只发指令） */
  function advance() {
    if (!nextCommand.value) return null
    if (nextCommand.value === 'CONFIRM_ROUTE') {
      // 权威：整栋楼方案（selectedPlanId / activeBuildingPlanId → buildingPlanId）
      return confirmRoute(selectedPlanId.value || activeBuildingPlanId.value)
    }
    return sendCommand(nextCommand.value)
  }

  return {
    // 状态
    stage, stageIndex, stageLabel, nextCommand, allowedCommands,
    fire, plans, activePlanId, selectedPlanId, lighting, metrics, rescue,
    buildingPlans, activeBuildingPlanId, evacuationScope,
    persons, devices, eventLog, evacuationSettled, seq,
    // 连接
    wsStatus, connected, error, pending, transitions, flowSteps, progress, syncCount,
    // 动作
    connect, disconnect, requestSync, sendCommand, advance, selectPlan,
    startFire, activateResponse, planRoutes, confirmRoute, completeEvacuation, confirmRetained, completeRescue, reset,
    // WS 消息入口（E2E 注入乱序/过期消息用；生产链路即 handleMessage 本身）
    applySnapshot, handleMessage,
  }
})

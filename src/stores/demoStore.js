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

export const useDemoStore = defineStore('demo', () => {
  // ── 状态（全部来自后端） ──
  const stage = ref('IDLE')
  const stageIndex = ref(0)
  const stageLabel = ref('正常状态')
  const nextCommand = ref('START_FIRE')
  const allowedCommands = ref(['START_FIRE'])
  const fire = ref(null)
  const plans = ref([])
  const activePlanId = ref(null)
  const lighting = ref(null)
  const metrics = ref({ total: 0, evacuating: 0, evacuated: 0, retained: 0, rescued: 0, riskZones: 0 })
  const rescue = ref({ active: false, completed: false, task: null })
  const persons = ref([])
  const devices = ref([])
  const eventLog = ref([])
  const evacuationSettled = ref(false)
  const seq = ref(0)

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

  // ── 应用服务端快照（并同步进 fireStore 供既有页面渲染） ──
  function applySnapshot(snap) {
    if (!snap) return
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
    if (snap.lighting !== undefined) lighting.value = snap.lighting
    if (snap.metrics !== undefined) metrics.value = snap.metrics
    if (snap.rescue !== undefined) rescue.value = snap.rescue
    if (snap.persons !== undefined) persons.value = snap.persons || []
    if (snap.devices !== undefined) devices.value = snap.devices || []
    if (snap.eventLog !== undefined) eventLog.value = snap.eventLog || []
    if (snap.evacuationSettled !== undefined) evacuationSettled.value = snap.evacuationSettled

    // 同步到既有 fireStore（页面读取 fireStore 渲染，避免双份数据源）
    if (fireStoreRef) fireStoreRef.applyDemoSnapshot(snap)
  }

  function handleMessage(msg) {
    switch (msg.type) {
      case WS_MSG.SNAPSHOT:
      case WS_MSG.STAGE:
        applySnapshot(msg)
        break
      case WS_MSG.TICK:
        // 实时疏散动态：只更新人员与指标
        if (msg.persons) persons.value = msg.persons
        if (msg.metrics) metrics.value = msg.metrics
        if (msg.evacuationSettled !== undefined) evacuationSettled.value = msg.evacuationSettled
        if (msg.seq !== undefined) seq.value = msg.seq
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
    })
    socket.connect()
  }

  function disconnect() {
    if (socket) { socket.close(); socket = null }
    wsStatus.value = 'closed'
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
  const confirmRoute = (planId) => sendCommand('CONFIRM_ROUTE', planId ? { planId } : {})
  const completeEvacuation = () => sendCommand('COMPLETE_EVACUATION')
  const confirmRetained = () => sendCommand('CONFIRM_RETAINED')
  const completeRescue = () => sendCommand('COMPLETE_RESCUE')
  const reset = () => sendCommand('RESET')

  /** 推进到下一阶段（后端决定下一步是什么） */
  function advance() {
    if (!nextCommand.value) return null
    if (nextCommand.value === 'CONFIRM_ROUTE') return confirmRoute(activePlanId.value)
    return sendCommand(nextCommand.value)
  }

  return {
    // 状态
    stage, stageIndex, stageLabel, nextCommand, allowedCommands,
    fire, plans, activePlanId, lighting, metrics, rescue,
    persons, devices, eventLog, evacuationSettled, seq,
    // 连接
    wsStatus, connected, error, pending, transitions, flowSteps, progress,
    // 动作
    connect, disconnect, sendCommand, advance,
    startFire, activateResponse, planRoutes, confirmRoute, completeEvacuation, confirmRetained, completeRescue, reset,
    applySnapshot,
  }
})

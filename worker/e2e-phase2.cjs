/**
 * 阶段二 E2E 测试
 * 覆盖：六阶段状态机全链路、WebSocket 连接与广播、非法状态转换、重复操作、
 *       断线重连、关键 REST API。
 * 运行：先启动 wrangler dev（8787），再 node worker/e2e-phase2.cjs
 */
const WebSocket = require('ws')

const BASE = process.env.API_BASE || 'http://127.0.0.1:8787'
const WS_BASE = BASE.replace(/^http/, 'ws')
const SESSION = 'e2e-session'

let passed = 0
let failed = 0
const failures = []

function check(name, cond, extra) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name); console.log(`  ✗ ${name}${extra ? ' → ' + JSON.stringify(extra) : ''}`) }
}

async function api(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, options)
  const text = await res.text()
  let body = null
  try { body = JSON.parse(text) } catch { /* 非 JSON */ }
  return { status: res.status, body }
}

const cmd = (command, payload = {}) =>
  api(`/api/v1/demo/command?sessionId=${SESSION}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ command, payload }),
  })

function openWs(sessionId = SESSION) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_BASE}/api/v1/demo/ws?sessionId=${sessionId}`)
    const messages = []
    ws.on('message', (raw) => {
      try { messages.push(JSON.parse(raw.toString())) } catch { /* ignore */ }
    })
    ws.on('open', () => resolve({ ws, messages }))
    ws.on('error', reject)
    setTimeout(() => reject(new Error('WS 连接超时')), 8000)
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor(fn, timeoutMs = 6000, interval = 200) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (fn()) return true
    await sleep(interval)
  }
  return false
}

;(async () => {
  console.log(`\n=== 阶段二 E2E（${BASE}）===\n`)

  // ── 0. 健康检查 ──
  console.log('[0] 服务健康与关键 REST')
  const health = await api('/healthz')
  check('healthz 返回 200', health.status === 200, health.body)
  const buildings = await api('/api/v1/buildings')
  check('GET /buildings 返回 4 栋', buildings.status === 200 && Array.isArray(buildings.body) && buildings.body.length === 4)
  const devices = await api('/api/v1/devices?buildingId=B003&floorId=5F')
  check('GET /devices 过滤查询可用', devices.status === 200 && Array.isArray(devices.body) && devices.body.length > 0)
  const alarms = await api('/api/v1/alarms?limit=5')
  check('GET /alarms 可用', alarms.status === 200 && Array.isArray(alarms.body))
  const logs = await api('/api/v1/operation-logs?limit=5')
  check('GET /operation-logs 可用', logs.status === 200 && Array.isArray(logs.body))

  // ── 1. 状态机元信息 ──
  console.log('\n[1] 状态机元信息')
  const meta = await api('/api/v1/demo/transitions')
  const flow = meta.body?.flow || []
  check('六阶段顺序正确', JSON.stringify(flow.map((f) => f.id)) === JSON.stringify([
    'FIRE_DETECTED', 'EMERGENCY_RESPONSE', 'ROUTE_PLANNING', 'SMART_EVACUATION', 'RETAINED_PERSONS', 'RESCUE_COORDINATION',
  ]), flow.map((f) => f.id))
  check('IDLE 仅允许 START_FIRE', JSON.stringify(meta.body?.transitions?.IDLE) === '{"START_FIRE":"FIRE_DETECTED"}')

  // ── 2. 复位（IDLE 下 RESET 属于非法转换，应为 409） ──
  console.log('\n[2] 复位语义')
  // 会话是持久的（Durable Object），先确保回到 IDLE 再断言
  let cur = await api(`/api/v1/demo/state?sessionId=${SESSION}`)
  if (cur.body?.stage !== 'IDLE') {
    await api(`/api/v1/demo/reset?sessionId=${SESSION}`, { method: 'POST' })
    cur = await api(`/api/v1/demo/state?sessionId=${SESSION}`)
  }
  check('已回到 IDLE', cur.body?.stage === 'IDLE', cur.body?.stage)
  const idleReset = await api(`/api/v1/demo/reset?sessionId=${SESSION}`, { method: 'POST' })
  check('IDLE 下 RESET 判定为非法转换（409）', idleReset.status === 409, idleReset.body)
  const startThenReset = await cmd('START_FIRE')
  check('START_FIRE 成功（用于验证可复位）', startThenReset.status === 200, startThenReset.body?.stage)
  const reset = await api(`/api/v1/demo/reset?sessionId=${SESSION}`, { method: 'POST' })
  check('非 IDLE 下 RESET 回到 IDLE', reset.status === 200 && reset.body?.stage === 'IDLE', reset.body?.stage)

  // ── 3. 非法转换与重复操作 ──
  console.log('\n[3] 非法状态转换 / 重复操作')
  const illegal = await cmd('COMPLETE_RESCUE')
  check('IDLE 下 COMPLETE_RESCUE 返回 409', illegal.status === 409, illegal.body)
  check('409 响应带允许命令列表', Array.isArray(illegal.body?.allowed) && illegal.body.allowed.includes('START_FIRE'))
  const unknown = await cmd('NO_SUCH_COMMAND')
  check('未知命令返回 400', unknown.status === 400, unknown.body)

  const fire1 = await cmd('START_FIRE')
  check('START_FIRE 成功 → FIRE_DETECTED', fire1.status === 200 && fire1.body?.stage === 'FIRE_DETECTED', fire1.body?.stage)
  const fire2 = await cmd('START_FIRE')
  check('重复 START_FIRE 返回 409', fire2.status === 409, fire2.body)
  const skip = await cmd('CONFIRM_ROUTE')
  check('跳阶段 CONFIRM_ROUTE 返回 409', skip.status === 409, skip.body)

  // ── 4. WebSocket 连接与广播 ──
  console.log('\n[4] WebSocket 连接与广播')
  const { ws, messages } = await openWs()
  check('WS 连接成功并收到快照', await waitFor(() => messages.some((m) => m.type === 'demo.snapshot')), messages.map((m) => m.type))
  const snapshot = messages.find((m) => m.type === 'demo.snapshot')
  check('快照含阶段与人员', Boolean(snapshot?.stage) && Array.isArray(snapshot?.persons), snapshot?.stage)

  const before = messages.length
  const resp = await cmd('ACTIVATE_RESPONSE')
  check('ACTIVATE_RESPONSE → EMERGENCY_RESPONSE', resp.status === 200 && resp.body?.stage === 'EMERGENCY_RESPONSE', resp.body?.stage)
  check('WS 收到阶段广播 demo.stage', await waitFor(() => messages.slice(before).some((m) => m.type === 'demo.stage')))
  const stageMsg = messages.slice(before).find((m) => m.type === 'demo.stage')
  check('广播阶段与接口一致', stageMsg?.stage === 'EMERGENCY_RESPONSE', stageMsg?.stage)
  check('应急响应联动应急照明', (stageMsg?.devices || []).some((d) => d.currentMode === 'emergency'), (stageMsg?.devices || []).slice(0, 2))
  check('应急照明灯光状态切换', stageMsg?.lighting?.mode === 'emergency', stageMsg?.lighting)

  // ── 5. 全链路推进 ──
  console.log('\n[5] 六阶段全链路推进')
  const r3 = await cmd('PLAN_ROUTES')
  check('PLAN_ROUTES → ROUTE_PLANNING', r3.status === 200 && r3.body?.stage === 'ROUTE_PLANNING', r3.body?.stage)
  check('生成多套疏散方案', (r3.body?.plans || []).length >= 2, (r3.body?.plans || []).length)

  // 阶段 3 → 4：必须由 CONFIRM_ROUTE 推进，且必须基于已存在的方案
  const badPlan = await cmd('CONFIRM_ROUTE', { planId: 'PLAN-NOT-EXIST' })
  check('确认不存在的方案返回 409', badPlan.status === 409, badPlan.body)

  const r4 = await cmd('CONFIRM_ROUTE')
  check('CONFIRM_ROUTE → SMART_EVACUATION', r4.status === 200 && r4.body?.stage === 'SMART_EVACUATION', r4.body?.stage)
  check('执行方案被标记', Boolean(r4.body?.activePlanId), r4.body?.activePlanId)
  check('方案进入 EXECUTING（EvacuationPlan 生命周期）', (r4.body?.plans || []).some((p) => p.status === 'EXECUTING'))
  check('人员进入 evacuating', (r4.body?.persons || []).some((p) => p.evacuating))

  // 实时推进：等待 tick 广播
  const beforeTick = messages.length
  check('WS 收到实时疏散 tick 广播', await waitFor(() => messages.slice(beforeTick).some((m) => m.type === 'demo.tick'), 8000))
  const tickMsg = messages.slice(beforeTick).find((m) => m.type === 'demo.tick')
  check('tick 携带人员位置更新', Array.isArray(tickMsg?.persons) && tickMsg.persons.length > 0)
  const moved = await waitFor(() => (messages.filter((m) => m.type === 'demo.tick').slice(-1)[0]?.metrics?.evacuated || 0) > 0, 15000)
  check('疏散推进产生已撤离人数', moved, messages.filter((m) => m.type === 'demo.tick').slice(-1)[0]?.metrics)

  const r5 = await cmd('COMPLETE_EVACUATION')
  check('COMPLETE_EVACUATION → RETAINED_PERSONS', r5.status === 200 && r5.body?.stage === 'RETAINED_PERSONS', r5.body?.stage)
  check('识别出滞留人员', (r5.body?.metrics?.retained || 0) > 0, r5.body?.metrics)
  check('方案置为 DONE', (r5.body?.plans || []).some((p) => p.status === 'DONE'))

  const r6 = await cmd('CONFIRM_RETAINED')
  check('CONFIRM_RETAINED → RESCUE_COORDINATION', r6.status === 200 && r6.body?.stage === 'RESCUE_COORDINATION', r6.body?.stage)
  check('生成救援任务', Boolean(r6.body?.rescue?.task), r6.body?.rescue)

  const r7 = await cmd('COMPLETE_RESCUE')
  check('COMPLETE_RESCUE → COMPLETED', r7.status === 200 && r7.body?.stage === 'COMPLETED', r7.body?.stage)
  check('滞留人员已获救', (r7.body?.metrics?.rescued || 0) > 0, r7.body?.metrics)

  // ── 5.5 路线算法校验（方案必须来自 shared/evacuation 规划器） ──
  console.log('\n[5.5] 疏散路线校验')
  const plans = r4.body?.plans || []
  check('方案命名为 方案A/B/C', plans.map((p) => p.name).join(',') === '方案A,方案B,方案C', plans.map((p) => p.name))
  check('每条方案都有节点序列', plans.every((p) => Array.isArray(p.nodes) && p.nodes.length >= 2))
  check('每条方案都有折线点', plans.every((p) => Array.isArray(p.points) && p.points.length === p.nodes.length))
  check('每条方案都有距离与时间', plans.every((p) => p.distance > 0 && p.estimatedTime > 0), plans.map((p) => [p.distance, p.estimatedTime]))
  check('每条方案都有风险等级', plans.every((p) => ['LOW', 'MEDIUM', 'HIGH'].includes(p.riskLevel)), plans.map((p) => p.riskLevel))
  check('方案终点均为安全出口', plans.every((p) => /EXIT_/.test(p.exitId || '')), plans.map((p) => p.exitId))
  check('方案路线终点落在 1F', plans.every((p) => (p.nodes || []).some((n) => n.startsWith('1F:'))))
  check('方案起点为火源区域', plans.every((p) => (p.startZones || []).includes('A区')), plans.map((p) => p.startZones))
  check('方案不经过火源房间（除起点）', plans.every((p) => p.nodes.slice(1).every((n) => n !== '5F:A_CENTER')))
  check('方案覆盖多个安全出口（真正可选）', new Set(plans.map((p) => p.exitId)).size >= 2, plans.map((p) => p.exitId))
  check('路线跨层下降经过楼梯', plans.every((p) => (p.nodes || []).some((n) => /STAIR_/.test(n))))
  check('人员已绑定路线（沿路线撤离而非直线）', (r4.body?.persons || []).some((p) => Array.isArray(p.routePoints) && p.routePoints.length > 1))

  // ── 5.6 整栋楼疏散校验（scope = BUILDING） ──
  console.log('\n[5.6] 整栋楼疏散方案（scope=BUILDING）')
  const bps = r4.body?.buildingPlans || []
  const activeBpId = r4.body?.activeBuildingPlanId
  check('下发 3 套整栋楼方案', bps.length === 3, bps.map((p) => p.id))
  check('PLAN-A/B/C 策略为 均衡/快速/安全',
    bps.map((p) => p.strategy).join(',') === 'BALANCED,FASTEST,SAFEST', bps.map((p) => p.strategy))
  check('疏散范围 = BUILDING（与火灾位置分离）',
    bps.every((p) => p.scope === 'BUILDING') && r4.body?.evacuationScope === 'BUILDING', r4.body?.evacuationScope)
  check('火灾只描述位置（楼/层/区）',
    Boolean(r4.body?.fire?.buildingId && r4.body?.fire?.floorId && r4.body?.fire?.zone), r4.body?.fire)
  check('buildingId 与火情楼栋一致', bps.every((p) => p.buildingId === r4.body?.fire?.buildingId), bps.map((p) => p.buildingId))
  check('每套方案都通过整栋楼校验', bps.every((p) => p.valid), bps.map((p) => p.reasons))
  // 所有有人员的 floorId+zone 都必须有合法路线
  // 走廊不是房间节点：这类人员按最近房间区域归属（规划器统一处理），房间区域必须全覆盖
  const occupied = new Set(
    (r4.body?.persons || []).filter((p) => p.zone !== '走廊').map((p) => `${p.floorId}:${p.zone}`),
  )
  const activeBp = bps.find((p) => p.id === activeBpId) || bps[0]
  const routeKeys = Object.keys(activeBp?.routesByZone || {})
  const missingZones = [...occupied].filter((k) => !activeBp?.routesByZone?.[k])
  check('整栋楼有人员的区域全部纳入疏散（无遗漏）', missingZones.length === 0, { occupied: occupied.size, routeKeys: routeKeys.length, missingZones: missingZones.slice(0, 5) })
  check('每条路线都合法（valid）', (activeBp?.routes || []).every((r) => r.valid), (activeBp?.routes || []).filter((r) => !r.valid).map((r) => r.routeId))
  check('所有路线终点为 1F 安全出口',
    (activeBp?.routes || []).every((r) => /^1F:EXIT_/.test(r.exitId) && r.nodes[r.nodes.length - 1] === r.exitId),
    (activeBp?.routes || []).slice(0, 3).map((r) => [r.routeId, r.exitId]))
  check('非 1F 路线跨层必经楼梯',
    (activeBp?.routes || []).filter((r) => r.floorId !== '1F').every((r) => r.nodes.some((n) => /STAIR_/.test(n))))
  check('路线不经过火源房间（除该区起点）',
    (activeBp?.routes || []).every((r) => r.nodes.slice(1).every((n) => n !== '5F:A_CENTER')))
  check('方案覆盖多个楼层（不是只疏散火警楼层）',
    new Set((activeBp?.routes || []).map((r) => r.floorId)).size > 1, [...new Set((activeBp?.routes || []).map((r) => r.floorId))])
  check('汇总指标完整（区域/人数/耗时）',
    Boolean(activeBp?.summary?.zoneCount > 0 && activeBp?.summary?.personCount > 0 && activeBp?.summary?.maxEstimatedTime > 0), activeBp?.summary)
  // 人员按各自 floor+zone 拿到路线（后端权威）
  const persons4 = r4.body?.persons || []
  check('整栋楼所有人员都拿到 routePoints',
    persons4.length > 0 && persons4.every((p) => Array.isArray(p.routePoints) && p.routePoints.length > 1),
    persons4.filter((p) => !Array.isArray(p.routePoints) || p.routePoints.length <= 1).slice(0, 3).map((p) => p.id))
  check('人员 routeId 属于当前整栋楼方案',
    persons4.every((p) => !p.routeId || String(p.routeId).startsWith(`${activeBpId}:`)),
    [...new Set(persons4.map((p) => p.routeId))].slice(0, 3))
  check('不同楼层人员路线不同（各自 floorId+zone）',
    new Set(persons4.map((p) => p.routeId)).size > 1, [...new Set(persons4.map((p) => p.routeId))].length)

  // ── 6. D1 业务落库校验（Alarm / EvacuationPlan / OperationLog） ──
  console.log('\n[6] D1 业务数据落库')
  const alarmId = r7.body?.alarmId
  const demoAlarm = alarmId ? (await api(`/api/v1/alarms/${alarmId}`)).body : null
  check('演示火警已落库 alarms', Boolean(demoAlarm?.id), demoAlarm)
  check('处置闭环后告警 resolved', demoAlarm?.status === 'resolved', demoAlarm?.status)
  const plansAfter = await api('/api/v1/evacuation-plans?buildingId=B003')
  check('疏散预案已落库 evacuation_plans', (plansAfter.body || []).length > 0, (plansAfter.body || []).length)
  const logsAfter = await api('/api/v1/operation-logs?module=演示流程&limit=20')
  check('演示操作日志已落库', (logsAfter.body || []).length >= 6, (logsAfter.body || []).length)

  // ── 7. 断线重连 ──
  console.log('\n[7] 断线重连')
  ws.close()
  await sleep(500)
  const reconnected = await openWs()
  check('断线后可重新连接', Boolean(reconnected.ws))
  const gotSnap2 = await waitFor(() => reconnected.messages.some((m) => m.type === 'demo.snapshot'), 6000)
  const snap2 = reconnected.messages.find((m) => m.type === 'demo.snapshot')
  check('重连后立即收到全量快照', gotSnap2, reconnected.messages.map((m) => m.type))
  check('重连快照与当前阶段一致', snap2?.stage === 'COMPLETED', snap2?.stage)

  // 心跳
  reconnected.ws.send(JSON.stringify({ type: 'demo.ping' }))
  check('心跳 PING 收到 PONG', await waitFor(() => reconnected.messages.some((m) => m.type === 'demo.pong'), 4000))

  // ── 8. 复位闭环 ──
  console.log('\n[8] 复位')
  const reset2 = await api(`/api/v1/demo/reset?sessionId=${SESSION}`, { method: 'POST' })
  check('再次 RESET 回到 IDLE', reset2.status === 200 && reset2.body?.stage === 'IDLE', reset2.body?.stage)
  check('RESET 后火情清空', reset2.body?.fire === null, reset2.body?.fire)

  reconnected.ws.close()
  ws.close?.()

  console.log(`\n=== 结果：${passed} 通过 / ${failed} 失败 ===`)
  if (failed) { console.log('失败项：'); failures.forEach((f) => console.log('  - ' + f)); process.exit(1) }
  process.exit(0)
})().catch((err) => {
  console.error('E2E 执行异常：', err)
  process.exit(1)
})

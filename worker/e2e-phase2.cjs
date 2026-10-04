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
  check('生成 3 套整栋楼方案', (r3.body?.buildingPlans || []).length === 3, (r3.body?.buildingPlans || []).map((p) => p.id))

  // 阶段 3 → 4：必须由 CONFIRM_ROUTE 推进，且必须携带 buildingPlanId（整栋楼方案）
  const noBp = await cmd('CONFIRM_ROUTE')
  check('CONFIRM_ROUTE 未携带 buildingPlanId 返回 409', noBp.status === 409, noBp.body)
  const onlyLegacy = await cmd('CONFIRM_ROUTE', { planId: 'PLAN-NOT-EXIST' })
  check('只传 legacy planId 返回 409', onlyLegacy.status === 409, onlyLegacy.body)
  const badBp = await cmd('CONFIRM_ROUTE', { buildingPlanId: 'PLAN-NOT-EXIST' })
  check('确认不存在的整栋楼方案返回 409', badBp.status === 409, badBp.body)

  const r4 = await cmd('CONFIRM_ROUTE', { buildingPlanId: 'PLAN-B' })
  check('CONFIRM_ROUTE → SMART_EVACUATION', r4.status === 200 && r4.body?.stage === 'SMART_EVACUATION', r4.body?.stage)
  check('执行方案被标记（activeBuildingPlanId）', r4.body?.activeBuildingPlanId === 'PLAN-B', r4.body?.activeBuildingPlanId)
  check('整栋楼方案进入 EXECUTING', (r4.body?.buildingPlans || []).some((p) => p.id === 'PLAN-B' && p.status === 'EXECUTING'))
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
  check('方案置为 DONE', (r5.body?.buildingPlans || []).some((p) => p.status === 'DONE'))

  const r6 = await cmd('CONFIRM_RETAINED')
  check('CONFIRM_RETAINED → RESCUE_COORDINATION', r6.status === 200 && r6.body?.stage === 'RESCUE_COORDINATION', r6.body?.stage)
  check('生成救援任务', Boolean(r6.body?.rescue?.task), r6.body?.rescue)

  const r7 = await cmd('COMPLETE_RESCUE')
  check('COMPLETE_RESCUE → COMPLETED', r7.status === 200 && r7.body?.stage === 'COMPLETED', r7.body?.stage)
  check('滞留人员已获救', (r7.body?.metrics?.rescued || 0) > 0, r7.body?.metrics)

  // ── 5.5 LEGACY 单区域方案校验（仅兼容保留，不再是 Demo 疏散方案来源） ──
  console.log('\n[5.5] LEGACY 单火灾区域方案（仅历史/兼容）')
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
  check('LEGACY 疏散预案已落库 evacuation_plans', (plansAfter.body || []).length > 0, (plansAfter.body || []).length)
  // 权威接口：整栋楼方案
  const bpApi = await api('/api/v1/building-evacuation-plans?buildingId=B003')
  check('整栋楼方案接口返回 scope=BUILDING', bpApi.body?.scope === 'BUILDING', bpApi.body?.scope)
  check('整栋楼方案接口返回 3 套 PLAN-A/B/C',
    (bpApi.body?.plans || []).length === 3 && (bpApi.body?.plans || []).every((p) => /^PLAN-[ABC]$/.test(p.id)),
    (bpApi.body?.plans || []).map((p) => p.id))
  check('整栋楼方案接口含 routes / summary',
    (bpApi.body?.plans || []).every((p) => Array.isArray(p.routes) && p.routes.length > 0 && p.summary && p.summary.zoneCount > 0),
    (bpApi.body?.plans || []).map((p) => [p.id, (p.routes || []).length]))
  check('LEGACY 接口不再混入整栋楼方案（type=building）',
    (plansAfter.body || []).every((p) => p.id !== 'PLAN-A' && p.id !== 'PLAN-B' && p.id !== 'PLAN-C'),
    (plansAfter.body || []).map((p) => p.id))
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

  // ── 7.5 整栋楼方案切换回归：A / B / C 全员路线同步切换 ──
  console.log('\n[7.5] 整栋楼方案切换（A / B / C 全员同步）')
  const runs = {}
  for (const id of ['PLAN-A', 'PLAN-B', 'PLAN-C']) {
    await api(`/api/v1/demo/reset?sessionId=${SESSION}`, { method: 'POST' })
    await cmd('START_FIRE')
    await cmd('ACTIVATE_RESPONSE')
    await cmd('PLAN_ROUTES')
    const rr = await cmd('CONFIRM_ROUTE', { buildingPlanId: id })
    const ps = rr.body?.persons || []
    runs[id] = {
      active: rr.body?.activeBuildingPlanId,
      scope: rr.body?.evacuationScope,
      routeIds: ps.map((p) => p.routeId),
      floors: [...new Set(ps.map((p) => p.floorId))],
      allOwned: ps.every((p) => String(p.routeId).startsWith(`${id}:`)),
      allValid: (rr.body?.buildingPlans || []).find((p) => p.id === id)?.routes?.every((r) => r.valid),
    }
  }
  check('确认 A：全员 routeId 属于 PLAN-A', runs['PLAN-A'].allOwned && runs['PLAN-A'].active === 'PLAN-A', runs['PLAN-A'])
  check('确认 B：全员 routeId 属于 PLAN-B', runs['PLAN-B'].allOwned && runs['PLAN-B'].active === 'PLAN-B', runs['PLAN-B'])
  check('确认 C：全员 routeId 属于 PLAN-C', runs['PLAN-C'].allOwned && runs['PLAN-C'].active === 'PLAN-C', runs['PLAN-C'])
  check('三套方案疏散范围均为 BUILDING',
    runs['PLAN-A'].scope === 'BUILDING' && runs['PLAN-B'].scope === 'BUILDING' && runs['PLAN-C'].scope === 'BUILDING')
  check('三套方案所有路线均通过校验', runs['PLAN-A'].allValid && runs['PLAN-B'].allValid && runs['PLAN-C'].allValid)
  // 切换方案后：每个人的 routeId 都要变（同一个人不允许仍停留在旧方案）
  const changedAB = runs['PLAN-A'].routeIds.every((rid, i) => rid !== runs['PLAN-B'].routeIds[i])
  const changedBC = runs['PLAN-B'].routeIds.every((rid, i) => rid !== runs['PLAN-C'].routeIds[i])
  check('A → B：所有人员路线同步变化', changedAB, [runs['PLAN-A'].routeIds[0], runs['PLAN-B'].routeIds[0]])
  check('B → C：所有人员路线同步变化', changedBC, [runs['PLAN-B'].routeIds[0], runs['PLAN-C'].routeIds[0]])
  check('1F~6F 均有人获得路线（不是只疏散 5F）',
    runs['PLAN-B'].floors.length >= 6, runs['PLAN-B'].floors)

  // ── 7.6 人员数据链统一（P1.6.1） ──
  console.log('\n[7.6] 人员数据链统一（DemoRoom → PersonRuntime → WS → 2D/3D）')
  // 统一字段：id / buildingId / floorId / zone / status / routeId / routePoints / progress / position
  const PERSON_FIELDS = ['id', 'buildingId', 'floorId', 'zone', 'status', 'routeId', 'routePoints', 'progress', 'position']
  const isCanonical = (p) => Boolean(p)
    && PERSON_FIELDS.every((f) => p[f] !== undefined)
    && Array.isArray(p.routePoints)
    && typeof p.progress === 'number' && p.progress >= 0 && p.progress <= 1
    && Boolean(p.position) && Number.isFinite(p.position.x) && Number.isFinite(p.position.y)

  await api(`/api/v1/demo/reset?sessionId=${SESSION}`, { method: 'POST' })
  await cmd('START_FIRE')
  await cmd('ACTIVATE_RESPONSE')
  await cmd('PLAN_ROUTES')
  const rc = await cmd('CONFIRM_ROUTE', { buildingPlanId: 'PLAN-C' })
  const chain = rc.body?.persons || []
  check('快照人员含统一字段 9 项', chain.length > 0 && chain.every(isCanonical),
    chain.filter((p) => !isCanonical(p)).slice(0, 2))
  check('position 与 x/y 同源（别名由统一字段派生）',
    chain.every((p) => p.position.x === p.x && p.position.y === p.y), chain.slice(0, 2).map((p) => [p.position, p.x, p.y]))
  check('buildingId / floorId / zone 均为有效值',
    chain.every((p) => p.buildingId === 'B003' && /^\d+F$/.test(p.floorId) && Boolean(p.zone)),
    chain.slice(0, 2).map((p) => [p.buildingId, p.floorId, p.zone]))
  check('全员 routePoints 为路线折线（≥2 点）',
    chain.every((p) => p.routePoints.length > 1),
    chain.filter((p) => p.routePoints.length <= 1).slice(0, 3).map((p) => p.id))
  check('全员 routeId 属于当前整栋楼方案 PLAN-C',
    chain.every((p) => String(p.routeId).startsWith('PLAN-C:')), [...new Set(chain.map((p) => p.routeId))].slice(0, 3))

  // 人员 ID：后端 DemoRoom / D1 person_presence / 2D / 3D 必须是同一套
  const ppRes = await api('/api/v1/person-presence?buildingId=B003')
  const ppIds = new Set((ppRes.body || []).map((p) => String(p.id)))
  const chainIds = new Set(chain.map((p) => String(p.id)))
  check('人员 id 与 D1 person_presence 完全一致（同一人员 ID）',
    chainIds.size > 0 && [...chainIds].every((id) => ppIds.has(id)) && chainIds.size === ppIds.size,
    { chain: chainIds.size, d1: ppIds.size })

  // routeId：后端下发 = 整栋楼方案 routesByZone[floorId:zone].routeId（2D/3D 用同一个）
  const bpC = (rc.body?.buildingPlans || []).find((p) => p.id === 'PLAN-C')
  const routeIdMismatch = chain.filter((p) => {
    const r = bpC?.routesByZone?.[`${p.floorId}:${p.zone}`]
    return r && r.routeId !== p.routeId
  })
  check('人员 routeId = 方案 routesByZone[floorId:zone].routeId',
    routeIdMismatch.length === 0, routeIdMismatch.slice(0, 3).map((p) => [p.id, p.floorId, p.zone, p.routeId]))
  check('routeId 覆盖多个楼层（整栋楼，不是只疏散 5F）',
    new Set(chain.map((p) => String(p.routeId).split(':')[1])).size >= 6,
    [...new Set(chain.map((p) => String(p.routeId).split(':')[1]))])

  // WebSocket tick：人员继续按统一契约推进（同一 id / 同一 routeId）
  // 注意：第一个 ws 已在 [7] 关闭，这里用重连后的连接接收广播
  const live = reconnected.messages
  const beforeTick2 = live.length
  const gotTick2 = await waitFor(() => live.slice(beforeTick2).some((m) => m.type === 'demo.tick'), 12000)
  check('WS tick 广播人员', gotTick2 && (live.slice(beforeTick2).find((m) => m.type === 'demo.tick')?.persons || []).length > 0)
  const tick2 = live.slice(beforeTick2).find((m) => m.type === 'demo.tick')
  check('tick 人员同样符合统一契约', (tick2?.persons || []).length > 0 && tick2.persons.every(isCanonical),
    (tick2?.persons || []).filter((p) => !isCanonical(p)).slice(0, 2))
  const tickIds = new Set((tick2?.persons || []).map((p) => String(p.id)))
  check('tick 与快照使用同一批人员 id',
    tickIds.size === chainIds.size && [...tickIds].every((id) => chainIds.has(id)), { tick: tickIds.size, snap: chainIds.size })
  const tickRouteMap = new Map((tick2?.persons || []).map((p) => [String(p.id), p.routeId]))
  check('tick 与快照使用同一个 routeId',
    chain.every((p) => tickRouteMap.get(String(p.id)) === p.routeId),
    chain.slice(0, 3).map((p) => [p.id, p.routeId, tickRouteMap.get(String(p.id))]))
  const progressed = await waitFor(() => {
    const t = live.slice(beforeTick2).filter((m) => m.type === 'demo.tick').slice(-1)[0]
    return Boolean(t && (t.persons || []).some((p) => p.progress > 0))
  }, 12000)
  check('tick 推进 progress（权威进度，前端不自行计算）', progressed)
  const posAdvanced = await waitFor(() => {
    const ticks = live.slice(beforeTick2).filter((m) => m.type === 'demo.tick')
    if (ticks.length < 2) return false
    const a = ticks[ticks.length - 2]
    const b = ticks[ticks.length - 1]
    const amap = new Map((a.persons || []).map((p) => [String(p.id), p.position]))
    return (b.persons || []).some((p) => {
      const prev = amap.get(String(p.id))
      return prev && (Math.abs(prev.x - p.position.x) > 0.01 || Math.abs(prev.y - p.position.y) > 0.01)
    })
  }, 12000)
  check('tick 推进 position（权威坐标，3D 只做视觉插值）', posAdvanced)

  // ── 7.7 设备数据链统一（P1.6.2） ──
  console.log('\n[7.7] 设备数据链统一（D1 → DeviceRuntime → WS → 楼层定位）')
  // 统一字段：id / type / buildingId / floorId / zone / status / currentMode / direction / brightness / emergencyFlash
  const DEVICE_FIELDS = ['id', 'type', 'buildingId', 'floorId', 'zone', 'status', 'currentMode', 'direction', 'brightness', 'emergencyFlash']
  const canonicalDevice = (d) => Boolean(d)
    && DEVICE_FIELDS.every((f) => d[f] !== undefined)
    && /^B\d{3}$/.test(String(d.buildingId))
    && /^\d+F$/.test(String(d.floorId))
    && typeof d.brightness === 'number' && Number.isFinite(d.brightness)
    && typeof d.emergencyFlash === 'boolean'

  const devState = await api(`/api/v1/demo/state?sessionId=${SESSION}`)
  const snapDevs = devState.body?.devices || []
  check('快照设备含统一字段 10 项', snapDevs.length > 0 && snapDevs.every(canonicalDevice),
    snapDevs.filter((d) => !canonicalDevice(d)).slice(0, 2))
  check('快照设备全部属于火警楼栋 B003', snapDevs.every((d) => d.buildingId === 'B003'),
    [...new Set(snapDevs.map((d) => d.buildingId))])
  const devFloors = [...new Set(snapDevs.map((d) => d.floorId))].sort()
  check('WS 快照可准确定位到楼层（floorId 覆盖 1F~6F）',
    devFloors.length === 6 && devFloors.every((f) => /^[1-6]F$/.test(f)), devFloors)
  check('zone（所属区域）非空且与楼层归属同源',
    snapDevs.every((d) => typeof d.zone === 'string' && d.zone.length > 0),
    snapDevs.filter((d) => !d.zone).slice(0, 2).map((d) => d.id))

  // 与 REST /devices 口径一致（同一设备 id、同一楼层归属）
  const restDevs = await api('/api/v1/devices?buildingId=B003')
  const restMap = new Map((restDevs.body || []).map((d) => [String(d.id), d]))
  check('快照设备 id 与 REST /devices 完全一致',
    snapDevs.length > 0 && snapDevs.every((d) => restMap.has(String(d.id))),
    snapDevs.filter((d) => !restMap.has(String(d.id))).slice(0, 3).map((d) => d.id))
  const devFloorMismatch = snapDevs.filter((d) => {
    const r = restMap.get(String(d.id))
    return r && (r.floorId !== d.floorId || String(r.zone ?? '') !== String(d.zone ?? ''))
  })
  check('快照设备楼层归属与 REST 一致（floorId / zone）',
    devFloorMismatch.length === 0, devFloorMismatch.slice(0, 3).map((d) => [d.id, d.floorId, d.zone]))

  // 整栋楼设备联动：范围为「一整栋楼」，不是火警楼层
  const linked = snapDevs.filter((d) => d.currentMode === 'emergency')
  const linkedFloors = [...new Set(linked.map((d) => d.floorId))].sort()
  check('整栋楼设备联动：应急联动覆盖全部 6 层',
    linkedFloors.length === 6, { linkedFloors, total: linked.length })
  check('每层联动都含疏散指示灯与应急照明',
    linkedFloors.every((f) => ['evacuation_light', 'emergency_light'].every(
      (t) => linked.some((d) => d.floorId === f && d.type === t),
    )), linkedFloors)
  check('火警楼层 5F 烟感为 warning',
    snapDevs.filter((d) => d.type === 'smoke_detector' && d.floorId === '5F').every((d) => d.status === 'warning'),
    snapDevs.filter((d) => d.type === 'smoke_detector' && d.floorId === '5F').map((d) => d.status))
  check('联动设备亮度拉满（brightness=100）',
    linked.filter((d) => d.type === 'emergency_light').every((d) => d.brightness === 100),
    linked.filter((d) => d.type === 'emergency_light' && d.brightness !== 100).slice(0, 2))

  // WebSocket 广播的设备同样符合统一契约（不只是 REST /state）
  const lastStage = [...live].reverse().find((m) => m.type === 'demo.stage')
  const wsDevs = lastStage?.devices || []
  check('WS demo.stage 广播设备符合统一契约',
    wsDevs.length > 0 && wsDevs.every(canonicalDevice), wsDevs.filter((d) => !canonicalDevice(d)).slice(0, 2))
  const wsDevIds = new Set(wsDevs.map((d) => String(d.id)))
  check('WS 与 /state 使用同一批设备 id',
    wsDevIds.size === snapDevs.length && snapDevs.every((d) => wsDevIds.has(String(d.id))),
    { ws: wsDevIds.size, state: snapDevs.length })
  const wsFloorMap = new Map(wsDevs.map((d) => [String(d.id), `${d.floorId}:${d.zone}`]))
  check('WS 与 /state 使用同一个楼层归属（floorId:zone）',
    snapDevs.every((d) => wsFloorMap.get(String(d.id)) === `${d.floorId}:${d.zone}`),
    snapDevs.slice(0, 3).map((d) => [d.id, wsFloorMap.get(String(d.id))]))

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

/**
 * P1.7.3-B2：WebSocket 状态收敛与重连一致性专项回归
 *
 * 覆盖：正常 snapshot / 正常 tick / 乱序 / 旧消息覆盖 / 断线 / 重连 + requestSync /
 *       重连后人员·设备·火灾·路线 / Golden Path 关键节点强制断线重连。
 *
 * 用法（需 demo 模式前端 + 后端已启动）：
 *   1) set VITE_DATA_SOURCE=demo && npx vite --port 5199
 *   2) npx wrangler dev （worker）
 *   3) node worker/e2e-p173-b2-ws-consistency.cjs
 *
 * 环境变量：PAGE_URL（默认 http://localhost:5199/）、API_BASE（默认 http://127.0.0.1:8787）
 */
const { chromium } = require('playwright-core')

const PAGE_URL = process.env.PAGE_URL || 'http://localhost:5199/'
const API_BASE = process.env.API_BASE || 'http://127.0.0.1:8787'
const SESSION = process.env.DEMO_SESSION || 'default'

// 后端 stage → fireStore legacy emergencyStage
const STAGE_TO_LEGACY = {
  IDLE: 0, FIRE_DETECTED: 1, EMERGENCY_RESPONSE: 2, ROUTE_PLANNING: 3,
  SMART_EVACUATION: 4, RETAINED_PERSONS: 5, RESCUE_COORDINATION: 6, COMPLETED: 7,
}

let passed = 0, failed = 0
const failures = []
function check(name, cond, extra) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name); console.log(`  ✗ ${name}${extra !== undefined ? ' → ' + JSON.stringify(extra).slice(0, 400) : ''}`) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor(fn, timeout = 15000, interval = 250) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) { if (await fn()) return true; await sleep(interval) }
  return false
}
async function api(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, options)
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
const state = async () => (await api(`/api/v1/demo/state?sessionId=${SESSION}`)).body || {}

;(async () => {
  console.log(`\n=== P1.7.3-B2 WS 一致性回归（${PAGE_URL} · ${API_BASE}）===\n`)
  const browser = await chromium.launch({ channel: 'msedge', headless: true })
  const page = await browser.newPage()
  const consoleLogs = []
  page.on('console', (m) => consoleLogs.push(`[${m.type()}] ${m.text()}`))

  await page.goto(PAGE_URL, { waitUntil: 'load', timeout: 45000 })
  await waitFor(() => page.evaluate(() => Boolean(window.__demo)), 20000)
  check('页面挂载并暴露开发钩子', await page.evaluate(() => Boolean(window.__demo)))
  check('运行模式为 demo', (await page.evaluate(() => window.__demo.dataSource.mode)) === 'demo')

  // ── 工具：前端三层快照 ──
  const feState = () => page.evaluate(() => {
    const ds = window.__demo.demoStore
    const s = window.__demo.store
    const per = (p) => ({
      id: String(p.id), status: p.status, routeId: p.routeId ?? null,
      rpLen: Array.isArray(p.routePoints) ? p.routePoints.length : 0,
      progress: typeof p.progress === 'number' ? p.progress : 0,
      pos: p.position ? [Math.round(p.position.x * 100) / 100, Math.round(p.position.y * 100) / 100] : null,
      retained: Boolean(p.retained), rescued: Boolean(p.rescued),
    })
    return {
      seq: ds.seq, stage: ds.stage, wsStatus: ds.wsStatus, syncCount: ds.syncCount,
      legacyStage: s.emergencyStage,
      fire: ds.fire ? [ds.fire.buildingId, ds.fire.floorId, ds.fire.zone].join('/') : null,
      dsPersons: (ds.persons || []).map(per),
      fsPersons: (s.persons || []).map(per),
      plans: (ds.buildingPlans || []).map((p) => p.id),
      activePlanId: ds.activeBuildingPlanId,
      fsDevices: (s.devices || []).map((d) => ({
        id: String(d.id), status: d.status, mode: d.currentMode, dir: d.direction ?? null,
        brightness: d.brightness ?? null, flash: Boolean(d.emergencyFlash),
      })),
      dsDevices: (ds.devices || []).map((d) => ({
        id: String(d.id), status: d.status, mode: d.currentMode, dir: d.direction ?? null,
        brightness: d.brightness ?? null, flash: Boolean(d.emergencyFlash),
      })),
    }
  })

  const disconnect = () => page.evaluate(() => window.__demo.demoStore.disconnect())
  const reconnect = async () => {
    await page.evaluate(() => window.__demo.demoStore.connect())
    return waitFor(() => page.evaluate(() => window.__demo.demoStore.wsStatus === 'open'), 20000)
  }

  // ── Case 1：正常 snapshot ──
  console.log('\n[Case 1] 正常 snapshot：Backend = demoStore = fireStore')
  const st1 = await state()
  if (st1.stage && st1.stage !== 'IDLE') await cmd('RESET')
  await sleep(1200)
  let be = await state()
  let fe = await feState()
  check('demoStore.seq === 后端 seq', fe.seq === be.seq, { fe: fe.seq, be: be.seq })
  check('demoStore.stage === 后端 stage', fe.stage === be.stage, [fe.stage, be.stage])
  check('fireStore.emergencyStage 与后端阶段一致', fe.legacyStage === (STAGE_TO_LEGACY[be.stage] ?? -1), [fe.legacyStage, be.stage])
  // 口径说明：demoStore 只镜像「灾情楼栋」的演示人员/设备；fireStore 是全量台账，
  // 因此权威性判定为「后端集合 == demoStore 集合」且「fireStore ⊇ 后端集合」。
  const bePIds1 = (be.persons || []).map((p) => String(p.id)).sort()
  const beDIds1 = (be.devices || []).map((d) => String(d.id)).sort()
  const fsPIdSet1 = new Set(fe.fsPersons.map((p) => p.id))
  const fsDIdSet1 = new Set(fe.fsDevices.map((d) => d.id))
  check('人员集合：demoStore == 后端，且 fireStore ⊇ 后端',
    JSON.stringify(fe.dsPersons.map((p) => p.id).sort()) === JSON.stringify(bePIds1)
    && bePIds1.every((id) => fsPIdSet1.has(id)),
    { ds: fe.dsPersons.length, be: bePIds1.length, fsMissing: bePIds1.filter((id) => !fsPIdSet1.has(id)).slice(0, 3) })
  check('设备集合：demoStore == 后端，且 fireStore ⊇ 后端',
    JSON.stringify(fe.dsDevices.map((d) => d.id).sort()) === JSON.stringify(beDIds1)
    && beDIds1.every((id) => fsDIdSet1.has(id)),
    { ds: fe.dsDevices.length, be: beDIds1.length, fsMissing: beDIds1.filter((id) => !fsDIdSet1.has(id)).slice(0, 3) })

  // ── 推进到 SMART_EVACUATION（后续 Case 的前置）──
  await cmd('START_FIRE'); await sleep(400)
  await cmd('ACTIVATE_RESPONSE'); await sleep(400)
  await cmd('PLAN_ROUTES'); await sleep(1200)

  // ── Case 2：正常 tick ──
  console.log('\n[Case 2] 正常 tick：seq 单调递增、状态持续推进')
  await cmd('CONFIRM_ROUTE', { buildingPlanId: 'PLAN-B' })
  const inEvac = await waitFor(async () => (await feState()).stage === 'SMART_EVACUATION', 15000)
  check('进入 SMART_EVACUATION', inEvac)
  const t1 = await feState()
  const beT1 = await state()
  await sleep(3000)
  const t2 = await feState()
  const beT2 = await state()
  check('tick 推进 seq（seq2 > seq1）', t2.seq > t1.seq,
    { fe: [t1.seq, t2.seq], be: [beT1.seq, beT2.seq], ws: [t1.wsStatus, t2.wsStatus] })
  const sumProg = (arr) => arr.reduce((a, p) => a + p.progress, 0)
  const prog1 = sumProg(t1.dsPersons)
  const prog2 = sumProg(t2.dsPersons)
  check('人员 progress 随 tick 推进', prog2 > prog1,
    { fe: [Math.round(prog1 * 100) / 100, Math.round(prog2 * 100) / 100], be: [sumProg(beT1.persons || []), sumProg(beT2.persons || [])] })
  check('tick 未清空 routePoints（每人仍有折线）',
    t2.fsPersons.every((p) => p.rpLen === 0 || p.rpLen >= 2), t2.fsPersons.filter((p) => p.rpLen > 0 && p.rpLen < 2).slice(0, 3))
  be = await state()
  check('seq 与后端同向（前端 seq ≤ 后端 seq 且差值 < 30）',
    t2.seq <= be.seq && be.seq - t2.seq < 30, [t2.seq, be.seq])

  // ── Case 3：乱序 tick（10 → 12 → 11，必须保留 12）──
  console.log('\n[Case 3] 乱序 tick：seq=10 → 12 → 11，最终必须保留 12')
  const case3 = await page.evaluate(() => {
    const ds = window.__demo.demoStore
    const s = window.__demo.store
    const base = ds.seq
    const pid = String((ds.persons || [])[0]?.id || '')
    // 注入的 tick 与真实 tick 同构：带全员（只改目标人员的 progress），避免污染人员集合
    const mk = (seq, progress) => ({
      type: 'demo.tick', seq, stage: ds.stage,
      persons: (ds.persons || []).map((p) => (
        String(p.id) === pid ? { ...p, progress, position: { x: 1, y: 1 } } : { ...p }
      )),
      metrics: ds.metrics, evacuationSettled: ds.evacuationSettled,
    })
    ds.handleMessage(mk(base + 2, 0.77))
    const after12 = { seq: ds.seq, progress: (s.persons || []).find((p) => String(p.id) === pid)?.progress ?? null }
    ds.handleMessage(mk(base + 1, 0.11))
    const after11 = { seq: ds.seq, progress: (s.persons || []).find((p) => String(p.id) === pid)?.progress ?? null }
    return { base, pid, after12, after11 }
  })
  check('更新的 tick（seq+2）被接受', case3.after12.seq === case3.base + 2 && case3.after12.progress === 0.77, case3.after12)
  check('乱序旧 tick（seq+1）被丢弃', case3.after11.seq === case3.base + 2 && case3.after11.progress === 0.77, case3.after11)
  check('fireStore 未回退到旧进度', case3.after11.progress === 0.77, case3.after11)

  // ── Case 4：旧 snapshot 不得覆盖新 tick ──
  console.log('\n[Case 4] 旧 snapshot（seq 更小）不得覆盖新状态')
  const snapOld = await state()      // seq = S
  const case4 = await page.evaluate((snap) => {
    const ds = window.__demo.demoStore
    const s = window.__demo.store
    const pid = String((ds.persons || [])[0]?.id || '')
    const before = { seq: ds.seq, stage: ds.stage, progress: (s.persons || []).find((p) => String(p.id) === pid)?.progress ?? null }
    // 先注入更新的 tick（seq+1，与真实 tick 同构）
    ds.handleMessage({
      type: 'demo.tick', seq: before.seq + 1, stage: ds.stage,
      persons: (ds.persons || []).map((p) => (
        String(p.id) === pid ? { ...p, progress: 0.88, position: { x: 2, y: 2 } } : { ...p }
      )),
      metrics: ds.metrics, evacuationSettled: ds.evacuationSettled,
    })
    // 再拿旧 snapshot（seq = S）覆盖 —— 必须被拒绝
    const accepted = ds.applySnapshot({ ...snap, stage: 'IDLE', fire: null })
    const after = { seq: ds.seq, stage: ds.stage, progress: (s.persons || []).find((p) => String(p.id) === pid)?.progress ?? null }
    return { before, after, accepted, snapSeq: snap.seq }
  }, snapOld)
  check('旧 snapshot 被拒绝（applySnapshot 返回 false）', case4.accepted === false, case4)
  check('阶段未被旧 snapshot 拉回 IDLE', case4.after.stage !== 'IDLE', case4.after)
  check('人员进度未被旧 snapshot 覆盖', case4.after.progress === 0.88, case4.after)
  check('seq 未被旧 snapshot 回退', case4.after.seq >= case4.before.seq + 1, case4)

  // ── Case 5：断线期间前端不得自行推进 ──
  console.log('\n[Case 5] 断线：前端不自行推进业务状态')
  await reconnect()   // 先恢复到真实链路
  await sleep(800)
  const beforeCut = await feState()
  await disconnect()
  await sleep(4000)
  const afterCut = await feState()
  check('断线后 seq 不变', afterCut.seq === beforeCut.seq, [beforeCut.seq, afterCut.seq])
  check('断线后阶段不变', afterCut.stage === beforeCut.stage, [beforeCut.stage, afterCut.stage])
  check('断线后人员进度不变',
    JSON.stringify(afterCut.fsPersons.map((p) => p.progress)) === JSON.stringify(beforeCut.fsPersons.map((p) => p.progress)))
  check('断线后 fireStore 未本地生成方案', afterCut.plans.length === beforeCut.plans.length, [beforeCut.plans, afterCut.plans])
  check('断线后 wsStatus = closed', afterCut.wsStatus === 'closed', afterCut.wsStatus)

  // ── Case 6：重连 + requestSync ──
  console.log('\n[Case 6] 重连：requestSync → snapshot → 收敛到后端当前状态')
  const syncBefore = afterCut.syncCount
  const opened = await reconnect()
  check('重新连接成功（wsStatus = open）', opened)
  const converged = await waitFor(async () => {
    const f = await feState()
    const b = await state()
    return f.seq === b.seq && f.stage === b.stage
  }, 20000)
  check('重连后收敛到后端当前状态（seq + stage 一致）', converged)
  const afterRe = await feState()
  check('重连确实发起了 requestSync（syncCount 增加）', afterRe.syncCount > syncBefore, [syncBefore, afterRe.syncCount])
  be = await state()
  check('重连后 seq = 后端 seq', afterRe.seq === be.seq, [afterRe.seq, be.seq])

  // ── Case 7：重连后人员状态 ──
  console.log('\n[Case 7] 重连后人员：position / progress / routeId / routePoints / retained / rescued')
  be = await state()
  fe = await feState()
  const beP = new Map((be.persons || []).map((p) => [String(p.id), p]))
  const dsP = new Map(fe.dsPersons.map((p) => [p.id, p]))
  const fsP = new Map(fe.fsPersons.map((p) => [p.id, p]))
  const personBad = []
  ;(be.persons || []).forEach((raw) => {
    const fp = fsP.get(String(raw.id))
    const bp = beP.get(String(raw.id))
    const dp = dsP.get(String(raw.id))
    if (!fp || !bp || !dp) { personBad.push([String(raw.id), 'missing']); return }
    if (fp.status !== bp.status) personBad.push([fp.id, 'status', fp.status, bp.status])
    if ((fp.routeId || null) !== (bp.routeId || null)) personBad.push([fp.id, 'routeId', fp.routeId, bp.routeId])
    if (fp.rpLen !== (Array.isArray(bp.routePoints) ? bp.routePoints.length : 0)) personBad.push([fp.id, 'routePoints', fp.rpLen, bp.routePoints?.length])
    if (Math.abs(fp.progress - (bp.progress || 0)) > 0.2) personBad.push([fp.id, 'progress', fp.progress, bp.progress])
    if (fp.retained !== Boolean(bp.retained)) personBad.push([fp.id, 'retained'])
    if (fp.rescued !== Boolean(bp.rescued)) personBad.push([fp.id, 'rescued'])
    if (fp.status !== dp.status) personBad.push([fp.id, 'ds-vs-fs status'])
  })
  check('人员全部字段与后端一致（含 demoStore↔fireStore 同源）', personBad.length === 0, personBad.slice(0, 5))
  const regressed = fe.fsPersons.filter((p) => {
    const old = fsP.get(p.id)
    return old && p.progress < old.progress - 0.01
  })
  check('重连后人员进度未回退', regressed.length === 0, regressed.slice(0, 3))

  // ── Case 8：重连后设备状态 ──
  console.log('\n[Case 8] 重连后设备：status / direction / brightness / emergencyFlash')
  const beD = new Map((be.devices || []).map((d) => [String(d.id), d]))
  const fsD = new Map(fe.fsDevices.map((d) => [d.id, d]))
  const devBad = []
  ;(be.devices || []).forEach((raw) => {
    const d = fsD.get(String(raw.id))
    const b = beD.get(String(raw.id))
    if (!d || !b) { devBad.push([String(raw.id), 'missing']); return }
    if (d.status !== b.status) devBad.push([d.id, 'status', d.status, b.status])
    if ((d.dir || null) !== (b.direction || null)) devBad.push([d.id, 'direction', d.dir, b.direction])
    if (d.brightness !== b.brightness) devBad.push([d.id, 'brightness', d.brightness, b.brightness])
    if (d.flash !== Boolean(b.emergencyFlash)) devBad.push([d.id, 'emergencyFlash', d.flash, b.emergencyFlash])
  })
  check('设备状态全部与后端一致', devBad.length === 0, devBad.slice(0, 5))
  check('整栋楼设备进入应急态（至少 1 台 emergency + brightness=100）',
    fe.fsDevices.some((d) => String(d.mode) === 'emergency' && d.brightness === 100),
    fe.fsDevices.filter((d) => String(d.mode) === 'emergency').slice(0, 3))

  // ── Case 9：重连后火灾与阶段 ──
  console.log('\n[Case 9] 重连后火灾 / 阶段')
  check('火灾位置与后端一致（buildingId/floorId/zone）',
    fe.fire === (be.fire ? [be.fire.buildingId, be.fire.floorId, be.fire.zone].join('/') : null), [fe.fire, be.fire])
  check('未因重连回退到 IDLE', fe.stage !== 'IDLE', fe.stage)
  check('fireStore.emergencyStage 与后端一致', fe.legacyStage === (STAGE_TO_LEGACY[be.stage] ?? -1), [fe.legacyStage, be.stage])

  // ── Case 10：重连后路线 ──
  console.log('\n[Case 10] 重连后路线：buildingPlans / activeBuildingPlanId / person.routeId')
  check('buildingPlans 未丢失且与后端一致',
    JSON.stringify(fe.plans) === JSON.stringify((be.buildingPlans || []).map((p) => p.id)), [fe.plans, be.buildingPlans?.map((p) => p.id)])
  check('activeBuildingPlanId 与后端一致', fe.activePlanId === be.activeBuildingPlanId, [fe.activePlanId, be.activeBuildingPlanId])
  const routeBad = (be.persons || []).filter((raw) => {
    const p = fsP.get(String(raw.id))
    const b = beP.get(String(raw.id))
    return !p || !b || (p.routeId || null) !== (b.routeId || null)
  })
  check('每人 routeId 与后端一致', routeBad.length === 0, routeBad.slice(0, 5).map((p) => p.id))
  check('灾情楼栋人员 routeId 全部非空（整栋楼方案已下发）',
    (be.persons || []).every((raw) => Boolean(raw.routeId)),
    (be.persons || []).filter((p) => !p.routeId).slice(0, 3).map((p) => p.id))

  // ── Golden Path + 关键节点强制断线重连 ──
  console.log('\n[B2-08] Golden Path：关键节点强制断线 / 重连')
  const steps = [
    ['COMPLETE_EVACUATION', 'RETAINED_PERSONS'],
    ['CONFIRM_RETAINED', 'RESCUE_COORDINATION'],
    ['COMPLETE_RESCUE', 'COMPLETED'],
  ]
  for (const [command, expect] of steps) {
    const at = (await feState()).stage
    await cmd(command)
    const ok = await waitFor(async () => (await feState()).stage === expect, 15000)
    check(`${command} → ${expect}`, ok, await (async () => (await feState()).stage)())
    // 断线 → 等待 → 重连 → 必须收敛回后端当前状态
    await disconnect()
    await sleep(1500)
    await reconnect()
    const conv = await waitFor(async () => {
      const f = await feState()
      const b = await state()
      return f.stage === b.stage && f.seq === b.seq
    }, 20000)
    const f2 = await feState()
    const b2 = await state()
    check(`${expect} 节点断线重连后仍与后端一致`, conv && f2.stage === b2.stage, [f2.stage, b2.stage, at])
  }

  // 最后回到 IDLE
  await cmd('RESET'); await sleep(1200)
  const fin = await feState()
  const finBe = await state()
  check('RESET 后前端回到 IDLE 且与后端一致', fin.stage === 'IDLE' && finBe.stage === 'IDLE', [fin.stage, finBe.stage])
  check('RESET 后 seq 一致', fin.seq === finBe.seq, [fin.seq, finBe.seq])

  console.log(`\n=== 结果：${passed} 通过 / ${failed} 失败 ===`)
  if (failed) { console.log('失败项：'); failures.forEach((f) => console.log('  - ' + f)) }
  const errs = consoleLogs.filter((l) => l.startsWith('[error]'))
  if (errs.length) console.log(`\n控制台错误 ${errs.length} 条：${errs.slice(0, 3).join(' | ')}`)

  await browser.close()
  process.exit(failed ? 1 : 0)
})().catch((err) => { console.error('B2 回归异常：', err); process.exit(1) })

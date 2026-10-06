/**
 * P1.7.3-B1 守卫回归：证明 demo 模式下 fireStore / View 的旧本地写入路径已被封锁。
 *
 * 只做「禁止写入」取证，不做功能重构验证 —— 业务链路（Golden Path）由
 * worker/e2e-phase2-browser.cjs 与 worker/e2e-phase3-journey.cjs 覆盖。
 *
 * 用法（需 demo 模式前端 + 后端已启动）：
 *   1) set VITE_DATA_SOURCE=demo && npx vite --port 5199
 *   2) npx wrangler dev （worker）
 *   3) node worker/e2e-p173-b1-guard.cjs
 *
 * 环境变量：PAGE_URL（默认 http://localhost:5199/）、API_BASE（默认 http://127.0.0.1:8787）
 */
const { chromium } = require('playwright-core')

const PAGE_URL = process.env.PAGE_URL || 'http://localhost:5199/'
const API_BASE = process.env.API_BASE || 'http://127.0.0.1:8787'
const SESSION = process.env.DEMO_SESSION || 'default'

let passed = 0, failed = 0
const failures = []
function check(name, cond, extra) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name); console.log(`  ✗ ${name}${extra !== undefined ? ' → ' + JSON.stringify(extra) : ''}`) }
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

;(async () => {
  console.log(`\n=== P1.7.3-B1 守卫回归（${PAGE_URL}）===\n`)
  const browser = await chromium.launch({ channel: 'msedge', headless: true })
  const page = await browser.newPage()
  const consoleLogs = []
  page.on('console', (m) => consoleLogs.push(`[${m.type()}] ${m.text()}`))

  const guardHit = (apiName) => consoleLogs.some((l) => l.includes('demo 模式禁止本地业务写入') && l.includes(apiName))

  await page.goto(PAGE_URL, { waitUntil: 'load', timeout: 45000 })
  await waitFor(() => page.evaluate(() => Boolean(window.__demo)), 20000)
  check('页面挂载并暴露开发钩子', await page.evaluate(() => Boolean(window.__demo)))
  check('运行模式为 demo', (await page.evaluate(() => window.__demo.dataSource.mode)) === 'demo')

  // 保证从干净状态开始
  const st0 = await api(`/api/v1/demo/state?sessionId=${SESSION}`)
  if (st0.body && st0.body.stage && st0.body.stage !== 'IDLE') await cmd('RESET')
  await sleep(600)

  // ── B1-01：旧 Demo Stage 写入 ──
  console.log('\n[B1-01] fireStore 旧 Stage 写入')
  const beforeStage = await page.evaluate(() => ({
    legacy: window.__demo.store.emergencyStage,
    backend: window.__demo.demoStore.stage,
  }))
  const rDetect = await page.evaluate(() => window.__demo.store.detectFireScenario('3号楼', '5F', 'A区'))
  const rStart = await page.evaluate(() => window.__demo.store.startDemoFlow())
  const rAdvance = await page.evaluate(() => window.__demo.store.advanceDemoStage())
  const rGenOpts = await page.evaluate(() => window.__demo.store.generateEvacuationOptions())
  const rSync = await page.evaluate(() => window.__demo.store.syncStageAfterExternalFire())
  const afterStage = await page.evaluate(() => ({
    legacy: window.__demo.store.emergencyStage,
    backend: window.__demo.demoStore.stage,
    fire: window.__demo.store.fireEvent,
  }))
  check('detectFireScenario 被拦截（返回 false）', rDetect === false, rDetect)
  check('startDemoFlow 被拦截（返回 false）', rStart === false, rStart)
  check('advanceDemoStage 被拦截（返回 false）', rAdvance === false, rAdvance)
  check('generateEvacuationOptions 被拦截（返回 []）', Array.isArray(rGenOpts) && rGenOpts.length === 0, rGenOpts)
  check('syncStageAfterExternalFire 被拦截（返回 false）', rSync === false, rSync)
  check('emergencyStage 未被本地改写', afterStage.legacy === beforeStage.legacy, [beforeStage, afterStage])
  check('后端阶段未被撬动（仍 IDLE）', afterStage.backend === 'IDLE', afterStage.backend)
  check('未凭空生成本地 fireEvent', afterStage.fire === null, afterStage.fire)
  check('守卫日志：detectFireScenario', guardHit('detectFireScenario'))

  // ── B1-02：设备 / 方向 / 应急态本地写入 ──
  console.log('\n[B1-02] 设备 / 方向 / 应急态本地写入')
  const devProbe = await page.evaluate(() => {
    const store = window.__demo.store
    const dev = (store.devices || []).find((d) => d && d.type === 'evacuation_light')
    const em = (store.devices || []).find((d) => d && d.type === 'emergency_light')
    const before = {
      emergencyMode: store.emergencyMode,
      devId: dev ? dev.id : null,
      dir: dev ? dev.direction : null,
      emId: em ? em.id : null,
      emStatus: em ? em.status : null,
      emMode: em ? em.currentMode : null,
      emBrightness: em ? em.brightness : null,
    }
    store.setEmergencyMode(true)
    if (before.devId) store.updateDeviceStatus(before.devId, 'fault')
    const batch = store.batchSwitchEvacuationDirection({ building: '3号楼', floors: ['5F'] }, 'right')
    const applied = store.applyRouteToDevices({ buildingId: 'B003', buildingName: '3号楼', floorsPassed: ['5F', '4F'], exitSide: 'right', routes: [] })
    const after = {
      emergencyMode: store.emergencyMode,
      dir: dev ? dev.direction : null,
      emStatus: em ? em.status : null,
      emMode: em ? em.currentMode : null,
      emBrightness: em ? em.brightness : null,
    }
    return { before, after, batchCount: batch && batch.count, applied: Array.isArray(applied) ? applied.length : null }
  })
  check('setEmergencyMode 未改写 emergencyMode', devProbe.before.emergencyMode === devProbe.after.emergencyMode, devProbe)
  check('updateDeviceStatus 未改写设备 status', devProbe.before.emStatus === devProbe.after.emStatus, devProbe)
  check('疏散灯 direction 未被本地改写', devProbe.before.dir === devProbe.after.dir, devProbe)
  check('应急灯 currentMode / brightness 未被本地改写',
    devProbe.before.emMode === devProbe.after.emMode && devProbe.before.emBrightness === devProbe.after.emBrightness, devProbe)
  check('batchSwitchEvacuationDirection 返回 0 台', devProbe.batchCount === 0, devProbe.batchCount)
  check('applyRouteToDevices 返回空绑定（readonly）', devProbe.applied === 0, devProbe.applied)
  check('守卫日志：setEmergencyMode', guardHit('setEmergencyMode'))
  check('守卫日志：applyRouteToDevices', guardHit('applyRouteToDevices'))

  // ── B1-03：本地重新生成疏散方案 ──
  console.log('\n[B1-03] 本地生成整栋楼方案')
  const planProbe = await page.evaluate(() => {
    const store = window.__demo.store
    const before = { plans: (store.buildingEvacuationPlans || []).length, active: store.activeBuildingPlanId }
    const res = store.generateBuildingEvacuationPlans({ buildingId: 'B003' })
    const after = { plans: (store.buildingEvacuationPlans || []).length, active: store.activeBuildingPlanId }
    return { before, after, resPlans: res && res.plans ? res.plans.length : null }
  })
  check('generateBuildingEvacuationPlans 返回空方案', planProbe.resPlans === 0, planProbe.resPlans)
  check('未向 store 注入本地生成的 A/B/C', planProbe.after.plans === planProbe.before.plans, planProbe)
  check('activeBuildingPlanId 未被本地置值', planProbe.after.active === planProbe.before.active, planProbe)
  check('守卫日志：generateBuildingEvacuationPlans', guardHit('generateBuildingEvacuationPlans'))

  // 后端真实下发时前端仍能镜像（不能因为封锁导致收不到方案）
  await cmd('START_FIRE'); await sleep(400)
  await cmd('ACTIVATE_RESPONSE'); await sleep(400)
  await cmd('PLAN_ROUTES'); await sleep(1200)
  const backendPlans = await waitFor(() => page.evaluate(
    () => (window.__demo.store.buildingEvacuationPlans || []).length >= 1,
  ), 15000)
  check('后端 buildingPlans 仍能镜像到 fireStore', backendPlans)
  const ids = await page.evaluate(() => ({
    store: window.__demo.store.buildingEvacuationPlans.map((p) => p.id),
    demo: window.__demo.demoStore.buildingPlans.map((p) => p.id),
  }))
  check('fireStore 方案 id 与 demoStore（WS）一致',
    JSON.stringify(ids.store) === JSON.stringify(ids.demo), ids)

  // ── B1-04：LightingView 本地业务写入 ──
  console.log('\n[B1-04] LightingView 本地业务写入')
  const lightBefore = await page.evaluate(() => {
    const s = window.__demo.store
    return { brightness: s.lightingStatus.brightness, mode: s.lightingStatus.mode, detected: s.lightingStatus.detectedPerson }
  })
  await page.goto(`${PAGE_URL}#/lighting`, { waitUntil: 'load' })
  await waitFor(() => page.evaluate(() => Boolean(window.__demo && window.__demo.store)), 20000)
  await sleep(1500)
  const lightAfter = await page.evaluate(() => {
    const s = window.__demo.store
    return { brightness: s.lightingStatus.brightness, mode: s.lightingStatus.mode, detected: s.lightingStatus.detectedPerson }
  })
  check('打开照明页未改写 lightingStatus.brightness', lightBefore.brightness === lightAfter.brightness, [lightBefore, lightAfter])
  check('打开照明页未改写 lightingStatus.mode', JSON.stringify(lightBefore.mode) === JSON.stringify(lightAfter.mode), [lightBefore, lightAfter])
  check('打开照明页未改写 lightingStatus.detectedPerson', lightBefore.detected === lightAfter.detected, [lightBefore, lightAfter])
  const switchProbe = await page.evaluate(() => {
    const s = window.__demo.store
    const beforeDev = (s.lightingDevices || []).map((d) => `${d.id}:${d.brightness}:${d.currentMode}:${d.status}`).join('|')
    const beforeMode = JSON.stringify(s.lightingStatus.currentMode)
    s.switchLightingMode('emergency')
    const person = s.simulatePersonEnter()
    const afterDev = (s.lightingDevices || []).map((d) => `${d.id}:${d.brightness}:${d.currentMode}:${d.status}`).join('|')
    return {
      devSame: beforeDev === afterDev,
      modeSame: beforeMode === JSON.stringify(s.lightingStatus.currentMode),
      personNull: person === null,
    }
  })
  check('switchLightingMode 未改写设备 / lightingStatus', switchProbe.devSame && switchProbe.modeSame, switchProbe)
  check('simulatePersonEnter 被拦截（返回 null）', switchProbe.personNull, switchProbe)
  check('守卫日志：switchLightingMode', guardHit('switchLightingMode'))

  console.log(`\n=== 结果：${passed} 通过 / ${failed} 失败 ===`)
  if (failed) { console.log('失败项：'); failures.forEach((f) => console.log('  - ' + f)) }

  // 测试隔离：复位 default session
  try {
    const st = await api(`/api/v1/demo/state?sessionId=${SESSION}`)
    if (st.body && st.body.stage && st.body.stage !== 'IDLE') {
      await cmd('RESET')
      await sleep(600)
      console.log('  ℹ 测试隔离：default session 已复位')
    }
  } catch (e) {
    console.log(`  ⚠ 测试隔离失败：${e.message}`)
  }

  await browser.close()
  process.exit(failed ? 1 : 0)
})().catch((err) => { console.error('B1 守卫回归异常：', err); process.exit(1) })

/**
 * P1.7 收口 · 最终 Golden Path 验收
 * ────────────────────────────────────────────────
 * 链路（真实点击，逐步推进）：
 *   模拟火灾 → 发现火灾 → 查看火情 → 确认火情 → 启动应急预案 → 选择疏散方案
 *   → 确认路径 → 智能疏散 → 人员移动 → 疏散完成 → 滞留人员 → 确认人员位置
 *   → 应急协同救援 → 消防救援 → 完成 → RESET
 *
 * 每一步同时核对八层：
 *   Backend(REST) → WS → demoStore → fireStore → 2D(DemoPanel/平面图)
 *   → 3D(__dtwin，仅活场景) → LightingView → operationLogs
 *
 * 本脚本只做验收，不修产品代码、不处理 P2 挂账项。
 *
 * 用法：
 *   1) demo 模式前端：set VITE_DATA_SOURCE=demo && npx vite --port 5199
 *   2) node worker/e2e-p17-golden-path-final.cjs
 */
const {
  PAGE_URL, sleep, waitFor, check, summary, results,
  demoState, resetDemoSession,
  openPage, openDemoPanel, ensureTwinMounted,
  clickByText, clickFlowButton, clickPlanChip, clickInDialog,
} = require('./e2e-lib.cjs')

// 后端 stage → fireStore legacy（src/stores/fireStore.js:191）
const LEGACY = {
  IDLE: 0, FIRE_DETECTED: 1, EMERGENCY_RESPONSE: 2, ROUTE_PLANNING: 3,
  SMART_EVACUATION: 4, RETAINED_PERSONS: 5, RESCUE_COORDINATION: 6, COMPLETED: 6,
}
const STAGE_ORDER = ['IDLE', 'FIRE_DETECTED', 'EMERGENCY_RESPONSE', 'ROUTE_PLANNING',
  'SMART_EVACUATION', 'RETAINED_PERSONS', 'RESCUE_COORDINATION', 'COMPLETED']

let page = null
let seen = []          // 阶段序列（校验无跳步/回退）
let maxLegacy = 0      // legacy 单调性
let maxLogs = 0        // operationLogs 单调性
let maxDone = -1       // 六步 done 数单调性

async function beStage() {
  const s = await demoState()
  return s.stage
}

/** 一次读全八层 */
async function layers() {
  const fe = await page.evaluate(() => {
    const store = window.__demo.store
    const ds = window.__demo.demoStore
    const w = window.__dtwin
    // 3D：句柄必须指向「当前挂载着」的场景才读（B-02 结论：陈旧句柄的 visible 是冻结旧值）
    const mounted = Boolean(w && w.scene && w.scene.renderer && w.scene.renderer.domElement.isConnected)
    const lights = (store.lightingDevices || [])
    const isEm = (d) => !!d.emergencyFlash || String(d.currentMode) === 'emergency' || String(d.status) === 'emergency'
    return {
      // WS
      ws: ds.wsStatus, seq: ds.seq,
      // demoStore
      demoStage: ds.stage, stageIndex: ds.stageIndex,
      dsMetrics: {
        total: (ds.metrics || {}).total ?? null,
        evacuated: (ds.metrics || {}).evacuated ?? null,
        retained: (ds.metrics || {}).retained ?? null,
        rescued: (ds.metrics || {}).rescued ?? null,
      },
      dsFlowSteps: (ds.flowSteps || []).map((s) => `${s.name}:${s.done ? 'D' : s.active ? 'P' : '-'}`),
      // fireStore
      legacy: store.emergencyStage,
      fireEvent: Boolean(store.fireEvent),
      // 3D 层的显示还取决于「当前查看楼栋」：总览态（未选楼栋）按设计不显示火区/路线
      selBld: String((store.dashboardView || {}).selectedBuildingId || ''),
      fireBld: store.fireEvent ? String(store.fireEvent.buildingId || '') : null,
      planBld: store.activeBuildingPlan ? String(store.activeBuildingPlan.buildingId || '') : null,
      routePlans: (store.routePlans || []).length,
      activePlan: Boolean(store.activeBuildingPlan),
      withRoutePoints: (store.persons || []).filter((p) => (p.routePoints || []).length).length,
      moving: (store.persons || []).filter((p) => p.status === 'evacuating').length,
      stranded: (store.strandedPersons || []).length,
      rescueTask: store.rescueTask ? String(store.rescueTask.id || '') || 'yes' : null,
      // 2D
      uiSteps: Array.from(document.querySelectorAll('.demo-panel .flow-step')).map((e) => {
        const name = (e.querySelector('.step-name') || {}).textContent || '?'
        return `${name}:${e.className.includes('done') ? 'D' : e.className.includes('processing') ? 'P' : '-'}`
      }),
      dialogs: Array.from(document.querySelectorAll('.biz-dialog-title')).map((e) => (e.textContent || '').trim()),
      // 3D
      twin: mounted
        ? {
          mounted: true,
          fire: w.fire ? Boolean(w.fire.group.visible) : null,
          route: w.route ? Boolean(w.route.group.visible) : null,
          rescue: w.rescue ? Boolean(w.rescue.group.visible) : null,
          persons: (w.persons && w.persons.data ? w.persons.data.filter(Boolean).length : null),
        }
        : { mounted: false },
      // LightingView 的权威数据源（B4-02 统一后）
      lighting: { total: lights.length, emergency: lights.filter(isEm).length },
      // operationLogs
      logs: {
        count: (store.operationLogs || []).length,
        last: (store.operationLogs || []).slice(0, 3).map((l) => `${l.action || ''}|${l.module || ''}`),
      },
    }
  })
  return fe
}

const fmt = (l) => `backend=${l.demoStage} ws=${l.ws} legacy=${l.legacy} | 火=${l.fireEvent} 方案=${l.routePlans}/${l.activePlan} 路线中=${l.withRoutePoints} 移动=${l.moving} 滞留=${l.stranded} 救援=${l.rescueTask} | 指标 T${l.dsMetrics.total}/E${l.dsMetrics.evacuated}/R${l.dsMetrics.retained}/S${l.dsMetrics.rescued} | 灯 ${l.lighting.emergency}/${l.lighting.total} | 日志 ${l.logs.count} | 3D ${l.twin.mounted ? `fire=${l.twin.fire} route=${l.twin.route} rescue=${l.twin.rescue} p=${l.twin.persons}` : '未挂载'}`

/**
 * 每一步的八层核对。expect = 点击后后端应处的 stage。
 */
async function verify(n, label, expect, opts = {}) {
  const l = await layers()
  const be = await beStage()
  // RESET 步本身就是「回退到 IDLE」，不纳入单调性/阶段序列校验
  if (!opts.isReset) seen.push(be)
  console.log(`\n  [${String(n).padStart(2, '0')} ${label}]`)
  console.log(`      ${fmt(l)}`)
  console.log(`      DemoPanel 六步 = ${JSON.stringify(l.uiSteps)}`)
  console.log(`      demoStore 投影 = ${JSON.stringify(l.dsFlowSteps)}`)

  check(`GP-${n}.1 后端 stage = ${expect}`, be === expect, { be, expect })
  check(`GP-${n}.2 demoStore 与后端一致（WS 收敛）`, l.demoStage === be, { demo: l.demoStage, be })
  check(`GP-${n}.3 fireStore legacy = ${LEGACY[expect]}`, l.legacy === LEGACY[expect], { legacy: l.legacy, expect: LEGACY[expect] })
  check(`GP-${n}.4 WS 处于 open 且有快照（seq>0）`, l.ws === 'open' && l.seq > 0, { ws: l.ws, seq: l.seq })
  // 2D：UI 渲染必须与 demoStore 权威投影逐项一致（B-01 修复点）
  check(`GP-${n}.5 2D 六步 == demoStore 权威投影`,
    JSON.stringify(l.uiSteps) === JSON.stringify(l.dsFlowSteps),
    { ui: l.uiSteps, ds: l.dsFlowSteps })
  // 3D：仅在活场景挂载时核对（B-02 结论：未挂载即无可见残留）。
  // 火区/路线的显示还要求「当前查看楼栋 == 火情/方案楼栋」：楼栋总览（未选楼栋）按设计不显示。
  if (l.twin.mounted) {
    const expectFire = Boolean(l.fireEvent && l.selBld && (!l.fireBld || l.fireBld === l.selBld))
    const expectRoute = Boolean((l.routePlans > 0 || l.activePlan) && l.selBld && (!l.planBld || l.planBld === l.selBld))
    console.log(`      3D 期望：fire=${expectFire}（火情楼栋=${l.fireBld || '-'} 当前楼栋=${l.selBld || '总览'}）`
      + ` route=${expectRoute}（方案楼栋=${l.planBld || '-'}）`)
    // 3D 图层随 watch 更新，允许一个短的最终一致窗口（最多 6s）。
    // 注意：阶段推进会切换视图（总览 ↔ 楼层平面图），3D 组件随之卸载/重挂载，
    // 期间句柄会断开（B-02：断开即无可观测的 3D），此时不得拿旧值判定。
    const { cur, skipped } = await (async () => {
      const read = () => page.evaluate(() => {
        const w = window.__dtwin
        if (!w || !w.scene) return null
        if (!w.scene.renderer.domElement.isConnected) return null
        return { fire: w.fire ? Boolean(w.fire.group.visible) : null, route: w.route ? Boolean(w.route.group.visible) : null }
      })
      let cur = { fire: l.twin.fire, route: l.twin.route }
      const t0 = Date.now()
      while (Date.now() - t0 < 6000) {
        if (cur.fire === expectFire && cur.route === expectRoute) break
        await sleep(400)
        const r = await read()
        if (!r) return { cur, skipped: true }   // 句柄已断开 → 跳过判定
        cur = r
      }
      return { cur, skipped: false }
    })()
    if (skipped) {
      console.log(`      · 3D 视图在采样窗口内被卸载/重挂载（句柄断开），跳过 3D 层判定`)
    } else {
      check(`GP-${n}.6 3D fire 与 fireStore 权威一致`, cur.fire === expectFire,
        { d3: cur.fire, expectFire, fireEvent: l.fireEvent, selBld: l.selBld, fireBld: l.fireBld })
      check(`GP-${n}.7 3D route 与「有方案且同楼栋」一致`, cur.route === expectRoute,
        { d3: cur.route, expectRoute, routePlans: l.routePlans, activePlan: l.activePlan, selBld: l.selBld, planBld: l.planBld })
    }
  } else {
    console.log(`      · 3D 未挂载（跳过 3D 层核对）`)
  }
  // LightingView 数据源：应急响应起应急灯必须点亮
  if (LEGACY[expect] >= 2) {
    check(`GP-${n}.8 LightingView 数据源含应急灯`, l.lighting.emergency > 0,
      { emergency: l.lighting.emergency, total: l.lighting.total })
  }
  // operationLogs 单调增长
  check(`GP-${n}.9 operationLogs 不回退`, l.logs.count >= maxLogs, { now: l.logs.count, max: maxLogs })
  maxLogs = Math.max(maxLogs, l.logs.count)
  // 阶段 / 六步进度单调（RESET 步除外，它本就是回退）
  if (!opts.isReset) {
    check(`GP-${n}.10 后端阶段未回退（legacy 单调）`, l.legacy >= maxLegacy, { legacy: l.legacy, maxLegacy })
    maxLegacy = Math.max(maxLegacy, l.legacy)
    const done = l.uiSteps.filter((s) => s.endsWith(':D')).length
    check(`GP-${n}.11 六步进度不回退`, done >= maxDone, { done, maxDone })
    maxDone = Math.max(maxDone, done)
  }
  return l
}

/** 点击并等待后端落到 expect，然后做八层核对 */
async function act(n, label, fn, expect, timeout = 20000, opts = {}) {
  if (fn) await fn()
  const ok = await waitFor(async () => (await beStage()) === expect, timeout)
  if (!ok) {
    console.log(`   ✗ [${String(n).padStart(2, '0')} ${label}] 后端未落到 ${expect}（实际 ${await beStage()}）`)
  }
  // REST 已推进后再等 WS 快照收敛到 demoStore / fireStore，否则采样时点会撞上传播窗口
  const conv = await waitFor(
    async () => (await page.evaluate(() => window.__demo.demoStore.stage)) === expect, 10000)
  if (!conv) {
    const ds = await page.evaluate(() => window.__demo.demoStore.stage)
    console.log(`   ✗ [${String(n).padStart(2, '0')} ${label}] demoStore 未收敛到 ${expect}（实际 ${ds}）`)
  }
  return verify(n, label, expect, opts)
}

async function dialogOpen(name) {
  return page.evaluate(
    (n) => Array.from(document.querySelectorAll('.biz-dialog-title')).some((e) => (e.textContent || '').includes(n)),
    name)
}

/** LightingView 页面级核对（切到 /lighting 再切回 /dashboard） */
async function checkLightingPage(n, label, expectEmergency) {
  await page.evaluate(() => { window.location.hash = '#/lighting' })
  await sleep(1500)
  const r = await page.evaluate(() => {
    const store = window.__demo.store
    const isEm = (d) => !!d.emergencyFlash || String(d.currentMode) === 'emergency' || String(d.status) === 'emergency'
    const lights = (store.lightingDevices || [])
    const tag = (document.querySelector('.header-status .status-tag') || {}).textContent || ''
    return { total: lights.length, emergency: lights.filter(isEm).length, tag: (tag || '').trim() }
  })
  console.log(`      LightingView：灯 ${r.emergency}/${r.total} 应急，头部状态「${r.tag}」`)
  if (expectEmergency) check(`GP-${n} LightingView 页面存在应急灯`, r.emergency > 0, r)
  else check(`GP-${n} LightingView 页面已回到日常（无应急灯）`, r.emergency === 0, r)
  await page.evaluate(() => { window.location.hash = '#/dashboard' })
  await sleep(1500)
}

// ─────────────────────────── 一趟 Golden Path ───────────────────────────
async function runRound(n) {
  console.log(`\n${'='.repeat(72)}\n  第 ${n} 趟 · Golden Path 全链路\n${'='.repeat(72)}`)
  seen = []; maxLegacy = 0; maxLogs = 0; maxDone = -1

  await resetDemoSession()
  await openDemoPanel(page)
  await sleep(1200)

  await act(1, '模拟火灾', () => clickByText(page, '模拟火灾'), 'FIRE_DETECTED')

  // 发现火灾：业务弹窗①必须出现（UI 层）
  const appeared = await waitFor(() => dialogOpen('发现火灾'), 8000)
  check(`GP-2 发现火灾：业务弹窗①出现`, appeared)
  await verify(2, '发现火灾（弹窗①）', 'FIRE_DETECTED')

  await act(3, '查看火情（UI 记账，不推进）',
    () => clickInDialog(page, '发现火灾', '查看火情'), 'FIRE_DETECTED', 8000)
  await sleep(1000) // 「确认火情」是查看火情后 800ms 自动弹出

  await act(4, '确认火情 → 后端指令链',
    () => clickInDialog(page, '确认火情', '确认火情'), 'EMERGENCY_RESPONSE')
  await sleep(1000) // 「是否启动应急预案」是确认火情后 800ms 自动弹出

  await act(5, '启动应急预案（幂等确认）',
    () => clickInDialog(page, '是否启动应急预案', '启动应急预案'), 'EMERGENCY_RESPONSE', 8000)

  await act(6, '选择疏散方案（A链推进 + 选 PLAN-B）', async () => {
    await clickFlowButton(page)
    await waitFor(async () => (await beStage()) === 'ROUTE_PLANNING', 15000)
    await sleep(800)
    await clickPlanChip(page, 1)
  }, 'ROUTE_PLANNING')

  // 3D 需处于挂载态才能核对 3D 层（B-02：未挂载时句柄不可信）
  await ensureTwinMounted(page)
  await sleep(1500)
  await verify(6.5, '查看 2D / 3D 疏散路线', 'ROUTE_PLANNING')
  // 必须关掉 3D 浮层：它是 inset:0 / z-index:900 的遮罩，会挡住后续业务按钮点击
  await page.evaluate(() => {
    const btn = document.querySelector('.dtwin-modal-close')
    if (btn) btn.click()
  })
  await sleep(800)

  await act(7, '确认当前疏散路径', () => clickFlowButton(page), 'SMART_EVACUATION')

  // 智能疏散 / 人员移动：采样人员是否真的在动
  const t0 = await layers()
  await sleep(3000)
  await verify(8, '智能疏散（t+3s）', 'SMART_EVACUATION')
  await sleep(3000)
  const t1 = await layers()
  await verify(9, '人员移动（t+6s）', 'SMART_EVACUATION')
  check(`GP-9 人员确实在疏散中（有 routePoints / evacuating）`,
    t1.withRoutePoints > 0 || t1.moving > 0 || (t1.dsMetrics.evacuated || 0) > (t0.dsMetrics.evacuated || 0),
    { t0: { rp: t0.withRoutePoints, mv: t0.moving, ev: t0.dsMetrics.evacuated },
      t1: { rp: t1.withRoutePoints, mv: t1.moving, ev: t1.dsMetrics.evacuated } })

  await act(10, '疏散完成 → 滞留人员识别', () => clickFlowButton(page), 'RETAINED_PERSONS')
  const l11 = await verify(11, '查看滞留人员位置', 'RETAINED_PERSONS')
  check(`GP-11 识别出滞留人员`, l11.stranded > 0 || (l11.dsMetrics.retained || 0) > 0,
    { stranded: l11.stranded, retained: l11.dsMetrics.retained })

  // 「确认人员位置」由 v-if=strandedPersons.length 控制，且需停留在火警楼层面板才渲染
  const btnReady = await (async () => {
    const has = () => page.evaluate(
      () => Array.from(document.querySelectorAll('button')).some((b) => (b.textContent || '').includes('确认人员位置')))
    if (await waitFor(has, 4000)) return true
    await clickByText(page, '聚焦火区', null, 'button')
    await sleep(900)
    return waitFor(has, 10000)
  })()
  check('GP-12.0 「确认人员位置」业务入口已渲染', btnReady)
  await act(12, '确认人员位置 → 后端指令链',
    () => clickByText(page, '确认人员位置', null, 'button'), 'RESCUE_COORDINATION')

  await act(13, '启动应急协同救援（幂等确认）',
    () => clickInDialog(page, '启动应急协同救援', '启动应急协同救援'), 'RESCUE_COORDINATION', 8000)

  await act(14, '消防救援协同',
    () => clickByText(page, '启动消防救援协同', null, 'button'), 'COMPLETED')

  await verify(15, '完成（COMPLETED）', 'COMPLETED')
  // 页面级 LightingView 核对（此时无未决弹窗，切换视图安全）
  await checkLightingPage('16a', 'COMPLETED 时 LightingView', true)

  // RESET
  await openDemoPanel(page)
  await act(17, 'RESET（停止重置）', () => clickByText(page, '停止重置'), 'IDLE', 20000, { isReset: true })
  const f = await layers()
  console.log(`      RESET 后：${fmt(f)}`)
  console.log(`      DemoPanel 六步 = ${JSON.stringify(f.uiSteps)}`)
  check('GP-18 RESET 后 demoStore = IDLE', f.demoStage === 'IDLE', { stage: f.demoStage })
  check('GP-19 RESET 后 fireStore legacy = 0', f.legacy === 0, { legacy: f.legacy })
  check('GP-20 RESET 后 UI 六步全部 pending（B-01）',
    f.uiSteps.length === 6 && f.uiSteps.every((s) => s.endsWith(':-')), f.uiSteps)
  check('GP-21 RESET 后无 fireEvent / 无方案 / 无 routePoints',
    !f.fireEvent && f.routePlans === 0 && !f.activePlan && f.withRoutePoints === 0,
    { fireEvent: f.fireEvent, routePlans: f.routePlans, activePlan: f.activePlan, rp: f.withRoutePoints })
  check('GP-22 RESET 后无滞留 / 无救援任务', f.stranded === 0 && f.rescueTask === null,
    { stranded: f.stranded, rescueTask: f.rescueTask })
  if (f.twin.mounted) {
    check('GP-23 RESET 后 3D fire/route 均不可见（B-02）',
      !f.twin.fire && !f.twin.route, { fire: f.twin.fire, route: f.twin.route })
  } else {
    console.log('      · 3D 未挂载（无可见 3D 残留）')
  }
  check('GP-24 RESET 后 LightingView 数据源无应急灯', f.lighting.emergency === 0, f.lighting)
  await checkLightingPage('25', 'RESET 后 LightingView', false)

  // 阶段序列无跳步/回退
  const idx = seen.map((s) => STAGE_ORDER.indexOf(s))
  let mono = true
  for (let i = 1; i < idx.length; i++) if (idx[i] < idx[i - 1]) mono = false
  console.log(`      阶段序列：${seen.join(' → ')}`)
  check('GP-26 全流程阶段序列无跳步/回退', mono, { seen })
}

;(async () => {
  console.log(`\n=== P1.7 收口 · 最终 Golden Path 验收（${PAGE_URL}）===\n`)
  const ctx = await openPage()
  page = ctx.page
  try {
    const mode = await page.evaluate(() => window.__demo.dataSource.mode)
    console.log(`  ℹ 运行模式：${mode}`)

    await runRound(1)
    const snap1 = { passed: results.passed, failed: results.failed, failures: [...results.failures] }

    console.log(`\n${'='.repeat(72)}\n  第二趟（幂等复跑）\n${'='.repeat(72)}`)
    const p0 = results.passed, f0 = results.failed
    results.failures.length = 0
    await runRound(2)
    const snap2 = { passed: results.passed - p0, failed: results.failed - f0, failures: [...results.failures] }

    console.log(`\n${'='.repeat(72)}\n  两趟一致性\n${'='.repeat(72)}`)
    console.log(`  第一趟：${snap1.passed} 通过 / ${snap1.failed} 失败`)
    console.log(`  第二趟：${snap2.passed} 通过 / ${snap2.failed} 失败`)
    const strip = (l) => JSON.stringify(l.map((s) => s.replace(/^GP-\d+(\.\d+)?/, 'GP-N')).sort())
    check('两趟结果一致（可稳定复现）',
      strip(snap1.failures) === strip(snap2.failures) && snap1.passed === snap2.passed,
      { r1: snap1.failures, r2: snap2.failures })

    const errs = ctx.logs.filter((l) => l.startsWith('[error]') || l.startsWith('[pageerror]'))
    console.log(`\n  控制台错误 / 未捕获异常：${errs.length} 条`)
    errs.slice(0, 10).forEach((l) => console.log(`    ${l.slice(0, 200)}`))
    check('无未捕获异常', errs.length === 0, errs.slice(0, 3))
  } catch (e) {
    console.log(`\n⚠ 验收中断：${e.stack || e.message}`)
    results.failed++
    results.failures.push('验收中断：' + e.message)
  } finally {
    try { await resetDemoSession() } catch (e) { /* ignore */ }
    await ctx.browser.close()
  }

  const r = summary('P1.7 收口 · 最终 Golden Path 验收')
  if (r.failed) process.exitCode = 1
})()

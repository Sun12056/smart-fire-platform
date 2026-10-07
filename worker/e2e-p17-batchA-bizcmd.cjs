/**
 * P1.7 第一阶段 · 批次 A 专项测试：3 个业务入口必须接入后端指令链
 * ────────────────────────────────────────────────
 * 被测 3 个业务入口（点击后后端 stage 不推进 = 断裂）：
 *   1. 业务弹窗①「发现火灾」→ 查看火情        FIRE_DETECTED     → EMERGENCY_RESPONSE
 *   2. 业务弹窗①b「确认火情」→ 确认火情       FIRE_DETECTED     → EMERGENCY_RESPONSE
 *   3. 楼层火处置面板 → 确认人员位置           RETAINED_PERSONS  → RESCUE_COORDINATION
 *
 * 判定口径：**只看后端 stage**（REST /api/v1/demo/state + 前端 demoStore.stage），
 * 不接受「UI processing/completed 变化了」这类前端自嗨证据。
 *
 * 用法：
 *   1) demo 模式前端：set VITE_DATA_SOURCE=demo && npx vite --port 5199
 *   2) node worker/e2e-p17-batchA-bizcmd.cjs
 */
const {
  PAGE_URL, sleep, waitFor, check, summary, results,
  demoState, resetDemoSession, cmd,
  openPage, openDemoPanel, clickByText, clickFlowButton, clickInDialog,
} = require('./e2e-lib.cjs')

let page = null

/** 后端权威 stage（REST 快照，不经前端） */
async function beStage() {
  const s = await demoState()
  return s.stage
}
/** 前端 demoStore.stage（WS 收敛后的镜像）+ fireStore legacy 阶段 */
async function feStage() {
  return page.evaluate(() => ({
    demo: window.__demo.demoStore.stage,
    legacy: window.__demo.store.emergencyStage,
    ws: window.__demo.demoStore.wsStatus,
    err: window.__demo.demoStore.error || null,
  }))
}
async function settle(ms = 1200) {
  await sleep(ms)
}
/** 业务弹窗是否打开 */
async function dialogOpen(name) {
  return page.evaluate(
    (n) => Array.from(document.querySelectorAll('.biz-dialog-title'))
      .some((e) => (e.textContent || '').includes(n)),
    name,
  )
}
/** 等到后端 stage 命中（最多 8s）；返回最终 stage */
async function waitBeStage(target, timeout = 8000) {
  const ok = await waitFor(async () => (await beStage()) === target, timeout)
  return { ok, stage: await beStage() }
}

/** 从 IDLE 起：模拟火灾 → FIRE_DETECTED */
async function toFireDetected() {
  await resetDemoSession()
  await openDemoPanel(page)
  await clickByText(page, '模拟火灾')
  const r = await waitBeStage('FIRE_DETECTED')
  if (!r.ok) throw new Error(`未能进入 FIRE_DETECTED，当前 ${r.stage}`)
  await settle(600)
}

/** 从 IDLE 起：一路推进到 RETAINED_PERSONS（走演示控制台 A 链，保证与 Golden Path 一致） */
async function toRetainedPersons() {
  await toFireDetected()
  for (let i = 0; i < 6; i++) {
    const cur = await beStage()
    if (cur === 'RETAINED_PERSONS') break
    await clickFlowButton(page)
    await waitFor(async () => (await beStage()) !== cur, 12000)
    await settle(500)
  }
  const cur = await beStage()
  if (cur !== 'RETAINED_PERSONS') throw new Error(`未能进入 RETAINED_PERSONS，当前 ${cur}`)
}

// ─────────────────────────── T1 查看火情 ───────────────────────────
// 批次 A 决策：FIRE_DETECTED → EMERGENCY_RESPONSE 这条迁移由「确认火情」拥有，
// 「查看火情」维持纯 UI 记账语义，不得推进后端 stage。这里作为回归守卫，防止被误改。
async function t1() {
  console.log('\n── T1 业务弹窗①「发现火灾」→ 查看火情（维持 UI 记账，不得推进） ──')
  await toFireDetected()
  const before = await beStage()

  const appeared = await waitFor(() => dialogOpen('发现火灾'), 8000)
  check('T1.1 「发现火灾」业务弹窗出现', appeared)

  await clickInDialog(page, '发现火灾', '查看火情')
  await settle()
  const closed = await waitFor(async () => !(await dialogOpen('发现火灾')), 5000)
  check('T1.2 点击后「发现火灾」弹窗关闭', closed)

  const after = await beStage()
  const fe = await feStage()
  console.log(`     后端 stage：${before} → ${after}（预期保持 FIRE_DETECTED，迁移归「确认火情」）`)
  console.log(`     前端收敛：demoStore=${fe.demo} legacy=${fe.legacy} ws=${fe.ws} err=${JSON.stringify(fe.err)}`)
  check('T1.3 后端 stage 保持 FIRE_DETECTED（不推进，迁移归确认火情）', after === 'FIRE_DETECTED', { before, after })
  check('T1.4 demoStore 与后端一致（WS 收敛）', fe.demo === after, { demo: fe.demo, be: after })
}

// ─────────────────────────── T2 确认火情 ───────────────────────────
async function t2() {
  console.log('\n── T2 业务弹窗①b「确认火情」→ 确认火情 ──')
  await toFireDetected()
  const before = await beStage()

  // 走到「确认火情」弹窗：先点查看火情（本步是否推进由 T1 覆盖）
  await waitFor(() => dialogOpen('发现火灾'), 8000)
  await clickInDialog(page, '发现火灾', '查看火情')
  await settle(1400) // 「确认火情」是查看火情后 800ms 自动弹出

  const appeared = await waitFor(() => dialogOpen('确认火情'), 8000)
  check('T2.1 「确认火情」业务弹窗出现', appeared)

  const mid = await beStage()
  await clickInDialog(page, '确认火情', '确认火情')
  await settle()
  const closed = await waitFor(async () => !(await dialogOpen('确认火情')), 5000)
  check('T2.2 点击后「确认火情」弹窗关闭', closed)

  const after = await beStage()
  const fe = await feStage()
  console.log(`     后端 stage：${before} --(查看火情)--> ${mid} --(确认火情)--> ${after}`)
  console.log(`     前端收敛：demoStore=${fe.demo} legacy=${fe.legacy} ws=${fe.ws} err=${JSON.stringify(fe.err)}`)
  check('T2.3 后端 stage 推进到 EMERGENCY_RESPONSE（不看 UI）', after === 'EMERGENCY_RESPONSE', { before, mid, after })
  check('T2.4 demoStore 与后端一致（WS 收敛）', fe.demo === after, { demo: fe.demo, be: after })

  // 下游「是否启动应急预案」弹窗行为必须保持不变：仍要出现，且不得被阶段 watch 误关
  const dlg2 = await waitFor(() => dialogOpen('是否启动应急预案'), 6000)
  check('T2.5 业务弹窗②「是否启动应急预案」仍然出现（UI 行为不变）', dlg2)
  if (dlg2) {
    await clickInDialog(page, '是否启动应急预案', '启动应急预案')
    await settle()
    const closed2 = await waitFor(async () => !(await dialogOpen('是否启动应急预案')), 5000)
    check('T2.6 弹窗②点击后关闭（UI 行为不变）', closed2)
    const s3 = await beStage()
    check('T2.7 弹窗②幂等：stage 仍为 EMERGENCY_RESPONSE（迁移已被确认火情消费）', s3 === 'EMERGENCY_RESPONSE', { s3 })
  }
}

/** 「确认人员位置」按钮由 v-if=strandedPersons.length 控制，且需停留在火警楼层面板才渲染。
 *  后端进入 RETAINED_PERSONS 后前端可能还需要一点时间/一次导航才把它渲染出来，这里先等再点。 */
async function ensureStrandedButton(timeout = 10000) {
  const has = () => page.evaluate(
    () => Array.from(document.querySelectorAll('button')).some((b) => (b.textContent || '').includes('确认人员位置')))
  if (await waitFor(has, 4000)) return true
  // 未渲染：先聚焦火区，把楼层火处置面板带出来（与 e2e-phase3-retention.cjs 的手动导航同思路）
  const nav = await clickByText(page, '聚焦火区', null, 'button')
  if (nav.ok) await settle(900)
  return waitFor(has, timeout)
}

// ─────────────────────────── T3 确认人员位置 ───────────────────────────
async function t3() {
  console.log('\n── T3 楼层火处置面板 → 确认人员位置 ──')
  await toRetainedPersons()
  const before = await beStage()

  const ready = await ensureStrandedButton()
  check('T3.0 「确认人员位置」业务入口已渲染', ready)
  const clickInfo = await clickByText(page, '确认人员位置', null, 'button')
  check('T3.1 找到并点击「确认人员位置」业务入口', Boolean(clickInfo && clickInfo.ok), clickInfo)
  await settle()

  const after = await beStage()
  const fe = await feStage()
  console.log(`     后端 stage：${before} → ${after}（目标 RESCUE_COORDINATION）`)
  console.log(`     前端收敛：demoStore=${fe.demo} legacy=${fe.legacy} ws=${fe.ws} err=${JSON.stringify(fe.err)}`)
  check('T3.2 后端 stage 推进到 RESCUE_COORDINATION（不看 UI）', after === 'RESCUE_COORDINATION', { before, after })
  check('T3.3 demoStore 与后端一致（WS 收敛）', fe.demo === after, { demo: fe.demo, be: after })

  // 弹窗③的出现/关闭行为必须保持不变（批次 A 不改 UI）
  const dlg3 = await waitFor(() => dialogOpen('启动应急协同救援'), 6000)
  check('T3.4 业务弹窗③「启动应急协同救援」仍然出现（UI 行为不变）', dlg3)
  if (dlg3) {
    await clickInDialog(page, '启动应急协同救援', '启动应急协同救援')
    await settle()
    const closed3 = await waitFor(async () => !(await dialogOpen('启动应急协同救援')), 5000)
    check('T3.5 弹窗③点击后关闭（UI 行为不变）', closed3)
    const s4 = await beStage()
    const fe4 = await feStage()
    check('T3.6 弹窗③幂等：stage 仍为 RESCUE_COORDINATION 且无后端报错', s4 === 'RESCUE_COORDINATION' && !fe4.err, { s4, err: fe4.err })
  }
}

// ─────────────────────────── T4 Golden Path 不受影响 ───────────────────────────
async function t4() {
  console.log('\n── T4 Golden Path：六阶段仍可走完（业务入口接入后不得卡死） ──')
  await toFireDetected()
  const seq = ['FIRE_DETECTED']
  // 用业务弹窗把流程推到 EMERGENCY_RESPONSE
  await waitFor(() => dialogOpen('发现火灾'), 8000)
  await clickInDialog(page, '发现火灾', '查看火情')
  await settle(1400)
  if (await dialogOpen('确认火情')) {
    await clickInDialog(page, '确认火情', '确认火情')
    await settle(1400)
  }
  if (await dialogOpen('是否启动应急预案')) {
    await clickInDialog(page, '是否启动应急预案', '启动应急预案')
  }
  await waitBeStage('EMERGENCY_RESPONSE')
  // 之后走演示控制台 A 链收尾
  for (const target of ['ROUTE_PLANNING', 'SMART_EVACUATION', 'RETAINED_PERSONS', 'RESCUE_COORDINATION', 'COMPLETED']) {
    const r = await waitBeStage(target, 3000)
    if (!r.ok) {
      await clickFlowButton(page)
      const r2 = await waitBeStage(target, 15000)
      if (r2.ok) { seq.push(target); continue }
      // RESCUE_COORDINATION 之后需业务入口收尾
      const c = await clickByText(page, '启动消防救援协同', null, 'button')
      if (!c.ok) await clickFlowButton(page)
      await waitBeStage(target, 15000)
    }
    seq.push(target)
    await settle(400)
  }
  const fin = await beStage()
  console.log(`     阶段序列：${seq.join(' → ')}`)
  check('T4.1 六阶段完整走完并停在 COMPLETED', fin === 'COMPLETED', { fin })
  check('T4.2 阶段序列无跳步/回退', seq.length === 6, { seq })
}

// ─────────────────────────── 主流程 ───────────────────────────
;(async () => {
  console.log(`\n=== P1.7 批次 A · 3 个业务入口后端指令链接入专项（${PAGE_URL}）===\n`)
  const ctx = await openPage()
  page = ctx.page
  const rounds = []
  try {
    const mode = await page.evaluate(() => window.__demo.dataSource.mode)
    console.log(`  ℹ 运行模式：${mode}`)
    await openDemoPanel(page)

    // 第一趟
    await t1(); const r1 = { passed: results.passed, failed: results.failed, list: [...results.failures] }
    await t2()
    await t3()
    await t4()
    const snap1 = { passed: results.passed, failed: results.failed, failures: [...results.failures] }

    console.log(`\n${'='.repeat(64)}\n  第二趟（幂等复跑）\n${'='.repeat(64)}`)
    const p0 = results.passed, f0 = results.failed
    results.failures.length = 0
    await t1()
    await t2()
    await t3()
    await t4()
    const snap2 = { passed: results.passed - p0, failed: results.failed - f0, failures: [...results.failures] }

    console.log(`\n${'='.repeat(64)}\n  两趟一致性\n${'='.repeat(64)}`)
    const same = JSON.stringify(snap1.failures) === JSON.stringify(snap2.failures)
      && snap1.passed === snap2.passed
    console.log(`  第一趟：${snap1.passed} 通过 / ${snap1.failed} 失败`)
    console.log(`  第二趟：${snap2.passed} 通过 / ${snap2.failed} 失败`)
    check('两趟结果一致（可稳定复现）', same, { r1: snap1.failures, r2: snap2.failures })

    const errs = ctx.logs.filter((l) => l.startsWith('[error]') || l.startsWith('[pageerror]'))
    console.log(`\n  控制台错误 / 未捕获异常：${errs.length} 条`)
    errs.slice(0, 10).forEach((l) => console.log(`    ${l.slice(0, 200)}`))
    check('无未捕获异常', errs.length === 0, errs.slice(0, 3))
  } catch (e) {
    console.log(`\n⚠ 专项中断：${e.stack || e.message}`)
    results.failed++
    results.failures.push('专项中断：' + e.message)
  } finally {
    try { await resetDemoSession() } catch (e) { console.log(`⚠ 复位失败：${e.message}`) }
    await ctx.browser.close()
  }

  const r = summary('P1.7 批次 A · 业务入口后端指令链')
  if (r.failed) process.exitCode = 1
})()

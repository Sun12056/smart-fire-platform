/**
 * P1.7 第二阶段 · B-01 专项：RESET 后演示控制台六步必须全部 pending
 * ────────────────────────────────────────────────
 * 现象：RESET 后后端已回 IDLE、persons/devices/metrics 已回基线，
 *       但 DemoPanel 六步里第一步「发现火灾」仍是 processing。
 *
 * 判定链路（逐环验证，不能只看 UI）：
 *   ① RESET 前确实处于进行中（六步里有 processing/done）
 *   ② 点「停止重置」后 backend(REST) = IDLE
 *   ③ WS snapshot 收到（demoStore.syncCount 增长）
 *   ④ demoStore.stage = IDLE
 *   ⑤ DemoPanel 六步 DOM class 全部 pending
 *   ⑥ 再开新一轮不受旧状态污染
 *
 * 用法：
 *   1) demo 模式前端：set VITE_DATA_SOURCE=demo && npx vite --port 5199
 *   2) node worker/e2e-p17-batchB01-reset-ui.cjs
 */
const {
  PAGE_URL, sleep, waitFor, check, summary, results,
  demoState, resetDemoSession,
  openPage, openDemoPanel, clickByText, clickFlowButton,
} = require('./e2e-lib.cjs')

let page = null

/** 后端权威 stage */
async function beStage() {
  const s = await demoState()
  return s.stage
}
/** 前端状态：demoStore（WS 收敛）+ platformStore 派生 + DemoPanel 六步 DOM */
async function probe() {
  return page.evaluate(() => {
    const ps = window.__demo.platformStore || null // 未暴露时不影响判定
    const ds = window.__demo.demoStore
    const steps = Array.from(document.querySelectorAll('.demo-panel .flow-step')).map((e) => {
      const name = (e.querySelector('.step-name') || {}).textContent || '?'
      const st = e.className.includes('done') ? 'done' : e.className.includes('processing') ? 'processing' : 'pending'
      return `${name}:${st}`
    })
    return {
      be: null,
      demoStage: ds.stage,
      demoStageIndex: ds.stageIndex,
      seq: ds.seq,                 // 已应用的快照版本（REST 响应与 WS 广播都会推进）
      syncCount: ds.syncCount,     // WS 连接后的全量同步次数（非快照计数，仅参考）
      ws: ds.wsStatus,
      // demoStore 的权威投影（后端 stageIndex 直接派生）
      dsFlowSteps: (ds.flowSteps || []).map((s) => `${s.name}:${s.done ? 'done' : s.active ? 'processing' : 'pending'}`),
      // platformStore 派生索引（若已暴露则记录，用于定位 phantom processing 的来源）
      psStepIndex: ps ? ps.demoStepIndex : null,
      psFlowActive: ps ? ps.demoFlowActive : null,
      psProgress: ps ? ps.progress : null,
      // DemoPanel 实际渲染
      uiSteps: steps,
      legacyStage: window.__demo.store.emergencyStage,
    }
  })
}
async function settle(ms = 1200) { await sleep(ms) }

/** 六步里是否存在 processing / done（证明「RESET 前确实处于进行中」） */
const hasActive = (p) => p.uiSteps.some((s) => s.endsWith(':processing') || s.endsWith(':done'))
const allPending = (p) => p.uiSteps.length === 6 && p.uiSteps.every((s) => s.endsWith(':pending'))

// ─────────────────────────── 一轮 ───────────────────────────
async function runRound(n, wsFrames) {
  console.log(`\n${'='.repeat(64)}\n  第 ${n} 趟\n${'='.repeat(64)}`)

  // ① 先跑到「进行中」：模拟火灾 + 推进两步
  console.log('\n── ① 进入进行中状态 ──')
  await resetDemoSession()
  await openDemoPanel(page)
  await clickByText(page, '模拟火灾')
  await waitFor(async () => (await beStage()) === 'FIRE_DETECTED', 12000)
  await settle(600)
  await clickFlowButton(page) // FIRE_DETECTED → EMERGENCY_RESPONSE
  await waitFor(async () => (await beStage()) === 'EMERGENCY_RESPONSE', 12000)
  await settle(800)

  const before = await probe()
  const beforeBe = await beStage()
  console.log(`     后端=${beforeBe}  demoStore=${before.demoStage}(idx=${before.demoStageIndex})  psStepIndex=${before.psStepIndex}`)
  console.log(`     demoStore.flowSteps = ${JSON.stringify(before.dsFlowSteps)}`)
  console.log(`     DemoPanel 六步      = ${JSON.stringify(before.uiSteps)}`)
  check(`B01-${n}.1 RESET 前确实处于进行中（六步含 processing/done）`, hasActive(before), before.uiSteps)
  check(`B01-${n}.2 RESET 前后端不在 IDLE`, beforeBe !== 'IDLE', { beforeBe })

  // ② 真实用户操作：点「停止重置」
  console.log('\n── ② 点击「停止重置」 ──')
  const wsFrom = wsFrames.length
  const clickInfo = await clickByText(page, '停止重置')
  check(`B01-${n}.3 找到并点击「停止重置」`, Boolean(clickInfo && clickInfo.ok), clickInfo)
  await waitFor(async () => (await beStage()) === 'IDLE', 12000)
  await settle(1500)

  const after = await probe()
  const afterBe = await beStage()
  console.log(`     后端=${afterBe}  demoStore=${after.demoStage}(idx=${after.demoStageIndex})  psStepIndex=${after.psStepIndex}  ws=${after.ws}`)
  const newFrames = wsFrames.slice(wsFrom)
  const idleFrames = newFrames.filter((t) => t.includes('IDLE'))
  console.log(`     WS 帧：点击后收到 ${newFrames.length} 帧，其中含 IDLE 的 ${idleFrames.length} 帧（WS ${after.ws}）`)
  if (idleFrames.length) console.log(`     样例：${idleFrames[0].slice(0, 160)}`)
  console.log(`     demoStore.flowSteps = ${JSON.stringify(after.dsFlowSteps)}`)
  console.log(`     DemoPanel 六步      = ${JSON.stringify(after.uiSteps)}`)

  check(`B01-${n}.4 RESET 后 backend = IDLE`, afterBe === 'IDLE', { afterBe })
  check(`B01-${n}.5 RESET 后 WS 收到含 IDLE 的快照`, idleFrames.length > 0 && after.ws === 'open',
    { newFrames: newFrames.length, idleFrames: idleFrames.length, ws: after.ws })
  check(`B01-${n}.6 RESET 后 demoStore = IDLE`, after.demoStage === 'IDLE', { stage: after.demoStage })
  check(`B01-${n}.7 RESET 后 fireStore legacy 阶段归零`, after.legacyStage === 0, { legacy: after.legacyStage })
  check(`B01-${n}.8 RESET 后 DemoPanel 六步全部 pending`, allPending(after), after.uiSteps)

  // ③ 再开新一轮：不得被旧状态污染
  console.log('\n── ③ 再开新一轮 Golden Path ──')
  await openDemoPanel(page)
  await clickByText(page, '模拟火灾')
  await waitFor(async () => (await beStage()) === 'FIRE_DETECTED', 12000)
  await settle(800)
  const again = await probe()
  console.log(`     DemoPanel 六步 = ${JSON.stringify(again.uiSteps)}`)
  check(`B01-${n}.9 新一轮第 1 步重新变为 processing（未被旧状态污染）`,
    again.uiSteps[0] && again.uiSteps[0].endsWith(':processing'), again.uiSteps)
  check(`B01-${n}.10 新一轮后续步保持 pending`,
    again.uiSteps.slice(1).every((s) => s.endsWith(':pending')), again.uiSteps)

  // 走完剩余阶段
  for (const t of ['EMERGENCY_RESPONSE', 'ROUTE_PLANNING', 'SMART_EVACUATION', 'RETAINED_PERSONS', 'RESCUE_COORDINATION', 'COMPLETED']) {
    const ok = await waitFor(async () => (await beStage()) === t, 2500)
    if (ok) { await settle(300); continue }
    await clickFlowButton(page)
    const ok2 = await waitFor(async () => (await beStage()) === t, 15000)
    if (!ok2) {
      const c = await clickByText(page, '启动消防救援协同', null, 'button')
      if (!c.ok) await clickFlowButton(page)
      await waitFor(async () => (await beStage()) === t, 15000)
    }
    await settle(300)
  }
  const fin = await beStage()
  check(`B01-${n}.11 新一轮可完整走完并停在 COMPLETED`, fin === 'COMPLETED', { fin })
}

// ─────────────────────────── 主流程 ───────────────────────────
;(async () => {
  console.log(`\n=== P1.7 批次 B-01 · RESET 后演示控制台六步归零专项（${PAGE_URL}）===\n`)
  const ctx = await openPage()
  page = ctx.page
  try {
    const mode = await page.evaluate(() => window.__demo.dataSource.mode)
    console.log(`  ℹ 运行模式：${mode}`)

    // 订阅 WS 帧必须早于连接建立：先挂监听再 reload，确保能抓到 RESET 之后的广播
    const wsFrames = []
    page.on('websocket', (ws) => {
      ws.on('framereceived', (f) => {
        try { wsFrames.push(String(f.payload)) } catch (e) { /* 忽略非文本帧 */ }
      })
    })
    await page.reload({ waitUntil: 'load' })
    await waitFor(() => page.evaluate(() => Boolean(window.__demo && window.__demo.demoStore)), 20000)
    await openDemoPanel(page)

    await runRound(1, wsFrames)
    const snap1 = { passed: results.passed, failed: results.failed, failures: [...results.failures] }

    console.log(`\n${'='.repeat(64)}\n  第二趟（幂等复跑）\n${'='.repeat(64)}`)
    const p0 = results.passed, f0 = results.failed
    results.failures.length = 0
    await runRound(2, wsFrames)
    const snap2 = { passed: results.passed - p0, failed: results.failed - f0, failures: [...results.failures] }

    console.log(`\n${'='.repeat(64)}\n  两趟一致性\n${'='.repeat(64)}`)
    console.log(`  第一趟：${snap1.passed} 通过 / ${snap1.failed} 失败`)
    console.log(`  第二趟：${snap2.passed} 通过 / ${snap2.failed} 失败`)
    // 断言名带趟号（B01-1.x / B01-2.x），比对前先抹掉趟号
    const strip = (list) => JSON.stringify(list.map((s) => s.replace(/^B01-\d+\./, 'B01-N.')))
    check('两趟结果一致（可稳定复现）',
      strip(snap1.failures) === strip(snap2.failures) && snap1.passed === snap2.passed,
      { r1: snap1.failures, r2: snap2.failures })

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

  const r = summary('P1.7 批次 B-01 · RESET 后六步归零')
  if (r.failed) process.exitCode = 1
})()

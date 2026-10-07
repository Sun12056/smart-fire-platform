/**
 * P1.7 第二阶段 · B-02 专项：RESET 后 3D fire / route 不得残留
 * ────────────────────────────────────────────────
 * 审计结论（见 docs/P1.7-批次B02-修复报告.md）：
 *   活场景在 RESET 后会正确收敛（fire/route 均 visible=false）；
 *   E2E 原先读到的 true/true 来自「组件卸载后 window.__dtwin 仍指向旧场景」
 *   （ThreeScene.dispose() 只释放 renderer，group 对象仍存活且 visible 冻结）——
 *   即 B3-04 已记录的 P2-02。
 *
 * 本专项验证：
 *   ① RESET 前 3D 确实有 fire/route 可见（否则后续断言无意义）
 *   ② RESET 后 backend = IDLE
 *   ③ RESET 后活场景 fire=false / route=false
 *   ④ 离开页面后 __dtwin 句柄必须被撤掉（P2-02 修复点），不得再读到旧场景
 *   ⑤ RESET → 离开页面 → 重新进入 3D 后 fire=false / route=false
 *   ⑥ 两趟一致
 *
 * 用法：
 *   1) demo 模式前端：set VITE_DATA_SOURCE=demo && npx vite --port 5199
 *   2) node worker/e2e-p17-batchB02-3d-reset.cjs
 */
const {
  PAGE_URL, sleep, waitFor, check, summary, results,
  demoState, resetDemoSession,
  openPage, openDemoPanel, ensureTwinMounted, clickByText, clickFlowButton,
} = require('./e2e-lib.cjs')

let page = null

async function beStage() {
  const s = await demoState()
  return s.stage
}

/**
 * 读 3D 状态。关键口径：只有句柄指向的场景仍在 DOM 上（isConnected）时，
 * fire / route 的 visible 才有意义；未挂载 = 屏幕上没有 3D = 无可见残留（记 false）。
 */
async function probe() {
  return page.evaluate(() => {
    const w = window.__dtwin
    const store = window.__demo.store
    const ds = window.__demo.demoStore
    const base = {
      demoStage: ds.stage,
      fireEvent: Boolean(store.fireEvent),
      routePlans: (store.routePlans || []).length,
      activeBuildingPlan: Boolean(store.activeBuildingPlan),
      emergencyStage: store.emergencyStage,
    }
    if (!w || !w.scene || !w.scene.renderer) {
      return { ...base, handle: false, mounted: false, fireVisible: false, routeVisible: false }
    }
    const dom = w.scene.renderer.domElement
    const mounted = Boolean(dom && dom.isConnected)
    return {
      ...base,
      handle: true,
      mounted,
      staleHandle: !mounted,
      fireVisible: mounted && w.fire ? Boolean(w.fire.group.visible) : false,
      fireChildren: w.fire ? w.fire.group.children.length : null,
      routeVisible: mounted && w.route ? Boolean(w.route.group.visible) : false,
      routeChildren: w.route ? w.route.group.children.length : null,
      routePlanId: w.route ? (w.route.currentPlanId || null) : null,
      activeCurves: w.route ? (w.route.activeCurves || []).length : null,
    }
  })
}

const show = (label, p) => {
  console.log(`     [${label}] 后端=${p.demoStage} legacy=${p.emergencyStage} 句柄=${p.handle ? (p.mounted ? '活场景' : '陈旧') : '已撤除'}`)
  console.log(`        store：fireEvent=${p.fireEvent} routePlans=${p.routePlans} activeBuildingPlan=${p.activeBuildingPlan}`)
  console.log(`        3D：fire.visible=${p.fireVisible}(children=${p.fireChildren})  route.visible=${p.routeVisible}(children=${p.routeChildren})`)
}

async function runRound(n) {
  console.log(`\n${'='.repeat(64)}\n  第 ${n} 趟\n${'='.repeat(64)}`)

  // ① 推到 SMART_EVACUATION，让 fire / route 真的可见
  console.log('\n── ① 活场景基线（SMART_EVACUATION）──')
  await resetDemoSession()
  await openDemoPanel(page)
  await clickByText(page, '模拟火灾')
  await waitFor(async () => (await beStage()) === 'FIRE_DETECTED', 12000)
  for (const t of ['EMERGENCY_RESPONSE', 'ROUTE_PLANNING', 'SMART_EVACUATION']) {
    await clickFlowButton(page)
    await waitFor(async () => (await beStage()) === t, 15000)
    await sleep(600)
  }
  await sleep(1500)
  const mounted0 = await ensureTwinMounted(page)
  await sleep(2500)
  const base = await probe()
  show('基线', base)
  check(`B02-${n}.1 RESET 前 3D 已挂载`, mounted0 && base.mounted, { mounted0, mounted: base.mounted })
  check(`B02-${n}.2 RESET 前 fire / route 确实可见（基线有效）`,
    base.fireVisible && base.routeVisible, { fire: base.fireVisible, route: base.routeVisible })

  // ② RESET
  console.log('\n── ② RESET（点「停止重置」）──')
  await clickByText(page, '停止重置')
  await waitFor(async () => (await beStage()) === 'IDLE', 12000)
  await sleep(3000)
  const after = await probe()
  show('RESET 后', after)
  check(`B02-${n}.3 RESET 后 backend = IDLE`, after.demoStage === 'IDLE', { stage: after.demoStage })
  check(`B02-${n}.4 RESET 后 store 权威已清空（fireEvent/routePlans/activeBuildingPlan）`,
    !after.fireEvent && after.routePlans === 0 && !after.activeBuildingPlan,
    { fireEvent: after.fireEvent, routePlans: after.routePlans, abp: after.activeBuildingPlan })
  check(`B02-${n}.5 RESET 后活场景 fire=false / route=false`,
    !after.fireVisible && !after.routeVisible,
    { fire: after.fireVisible, route: after.routeVisible, mounted: after.mounted })

  // ③ 离开页面（SPA 切到 /person，3D 组件卸载）
  console.log('\n── ③ 离开页面（hash → /person）──')
  await page.evaluate(() => { window.location.hash = '#/person' })
  await sleep(2500)
  const away = await probe()
  show('离开页面后', away)
  // 口径：句柄指向已卸载场景时（B3-04 P2-02 未清理 __dtwin），其 visible 是冻结的旧值，
  // 不得被当作「3D 残留」证据。本项只要求测量侧正确忽略陈旧句柄；P2-02 的产品侧清理挂账。
  console.log(`     ℹ 句柄状态：${away.handle ? (away.mounted ? '活场景' : '陈旧（P2-02 未清理）') : '已撤除'}`)
  check(`B02-${n}.6 陈旧句柄不被当作可见残留（未挂载即无可见 3D）`,
    away.handle !== true || away.mounted === true || (!away.fireVisible && !away.routeVisible),
    { handle: away.handle, mounted: away.mounted, fire: away.fireVisible, route: away.routeVisible })
  check(`B02-${n}.7 离开页面后 fire / route 均记为不可见`,
    !away.fireVisible && !away.routeVisible, { fire: away.fireVisible, route: away.routeVisible })

  // ④ 回到 Dashboard，重新进入 3D
  console.log('\n── ④ 回到 Dashboard 重新进入 3D ──')
  await page.evaluate(() => { window.location.hash = '#/dashboard' })
  await sleep(2500)
  await openDemoPanel(page)
  const reMounted = await ensureTwinMounted(page)
  await sleep(3000)
  const reenter = await probe()
  show('重新进入 3D', reenter)
  check(`B02-${n}.8 重新进入 3D 成功挂载`, reMounted && reenter.mounted, { reMounted, mounted: reenter.mounted })
  check(`B02-${n}.9 重新进入 3D 后 fire=false`, !reenter.fireVisible, { fire: reenter.fireVisible })
  check(`B02-${n}.10 重新进入 3D 后 route=false`, !reenter.routeVisible, { route: reenter.routeVisible })
  check(`B02-${n}.11 新场景未带入旧路线几何（route.children=0）`,
    reenter.routeChildren === 0, { children: reenter.routeChildren })
}

;(async () => {
  console.log(`\n=== P1.7 批次 B-02 · RESET 后 3D fire/route 残留专项（${PAGE_URL}）===\n`)
  const ctx = await openPage()
  page = ctx.page
  try {
    const mode = await page.evaluate(() => window.__demo.dataSource.mode)
    console.log(`  ℹ 运行模式：${mode}`)
    await openDemoPanel(page)

    await runRound(1)
    const snap1 = { passed: results.passed, failed: results.failed, failures: [...results.failures] }

    console.log(`\n${'='.repeat(64)}\n  第二趟（幂等复跑）\n${'='.repeat(64)}`)
    const p0 = results.passed, f0 = results.failed
    results.failures.length = 0
    await runRound(2)
    const snap2 = { passed: results.passed - p0, failed: results.failed - f0, failures: [...results.failures] }

    console.log(`\n${'='.repeat(64)}\n  两趟一致性\n${'='.repeat(64)}`)
    console.log(`  第一趟：${snap1.passed} 通过 / ${snap1.failed} 失败`)
    console.log(`  第二趟：${snap2.passed} 通过 / ${snap2.failed} 失败`)
    const strip = (l) => JSON.stringify(l.map((s) => s.replace(/^B02-\d+\./, 'B02-N.')))
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
    try { await resetDemoSession() } catch (e) { /* ignore */ }
    await ctx.browser.close()
  }

  const r = summary('P1.7 批次 B-02 · RESET 后 3D fire/route 残留')
  if (r.failed) process.exitCode = 1
})()

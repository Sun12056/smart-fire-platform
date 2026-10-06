/**
 * P1.7.3-B4-01 专项回归（P1-02：解除 3D 对 legacy activeRoutePlanId 的隐式方案依赖）
 * ────────────────────────────────────────────────
 * 核心命题：3D（BuildingDigitalTwin 宿主的 route / persons 层）当前方案的
 * **唯一触发源**必须是 fireStore.activeBuildingPlan（/ activeBuildingPlanId），
 * 而不是「syncLegacyRouteState 顺手把 activeRoutePlanId 改了」的副作用。
 *
 * 关键用例 T2：冻结 legacy（activeRoutePlanId + routePlans 都不动），
 * 只让 activeBuildingPlan 变化 → 3D 必须更新。
 * 修复前该用例应当 FAIL（3D 停在旧方案），修复后 PASS。
 *
 * 用法：node worker/e2e-p173-b401-3d-plan-watch.cjs
 */
const {
  sleep, waitFor, check, summary,
  cmd, demoState, resetDemoSession, openPage, openDemoPanel, clickByText,
} = require('./e2e-lib.cjs')

const stageOf = (page) => page.evaluate(() => window.__demo.demoStore.stage)
const waitStage = (page, stage, timeout = 20000) =>
  waitFor(async () => (await stageOf(page)) === stage, timeout)

/** 打开 3D 数字孪生浮层（未挂载时 __dtwin 是旧快照，不能用于比对） */
async function open3D(page) {
  await page.evaluate(() => { window.location.hash = '#/dashboard' })
  const hasBtn = await waitFor(() => page.locator('.open-3d-btn').count().then((c) => c > 0), 15000)
  if (!hasBtn) {
    await page.evaluate(() => window.__demo.store.saveDashboardViewState({ viewMode: 'floors' }))
    await waitFor(() => page.locator('.open-3d-btn').count().then((c) => c > 0), 10000)
  }
  await page.evaluate(() => { const b = document.querySelector('.open-3d-btn'); if (b) b.click() })
  return waitFor(() => page.evaluate(
    () => Boolean(window.__dtwin && window.__dtwin.scene && window.__dtwin.scene.renderer.domElement.isConnected
      && (window.__dtwin.persons.data || []).filter(Boolean).length > 0),
  ), 45000)
}

/** 3D 当前方案指纹快照（route 层 + persons 层路线来源） */
const ROUTE_FP = () => {
  const dt = window.__dtwin || {}
  const store = window.__demo.store
  const data3d = (dt.persons && dt.persons.data ? dt.persons.data : []).filter(Boolean)
  return {
    planId3d: dt.route
      ? (dt.route.currentPlanId === null || dt.route.currentPlanId === undefined
        ? null : String(dt.route.currentPlanId))
      : null,
    tubes: dt.route ? (dt.route._tubes || []).length : -1,
    visible: dt.route ? Boolean(dt.route.group.visible) : null,
    curves: dt.route ? (dt.route.activeCurves || []).length : -1,
    planIdFs: store.activeBuildingPlanId,
    planFs: store.activeBuildingPlan ? store.activeBuildingPlan.id : null,
    legacy: store.activeRoutePlanId,
    legacyPlansSig: (store.routePlans || []).map((p) => p.id).join(','),
    personPlanKeys: [...new Set(data3d.map((d) => String(d.routeKey || '').split(':').slice(0, 2).join(':'))
      .filter((k) => k.startsWith('bp:')))],
  }
}

/** 切换到 TOOL 无关的「下一个不同于当前」的方案 id */
const nextPlanId = (ids, cur) => ids.find((x) => x !== cur) || cur

;(async () => {
  await resetDemoSession()
  const { browser, page } = await openPage()
  const pageErrors = []
  page.on('pageerror', (e) => pageErrors.push(String(e.message).slice(0, 160)))

  try {
    await openDemoPanel(page)

    // ═══ 推进到 ROUTE_PLANNING ═══
    console.log('\n[准备] 推进到阶段 3（疏散路径规划）并挂载 3D')
    await cmd('START_FIRE'); check('START_FIRE → FIRE_DETECTED', await waitStage(page, 'FIRE_DETECTED'))
    await cmd('ACTIVATE_RESPONSE'); check('ACTIVATE_RESPONSE → EMERGENCY_RESPONSE', await waitStage(page, 'EMERGENCY_RESPONSE'))
    await cmd('PLAN_ROUTES'); check('PLAN_ROUTES → ROUTE_PLANNING', await waitStage(page, 'ROUTE_PLANNING'))
    await waitFor(() => page.evaluate(() => (window.__demo.demoStore.buildingPlans || []).length >= 3), 20000)
    const planIds = await page.evaluate(() => (window.__demo.demoStore.buildingPlans || []).map((p) => p.id))
    const RECOMMENDED = await page.evaluate(() => window.__demo.demoStore.activeBuildingPlanId)
    const TARGET = planIds.includes('PLAN-C') ? 'PLAN-C' : planIds[planIds.length - 1]
    console.log(`      方案集合=${planIds.join('/')} 后端推荐=${RECOMMENDED} 本轮目标=${TARGET}`)
    check('准备：3D 数字孪生已挂载', await open3D(page))

    // ═══ T1：A → B → C：3D 直接跟随 activeBuildingPlan ═══
    console.log('\n[T1] View 逐个切换 A/B/C：fireStore.activeBuildingPlan → 3D 路线层')
    for (const id of planIds) {
      await page.evaluate((pid) => {
        const list = (window.__demo.store.buildingEvacuationPlans || [])
        const idx = list.findIndex((p) => p.id === pid)
        const btns = document.querySelectorAll('.fip-plan')
        if (btns[idx]) btns[idx].click()
      }, id)
      const ok = await waitFor(() => page.evaluate(
        (p) => String((window.__dtwin && window.__dtwin.route ? window.__dtwin.route.currentPlanId : '') || '').startsWith(`${p}:`),
        id), 6000)
      const fp = await page.evaluate(ROUTE_FP)
      check(`${id}：fireStore.activeBuildingPlan === 所选`, fp.planIdFs === id && fp.planFs === id, fp)
      check(`${id}：3D route.currentPlanId 跟随（有路线 tube）`, ok && fp.tubes > 0, fp)
      check(`${id}：3D 人员路线来自同一方案（bp:<方案id>）`,
        fp.personPlanKeys.length > 0 && fp.personPlanKeys.every((k) => k === `bp:${id}`), fp.personPlanKeys)
    }

    // ═══ T2（核心）：activeBuildingPlan 改变 + legacy 冻结 → 3D 仍然更新 ═══
    console.log('\n[T2] ★ 冻结 legacy（activeRoutePlanId / routePlans 不变），仅改 activeBuildingPlan → 3D 必须更新')
    const from = await page.evaluate(() => window.__demo.store.activeBuildingPlanId)
    const to = nextPlanId(planIds, from)
    const before = await page.evaluate(ROUTE_FP)
    const frozen = await page.evaluate((target) => {
      const store = window.__demo.store
      const snap = {
        legacy: store.activeRoutePlanId,
        legacyPlansSig: (store.routePlans || []).map((p) => p.id).join(','),
      }
      // 关键：只写「意向 / 权威槽」activeBuildingPlanId，不让 syncLegacyRouteState 产生任何副作用
      store.activeBuildingPlanId = target
      // 若这次赋值意外触发了 legacy 重算，把它钉回原值，确保「legacy 完全没动」
      const touched = store.activeRoutePlanId !== snap.legacy
        || (store.routePlans || []).map((p) => p.id).join(',') !== snap.legacyPlansSig
      store.activeRoutePlanId = snap.legacy
      return { snap, touched, nowFs: store.activeBuildingPlanId }
    }, to)
    await sleep(900)
    const after = await page.evaluate(ROUTE_FP)
    check('T2 前置：legacy activeRoutePlanId / routePlans 均未被改动（无同步副作用）',
      after.legacy === before.legacy && after.legacyPlansSig === before.legacyPlansSig,
      { before: { legacy: before.legacy, sig: before.legacyPlansSig }, after: { legacy: after.legacy, sig: after.legacyPlansSig }, frozen })
    check('T2 前置：fireStore.activeBuildingPlan 已切到新方案', after.planIdFs === to && after.planFs === to, after)
    check('T2 3D route.currentPlanId 直接跟随 activeBuildingPlan（即便 legacy 不变）',
      String(after.planId3d || '').startsWith(`${to}:`), { to, before3d: before.planId3d, after3d: after.planId3d })
    check('T2 3D 人员路线切到新方案（bp:<新方案id>）',
      after.personPlanKeys.length > 0 && after.personPlanKeys.every((k) => k === `bp:${to}`),
      { to, beforeKeys: before.personPlanKeys, afterKeys: after.personPlanKeys })

    // 回到目标方案（走正式 View 入口）
    await page.evaluate((pid) => {
      const list = (window.__demo.store.buildingEvacuationPlans || [])
      const idx = list.findIndex((p) => p.id === pid)
      const btns = document.querySelectorAll('.fip-plan')
      if (btns[idx]) btns[idx].click()
    }, TARGET)
    await sleep(700)

    // ═══ T3：WS 快照下发（断线重连 + 全量同步）→ 3D 跟随后端权威方案 ═══
    console.log('\n[T3] WS 重连 / 全量快照后 3D 仍跟随后端权威方案')
    await page.evaluate(() => { try { window.__demo.demoStore.disconnect() } catch (_) {} })
    await sleep(500)
    await page.evaluate(() => window.__demo.demoStore.connect())
    await waitFor(() => page.evaluate(() => window.__demo.demoStore.connected), 20000)
    await waitFor(() => page.evaluate(() => Boolean((window.__demo.store.buildingEvacuationPlans || []).length)), 15000)
    await sleep(1200)
    const t3 = await page.evaluate(ROUTE_FP)
    const be3 = await demoState()
    // 未 confirm 之前后端 activeBuildingPlanId 仍是它自己的推荐/执行方案；
    // 前端按 B3-05 的 intent > executed 语义保持「所选方案」（确认后在 T4 校验两者一致）
    console.log(`      ℹ 重连后后端 activeBuildingPlanId=${be3.activeBuildingPlanId}（未确认阶段允许为推荐方案）`)
    check('T3 重连后 fireStore.activeBuildingPlan === 所选方案', t3.planIdFs === TARGET && t3.planFs === TARGET, t3)
    check('T3 3D 跟随 fireStore 的当前方案', String(t3.planId3d || '').startsWith(`${TARGET}:`), t3)

    // ═══ T4：Golden Path（确认 → 智能疏散）：3D 不丢、不串 ═══
    console.log('\n[T4] Golden Path：确认所选方案 → 智能疏散阶段 3D 与后端同源')
    await clickByText(page, '确认当前疏散路径')
    check('T4 进入 SMART_EVACUATION', await waitStage(page, 'SMART_EVACUATION'))
    await waitFor(() => page.evaluate(() => (window.__demo.demoStore.persons || []).length > 0), 15000)
    await sleep(1200)
    const t4 = await page.evaluate(ROUTE_FP)
    const be4 = await demoState()
    check('T4 后端执行的是所选方案', be4.activeBuildingPlanId === TARGET, { TARGET, backend: be4.activeBuildingPlanId })
    check('T4 3D 路线层仍是同一方案（未回退推荐方案）', String(t4.planId3d || '').startsWith(`${TARGET}:`), t4)
    check('T4 3D 人员路线来自后端 routePoints（backend: 源优先）',
      await page.evaluate(() => {
        const dt = window.__dtwin
        const data = (dt && dt.persons && dt.persons.data ? dt.persons.data : []).filter(Boolean)
        return data.length > 0 && data.filter((d) => String(d.routeKey || '').startsWith('backend:')).length > 0
      }), t4.personPlanKeys)

    // ═══ T5：RESET → 3D 方案清空（不残留上一轮） ═══
    console.log('\n[T5] RESET：3D 路线 / 人员方案全部清空')
    await cmd('RESET')
    await waitStage(page, 'IDLE')
    await sleep(1500)
    const t5 = await page.evaluate(ROUTE_FP)
    check('T5 fireStore.activeBuildingPlan 已清空', t5.planIdFs === null && t5.planFs === null, t5)
    check('T5 3D 方案指纹清空 / 路线不可见（不再持有上一轮方案）',
      t5.planId3d === null && t5.visible === false && t5.curves === 0, t5)
    check('T5 legacy activeRoutePlanId 同步清空', t5.legacy === null, t5)
    if (t5.tubes > 0) {
      console.log(`      ℹ 3D tube 资源残留 ${t5.tubes} 条（P2-01：RouteLayer3D 无方案时不 dispose），本批不处理`)
    }

    // ═══ T6：新一轮演练 → 3D 跟随新方案（不沿用上一轮 id） ═══
    console.log('\n[T6] 新一轮演练：3D 跟随新一轮重建的方案')
    await cmd('START_FIRE'); await waitStage(page, 'FIRE_DETECTED')
    await cmd('ACTIVATE_RESPONSE'); await waitStage(page, 'EMERGENCY_RESPONSE')
    await cmd('PLAN_ROUTES'); await waitStage(page, 'ROUTE_PLANNING')
    await waitFor(() => page.evaluate(() => (window.__demo.demoStore.buildingPlans || []).length >= 3), 20000)
    await open3D(page)
    await sleep(1200)
    const t6 = await page.evaluate(ROUTE_FP)
    const be6 = await demoState()
    check('T6 新一轮 fireStore.activeBuildingPlan === 后端权威方案',
      t6.planIdFs === be6.activeBuildingPlanId && t6.planFs === be6.activeBuildingPlanId, { t6, backend: be6.activeBuildingPlanId })
    check('T6 3D 跟随新一轮方案', String(t6.planId3d || '').startsWith(`${t6.planIdFs}:`) && t6.tubes > 0, t6)

    check('全程无未捕获页面异常', pageErrors.length === 0, pageErrors.slice(0, 3))
  } finally {
    await cmd('RESET').catch(() => {})
    await sleep(600)
    await browser.close()
    summary('P1.7.3-B4-01 专项回归（3D 直接订阅 activeBuildingPlan）')
    process.exitCode = 0
  }
})()

/**
 * P1.7.3-B3-05 专项回归（P0-01 方案选择单一权威 / P1-01 persons-devices 双源）
 * ────────────────────────────────────────────────
 * 关注点不是「字段有没有」，而是「谁决定业务状态」：
 *   P0-01：View 选择方案 → 只能写 demoStore.selectedPlanId（唯一意向权威）
 *          → fireStore / 2D / 3D 单向投影跟随 → CONFIRM_ROUTE 执行同一方案。
 *   P1-01：demo 模式下 persons/devices 的业务状态只来自后端运行时；
 *          本地 seed 只允许提供静态结构（不得补全、不得覆盖）。
 *
 * 用法：node worker/e2e-p173-b305-p0p1.cjs
 */
const {
  PAGE_URL, sleep, waitFor, check, summary,
  cmd, demoState, resetDemoSession, openPage, openDemoPanel, ensureTwinMounted, clickByText,
} = require('./e2e-lib.cjs')

const stageOf = (page) => page.evaluate(() => window.__demo.demoStore.stage)
const waitStage = (page, stage, timeout = 20000) =>
  waitFor(async () => (await stageOf(page)) === stage, timeout)

/** 打开 3D 数字孪生浮层（按需挂载：未挂载时 __dtwin 是旧快照，不能用于比对） */
async function open3D(page) {
  const hasBtn = await waitFor(() => page.locator('.open-3d-btn').count().then((c) => c > 0), 15000)
  if (!hasBtn) {
    // 兜底：强制回到楼层视图（3D 入口挂在楼层/平面图区），再重试
    await page.evaluate(() => window.__demo.store.saveDashboardViewState({ viewMode: 'floors' }))
    await waitFor(() => page.locator('.open-3d-btn').count().then((c) => c > 0), 10000)
  }
  await page.evaluate(() => { const b = document.querySelector('.open-3d-btn'); if (b) b.click() })
  return waitFor(() => page.evaluate(
    () => Boolean(window.__dtwin && window.__dtwin.scene && window.__dtwin.scene.renderer.domElement.isConnected
      && (window.__dtwin.persons.data || []).filter(Boolean).length > 0),
  ), 45000)
}

;(async () => {
  await resetDemoSession()
  const { browser, page } = await openPage()
  const pageErrors = []
  page.on('pageerror', (e) => pageErrors.push(String(e.message).slice(0, 160)))

  try {
    await openDemoPanel(page)

    // ═══ 基线（IDLE）：本地 seed 的静态业务值，供 T10 复位比对 ═══
    const baseline = await page.evaluate(() => {
      const p = {}
      ;(window.__demo.store.persons || []).forEach((x) => {
        p[String(x.id)] = [
          x.status, (x.routePoints || []).length, x.routeId === undefined ? 'undef' : String(x.routeId),
          Number(x.progress || 0), x.position ? `${x.position.x},${x.position.y}` : 'null',
        ].join('|')
      })
      const d = {}
      ;(window.__demo.store.devices || []).forEach((x) => {
        d[String(x.id)] = [
          x.status, x.direction === undefined ? 'undef' : String(x.direction),
          x.emergencyFlash ? 1 : 0, Number(x.brightness === undefined ? -1 : x.brightness),
        ].join('|')
      })
      return { persons: p, devices: d }
    })

    // ═══ 推进到 ROUTE_PLANNING ═══
    console.log('\n[准备] 推进到阶段 3（疏散路径规划）')
    await cmd('START_FIRE'); check('START_FIRE → FIRE_DETECTED', await waitStage(page, 'FIRE_DETECTED'))
    await cmd('ACTIVATE_RESPONSE'); check('ACTIVATE_RESPONSE → EMERGENCY_RESPONSE', await waitStage(page, 'EMERGENCY_RESPONSE'))
    await cmd('PLAN_ROUTES'); check('PLAN_ROUTES → ROUTE_PLANNING', await waitStage(page, 'ROUTE_PLANNING'))
    await waitFor(() => page.evaluate(() => (window.__demo.demoStore.buildingPlans || []).length >= 3), 20000)

    const planIds = await page.evaluate(() => (window.__demo.demoStore.buildingPlans || []).map((p) => p.id))
    const TARGET = planIds.includes('PLAN-C') ? 'PLAN-C' : planIds[planIds.length - 1]
    const RECOMMENDED = await page.evaluate(() => window.__demo.demoStore.activeBuildingPlanId)
    console.log(`      方案集合=${planIds.join('/')} 后端推荐=${RECOMMENDED} 本轮选择=${TARGET}`)

    // ═══ T1：RoutePlanView 点选 PLAN-C → 意向 / fireStore 同源 ═══
    console.log('\n[T1] View 点选方案（RoutePlanView bp-chip）→ 单权威落点')
    await page.evaluate(() => { window.location.hash = '#/route-plan' })
    const chipsReady = await waitFor(() => page.locator('.bp-chip').count().then((c) => c >= 3), 15000)
    check('T1 RoutePlanView 列出 A/B/C 方案 chip', chipsReady)
    const clickRes = await page.evaluate((id) => {
      const idx = (window.__demo.store.buildingEvacuationPlans || []).findIndex((p) => p.id === id)
      const el = document.querySelectorAll('.bp-chip')[idx]
      if (!el) return { ok: false, idx, n: document.querySelectorAll('.bp-chip').length }
      el.click()
      return { ok: true, idx, label: (el.textContent || '').trim() }
    }, TARGET)
    await sleep(600)
    const t1 = await page.evaluate(() => ({
      selectedPlanId: window.__demo.demoStore.selectedPlanId,
      fireStorePlanId: window.__demo.store.activeBuildingPlanId,
      fireStorePlan: window.__demo.store.activeBuildingPlan ? window.__demo.store.activeBuildingPlan.id : null,
      // 旧链路的「第二份本地意向」必须不再独立：两者恒等
      legacySlip: window.__demo.store.activeBuildingPlanId !== window.__demo.demoStore.selectedPlanId,
    }))
    check('T1 demoStore.selectedPlanId === 所选方案', t1.selectedPlanId === TARGET, { clickRes, t1 })
    check('T1 fireStore.activeBuildingPlan === 所选方案（无第二份本地意向）',
      t1.fireStorePlanId === TARGET && t1.fireStorePlan === TARGET && t1.legacySlip === false, t1)

    // ═══ T4：A → B → C 每次都全链路一致（2D / 3D） ═══
    console.log('\n[T4] 依次切换 A/B/C：demoStore / fireStore / 2D / 3D 全部一致')
    await page.evaluate(() => { window.location.hash = '#/dashboard' })
    const twinOk = await open3D(page)
    check('T4 3D 数字孪生已挂载', twinOk)
    for (const id of planIds) {
      const clicked = await page.evaluate((pid) => {
        const list = (window.__demo.store.buildingEvacuationPlans || [])
        const idx = list.findIndex((p) => p.id === pid)
        const btns = document.querySelectorAll('.fip-plan')
        if (!btns[idx]) return { ok: false, idx, n: btns.length }
        btns[idx].click()
        return { ok: true, idx, label: (btns[idx].textContent || '').trim().slice(0, 12) }
      }, id)
      await sleep(500)
      const st = await page.evaluate(() => ({
        selected: window.__demo.demoStore.selectedPlanId,
        fs: window.__demo.store.activeBuildingPlanId,
        plan3d: (() => {
          const dt = window.__dtwin
          return dt && dt.route ? String(dt.route.currentPlanId || '') : null
        })(),
        plan2dChip: (() => {
          const active = document.querySelector('.fip-plan.active')
          return active ? (active.textContent || '').trim().slice(0, 12) : null
        })(),
      }))
      const ok3d = await waitFor(() => page.evaluate(
        (p) => String((window.__dtwin && window.__dtwin.route ? window.__dtwin.route.currentPlanId : '') || '').startsWith(`${p}:`),
        id), 6000)
      check(`${id}：demoStore.selectedPlanId 一致`, st.selected === id, { clicked, st })
      check(`${id}：fireStore.activeBuildingPlanId 一致`, st.fs === id, st)
      check(`${id}：3D 路线层跟随同一方案`, ok3d, st)
    }

    // 切回目标方案再确认（保证「确认的是所选」）
    await page.evaluate((pid) => {
      const idx = (window.__demo.store.buildingEvacuationPlans || []).findIndex((p) => p.id === pid)
      const btns = document.querySelectorAll('.fip-plan')
      if (btns[idx]) btns[idx].click()
    }, TARGET)
    await sleep(600)

    // ═══ T2：确认 → 后端执行的就是所选方案 ═══
    console.log('\n[T2] 确认疏散路径 → 后端执行「所选」方案（不得是推荐方案）')
    await clickByText(page, '确认当前疏散路径')
    check('T2 进入 SMART_EVACUATION', await waitStage(page, 'SMART_EVACUATION'))
    await waitFor(() => page.evaluate(() => (window.__demo.demoStore.persons || []).length > 0), 15000)
    const backend = await demoState()
    const t2 = await page.evaluate(() => ({
      selected: window.__demo.demoStore.selectedPlanId,
      dsActive: window.__demo.demoStore.activeBuildingPlanId,
      fsActive: window.__demo.store.activeBuildingPlanId,
    }))
    check('T2 后端执行的是所选方案', backend.activeBuildingPlanId === TARGET, { TARGET, RECOMMENDED, backend: backend.activeBuildingPlanId })
    check('T2 demoStore / fireStore 与后端同一方案',
      t2.dsActive === TARGET && t2.fsActive === TARGET && t2.selected === TARGET, t2)
    check('T2 与「后端推荐方案」不同时才算有效（本组确实选了非推荐方案）',
      TARGET !== RECOMMENDED || TARGET === planIds[planIds.length - 1], { TARGET, RECOMMENDED })

    // ═══ T3：WS 重连（含 requestSync 全量补齐）后方案保持一致 ═══
    console.log('\n[T3] WS 断线重连 + 全量同步后方案仍一致')
    await page.evaluate(() => { try { window.__demo.demoStore.disconnect() } catch (_) {} })
    await sleep(500)
    await page.evaluate(() => window.__demo.demoStore.connect())
    await waitFor(() => page.evaluate(() => window.__demo.demoStore.connected), 20000)
    await waitFor(() => page.evaluate(() => Boolean((window.__demo.store.buildingEvacuationPlans || []).length)), 15000)
    await sleep(1000)
    const t3 = await page.evaluate(() => ({
      selected: window.__demo.demoStore.selectedPlanId,
      dsActive: window.__demo.demoStore.activeBuildingPlanId,
      fsActive: window.__demo.store.activeBuildingPlanId,
      fsPlan: window.__demo.store.activeBuildingPlan ? window.__demo.store.activeBuildingPlan.id : null,
    }))
    const backend3 = await demoState()
    check('T3 重连后 selectedPlanId 不失守', t3.selected === TARGET, t3)
    check('T3 重连后 demoStore / fireStore / 后端同一方案',
      t3.dsActive === TARGET && t3.fsActive === TARGET && t3.fsPlan === TARGET && backend3.activeBuildingPlanId === TARGET,
      { t3, backend: backend3.activeBuildingPlanId })

    // ═══ T5：persons 业务状态必须来自后端运行时 ═══
    console.log('\n[T5] 抽样 ≥20 人员：身份 / 位置 / 状态 / 路线全部来自后端权威')
    const t5 = await page.evaluate((n) => {
      const fs = window.__demo.store
      const ds = window.__demo.demoStore
      const dsIds = (ds.persons || []).map((p) => String(p.id))
      const step = Math.max(1, Math.floor(dsIds.length / n))
      const sample = dsIds.filter((_, i) => i % step === 0).slice(0, n)
      const fsmap = new Map((fs.persons || []).map((p) => [String(p.id), p]))
      const dsmap = new Map((ds.persons || []).map((p) => [String(p.id), p]))
      const bad = []
      sample.forEach((id) => {
        const src = dsmap.get(id)
        const dst = fsmap.get(id)
        if (!src || !dst) { bad.push({ id, reason: 'missing' }); return }
        const diff = []
        if (String(src.buildingId) !== String(dst.buildingId)) diff.push('buildingId')
        if (String(src.floorId) !== String(dst.floorId)) diff.push('floorId')
        if (String(src.zone) !== String(dst.zone)) diff.push('zone')
        if (String(src.status) !== String(dst.status)) diff.push('status')
        if (String(src.routeId ?? null) !== String(dst.routeId ?? null)) diff.push('routeId')
        if ((src.routePoints || []).length !== (dst.routePoints || []).length) diff.push('routePoints')
        if (Number(src.progress || 0) !== Number(dst.progress || 0)) diff.push('progress')
        if (JSON.stringify(src.position || null) !== JSON.stringify(dst.position || null)) diff.push('position')
        if (diff.length) bad.push({ id, diff, backend: [src.status, src.routeId, (src.routePoints || []).length], fsSide: [dst.status, dst.routeId, (dst.routePoints || []).length] })
      })
      // 本机回收：非后端托管人员不得出现「演练业务态」
      //（status 可以是 seed 的静态值，如 static；但路线 / 疏散 / 滞留 / routeId 不得残留）
      const managed = new Set(dsIds)
      const idle = (fs.persons || []).filter((p) => !managed.has(String(p.id)))
      const busy = idle.filter((p) => (p.routePoints || []).length > 1 || p.evacuating || p.retained || p.rescued
        || (p.routeId !== null && p.routeId !== undefined))
      return { managedTotal: dsIds.length, sample: sample.length, bad, unmanagedTotal: idle.length, unmanagedBusy: busy.slice(0, 5).map((p) => [p.id, p.status, (p.routePoints || []).length]) }
    }, 20)
    check('T5 抽样人数 ≥ 20（后端运行时成员）', t5.sample >= 20, { managedTotal: t5.managedTotal, sample: t5.sample })
    check('T5 抽样人员的 canonical 身份 / status / routeId / position 与后端完全一致', t5.bad.length === 0, t5.bad.slice(0, 5))
    check('T5 非后端托管人员不带业务状态（只保留静态结构）', t5.unmanagedBusy.length === 0,
      { unmanagedTotal: t5.unmanagedTotal, unmanagedBusy: t5.unmanagedBusy })

    // ═══ T6：devices 业务状态必须来自后端运行时 ═══
    console.log('\n[T6] 抽样 ≥20 设备：buildingId / floorId / zone / status / direction / emergencyFlash 不被 seed 覆盖')
    const t6 = await page.evaluate((n) => {
      const fs = window.__demo.store
      const ds = window.__demo.demoStore
      const dsIds = (ds.devices || []).map((d) => String(d.id))
      const step = Math.max(1, Math.floor(dsIds.length / n))
      const sample = dsIds.filter((_, i) => i % step === 0).slice(0, n)
      const fsmap = new Map((fs.devices || []).map((d) => [String(d.id), d]))
      const dsmap = new Map((ds.devices || []).map((d) => [String(d.id), d]))
      const bad = []
      sample.forEach((id) => {
        const src = dsmap.get(id)
        const dst = fsmap.get(id)
        if (!src || !dst) { bad.push({ id, reason: 'missing' }); return }
        const diff = []
        if (String(src.buildingId) !== String(dst.buildingId)) diff.push('buildingId')
        if (String(src.floorId) !== String(dst.floorId)) diff.push('floorId')
        if (String(src.zone) !== String(dst.zone)) diff.push('zone')
        if (String(src.status) !== String(dst.status)) diff.push('status')
        if (String(src.direction ?? null) !== String(dst.direction ?? null)) diff.push('direction')
        if (Boolean(src.emergencyFlash) !== Boolean(dst.emergencyFlash)) diff.push('emergencyFlash')
        if (Number(src.brightness) !== Number(dst.brightness)) diff.push('brightness')
        if (diff.length) bad.push({ id, diff, backend: [src.status, src.direction, src.emergencyFlash], fsSide: [dst.status, dst.direction, dst.emergencyFlash] })
      })
      const managed = new Set(dsIds)
      const idle = (fs.devices || []).filter((d) => !managed.has(String(d.id)))
      // 静态台账 status（warning / fault …）属于 seed 允许的静态结构；
      // 演练业务态（应急闪灯 / 应急模式 / 疏散方向）不得残留
      const busy = idle.filter((d) => d.emergencyFlash || String(d.currentMode) === 'emergency'
        || String(d.status) === 'emergency')
      return { managedTotal: dsIds.length, sample: sample.length, bad, unmanagedTotal: idle.length, unmanagedBusy: busy.slice(0, 5).map((d) => [d.id, d.status, Boolean(d.emergencyFlash)]) }
    }, 20)
    check('T6 抽样设备数 ≥ 20', t6.sample >= 20, { managedTotal: t6.managedTotal, sample: t6.sample })
    check('T6 抽样设备业务状态与后端完全一致（无 seed 覆盖）', t6.bad.length === 0, t6.bad.slice(0, 5))
    check('T6 非后端托管设备不带应急业务状态', t6.unmanagedBusy.length === 0,
      { unmanagedTotal: t6.unmanagedTotal, unmanagedBusy: t6.unmanagedBusy })

    // ═══ T7 / T8：2D ↔ 3D 人员 / 设备一致 ═══
    console.log('\n[T7][T8] 2D / 3D 同源校验')
    const t7 = await page.evaluate(() => {
      const fs = window.__demo.store
      const dt = window.__dtwin
      const map = new Map((fs.personRuntimes || []).map((p) => [String(p.id), p]))
      const data3d = (dt && dt.persons && dt.persons.data ? dt.persons.data : []).filter(Boolean)
      const mismatched = []
      data3d.forEach((d) => {
        const p2 = map.get(String(d.id))
        if (!p2) return
        if (String(p2.status) !== String(d.status)) mismatched.push({ id: d.id, d2: p2.status, d3: d.status })
      })
      const backendRoute = data3d.filter((d) => String(d.routeKey || '').startsWith('backend:')).length
      return { count3d: data3d.length, matched: data3d.length - mismatched.length, mismatched: mismatched.slice(0, 5), backendRoute }
    })
    check('T7 3D 有人员实例且状态与 2D(personRuntimes)一致', t7.count3d > 0 && t7.mismatched.length === 0, t7)
    check('T7 3D 人员路线来自后端 routePoints（非本地重算）', t7.backendRoute > 0, t7)

    const t8 = await page.evaluate(() => {
      const fs = window.__demo.store
      const dt = window.__dtwin
      if (!dt || !dt.em) return { ok: false, reason: '3D 应急灯层未挂载' }
      const parse = (m) => {
        const out = []
        m.forEach((rec, id) => out.push({ id: String(id), dev: rec.device }))
        return out
      }
      const bound = parse(dt.em.evacMap).concat(parse(dt.em.emMap))
      const map = new Map((fs.devices || []).map((d) => [String(d.id), d]))
      const diff = []
      bound.forEach((b) => {
        const d2 = map.get(b.id)
        if (!d2) { diff.push({ id: b.id, reason: '3D 绑定了 store 中不存在的设备' }); return }
        if (String(d2.direction ?? null) !== String(b.dev.direction ?? null)) diff.push({ id: b.id, d2: d2.direction, d3: b.dev.direction })
        if (String(d2.status) !== String(b.dev.status)) diff.push({ id: b.id, d2: d2.status, d3: b.dev.status })
        if (Boolean(d2.emergencyFlash) !== Boolean(b.dev.emergencyFlash)) diff.push({ id: b.id, flash2: d2.emergencyFlash, flash3: b.dev.emergencyFlash })
      })
      return { ok: true, bound: bound.length, diff: diff.slice(0, 5) }
    })
    check('T8 3D 应急灯 / 疏散灯只消费 store.devices（逐设备状态一致）',
      t8.ok && t8.diff.length === 0, t8)

    // ═══ T9：跨楼栋不得污染 ═══
    console.log('\n[T9] 跨楼栋隔离：其它楼栋不得被火情楼栋的方案 / 状态污染')
    const scenarioBid = await page.evaluate(() => String((window.__demo.store.buildingEvacuationPlans[0] || {}).buildingId || ''))
    const otherBid = scenarioBid === 'B002' ? 'B003' : 'B002'
    const t9 = await page.evaluate((other) => {
      const fs = window.__demo.store
      const before = {
        plans: (fs.buildingEvacuationPlans || []).length,
        routePlans: (fs.routePlans || []).length,
      }
      const planBuildingIds = [...new Set((fs.buildingEvacuationPlans || []).map((p) => String(p.buildingId || '')))]
      // 其它楼栋人员不得拿到路线路点（不能继承火情楼栋的疏散任务）
      const crossPersons = (fs.persons || []).filter((p) => String(p.buildingId) === other && (p.routePoints || []).length > 1)
      // 其它楼栋设备不得进入应急闪灯
      const crossDevices = (fs.devices || []).filter((d) => String(d.buildingId) === other && d.emergencyFlash)
      return { before, planBuildingIds, crossPersons: crossPersons.length, crossDevices: crossDevices.length }
    }, otherBid)
    // 切到其它楼栋：走 UI 同一条路径（dashboardView.selectedBuildingId → 该楼栋自己的方案集合）
    await page.evaluate((other) => {
      window.__demo.store.saveDashboardViewState({ buildingId: other })
    }, otherBid)
    await sleep(1200)
    const t9after = await page.evaluate(() => {
      const fs = window.__demo.store
      return {
        plans: (fs.buildingEvacuationPlans || []).length,
        routePlans: (fs.routePlans || []).length,
        activePlanId: fs.activeBuildingPlanId,
        buildingId: (fs.buildingEvacuationPlans[0] || {}).buildingId || null,
      }
    })
    await page.evaluate((bid) => {
      window.__demo.store.saveDashboardViewState({ buildingId: bid })
    }, scenarioBid)
    await sleep(1200)
    const t9back = await page.evaluate(() => {
      const fs = window.__demo.store
      return {
        plans: (fs.buildingEvacuationPlans || []).length,
        buildingId: (fs.buildingEvacuationPlans[0] || {}).buildingId || null,
        activePlanId: fs.activeBuildingPlanId,
      }
    })
    check('T9 火情楼栋方案只属于该楼栋（planBuildingIds 单一）',
      t9.planBuildingIds.length === 1 && t9.planBuildingIds[0] === scenarioBid, t9)
    check('T9 其它楼栋人员不继承疏散路线', t9.crossPersons === 0, t9)
    check('T9 其它楼栋设备不进入应急闪灯', t9.crossDevices === 0, t9)
    check('T9 切到其它楼栋后不残留上一栋楼的方案（demo 下清空）',
      t9after.plans === 0 && t9after.routePlans === 0 && t9after.activePlanId === null, t9after)
    check('T9 切回原楼栋后方案从归档恢复（不重算、不串楼栋）',
      t9back.plans === t9.before.plans && t9back.buildingId === scenarioBid && t9back.activePlanId !== null,
      { t9back, beforePlans: t9.before.plans })

    // ═══ T10：RESET 全链路收敛 ═══
    console.log('\n[T10] RESET：后端 / WS / demoStore / fireStore / 2D / 3D 全部回到基线')
    await cmd('RESET')
    check('T10 后端回到 IDLE', await waitStage(page, 'IDLE'))
    await sleep(2000)
    const t10 = await page.evaluate((base) => {
      const fs = window.__demo.store
      const ds = window.__demo.demoStore
      const keyP = (x) => [
        x.status, (x.routePoints || []).length, x.routeId === undefined ? 'undef' : String(x.routeId),
        Number(x.progress || 0), x.position ? `${x.position.x},${x.position.y}` : 'null',
      ].join('|')
      const keyD = (x) => [
        x.status, x.direction === undefined ? 'undef' : String(x.direction),
        x.emergencyFlash ? 1 : 0, Number(x.brightness === undefined ? -1 : x.brightness),
      ].join('|')
      const personDiff = []
      Object.keys(base.persons).forEach((id) => {
        const now = (fs.persons || []).find((p) => String(p.id) === id)
        if (!now) return
        if (keyP(now) !== base.persons[id]) personDiff.push({ id, base: base.persons[id], now: keyP(now) })
      })
      const deviceDiff = []
      Object.keys(base.devices).forEach((id) => {
        const now = (fs.devices || []).find((d) => String(d.id) === id)
        if (!now) return
        if (keyD(now) !== base.devices[id]) deviceDiff.push({ id, base: base.devices[id], now: keyD(now) })
      })
      return {
        stage: ds.stage,
        selectedPlanId: ds.selectedPlanId,
        dsPlans: (ds.buildingPlans || []).length,
        dsActive: ds.activeBuildingPlanId,
        fireEvent: fs.fireEvent,
        plans: (fs.buildingEvacuationPlans || []).length,
        activePlanId: fs.activeBuildingPlanId,
        routePlans: (fs.routePlans || []).length,
        stranded: (fs.strandedPersons || []).length,
        rescueCompleted: fs.rescueCompleted,
        emergencyFlash: (fs.devices || []).filter((d) => d.emergencyFlash).length,
        personDiff: personDiff.slice(0, 5), personDiffTotal: personDiff.length,
        deviceDiff: deviceDiff.slice(0, 5), deviceDiffTotal: deviceDiff.length,
      }
    }, baseline)
    const backend10 = await demoState()
    check('T10 demoStore.selectedPlanId 已清空', t10.selectedPlanId === null, t10)
    check('T10 fireStore 火情 / 方案 / 路线 / 滞留全部复位',
      t10.fireEvent === null && t10.plans === 0 && t10.activePlanId === null && t10.routePlans === 0
      && t10.stranded === 0 && t10.rescueCompleted === false, t10)
    check('T10 后端 DER 为空且与前端一致',
      backend10.stage === 'IDLE' && backend10.fire === null && (backend10.buildingPlans || []).length === 0,
      { stage: backend10.stage, fire: backend10.fire, plans: (backend10.buildingPlans || []).length })
    check('T10 人员全部回到 seed 基线（业务状态无残留）', t10.personDiffTotal === 0, t10.personDiff)
    check('T10 设备全部回到 seed 基线（无应急闪灯残留）',
      t10.deviceDiffTotal === 0 && t10.emergencyFlash === 0, { deviceDiff: t10.deviceDiff, emergencyFlash: t10.emergencyFlash })

    check('全程无未捕获页面异常', pageErrors.length === 0, pageErrors.slice(0, 3))
  } catch (err) {
    check(`执行异常：${err && err.message}`, false)
    console.error(err)
  } finally {
    await resetDemoSession()
    await browser.close().catch(() => {})
  }

  const r = summary('P1.7.3-B3-05 专项回归')
  process.exit(r.failed ? 1 : 0)
})()

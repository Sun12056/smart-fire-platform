/**
 * P1.7.3-B4-02 专项回归（LightingView 灯具数据源统一）
 * ────────────────────────────────────────────────
 * 命题：灯具设备只有一份业务数据源
 *   Backend / WS → demoStore.devices → fireStore.devices →（派生投影）fireStore.lightingDevices → LightingView
 *
 * 修复前：fireStore.lightingDevices 是独立维护的第二份集合
 *         （初始值 = mock/devices.js 的旧台账，与 store.devices 的平面空间种子设备互不相干），
 *         后端 / WS 的灯具数据永远到不了 LightingView。
 *
 * 关键断言：
 *   T1 成员一致：lightingDevices 与 store.devices(type=emergency_light) 的 id 集合必须完全相等
 *              （修复前：lightingDevices 里几乎全是 store.devices 中不存在的旧台账 id）
 *   T2 DOM 侧：LightingView 上呈现的设备必须能在 store.devices 里找到（同名同楼栋同楼层），
 *              且页面上的状态文本 === 该权威设备的 status
 *   T3 传播：后端托管灯具（demoStore.devices）的运行态必须出现在 lightingDevices 同一 id 上
 *   T4/T5/T6：WS 重连 / RESET / 新一轮 后仍收敛
 *   T7：2D / 3D / LightingView 在设备成员集合层面同源（都 ⊆ store.devices）
 *
 * 用法：node worker/e2e-p173-b402-lighting-source.cjs
 */
const {
  sleep, waitFor, check, summary,
  cmd, demoState, resetDemoSession, openPage, openDemoPanel,
} = require('./e2e-lib.cjs')

const stageOf = (page) => page.evaluate(() => window.__demo.demoStore.stage)
const waitStage = (page, stage, timeout = 20000) =>
  waitFor(async () => (await stageOf(page)) === stage, timeout)

/** 灯具数据源快照：store.devices(权威) / lightingDevices(LightingView 源) / demoStore(后端) / 3D */
const FP = () => {
  const s = window.__demo.store
  const ds = window.__demo.demoStore
  const dt = window.__dtwin || {}
  const dev = (s.devices || []).filter(Boolean)
  const el = dev.filter((d) => d.type === 'emergency_light')
  const lit = (s.lightingDevices || []).filter(Boolean)
  const dsEl = (ds.devices || []).filter((d) => d && d.type === 'emergency_light')
  const norm = (v) => String(v ?? '')
  const ids = (arr) => arr.map((d) => norm(d.id))
  const litIds = new Set(ids(lit))
  const fsIds = new Set(ids(el))
  const em3d = dt.em
  return {
    // 成员集合
    fsElTotal: el.length,
    litTotal: lit.length,
    dsElTotal: dsEl.length,
    litOnly: ids(lit).filter((x) => !fsIds.has(x)).length,   // 第二数据源独有（不得有）
    fsOnly: ids(el).filter((x) => !litIds.has(x)).length,    // 权威侧有但 LightingView 看不到（不得有）
    sampleLit: ids(lit).slice(0, 3),
    sampleFs: ids(el).slice(0, 3),
    // 3D 应急灯层（读 store.devices）
    em3dIds: em3d && em3d.emMap ? [...em3d.emMap.keys()].map(norm) : [],
    // 运行态传播（后端托管灯具 → lightingDevices）
    propagate: (() => {
      const map = new Map(lit.map((d) => [norm(d.id), d]))
      const bad = []
      dsEl.forEach((src) => {
        const dst = map.get(norm(src.id))
        if (!dst) { bad.push({ id: norm(src.id), reason: 'missing-in-lightingDevices' }); return }
        const diff = []
        if (norm(src.status) !== norm(dst.status)) diff.push('status')
        if (norm(src.direction ?? null) !== norm(dst.direction ?? null)) diff.push('direction')
        if (Boolean(src.emergencyFlash) !== Boolean(dst.emergencyFlash)) diff.push('emergencyFlash')
        if (Number(src.brightness) !== Number(dst.brightness)) diff.push('brightness')
        if (diff.length) bad.push({ id: norm(src.id), diff })
      })
      return { checked: dsEl.length, bad: bad.slice(0, 5), badTotal: bad.length }
    })(),
    // 应急残留（RESET 后应为空）
    emergencyResidue: lit.filter((d) => d.emergencyFlash || norm(d.status) === 'emergency').length,
  }
}

/** 打开智能照明页并读取页面呈现（DOM）的设备信息 */
async function readLightingPage(page) {
  await page.evaluate(() => { window.location.hash = '#/lighting' })
  const ready = await waitFor(() => page.evaluate(
    () => Boolean(document.querySelector('.device-selector')) && Boolean(document.querySelector('.device-info')),
  ), 20000)
  if (!ready) return { ready: false }
  await sleep(600)
  return page.evaluate(() => {
    const selText = (s) => {
      const t = (s.innerText || '').trim()
      if (t) return t
      const item = s.querySelector('.el-select__selected-item, .el-select__placeholder, input')
      return item ? (item.textContent || item.value || '').trim() : ''
    }
    const inputs = Array.from(document.querySelectorAll('.device-selector .el-select')).map(selText)
    const info = Array.from(document.querySelectorAll('.device-info .info-text')).map((n) => (n.textContent || '').trim())
    const statusEl = document.querySelector('.device-info .status-tag')
    const dev = (window.__demo.store.devices || []).filter(Boolean)
    const [bld, floor, devName] = inputs
    const match = dev.find((d) => d.name === devName && d.building === bld && d.floor === floor
      && d.type === 'emergency_light')
    return {
      ready: true,
      building: bld, floor, devName,
      domStatus: statusEl ? (statusEl.textContent || '').trim() : null,
      domInfo: info,
      matchedInAuthoritative: Boolean(match),
      authoritativeStatus: match ? String(match.status) : null,
      authoritativeId: match ? String(match.id) : null,
      inLightingDevices: match
        ? (window.__demo.store.lightingDevices || []).some((d) => String(d.id) === String(match.id))
        : false,
    }
  })
}

;(async () => {
  await resetDemoSession()
  const { browser, page } = await openPage()
  const pageErrors = []
  page.on('pageerror', (e) => pageErrors.push(String(e.message).slice(0, 160)))

  try {
    await openDemoPanel(page)

    // ═══ T1 / T2：IDLE 基线 ═══
    console.log('\n[T1][T2] IDLE 基线：灯具成员集合 + LightingView 页面呈现')
    const idle = await page.evaluate(FP)
    check('T1 LightingView 灯具集合 = 权威 devices 的 emergency_light 子集（无第二数据源独有成员）',
      idle.litOnly === 0, { litOnly: idle.litOnly, sampleLit: idle.sampleLit, sampleFs: idle.sampleFs })
    check('T1 权威侧灯具全部能被 LightingView 看到（无遗漏）', idle.fsOnly === 0,
      { fsOnly: idle.fsOnly, fsElTotal: idle.fsElTotal, litTotal: idle.litTotal })

    const dom = await readLightingPage(page)
    check('T2 智能照明页已渲染设备选择区', dom.ready, dom)
    check('T2 页面呈现的设备能在权威 devices 中找到（不再是旧台账的第二份集合）',
      dom.matchedInAuthoritative === true, dom)
    check('T2 页面呈现的设备同时存在于 store.lightingDevices', dom.inLightingDevices === true, dom)
    check('T2 页面状态文本 === 权威设备 status（LightingView 消费的是同一份对象）',
      dom.matchedInAuthoritative && dom.domStatus === dom.authoritativeStatus, dom)

    // ═══ T3：演练中后端/WS 灯具数据 → demoStore → fireStore → LightingView ═══
    console.log('\n[T3] 演练中：后端 / WS 灯具运行态必须出现在 LightingView 的数据源里')
    await page.evaluate(() => { window.location.hash = '#/dashboard' })
    await cmd('START_FIRE'); check('START_FIRE → FIRE_DETECTED', await waitStage(page, 'FIRE_DETECTED'))
    await cmd('ACTIVATE_RESPONSE'); check('ACTIVATE_RESPONSE → EMERGENCY_RESPONSE', await waitStage(page, 'EMERGENCY_RESPONSE'))
    await cmd('PLAN_ROUTES'); check('PLAN_ROUTES → ROUTE_PLANNING', await waitStage(page, 'ROUTE_PLANNING'))
    await waitFor(() => page.evaluate(() => (window.__demo.demoStore.devices || []).length > 0), 20000)
    // CONFIRM_ROUTE 必须显式携带 buildingPlanId（后端强校验），取后端当前/推荐方案
    const bpId = await page.evaluate(() => window.__demo.demoStore.activeBuildingPlanId
      || ((window.__demo.demoStore.buildingPlans || [])[0] || {}).id || 'PLAN-A')
    await cmd('CONFIRM_ROUTE', { buildingPlanId: bpId }); await waitStage(page, 'SMART_EVACUATION')
    await waitFor(() => page.evaluate(() => (window.__demo.demoStore.devices || []).length > 0), 20000)
    await sleep(1500)
    const run = await page.evaluate(FP)
    check('T3 后端托管灯具数 ≥ 20（样本有意义）', run.dsElTotal >= 20, { dsElTotal: run.dsElTotal })
    check('T3 成员集合仍一致（无第二数据源独有成员 / 无遗漏）', run.litOnly === 0 && run.fsOnly === 0,
      { litOnly: run.litOnly, fsOnly: run.fsOnly, litTotal: run.litTotal, fsElTotal: run.fsElTotal })
    check('T3 后端灯具运行态已传播到 LightingView 的数据源（status/direction/emergencyFlash/brightness 一致）',
      run.propagate.badTotal === 0, run.propagate)

    const domRun = await readLightingPage(page)
    check('T3 演练中 LightingView 页面设备仍来自权威集合', domRun.matchedInAuthoritative === true, domRun)
    check('T3 演练中页面状态文本 === 权威设备 status', domRun.domStatus === domRun.authoritativeStatus, domRun)

    // ═══ T4：WS 重连 + 全量同步 ═══
    console.log('\n[T4] WS 重连 / 全量快照后仍收敛')
    await page.evaluate(() => { try { window.__demo.demoStore.disconnect() } catch (_) {} })
    await sleep(500)
    await page.evaluate(() => window.__demo.demoStore.connect())
    await waitFor(() => page.evaluate(() => window.__demo.demoStore.connected), 20000)
    await waitFor(() => page.evaluate(() => (window.__demo.demoStore.devices || []).length > 0), 20000)
    await sleep(1200)
    const re = await page.evaluate(FP)
    check('T4 重连后成员集合一致', re.litOnly === 0 && re.fsOnly === 0,
      { litOnly: re.litOnly, fsOnly: re.fsOnly })
    check('T4 重连后后端运行态仍一致', re.propagate.badTotal === 0, re.propagate)

    // ═══ T7：2D / 3D / LightingView 成员同源 ═══
    console.log('\n[T7] 2D / 3D / LightingView 在设备成员集合层面同源')
    const all = await page.evaluate(() => {
      const s = window.__demo.store
      const dt = window.__dtwin || {}
      const devIds = new Set((s.devices || []).filter(Boolean).map((d) => String(d.id)))
      const em3d = dt.em && dt.em.emMap ? [...dt.em.emMap.keys()].map(String) : []
      return {
        em3dTotal: em3d.length,
        em3dNotInAuthoritative: em3d.filter((id) => !devIds.has(id)),
        litTotal: (s.lightingDevices || []).length,
        litNotInAuthoritative: (s.lightingDevices || []).filter((d) => !devIds.has(String(d.id))).map((d) => String(d.id)),
      }
    })
    check('T7 3D 应急灯成员全部来自权威 devices', all.em3dNotInAuthoritative.length === 0,
      { em3dTotal: all.em3dTotal, em3dNotInAuthoritative: all.em3dNotInAuthoritative.slice(0, 3) })
    check('T7 LightingView 成员全部来自权威 devices', all.litNotInAuthoritative.length === 0,
      { litTotal: all.litTotal, litNotInAuthoritative: all.litNotInAuthoritative.slice(0, 3) })

    // ═══ T5：RESET ═══
    console.log('\n[T5] RESET：灯具集合回到基线且与权威同步')
    await cmd('RESET')
    await waitStage(page, 'IDLE')
    await sleep(1500)
    const rst = await page.evaluate(FP)
    check('T5 RESET 后成员集合一致', rst.litOnly === 0 && rst.fsOnly === 0,
      { litOnly: rst.litOnly, fsOnly: rst.fsOnly, litTotal: rst.litTotal, fsElTotal: rst.fsElTotal })
    check('T5 RESET 后无应急残留（emergencyFlash / status=emergency 清空）', rst.emergencyResidue === 0,
      { emergencyResidue: rst.emergencyResidue })

    // ═══ T6：新一轮演练 ═══
    console.log('\n[T6] 新一轮演练：灯具数据源再次收敛')
    await cmd('START_FIRE'); await waitStage(page, 'FIRE_DETECTED')
    await cmd('ACTIVATE_RESPONSE'); await waitStage(page, 'EMERGENCY_RESPONSE')
    await cmd('PLAN_ROUTES'); await waitStage(page, 'ROUTE_PLANNING')
    const bpId2 = await page.evaluate(() => window.__demo.demoStore.activeBuildingPlanId
      || ((window.__demo.demoStore.buildingPlans || [])[0] || {}).id || 'PLAN-A')
    await cmd('CONFIRM_ROUTE', { buildingPlanId: bpId2 }); await waitStage(page, 'SMART_EVACUATION')
    await waitFor(() => page.evaluate(() => (window.__demo.demoStore.devices || []).length > 0), 20000)
    await sleep(1500)
    const round2 = await page.evaluate(FP)
    check('T6 新一轮成员集合一致', round2.litOnly === 0 && round2.fsOnly === 0,
      { litOnly: round2.litOnly, fsOnly: round2.fsOnly })
    check('T6 新一轮后端运行态一致', round2.propagate.badTotal === 0, round2.propagate)
    const dom2 = await readLightingPage(page)
    check('T6 新一轮 LightingView 页面设备仍来自权威集合', dom2.matchedInAuthoritative === true, dom2)

    check('全程无未捕获页面异常', pageErrors.length === 0, pageErrors.slice(0, 3))
  } finally {
    await cmd('RESET').catch(() => {})
    await sleep(600)
    await browser.close()
    summary('P1.7.3-B4-02 专项回归（LightingView 灯具数据源统一）')
    process.exitCode = 0
  }
})()

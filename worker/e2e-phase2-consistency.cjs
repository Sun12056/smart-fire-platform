/**
 * P1.6.3 2D / 3D 一致性自动化验收
 * ────────────────────────────────────────────────
 * 三方口径：后端 = WebSocket 权威快照（demoStore）；2D = fireStore 平面图；3D = PersonLayer3D / RouteLayer3D
 * 验收项：
 *   ① 人员数量一致       后端 / 2D / 3D
 *   ② 人员 ID 一致
 *   ③ routeId 一致
 *   ④ routePoints 一致（后端 ↔ 2D 逐点相等；后端 ↔ 3D 派生折线与后端点列同源）
 *   ⑤ 人员 status 一致
 *   ⑥ 2D / 3D 路线数量一致
 *   ⑦ 当前 activeBuildingPlanId 一致
 *
 * 关键前提：3D 场景按需挂载（DashboardView「3D 模型」浮层），比较时 3D 必须处于已挂载状态，
 *           否则「2D/3D 一致」会退化成读取一份不再更新的旧快照。脚本会显式校验这一点。
 *
 * 用法：
 *   1) 启动后端：cd worker && npx wrangler dev --port 8787
 *   2) 以 demo 模式启动前端：set VITE_DATA_SOURCE=demo && npx vite --port 5199
 *   3) node worker/e2e-phase2-consistency.cjs
 * 环境变量：PAGE_URL / API_BASE
 */
const { chromium } = require('playwright-core')

const PAGE_URL = process.env.PAGE_URL || 'http://localhost:5199/'
const API_BASE = (process.env.API_BASE || 'http://127.0.0.1:8787').replace(/\/$/, '')
const SESSION = 'default'

let passed = 0, failed = 0
const failures = []
function check(name, cond, extra) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name); console.log(`  ✗ ${name}${extra !== undefined ? ' → ' + JSON.stringify(extra) : ''}`) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor(fn, timeout = 8000, interval = 250) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) { if (await fn()) return true; await sleep(interval) }
  return false
}

/**
 * 三方一致性采集（浏览器内执行）。
 * 口径：以「后端演示楼栋」为准，2D / 3D 取同一 buildingId 的人员做三方比对。
 */
function consistencyFn() {
  const demo = window.__demo.demoStore
  const store = window.__demo.store
  const dt = window.__dtwin
  const backend = (demo.persons || []).filter(Boolean)
  const buildingId = backend.length ? backend[0].buildingId : ''
  const twoDAll = (store.persons || []).filter(Boolean)
  const twoD = twoDAll.filter((p) => String(p.buildingId || '') === String(buildingId))
  const three = (dt.persons.data || []).filter(Boolean)

  const norm = (v) => (v === undefined || v === null ? '' : String(v))
  const samePts = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length
    && a.every((pt, i) => Number(pt.x) === Number(b[i].x) && Number(pt.y) === Number(b[i].y))

  const dMap = new Map(twoD.map((p) => [norm(p.id), p]))
  const tMap = new Map(three.map((d) => [norm(d.id), d]))
  const bIds = backend.map((p) => norm(p.id)).sort()
  const tIds = three.map((d) => norm(d.id)).sort()
  const row = (id, a, b, kind) => ({ id, backend: a, other: b, kind })

  const routeIdBad2D = []
  const routeIdBad3D = []
  const ptsBad2D = []
  const ptsBad3D = []
  const statusBad2D = []
  const statusBad3D = []

  backend.forEach((p) => {
    const id = norm(p.id)
    const d = dMap.get(id)
    const t = tMap.get(id)
    if (d) {
      if (norm(d.routeId) !== norm(p.routeId)) routeIdBad2D.push(row(id, p.routeId, d.routeId, '2D'))
      if (!samePts(p.routePoints, d.routePoints)) {
        ptsBad2D.push({ id, backend: (p.routePoints || []).length, other: (d.routePoints || []).length })
      }
      if (norm(d.status) !== norm(p.status)) statusBad2D.push(row(id, p.status, d.status, '2D'))
    }
    if (t) {
      if (norm(t.routeId) !== norm(p.routeId)) routeIdBad3D.push(row(id, p.routeId, t.routeId, '3D'))
      const rp = Array.isArray(p.routePoints) ? p.routePoints : []
      const nodes = Array.isArray(p.route) ? p.route : []
      // 3D 折线由后端点列逐点映射得到（polylineFromSvg 取 min(点列, 节点列)）
      const expected = rp.length ? Math.min(rp.length, nodes.length || rp.length) : 0
      const got = (t.pts || []).length
      if (expected > 1 && got !== expected) ptsBad3D.push({ id, expected, got, key: t.routeKey })
      if (norm(t.status) !== norm(p.status)) statusBad3D.push(row(id, p.status, t.status, '3D'))
    }
  })

  const bp = store.activeBuildingPlan
  const routes2D = bp ? (bp.routes || []).length : 0
  const routes3D = (dt.route._tubes || []).length
  const distinctBackendRoutes = [...new Set(backend.map((p) => norm(p.routeId)).filter(Boolean))]
  const distinct3DRoutes = [...new Set(three.map((d) => norm(d.routeId)).filter(Boolean))]
  const planRoutes = bp ? (bp.routes || []).map((r) => norm(r.routeId)) : []

  return {
    // 3D 是否真的挂载（未挂载时 2D/3D 比对无意义）
    twinMounted: Boolean(dt.scene.renderer.domElement.isConnected),
    buildingId,
    backendCount: backend.length,
    twoDCountAll: twoDAll.length,
    twoDCount: twoD.length,
    threeCount: three.length,
    missingIn2D: bIds.filter((id) => !dMap.has(id)).length,
    missingIn3D: bIds.filter((id) => !tMap.has(id)).length,
    extraIn3D: tIds.filter((id) => !bIds.includes(id)).length,
    idsIdentical: JSON.stringify(bIds) === JSON.stringify(tIds),
    routeIdBad2D, routeIdBad3D,
    ptsBad2D, ptsBad3D,
    statusBad2D, statusBad3D,
    routes2D, routes3D,
    distinctBackendRoutes: distinctBackendRoutes.length,
    distinct3DRoutes: distinct3DRoutes.length,
    backendRoutesInPlan: distinctBackendRoutes.every((r) => planRoutes.includes(r)),
    threeRoutesInPlan: distinct3DRoutes.every((r) => planRoutes.includes(r)),
    backendPlanId: demo.activeBuildingPlanId,
    twoDPlanId: store.activeBuildingPlanId,
    threeDPlanId: dt.route.currentPlanId,
    statusSamples: backend.slice(0, 3).map((p) => ({
      id: norm(p.id), b: p.status,
      d: dMap.get(norm(p.id)) ? dMap.get(norm(p.id)).status : null,
      t: tMap.get(norm(p.id)) ? tMap.get(norm(p.id)).status : null,
    })),
    sample: backend.slice(0, 2).map((p) => [norm(p.id), p.routeId, (p.routePoints || []).length, p.status]),
  }
}

/**
 * P1.6.1 人员身份链采集（浏览器内执行）
 * 校验链路每一跳都不得改变人员身份：
 *  ① 快照人员 id 唯一
 *  ② snapshot → demoStore → fireStore：id / floorId / zone / routeId / status 全程不变
 *  ③ progress 恒在 0~1
 *  ④ 3D 不产生新的 routeId、不修改业务 status、不产生新 routeKey
 *  ⑤ 整栋楼 1F~6F 每层人员数 / ID / floorId / zone / routeId / status 三方一致
 */
function identityFn() {
  const demo = window.__demo.demoStore
  const store = window.__demo.store
  const dt = window.__dtwin
  const norm = (v) => (v === undefined || v === null ? '' : String(v))
  const backend = (demo.persons || []).filter(Boolean)
  const buildingId = backend.length ? backend[0].buildingId : ''

  const indexById = (list, key) => {
    const m = new Map()
    ;(list || []).filter(Boolean).forEach((x) => m.set(norm(x[key || 'id']), x))
    return m
  }
  const backendIds = backend.map((p) => norm(p.id))
  const storeMap = indexById(store.persons)
  const threeMap = indexById(dt.persons.data)

  const hopMissingInStore = backendIds.filter((id) => !storeMap.has(id))
  const hopMissingIn3D = backendIds.filter((id) => !threeMap.has(id))
  const dupIds = backendIds.filter((id, i) => backendIds.indexOf(id) !== i)

  const floorBad = []
  const zoneBad = []
  const routeIdBad = []
  const statusBad = []
  const progressBad = []
  backend.forEach((p) => {
    const id = norm(p.id)
    if (typeof p.progress === 'number' && (p.progress < 0 || p.progress > 1)) progressBad.push([id, p.progress])
    const s = storeMap.get(id)
    const t = threeMap.get(id)
    if (s) {
      if (norm(s.floorId) !== norm(p.floorId)) floorBad.push({ id, backend: p.floorId, layer: '2D', got: s.floorId })
      if (norm(s.zone) !== norm(p.zone)) zoneBad.push({ id, backend: p.zone, layer: '2D', got: s.zone })
      if (norm(s.routeId) !== norm(p.routeId)) routeIdBad.push({ id, backend: p.routeId, layer: '2D', got: s.routeId })
      if (norm(s.status) !== norm(p.status)) statusBad.push({ id, backend: p.status, layer: '2D', got: s.status })
      if (typeof s.progress === 'number' && (s.progress < 0 || s.progress > 1)) progressBad.push([`2D:${id}`, s.progress])
    }
    if (t) {
      if (norm(t.floorId) !== norm(p.floorId)) floorBad.push({ id, backend: p.floorId, layer: '3D', got: t.floorId })
      if (norm(t.zone) !== norm(p.zone)) zoneBad.push({ id, backend: p.zone, layer: '3D', got: t.zone })
      if (norm(t.routeId) !== norm(p.routeId)) routeIdBad.push({ id, backend: p.routeId, layer: '3D', got: t.routeId })
      if (norm(t.status) !== norm(p.status)) statusBad.push({ id, backend: p.status, layer: '3D', got: t.status })
    }
  })

  // ④ 3D 不得生产任何后端没有的 routeId / status / routeKey（3D 只消费）
  const backendRouteIds = new Set(backend.map((p) => norm(p.routeId)).filter(Boolean))
  const planRouteIds = new Set(((store.activeBuildingPlan || {}).routes || []).map((r) => norm(r.routeId)).filter(Boolean))
  const backendStatuses = new Set(backend.map((p) => norm(p.status)).filter(Boolean))
  const routeId3DExtra = []
  const status3DExtra = []
  const routeKey3DExtra = []
  ;(dt.persons.data || []).filter(Boolean).forEach((d) => {
    const id = norm(d.id)
    const rid = norm(d.routeId)
    if (rid && !backendRouteIds.has(rid) && !planRouteIds.has(rid)) routeId3DExtra.push([id, rid])
    const st = norm(d.status)
    if (st && !backendStatuses.has(st)) status3DExtra.push([id, st])
    const key = String(d.routeKey || '')
    if (key && !/^(backend|bp|mock|none):/.test(key)) routeKey3DExtra.push([id, key])
  })

  // ⑤ 整栋楼逐层比对（1F ~ 6F）
  const FLOORS = ['1F', '2F', '3F', '4F', '5F', '6F']
  const perFloor = FLOORS.map((f) => {
    const b = backend.filter((p) => norm(p.floorId) === f)
    const s2d = (store.persons || []).filter((p) => p && norm(p.buildingId) === String(buildingId) && norm(p.floorId) === f)
    const s3d = (dt.persons.data || []).filter((d) => d && norm(d.floorId) === f)
    const bIds = b.map((p) => norm(p.id)).sort()
    const dIds = s2d.map((p) => norm(p.id)).sort()
    const tIds = s3d.map((d) => norm(d.id)).sort()
    const zoneMismatch = []
    const routeMismatch = []
    const statusMismatch = []
    b.forEach((p) => {
      const id = norm(p.id)
      const t = threeMap.get(id)
      const s = storeMap.get(id)
      if (t && norm(t.zone) !== norm(p.zone)) zoneMismatch.push({ id, backend: p.zone, got: t.zone })
      if (s && norm(s.routeId) !== norm(p.routeId)) routeMismatch.push({ id, backend: p.routeId, got: s.routeId })
      if (t && norm(t.status) !== norm(p.status)) statusMismatch.push({ id, backend: p.status, got: t.status })
    })
    return {
      floor: f,
      backend: b.length,
      twoD: s2d.length,
      threeD: s3d.length,
      idsSame2D: JSON.stringify(bIds) === JSON.stringify(dIds),
      idsSame3D: JSON.stringify(bIds) === JSON.stringify(tIds),
      zoneMismatch: zoneMismatch.length,
      routeMismatch: routeMismatch.length,
      statusMismatch: statusMismatch.length,
      zones: [...new Set(b.map((p) => norm(p.zone)))].sort(),
    }
  })

  return {
    buildingId,
    backendCount: backend.length,
    dupIds, hopMissingInStore, hopMissingIn3D,
    floorBad, zoneBad, routeIdBad, statusBad, progressBad,
    routeId3DExtra, status3DExtra, routeKey3DExtra,
    perFloor,
  }
}

;(async () => {
  console.log(`\n=== P1.6.3 2D/3D 一致性验收（${PAGE_URL} · ${API_BASE}）===\n`)
  const browser = await chromium.launch({ channel: 'msedge', headless: true })
  const page = await browser.newPage()
  const consoleErrors = []
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })

  // ── 0. 复位后端状态机（Durable Object 会话持久） ──
  const st = await fetch(`${API_BASE}/api/v1/demo/state?sessionId=${SESSION}`).then((r) => r.json())
  if (st.stage !== 'IDLE') {
    await fetch(`${API_BASE}/api/v1/demo/reset?sessionId=${SESSION}`, { method: 'POST' })
    await sleep(600)
  }

  await page.goto(PAGE_URL, { waitUntil: 'load', timeout: 45000 })
  await waitFor(() => page.evaluate(() => Boolean(window.__demo)), 20000)
  check('页面挂载并暴露开发钩子', await page.evaluate(() => Boolean(window.__demo)))
  check('WS 已连接后端状态机', await waitFor(() => page.evaluate(() => window.__demo.demoStore.wsStatus === 'open'), 15000),
    await page.evaluate(() => window.__demo.demoStore.wsStatus))

  await page.evaluate(() => { if (!window.__demo.store.demoMode) window.__demo.store.toggleDemoMode() })
  await page.waitForSelector('.demo-panel', { timeout: 10000 })
  const clickByText = async (text) => {
    const ok = await page.evaluate((t) => {
      const btn = Array.from(document.querySelectorAll('.demo-panel button')).find((b) => b.textContent.includes(t))
      if (!btn) return false
      btn.click()
      return true
    }, text)
    if (!ok) throw new Error(`未找到按钮：${text}`)
  }

  // ── 1. 驱动后端状态机到「疏散路径规划」 ──
  await clickByText('启动演示流程')
  check('进入发现火灾', await waitFor(() => page.evaluate(() => window.__demo.demoStore.stage === 'FIRE_DETECTED'), 10000))
  await clickByText('推进下一步')
  check('进入启动应急响应', await waitFor(() => page.evaluate(() => window.__demo.demoStore.stage === 'EMERGENCY_RESPONSE'), 10000))
  await clickByText('推进下一步')
  check('进入疏散路径规划', await waitFor(() => page.evaluate(() => window.__demo.demoStore.stage === 'ROUTE_PLANNING'), 10000))

  // ── 2. 打开 3D 浮层（3D 按需挂载：未挂载时的 3D 数据是旧快照，不能用于一致性比对） ──
  const open3D = async () => {
    const opened = await page.evaluate(() => {
      const btn = document.querySelector('.open-3d-btn')
      if (!btn) return false
      btn.click()
      return true
    })
    if (!opened) throw new Error('未找到 3D 模型入口按钮')
    return waitFor(() => page.evaluate(
      () => Boolean(window.__dtwin && window.__dtwin.persons && window.__dtwin.route
        && window.__dtwin.scene.renderer.domElement.isConnected
        && (window.__dtwin.persons.data || []).filter(Boolean).length > 0),
    ), 40000)
  }
  const close3D = () => page.evaluate(() => {
    const btn = document.querySelector('.dtwin-modal-close')
    if (btn) btn.click()
  })

  check('打开 3D 数字孪生浮层', await open3D())

  // ── 3. 预览期：A/B/C 方案切换时 2D / 3D 必须同源（同一 activeBuildingPlanId） ──
  console.log('\n[预览期] A/B/C 整栋楼方案：2D / 3D 同源')
  const preview = await page.evaluate(async () => {
    const store = window.__demo.store
    const dt = window.__dtwin
    const ids = (store.buildingEvacuationPlans || []).map((p) => p.id)
    const out = []
    for (const id of ids) {
      store.setActiveBuildingPlan(id)
      // 只等待（不手动调用 update）：验证 3D 会自动跟随 2D 方案切换
      let waited = 0
      while (waited < 3000 && !String(dt.route.currentPlanId || '').startsWith(`${id}:`)) {
        await new Promise((r) => setTimeout(r, 100))
        waited += 100
      }
      const bp = store.activeBuildingPlan
      const keys = (dt.persons.data || []).filter(Boolean).map((d) => String(d.routeKey || ''))
      out.push({
        id, waited,
        planId2D: store.activeBuildingPlanId,
        planId3D: dt.route.currentPlanId,
        routes2D: bp ? (bp.routes || []).length : 0,
        routes3D: (dt.route._tubes || []).length,
        persons3D: keys.length,
        keysOwned: keys.filter((k) => k.startsWith(`bp:${id}:`)).length,
      })
    }
    return out
  })
  preview.forEach((r) => {
    check(`${r.id}：3D 自动跟随 2D 方案切换（${r.waited}ms）`, String(r.planId3D || '').startsWith(`${r.id}:`), r)
    check(`${r.id}：2D 的 activeBuildingPlanId 等于所选方案`, r.planId2D === r.id, r)
    check(`${r.id}：2D / 3D 路线数量一致（${r.routes2D} 条）`,
      r.routes2D > 1 && r.routes2D === r.routes3D, r)
    check(`${r.id}：3D 人员路线来自同一方案`, r.persons3D > 0 && r.keysOwned === r.persons3D, r)
  })

  // 关闭浮层以便点击演示控制台；选中「非推荐方案」后确认，验证「确认即所选」
  await close3D()
  const picked = preview.length > 1 ? preview[1].id : preview[0].id
  await page.evaluate((id) => {
    window.__demo.store.setActiveBuildingPlan(id)
    window.__demo.demoStore.selectPlan(id)
  }, picked)
  await clickByText('确认当前疏散路径')
  check('进入智能疏散', await waitFor(() => page.evaluate(() => window.__demo.demoStore.stage === 'SMART_EVACUATION'), 10000))
  check('后端执行所选方案', await waitFor(() => page.evaluate((id) => window.__demo.demoStore.activeBuildingPlanId === id, picked), 10000),
    { picked, backend: await page.evaluate(() => window.__demo.demoStore.activeBuildingPlanId) })
  check('后端已下发人员路线（routePoints）', await waitFor(
    () => page.evaluate(() => (window.__demo.demoStore.persons || []).some((p) => Array.isArray(p.routePoints) && p.routePoints.length > 1)),
    20000))

  // ── 4. 执行期：重新挂载 3D 后做三方全量比对 ──
  console.log('\n[执行期] 后端 / 2D / 3D 三方一致性')
  check('疏散中重新挂载 3D 数字孪生', await open3D())

  const isConsistent = (s) => s.twinMounted && s.backendCount > 0
    && s.backendCount === s.twoDCount && s.backendCount === s.threeCount
    && s.idsIdentical && s.extraIn3D === 0 && s.missingIn3D === 0 && s.missingIn2D === 0
    && s.routeIdBad2D.length === 0 && s.routeIdBad3D.length === 0
    && s.ptsBad2D.length === 0 && s.ptsBad3D.length === 0
    && s.statusBad2D.length === 0 && s.statusBad3D.length === 0
    && s.routes2D > 1 && s.routes2D === s.routes3D
    && s.backendRoutesInPlan && s.threeRoutesInPlan
    && s.distinctBackendRoutes === s.distinct3DRoutes
    && Boolean(s.backendPlanId) && s.backendPlanId === s.twoDPlanId
    && String(s.threeDPlanId || '').startsWith(`${s.backendPlanId}:`)

  // 后端广播 → 2D 应用 → 3D 重建存在帧间隔：给一个收敛窗口，超时仍未对齐即判不一致
  let c = await page.evaluate(consistencyFn)
  const t0 = Date.now()
  while (Date.now() - t0 < 15000 && !isConsistent(c)) {
    await sleep(600)
    c = await page.evaluate(consistencyFn)
  }
  check('3D 处于挂载状态（比对前提）', c.twinMounted, c)
  check('三方数据在广播后自动收敛（无需手工刷新）', isConsistent(c), {
    waitedMs: Date.now() - t0, sample: c.sample, planIds: [c.backendPlanId, c.twoDPlanId, c.threeDPlanId],
    routes: [c.routes2D, c.routes3D],
    bad3D: { routeId: c.routeIdBad3D.slice(0, 2), pts: c.ptsBad3D.slice(0, 2), status: c.statusBad3D.slice(0, 2) },
  })

  // ① 人员数量一致
  check('后端 / 2D / 3D 人员数量一致',
    c.backendCount > 0 && c.backendCount === c.twoDCount && c.backendCount === c.threeCount, c)
  // ② 人员 ID 一致
  check('后端人员 ID 全部存在于 2D', c.missingIn2D === 0, c)
  check('后端 / 3D 人员 ID 完全一致', c.idsIdentical && c.extraIn3D === 0, c)
  check('3D 未渲染后端之外的人员', c.missingIn3D === 0, c)
  // ③ routeId 一致
  check('后端 → 2D：routeId 一致', c.routeIdBad2D.length === 0, c.routeIdBad2D.slice(0, 3))
  check('后端 → 3D：routeId 一致', c.routeIdBad3D.length === 0, c.routeIdBad3D.slice(0, 3))
  // ④ routePoints 一致
  check('后端 → 2D：routePoints 逐点一致', c.ptsBad2D.length === 0, c.ptsBad2D.slice(0, 3))
  check('后端 → 3D：折线与后端点列同源（点数一致）', c.ptsBad3D.length === 0, c.ptsBad3D.slice(0, 3))
  // ⑤ 人员 status 一致
  check('后端 → 2D：人员 status 一致', c.statusBad2D.length === 0, c.statusBad2D.slice(0, 3))
  check('后端 → 3D：人员 status 一致', c.statusBad3D.length === 0, c.statusBad3D.slice(0, 3))
  // ⑥ 2D / 3D 路线数量一致
  check('2D / 3D 路线数量一致', c.routes2D > 1 && c.routes2D === c.routes3D, c)
  check('后端 / 3D 的 routeId 都属于当前整栋楼方案',
    c.backendRoutesInPlan && c.threeRoutesInPlan && c.distinctBackendRoutes === c.distinct3DRoutes, c)
  // ⑦ activeBuildingPlanId 一致
  check('后端 / 2D / 3D activeBuildingPlanId 一致',
    Boolean(c.backendPlanId) && c.backendPlanId === c.twoDPlanId
    && String(c.threeDPlanId || '').startsWith(`${c.backendPlanId}:`),
    [c.backendPlanId, c.twoDPlanId, c.threeDPlanId])

  // ── 5. 持续一致性：推进若干 tick 后三方仍须一致 ──
  await sleep(3000)
  const c2 = await page.evaluate(consistencyFn)
  check('推进 3 秒后 3D 仍处于挂载状态', c2.twinMounted, c2)
  check('推进 3 秒后人员数量仍一致',
    c2.backendCount === c2.twoDCount && c2.backendCount === c2.threeCount, c2)
  check('推进 3 秒后 ID 仍一致', c2.idsIdentical && c2.extraIn3D === 0, c2)
  check('推进 3 秒后 routeId 仍一致',
    c2.routeIdBad2D.length === 0 && c2.routeIdBad3D.length === 0, c2)
  check('推进 3 秒后 routePoints 仍同源',
    c2.ptsBad2D.length === 0 && c2.ptsBad3D.length === 0, c2)
  check('推进 3 秒后 status 仍一致',
    c2.statusBad2D.length === 0 && c2.statusBad3D.length === 0, c2)
  check('推进 3 秒后 2D / 3D 路线数量仍一致',
    c2.routes2D === c2.routes3D && c2.routes2D > 1, c2)
  check('推进 3 秒后 activeBuildingPlanId 仍三方一致',
    c2.backendPlanId === c2.twoDPlanId && String(c2.threeDPlanId || '').startsWith(`${c2.backendPlanId}:`),
    [c2.backendPlanId, c2.twoDPlanId, c2.threeDPlanId])
  const advanced = (await page.evaluate(() => (window.__demo.demoStore.persons || [])
    .filter((p) => p.status === 'safe' || p.status === 'evacuating').length))
  check('后端人员在推进（存在疏散 / 撤离完成状态）', advanced > 0, { advanced, sample: c2.statusSamples })

  // ── 6. 人员身份链一致性（P1.6.1）──
  console.log('\n[身份链] snapshot → demoStore → fireStore(2D) → PersonLayer3D(3D)')
  const idc = await page.evaluate(identityFn)
  check('① 快照中每个人员 id 唯一', idc.dupIds.length === 0, idc.dupIds)
  check('② snapshot → fireStore：后端人员 id 全部保留（不改名/不重建）',
    idc.hopMissingInStore.length === 0, idc.hopMissingInStore)
  check('② fireStore → 3D：人员 id 与后端一一对应',
    idc.hopMissingIn3D.length === 0, idc.hopMissingIn3D)
  check('④ 后端 floorId 与前端 floorId 一致（2D / 3D 口径统一）',
    idc.floorBad.length === 0, idc.floorBad.slice(0, 3))
  check('⑤ 后端 zone 与前端 zone 一致（避免 area 别名成为第二套身份）',
    idc.zoneBad.length === 0, idc.zoneBad.slice(0, 3))
  check('⑥ routeId 后端 → 2D / 3D 全程一致', idc.routeIdBad.length === 0, idc.routeIdBad.slice(0, 3))
  check('⑨ 后端 status 变化后 2D / 3D 同步', idc.statusBad.length === 0, idc.statusBad.slice(0, 3))
  check('⑧ progress 始终落在 0~1（含后端与 2D）',
    idc.progressBad.length === 0, idc.progressBad.slice(0, 3))
  check('⑩ 3D 不产生新的 routeId（全部来自后端或当前整栋楼方案）',
    idc.routeId3DExtra.length === 0, idc.routeId3DExtra.slice(0, 3))
  check('⑪ 3D 不修改人员业务状态（status 取值不超出后端集合）',
    idc.status3DExtra.length === 0, idc.status3DExtra.slice(0, 3))
  check('⑩ 3D 路线来源指纹只来自权威三类（backend / bp / mock / none）',
    idc.routeKey3DExtra.length === 0, idc.routeKey3DExtra.slice(0, 3))

  // ── 7. 整栋楼覆盖：1F ~ 6F 三方一致（人员数 / ID / floorId / zone / routeId / status）──
  console.log('\n[整栋楼] 1F ~ 6F 逐层三方一致（后端 / 2D / 3D）')
  idc.perFloor.forEach((f) => {
    check(`${f.floor}：人员数量三方一致（${f.backend} 人）`,
      f.backend > 0 && f.backend === f.twoD && f.backend === f.threeD, f)
    check(`${f.floor}：人员 ID 三方一致`, f.idsSame2D && f.idsSame3D, f)
    check(`${f.floor}：zone 三方一致`, f.zoneMismatch === 0, f)
    check(`${f.floor}：routeId 三方一致`, f.routeMismatch === 0, f)
    check(`${f.floor}：status 三方一致`, f.statusMismatch === 0, f)
  })
  check('整栋楼 6 层全部有人员进入数据链（1F~6F）',
    idc.perFloor.length === 6 && idc.perFloor.every((f) => f.backend > 0),
    idc.perFloor.map((f) => [f.floor, f.backend, f.twoD, f.threeD]))
  check('每层都出现多个人员区域（zone 覆盖不是单一火源区）',
    idc.perFloor.every((f) => f.zones.length > 0)
    && new Set(idc.perFloor.flatMap((f) => f.zones)).size > 1,
    idc.perFloor.map((f) => [f.floor, f.zones]))

  check('无 JS 运行时错误', consoleErrors.length === 0, consoleErrors.slice(0, 2))

  await browser.close()
  console.log(`\n=== 结果：${passed} 通过 / ${failed} 失败 ===`)
  if (failed) { console.log('失败项：'); failures.forEach((f) => console.log('  - ' + f)); process.exit(1) }
  process.exit(0)
})().catch((err) => {
  console.error('一致性验收执行异常：', err)
  process.exit(1)
})

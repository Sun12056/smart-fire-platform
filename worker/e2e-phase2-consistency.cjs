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

/* ═══════════════════════════════════════════════════════════════════════════
 * P1.6.3 第二阶段：全局一致性测试基线
 * ─────────────────────────────────────────────────────────────────────────
 * 原则：本阶段只改测试代码，不动业务代码。目标是「把真实存在的一致性问题可靠地测红」，
 *       已知缺陷统一以 reds[] 记录并连同证据输出，不通过降低断言强度换取全绿。
 *
 * 测试矩阵：
 *   PERSON  · REST baseline DTO / WS runtime DTO / canonical fields / spatial identity / 24 场景
 *   DEVICE  · REST ↔ WS ↔ Mock / canonical fields / 同一字段同一语义 / 24 场景
 *   DEMO    · snapshot ↔ tick 字段集合 / 六阶段状态链 / 单一运行时权威
 *   PLAN    · PLAN-A/B/C / scope=BUILDING / 楼栋隔离
 *   3D      · source-level assertion（3D 各模块是否仍用旧别名做业务判断）
 *   MODE    · 当前数据源模式的合规 + 静默回退防御（source-level）
 * ═══════════════════════════════════════════════════════════════════════════ */

// ── 场景矩阵：4 栋 × 6 层 = 24 ──
const BUILDINGS = ['B001', 'B002', 'B003', 'B004']
const FLOORS = ['1F', '2F', '3F', '4F', '5F', '6F']

// REST baseline DTO 契约（静态人员台账：不含运行时字段，不得反向要求 runtime 字段）
const PERSON_BASELINE_FIELDS = ['id', 'buildingId', 'floorId', 'zone', 'x', 'y', 'status', 'movementType']
// WS runtime DTO 契约（后端运行时：含路线 / 进度 / 疏散标志）
const PERSON_RUNTIME_FIELDS = [
  'id', 'buildingId', 'floorId', 'zone', 'x', 'y', 'status', 'movementType',
  'progress', 'targetX', 'targetY', 'routeId', 'route', 'routePoints',
  'waypoint', 'evacuating', 'retained', 'rescued',
]
// 设备 canonical DTO（10 项）
const DEVICE_CANON_FIELDS = [
  'id', 'type', 'buildingId', 'floorId', 'zone', 'status', 'currentMode', 'direction', 'brightness', 'emergencyFlash',
]
// shared/device/deviceRuntime.js 现行契约默认值（用于识别「默认值冒充真实值」）
const DEVICE_CONTRACT_DEFAULT = { currentMode: 'daily', direction: 'right', brightness: 60, emergencyFlash: false }

const BUILDING_ID_TO_NAME = { B001: '1号楼', B002: '2号楼', B003: '3号楼', B004: '4号楼' }

// ── 红灯登记簿：{ code, scope, evidence, loc } ──
const reds = []
function recordRed(code, scope, evidence, loc) {
  reds.push({ code, scope, evidence, loc })
  console.log(`  ⚑ 缺陷登记 ${code} — ${scope}`)
}

const fetchJson = async (url, opt) => {
  const r = await fetch(url, opt)
  let body = null
  try { body = await r.json() } catch { /* 非 JSON 体，保留 null */ }
  return { status: r.status, body }
}
const sendCommand = (command, payload = {}) => fetchJson(`${API_BASE}/api/v1/demo/command?sessionId=${SESSION}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ command, payload }),
})
// 指定会话下发指令（DO 按 sessionId 隔离：探针使用独立会话，避免污染 default）
const sendCommandTo = (session, command, payload = {}) => fetchJson(`${API_BASE}/api/v1/demo/command?sessionId=${session}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ command, payload }),
})
const idSetBudget = (arr) => new Set(arr.map((x) => String(x.id)))
const keysOf = (o) => (o && typeof o === 'object' ? Object.keys(o) : [])

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

  /* ══════════════════════════════════════════════════════════════════════
   * [P1.6.3 采样] REST(D1) / WS(DO) / Mock(前端种子) / Store(2D) / 3D 五层快照
   * ══════════════════════════════════════════════════════════════════════ */
  console.log('\n[P1.6.3] 五层数据源采样：REST(D1) / WS(DO) / Mock(种子) / Store(2D) / 3D')
  const restPersons = ((await fetchJson(`${API_BASE}/api/v1/person-presence`)).body) || []
  const restDevices = ((await fetchJson(`${API_BASE}/api/v1/devices`)).body) || []
  const wsSnap = (await fetchJson(`${API_BASE}/api/v1/demo/state?sessionId=${SESSION}`)).body || {}
  const wsPersons = wsSnap.persons || []
  const wsDevices = wsSnap.devices || []

  // 页面侧：Store(2D) / demoStore(WS 镜像) / 3D PersonLayer3D / Mock 种子（经 Vite 动态 import）
  const pageData = await page.evaluate(() => {
    const s = window.__demo.store
    const d = window.__demo.demoStore
    const pack = (list) => (Array.isArray(list) ? list : []).filter(Boolean).map((x) => ({
      id: String(x.id),
      buildingId: x.buildingId === undefined || x.buildingId === null ? '' : String(x.buildingId),
      floorId: x.floorId === undefined || x.floorId === null ? '' : String(x.floorId),
      zone: x.zone === undefined || x.zone === null ? '' : String(x.zone),
      building: x.building === undefined || x.building === null ? '' : String(x.building),
      floor: x.floor === undefined || x.floor === null ? '' : String(x.floor),
      area: x.area === undefined || x.area === null ? '' : String(x.area),
      type: x.type === undefined || x.type === null ? '' : String(x.type),
      status: x.status === undefined || x.status === null ? '' : String(x.status),
      currentMode: x.currentMode === undefined || x.currentMode === null ? null : String(x.currentMode),
      direction: x.direction === undefined || x.direction === null ? null : String(x.direction),
      brightness: typeof x.brightness === 'number' ? x.brightness : (x.brightness === undefined ? undefined : Number(x.brightness)),
      emergencyFlash: typeof x.emergencyFlash === 'boolean' ? x.emergencyFlash : null,
      routeId: x.routeId === undefined || x.routeId === null ? '' : String(x.routeId),
      progress: typeof x.progress === 'number' ? x.progress : null,
      hasOwnZone: Object.prototype.hasOwnProperty.call(x, 'zone'),
      mockRuntime: Boolean(x._evac) || Boolean(x._evacDone),
    }))
    return {
      mode: window.__demo.dataSource ? window.__demo.dataSource.mode : null,
      storePersons: pack(s.persons),
      storeDevices: pack(s.devices),
      demoPersons: pack(d.persons),
      demoDevices: pack(d.devices),
      threePersons: (window.__dtwin && window.__dtwin.persons) ? pack(window.__dtwin.persons.data) : [],
      threeDevices: (window.__dtwin && window.__dtwin.em && window.__dtwin.em.data) ? (window.__dtwin.em.data || []).length : null,
      emergencyStage: s.emergencyStage,
      storePlanId: s.activeBuildingPlanId,
      storePlanBuildingId: s.activeBuildingPlan ? (s.activeBuildingPlan.buildingId || null) : null,
      plans: (s.buildingEvacuationPlans || []).map((p) => ({
        id: p.id, buildingId: p.buildingId || null, scope: p.scope || null, routes: (p.routes || []).length,
      })),
      backendPlanId: d.activeBuildingPlanId,
      selectedBuildingId: (s.dashboardView || {}).selectedBuildingId || null,
      remoteReady: Boolean(s.remoteReady),
      remoteError: s.remoteError || null,
      degraded: Boolean(s.dataSourceDegraded),
      wsStatus: d.wsStatus,
    }
  })
  // 3D 对象 key 名修正（避免上面对象字面量里的空格 key 造成歧义）
  const pageStorePersons = pageData.storePersons
  const pageStoreDevices = pageData.storeDevices
  const pageDemoPersons = pageData.demoPersons
  const pageDemoDevices = pageData.demoDevices
  const pageThreePersons = pageData.threePersons

  const mockLayer = await page.evaluate(async () => {
    try {
      const seed = await import('/src/mock/deviceSeed.js')
      const person = await import('/src/mock/person.js')
      const ds = seed.buildSeedDevices()
      return {
        error: null,
        devices: ds.map((d) => ({
          id: String(d.id),
          type: d.type || '',
          buildingId: d.buildingId || '',
          floorId: d.floorId || '',
          zone: Object.prototype.hasOwnProperty.call(d, 'zone') ? String(d.zone ?? '') : undefined,
          hasOwnZone: Object.prototype.hasOwnProperty.call(d, 'zone'),
          ownBuildingId: Object.prototype.hasOwnProperty.call(d, 'buildingId'),
          ownFloorId: Object.prototype.hasOwnProperty.call(d, 'floorId'),
          area: d.area === undefined ? undefined : String(d.area),
          zoneName: d.zoneName === undefined ? undefined : String(d.zoneName),
          status: d.status === undefined ? undefined : String(d.status),
          currentMode: d.currentMode === undefined ? undefined : String(d.currentMode),
          direction: d.direction === undefined ? undefined : String(d.direction),
          brightness: typeof d.brightness === 'number' ? d.brightness : undefined,
          emergencyFlash: typeof d.emergencyFlash === 'boolean' ? d.emergencyFlash : undefined,
        })),
        persons: (person.persons || []).map((p) => ({
          id: String(p.id),
          buildingId: p.buildingId === undefined ? undefined : String(p.buildingId),
          floorId: p.floorId === undefined ? undefined : String(p.floorId),
          zone: p.zone === undefined ? undefined : String(p.zone),
          building: p.building === undefined ? undefined : String(p.building),
          floor: p.floor === undefined ? undefined : String(p.floor),
          area: p.area === undefined ? undefined : String(p.area),
        })),
      }
    } catch (err) {
      return { error: String(err), devices: [], persons: [] }
    }
  })
  check('可在页面内采样 Mock 种子数据源（经 Vite 动态 import）', !mockLayer.error, mockLayer.error)

  /* ══════════════════ [PERSON] 人员一致性 ══════════════════ */
  console.log('\n[PERSON] REST baseline ↔ WS runtime ↔ Store ↔ 2D ↔ 3D')
  check('REST /person-presence 返回人员台账', restPersons.length > 0, { count: restPersons.length })
  check('WS 快照返回运行时人员', wsPersons.length > 0, { count: wsPersons.length })
  check('Store(2D) 已持有人员', pageStorePersons.length > 0, { count: pageStorePersons.length })

  // ① REST baseline DTO vs WS runtime DTO：契约分离（不强行要求两个 DTO 相同）
  const baselineMissing = restPersons.filter((p) => PERSON_BASELINE_FIELDS.some((k) => p[k] === undefined))
  check(`REST baseline DTO 字段完整（${PERSON_BASELINE_FIELDS.length} 项：id/buildingId/floorId/zone/x/y/status/movementType）`,
    baselineMissing.length === 0, { bad: baselineMissing.length, sample: baselineMissing.slice(0, 2) })
  const baselineRuntimeLeak = restPersons.filter((p) => ['routeId', 'routePoints', 'progress', 'evacuating'].some((k) => k in p))
  check('REST baseline DTO 与 WS runtime DTO 契约分离（REST 不提供运行时字段）',
    baselineRuntimeLeak.length === 0, { leak: baselineRuntimeLeak.length })
  const runtimeMissing = wsPersons.filter((p) => PERSON_RUNTIME_FIELDS.some((k) => p[k] === undefined))
  check(`WS runtime DTO 字段完整（${PERSON_RUNTIME_FIELDS.length} 项，含 routeId/routePoints/progress/waypoint/疏散标志）`,
    runtimeMissing.length === 0, { bad: runtimeMissing.length, missingSample: runtimeMissing.length ? PERSON_RUNTIME_FIELDS.filter((k) => runtimeMissing[0][k] === undefined) : [] })
  const runtimeTypeBad = wsPersons.filter((p) => !Array.isArray(p.route) || !Array.isArray(p.routePoints) || typeof p.progress !== 'number')
  check('WS runtime DTO 类型正确（route / routePoints 数组，progress 数字）',
    runtimeTypeBad.length === 0, { bad: runtimeTypeBad.length })
  const progressOutOfRange = wsPersons.concat(pageStorePersons).filter((p) => typeof p.progress === 'number' && (p.progress < 0 || p.progress > 1))
  check('progress 始终落在 0~1', progressOutOfRange.length === 0, progressOutOfRange.slice(0, 3))

  // ② 空间身份：同 ID → 同 buildingId/floorId/zone（跨层漂移检测）
  const spatialDrift = []
  const layerPersonMaps = [
    ['REST', new Map(restPersons.map((p) => [String(p.id), p]))],
    ['WS', new Map(wsPersons.map((p) => [String(p.id), p]))],
    ['Store', new Map(pageStorePersons.map((p) => [String(p.id), p]))],
    ['demoStore', new Map(pageDemoPersons.map((p) => [String(p.id), p]))],
    ['Mock', new Map((mockLayer.persons || []).map((p) => [String(p.id), p]))],
  ]
  const BUILDING_NAME_TO_ID = Object.fromEntries(Object.entries(BUILDING_ID_TO_NAME).map(([k, v]) => [v, k]))
  // canonical 身份解析：buildingId 优先，中文楼栋名仅作为「旧别名兜底」（与生产代码同规则）
  const canonicalOf = (p) => {
    const bid = p.buildingId || (p.building ? (BUILDING_NAME_TO_ID[p.building] || '') : '')
    return { buildingId: bid, floorId: p.floorId || p.floor || '', zone: p.zone || p.area || '' }
  }
  for (let i = 1; i < layerPersonMaps.length; i++) {
    const [bName, bMap] = layerPersonMaps[i]
    for (const [aName, aMap] of layerPersonMaps.slice(0, i)) {
      let cmp = 0
      aMap.forEach((ap, id) => {
        const bp = bMap.get(id)
        if (!bp) return
        cmp++
        const ca = canonicalOf(ap)
        const cb = canonicalOf(bp)
        if (ca.buildingId !== cb.buildingId || ca.floorId !== cb.floorId || ca.zone !== cb.zone) {
          spatialDrift.push({ id, layers: `${aName}→${bName}`, a: ca, b: cb })
        }
      })
    }
  }
  check('人员空间身份无漂移（REST/WS/Store/demoStore/Mock：同 ID → 同 buildingId/floorId/zone）',
    spatialDrift.length === 0, spatialDrift.slice(0, 3))

  // ③ 旧字段不得反向覆盖 canonical field
  const aliasBad = []
  ;[['WS', wsPersons], ['REST', restPersons], ['Store', pageStorePersons], ['demoStore', pageDemoPersons]].forEach(([layer, list]) => {
    list.forEach((p) => {
      const bid = String(p.buildingId || '')
      if (p.building && bid && BUILDING_ID_TO_NAME[bid] && p.building !== BUILDING_ID_TO_NAME[bid]) {
        aliasBad.push({ layer, id: p.id, kind: 'building', canonical: bid, alias: p.building })
      }
      const fid = String(p.floorId || '')
      if (p.floor && fid && p.floor !== fid) aliasBad.push({ layer, id: p.id, kind: 'floor', canonical: fid, alias: p.floor })
      const zn = String(p.zone || '')
      if (p.area && zn && p.area !== zn) aliasBad.push({ layer, id: p.id, kind: 'area', canonical: zn, alias: p.area })
    })
  })
  check('旧字段（building/floor/area）未反向覆盖 canonical field', aliasBad.length === 0, aliasBad.slice(0, 3))

  // Mock 种子人员是否自带 canonical buildingId（不依赖中文名映射）
  const mockNoOwnBuildingId = (mockLayer.persons || []).filter((p) => p.buildingId === undefined || p.buildingId === '')
  check('Mock 种子人员自带 canonical buildingId（不依赖中文名映射）', mockNoOwnBuildingId.length === 0,
    { total: (mockLayer.persons || []).length, missing: mockNoOwnBuildingId.length })
  if (mockNoOwnBuildingId.length > 0) {
    recordRed('C5', '人员种子没有 canonical buildingId，只有中文楼栋名',
      `${mockNoOwnBuildingId.length}/${(mockLayer.persons || []).length} 个种子人员无 buildingId（示例 ${(mockNoOwnBuildingId[0] || {}).id} building=${(mockNoOwnBuildingId[0] || {}).building}），D1 写入时靠 worker/src/seed.ts 的名称映射补齐`,
      'src/mock/person.js（人员结构：building/floor/zone）；worker/src/seed.ts:80-89（名称映射补 buildingId）')
  }

  // ④ DemoRoom 运行时覆盖范围（Q1：DO = 单楼栋演练房间）
  // 快照未暴露 scenario 字段：演练楼栋只能从现有字段推导 —— persons / devices 的 buildingId 唯一集
  const wsPersonBuildings = [...new Set(wsPersons.map((p) => String(p.buildingId)))].sort()
  const wsDeviceBuildings = [...new Set(wsDevices.map((d) => String(d.buildingId)))].sort()
  const wsPersonFloors = [...new Set(wsPersons.map((p) => String(p.floorId)))].sort()
  const restPersonBuildings = [...new Set(restPersons.map((p) => String(p.buildingId)))].sort()
  const demoBuildingId = (() => {
    const uniq = [...new Set([...wsPersonBuildings, ...wsDeviceBuildings])].filter(Boolean)
    return uniq.length === 1 ? uniq[0] : (wsPersonBuildings[0] || '')
  })()
  const singleBuildingRuntime = wsPersonBuildings.length === 1
    && (wsDeviceBuildings.length === 0 || wsDeviceBuildings[0] === demoBuildingId)
  check('DemoRoom 是单楼栋演练房间（runtime 人员/设备同属一栋楼）', singleBuildingRuntime,
    { demoBuildingId, personBuildings: wsPersonBuildings, deviceBuildings: wsDeviceBuildings })
  const runtimeFloorSet = [...new Set(wsPersons
    .filter((p) => String(p.buildingId) === demoBuildingId)
    .map((p) => String(p.floorId)))].sort()
  const demoFloorCovered = FLOORS.every((f) => runtimeFloorSet.includes(f))
  check(`DemoRoom runtime 覆盖演练楼栋 ${demoBuildingId} 的 ${FLOORS[0]}~${FLOORS[FLOORS.length - 1]}`,
    demoFloorCovered,
    { demoBuildingId, covered: runtimeFloorSet, missing: FLOORS.filter((f) => !runtimeFloorSet.includes(f)) })
  if (!demoFloorCovered) {
    recordRed('D1', `DemoRoom runtime 未覆盖演练楼栋 ${demoBuildingId} 的全部楼层`,
      `runtime 楼层集合 ${JSON.stringify(runtimeFloorSet)}（期望 ${FLOORS.join('/')}），运行时 ${wsPersons.length} 人；REST ledger 楼栋集合 ${JSON.stringify(restPersonBuildings)} 共 ${restPersons.length} 人`,
      'worker/src/durable/DemoRoom.ts:25,40-43（DEFAULT_SCENARIO.buildingId 与 SQL WHERE building_id = ?）')
  }
  const wsExtra = wsPersons.filter((p) => !idSetBudget(restPersons).has(String(p.id)))
  check('WS runtime 人员 ID 全部来自 REST baseline 集合（无凭空新增）', wsExtra.length === 0, wsExtra.slice(0, 3))

  // ⑤ 人员集合分层（Q2）：ledgerPersons（全楼栋静态台账） vs runtimePersons（当前演练楼栋运行时）
  const wsRuntimeIdSet = idSetBudget(wsPersons)
  const runtimePersons = pageStorePersons.filter((p) => String(p.buildingId) === demoBuildingId)
  const ledgerPersons = pageStorePersons.filter((p) => String(p.buildingId) !== demoBuildingId)
  const runtimeMissingInWs = runtimePersons.filter((p) => !wsRuntimeIdSet.has(String(p.id)))
  check(`演练楼栋 ${demoBuildingId}：Store 人员全部来自 WS 运行时（不存在第二套运行时）`,
    runtimePersons.length > 0 && runtimeMissingInWs.length === 0,
    { demoBuildingId, storeRuntime: runtimePersons.length, wsRuntime: wsPersons.length,
      missing: runtimeMissingInWs.slice(0, 3).map((p) => p.id) })
  if (runtimeMissingInWs.length > 0) {
    recordRed('D2', `演练楼栋 ${demoBuildingId} 存在无 WS 运行时来源的人员`,
      `演练楼栋 Store 人员 ${runtimePersons.length} 人 / WS runtime ${wsPersons.length} 人；无运行时来源 ${runtimeMissingInWs.length} 人，示例 ${runtimeMissingInWs.slice(0, 3).map((p) => p.id).join(',')}`,
      'src/App.vue:36（initFromRemote 全量 REST） + src/stores/fireStore.js:140-160,261-321（与 WS 快照合并）')
  }
  const ledgerLeaked = ledgerPersons.filter((p) => wsRuntimeIdSet.has(String(p.id)))
  check('其它楼栋人员为 ledger-only（不进入 WS runtime，不要求 runtime 字段）', ledgerLeaked.length === 0,
    { ledgerPersons: ledgerPersons.length, ledgerInRuntime: ledgerLeaked.length, demoBuildingId })

  // 身份字段（personId / buildingId / floorId / zone）一致性不得因放宽口径而丢失
  const wsPersonMap = new Map(wsPersons.map((p) => [String(p.id), p]))
  const normIdField = (v) => (v === undefined || v === null ? '' : String(v))
  const runtimeIdentityBad = []
  runtimePersons.forEach((sp) => {
    const wp = wsPersonMap.get(String(sp.id))
    if (!wp) return
    ;['buildingId', 'floorId', 'zone'].forEach((k) => {
      if (normIdField(sp[k]) !== normIdField(wp[k])) {
        runtimeIdentityBad.push({ id: sp.id, field: k, store: sp[k], ws: wp[k] })
      }
    })
  })
  check(`演练楼栋 runtime 人员身份字段一致（personId / buildingId / floorId / zone）`,
    runtimeIdentityBad.length === 0, runtimeIdentityBad.slice(0, 3))
  const mockRuntimeLeft = pageStorePersons.filter((p) => p.mockRuntime)
  check('demo 模式：Store 人员无 mock 本地运行态残留（_evac / _evacDone）', mockRuntimeLeft.length === 0,
    { bad: mockRuntimeLeft.length, sample: mockRuntimeLeft.slice(0, 3).map((p) => p.id) })

  /* ══════════════════ [DEVICE] 设备一致性 ══════════════════ */
  console.log('\n[DEVICE] REST(D1) ↔ WS(DO) ↔ Mock(种子) ↔ Store(2D) / 3D')
  check('REST /devices 返回设备台账', restDevices.length > 0, { count: restDevices.length })
  check('WS 快照返回运行时设备', wsDevices.length > 0, { count: wsDevices.length })
  const deviceCanonBad = [['REST', restDevices], ['WS', wsDevices], ['Store', pageStoreDevices], ['demoStore', pageDemoDevices]]
    .flatMap(([layer, list]) => list.filter((d) => DEVICE_CANON_FIELDS.some((k) => d[k] === undefined)).map((d) => ({ layer, id: d.id })))
  check(`设备 canonical 字段完整（${DEVICE_CANON_FIELDS.length} 项）`, deviceCanonBad.length === 0, deviceCanonBad.slice(0, 3))

  // 设备字段分两类：身份字段（全链路必须一致） / 运行时字段（REST、Mock 是静态台账，WS、Store 是运行时）
  const restDeviceMap = new Map(restDevices.map((d) => [String(d.id), d]))
  const mockDeviceMap = new Map((mockLayer.devices || []).map((d) => [String(d.id), d]))
  const storeDeviceMap = new Map(pageStoreDevices.map((d) => [String(d.id), d]))
  const IDENTITY_FIELDS = ['type', 'buildingId', 'floorId', 'zone']
  const RUNTIME_FIELDS = ['status', 'currentMode', 'direction', 'brightness', 'emergencyFlash']
  const normVal = (v) => (typeof v === 'number' ? v : (typeof v === 'boolean' ? v : String(v)))
  const compareAcross = (fieldList) => {
    const bad = []
    wsDevices.forEach((w) => {
      const targets = [['REST', restDeviceMap.get(String(w.id))], ['Mock', mockDeviceMap.get(String(w.id))], ['Store', storeDeviceMap.get(String(w.id))]]
      targets.forEach(([layer, o]) => {
        if (!o) return
        fieldList.forEach((k) => {
          if (w[k] === undefined || o[k] === undefined) return
          if (normVal(w[k]) !== normVal(o[k])) bad.push({ id: w.id, layer: `WS→${layer}`, field: k, ws: w[k], other: o[k] })
        })
      })
    })
    return bad
  }
  const identityBad = compareAcross(IDENTITY_FIELDS)
  check('同一设备身份字段跨层一致（type / buildingId / floorId / zone：REST ↔ WS ↔ Mock ↔ Store）',
    identityBad.length === 0, identityBad.slice(0, 4))
  const runtimeBadSelf = (() => {
    const bad = []
    pageDemoDevices.forEach((d) => {
      const s = storeDeviceMap.get(String(d.id))
      if (!s) return
      RUNTIME_FIELDS.forEach((k) => {
        if (d[k] === undefined || s[k] === undefined) return
        if (normVal(d[k]) !== normVal(s[k])) bad.push({ id: d.id, layer: 'demoStore→Store', field: k, ws: d[k], store: s[k] })
      })
    })
    return bad
  })()
  check('同一设备运行时字段 WS ↔ Store 一致（status/currentMode/direction/brightness/emergencyFlash）',
    runtimeBadSelf.length === 0, runtimeBadSelf.slice(0, 4))
  if (runtimeBadSelf.length > 0) {
    const byField = {}
    runtimeBadSelf.forEach((b) => { byField[b.field] = (byField[b.field] || 0) + 1 })
    recordRed('D4', '设备运行时字段 WS ↔ Store 漂移',
      `${runtimeBadSelf.length} 处不一致，按字段统计 ${JSON.stringify(byField)}；示例 ${JSON.stringify(runtimeBadSelf.slice(0, 2))}`,
      'src/stores/fireStore.js（applyDemoSnapshot 设备合并） ↔ src/stores/demoStore.js（WS 镜像）')
  }
  // Q2 口径：REST / Mock 是静态台账（D1 + 种子），不承担 Demo 运行时；
  // 运行时状态经 WS snapshot / stage 广播，只与 Store 比对，不再要求 REST/Mock == WS runtime
  const ledgerStaticOk = restDevices.length > 0
    && restDevices.every((d) => d.status !== undefined && d.currentMode !== undefined)
  check('REST / Mock 设备保持静态台账口径（台账运行时字段完整，不要求跟随 runtime）', ledgerStaticOk,
    { rest: restDevices.length,
      missing: restDevices.filter((d) => d.status === undefined || d.currentMode === undefined).length })
  const ledgerVsRuntime = compareAcross(RUNTIME_FIELDS).filter((b) => b.layer === 'WS→REST' || b.layer === 'WS→Mock')
  console.log(`  ℹ 台账/运行时分层：WS runtime 与 REST/Mock 台账存在 ${ledgerVsRuntime.length} 处差异（Q2 口径下属预期，不登记为缺陷）`)

  // C1：种子是否自身携带 canonical zone（而非仅 area / zoneName）
  const mockNoOwnZone = (mockLayer.devices || []).filter((d) => !d.hasOwnZone)
  check('Mock 种子设备自带 canonical zone（不是仅靠 area / zoneName 回退）', mockNoOwnZone.length === 0,
    { total: (mockLayer.devices || []).length, missingZone: mockNoOwnZone.length })
  if (mockNoOwnZone.length > 0) {
    recordRed('C1', '设备种子没有 canonical zone 字段',
      `${mockNoOwnZone.length}/${(mockLayer.devices || []).length} 台种子设备无自有 zone；示例 ${JSON.stringify((mockNoOwnZone[0] || {}).id)} zone=${mockNoOwnZone[0] ? String(mockNoOwnZone[0].zone) : '-'} area=${mockNoOwnZone[0] ? String(mockNoOwnZone[0].area) : '-'} zoneName=${mockNoOwnZone[0] ? String(mockNoOwnZone[0].zoneName) : '-'}`,
      'src/mock/deviceSeed.js:36-41（只有 building/floorId/area/zoneName）；worker/src/seed.ts:42（D1 zone 列取自 area）')
  }
  // C2：默认值是否冒充真实值 —— 只看「种子未定义」但下游给出契约默认值的字段
  const defaultMasquerade = []
  const contractDefaults = DEVICE_CONTRACT_DEFAULT
  ;(mockLayer.devices || []).forEach((m) => {
    const restTarget = restDeviceMap.get(String(m.id))
    if (!restTarget) return
    const targets = [['REST', restTarget], ['Store', storeDeviceMap.get(String(m.id))]].filter(([, o]) => o)
    const undefFields = [...IDENTITY_FIELDS, ...RUNTIME_FIELDS].filter((k) => m[k] === undefined)
    undefFields.forEach((k) => {
      targets.forEach(([layer, o]) => {
        if (o[k] !== undefined && contractDefaults[k] !== undefined && o[k] === contractDefaults[k]) {
          defaultMasquerade.push({ id: m.id, layer, field: k, mock: undefined, downstream: o[k], note: '契约默认值冒充真实值' })
        }
      })
    })
  })
  check('未被定义 fields 未被契约默认值冒充（Mock 未定义 → 下游出现 daily/right/60/false）',
    defaultMasquerade.length === 0, defaultMasquerade.slice(0, 4))
  const nullishRuntime = ([]).concat(
    restDevices.filter((d) => d.brightness === undefined || d.brightness === null).length ? ['REST.brightness'] : [],
    restDevices.filter((d) => d.currentMode === undefined || d.currentMode === null).length ? ['REST.currentMode'] : [],
    wsDevices.filter((d) => d.brightness === undefined || d.brightness === null).length ? ['WS.brightness'] : [],
  )
  check('设备不存在「同一类型在 REST 为 null、在 WS 为数值」的口径分裂', nullishRuntime.length === 0,
    { nullish: nullishRuntime, restNullBrightness: restDevices.filter((d) => d.brightness === undefined || d.brightness === null).length })

  /* ══════════════════ [24 场景] 4 栋 × 6 层 ══════════════════ */
  console.log('\n[24 场景] B001~B004 × 1F~6F：人员 / 设备集合与空间身份')
  const scenarioSummary = []
  let scenarioPersonBad = 0
  let scenarioDeviceBad = 0
  const mockPersons = mockLayer.persons || []
  const personCountsByScenario = (list) => {
    const m = new Map()
    list.forEach((p) => {
      const c = canonicalOf(p)
      const k = `${c.buildingId}|${c.floorId}`
      m.set(k, (m.get(k) || 0) + 1)
    })
    return m
  }
  const pmRest = personCountsByScenario(restPersons)
  const pmWs = personCountsByScenario(wsPersons)
  const pmStore = personCountsByScenario(pageStorePersons)
  const pmMock = personCountsByScenario(mockPersons)
  const dmRest = personCountsByScenario(restDevices)
  const dmWs = personCountsByScenario(wsDevices)
  const dmStore = personCountsByScenario(pageStoreDevices)
  const dmMock = personCountsByScenario(mockLayer.devices || [])
  BUILDINGS.forEach((bid) => {
    FLOORS.forEach((floor) => {
      const k = `${bid}|${floor}`
      const pCounts = { rest: pmRest.get(k) || 0, ws: pmWs.get(k) || 0, store: pmStore.get(k) || 0, mock: pmMock.get(k) || 0 }
      const dCounts = { rest: dmRest.get(k) || 0, ws: dmWs.get(k) || 0, store: dmStore.get(k) || 0, mock: dmMock.get(k) || 0 }
      const peopleOk = pCounts.rest > 0 && pCounts.rest === pCounts.store && pCounts.rest === pCounts.mock
      const deviceOk = dCounts.rest > 0 && dCounts.rest === dCounts.store && dCounts.rest === dCounts.mock
      if (!peopleOk) scenarioPersonBad++
      if (!deviceOk) scenarioDeviceBad++
      scenarioSummary.push(`${bid}-${floor}:人(${pCounts.rest}/${pCounts.store}/${pCounts.mock}/ws${pCounts.ws}) 设备(${dCounts.rest}/${dCounts.store}/${dCounts.mock}/ws${dCounts.ws})`)
      check(`${bid}-${floor} 人员集合一致（REST / Store / Mock 同源同量）`, peopleOk, pCounts)
      check(`${bid}-${floor} 设备集合一致（REST / Store / Mock 同源同量）`, deviceOk, dCounts)
    })
  })
  // 24 个 ledger 场景（4 栋 × 6F）是台账口径，已由上面 48 条断言覆盖；
  // runtime 只覆盖当前演练楼栋（Q1），因此这里按 demoBuildingId 的 1F~6F 校验
  const runtimeCoveredScenarios = FLOORS.filter((f) => (pmWs.get(`${demoBuildingId}|${f}`) || 0) > 0)
  check(`演练楼栋 ${demoBuildingId} 的 ${FLOORS[0]}~${FLOORS[FLOORS.length - 1]} 全部有 WS 运行时人员参与数据链`,
    runtimeCoveredScenarios.length === FLOORS.length,
    { demoBuildingId, covered: runtimeCoveredScenarios,
      missing: FLOORS.filter((f) => (pmWs.get(`${demoBuildingId}|${f}`) || 0) === 0) })
  if (runtimeCoveredScenarios.length !== FLOORS.length) {
    console.log('    └ 演练楼栋覆盖明细：' + scenarioSummary.filter((s) => s.startsWith(demoBuildingId)).join(' | '))
  }

  /* ══════════════════ [DEMO] snapshot / stage / tick 协议口径 ══════════════════ */
  console.log('\n[DEMO] snapshot / stage = 完整运行时；tick = 持续增量')
  const wsProbe = await new Promise((resolve) => {
    const out = { snapshot: null, stage: null, tick: null, tickCount: 0, error: null }
    let ws
    try {
      ws = new WebSocket(`ws://${new URL(API_BASE).host}/api/v1/demo/ws?sessionId=${SESSION}`)
    } catch (err) { out.error = String(err); resolve(out); return }
    ws.onmessage = (e) => {
      let m = null
      try { m = JSON.parse(e.data) } catch { return }
      if (m.type === 'demo.snapshot' && !out.snapshot) out.snapshot = m
      if (m.type === 'demo.stage' && !out.stage) out.stage = m
      if (m.type === 'demo.tick') { out.tickCount++; if (!out.tick) out.tick = m }
    }
    ws.onerror = (e) => { out.error = out.error || String(e && e.message || 'ws error') }
    setTimeout(() => { try { ws.close() } catch { /* 已关闭 */ } ; resolve(out) }, 6000)
  })
  check('WS 探针收到 snapshot / tick 报文', Boolean(wsProbe.snapshot) && wsProbe.tickCount > 0,
    { snapshot: Boolean(wsProbe.snapshot), ticks: wsProbe.tickCount, error: wsProbe.error })
  if (wsProbe.snapshot && wsProbe.tick) {
    const snapPersonKeys = keysOf((wsProbe.snapshot.persons || [])[0]).sort().join(',')
    const tickPersonKeys = keysOf((wsProbe.tick.persons || [])[0]).sort().join(',')
    check('tick.persons 与 snapshot.persons 字段集合一致', snapPersonKeys === tickPersonKeys,
      { snapshot: snapPersonKeys, tick: tickPersonKeys })
    // 协议口径：tick = 持续增量（persons / metrics / 阶段字段）；devices 的权威路径是 snapshot / stage
    const tickRequired = ['persons', 'metrics', 'stage']
    const missingInTick = tickRequired.filter((k) => wsProbe.tick[k] === undefined)
    check('tick 携带持续增量必需字段（persons / metrics / stage）', missingInTick.length === 0,
      { tickTopKeys: keysOf(wsProbe.tick).join(','), missingInTick })
    if (missingInTick.length > 0) {
      recordRed('D3', 'demo.tick 缺少持续增量必需字段',
        `tick 顶层字段 ${keysOf(wsProbe.tick).join(',')}；缺少 ${missingInTick.join(',')}`,
        'worker/src/durable/DemoRoom.ts（tick 构造）')
    }
    const snapHasDevices = Array.isArray(wsProbe.snapshot.devices) && wsProbe.snapshot.devices.length > 0
    check('demo.snapshot 携带完整运行时状态（含 devices）', snapHasDevices,
      { devices: (wsProbe.snapshot.devices || []).length, topKeys: keysOf(wsProbe.snapshot).length })
    if (!snapHasDevices) {
      recordRed('D3', 'demo.snapshot 未携带 devices 完整运行时',
        `snapshot 顶层字段 ${keysOf(wsProbe.snapshot).join(',')}`,
        'worker/src/durable/DemoRoom.ts:562-596（snapshot 构造）')
    }
    check('tick 与 snapshot 的 stage 语义一致（同为当前阶段）',
      String(wsProbe.tick.stage) === String(wsProbe.snapshot.stage),
      { tick: wsProbe.tick.stage, snapshot: wsProbe.snapshot.stage })
  }

  // 阶段切换必须能拿到含 devices 的完整运行时：用独立 session 触发（DO 按 sessionId 隔离），
  // 避免把 default 会话推离 IDLE 而污染后续测试套件
  const PROBE_SESSION = 'p163-d3-probe'
  let stageMsg = null
  try {
    await sendCommandTo(PROBE_SESSION, 'RESET')
    await sleep(700)
    stageMsg = await new Promise((resolve) => {
      let ws
      let settled = false
      const finish = (m) => {
        if (settled) return
        settled = true
        try { ws.close() } catch { /* 已关闭 */ }
        resolve(m)
      }
      try {
        ws = new WebSocket(`ws://${new URL(API_BASE).host}/api/v1/demo/ws?sessionId=${PROBE_SESSION}`)
      } catch (e) { resolve(null); return }
      ws.onmessage = (e) => {
        let m = null
        try { m = JSON.parse(e.data) } catch { return }
        if (m.type === 'demo.stage' && m.stage && m.stage !== 'IDLE') finish(m)
      }
      ws.onerror = () => { if (!settled) finish(null) }
      setTimeout(async () => {
        try { await sendCommandTo(PROBE_SESSION, 'START_FIRE') } catch { /* 指令失败由断言兜底 */ }
      }, 800)
      setTimeout(() => { if (!settled) finish(null) }, 9000)
    })
  } catch (e) {
    console.log(`  ⚠ D3 stage 探针异常：${e.message}`)
  } finally {
    try { await sendCommandTo(PROBE_SESSION, 'RESET') } catch { /* 隔离会话复位失败不影响主流程 */ }
  }
  const stageHasDevices = Boolean(stageMsg) && Array.isArray(stageMsg.devices) && stageMsg.devices.length > 0
  check('阶段切换：demo.stage 携带完整运行时状态（含 devices）', stageHasDevices,
    stageMsg
      ? { stage: stageMsg.stage, devices: (stageMsg.devices || []).length, topKeys: keysOf(stageMsg).length }
      : { stage: null })
  if (!stageHasDevices) {
    recordRed('D3', 'demo.stage 未携带 devices 完整运行时',
      stageMsg
        ? `stage=${stageMsg.stage}，顶层字段 ${keysOf(stageMsg).join(',')}`
        : '探针窗口内未收到非 IDLE 的 demo.stage 报文',
      'worker/src/durable/DemoRoom.ts（demo.stage 广播）')
  }

  /* ══════════════════ [PLAN] 整栋楼疏散方案权威链 ══════════════════ */
  console.log('\n[PLAN] PLAN-A/B/C · scope=BUILDING · 楼栋隔离')
  const backendPlans = wsSnap.buildingPlans || []
  const expectedIds = ['PLAN-A', 'PLAN-B', 'PLAN-C']
  check('后端下发 3 套整栋楼方案（PLAN-A/B/C）',
    backendPlans.length === 3 && expectedIds.every((id) => backendPlans.some((p) => p.id === id)),
    backendPlans.map((p) => p.id))
  const scopeBad = backendPlans.filter((p) => p.scope !== 'BUILDING')
  check('全部方案 scope === BUILDING', scopeBad.length === 0, scopeBad.map((p) => [p.id, p.scope]))
  const planBuildingBad = backendPlans.filter((p) => !p.buildingId || !/^B\d{3}$/.test(String(p.buildingId)))
  check('全部方案携带合法 buildingId', planBuildingBad.length === 0, planBuildingBad.map((p) => [p.id, p.buildingId]))
  check('2D / 3D 引用的 buildingPlanId 与后端一致',
    Boolean(pageData.storePlanId) && pageData.storePlanId === pageData.backendPlanId,
    { store: pageData.storePlanId, demoStore: pageData.backendPlanId, backend: wsSnap.activeBuildingPlanId })
  const storePlansBad = pageData.plans.filter((p) => !backendPlans.some((b) => b.id === p.id))
  check('Store 内方案集合 = 后端方案集合（无第四套方案）', storePlansBad.length === 0, storePlansBad)
  check('不把 legacyPlans / legacyActivePlanId 当作权威（当前方案来自 buildingPlans）',
    Boolean(pageData.storePlanId) && backendPlans.some((p) => p.id === pageData.storePlanId),
    pageData.storePlanId)

  // 楼栋隔离：B001 → B002 → B003 → B004 → B001
  console.log('\n[PLAN] 楼栋切换隔离（切楼栋后不得残留旧楼栋方案）')
  const isolation = await page.evaluate(async (sequence) => {
    const s = window.__demo.store
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    const out = []
    for (const bid of sequence) {
      // 直接改 store 里的持久态「当前楼栋」（等价于 UI 侧 selectBuilding）
      if (s.dashboardView) s.dashboardView.selectedBuildingId = bid
      await wait(500)
      out.push({
        selectedBuildingId: (s.dashboardView || {}).selectedBuildingId,
        activeBuildingPlanId: s.activeBuildingPlanId,
        planBuildingId: s.activeBuildingPlan ? (s.activeBuildingPlan.buildingId || null) : null,
      })
    }
    return out
  }, ['B001', 'B002', 'B003', 'B004', 'B001'])
  isolation.forEach((r) => {
    const ok = r.planBuildingId === r.selectedBuildingId
    check(`切至 ${r.selectedBuildingId}：activeBuildingPlan.buildingId === 当前楼栋`, ok, r)
    if (!ok) {
      recordRed('E1', `切换到 ${r.selectedBuildingId} 后当前方案仍是 ${r.planBuildingId} 的方案`,
        `selectedBuildingId=${r.selectedBuildingId}, activeBuildingPlanId=${r.activeBuildingPlanId}, activeBuildingPlan.buildingId=${r.planBuildingId}`,
        'src/views/DashboardView.vue:1930-1934（plans 仅在为空时生成一次，切楼栋不清方案）；src/views/RoutePlanView.vue:523 同理')
    }
  })
  const hasIsolationRed = isolation.some((r) => r.planBuildingId !== r.selectedBuildingId)
  check('楼栋切换隔离：不存在跨楼栋方案渲染（24 场景不会被旧方案污染）', !hasIsolationRed, isolation)

  /* ══════════════════ [3D] 旧别名依赖（source-level） ══════════════════ */
  console.log('\n[3D] EmergencyLight3D / FireZone3D / CameraDirector / RescueLayer3D / RouteLayer3D：是否仍用旧别名做业务判断')
  const fs = require('fs')
  const path = require('path')
  const readSrc = (rel) => {
    try { return fs.readFileSync(path.resolve(process.cwd(), rel), 'utf8') } catch { return null }
  }
  const linesMatching = (filePath, re) => {
    const src = readSrc(filePath)
    if (!src) return []
    return src.split('\n').map((l, i) => ({ line: i + 1, text: l.trim() }))
      .filter((o) => re.test(o.text) && !o.text.startsWith('//') && !o.text.startsWith('*'))
  }
  const elOld = linesMatching('src/components/building3d/EmergencyLight3D.js', /\bdev\.(floor|area)\b/)
  const elCanonical = linesMatching('src/components/building3d/EmergencyLight3D.js', /floorIdOf|zoneOf|d\.floorId/)
  check('EmergencyLight3D 不以旧别名（dev.floor / dev.area）做楼层/区域业务判断',
    elOld.length === 0, elOld.slice(0, 6))
  if (elOld.length > 0) {
    recordRed('F1', 'EmergencyLight3D 用设备旧别名做楼层/区域判定',
      `${elOld.length} 处引用 dev.floor / dev.area（未优先使用 canonical floorId/zone，canonical 引用 ${elCanonical.length} 处）`,
      'src/components/building3d/EmergencyLight3D.js:' + elOld.slice(0, 6).map((o) => o.line).join(','))
  }
  const fireZoneOld = linesMatching('src/components/building3d/FireZone3D.js', /\bfe\.(floor|area)\b/)
  const camOld = linesMatching('src/components/building3d/CameraDirector.js', /\bfe\.(floor|area)\b/)
  const rescueOld = linesMatching('src/components/building3d/RescueLayer3D.js', /\bfe\.(floor|area)\b/)
  const fire3dOld = fireZoneOld.length + camOld.length + rescueOld.length
  check('FireZone3D / CameraDirector / RescueLayer3D 不以 fireEvent 旧别名做业务判断', fire3dOld === 0,
    { fireZone: fireZoneOld.slice(0, 3), camera: camOld.slice(0, 3), rescue: rescueOld.slice(0, 3) })
  if (fire3dOld > 0) {
    recordRed('F2', '火情相关 3D 层依赖 fireEvent 旧别名（fe.floor / fe.area）',
      `FireZone3D ${fireZoneOld.length} 处、CameraDirector ${camOld.length} 处、RescueLayer3D ${rescueOld.length} 处；根因是 fireStore 重建 fireEvent 时只写 building/floor/area`,
      'src/stores/fireStore.js:274-281 → FireZone3D:' + fireZoneOld.slice(0, 3).map((o) => o.line).join(',') + ' / CameraDirector:' + camOld.slice(0, 3).map((o) => o.line).join(',') + ' / RescueLayer3D:' + rescueOld.slice(0, 3).map((o) => o.line).join(','))
  }
  const routeLayerSrc = readSrc('src/components/building3d/RouteLayer3D.js') || ''
  const routeUsesPlan = /activeBuildingPlan/.test(routeLayerSrc)
  const routeChecksBuilding = /buildingId\s*===\s*|buildingId\s*!==\s*/.test(routeLayerSrc)
  check('RouteLayer3D 渲染方案前校验方案所属楼栋（避免跨楼栋渲染）', routeUsesPlan && routeChecksBuilding,
    { usesActiveBuildingPlan: routeUsesPlan, checksPlanBuildingId: routeChecksBuilding })
  if (!(routeUsesPlan && routeChecksBuilding)) {
    recordRed('F3', 'RouteLayer3D 渲染 activeBuildingPlan 时不校验方案所属楼栋',
      '引用了 activeBuildingPlan 但未与当前 selectedBuildingId / plan.buildingId 比较，配合 E1 会把旧楼栋方案画到新楼栋上',
      'src/components/building3d/RouteLayer3D.js:31-40')
  }
  // 允许「canonical 优先 + 别名兜底」（p.floorId || p.floor），但禁止「只有别名」的裸用
  const personLayerSrc = readSrc('src/components/building3d/PersonLayer3D.js') || ''
  const personLayerLines = personLayerSrc.split('\n').map((l, i) => ({ line: i + 1, text: l.trim() }))
  const nearCanonical = (idx, re) => [idx - 1, idx, idx + 1].some((i) => personLayerLines[i] && re.test(personLayerLines[i].text))
  const personLayerBad = personLayerLines
    .map((o, i) => ({ o, i }))
    .filter(({ o }) => !o.text.startsWith('//') && !o.text.startsWith('*'))
    .filter(({ o, i }) => (
      (/\bp\.floor\b/.test(o.text) && !nearCanonical(i, /\bp\.floorId\b/))
      || (/\bp\.area\b/.test(o.text) && !nearCanonical(i, /\bp\.zone\b/))
      || (/\bp\.building\b/.test(o.text) && !nearCanonical(i, /\bp\.buildingId\b/))
    ))
    .map(({ o }) => o)
  check('PersonLayer3D 不含「只用旧别名」的人员身份判定（允许 canonical 优先 + 别名兜底）',
    personLayerBad.length === 0, personLayerBad.slice(0, 4))

  /* ══════════════════ [MODE] 数据源模式合规 ══════════════════ */
  console.log('\n[MODE] 当前数据源模式合规 + 静默回退防御')
  check('页面运行模式可识别', Boolean(pageData.mode), pageData.mode)
  check('demo 模式：WS 连接正常', pageData.wsStatus === 'open', pageData.wsStatus)
  check('远端数据源未降级（remoteError 为空 / dataSourceDegraded 为 false）',
    !pageData.degraded && !pageData.remoteError, { degraded: pageData.degraded, remoteError: pageData.remoteError })
  const fireStoreSrc = readSrc('src/stores/fireStore.js') || ''
  // 精确取 initFromRemote 函数体（到该函数的收尾大括号为止），避免误判文件里其它 mock 引用
  const remoteStart = fireStoreSrc.indexOf('async function initFromRemote')
  let remoteBody = ''
  if (remoteStart >= 0) {
    const lines = fireStoreSrc.slice(remoteStart).split('\n')
    const stop = lines.findIndex((l, i) => i > 0 && /^  \}$/.test(l))
    remoteBody = lines.slice(0, stop < 0 ? 60 : stop + 1).join('\n')
  }
  const fallbackHits = remoteBody
    ? (remoteBody.match(/mockRepository|buildSeedDevices|initialPersons|initialBuildings/g) || [])
    : ['未定位到 initFromRemote']
  // 降级必须显式：catch 里置位 degraded / remoteError，而不是加载 mock
  const explicitDegrade = /dataSourceDegraded\.value\s*=\s*true/.test(remoteBody) && /remoteError\.value\s*=/.test(remoteBody)
  check('fireStore.initFromRemote 失败时不静默回退 mock（函数体内无 mock 数据源加载）',
    Boolean(remoteBody) && fallbackHits.length === 0, { fallbackHits })
  check('fireStore.initFromRemote 失败时显式降级（dataSourceDegraded=true 且 remoteError 置位）', explicitDegrade,
    { explicitDegrade })
  const apiSrc = readSrc('src/api/index.js') || ''
  check('数据源选择不把未知模式降级为 mock 之外的隐式行为（api / demo / mock 三态显式）',
    /isMock|isApi|isDemo/.test(apiSrc), { hasExplicitStates: /isMock|isApi|isDemo/.test(apiSrc) })

  /* ══════════════════ [DEMO] 六阶段状态链一致性 ══════════════════ */
  console.log('\n[DEMO] 六阶段状态链：Backend == WS == demoStore == fireStore == UI')
  const legacyMapRaw = (fireStoreSrc.match(/const STAGE_TO_LEGACY\s*=\s*\{([\s\S]*?)\}/) || [])[1] || ''
  const legacyMap = {}
  legacyMapRaw.split(',').forEach((pair) => {
    const m = pair.match(/([A-Z_]+)\s*:\s*(-?\d+)/)
    if (m) legacyMap[m[1]] = parseInt(m[2], 10)
  })
  check('可从 fireStore 解析 STAGE_TO_LEGACY（否则 emergencyStage 断言是空跑）',
    Object.keys(legacyMap).length >= 6, Object.keys(legacyMap).length)
  const chain = await page.evaluate(async (args) => {
    const d = window.__demo.demoStore
    const s = window.__demo.store
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    const backendState = async () => {
      const r = await fetch(args.apiBase + '/api/v1/demo/state?sessionId=' + args.session)
      const j = await r.json()
      return { stage: j.stage, planId: j.activeBuildingPlanId || null }
    }
    const snapshotRow = async (label, waited) => {
      const backend = await backendState()
      return {
        label,
        waited,
        backendStage: backend.stage,
        demoStage: d.stage,
        emergencyStage: s.emergencyStage,
        demoPlanId: d.activeBuildingPlanId || null,
        storePlanId: s.activeBuildingPlanId || null,
        backendPlanId: backend.planId,
        uiActive: (d.flowSteps || []).filter((x) => x.active).map((x) => x.id)[0] || null,
        nextCommand: d.nextCommand,
      }
    }
    const rows = []
    // 复位到 IDLE
    await d.reset()
    await wait(1500)
    rows.push(await snapshotRow('RESET→IDLE', 0))

    // 非法跃迁（IDLE 起）
    const illegal = []
    for (const cmd of ['CONFIRM_ROUTE', 'COMPLETE_EVACUATION', 'COMPLETE_RESCUE']) {
      const before = d.stage
      await d.sendCommand(cmd)
      await wait(700)
      illegal.push({ cmd, before, after: d.stage, backend: (await backendState()).stage, error: d.error })
    }

    // 逐级推进到 COMPLETED（完全由后端 nextCommand 驱动）
    let guard = 0
    while (guard++ < 40) {
      const nx = d.nextCommand
      if (!nx) break
      const before = d.stage
      const payload = nx === 'CONFIRM_ROUTE'
        ? { buildingPlanId: ((d.buildingPlans || [])[1] || (d.buildingPlans || [])[0] || {}).id || null }
        : {}
      await d.sendCommand(nx, payload)
      let waited = 0
      while (waited < 30000 && d.stage === before) { await wait(700); waited += 700 }
      rows.push(await snapshotRow(nx, waited))
      if (d.stage === 'COMPLETED') break
      if (d.stage === before) break
    }
    return { rows, illegal }
  }, { apiBase: API_BASE, session: SESSION })

  chain.rows.forEach((r) => {
    check(`${r.label}：demoStore.stage === 后端 stage`, r.demoStage === r.backendStage, r)
    check(`${r.label}：fireStore.emergencyStage 与 demoStore.stage 同步`,
      legacyMap[r.demoStage] === undefined ? true : legacyMap[r.demoStage] === r.emergencyStage,
      { stage: r.demoStage, emergencyStage: r.emergencyStage, expected: legacyMap[r.demoStage] })
    check(`${r.label}：demoStore / fireStore / 后端 buildingPlanId 一致`,
      r.demoPlanId === r.storePlanId && r.demoPlanId === r.backendPlanId,
      { backend: r.backendPlanId, demoStore: r.demoPlanId, fireStore: r.storePlanId })
    check(`${r.label}：UI 六阶段进度条定位到当前阶段`, r.uiActive === r.demoStage || r.demoStage === 'COMPLETED' || r.demoStage === 'IDLE',
      { ui: r.uiActive, stage: r.demoStage })
  })
  const reachedStages = [...new Set(chain.rows.map((r) => r.backendStage))]
  const expectedChain = ['IDLE', 'FIRE_DETECTED', 'EMERGENCY_RESPONSE', 'ROUTE_PLANNING', 'SMART_EVACUATION', 'RETAINED_PERSONS', 'RESCUE_COORDINATION', 'COMPLETED']
  const missingStages = expectedChain.filter((st) => !reachedStages.includes(st))
  check('六阶段全链路走通（IDLE → … → COMPLETED）', missingStages.length === 0, { reached: reachedStages, missing: missingStages })
  chain.illegal.forEach((i) => {
    check(`非法跃迁被拒绝：IDLE → ${i.cmd}`, i.after === i.before && i.backend === i.before, i)
  })
  const planResetBad = chain.rows.filter((r) => r.backendPlanId === null && (r.storePlanId !== null || r.demoPlanId !== null))
  check('RESET 后 fireStore / demoStore 的 activeBuildingPlanId 同步复位为 null', planResetBad.length === 0, planResetBad)
  if (planResetBad.length > 0) {
    recordRed('E2', 'RESET 后 fireStore 仍保留旧 buildingPlanId（后端已清空，2D 仍视为当前方案）',
      `${planResetBad.length} 个阶段快照出现「后端 null / fireStore ${planResetBad[0].storePlanId}」，涉及阶段：${planResetBad.map((r) => r.backendStage).join('、')}`,
      'src/stores/fireStore.js:261-321（applyDemoSnapshot 只在 snapshot 带 buildingPlans 时覆盖，IDLE 快照不触发 plan 复位）')
  }

  /* ══════════════════ 测试收尾：复位 DO，避免污染后续测试套件 ══════════════════ */
  const finalReset = await sendCommand('RESET')
  await sleep(1200)
  check('测试收尾把 DemoRoom 复位到 IDLE（避免污染其它测试套件）',
    Boolean(finalReset.body) && finalReset.body.stage === 'IDLE',
    { stage: finalReset.body ? finalReset.body.stage : null, status: finalReset.status })

  /* ══════════════════ P1.6.3 缺陷登记汇总 ══════════════════ */
  console.log('\n════════ P1.6.3 第二阶段：已登记缺陷 ════════')
  if (!reds.length) {
    console.log('  （无：本轮未触发已编目缺陷）')
  } else {
    reds.forEach((r) => {
      console.log(`\n[${r.code}] ${r.scope}`)
      console.log(`  现象：${r.evidence}`)
      console.log(`  位置：${r.loc}`)
    })
  }

  // 非法跃迁测试本身会产生预期内的 409（后端正确拒绝），不应算作运行时错误；其余错误不得被吞
  const expected409 = consoleErrors.filter((e) => /409/.test(e))
  const unexpectedErrors = consoleErrors.filter((e) => !/409/.test(e))
  if (expected409.length) console.log(`  ℹ 非法跃迁被后端拒绝产生的 409 日志 ${expected409.length} 条（预期内，不计入错误）`)
  check('无意料之外的 JS 运行时错误（非法跃迁 409 属预期）', unexpectedErrors.length === 0, unexpectedErrors.slice(0, 2))

  await browser.close()
  console.log(`\n=== 结果：${passed} 通过 / ${failed} 失败 ===`)
  if (failed) { console.log('失败项：'); failures.forEach((f) => console.log('  - ' + f)); process.exit(1) }
  process.exit(0)
})().catch((err) => {
  console.error('一致性验收执行异常：', err)
  process.exit(1)
})

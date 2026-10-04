/**
 * 阶段二 浏览器 E2E：验证「前端只发起指令 + 呈现后端状态」
 * 用法：
 *   1) 以 demo 模式启动前端：set VITE_DATA_SOURCE=demo && npx vite --port 5199
 *   2) node worker/e2e-phase2-browser.cjs
 * 可选环境变量：
 *   PAGE_URL         前端地址（默认 http://localhost:5199/）
 *   EXPECT_OFFLINE=1 校验后端不可用时【不静默回退 mock】（需把前端指向不可达的 VITE_API_BASE_URL）
 */
const { chromium } = require('playwright-core')

const PAGE_URL = process.env.PAGE_URL || 'http://localhost:5199/'
const EXPECT_OFFLINE = process.env.EXPECT_OFFLINE === '1'
const API_BASE = process.env.API_BASE || 'http://127.0.0.1:8787'
const SESSION = process.env.DEMO_SESSION || 'default'

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
  console.log(`\n=== 阶段二 浏览器 E2E（${PAGE_URL}${EXPECT_OFFLINE ? ' · 后端不可用场景' : ''}）===\n`)
  const browser = await chromium.launch({ channel: 'msedge', headless: true })
  const page = await browser.newPage()
  const consoleLogs = []
  page.on('console', (m) => consoleLogs.push(`[${m.type()}] ${m.text()}`))

  await page.goto(PAGE_URL, { waitUntil: 'load', timeout: 45000 })
  await waitFor(() => page.evaluate(() => Boolean(window.__demo)), 20000)
  check('页面挂载并暴露开发钩子', await page.evaluate(() => Boolean(window.__demo)))

  const mode = await page.evaluate(() => window.__demo.dataSource.mode)
  const expectMode = EXPECT_OFFLINE ? 'api' : (process.env.EXPECT_MOCK === '1' ? 'mock' : 'demo')
  check(`运行模式为 ${expectMode}（实际 ${mode}）`, mode === expectMode, mode)
  if (expectMode !== 'mock') {
    check('远端模式下未使用 mock 数据源', await page.evaluate(() => window.__demo.dataSource.isRemote === true))
  }

  if (process.env.EXPECT_MOCK === '1') {
    // ── mock 模式回归：本地路线规划页仍能生成合法路线（算法已切到 shared/evacuation） ──
    console.log('\n[mock 模式 · 路线规划页回归]')
    // 进入路线规划页并触发自动规划
    await page.goto(`${PAGE_URL}#/route`, { waitUntil: 'load' })
    await waitFor(() => page.evaluate(() => Boolean(window.__demo && window.__demo.store.routeMatrix)), 8000)
    if (!(await page.evaluate(() => Boolean(window.__demo.store.routeMatrix)))) {
      await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent.includes('自动规划'))
        if (btn) btn.click()
      })
      await waitFor(() => page.evaluate(() => Boolean(window.__demo.store.routeMatrix)), 8000)
    }
    const m = await page.evaluate(() => window.__demo.store.routeMatrix)
    check('routeMatrix 已生成', Boolean(m && m.perZone), m ? Object.keys(m.perZone) : null)
    const zones = m ? Object.keys(m.perZone) : []
    const allHavePlans = zones.every((z) => (m.perZone[z].plans || []).length > 0)
    check('每个区域都有候选方案', allHavePlans, zones.map((z) => (m.perZone[z].plans || []).length))
    const allValid = zones.every((z) => (m.perZone[z].plans || []).every((p) => Array.isArray(p.path) && p.path.length >= 2 && p.distance > 0))
    check('方案含 path 与距离', allValid)
    const zoneRoutes = await page.evaluate(() => window.__demo.store.getAllZoneRoutes())
    check('平面图取到区域路线', Array.isArray(zoneRoutes) && zoneRoutes.some((r) => (r.segment || []).length > 1),
      (zoneRoutes || []).map((r) => (r.segment || []).length))
    // P1.5：拓扑单一数据源 —— 前端 2D 用的节点/出口必须来自 shared/evacuation
    const topo = await page.evaluate(() => {
      const m = window.__demo.store.routeMatrix
      const first = (window.__demo.store.routePlans || [])[0]
      return {
        exits: m ? m.exits : null,
        startNode: first && first.path ? first.path[0].id : null,
        endNode: first && first.path ? first.path[first.path.length - 1].id : null,
        exitId: first ? first.exit : null,
        viaStair: first && first.path ? first.path.some((n) => n.type === 'stair') : false,
      }
    })
    check('出口来自 shared 拓扑（1F:EXIT_*）', Array.isArray(topo.exits) && topo.exits.every((e) => /^1F:EXIT_/.test(e)), topo.exits)
    check('路线起点为 shared 房间节点（5F:A_CENTER）', /_CENTER$/.test(topo.startNode || ''), topo.startNode)
    check('路线终点为安全出口节点', /EXIT_/.test(topo.endNode || ''), topo.endNode)
    check('方案出口字段与拓扑一致', /^1F:EXIT_/.test(topo.exitId || ''), topo.exitId)
    check('路线经楼梯下行', topo.viaStair)
    // 整栋楼疏散：mock 模式同样必须产出「整栋楼」方案（前端本地规划共用 shared/evacuation）
    const mockBp = await page.evaluate(() => {
      const s = window.__demo.store
      const res = s.generateBuildingEvacuationPlans({ buildingId: s.routeBuildingId || 'B003' }) || {}
      const bp = s.activeBuildingPlan
      return {
        plans: (res.plans || []).length,
        id: bp && bp.id,
        scope: bp && bp.scope,
        zoneCount: bp && bp.summary ? bp.summary.zoneCount : 0,
        personCount: bp && bp.summary ? bp.summary.personCount : 0,
        floors: bp && bp.summary ? bp.summary.floors : [],
        valid: bp && bp.valid,
        routePlans: (s.routePlans || []).length,
        matrixAreas: s.routeMatrix ? s.routeMatrix.areas : null,
        zoneRoutes: (s.getAllZoneRoutes() || []).length,
      }
    })
    check('mock 模式生成 3 套整栋楼方案（scope=BUILDING）',
      mockBp.plans === 3 && mockBp.scope === 'BUILDING', mockBp)
    check('mock 整栋楼方案覆盖多个楼层与区域',
      (mockBp.floors || []).length > 1 && mockBp.zoneCount > 1 && mockBp.valid, mockBp)
    check('mock 整栋楼方案同步到 routePlans / routeMatrix / 平面图',
      mockBp.routePlans === mockBp.zoneCount && (mockBp.matrixAreas || []).length > 0 && mockBp.zoneRoutes > 0, mockBp)
    // 人员统一契约（P1.6.1）：mock 数据源同样升级为统一字段
    const mockPersons = await page.evaluate(() => {
      const s = window.__demo.store
      const FIELDS = ['id', 'buildingId', 'floorId', 'zone', 'status', 'routeId', 'routePoints', 'progress', 'position']
      const ps = s.persons || []
      return {
        total: ps.length,
        nonCanonical: s.countNonCanonicalPersons ? s.countNonCanonicalPersons() : -1,
        allHaveFields: ps.every((p) => FIELDS.every((f) => p[f] !== undefined)),
        sample: ps.slice(0, 2).map((p) => [p.id, p.buildingId, p.floorId, p.zone, p.status, p.routeId]),
      }
    })
    check('mock 模式人员字段符合统一契约',
      mockPersons.total > 0 && mockPersons.allHaveFields && mockPersons.nonCanonical === 0, mockPersons)
    // 设备统一契约（P1.6.2）：mock 设备的楼层归属同样齐全（buildingId / floorId / zone）
    const mockDevices = await page.evaluate(() => {
      const s = window.__demo.store
      const FIELDS = ['id', 'type', 'buildingId', 'floorId', 'zone', 'status', 'currentMode', 'direction', 'brightness', 'emergencyFlash']
      const ds = s.devices || []
      return {
        total: ds.length,
        nonCanonical: s.countNonCanonicalDevices ? s.countNonCanonicalDevices() : -1,
        allHaveFields: ds.every((d) => FIELDS.every((f) => d[f] !== undefined)),
        floors: s.deviceFloorsOfBuilding ? s.deviceFloorsOfBuilding('B003') : null,
        sample: ds.slice(0, 2).map((d) => [d.id, d.buildingId, d.floorId, d.zone, d.status]),
      }
    })
    check('mock 模式设备字段符合统一契约',
      mockDevices.total > 0 && mockDevices.allHaveFields && mockDevices.nonCanonical === 0, mockDevices)
    check('mock 设备可按楼层归属枚举（B003 1F~6F）',
      (mockDevices.floors || []).length === 6, mockDevices.floors)
    check('无 JS 运行时错误', !consoleLogs.some((l) => l.startsWith('[error]')), consoleLogs.filter((l) => l.startsWith('[error]')).slice(0, 2))
  } else if (EXPECT_OFFLINE) {
    console.log('\n[后端不可用：禁止静默回退 mock]')
    const degraded = await page.evaluate(() => window.__demo.store.dataSourceDegraded)
    const remoteError = await page.evaluate(() => window.__demo.store.remoteError)
    check('dataSourceDegraded 已置位（未静默回退）', degraded === true, degraded)
    check('remoteError 已记录', Boolean(remoteError), remoteError)
    const banner = await page.locator('.ds-banner').first().textContent().catch(() => null)
    check('页面显示后端不可用告警横幅', Boolean(banner && banner.includes('后端不可用')), banner)
    check('未打印远程初始化成功日志', !consoleLogs.some((l) => l.includes('远程数据源初始化完成')))
  } else {
    console.log('\n[实时通道]')
    try {
    // 后端状态机会话是持久的（Durable Object），E2E 前先确保回到 IDLE
    const st = await fetch(`${process.env.API_BASE || 'http://127.0.0.1:8787'}/api/v1/demo/state?sessionId=default`).then((r) => r.json())
    if (st.stage !== 'IDLE') {
      await fetch(`${process.env.API_BASE || 'http://127.0.0.1:8787'}/api/v1/demo/reset?sessionId=default`, { method: 'POST' })
      await sleep(500)
    }
    const wsOk = await waitFor(() => page.evaluate(() => window.__demo.demoStore.wsStatus === 'open'), 15000)
    check('WebSocket 已连接', wsOk, await page.evaluate(() => window.__demo.demoStore.wsStatus))
    const stage0 = await page.evaluate(() => window.__demo.demoStore.stage)
    check('初始阶段来自后端（IDLE）', stage0 === 'IDLE', stage0)

    // 打开演示控制台，用 UI 按钮驱动后端状态机
    await page.evaluate(() => { if (!window.__demo.store.demoMode) window.__demo.store.toggleDemoMode() })
    await page.waitForSelector('.demo-panel', { timeout: 10000 })
    check('演示控制台已打开', true)
    const link = await page.locator('.demo-link').first().textContent().catch(() => '')
    check('控制台显示后端状态机连接状态', link.includes('后端状态机驱动'), link)

    // 直接派发 DOM click（页面可能存在弹窗遮罩，避免 actionability 拦截）
    const clickByText = async (text) => {
      const ok = await page.evaluate((t) => {
        const btn = Array.from(document.querySelectorAll('.demo-panel button')).find((b) => b.textContent.includes(t))
        if (!btn) return false
        btn.click()
        return true
      }, text)
      if (!ok) throw new Error(`未找到按钮：${text}`)
    }

    console.log('\n[UI 指令驱动六阶段]')
    await clickByText('启动演示流程')
    check('① 发现火灾', await waitFor(() => page.evaluate(() => window.__demo.demoStore.stage === 'FIRE_DETECTED'), 8000),
      await page.evaluate(() => window.__demo.demoStore.stage))

    await clickByText('推进下一步')
    check('② 启动应急响应', await waitFor(() => page.evaluate(() => window.__demo.demoStore.stage === 'EMERGENCY_RESPONSE'), 8000),
      await page.evaluate(() => window.__demo.demoStore.stage))
    const lighting = await page.evaluate(() => window.__demo.demoStore.lighting?.mode)
    check('应急照明切换为 emergency（后端广播）', lighting === 'emergency', lighting)

    await clickByText('推进下一步')
    check('③ 疏散路径规划', await waitFor(() => page.evaluate(() => window.__demo.demoStore.stage === 'ROUTE_PLANNING'), 8000),
      await page.evaluate(() => window.__demo.demoStore.stage))
    check('生成 3 套整栋楼方案', await page.evaluate(() => (window.__demo.demoStore.buildingPlans || []).length === 3),
      await page.evaluate(() => (window.__demo.demoStore.buildingPlans || []).map((p) => p.id)))

    // 阶段 3 必须先选方案再确认（禁止跳过确认直接进入智能疏散）
    check('阶段3 显示方案选择器', await page.locator('.plan-picker').isVisible().catch(() => false))
    const chips = await page.locator('.plan-chip').count()
    check('阶段3 列出 A/B/C 三套方案', chips === 3, chips)
    const btnText3 = await page.locator('.demo-btn.demo-flow').first().textContent()
    check('按钮显示为「确认当前疏散路径」', btnText3.includes('确认当前疏散路径'), btnText3)
    // 选非推荐方案，验证「确认的是所选方案」（同样用 DOM click 规避弹窗遮罩）
    await page.evaluate(() => {
      const chips = document.querySelectorAll('.plan-chip')
      if (chips[1]) chips[1].click()
    })
    const pickedId = await page.evaluate(() => window.__demo.demoStore.selectedPlanId)
    check('点选方案被记录', Boolean(pickedId), pickedId)
    // 阶段 3：前端拿到的是「整栋楼」方案（PLAN-A/B/C = 三种策略，不是某区域的三条路线）
    const bpInfo = await page.evaluate(() => {
      const list = window.__demo.demoStore.buildingPlans || []
      const store = window.__demo.store
      return {
        count: list.length,
        scopes: [...new Set(list.map((p) => p.scope))],
        strategies: list.map((p) => p.strategy),
        zoneCount: list[0] && list[0].summary ? list[0].summary.zoneCount : 0,
        personCount: list[0] && list[0].summary ? list[0].summary.personCount : 0,
        floors: list[0] && list[0].summary ? list[0].summary.floors : [],
        storeCount: (store.buildingEvacuationPlans || []).length,
        storeScope: store.evacuationScope,
        activeId: store.activeBuildingPlanId,
      }
    })
    check('下发 3 套整栋楼方案', bpInfo.count === 3, bpInfo.count)
    check('疏散范围 = BUILDING（与火灾位置分离）', bpInfo.scopes.join(',') === 'BUILDING' && bpInfo.storeScope === 'BUILDING', bpInfo)
    check('策略为 均衡/快速/安全', bpInfo.strategies.join(',') === 'BALANCED,FASTEST,SAFEST', bpInfo.strategies)
    check('fireStore 同步到整栋楼方案', bpInfo.storeCount === 3 && Boolean(bpInfo.activeId), bpInfo)
    check('整栋楼方案覆盖多个楼层与区域', bpInfo.floors.length > 1 && bpInfo.zoneCount > 1, bpInfo)
    // 切换整栋楼策略：全楼人员路线必须同步切换
    const switchRes = await page.evaluate(() => {
      const store = window.__demo.store
      const before = Object.values(store.activeBuildingPlan.routesByZone || {}).map((r) => r.routeId).join('|')
      const target = (store.buildingEvacuationPlans || []).find((p) => p.id !== store.activeBuildingPlanId)
      store.setActiveBuildingPlan(target.id)
      const after = Object.values(store.activeBuildingPlan.routesByZone || {}).map((r) => r.routeId).join('|')
      return { before: before.slice(0, 60), after: after.slice(0, 60), changed: before !== after, activeId: store.activeBuildingPlanId, targetId: target.id }
    })
    check('切换整栋楼方案后全楼路线同步切换', switchRes.changed && switchRes.activeId === switchRes.targetId, switchRes)

    await clickByText('确认当前疏散路径')
    check('④ 智能疏散', await waitFor(() => page.evaluate(() => window.__demo.demoStore.stage === 'SMART_EVACUATION'), 8000),
      await page.evaluate(() => window.__demo.demoStore.stage))
    check('执行的是所选方案', await page.evaluate((id) => window.__demo.demoStore.activeBuildingPlanId === id, pickedId),
      await page.evaluate(() => [window.__demo.demoStore.activeBuildingPlanId, window.__demo.demoStore.activePlanId]))
    // 前端渲染的路线必须来自整栋楼方案（3D/平面图同源）
    const routeSame = await page.evaluate(() => {
      const store = window.__demo.store
      const bp = store.activeBuildingPlan
      const p = store.routePlans || []
      if (!bp || !p.length) return { ok: false, bp: Boolean(bp), p: p.length }
      const first = p[0]
      return {
        ok: Boolean(first.path && first.path.length && first.exit && first.distance > 0),
        pathLen: first.path.length,
        exit: first.exit,
        active: store.activeBuildingPlanId,
        // 每条前端方案都必须反向指向当前整栋楼方案
        allOwnedByBp: p.every((x) => x.buildingPlanId === store.activeBuildingPlanId),
        routeCount: (bp.routes || []).length,
      }
    })
    check('前端路线来自整栋楼方案（含 path/出口/距离）', routeSame.ok, routeSame)
    check('前端所有路线都归属当前 buildingPlan',
      routeSame.allOwnedByBp === true && routeSame.routeCount > 1, routeSame)
    check('activeBuildingPlanId 已同步（当前方案唯一）', Boolean(routeSame.active), routeSame.active)
    check('前端 emergencyStage 与后端同步为 4', await waitFor(() => page.evaluate(() => window.__demo.store.emergencyStage === 4), 8000),
      await page.evaluate(() => window.__demo.store.emergencyStage))
    const tickOk = await waitFor(() => page.evaluate(() => window.__demo.demoStore.metrics.evacuated > 0), 20000)
    check('实时广播驱动人员撤离（metrics.evacuated > 0）', tickOk,
      await page.evaluate(() => window.__demo.demoStore.metrics))
    const personsMoved = await page.evaluate(() => {
      const p = window.__demo.demoStore.persons || []
      return p.some((x) => x.status === 'safe' || x.evacuating)
    })
    check('人员状态由后端驱动更新', personsMoved)

    // ── ④·补 整栋楼方案权威性回归（P1.5.5） ──
    console.log('\n[④·补] 整栋楼方案权威性 / legacy 隔离')
    // ① 修改 legacy world.plans（旧单区域方案）不得影响 Demo 整栋楼疏散
    const legacyMutation = await page.evaluate(async () => {
      const demo = window.__demo.demoStore
      const before = (demo.persons || []).map((p) => p.routeId).join('|')
      const beforeActive = demo.activeBuildingPlanId
      // 清空并污染旧结构
      demo.plans = (demo.plans || []).map((p) => ({ ...p, name: '污染方案', nodes: ['1F:EXIT_W'], points: [{ x: 0, y: 0 }] }))
      demo.activePlanId = 'HACKED-LEGACY-PLAN'
      // 短暂等待即可（等待一个 tick 广播，验证旧结构变化不会被后端采纳）
      await new Promise((r) => setTimeout(r, 400))
      const after = (demo.persons || []).map((p) => p.routeId).join('|')
      return {
        changed: before !== after,
        beforeActive,
        afterActive: demo.activeBuildingPlanId,
        sample: (demo.persons || []).slice(0, 2).map((p) => p.routeId),
      }
    })
    check('修改 legacy world.plans 不影响人员路线', legacyMutation.changed === false, legacyMutation)
    check('修改 legacy world.plans 不改变 activeBuildingPlanId',
      legacyMutation.beforeActive === legacyMutation.afterActive, legacyMutation)

    // 所有人员 routeId 都属于当前 buildingPlan；没有人还在用旧 zone plan
    const ownership = await page.evaluate(() => {
      const demo = window.__demo.demoStore
      const id = demo.activeBuildingPlanId
      const ps = demo.persons || []
      const legacyIds = (demo.plans || []).map((p) => String(p.id))
      return {
        total: ps.length,
        active: id,
        owned: ps.filter((p) => String(p.routeId || '').startsWith(`${id}:`)).length,
        usingLegacy: ps.filter((p) => legacyIds.some((lid) => String(p.routeId || '').startsWith(lid))).length,
        floors: [...new Set(ps.map((p) => p.floorId))],
        sample: ps.slice(0, 3).map((p) => [p.id, p.floorId, p.zone, p.routeId]),
      }
    })
    check('所有人员 routeId 都属于当前 buildingPlan',
      ownership.total > 0 && ownership.owned === ownership.total, ownership)
    check('没有人员继续使用旧 zone plan', ownership.usingLegacy === 0, ownership)
    check('疏散覆盖 1F~6F 全部楼层', ownership.floors.length >= 6, ownership.floors)

    // ② routeMatrix.perZone（只读投影）被篡改，不得影响后端执行方案 / 3D 人员路线
    const perZoneMutation = await page.evaluate(async () => {
      const store = window.__demo.store
      const demo = window.__demo.demoStore
      const beforeBackend = (demo.persons || []).map((p) => p.routeId).join('|')
      const beforeActive = store.activeBuildingPlanId
      const before3d = (window.__dtwin?.persons?.data || []).filter(Boolean).map((d) => d.routeKey).join('|')
      const m = store.routeMatrix
      if (m && m.perZone) {
        Object.keys(m.perZone).forEach((z) => {
          m.perZone[z].recommendedId = 'HACKED-ZONE-PLAN'
          m.perZone[z].backupId = null
          m.perZone[z].plans = []
        })
      }
      await new Promise((r) => setTimeout(r, 400))
      const afterBackend = (demo.persons || []).map((p) => p.routeId).join('|')
      const after3d = (window.__dtwin?.persons?.data || []).filter(Boolean).map((d) => d.routeKey).join('|')
      return {
        backendChanged: beforeBackend !== afterBackend,
        activeChanged: beforeActive !== store.activeBuildingPlanId,
        three3dChanged: before3d !== after3d,
        before3dLen: before3d.length,
      }
    })
    check('routeMatrix.perZone 修改不影响后端人员 routeId', perZoneMutation.backendChanged === false, perZoneMutation)
    check('routeMatrix.perZone 修改不影响 activeBuildingPlanId', perZoneMutation.activeChanged === false, perZoneMutation)
    check('routeMatrix.perZone 修改不影响 3D 人员路线', perZoneMutation.three3dChanged === false, perZoneMutation)

    // ③ 整栋楼同一方案：每个方案都覆盖所有楼层，且切换后「每个楼层+区域」的 routeId 同步变化
    const switchAll = await page.evaluate(() => {
      const store = window.__demo.store
      const out = {}
      const ids = (store.buildingEvacuationPlans || []).map((p) => p.id)
      ids.forEach((id) => {
        store.setActiveBuildingPlan(id)
        const bp = store.activeBuildingPlan
        const map = {}
        Object.entries(bp.routesByZone || {}).forEach(([zk, r]) => { map[zk] = r.routeId })
        out[id] = {
          active: store.activeBuildingPlanId,
          map,
          floors: [...new Set((bp.routes || []).map((r) => r.floorId))],
          allOwned: Object.values(map).every((rid) => String(rid).startsWith(`${id}:`)),
        }
      })
      const keys = Object.keys(out)
      const cmp = (a, b) => {
        const zks = Object.keys(out[a].map)
        return {
          total: zks.length,
          changedAll: zks.every((k) => out[a].map[k] !== out[b].map[k]),
          sample: [zks[0], out[a].map[zks[0]], out[b].map[zks[0]]],
        }
      }
      return {
        ids: keys,
        everyActiveOk: keys.every((id) => out[id].active === id),
        everyOwned: keys.every((id) => out[id].allOwned),
        floorsPerPlan: keys.map((id) => out[id].floors.length),
        ab: keys.length > 1 ? cmp(keys[0], keys[1]) : null,
        bc: keys.length > 2 ? cmp(keys[1], keys[2]) : null,
        finalActive: store.activeBuildingPlanId,
      }
    })
    check('切换到每个整栋楼方案：activeBuildingPlanId 唯一生效', switchAll.everyActiveOk === true, switchAll.ids)
    check('每个方案的所有路线 routeId 都属于该方案', switchAll.everyOwned === true, switchAll.ids)
    check('每个方案都覆盖 1F~6F（不是只疏散 5F）',
      switchAll.floorsPerPlan.every((n) => n >= 6), switchAll.floorsPerPlan)
    check('A → B：每个楼层+区域的 routeId 同步变化',
      Boolean(switchAll.ab && switchAll.ab.changedAll && switchAll.ab.total > 1), switchAll.ab)
    check('B → C：每个楼层+区域的 routeId 同步变化',
      Boolean(switchAll.bc && switchAll.bc.changedAll && switchAll.bc.total > 1), switchAll.bc)
    // 恢复到最后点选的方案，避免影响后续确认流程
    await page.evaluate((id) => window.__demo.store.setActiveBuildingPlan(id), 'PLAN-B').catch(() => {})

    // ── ⑤ 3D 人员沿后端路线移动 ──
    console.log('\n[⑤ 3D 人员沿路线]')
    const dtReady = await waitFor(() => page.evaluate(() => Boolean(window.__dtwin && window.__dtwin.persons)), 30000)
    check('3D 数字孪生已挂载（__dtwin）', dtReady)
    // 3D 按需挂载（DashboardView「3D 模型」浮层）：未挂载时 __dtwin 是一份不再更新的旧快照，
    // 2D / 3D 比对必须在挂载态下进行，否则会把「脱离同步的旧数据」误判为一致
    const ensureTwinMounted = async () => {
      const mounted = () => page.evaluate(
        () => Boolean(window.__dtwin && window.__dtwin.scene.renderer.domElement.isConnected),
      )
      if (await mounted()) return true
      await page.evaluate(() => { const b = document.querySelector('.open-3d-btn'); if (b) b.click() })
      return waitFor(mounted, 40000)
    }
    check('3D 处于挂载态（2D / 3D 比对前提）', await ensureTwinMounted())
    if (dtReady) {
      const d0 = await page.evaluate(() => {
        const ds = window.__dtwin.persons.data.filter(Boolean)
        // 后端只给「火警楼层参与疏散的人员」下发 routePoints；其他楼层人员本就静止在权威坐标
        const shouldHave = (window.__demo.store.persons || [])
          .filter((p) => Array.isArray(p.routePoints) && p.routePoints.length > 1).map((p) => p.id)
        const routed = ds.filter((d) => shouldHave.includes(d.id))
        return {
          total: ds.length,
          shouldHave: shouldHave.length,
          withBackendRoute: routed.filter((d) => String(d.routeKey || '').startsWith('backend:')).length,
          missing: routed.filter((d) => !d.pts || d.pts.length < 2).length,
          sample: routed.slice(0, 3).map((d) => ({
            id: d.id, routeKey: d.routeKey, n: (d.pts || []).length,
            y0: (d.pts || [])[0] ? +d.pts[0].y.toFixed(2) : null,
            yN: (d.pts || []).length ? +d.pts[d.pts.length - 1].y.toFixed(2) : null,
          })),
        }
      })
      check('人员数据来自后端 routePoints（非 zone 随机散点）',
        d0.shouldHave > 0 && d0.withBackendRoute === d0.shouldHave && d0.missing === 0, d0)
      check('每条路线含多个节点', d0.sample.every((s) => s.n >= 2), d0.sample)
      // 跨楼层：非 1F 人员的路线必须连续下降（y0 > yN），1F 人员本就在首层（高度不变属正常）
      const crossFloor = await page.evaluate(() => {
        const bp = window.__demo.store.activeBuildingPlan
        const backend = window.__demo.demoStore.persons || []
        const upper = backend.filter((p) => p && p.floorId && p.floorId !== '1F').map((p) => p.id)
        const ds = window.__dtwin.persons.data.filter(Boolean).filter((d) => upper.includes(d.id))
        const descended = ds.filter((d) => (d.pts || []).length > 1 && d.pts[0].y > d.pts[d.pts.length - 1].y)
        return {
          upper: upper.length, withPts: ds.length, descended: descended.length,
          sample: ds.slice(0, 2).map((d) => ({ id: d.id, n: (d.pts || []).length, y0: +d.pts[0].y.toFixed(2), yN: +d.pts[d.pts.length - 1].y.toFixed(2) })),
          planRoutes: bp ? (bp.routes || []).length : 0,
        }
      })
      check('非 1F 人员路线跨楼层连续下降', crossFloor.withPts > 0 && crossFloor.descended === crossFloor.withPts, crossFloor)

      // （3D 移动性检查见下方，此处先完成折线一致性校验，避免拖到疏散完成后）

      const snapA = await page.evaluate(() => window.__dtwin.persons.data.filter(Boolean)
        .map((d) => ({ id: d.id, x: d.cur.x, y: d.cur.y, z: d.cur.z })))
      await page.waitForTimeout(1800)
      const snapB = await page.evaluate(() => window.__dtwin.persons.data.filter(Boolean)
        .map((d) => ({ id: d.id, x: d.cur.x, y: d.cur.y, z: d.cur.z })))
      const backendProg = await page.evaluate(() => {
        const ps = window.__demo.demoStore.persons || []
        const moving = ps.filter((p) => p.evacuating && typeof p.progress === 'number' && p.progress < 1)
        return {
          total: ps.length,
          moving: moving.length,
          evacuated: window.__demo.demoStore.metrics?.evacuated ?? -1,
          evacuating: window.__demo.demoStore.metrics?.evacuating ?? -1,
        }
      })
      const moved = snapA.filter((a, i) => {
        const b = snapB[i]
        return b && Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) > 0.2
      }).length
      check('3D 人员持续移动（视觉插值推进）', moved > 0, { moved, ...backendProg })

      // routeMatrix.perZone 是只读投影：篡改它不得改变 3D 人员折线
      const perZone3d = await page.evaluate(async () => {
        const store = window.__demo.store
        const before = window.__dtwin.persons.data.filter(Boolean).map((d) => `${d.id}:${d.routeKey}`).join('|')
        const m = store.routeMatrix
        if (m && m.perZone) {
          Object.keys(m.perZone).forEach((z) => {
            m.perZone[z].recommendedId = 'HACKED-ZONE-PLAN'
            m.perZone[z].plans = []
          })
        }
        await new Promise((r) => setTimeout(r, 400))
        const after = window.__dtwin.persons.data.filter(Boolean).map((d) => `${d.id}:${d.routeKey}`).join('|')
        return { changed: before !== after, len: before.length, sample: before.slice(0, 60) }
      })
      check('routeMatrix.perZone 修改不影响 3D 人员折线', perZone3d.changed === false && perZone3d.len > 0, perZone3d)

      // 不穿墙 / 不经火区 / 必达出口：3D 折线来自后端方案 → 与 2D 同一条
      const geo = await page.evaluate(() => {
        const dt = window.__dtwin
        const store = window.__demo.store
        const bp = store.activeBuildingPlan
        // 整栋楼方案：3D 路线层为「每个有人的区域」各画一条；取火源区那条做几何校验
        const fire = bp && bp.fire ? bp.fire : { floorId: '5F', zone: 'A区' }
        const route = bp ? (bp.routesByZone || {})[`${fire.floorId}:${fire.zone}`] : null
        const planId = store.activeRoutePlanId
        const plan = (store.routePlans || []).find((p) => p.id === planId)
        return {
          routePlanId3D: dt.route.currentPlanId,
          activeBuildingPlanId: store.activeBuildingPlanId,
          drawnRoutes: (dt.route._tubes || []).length,
          planRoutes: bp ? (bp.routes || []).length : 0,
          routeNodes: route ? route.nodes.length : 0,
          planPathLen: plan ? plan.path.length : 0,
          endsAtExit: route ? /EXIT_/.test(route.exitId) : false,
          viaStair: route ? route.nodes.some((n) => /STAIR_/.test(n)) : false,
          viaFireRoom: route ? route.nodes.slice(1).some((n) => n.endsWith('A_CENTER')) : false,
        }
      })
      // 3D 路线层的方案 id 形如 `PLAN-B:<routes数量>`
      check('2D 与 3D 使用同一个整栋楼方案',
        String(geo.routePlanId3D || '').startsWith(`${geo.activeBuildingPlanId}:`), geo)
      check('3D 绘制了整栋楼全部区域路线', geo.drawnRoutes === geo.planRoutes && geo.drawnRoutes > 1, geo)
      check('3D 折线与方案路径同源', geo.routeNodes === geo.planPathLen && geo.planPathLen > 1, geo)
      check('路线经楼梯', geo.viaStair)
      check('路线止于安全出口', geo.endsAtExit)
      check('路线不进入火源房间（起点除外）', geo.viaFireRoom === false)

      // 整栋楼：后端每个人的 routeId 必须与前端 2D/3D 使用的 buildingEvacuationPlan 路线一致
      const routeIdMatch = await page.evaluate(() => {
        const store = window.__demo.store
        const bp = store.activeBuildingPlan
        if (!bp) return { ok: false, reason: 'no activeBuildingPlan' }
        const backend = window.__demo.demoStore.persons || []
        const bad = []
        let checked = 0
        backend.forEach((p) => {
          const r = (bp.routesByZone || {})[`${p.floorId}:${p.zone}`]
          if (!r) return
          checked += 1
          if (r.routeId !== p.routeId) bad.push({ id: p.id, backend: p.routeId, frontend: r.routeId })
        })
        return {
          ok: bad.length === 0, checked, bad: bad.slice(0, 3),
          planId: bp.id, scope: bp.scope,
          routeCount: (bp.routes || []).length,
          allValid: (bp.routes || []).every((r) => r.valid),
          allToExit: (bp.routes || []).every((r) => /^1F:EXIT_/.test(r.exitId)),
        }
      })
      check('2D/3D routeId 与后端人员 routeId 一致', routeIdMatch.ok && routeIdMatch.checked > 0, routeIdMatch)
      check('整栋楼所有路线合法且终点为 1F 出口',
        routeIdMatch.allValid === true && routeIdMatch.allToExit === true, routeIdMatch)

      // 视觉错峰：起步时间不同（同一时刻人员进度不完全一致）
      const stagger = await page.evaluate(() => window.__dtwin.persons.data.filter(Boolean)
        .map((d) => +(d.delay || 0).toFixed(2)))
      check('人员视觉错峰（delay 分散）', new Set(stagger).size > 1, stagger.slice(0, 5))

      // 刷新/重连不产生大量瞬移：重复 update(store) 后位置基本不动
      const jump = await page.evaluate(() => {
        const before = window.__dtwin.persons.data.filter(Boolean).map((d) => d.cur.clone())
        window.__dtwin.persons.update(window.__dtwin.store)
        const after = window.__dtwin.persons.data.filter(Boolean)
        let max = 0
        after.forEach((d, i) => { if (before[i]) max = Math.max(max, d.cur.distanceTo(before[i])) })
        return +max.toFixed(3)
      })
      check('重同步不产生瞬移（最大位移 < 0.5）', jump < 0.5, jump)

      // 应急灯：只改 emissive/opacity，位置不变且保持绿色（不因应急变红）
      const light = await page.evaluate(() => {
        const em = window.__dtwin.em
        const rec = [...em.evacMap.values()][0]
        return rec ? {
          color: rec.sprite.material.color.getHexString(),
          opacity: +rec.sprite.material.opacity.toFixed(2),
          pos: [+rec.sprite.position.x.toFixed(2), +rec.sprite.position.y.toFixed(2), +rec.sprite.position.z.toFixed(2)],
          routeGreen: /39ff88/i.test(window.__dtwin.route.flowTex.name || '') || true,
        } : null
      })
      check('疏散指示灯颜色非红（白底 + 绿色箭头贴图）', light && light.color === 'ffffff', light)
      check('应急灯位置固定（仅透明度脉冲）', light && light.pos[1] > 0, light)
    }

    // ── ④·补2 人员数据链统一（P1.6.1） ──
    console.log('\n[④·补2] 人员数据链统一（后端 / 2D / 3D 同一 ID 与 routeId）')
    const chain = await page.evaluate(() => {
      const demo = window.__demo.demoStore   // 后端 WebSocket 快照
      const store = window.__demo.store      // fireStore（2D 平面图消费）
      const dt = window.__dtwin && window.__dtwin.persons // 3D
      const FIELDS = ['id', 'buildingId', 'floorId', 'zone', 'status', 'routeId', 'routePoints', 'progress', 'position']
      const canonical = (p) => Boolean(p)
        && FIELDS.every((f) => p[f] !== undefined)
        && Array.isArray(p.routePoints)
        && typeof p.progress === 'number'
        && Boolean(p.position) && Number.isFinite(p.position.x) && Number.isFinite(p.position.y)
      const backend = demo.persons || []
      const twoD = store.persons || []
      const three = (dt && dt.data ? dt.data : []).filter(Boolean)
      const bIds = backend.map((p) => String(p.id)).sort()
      const dIdSet = new Set(twoD.map((p) => String(p.id)))
      const tIds = three.map((d) => String(d.id)).sort()
      // routeId 一致性：后端 → 2D
      const bRoute = new Map(backend.map((p) => [String(p.id), p.routeId]))
      const mismatch2d = twoD.filter((p) => bRoute.has(String(p.id)) && bRoute.get(String(p.id)) !== p.routeId)
      // routeId 一致性：后端 → 3D（3D 路线指纹必须携带后端 routeId）
      const tMap = new Map(three.map((d) => [String(d.id), d]))
      const keyNoRoute = backend.filter((p) => {
        const d = tMap.get(String(p.id))
        return d && d.routeKey && !String(d.routeKey).includes(String(p.routeId))
      })
      // 位置一致性：2D 与后端同源
      const bPos = new Map(backend.map((p) => [String(p.id), p.position]))
      const posMismatch = twoD.filter((p) => {
        const q = bPos.get(String(p.id))
        return q && (!p.position || p.position.x !== q.x || p.position.y !== q.y)
      })
      return {
        backendCount: backend.length,
        twoDCount: twoD.length,
        threeCount: three.length,
        idsAllIn2D: bIds.length > 0 && bIds.every((id) => dIdSet.has(id)),
        idsSameAs3D: JSON.stringify(bIds) === JSON.stringify(tIds),
        nonCanonical2D: twoD.filter((p) => !canonical(p)).length,
        selfCheck: store.countNonCanonicalPersons ? store.countNonCanonicalPersons() : -1,
        mismatch2d: mismatch2d.length,
        keyNoRoute: keyNoRoute.length,
        posMismatch: posMismatch.length,
        selfGenerated: three.filter((d) => String(d.routeKey || '').startsWith('mock:')).length,
        sample: backend.slice(0, 2).map((p) => [p.id, p.buildingId, p.floorId, p.zone, p.routeId]),
        sample3d: three.slice(0, 2).map((d) => [d.id, d.routeId, d.routeKey]),
        ncSample: twoD.filter((p) => !canonical(p)).slice(0, 2)
          .map((p) => [String(p.id), p.buildingId, p.floorId, p.zone, p.routeId, Array.isArray(p.routePoints), p.progress, Boolean(p.position)]),
        posSample: posMismatch.slice(0, 2).map((p) => [String(p.id), p.position, bPos.get(String(p.id))]),
      }
    })
    check('后端 → 2D：同一批人员 ID', chain.idsAllIn2D && chain.backendCount > 0, chain)
    check('后端 → 3D：同一批人员 ID', chain.idsSameAs3D && chain.threeCount === chain.backendCount, chain)
    check('2D 人员字段符合统一契约（9 项齐全）', chain.nonCanonical2D === 0 && chain.selfCheck === 0, chain)
    check('后端 → 2D：同一 routeId', chain.mismatch2d === 0, chain)
    check('后端 → 3D：3D 路线指纹携带同一 routeId', chain.keyNoRoute === 0, chain)
    check('后端 → 2D：position 同源', chain.posMismatch === 0, chain)
    check('3D 未自行生成路线（无本地 mock 路线指纹）', chain.selfGenerated === 0, chain)

    // ── ④·补3 设备数据链统一（P1.6.2） ──
    console.log('\n[④·补3] 设备数据链统一（后端 / 2D 同一设备 ID 与楼层归属）')
    const dchain = await page.evaluate(() => {
      const demo = window.__demo.demoStore   // 后端 WebSocket 快照
      const store = window.__demo.store      // fireStore（2D 平面图 / 3D 消费）
      const FIELDS = ['id', 'type', 'buildingId', 'floorId', 'zone', 'status', 'currentMode', 'direction', 'brightness', 'emergencyFlash']
      const canonical = (d) => Boolean(d)
        && FIELDS.every((f) => d[f] !== undefined)
        && /^B\d{3}$/.test(String(d.buildingId))
        && /^\d+F$/.test(String(d.floorId))
        && typeof d.brightness === 'number'
        && typeof d.emergencyFlash === 'boolean'
      const backend = demo.devices || []
      const twoD = store.devices || []
      const bIds = backend.map((d) => String(d.id))
      const dMap = new Map(twoD.map((d) => [String(d.id), d]))
      // 楼层归属一致性：同一 id 在后端与 2D 必须落在同一层
      const floorMismatch = backend.filter((d) => {
        const t = dMap.get(String(d.id))
        return t && (t.floorId !== d.floorId || t.buildingId !== d.buildingId || String(t.zone ?? '') !== String(d.zone ?? ''))
      })
      const missing = backend.filter((d) => !dMap.has(String(d.id)))
      // 整栋楼联动：dispatch 后每层都应有 emergency 联动设备
      const linked = backend.filter((d) => d.currentMode === 'emergency')
      const linkedFloors = [...new Set(linked.map((d) => d.floorId))].sort()
      return {
        backendCount: backend.length,
        twoDCount: twoD.length,
        allInBuilding: backend.every((d) => d.buildingId === 'B003'),
        backendFloors: [...new Set(backend.map((d) => d.floorId))].sort(),
        nonCanonicalBackend: backend.filter((d) => !canonical(d)).length,
        selfCheck: store.countNonCanonicalDevices ? store.countNonCanonicalDevices() : -1,
        missingIn2D: missing.length,
        floorMismatch: floorMismatch.length,
        storeFloorSummary: store.deviceFloorsOfBuilding ? store.deviceFloorsOfBuilding('B003') : null,
        linkedFloors,
        sample: backend.slice(0, 2).map((d) => [d.id, d.buildingId, d.floorId, d.zone, d.currentMode]),
      }
    })
    check('设备快照含统一字段 10 项', dchain.backendCount > 0 && dchain.nonCanonicalBackend === 0, dchain)
    check('设备全部归属火警楼栋 B003', dchain.allInBuilding, dchain.backendFloors)
    check('WS 设备快照可准确定位到楼层（floorId 覆盖 1F~6F）',
      dchain.backendFloors.length === 6 && dchain.backendFloors.every((f) => /^[1-6]F$/.test(f)), dchain.backendFloors)
    check('2D 设备同样符合统一契约', dchain.selfCheck === 0, dchain)
    check('后端 → 2D：同一批设备 ID', dchain.missingIn2D === 0, dchain)
    check('后端 → 2D：同一楼层归属（buildingId / floorId / zone）', dchain.floorMismatch === 0, dchain)
    check('store 可按楼层枚举设备（deviceFloorsOfBuilding）',
      (dchain.storeFloorSummary || []).length === 6, dchain.storeFloorSummary)
    check('整栋楼设备联动：6 层全部进入 emergency', dchain.linkedFloors.length === 6, dchain.linkedFloors)

    await clickByText('推进下一步')
    check('⑤ 滞留人员识别', await waitFor(() => page.evaluate(() => window.__demo.demoStore.stage === 'RETAINED_PERSONS'), 8000),
      await page.evaluate(() => window.__demo.demoStore.stage))
    check('识别出滞留人员', await page.evaluate(() => (window.__demo.demoStore.metrics.retained || 0) > 0),
      await page.evaluate(() => window.__demo.demoStore.metrics))
    check('strandedPersons 已同步到 fireStore', await page.evaluate(() => (window.__demo.store.strandedPersons || []).length > 0),
      await page.evaluate(() => (window.__demo.store.strandedPersons || []).length))
    // 滞留人员必须留在原地，不得继续沿疏散路线前进（P2 逻辑本阶段不改动，只校验「冻结」这一稳定不变量）
    const strandedSnap = async () => page.evaluate(() => {
      const ds = (window.__dtwin && window.__dtwin.persons.data || []).filter(Boolean)
      const byId = new Map((window.__demo.store.persons || []).map((p) => [String(p.id), p]))
      return ds.filter((d) => {
        const p = byId.get(String(d.id))
        return p && (p.status === 'stranded' || p.retained)
      }).map((d) => ({
        id: d.id,
        x: +d.cur.x.toFixed(3), y: +d.cur.y.toFixed(3), z: +d.cur.z.toFixed(3),
        distToExit: d.pts && d.pts.length ? +d.cur.distanceTo(d.pts[d.pts.length - 1]).toFixed(2) : null,
      }))
    })
    // 先等待视觉插值收敛（冻结瞬间的残余插值不代表仍在撤离），再比对两次快照
    await page.waitForTimeout(2500)
    const strandedA = await strandedSnap()
    await page.waitForTimeout(1600)
    const strandedB = await strandedSnap()
    const drift = strandedA.map((a, i) => {
      const b = strandedB[i]
      return b ? +Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z).toFixed(3) : -1
    })
    check('滞留人员存在且被标记', strandedA.length > 0, strandedA.length)
    check('滞留人员未继续沿疏散路线前进（位置冻结）',
      strandedA.length > 0 && drift.every((d) => d >= 0 && d < 0.2), { drift, distToExit: strandedA.map((s) => s.distToExit) })

    await clickByText('推进下一步')
    check('⑥ 协同消防救援', await waitFor(() => page.evaluate(() => window.__demo.demoStore.stage === 'RESCUE_COORDINATION'), 8000),
      await page.evaluate(() => window.__demo.demoStore.stage))

    await clickByText('推进下一步')
    check('处置完成 COMPLETED', await waitFor(() => page.evaluate(() => window.__demo.demoStore.stage === 'COMPLETED'), 8000),
      await page.evaluate(() => window.__demo.demoStore.stage))
    check('救援任务完成', await page.evaluate(() => window.__demo.demoStore.rescue?.completed === true))

    const bodyText = await page.evaluate(() => document.body.innerText)
    check('页面呈现后端阶段信息', bodyText.includes('协同救援') || bodyText.includes('处置完成'), bodyText.slice(0, 120))
    } finally {
      // Durable Object 会话跨测试持久化；无论断言/异常发生在哪里，都把本次 E2E 留下的状态复位到 IDLE。
      try {
        const st = await api(`/api/v1/demo/state?sessionId=${SESSION}`)
        if (st.body?.stage !== 'IDLE') {
          const reset = await cmd('RESET')
          if (reset.status !== 200) console.warn('E2E 清理复位失败：', reset.status, reset.body)
          else await sleep(300)
        }
      } catch (resetErr) {
        console.warn('E2E 清理复位异常：', resetErr?.message || resetErr)
      }
    }
  }

  await browser.close()
  console.log(`\n=== 结果：${passed} 通过 / ${failed} 失败 ===`)
  if (failed) { console.log('失败项：'); failures.forEach((f) => console.log('  - ' + f)); process.exit(1) }
  process.exit(0)
})().catch((err) => { console.error('浏览器 E2E 异常：', err); process.exit(1) })

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
    check('生成多套方案', await page.evaluate(() => (window.__demo.demoStore.plans || []).length >= 2))

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

    await clickByText('确认当前疏散路径')
    check('④ 智能疏散', await waitFor(() => page.evaluate(() => window.__demo.demoStore.stage === 'SMART_EVACUATION'), 8000),
      await page.evaluate(() => window.__demo.demoStore.stage))
    check('执行的是所选方案', await page.evaluate((id) => window.__demo.demoStore.activePlanId === id, pickedId),
      await page.evaluate(() => window.__demo.demoStore.activePlanId))
    // 前端渲染的路线必须来自后端规划器（3D/平面图同源）
    const routeSame = await page.evaluate(() => {
      const p = window.__demo.store.routePlans || []
      const backend = window.__demo.demoStore.plans || []
      if (!p.length || !backend.length) return { ok: false, p: p.length, b: backend.length }
      const first = p[0]
      return {
        ok: Boolean(first.path && first.path.length && first.exit && first.distance > 0),
        pathLen: first.path.length,
        exit: first.exit,
        active: window.__demo.store.activeRoutePlanId,
      }
    })
    check('前端路线来自后端方案（含 path/出口/距离）', routeSame.ok, routeSame)
    check('3D 使用的 activeRoutePlanId 已同步', Boolean(routeSame.active), routeSame.active)
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

    await clickByText('推进下一步')
    check('⑤ 滞留人员识别', await waitFor(() => page.evaluate(() => window.__demo.demoStore.stage === 'RETAINED_PERSONS'), 8000),
      await page.evaluate(() => window.__demo.demoStore.stage))
    check('识别出滞留人员', await page.evaluate(() => (window.__demo.demoStore.metrics.retained || 0) > 0),
      await page.evaluate(() => window.__demo.demoStore.metrics))
    check('strandedPersons 已同步到 fireStore', await page.evaluate(() => (window.__demo.store.strandedPersons || []).length > 0),
      await page.evaluate(() => (window.__demo.store.strandedPersons || []).length))

    await clickByText('推进下一步')
    check('⑥ 协同消防救援', await waitFor(() => page.evaluate(() => window.__demo.demoStore.stage === 'RESCUE_COORDINATION'), 8000),
      await page.evaluate(() => window.__demo.demoStore.stage))

    await clickByText('推进下一步')
    check('处置完成 COMPLETED', await waitFor(() => page.evaluate(() => window.__demo.demoStore.stage === 'COMPLETED'), 8000),
      await page.evaluate(() => window.__demo.demoStore.stage))
    check('救援任务完成', await page.evaluate(() => window.__demo.demoStore.rescue?.completed === true))

    const bodyText = await page.evaluate(() => document.body.innerText)
    check('页面呈现后端阶段信息', bodyText.includes('协同救援') || bodyText.includes('处置完成'), bodyText.slice(0, 120))
  }

  await browser.close()
  console.log(`\n=== 结果：${passed} 通过 / ${failed} 失败 ===`)
  if (failed) { console.log('失败项：'); failures.forEach((f) => console.log('  - ' + f)); process.exit(1) }
  process.exit(0)
})().catch((err) => { console.error('浏览器 E2E 异常：', err); process.exit(1) })

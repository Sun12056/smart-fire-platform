// 临时演练脚本：完整 Demo（火灾 → 生成整栋楼方案 → 选 B → 确认 → 观察 1F~6F 移动 → 校验 2D/3D 同源）
const { chromium } = require('playwright-core')

const PAGE_URL = process.env.PAGE_URL || 'http://localhost:5199/'
const line = (t) => console.log('\n── ' + t)

async function clickText(page, text) {
  // 直接派发 DOM click（页面可能存在弹窗遮罩，避免 actionability 拦截）
  const ok = await page.evaluate((t) => {
    const el = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').includes(t))
    if (!el) return false
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    return true
  }, text)
  if (!ok) throw new Error(`未找到按钮：${text}`)
}
const waitStage = (page, stage, ms = 12000) =>
  page.waitForFunction((s) => window.__demo?.demoStore?.stage === s, stage, { timeout: ms })

;(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true })
  const page = await browser.newPage()
  const errors = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.goto(PAGE_URL, { waitUntil: 'load' })
  await page.waitForFunction(() => window.__demo && window.__demo.demoStore && window.__demo.store, null, { timeout: 30000 })
  await new Promise((r) => setTimeout(r, 1200))

  // 先确保后端状态机回到 IDLE，再打开演示控制台
  await fetch('http://127.0.0.1:8787/api/v1/demo/reset?sessionId=default', { method: 'POST' }).catch(() => {})
  await new Promise((r) => setTimeout(r, 600))
  await page.evaluate(() => { if (!window.__demo.store.demoMode) window.__demo.store.toggleDemoMode() })
  await page.waitForSelector('.demo-panel', { timeout: 15000 })
  // ① 模拟火灾 / 发现火灾
  await clickText(page, '启动演示流程')
  await waitStage(page, 'FIRE_DETECTED')
  const fire = await page.evaluate(() => {
    const f = window.__demo.store.fireEvent
    return { building: f?.building, floor: f?.floor, area: f?.area, scope: window.__demo.store.evacuationScope }
  })
  line('① 发现火灾'); console.log('   火情位置：', JSON.stringify(fire), '→ 疏散范围 evacuationScope =', fire.scope)

  // ② 查看火情 + 启动应急预案
  await clickText(page, '推进下一步')
  await waitStage(page, 'EMERGENCY_RESPONSE')
  const devices = await page.evaluate(() => {
    const ds = window.__demo.demoStore.devices || []
    return {
      world设备数: ds.length,
      进入emergency: ds.filter((d) => d.currentMode === 'emergency').length,
      强闪: ds.filter((d) => d.emergencyFlash).length,
    }
  })
  const b003Devices = await fetch('http://127.0.0.1:8787/api/v1/devices?buildingId=B003&limit=500')
    .then((r) => r.json()).then((j) => {
      const list = j.items || j.devices || j
      const byFloor = {}
      ;(Array.isArray(list) ? list : []).forEach((d) => { byFloor[d.floorId || d.floor] = (byFloor[d.floorId || d.floor] || 0) + 1 })
      return { count: (Array.isArray(list) ? list : []).length, byFloor }
    }).catch(() => null)
  line('② 启动应急预案（整栋楼设备联动）')
  console.log('   后端 Demo 世界设备：', JSON.stringify(devices))
  console.log('   B003 全楼设备（D1）：', JSON.stringify(b003Devices))
  console.log('   火灾标记（只描述位置，不是疏散范围）：', JSON.stringify(await page.evaluate(() => window.__demo.store.fireEvent)))

  // ③ 生成整栋楼 A/B/C 方案
  await clickText(page, '推进下一步')
  await waitStage(page, 'ROUTE_PLANNING')
  const plans = await page.evaluate(() => (window.__demo.store.buildingEvacuationPlans || []).map((p) => ({
    id: p.id, name: p.name, strategy: p.strategy, scope: p.scope,
    楼层: p.summary.floors.length, 区域: p.summary.zoneCount, 人数: p.summary.personCount,
    路线数: p.summary.routeCount, 出口: p.summary.exitLabels, 最慢耗时: p.summary.maxEstimatedTime, 风险: p.summary.riskLevel,
  })))
  line('③ 生成整栋楼 A/B/C 三套方案')
  plans.forEach((p) => console.log('   ', JSON.stringify(p, null, 0)))

  // ④ 选择 B（快速疏散）
  await page.evaluate(() => {
    const chips = document.querySelectorAll('.plan-chip')
    if (chips[1]) chips[1].click()
  })
  const picked = await page.evaluate(() => ({
    selectedPlanId: window.__demo.demoStore.selectedPlanId,
    activeBuildingPlanId: window.__demo.store.activeBuildingPlanId,
  }))
  line('④ 选择 B 方案'); console.log('   ', JSON.stringify(picked))

  // ⑤ 确认当前整栋楼疏散路径
  await clickText(page, '确认当前疏散路径')
  await waitStage(page, 'SMART_EVACUATION')
  const confirm = await page.evaluate(() => {
    const d = window.__demo.demoStore
    const ps = d.persons || []
    const bp = (d.buildingPlans || []).find((p) => p.id === d.activeBuildingPlanId)
    return {
      stage: d.stage,
      activeBuildingPlanId: d.activeBuildingPlanId,
      scope: d.evacuationScope,
      人员总数: ps.length,
      有routePoints: ps.filter((p) => Array.isArray(p.routePoints) && p.routePoints.length > 1).length,
      routeId全属当前方案: ps.every((p) => String(p.routeId).startsWith(`${d.activeBuildingPlanId}:`)),
      楼层分布: [...new Set(ps.map((p) => p.floorId))].sort(),
      每楼层人数: ps.reduce((m, p) => { m[p.floorId] = (m[p.floorId] || 0) + 1; return m }, {}),
      方案valid: bp ? bp.valid : null,
    }
  })
  line('⑤ 确认整栋楼疏散路径 → 智能疏散'); console.log('   ', JSON.stringify(confirm))

  // ⑥ 观察 1F~6F 人员移动
  await page.waitForTimeout(3000)
  const snap1 = await page.evaluate(() => (window.__demo.demoStore.persons || []).map((p) => [p.id, p.progress]))
  await page.waitForTimeout(3000)
  const moving = await page.evaluate((prev) => {
    const ps = window.__demo.demoStore.persons || []
    const map = new Map(prev)
    const byFloor = {}
    ps.forEach((p) => {
      const before = map.get(p.id)
      const advanced = typeof before === 'number' && typeof p.progress === 'number' && p.progress > before
      byFloor[p.floorId] = byFloor[p.floorId] || { total: 0, advanced: 0 }
      byFloor[p.floorId].total++
      if (advanced || p.progress >= 1) byFloor[p.floorId].advanced++
    })
    return { byFloor, metrics: window.__demo.demoStore.metrics }
  }, snap1)
  line('⑥ 观察 1F~6F 人员移动')
  Object.entries(moving.byFloor).sort().forEach(([f, v]) => console.log(`    ${f}: ${v.advanced}/${v.total} 已推进`))
  console.log('    metrics:', JSON.stringify(moving.metrics))

  // ⑦ 2D / 3D 路线同源校验
  const geo = await page.evaluate(() => {
    const store = window.__demo.store
    const dt = window.__dtwin
    const bp = store.activeBuildingPlan
    const routes2d = store.getAllZoneRoutes().map((z) => ({ zone: z.zone, routeId: z.routeId, pts: (z.segment || []).length }))
    return {
      activeBuildingPlanId: store.activeBuildingPlanId,
      方案路线数: (bp.routes || []).length,
      '2D路线(当前楼层)': routes2d.length ? routes2d : '(当前视图非规划楼层)',
      '2D路线routeId前缀一致': routes2d.every((r) => String(r.routeId).startsWith(`${store.activeBuildingPlanId}:`)),
      '3D路线层': dt && dt.route ? { 方案: dt.route.currentPlanId, 折线数: (dt.route._tubes || []).length } : null,
      '3D人员路线来自后端': dt ? (dt.persons.data.filter(Boolean).filter((d) => String(d.routeKey || '').startsWith('backend:')).length) : 0,
    }
  })
  line('⑦ 2D / 3D 路线同源'); console.log('   ', JSON.stringify(geo, null, 0))

  // ⑧ 最终归属校验
  const final = await page.evaluate(() => {
    const d = window.__demo.demoStore
    const ps = d.persons || []
    const legacyIds = (d.plans || []).map((p) => String(p.id))
    return {
      当前方案: d.activeBuildingPlanId,
      人员数: ps.length,
      routeId属于当前方案: ps.filter((p) => String(p.routeId).startsWith(`${d.activeBuildingPlanId}:`)).length,
      使用旧zonePlan的人数: ps.filter((p) => legacyIds.some((id) => String(p.routeId).startsWith(id))).length,
      示例: ps.slice(0, 3).map((p) => `${p.id} ${p.floorId}-${p.zone} → ${p.routeId}`),
    }
  })
  line('⑧ routeId 归属'); console.log('   ', JSON.stringify(final, null, 0))
  line('⑨ 页面 JS 错误'); console.log('   ', errors.length ? errors.slice(0, 3) : '无')

  await browser.close()
})().catch((e) => { console.error('演练异常：', e); process.exit(1) })

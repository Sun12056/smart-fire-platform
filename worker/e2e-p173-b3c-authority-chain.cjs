/**
 * P1.7.3-B3c canonical 权威链回归（B3-03）
 *
 * 目标：证明 B3-03 之后「canonical 存在 → 只认 canonical；canonical 缺失 → 才允许 legacy fallback」：
 *   T1  冲突人员 canonical 胜出
 *   T2  冲突设备：DeviceView 筛选只认 canonical（buildingId / floorId）
 *   T3  冲突火灾：2D 火区 + 3D 火区高亮 + FireZone3D 只认 canonical
 *   T4  楼栋设备数 buildingDeviceCount 只按 canonical 入账
 *   T5  应急联动预览 emPreviewCount 只按 canonical 楼栋 / 楼层统计
 *   T6  新建人员必须自带完整 canonical 三元组
 *   T7  riskArea 必须自带 buildingId / floorId / zone
 *   T8  generateRoutePlans 只在同 canonical 楼栋时 replan（跨楼栋不串）
 *   T9  未知楼栋 B999 不得静默归入当前楼栋
 *   T10 Demo Golden Path 全程 canonical 三元组不漂移
 *   T11 PersonLayer3D legacy fallback 只影响是否渲染，写入的仍是 canonical
 *
 * 用法（需 demo 模式前端 + 后端已启动）：
 *   1) set VITE_DATA_SOURCE=demo && npx vite --port 5199
 *   2) npx wrangler dev（worker）
 *   3) node worker/e2e-p173-b3c-authority-chain.cjs
 *
 * 环境变量：PAGE_URL（默认 http://localhost:5199/）、API_BASE（默认 http://127.0.0.1:8787）
 */
const { chromium } = require('playwright-core')

const PAGE_URL = process.env.PAGE_URL || 'http://localhost:5199/'
const API_BASE = process.env.API_BASE || 'http://127.0.0.1:8787'
const SESSION = process.env.DEMO_SESSION || 'default'
const STAGE_TO_LEGACY = {
  IDLE: 0, FIRE_DETECTED: 1, EMERGENCY_RESPONSE: 2, ROUTE_PLANNING: 3,
  SMART_EVACUATION: 4, RETAINED_PERSONS: 5, RESCUE_COORDINATION: 6, COMPLETED: 7,
}

let passed = 0, failed = 0, skipped = 0
const failures = []
function check(name, cond, extra) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name); console.log(`  ✗ ${name}${extra !== undefined ? ' → ' + JSON.stringify(extra).slice(0, 400) : ''}`) }
}
function skip(name, why) { skipped++; console.log(`  ⃝ ${name}（跳过：${why}）`) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor(fn, timeout = 15000, interval = 250) {
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
const state = async () => (await api(`/api/v1/demo/state?sessionId=${SESSION}`)).body || {}

;(async () => {
  console.log(`\n=== P1.7.3-B3c canonical 权威链回归（${PAGE_URL} · ${API_BASE}）===\n`)
  const browser = await chromium.launch({ channel: 'msedge', headless: true })
  const page = await browser.newPage()
  await page.goto(PAGE_URL, { waitUntil: 'load', timeout: 45000 })
  await waitFor(() => page.evaluate(() => Boolean(window.__demo)), 20000)
  check('页面挂载并暴露开发钩子', await page.evaluate(() => Boolean(window.__demo)))
  check('运行模式为 demo', (await page.evaluate(() => window.__demo.dataSource.mode)) === 'demo')

  const st0 = await state()
  if (st0.stage && st0.stage !== 'IDLE') await cmd('RESET')
  await sleep(1200)

  // 清掉上一次运行残留的持久化视图状态，保证每次从「楼栋总览（3D 挂载）」起步
  await page.evaluate(() => {
    const s = window.__demo.store
    if (typeof s.saveDashboardViewState === 'function') {
      s.saveDashboardViewState({ viewMode: 'buildings', buildingId: 'B003', floorId: null, zone: null })
    }
  })
  await page.reload({ waitUntil: 'load' })
  await waitFor(() => page.evaluate(() => Boolean(window.__demo)), 20000)
  await waitFor(() => page.locator('.bo-card').count().then((c) => c > 0), 20000)

  const has3D = await waitFor(() => page.evaluate(() => Boolean(window.__dtwin && window.__dtwin.model && window.__dtwin.model.idx && window.__dtwin.model.idx.entries.length > 0)), 30000)
  if (!has3D) console.log('  ⚠ 3D 未就绪：WebGL / GLB 可能未加载完成')

  // 通用：设置当前查看楼栋（canonical）
  const setCurrentBuilding = (bid) => page.evaluate((b) => {
    const s = window.__demo.store
    if (s.dashboardView) s.dashboardView.selectedBuildingId = b
    return s.dashboardView ? s.dashboardView.selectedBuildingId : null
  }, bid)

  const readFireEvent = () => page.evaluate(() => {
    const fe = window.__demo.store.fireEvent
    return fe ? {
      buildingId: fe.buildingId, floorId: fe.floorId, zone: fe.zone,
      building: fe.building, floor: fe.floor, area: fe.area,
    } : null
  })

  await setCurrentBuilding('B003')

  // ── T1：冲突人员 canonical 胜出 ──
  console.log('\n[T1] 冲突人员：buildingId=B003 vs building=2号楼 → 认 B003')
  const t1 = await page.evaluate(async () => {
    const m = await import('/shared/person/personRuntime.js')
    const conflict = { id: 'ZZ-P1', buildingId: 'B003', building: '2号楼', floorId: '5F', floor: '4F', zone: 'A区', area: 'D区', status: 'normal' }
    return {
      bid: m.buildingIdOf(conflict), fid: m.floorIdOf(conflict), zid: m.zoneOf(conflict),
      hitCanon: m.personInLocation(conflict, { buildingId: 'B003', floorId: '5F', zone: 'A区' }),
      missAlias: m.personInLocation(conflict, { buildingId: 'B002', floorId: '4F', zone: 'D区' }),
      missName: m.personInLocation(conflict, { building: '2号楼' }),
      countCanon: m.countPersonsInLocation([conflict], { buildingId: 'B003', floorId: '5F', zone: 'A区' }),
      countAlias: m.countPersonsInLocation([conflict], { building: '2号楼', floorId: '4F', zone: 'D区' }),
      norm: (() => { const n = m.normalizePersonRuntime(conflict); return { buildingId: n.buildingId, floorId: n.floorId, zone: n.zone, building: n.building, floor: n.floor, area: n.area } })(),
    }
  })
  check('helper 三元组取 canonical（B003 / 5F / A区）', t1.bid === 'B003' && t1.fid === '5F' && t1.zid === 'A区', t1)
  check('canonical 命中、alias 口径不命中', t1.hitCanon === true && t1.missAlias === false && t1.missName === false, t1)
  check('countPersonsInLocation 同口径（canonical=1 / alias=0）', t1.countCanon === 1 && t1.countAlias === 0, t1)
  check('normalizePersonRuntime 后别名同源（3号楼 / 5F / A区）',
    t1.norm.building === '3号楼' && t1.norm.floor === '5F' && t1.norm.area === 'A区', t1.norm)

  // ── T2：DeviceView 楼栋 / 楼层筛选只认 canonical ──
  console.log('\n[T2] 冲突设备筛选：DeviceView 只认 buildingId / floorId')
  await page.goto(`${PAGE_URL}#/devices`, { waitUntil: 'load' })
  await waitFor(() => page.locator('.device-table').count().then((c) => c > 0), 20000)
  const panelCount = () => page.locator('.panel-count').first().innerText().then((t) => parseInt(t.trim(), 10) || 0)
  const DEV_ID = 'ZZ-B3C-DEV-001'
  await page.evaluate((did) => {
    const s = window.__demo.store
    if (!s.devices.some((d) => String(d.id) === did)) {
      s.devices.push({
        id: did, name: 'B3C冲突设备', type: 'smoke_detector',
        buildingId: 'B003', building: '2号楼',
        floorId: '5F', floor: '4F', zone: 'A区', area: 'D区',
        status: 'normal', currentMode: 'daily', direction: 'left', brightness: 60, emergencyFlash: false,
        battery: 90, x: 120, y: 60,
      })
    }
  }, DEV_ID)
  // 用搜索框把目标设备单独隔离出来
  await page.locator('.filter-item input').first().fill(DEV_ID)
  await sleep(400)
  check('目标冲突设备已进入台账（过滤前可见）', await panelCount() === 1, await panelCount())

  async function pickSelect(idx, label) {
    const item = page.locator('.filter-item').nth(idx)
    await item.locator('.el-select').click()
    await sleep(250)
    const opt = page.locator('.el-select-dropdown__item:visible', { hasText: new RegExp(`^${label}$`) }).first()
    await opt.click()
    await sleep(350)
  }
  async function clearSelect(idx) {
    const item = page.locator('.filter-item').nth(idx)
    await item.locator('.el-select').hover()
    await sleep(150)
    const clear = item.locator('.el-select__clear')
    if (await clear.count()) { await clear.first().click({ force: true }); await sleep(250) }
  }
  await pickSelect(2, '3号楼')
  check('筛选「3号楼」命中 canonical 设备（1 台）', await panelCount() === 1, await panelCount())
  await clearSelect(2)
  await pickSelect(2, '2号楼')
  check('筛选「2号楼」不得因别名命中（0 台）', await panelCount() === 0, await panelCount())
  await clearSelect(2)
  await pickSelect(2, '3号楼')
  await pickSelect(3, '5F')
  check('筛选「3号楼 + 5F」命中（canonical 楼层）', await panelCount() === 1, await panelCount())
  await clearSelect(3)
  await pickSelect(3, '4F')
  check('筛选「3号楼 + 4F」不得因别名 floor=4F 命中（0 台）', await panelCount() === 0, await panelCount())
  await clearSelect(3); await clearSelect(2)
  await page.locator('.filter-item input').first().fill('')
  await sleep(300)

  // ── T3：冲突火灾 → 2D / 3D 只认 canonical ──
  console.log('\n[T3] 冲突火灾：2D 火区 + 3D 高亮 + FireZone3D 只认 canonical')
  await page.goto(PAGE_URL, { waitUntil: 'load' })
  await waitFor(() => page.evaluate(() => Boolean(window.__demo)), 20000)
  await waitFor(() => page.evaluate(() => Boolean(window.__dtwin && window.__dtwin.model && window.__dtwin.model.idx && window.__dtwin.model.idx.entries.length > 0)), 40000)
  await waitFor(() => page.locator('.bo-card').count().then((c) => c > 0), 20000)
  const t3has3D = await page.evaluate(() => Boolean(window.__dtwin && window.__dtwin.fire))
  await setCurrentBuilding('B003')
  // 断开 WS：防止后端 IDLE 快照把我们构造的冲突 fireEvent 覆盖掉
  await page.evaluate(() => { try { window.__demo.demoStore.disconnect() } catch (_) {} })
  await sleep(300)
  // 直接写入「canonical 与别名故意冲突」的 fireEvent（绕开快照的 canonical 重算）
  await page.evaluate(() => {
    window.__demo.store.fireEvent = {
      id: 'FE-B3C-CONFLICT',
      buildingId: 'B003', building: '2号楼',
      floorId: '5F', floor: '4F',
      zone: 'A区', area: 'D区',
      level: 'danger', status: 'active', time: new Date().toISOString(),
    }
  })
  await sleep(500)

  if (!t3has3D) skip('3D 火区高亮 / FireZone3D 断言', 'WebGL / GLB 未就绪')
  if (t3has3D) {
    const t3d = await page.evaluate(async () => {
      const utils = await import('/src/components/building3d/building3dUtils.js')
      const dt = window.__dtwin
      const model = dt.model
      model.applyHighlight({ selFloorNum: null, selZone: null })
      model.applyFireHighlight(window.__demo.store.fireEvent)
      const hex = utils.COLORS.fire
      const lit = model.idx.entries
        .filter((e) => e.mats.some((m) => m.emissive && m.emissive.getHex && m.emissive.getHex() === hex))
        .map((e) => ({ floorId: e.tag.floorId, zone: e.tag.zone, kind: e.tag.kind }))
      dt.fire.update(window.__demo.store)
      return {
        lit,
        zones: lit.filter((e) => e.kind !== 'wall'),
        fireActiveFloorId: dt.fire.activeFloorId,
        fireActiveZone: dt.fire.activeZone,
        fireVisible: dt.fire.group.visible,
      }
    })
    check('BuildingModel.applyFireHighlight 只点亮 canonical 楼层（全部 floorId=5F）',
      t3d.zones.length > 0 && t3d.zones.every((e) => e.floorId === '5F'), t3d.zones.slice(0, 5))
    check('BuildingModel.applyFireHighlight 只点亮 canonical 区域（zone=A区，不是 alias D区）',
      t3d.zones.every((e) => e.zone === 'A区'), t3d.zones.slice(0, 5))
    check('FireZone3D 落位 canonical（activeFloorId=5F / activeZone=A区 / 可见）',
      t3d.fireActiveFloorId === '5F' && t3d.fireActiveZone === 'A区' && t3d.fireVisible === true, t3d)

    // 未知楼栋（B999）：不得静默归入当前楼栋（趁 GLB 已加载在这里一并验证）
    const t9v = await page.evaluate(() => {
      const s = window.__demo.store
      s.fireEvent = { id: 'FE-B3C-999', buildingId: 'B999', building: '9号楼', floorId: '5F', floor: '5F', zone: 'A区', area: 'A区', level: 'danger', status: 'active' }
      window.__dtwin.fire.update(s)
      return { visible: window.__dtwin.fire.group.visible, sel: s.dashboardView ? s.dashboardView.selectedBuildingId : null }
    })
    check('FireZone3D 对未知楼栋不显示火区（禁止静默归当前楼栋）', t9v.visible === false, t9v)
    check('未知楼栋不改变当前选中楼栋（仍为 B003）', t9v.sel === 'B003', t9v)
    // 还原冲突火灾，供下面的 2D 校验使用
    await page.evaluate(() => {
      window.__demo.store.fireEvent = {
        id: 'FE-B3C-CONFLICT',
        buildingId: 'B003', building: '2号楼',
        floorId: '5F', floor: '4F',
        zone: 'A区', area: 'D区',
        level: 'danger', status: 'active', time: new Date().toISOString(),
      }
    })
    await sleep(400)
  }

  // 2D：楼层网格的「火警楼层」标记 + 内联平面图的火区房间矩形（按 canonical floorId / zone）
  const t2d = await page.evaluate(async () => {
    const fp = await import('/src/mock/floorPlanData.js')
    const a = (fp.ROOMS || []).find((r) => r.name === 'A区')
    const d = (fp.ROOMS || []).find((r) => r.name === 'D区')
    return { aX: a ? a.x : null, dX: d ? d.x : null }
  })
  // 进入楼层网格视图（默认停楼栋总览）
  await waitFor(() => page.locator('.bo-action').count().then((c) => c > 0), 15000)
  await page.locator('.bo-action', { hasText: '进入楼层平面图' }).first().click()
  await waitFor(() => page.locator('.floor-card').count().then((c) => c > 0), 15000)
  await sleep(400)
  const fireFloorCards = await page.evaluate(() => [...document.querySelectorAll('.floor-card.fire-floor')]
    .map((c) => (c.querySelector('.floor-num') || {}).textContent?.trim() || ''))
  check('2D 楼层网格：只有 canonical 楼层 5F 被标记为火警楼层（别名 4F 不参与）',
    fireFloorCards.length === 1 && fireFloorCards[0] === '5F', fireFloorCards)

  const grid2d = await page.evaluate(() => [...document.querySelectorAll('.floor-card')].map((c) => {
    const pulse = c.querySelector('.fire-zone-pulse')
    return {
      floor: (c.querySelector('.floor-num') || {}).textContent?.trim() || '',
      fireFloor: c.classList.contains('fire-floor'),
      fireX: pulse ? Number(pulse.getAttribute('x')) : null,
    }
  }))
  const g5 = grid2d.find((f) => f.floor === '5F')
  const g4 = grid2d.find((f) => f.floor === '4F')
  check('2D 楼层网格：只有 canonical 楼层 5F 渲染火区（别名 4F 不渲染）',
    !!g5 && g5.fireX !== null && !!g4 && g4.fireX === null, { g5, g4 })
  check('2D 火区矩形落在 canonical A区（x 与 A区房间一致，不是别名 D区）',
    !!g5 && t2d.aX !== null && Math.abs(Number(g5.fireX) - Number(t2d.aX)) < 1, { fireX: g5 && g5.fireX, aX: t2d.aX, dX: t2d.dX })

  // ── T4：楼栋设备数 buildingDeviceCount 按 canonical 入账 ──
  console.log('\n[T4] buildingDeviceCount：冲突设备只计入 canonical 楼栋')
  await page.evaluate(() => {
    const s = window.__demo.store
    if (typeof s.saveDashboardViewState === 'function') {
      s.saveDashboardViewState({ viewMode: 'buildings', buildingId: 'B003', floorId: null, zone: null })
    }
  })
  await sleep(700) // 等持久化 debounce 落盘
  await page.goto(PAGE_URL, { waitUntil: 'load' })
  await page.reload({ waitUntil: 'load' })
  await waitFor(() => page.locator('.bo-card').count().then((c) => c > 0), 25000)
  await waitFor(() => page.evaluate(() => Boolean(window.__demo)), 20000)
  if (!(await page.locator('.bo-card').count())) {
    // 兜底：若仍停在楼层视图，手动退回楼栋总览
    const back = page.locator('button, .ft-tab, .fp-back', { hasText: /总览|返回/ }).first()
    if (await back.count()) { await back.click(); await sleep(800) }
  }
  // 断开 WS：避免后端快照在计数前后替换 devices，造成计数抖动
  await page.evaluate(() => { try { window.__demo.demoStore.disconnect() } catch (_) {} })
  await sleep(500)
  const cardDeviceCount = (name) => page.evaluate((n) => {
    const cards = [...document.querySelectorAll('.bo-card')]
    const card = cards.find((c) => (c.querySelector('.bo-card-name') || {}).textContent?.trim() === n)
    if (!card) return null
    const stat = [...card.querySelectorAll('.bo-stat b')]
    return stat.length >= 2 ? parseInt(stat[1].textContent.trim(), 10) : null
  }, name)
  const before3 = await cardDeviceCount('3号楼')
  const before2 = await cardDeviceCount('2号楼')
  check('已进入楼栋总览（3 号楼 / 2 号楼卡片可读）', before3 !== null && before2 !== null, { before3, before2 })
  await page.evaluate((did) => {
    const s = window.__demo.store
    if (!s.devices.some((d) => String(d.id) === did)) {
      // 整体赋值的写法比 push 更能触发列表重算（部分视图对数组原地变更响应不及时）
      s.devices = (s.devices || []).concat([{
        id: did, name: 'B3C冲突设备2', type: 'smoke_detector',
        buildingId: 'B003', building: '2号楼', floorId: '5F', floor: '4F',
        zone: 'A区', area: 'D区', status: 'normal', x: 120, y: 60,
      }])
    }
    if (typeof s.refreshBuildings === 'function') s.refreshBuildings()
  }, 'ZZ-B3C-DEV-002')
  await waitFor(() => page.locator('.bo-card').count().then((c) => c > 0), 10000)
  await sleep(1200)
  const after3 = await cardDeviceCount('3号楼')
  const after2 = await cardDeviceCount('2号楼')
  const diag4 = await page.evaluate(() => {
    const s = window.__demo.store
    return {
      total: (s.devices || []).length,
      b003: (s.devices || []).filter((d) => d && String(d.buildingId) === 'B003').length,
      hasInjected: (s.devices || []).some((d) => String(d.id) === 'ZZ-B3C-DEV-002'),
      cardTexts: [...document.querySelectorAll('.bo-card')].map((c) => (c.textContent || '').replace(/\s+/g, ' ').trim()),
    }
  })
  check('3号楼设备数 +1（canonical 入账）', after3 === before3 + 1, { before: before3, after: after3, diag4 })
  check('2号楼设备数不变（别名不得反向入账）', after2 === before2, { before: before2, after: after2 })

  // ── T5：应急联动预览 emPreviewCount 按 canonical 楼栋 / 楼层统计 ──
  console.log('\n[T5] emPreviewCount：只统计 canonical 楼栋 + canonical 楼层')
  await page.goto(`${PAGE_URL}#/dashboard?panel=emergency`, { waitUntil: 'load' })
  await waitFor(() => page.locator('.emergency-panel').count().then((c) => c > 0), 20000)
  await waitFor(() => page.evaluate(() => Boolean(window.__demo)), 20000)
  await page.evaluate(() => { try { window.__demo.demoStore.disconnect() } catch (_) {} })
  await setCurrentBuilding('B003')
  await sleep(300)
  const emPreview = () => page.evaluate(() => {
    const el = document.querySelector('.em-preview')
    if (!el) return null
    const strongs = [...el.querySelectorAll('strong')]
    return strongs.length >= 2 ? parseInt(strongs[1].textContent.trim(), 10) : null
  })
  /** 只保留单一楼层被勾选（emFloors 是累加数组，必须先清掉其它楼层） */
  const pickEmFloorOnly = async (fid) => {
    const items = await page.locator('.em-check-item').all()
    for (const it of items) {
      const txt = ((await it.innerText()) || '').trim()
      const box = it.locator('input')
      const checked = await box.isChecked()
      if (txt === fid && !checked) { await box.click(); await sleep(200) }
      else if (txt !== fid && checked) { await box.click(); await sleep(200) }
    }
    await sleep(300)
  }
  const emBase = await emPreview()
  await pickEmFloorOnly('4F')
  const em4_0 = await emPreview()
  await pickEmFloorOnly('5F')
  const em5_0 = await emPreview()
  await page.evaluate(() => {
    const s = window.__demo.store
    if (!s.devices.some((d) => String(d.id) === 'ZZ-B3C-DEV-003')) {
      s.devices.push({
        id: 'ZZ-B3C-DEV-003', name: 'B3C冲突设备3', type: 'evacuation_light',
        buildingId: 'B003', building: '2号楼', floorId: '5F', floor: '4F',
        zone: 'A区', area: 'D区', status: 'normal', direction: 'left', x: 120, y: 60,
      })
    }
  })
  await sleep(500)
  const em5_1 = await emPreview()
  check('应急联动 5F 预览数 +1（canonical 楼栋 + canonical 楼层命中）', em5_1 === em5_0 + 1, { em5_0, em5_1 })
  await pickEmFloorOnly('4F')
  const em4_1 = await emPreview()
  check('应急联动 4F 预览数不含该设备（别名 floor=4F 不参与）', em4_1 === em4_0, { before: em4_0, after: em4_1 })

  // ── T6：新建人员必须自带完整 canonical ──
  console.log('\n[T6] simulatePerson：新人员必须带 buildingId / floorId / zone')
  const t6 = await page.evaluate(() => {
    const s = window.__demo.store
    const p = s.simulatePerson()
    return {
      buildingId: p.buildingId, floorId: p.floorId, zone: p.zone,
      building: p.building, floor: p.floor, area: p.area,
      nonCanonical: typeof s.countNonCanonicalPersons === 'function' ? s.countNonCanonicalPersons() : null,
    }
  })
  check('新人员 buildingId 符合 B\\d{3}', /^B\d{3}$/.test(String(t6.buildingId || '')), t6)
  check('新人员 floorId 符合 \\d+F', /^\d+F$/.test(String(t6.floorId || '')), t6)
  check('新人员 zone 非空', Boolean(t6.zone), t6)
  check('新人员别名与 canonical 同源（floor === floorId）', t6.floor === t6.floorId, t6)

  // ── T7：riskArea 必须自带 canonical 三元组 ──
  console.log('\n[T7] simulateRisk：riskArea 必须带 canonical 三元组')
  const t7 = await page.evaluate(() => {
    const s = window.__demo.store
    const before = Array.isArray(s.riskAreas) ? s.riskAreas.length : 0
    s.simulateRisk('3号楼', '5F', 'A区')
    const list = s.riskAreas || []
    const last = list[list.length - 1]
    return {
      grew: list.length > before,
      buildingId: last ? last.buildingId : null,
      floorId: last ? last.floorId : null,
      zone: last ? last.zone : null,
      building: last ? last.building : null,
      floor: last ? last.floor : null,
      allCanonical: list.every((r) => /^B\d{3}$/.test(String(r.buildingId || '')) && /^\d+F$/.test(String(r.floorId || '')) && Boolean(r.zone)),
    }
  })
  check('riskArea 已写入', t7.grew === true, t7)
  check('riskArea canonical = B003 / 5F / A区', t7.buildingId === 'B003' && t7.floorId === '5F' && t7.zone === 'A区', t7)
  check('存量 riskAreas 全部具备 canonical 三元组（alias 不再是第二口径）', t7.allCanonical === true, t7)

  // ── T8：generateRoutePlans 跨楼栋不 replan ──
  console.log('\n[T8] generateRoutePlans：跨楼栋不串 buildingId')
  const t8 = await page.evaluate(() => {
    const s = window.__demo.store
    const m1 = s.generateRoutePlans({ buildingId: 'B002', floorId: '5F' })
    const blockedCross = (s.routePlans || []).filter((p) => p.status === 'BLOCKED').length
    const m2 = s.generateRoutePlans({ buildingId: 'B003', floorId: '5F' })
    return {
      crossMatrix: m1 ? m1.buildingId : null,
      sameMatrix: m2 ? m2.buildingId : null,
      blockedCross,
    }
  })
  check('generateRoutePlans 按 canonical buildingId 生成（跨楼栋 B002 不被火源影响）',
    t8.crossMatrix === 'B002' && t8.blockedCross === 0, t8)
  check('generateRoutePlans 同 canonical 楼栋正常返回 B003', t8.sameMatrix === 'B003', t8)

  // ── T9：未知楼栋不得静默归入当前楼栋 ──
  console.log('\n[T9] 未知楼栋 B999：不命中、不归当前楼栋（helper / store 层）')
  const t9 = await page.evaluate(() => {
    const s = window.__demo.store
    s.fireEvent = { id: 'FE-B3C-999', buildingId: 'B999', building: '9号楼', floorId: '5F', floor: '5F', zone: 'A区', area: 'A区', level: 'danger', status: 'active' }
    return { selBuildingId: s.dashboardView ? s.dashboardView.selectedBuildingId : null }
  })
  const t9b = await page.evaluate(async () => {
    const m = await import('/shared/person/personRuntime.js')
    const b = await import('/shared/device/deviceRuntime.js')
    const fe = window.__demo.store.fireEvent
    return {
      bid: m.buildingIdOf(fe),
      devInBuilding: b.deviceInBuilding({ id: 'X', buildingId: 'B003', floorId: '5F', zone: 'A区', status: 'normal' }, 'B999'),
      devInBuildingUnknownName: b.deviceInBuilding({ id: 'X', buildingId: 'B003', floorId: '5F', zone: 'A区', status: 'normal' }, '9号楼'),
    }
  })
  check('未知楼栋 fireEvent 不得静默归当前楼栋（selectedBuildingId 仍为 B003）', t9.selBuildingId === 'B003', t9)
  check('deviceInBuilding：B999 / 9号楼 均不命中', t9b.devInBuilding === false && t9b.devInBuildingUnknownName === false, t9b)
  check('buildingIdOf 保持未知 id 原样（不静默替换）', t9b.bid === 'B999', t9b)
  check('deviceInBuilding：B999 / 9号楼 均不命中', t9b.devInBuilding === false && t9b.devInBuildingUnknownName === false, t9b)
  check('buildingIdOf 保持未知 id 原样（不静默替换）', t9b.bid === 'B999', t9b)

  // ── T10：Demo Golden Path 全程 canonical 不漂移 ──
  console.log('\n[T10] Golden Path：逐阶段 canonical 与后端对齐')
  await page.evaluate(() => { window.__demo.store.fireEvent = null })
  await cmd('RESET'); await sleep(1000)
  const gp = [['START_FIRE', 'FIRE_DETECTED'], ['ACTIVATE_RESPONSE', 'EMERGENCY_RESPONSE'], ['PLAN_ROUTES', 'ROUTE_PLANNING']]
  for (const [command, expect] of gp) {
    await cmd(command)
    const ok = await waitFor(async () => (await state()).stage === expect, 20000)
    check(`${command} → ${expect}`, ok, (await state()).stage)
    await sleep(700)
    const fe = await readFireEvent()
    const be = await state()
    check(`${expect}：canonical 三元组与后端一致`,
      !fe || !be.fire || (fe.buildingId === be.fire.buildingId && fe.floorId === be.fire.floorId && fe.zone === be.fire.zone),
      { fe, be: be.fire })
  }
  const steps = [
    ['CONFIRM_ROUTE', 'SMART_EVACUATION', { buildingPlanId: 'PLAN-B' }],
    ['COMPLETE_EVACUATION', 'RETAINED_PERSONS', {}],
    ['CONFIRM_RETAINED', 'RESCUE_COORDINATION', {}],
    ['COMPLETE_RESCUE', 'COMPLETED', {}],
  ]
  for (const [command, expect, payload] of steps) {
    await cmd(command, payload)
    const ok = await waitFor(async () => (await state()).stage === expect, 25000)
    check(`${command} → ${expect}`, ok, (await state()).stage)
    await sleep(700)
    const fe = await readFireEvent()
    const be = await state()
    check(`${expect}：canonical 三元组全程不漂移`,
      !fe || !be.fire || (fe.buildingId === be.fire.buildingId && fe.floorId === be.fire.floorId && fe.zone === be.fire.zone),
      { fe, be: be.fire })
    check(`${expect}：别名与 canonical 同源（building/floor/area 由 canonical 派生）`,
      !fe || (fe.building !== '2号楼' && fe.floor === fe.floorId && fe.area === fe.zone), fe)
  }
  await cmd('RESET'); await sleep(1200)

  // ── T11：PersonLayer3D legacy fallback 只影响渲染，不改 canonical ──
  console.log('\n[T11] PersonLayer3D：legacy fallback 只决定是否渲染，写入的仍是 canonical')
  const t11ready = await waitFor(() => page.evaluate(() => Boolean(window.__dtwin && window.__dtwin.persons && window.__dtwin.model)), 60000)
  if (!t11ready) skip('PersonLayer3D legacy fallback 断言', '3D 未就绪')
  if (t11ready) {
    const t11 = await page.evaluate(() => {
      const s = window.__demo.store
      if (s.dashboardView) s.dashboardView.selectedBuildingId = 'B003'
      // 无 canonical 的人员（只有旧别名）→ 允许 legacy fallback 判定渲染，但运行时字段必须是 canonical
      const tmpId = 'ZZ-B3C-NOCANON'
      if (!s.persons.some((p) => String(p.id) === tmpId)) {
        s.persons.push({
          id: tmpId, name: '无canonical人员', building: '3号楼', floor: '5F', zone: 'A区',
          status: 'normal', x: 100, y: 100, position: { x: 100, y: 100 },
          routeId: null, routePoints: [], progress: 0, movementType: 'static',
        })
      }
      window.__dtwin.persons.update(s)
      const hit = (window.__dtwin.persons.data || []).find((d) => String(d.id) === tmpId)
      const idx = s.persons.findIndex((p) => String(p.id) === tmpId)
      if (idx >= 0) s.persons.splice(idx, 1)
      return hit ? { buildingId: hit.buildingId, floorId: hit.floorId, zone: hit.zone } : null
    })
    check('legacy（无 canonical）人员仍可被选中渲染', t11 !== null, t11)
    check('PersonLayer3D 写入的是 canonical 三元组（B003 / 5F / A区）',
      !!t11 && t11.buildingId === 'B003' && t11.floorId === '5F' && t11.zone === 'A区', t11)
  }

  const fin = await state()
  check('收尾：后端回到 IDLE', fin.stage === 'IDLE', fin.stage)

  await browser.close()
  console.log(`\n=== 结果：${passed} 通过 / ${failed} 失败 / ${skipped} 跳过 ===`)
  if (failures.length) console.log('失败项：\n  - ' + failures.join('\n  - '))
  console.log('')
  process.exit(failed ? 1 : 0)
})().catch((err) => {
  console.error('\n[B3c E2E] 执行异常：', err)
  process.exit(1)
})

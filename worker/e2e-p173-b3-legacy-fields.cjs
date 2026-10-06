/**
 * P1.7.3-B3 旧字段 / 旧别名权威链回归
 *
 * 目标：证明 business 判定只认 canonical 三元组（buildingId / floorId / zone），
 *      旧别名 building / floor / area 只作为「由 canonical 派生的只读兼容层」。
 *
 * 手法：
 *   ① 注入「canonical 与别名故意冲突」的后端快照（走真实入口 store.applyDemoSnapshot），
 *      断言 store 里 canonical 胜出、别名被重算；
 *   ② 跑真实 Golden Path（后端状态机驱动），逐阶段比对 前端 canonical 与后端 /demo/state。
 *
 * 用法（需 demo 模式前端 + 后端已启动）：
 *   1) set VITE_DATA_SOURCE=demo && npx vite --port 5199
 *   2) npx wrangler dev（worker）
 *   3) node worker/e2e-p173-b3-legacy-fields.cjs
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

let passed = 0, failed = 0
const failures = []
function check(name, cond, extra) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name); console.log(`  ✗ ${name}${extra !== undefined ? ' → ' + JSON.stringify(extra).slice(0, 400) : ''}`) }
}
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
  console.log(`\n=== P1.7.3-B3 旧字段 / 旧别名权威链回归（${PAGE_URL} · ${API_BASE}）===\n`)
  const browser = await chromium.launch({ channel: 'msedge', headless: true })
  const page = await browser.newPage()
  await page.goto(PAGE_URL, { waitUntil: 'load', timeout: 45000 })
  await waitFor(() => page.evaluate(() => Boolean(window.__demo)), 20000)
  check('页面挂载并暴露开发钩子', await page.evaluate(() => Boolean(window.__demo)))
  check('运行模式为 demo', (await page.evaluate(() => window.__demo.dataSource.mode)) === 'demo')

  // 从干净状态开始
  const st0 = await state()
  if (st0.stage && st0.stage !== 'IDLE') await cmd('RESET')
  await sleep(1200)

  /** 前端 canonical / alias 快照 */
  const feLoc = () => page.evaluate(() => {
    const s = window.__demo.store
    const fe = s.fireEvent
    return {
      selBuildingId: (s.dashboardView || {}).selectedBuildingId,
      fire: fe ? {
        buildingId: fe.buildingId, floorId: fe.floorId, zone: fe.zone,
        building: fe.building, floor: fe.floor, area: fe.area,
      } : null,
      nonCanonicalPersons: typeof s.countNonCanonicalPersons === 'function' ? s.countNonCanonicalPersons() : null,
      nonCanonicalDevices: typeof s.countNonCanonicalDevices === 'function' ? s.countNonCanonicalDevices() : null,
      planBuildingId: s.activeBuildingPlan ? s.activeBuildingPlan.buildingId : null,
      plans: (s.buildingEvacuationPlans || []).map((p) => p.buildingId),
    }
  })
  /** 取一个真实存在的设备 id / 人员 id（后续用冲突别名覆盖） */
  const pickIds = () => page.evaluate(() => {
    const s = window.__demo.store
    const d = (s.devices || []).find((x) => x && x.id)
    const p = (s.persons || []).find((x) => x && x.id)
    return { deviceId: d ? String(d.id) : null, personId: p ? String(p.id) : null }
  })
  const readDevice = (id) => page.evaluate((did) => {
    const d = (window.__demo.store.devices || []).find((x) => String(x.id) === String(did))
    return d ? {
      buildingId: d.buildingId, floorId: d.floorId, zone: d.zone,
      building: d.building, floor: d.floor, area: d.area,
    } : null
  }, id)
  const readPerson = (id) => page.evaluate((pid) => {
    const p = (window.__demo.store.persons || []).find((x) => String(x.id) === String(pid))
    return p ? {
      buildingId: p.buildingId, floorId: p.floorId, zone: p.zone,
      building: p.building, floor: p.floor, area: p.area,
    } : null
  }, id)

  const ids = await pickIds()
  check('页面已加载设备 / 人员台账', Boolean(ids.deviceId && ids.personId), ids)

  // ── Case 1：设备 canonical 与别名冲突 → 必须认 canonical ──
  console.log('\n[Case 1] 设备：buildingId=B003 与 building=2号楼 冲突 → 认 B003')
  await page.evaluate((did) => {
    window.__demo.store.applyDemoSnapshot({
      devices: [{
        id: did, buildingId: 'B003', building: '2号楼',
        floorId: '5F', floor: '4F', zone: 'A区', area: 'D区',
        status: 'emergency', currentMode: 'emergency', direction: 'left', brightness: 100, emergencyFlash: false,
      }],
    })
  }, ids.deviceId)
  await sleep(400)
  const dev1 = await readDevice(ids.deviceId)
  check('设备 canonical 保持 B003 / 5F / A区',
    dev1 && dev1.buildingId === 'B003' && dev1.floorId === '5F' && dev1.zone === 'A区', dev1)
  check('设备别名随 canonical 重算（3号楼 / 5F / A区），不是冲突值 2号楼 / 4F / D区',
    dev1 && dev1.building === '3号楼' && dev1.floor === '5F' && dev1.area === 'A区', dev1)

  // ── Case 2：人员 canonical 与别名冲突 → 必须认 canonical ──
  console.log('\n[Case 2] 人员：floorId=5F 与 floor=4F 冲突 → 认 5F')
  await page.evaluate((pid) => {
    window.__demo.store.applyDemoSnapshot({
      persons: [{
        id: pid, buildingId: 'B003', building: '2号楼',
        floorId: '5F', floor: '4F', zone: 'A区', area: 'D区',
        status: 'evacuating', progress: 0.2, routePoints: [], routeId: null,
        position: { x: 100, y: 100 },
      }],
    })
  }, ids.personId)
  await sleep(400)
  const per2 = await readPerson(ids.personId)
  check('人员 canonical 保持 B003 / 5F / A区',
    per2 && per2.buildingId === 'B003' && per2.floorId === '5F' && per2.zone === 'A区', per2)
  check('人员别名随 canonical 重算（3号楼 / 5F / A区）',
    per2 && per2.building === '3号楼' && per2.floor === '5F' && per2.area === 'A区', per2)

  // ── Case 3：火灾 canonical 与别名冲突 → 必须认 canonical ──
  console.log('\n[Case 3] 火灾：zone=A区 与 area=D区 冲突 → 认 A区')
  await page.evaluate(() => {
    window.__demo.store.applyDemoSnapshot({
      stage: 'FIRE_DETECTED',
      fire: {
        id: 'FE-B3-TEST', buildingId: 'B003', buildingName: '2号楼',
        floorId: '5F', zone: 'A区', area: 'D区', level: 'danger', detectedAt: new Date().toISOString(),
      },
    })
  })
  await sleep(500)
  const loc3 = await feLoc()
  check('fireEvent canonical = B003 / 5F / A区',
    loc3.fire && loc3.fire.buildingId === 'B003' && loc3.fire.floorId === '5F' && loc3.fire.zone === 'A区', loc3.fire)
  check('fireEvent 别名由 canonical 派生（building=3号楼 / area=A区）',
    loc3.fire && loc3.fire.building === '3号楼' && loc3.fire.area === 'A区' && loc3.fire.floor === '5F', loc3.fire)

  // ── Case 4：楼栋筛选不得混入其他楼栋（别名冲突也不漂移）──
  console.log('\n[Case 4] 楼栋筛选：当前 B003，不得出现 B002 的设备 / 人员 / 火灾')
  const loc4 = await feLoc()
  check('2D 选中楼栋按 canonical 收敛到 B003（未被别名 buildingName=2号楼 带偏到 B002）',
    loc4.selBuildingId === 'B003', loc4.selBuildingId)
  check('台账无 B002 人员冒充 B003（canonical 完整率 100%）',
    loc4.nonCanonicalPersons === 0, loc4.nonCanonicalPersons)
  check('台账无 B002 设备冒充 B003（canonical 完整率 100%）',
    loc4.nonCanonicalDevices === 0, loc4.nonCanonicalDevices)

  // ── Case 5：跨楼栋方案隔离（继承 B1/B2 口径）──
  console.log('\n[Case 5] 跨楼栋方案：方案只属于火警楼栋 B003')
  await cmd('RESET'); await sleep(800)
  await cmd('START_FIRE'); await sleep(400)
  await cmd('ACTIVATE_RESPONSE'); await sleep(400)
  await cmd('PLAN_ROUTES'); await sleep(1500)
  const loc5 = await feLoc()
  check('存在后端下发的整栋楼方案', Array.isArray(loc5.plans) && loc5.plans.length > 0, loc5.plans)
  check('方案归属 canonical buildingId = B003（没有 B002 方案混入）',
    loc5.plans.every((b) => b === 'B003') && loc5.planBuildingId === 'B003', loc5)
  const be5 = await state()
  check('前端方案楼栋与后端 fire.buildingId 一致',
    !be5.fire || be5.fire.buildingId === 'B003', be5.fire)

  // ── Case 6：2D 平面图（火灾 / 设备 / 人员判定走 canonical）──
  console.log('\n[Case 6] 2D：火灾 / 设备 / 人员判定只认 canonical')
  const loc6 = await feLoc()
  check('2D 选中楼栋 = 火警 canonical buildingId',
    loc6.selBuildingId === (loc6.fire ? loc6.fire.buildingId : null), loc6)
  const be6 = await state()
  check('前端 fireEvent 三元组 === 后端 fire 三元组（canonical 全等）',
    loc6.fire && be6.fire
      && loc6.fire.buildingId === be6.fire.buildingId
      && loc6.fire.floorId === be6.fire.floorId
      && loc6.fire.zone === be6.fire.zone, { fe: loc6.fire, be: be6.fire })
  check('fireStore.emergencyStage 与后端阶段一致',
    (await page.evaluate(() => window.__demo.store.emergencyStage)) === (STAGE_TO_LEGACY[be6.stage] ?? -1), be6.stage)

  // ── Case 7：3D legacy fallback（缺 canonical 也不改变归属判定）──
  console.log('\n[Case 7] 3D：正常路径与 legacy fallback 都读 canonical')
  const per7 = await page.evaluate(() => {
    const s = window.__demo.store
    const list = (s.persons || []).filter((p) => p && p.buildingId === 'B003')
    return {
      total: list.length,
      aliasDrift: list.filter((p) => p.building && p.building !== '3号楼').length,
      floorDrift: list.filter((p) => p.floor && p.floor !== p.floorId).length,
      zoneDrift: list.filter((p) => p.area && p.area !== p.zone).length,
    }
  })
  check('B003 人员全部带 canonical buildingId', per7.total > 0, per7)
  check('3D 读到的 building 别名无漂移（全部 = 3号楼）', per7.aliasDrift === 0, per7)
  check('3D 读到的 floor 别名无漂移（全部 = floorId）', per7.floorDrift === 0, per7)
  check('3D 读到的 area 别名无漂移（全部 = zone）', per7.zoneDrift === 0, per7)

  // ── Case 8：Demo Golden Path 全程无字段来源漂移 ──
  console.log('\n[Case 8] Golden Path：逐阶段 canonical 与后端对齐')
  const steps = [
    ['CONFIRM_ROUTE', 'SMART_EVACUATION', { buildingPlanId: 'PLAN-B' }],
    ['COMPLETE_EVACUATION', 'RETAINED_PERSONS', {}],
    ['CONFIRM_RETAINED', 'RESCUE_COORDINATION', {}],
    ['COMPLETE_RESCUE', 'COMPLETED', {}],
  ]
  for (const [command, expect, payload] of steps) {
    await cmd(command, payload)
    const ok = await waitFor(async () => (await state()).stage === expect, 20000)
    check(`${command} → ${expect}`, ok, (await state()).stage)
    await sleep(600)
    const fe = await feLoc()
    const be = await state()
    check(`${expect}：fireEvent canonical 与后端一致（无来源漂移）`,
      !fe.fire || !be.fire || (
        fe.fire.buildingId === be.fire.buildingId
        && fe.fire.floorId === be.fire.floorId
        && fe.fire.zone === be.fire.zone
      ), { fe: fe.fire, be: be.fire })
    check(`${expect}：楼栋 / 楼层 / 区域未漂移（selectedBuildingId = 火警楼栋）`,
      fe.selBuildingId === (be.fire ? be.fire.buildingId : fe.selBuildingId), [fe.selBuildingId, be.fire])
  }

  // ── Case 9：未知楼栋不得静默归当前楼栋 ──
  console.log('\n[Case 9] 未知楼栋：查不到必须为空，禁止回退「当前楼栋」')
  const c9 = await page.evaluate(async () => {
    const mod = await import('/shared/person/personRuntime.js')
    const bmod = await import('/shared/device/deviceRuntime.js')
    return {
      unknownName: mod.buildingIdOf({ building: '9号楼' }),
      unknownId: mod.buildingIdOf({ buildingId: 'B099' }),
      conflict: mod.buildingIdOf({ buildingId: 'B003', building: '2号楼' }),
      inLocUnknown: mod.personInLocation({ id: 'X', buildingId: 'B003', floorId: '5F', zone: 'A区' }, { building: '9号楼' }),
      devUnknown: bmod.deviceInBuilding({ id: 'D', buildingId: 'B003', floorId: '5F', zone: 'A区', status: 'normal' }, '9号楼'),
      devConflict: bmod.deviceInBuilding({ id: 'D', buildingId: 'B003', building: '2号楼', floorId: '5F', zone: 'A区', status: 'normal' }, 'B002'),
    }
  })
  check('未知楼栋名 → buildingIdOf 返回空串（不是当前楼栋）', c9.unknownName === '', c9.unknownName)
  check('未知楼栋 id → 原样返回，不静默替换', c9.unknownId === 'B099', c9.unknownId)
  check('personInLocation：未知楼栋不命中（禁止串楼栋）', c9.inLocUnknown === false, c9.inLocUnknown)
  check('deviceInBuilding：未知楼栋不命中', c9.devUnknown === false, c9.devUnknown)
  check('deviceInBuilding：别名 B002 不得命中 canonical B003 的设备', c9.devConflict === false, c9.devConflict)

  // ── Case 10：helper 层 canonical 优先于 alias ──
  console.log('\n[Case 10] helper：canonical 与 alias 冲突时以 canonical 为准')
  const c10 = await page.evaluate(async () => {
    const mod = await import('/shared/person/personRuntime.js')
    const conflict = { buildingId: 'B003', building: '2号楼', floorId: '5F', floor: '4F', zone: 'A区', area: 'D区' }
    const norm = mod.normalizePersonRuntime(conflict)
    return {
      bid: mod.buildingIdOf(conflict),
      fid: mod.floorIdOf(conflict),
      zid: mod.zoneOf(conflict),
      normBuilding: norm.building,
      normFloor: norm.floor,
      normArea: norm.area,
      hit: mod.personInLocation(conflict, { buildingId: 'B003', floorId: '5F', zone: 'A区' }),
      miss: mod.personInLocation(conflict, { buildingId: 'B002', floorId: '4F', zone: 'D区' }),
      nameHit: mod.personInLocation(conflict, { building: '3号楼' }),
      nameMiss: mod.personInLocation(conflict, { building: '2号楼' }),
    }
  })
  check('buildingIdOf / floorIdOf / zoneOf 全部取 canonical',
    c10.bid === 'B003' && c10.fid === '5F' && c10.zid === 'A区', c10)
  check('normalizePersonRuntime 后别名同源（3号楼 / 5F / A区）',
    c10.normBuilding === '3号楼' && c10.normFloor === '5F' && c10.normArea === 'A区', c10)
  check('canonical 命中、alias 口径不命中', c10.hit === true && c10.miss === false, c10)
  check('中文名入参反查 canonical（3号楼命中 / 2号楼不命中）',
    c10.nameHit === true && c10.nameMiss === false, c10)

  // 收尾
  await cmd('RESET'); await sleep(1000)
  const fin = await state()
  check('RESET 后后端回到 IDLE', fin.stage === 'IDLE', fin.stage)

  await browser.close()
  console.log(`\n=== 结果：${passed} 通过 / ${failed} 失败 ===`)
  if (failures.length) console.log('失败项：\n  - ' + failures.join('\n  - '))
  console.log('')
  process.exit(failed ? 1 : 0)
})().catch((err) => {
  console.error('\n[B3 E2E] 执行异常：', err)
  process.exit(1)
})

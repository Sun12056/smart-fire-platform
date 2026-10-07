/**
 * P1.7.3-B4-03 专项回归（应急灯运行态三端统一）
 * ────────────────────────────────────────────────
 * 命题：status / direction / emergencyFlash / brightness / currentMode 五个运行态字段
 *       在 2D / 3D / LightingView 三端只能有一个权威来源 —— fireStore.devices[i]。
 *
 *   权威链：Backend / WS → demoStore.devices → fireStore.devices
 *           →┬→ 3D  (EmergencyLight3D：rec.runtime)
 *            ├→ 2D  (BuildingView 平面图：.plan-device data-*)
 *            └→ LightingView（当前选中设备的 brightness / currentMode / status）
 *
 * 负向断言（修复前必然失败）：
 *   T1 3D 图层必须消费权威设备的五字段（修复前 tick 只读全局 store.emergencyMode，
 *      status / currentMode / brightness / emergencyFlash 一律未被消费）
 *   T2 3D 应急强闪只能由设备自身 emergencyFlash 决定（修复前被全局 emergencyMode 污染，
 *      非火情楼栋 B001 的灯具在演练中也会被强闪）
 *   T3 3D 疏散方向必须随权威 direction 收敛（修复前只在 _bindEvac 时读一次，
 *      后端翻转后箭头不更新）
 *   T4/T5 LightingView 的亮度 / 模式必须等于「当前选中的权威设备」，
 *      而不是全局聚合 lightingStatus（修复前读 snap.lighting 聚合：
 *      非火情楼栋设备显示 100%，火情楼栋设备显示「日常节能」）
 *   T6 2D 平面图必须消费权威运行态（修复前只消费 status，且 emergency 被染成绿色、
 *      无应急脉冲、无方向）
 *
 * 用法：node worker/e2e-p173-b403-runtime-unity.cjs
 */
const {
  sleep, waitFor, check, summary,
  cmd, resetDemoSession, openPage, openDemoPanel,
} = require('./e2e-lib.cjs')

// DemoRoom.DEFAULT_SCENARIO：火情楼栋固定 B003 / 5F / A区（后端托管设备只覆盖这一栋）
const FIRE_BLD = 'B003'
const OTHER_BLD = 'B001'
const FIRE_FLOOR = '5F'

const stageOf = (page) => page.evaluate(() => window.__demo.demoStore.stage)
const waitStage = (page, stage, timeout = 20000) =>
  waitFor(async () => (await stageOf(page)) === stage, timeout)

// 3D 强闪阈值：应急强闪峰值 ≈ 2.8，常态呼吸峰值 ≈ 1.2（见 EmergencyLight3D.tick）
const FLASH_PEAK_MIN = 2.0
const FLASH_PEAK_MAX_CALM = 1.5

/** 3D 数字孪生是否「已挂载且活着」（切页后 __dtwin 可能仍是已卸载的旧实例） */
const twinAlive = (page) => page.evaluate(() => {
  const dt = window.__dtwin
  if (!dt || !dt.em) return false
  const el = dt.scene && dt.scene.renderer && dt.scene.renderer.domElement
  return Boolean(el && el.isConnected && dt.em.emMap && dt.em.emMap.size > 0)
})

/** 进入楼宇态势页并把 2D / 3D 同时聚焦到指定楼栋 + 楼层 */
async function focusBuilding(page, bldId, floorId) {
  // ① 3D 各层只认 dashboardView.selectedBuildingId（canonical）
  await page.evaluate(({ bldId }) => {
    window.__demo.store.dashboardView.selectedBuildingId = String(bldId)
  }, { bldId })
  // ② 2D（BuildingView）持有自己的 selectedBld，只认楼栋列表的 UI 点击
  const bldName = await page.evaluate((bid) => {
    const b = (window.__demo.store.buildings || []).find((x) => String(x.id) === String(bid))
    return b ? String(b.name) : ''
  }, bldId)
  if (bldName) {
    await page.evaluate((name) => {
      const item = Array.from(document.querySelectorAll('.building-item'))
        .find((n) => (n.textContent || '').includes(name))
      if (item) item.click()
    }, bldName)
  }
  await sleep(400)
  // 点击楼栋会把楼层清掉，重新选楼层
  await page.evaluate((floorId) => {
    if (floorId) window.__demo.store.selectFloor(floorId)
  }, floorId)
  await waitFor(() => twinAlive(page), 40000)
  await sleep(1500)
}

/**
 * 进入楼宇态势页并等待 3D 实例就绪。
 * ⚠ 切页会卸载 BuildingDigitalTwin，而 window.__dtwin 仍指向已停止 tick 的旧实例
 *   （材质 / runtime 冻结），读它等于读假数据。因此整套用例只在「一次挂载」内完成
 *    3D / 2D 部分，智能照明页（需切页）统一放到最后。
 */
async function gotoBuildingPage(page) {
  await page.evaluate(() => { window.location.hash = '#/building' })
  await waitFor(() => page.evaluate(() => Boolean(document.querySelector('.building-view'))), 20000)
  await waitFor(() => twinAlive(page), 40000)
}

/**
 * 三端运行态指纹。
 * auth = fireStore.devices（唯一权威）；d3 = 3D 图层实际消费到的运行态；d2 = 2D 平面图 DOM。
 */
const readRuntime = () => {
  const s = window.__demo.store
  const dt = window.__dtwin || {}
  const norm = (v) => String(v ?? '')
  const bid = String(s.dashboardView.selectedBuildingId || '')
  const fid = String(s.dashboardView.selectedFloorId || '')

  const allDevices = (s.devices || []).filter(Boolean)
  const authList = allDevices.filter((d) => String(d.buildingId) === bid)
  const authMap = new Map(allDevices.map((d) => [norm(d.id), d]))
  const st = (d) => ({
    status: norm(d.status),
    currentMode: norm(d.currentMode),
    direction: norm(d.direction) === 'left' ? 'left' : 'right',
    brightness: Number(d.brightness),
    emergencyFlash: !!d.emergencyFlash,
  })
  const emergency = (d) =>
    !!d.emergencyFlash || norm(d.currentMode) === 'emergency' || norm(d.status) === 'emergency'
  const isLight = (d) => d.type === 'emergency_light' || d.type === 'evacuation_light'

  const lights = authList.filter(isLight)
  const floorLights = (fid ? lights.filter((d) => String(d.floorId) === fid) : lights)
    .map((d) => ({ id: norm(d.id), type: d.type, ...st(d), emergency: emergency(d) }))

  // ── 3D：图层实际消费到的运行态（rec.runtime）+ 箭头方向（rec.dir）
  const d3 = []
  const em = dt.em
  if (em) {
    const walk = (map, kind) => {
      if (!map) return
      map.forEach((rec, id) => {
        const dev = authMap.get(norm(id))
        if (!dev) return
        // 3D 图层不会清理上一栋楼的绑定，统计只认「当前聚焦楼栋」
        if (String(dev.buildingId) !== bid) return
        d3.push({
          id: norm(id),
          kind,
          runtime: rec.runtime || null,
          dir: norm(rec.dir),
          auth: st(dev),
          authEmergency: emergency(dev),
        })
      })
    }
    walk(em.emMap, 'emergency_light')
    walk(em.evacMap, 'evacuation_light')
  }

  // ── 2D：平面图 DOM 实际消费到的运行态（data-* 即渲染所用值，按 data-id 精确对齐权威）
  const nodes = Array.from(document.querySelectorAll('.plan-device'))
  const d2Mismatch = []
  let d2NotInBuilding = 0
  const d2 = nodes.map((g) => {
    const id = norm(g.getAttribute('data-id'))
    const dev = authMap.get(id)
    const got = {
      id,
      status: g.getAttribute('data-status'),
      mode: g.getAttribute('data-mode'),
      flash: g.getAttribute('data-flash'),
      brightness: g.getAttribute('data-brightness'),
      dir: g.getAttribute('data-dir'),
    }
    if (!dev) return { ...got, matched: false }
    if (String(dev.buildingId) !== bid) d2NotInBuilding++
    const want = st(dev)
    const diff = []
    if (got.status !== want.status) diff.push('status')
    if (got.mode !== want.currentMode) diff.push('currentMode')
    if (got.flash !== String(emergency(dev))) diff.push('emergencyFlash')
    if (Number(got.brightness) !== want.brightness) diff.push('brightness')
    if (isLight(dev) && got.dir !== want.direction) diff.push('direction')
    if (diff.length) d2Mismatch.push({ id, type: dev.type, got, want, diff })
    return { ...got, matched: true }
  })

  return {
    bid, fid,
    authLightTotal: lights.length,
    floorLights,
    d3,
    d3MissingRuntime: d3.filter((x) => !x.runtime).length,
    d3RuntimeMismatch: d3.filter((x) => x.runtime && (
      String(x.runtime.status) !== x.auth.status
      || String(x.runtime.currentMode) !== x.auth.currentMode
      || String(x.runtime.direction) !== x.auth.direction
      || Number(x.runtime.brightness) !== x.auth.brightness
      || Boolean(x.runtime.emergencyFlash) !== x.auth.emergencyFlash
    )).map((x) => ({ id: x.id, kind: x.kind, runtime: x.runtime, auth: x.auth })),
    d3DirMismatch: d3.filter((x) => x.dir && x.dir !== x.auth.direction)
      .map((x) => ({ id: x.id, kind: x.kind, dir3d: x.dir, authDir: x.auth.direction })),
    d2Total: nodes.length,
    d2NotInBuilding,
    d2MissingRuntime: d2.filter((x) => x.status === null || x.id === '').length,
    d2Mismatch,
  }
}

/**
 * 采样 3D 应急灯的光强峰值（判断是否处于「强闪」）。
 * 只统计「当前聚焦楼栋」的灯具：3D 图层不会清理上一栋楼的绑定。
 */
function sample3dPeak(page, bldId, ms = 1800) {
  return page.evaluate(async ({ ms, bldId }) => {
    const s = window.__demo.store
    const em = window.__dtwin && window.__dtwin.em
    if (!em) return null
    const want = new Set((s.devices || []).filter(Boolean)
      .filter((d) => String(d.buildingId) === String(bldId))
      .map((d) => String(d.id)))
    const ids = [...em.emMap.keys()].filter((id) => want.has(String(id))).slice(0, 10)
    const peak = {}
    const t0 = performance.now()
    while (performance.now() - t0 < ms) {
      ids.forEach((id) => {
        const rec = em.emMap.get(id)
        if (!rec) return
        const v = Math.max(
          rec.light ? rec.light.intensity : 0,
          rec.mesh ? rec.mesh.material.emissiveIntensity : 0,
        )
        peak[String(id)] = Math.max(peak[String(id)] || 0, v)
      })
      await new Promise((r) => requestAnimationFrame(r))
    }
    return { count: ids.length, peak }
  }, { ms, bldId })
}

/** 驱动 Element Plus 下拉：选中第 index 个 select 的指定文案 */
async function pickSelectOption(page, index, text) {
  await page.evaluate((i) => {
    const sel = document.querySelectorAll('.device-selector .el-select')[i]
    if (!sel) return false
    const trigger = sel.querySelector('.el-select__wrapper') || sel.querySelector('input') || sel
    ;['mousedown', 'mouseup', 'click'].forEach((t) => {
      trigger.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }))
    })
    return true
  }, index)
  await sleep(600)
  const r = await page.evaluate((t) => {
    const items = Array.from(document.querySelectorAll('.el-select-dropdown__item'))
      .filter((n) => n.offsetParent !== null)
    const hit = items.find((n) => (n.textContent || '').trim() === t)
    if (!hit) {
      return { ok: false, candidates: items.map((n) => (n.textContent || '').trim()).slice(0, 10) }
    }
    ;['mousedown', 'mouseup', 'click'].forEach((ev) => {
      hit.dispatchEvent(new MouseEvent(ev, { bubbles: true, cancelable: true, view: window }))
    })
    return { ok: true }
  }, text)
  await sleep(800)
  return r
}

/** 打开智能照明页并读取「页面呈现的亮度 / 模式 / 选中设备」 */
async function readLightingView(page) {
  await page.evaluate(() => { window.location.hash = '#/lighting' })
  const ready = await waitFor(() => page.evaluate(
    () => Boolean(document.querySelector('.lighting-view'))
      && Boolean(document.querySelector('.device-selector'))
      && Boolean(document.querySelector('.brightness-value')),
  ), 30000)
  if (!ready) return { ready: false }
  await sleep(700)
  return page.evaluate(() => {
    const selText = (s) => {
      const t = (s.innerText || '').trim()
      if (t) return t
      const item = s.querySelector('.el-select__selected-item, .el-select__placeholder, input')
      return item ? (item.textContent || item.value || '').trim() : ''
    }
    const inputs = Array.from(document.querySelectorAll('.device-selector .el-select')).map(selText)
    const [bld, floor, devName] = inputs
    const root = document.querySelector('.lighting-view')
    const bText = (document.querySelector('.brightness-value') || {}).textContent || ''
    const mText = (document.querySelector('.header-status .status-tag') || {}).textContent || ''
    const sText = (document.querySelector('.device-info .status-tag') || {}).textContent || ''
    // 优先用页面自报的 data-device-id（真正驱动页面渲染的那台设备）
    const domId = root ? String(root.getAttribute('data-device-id') || '') : ''
    const all = (window.__demo.store.devices || []).filter(Boolean)
    const dev = (domId && all.find((d) => String(d.id) === domId))
      || all.find((d) => d.name === devName && d.building === bld && d.floor === floor
        && (d.type === 'emergency_light' || d.type === 'evacuation_light'))
    return {
      ready: true,
      building: bld, floor, devName,
      domId,
      brightnessShown: Number((bText.match(/-?\d+/) || [null])[0]),
      modeShown: (mText || '').trim(),
      statusShown: (sText || '').trim(),
      domBrightness: root ? Number(root.getAttribute('data-brightness')) : null,
      domMode: root ? String(root.getAttribute('data-mode') || '') : null,
      authId: dev ? String(dev.id) : null,
      auth: dev ? {
        status: String(dev.status),
        currentMode: String(dev.currentMode),
        brightness: Number(dev.brightness),
        emergencyFlash: !!dev.emergencyFlash,
      } : null,
      // store 侧的聚合镜像（B4-03 之后它只是设备镜像，不再是运行态来源）
      aggregate: {
        brightness: Number(window.__demo.store.lightingStatus?.brightness),
        mode: String(window.__demo.store.lightingStatus?.mode ?? ''),
      },
    }
  })
}

const MODE_LABEL = { daily: '日常节能', induction: '人员感应增强', emergency: '应急照明' }
const STATUS_LABEL = { normal: '在线', offline: '离线', emergency: '应急', warning: '异常' }

;(async () => {
  await resetDemoSession()
  const { browser, page } = await openPage()
  const pageErrors = []
  page.on('pageerror', (e) => pageErrors.push(String(e.message).slice(0, 160)))

  try {
    await openDemoPanel(page)

    // ═══ 基线：IDLE 下先把 3D 绑定到火情楼栋（用于 T3 方向收敛） ═══
    console.log('\n[基线] IDLE：2D / 3D 聚焦 B003 5F（3D 在 IDLE 完成绑定）')
    await gotoBuildingPage(page)
    await focusBuilding(page, FIRE_BLD, FIRE_FLOOR)
    const idle = await page.evaluate(readRuntime)
    check('基线 3D 已绑定火情楼栋灯具', idle.d3.length > 0,
      { d3: idle.d3.length, authLightTotal: idle.authLightTotal })
    const dirIdle = idle.d3.filter((x) => x.kind === 'evacuation_light')
    const dirIdleBad = dirIdle.filter((x) => x.dir && x.dir !== x.auth.direction)
    check('基线 T3-a IDLE 时 3D 箭头方向 === 权威 direction', dirIdleBad.length === 0,
      { checked: dirIdle.length, bad: dirIdleBad.slice(0, 3) })

    // ═══ 推进到应急联动（后端翻转 direction + 置 emergency/brightness=100/emergencyFlash） ═══
    console.log('\n[推进] START_FIRE → ACTIVATE_RESPONSE')
    await cmd('START_FIRE'); check('START_FIRE → FIRE_DETECTED', await waitStage(page, 'FIRE_DETECTED'))
    await cmd('ACTIVATE_RESPONSE'); check('ACTIVATE_RESPONSE → EMERGENCY_RESPONSE', await waitStage(page, 'EMERGENCY_RESPONSE'))
    await waitFor(() => page.evaluate(() => (window.__demo.demoStore.devices || [])
      .some((d) => d && d.emergencyFlash)), 20000)
    // ⚠ 这里故意「不重新聚焦」：3D 的绑定仍停留在 IDLE 时刻，
    //    若图层只在 bind 时读一次设备运行态，后端翻转的 direction 就永远不会到达 3D。
    await sleep(1500)

    // ═══ T1：3D 消费权威五字段 ═══
    console.log('\n[T1] 3D（EmergencyLight3D）必须消费权威设备的五个运行态字段')
    const run = await page.evaluate(readRuntime)
    check('T1 3D 已绑定灯具且数量有意义', run.d3.length >= 5, { d3: run.d3.length })
    check('T1 3D 每条记录都带有「实际消费到的运行态」（不是只读全局标志）',
      run.d3MissingRuntime === 0, { d3MissingRuntime: run.d3MissingRuntime, total: run.d3.length })
    check('T1 3D 消费到的运行态与权威 devices 五字段完全一致',
      run.d3RuntimeMismatch.length === 0, run.d3RuntimeMismatch.slice(0, 3))

    // ═══ T6：2D 平面图消费权威运行态 ═══
    console.log('\n[T6] 2D（BuildingView 平面图）必须消费权威设备的五个运行态字段')
    check('T6 平面图已渲染设备点位', run.d2Total > 0, { d2Total: run.d2Total })
    check('T6 2D 与 3D 聚焦的是同一栋楼（2D 点位全部属于权威楼栋）',
      run.d2NotInBuilding === 0, { d2NotInBuilding: run.d2NotInBuilding, bid: run.bid })
    check('T6 2D 点位带有「实际消费到的运行态」', run.d2MissingRuntime === 0,
      { d2MissingRuntime: run.d2MissingRuntime, d2Total: run.d2Total })
    check('T6 2D 点位的 status/currentMode/emergencyFlash/brightness/direction 与权威一致',
      run.d2Mismatch.length === 0, run.d2Mismatch.slice(0, 3))
    const emOnFloor = run.floorLights.filter((d) => d.emergency)
    check('T6 火情楼层确实存在应急态灯具（样本有意义）', emOnFloor.length > 0,
      { floorLights: run.floorLights.length, emergency: emOnFloor.length })

    // ═══ T3-b：后端翻转 direction 后 3D 必须收敛 ═══
    console.log('\n[T3-b] 后端翻转 direction 后 3D 箭头必须跟随权威')
    const dirNow = run.d3.filter((x) => x.kind === 'evacuation_light')
    const dirFlippedCount = dirNow.filter((x, i) => {
      const before = dirIdle.find((y) => y.id === x.id)
      return before && before.auth.direction !== x.auth.direction
    }).length
    check('T3-b 3D 箭头方向 === 权威 direction（翻转后）',
      run.d3DirMismatch.length === 0,
      { checked: dirNow.length, 后端翻转条数: dirFlippedCount, bad: run.d3DirMismatch.slice(0, 3) })

    // ═══ T2：3D 强闪只由设备 emergencyFlash 决定（非火情楼栋不得强闪） ═══
    console.log('\n[T2] 3D 应急强闪只能由设备自身 emergencyFlash 决定（全局 emergencyMode 不得污染）')
    await focusBuilding(page, OTHER_BLD, FIRE_FLOOR)
    const other = await page.evaluate(readRuntime)
    const otherPeakRaw = await sample3dPeak(page, OTHER_BLD)
    const otherAuthEmergency = other.floorLights.concat(other.d3.map((x) => x.auth))
      .filter((d) => d.emergencyFlash || d.status === 'emergency' || d.currentMode === 'emergency').length
    check('T2 非火情楼栋权威运行态为「非应急」',
      otherAuthEmergency === 0 && other.d3.length > 0,
      { otherAuthEmergency, d3: other.d3.length, bid: other.bid })
    const peaks = Object.values((otherPeakRaw && otherPeakRaw.peak) || {})
    const flashed = peaks.filter((v) => v >= FLASH_PEAK_MIN).length
    check('T2 非火情楼栋灯具不得呈现应急强闪（光强峰值 ≤ 1.5）',
      peaks.length > 0 && flashed === 0,
      { sampled: peaks.length, flashed, maxPeak: peaks.length ? Math.max(...peaks).toFixed(2) : null })

    // 火情楼栋必须强闪（正向对照）
    await focusBuilding(page, FIRE_BLD, FIRE_FLOOR)
    const firePeakRaw = await sample3dPeak(page, FIRE_BLD)
    const fPeaks = Object.values((firePeakRaw && firePeakRaw.peak) || {})
    check('T2 火情楼栋灯具必须呈现应急强闪（光强峰值 ≥ 2.0）',
      fPeaks.length > 0 && fPeaks.filter((v) => v >= FLASH_PEAK_MIN).length === fPeaks.length,
      { sampled: fPeaks.length, maxPeak: fPeaks.length ? Math.max(...fPeaks).toFixed(2) : null })

    // ═══ T7：RESET 后三端回到 daily ═══
    console.log('\n[T7] RESET：三端运行态同时回到 daily')
    await cmd('RESET'); await waitStage(page, 'IDLE')
    await sleep(1500)
    await focusBuilding(page, FIRE_BLD, FIRE_FLOOR)
    const rst = await page.evaluate(readRuntime)
    check('T7 RESET 后 3D 运行态仍与权威一致', rst.d3RuntimeMismatch.length === 0,
      rst.d3RuntimeMismatch.slice(0, 3))
    check('T7 RESET 后 3D 箭头方向仍与权威一致', rst.d3DirMismatch.length === 0,
      rst.d3DirMismatch.slice(0, 3))
    check('T7 RESET 后 2D 运行态仍与权威一致',
      rst.d2MissingRuntime === 0 && rst.d2Mismatch.length === 0,
      { missing: rst.d2MissingRuntime, bad: rst.d2Mismatch.slice(0, 3) })
    const rstPeakRaw = await sample3dPeak(page, FIRE_BLD, 1200)
    const rPeaks = Object.values((rstPeakRaw && rstPeakRaw.peak) || {})
    check('T7 RESET 后 3D 不再强闪',
      rPeaks.length > 0 && rPeaks.every((v) => v <= FLASH_PEAK_MAX_CALM),
      { sampled: rPeaks.length, maxPeak: rPeaks.length ? Math.max(...rPeaks).toFixed(2) : null })
    check('T7 RESET 后权威灯具无应急残留',
      rst.floorLights.every((d) => !d.emergency),
      { residue: rst.floorLights.filter((d) => d.emergency).length })

    // ═══ T8：新一轮演练再次收敛 ═══
    console.log('\n[T8] 新一轮演练：三端运行态再次收敛')
    await cmd('START_FIRE'); await waitStage(page, 'FIRE_DETECTED')
    await cmd('ACTIVATE_RESPONSE'); await waitStage(page, 'EMERGENCY_RESPONSE')
    await waitFor(() => page.evaluate(() => (window.__demo.demoStore.devices || [])
      .some((d) => d && d.emergencyFlash)), 20000)
    await sleep(1500)
    await focusBuilding(page, FIRE_BLD, FIRE_FLOOR)
    const r2 = await page.evaluate(readRuntime)
    check('T8 新一轮 3D 运行态与权威一致', r2.d3RuntimeMismatch.length === 0,
      r2.d3RuntimeMismatch.slice(0, 3))
    check('T8 新一轮 2D 运行态与权威一致',
      r2.d2MissingRuntime === 0 && r2.d2Mismatch.length === 0,
      { missing: r2.d2MissingRuntime, bad: r2.d2Mismatch.slice(0, 3) })

    // ═══ T4 / T5 / T9：智能照明页（需切页，统一放在 3D / 2D 之后） ═══
    console.log('\n[T4] LightingView 呈现的亮度必须等于「当前选中的权威设备」')
    const lv1 = await readLightingView(page)
    check('T4 智能照明页已渲染', lv1.ready === true, lv1)
    check('T4 页面选中的设备能在权威 devices 中定位', Boolean(lv1.auth), lv1)
    check('T4 页面亮度 === 权威设备 brightness（不得是全局聚合值）',
      Boolean(lv1.auth) && lv1.brightnessShown === lv1.auth.brightness,
      { shown: lv1.brightnessShown, auth: lv1.auth, aggregate: lv1.aggregate, dev: lv1.devName })

    console.log('\n[T5] LightingView 呈现的模式必须等于「当前选中的权威设备」currentMode')
    const fireBldName = await page.evaluate((bid) => {
      const b = (window.__demo.store.buildings || []).find((x) => String(x.id) === String(bid))
      return b ? String(b.name) : ''
    }, FIRE_BLD)
    let lv2 = null
    if (fireBldName) {
      const picked = await pickSelectOption(page, 0, fireBldName)
      if (!picked.ok) console.log('  ℹ 楼栋下拉未能选中：' + JSON.stringify(picked))
      else {
        const pickedFloor = await pickSelectOption(page, 1, FIRE_FLOOR)
        if (!pickedFloor.ok) console.log('  ℹ 楼层下拉未能选中：' + JSON.stringify(pickedFloor))
        lv2 = await readLightingView(page)
      }
    }
    check('T5 已切换到火情楼栋的照明设备', Boolean(lv2 && lv2.auth && lv2.building === fireBldName),
      lv2 || { fireBldName })
    check('T5 权威设备处于应急态（样本有意义）',
      Boolean(lv2 && lv2.auth && lv2.auth.currentMode === 'emergency'),
      lv2 && lv2.auth)
    check('T5 页面模式 === 权威设备 currentMode 对应文案',
      Boolean(lv2 && lv2.auth) && lv2.modeShown === MODE_LABEL[lv2.auth.currentMode],
      { shown: lv2 && lv2.modeShown, want: lv2 && lv2.auth && MODE_LABEL[lv2.auth.currentMode], auth: lv2 && lv2.auth })
    check('T9 LightingView 自报运行态（data-*）与权威设备一致',
      Boolean(lv2 && lv2.auth) && lv2.domMode === lv2.auth.currentMode
        && lv2.domBrightness === lv2.auth.brightness,
      { domMode: lv2 && lv2.domMode, domBrightness: lv2 && lv2.domBrightness, auth: lv2 && lv2.auth })

    check('全程无未捕获页面异常', pageErrors.length === 0, pageErrors.slice(0, 3))
  } finally {
    await cmd('RESET').catch(() => {})
    await sleep(600)
    await browser.close()
    summary('P1.7.3-B4-03 专项回归（应急灯运行态三端统一）')
    process.exitCode = 0
  }
})()

/**
 * P1.7 第一阶段 · 演示全流程「游记式」记录脚本
 * ────────────────────────────────────────────────
 * 目的：用真实用户操作（DOM click）从「模拟火灾」一路走到「救援完成 + RESET」，
 *      把每一步的前后端证据打印出来，**不做任何断言、不判红**，先把断裂点暴露出来。
 *
 * 用法：
 *   1) demo 模式前端：set VITE_DATA_SOURCE=demo && npx vite --port 5199
 *   2) node worker/e2e-phase3-journey.cjs
 *
 * 环境变量：
 *   PAGE_URL / API_BASE / SESSION_ID   见 e2e-lib.cjs
 *   JOURNEY_ROUNDS=1|2                 跑几趟（默认 2，第二趟用于幂等对比）
 *   JOURNEY_TICK_WAIT=3000             疏散采样间隔
 *   JOURNEY_REPORT=0                   关闭 journey 报告 JSON 落盘
 */
const fs = require('fs')
const path = require('path')
const {
  PAGE_URL, sleep, waitFor, demoState, resetDemoSession,
  openPage, openDemoPanel, ensureTwinMounted, clickByText, clickFlowButton,
  clickPlanChip, clickInDialog, waitStage,
} = require('./e2e-lib.cjs')

const ROUNDS = Number(process.env.JOURNEY_ROUNDS || 2)
const TICK_WAIT = Number(process.env.JOURNEY_TICK_WAIT || 3000)
const REPORT_FILE = path.resolve(process.cwd(), 'worker/.journey-report.json')
const WRITE_REPORT = process.env.JOURNEY_REPORT !== '0'

const T0 = Date.now()
const rows = []
const breaks = []
let page = null
let prevPos = null // 上一次采样的「人员 id → 坐标/进度」，用于位移 / 跳变 / 逆行观测

/** 与上一步采样比：谁动了、最大位移多少（穿墙/跳变的间接证据）、有没有倒退 */
function compareMovement(cur, intervalMs) {
  const map = new Map((cur || []).map(([id, x, z, pg]) => [id, { x, z, pg }]))
  if (!prevPos) { prevPos = map; return null }
  let moved = 0, back = 0, maxD = 0, maxId = '-', maxFrom = null, maxTo = null
  prevPos.forEach((v, id) => {
    const c = map.get(id)
    if (!c) return
    const d = Math.hypot(c.x - v.x, c.z - v.z)
    if (d > 1e-6) moved++
    if (typeof c.pg === 'number' && typeof v.pg === 'number' && c.pg < v.pg - 1e-9) back++
    if (d > maxD) { maxD = d; maxId = id; maxFrom = [v.x, v.z]; maxTo = [c.x, c.z] }
  })
  const newCount = cur.filter(([id]) => !prevPos.has(id)).length
  prevPos = map
  return { moved, back, maxD: Math.round(maxD * 1000) / 1000, maxId, maxFrom, maxTo, newCount, intervalMs }
}

// ─────────────────────────── 采集 ───────────────────────────
async function collectFrontend() {
  return page.evaluate(() => {
    const tally = (list) => list.reduce((m, k) => { m[k] = (m[k] || 0) + 1; return m }, {})
    const text = (sel) => { const e = document.querySelector(sel); return e ? (e.textContent || '').trim() : null }
    const demo = window.__demo.demoStore
    const store = window.__demo.store
    const ps = demo.persons || []
    const ds = demo.devices || []
    const sps = store.persons || []
    // 位置指纹：同一时刻快照求和，跨采样比较可发现「灯具/人员位置抖动」「人员跳变」
    const posFP = (arr) => {
      let acc = 0
      arr.forEach((p) => {
        const q = p.position || p.pos || {}
        acc += Math.round(((q.x || 0) * 31 + (q.z || 0) * 17 + (q.y || 0) * 7) * 100) / 100
      })
      return Math.round(acc * 100) / 100
    }
    const backIds = ps.map((p) => String(p.id))
    const storeIds = sps.map((p) => String(p.id))
    const setB = new Set(backIds)
    const setS = new Set(storeIds)
    const bps = store.buildingEvacuationPlans || []
    return {
      ws: demo.wsStatus,
      stage: demo.stage,
      stageIndex: demo.stageIndex,
      legacyStage: store.emergencyStage,
      nextCommand: demo.nextCommand,
      allowed: demo.allowedCommands || [],
      demoError: text('.demo-error'),
      fire: demo.fire ? [demo.fire.buildingId, demo.fire.floorId, demo.fire.zone].join('/') : null,
      storeFire: store.fireEvent ? { id: store.fireEvent.id, status: store.fireEvent.status } : null,
      plans: (demo.buildingPlans || []).map((p) => p.id),
      selectedPlanId: demo.selectedPlanId,
      activePlanId: demo.activeBuildingPlanId,
      scope: store.evacuationScope || null,
      metrics: demo.metrics || {},
      // ── B. 前端 Store ──
      storeFire: store.fireEvent ? { buildingId: store.fireEvent.buildingId, floorId: store.fireEvent.floorId, zone: store.fireEvent.zone, status: store.fireEvent.status } : null,
      storeFlags: {
        alert: Boolean(store.fireAlertVisible), confirmed: Boolean(store.fireConfirmed),
        respConfirmed: Boolean(store.emergencyResponseConfirmed), routeConfirmed: Boolean(store.routeDecisionConfirmed),
      },
      selectedBuildingId: String((store.dashboardView || {}).selectedBuildingId || ''),
      routeBuildingId: store.routeBuildingId || null,
      routePlans: {
        count: (store.routePlans || []).length,
        buildingPlanIds: [...new Set((store.routePlans || []).map((p) => p.buildingPlanId || null))],
      },
      buildingPlansDetail: bps.map((p) => ({
        id: p.id, buildingId: p.buildingId || null, strategy: p.strategy || null,
        routes: (p.routes || []).length,
        routeBuildingIds: [...new Set((p.routes || []).map((r) => r.buildingId || null))],
        zoneCount: p.summary ? p.summary.zoneCount : null,
        personCount: p.summary ? p.summary.personCount : null,
      })),
      activePlan: store.activeBuildingPlan ? {
        id: store.activeBuildingPlan.id, buildingId: store.activeBuildingPlan.buildingId || null,
        strategy: store.activeBuildingPlan.strategy || null, routes: (store.activeBuildingPlan.routes || []).length,
      } : null,
      evacRun: store.evacRun ? { running: Boolean(store.evacRun.running), keys: Object.keys(store.evacRun) } : null,
      evacPct: store.evacStats ? store.evacStats.pct : null,
      strandedList: (store.strandedPersons || []).map((p) => `${p.id}@${p.building}/${p.floorId || p.floor}/${p.zone}:${p.status}`),
      rescueTask: store.rescueTask ? { id: store.rescueTask.id, status: store.rescueTask.status } : null,
      logs: {
        count: (store.operationLogs || []).length,
        last: (store.operationLogs || []).slice(0, 4).map((l) => `${l.action}|${l.module}`),
      },
      // ── C/D. 2D 人员 vs 后端人员；位置指纹（抖动/跳变检测） ──
      persons2d: { total: sps.length, byStatus: tally(sps.map((p) => p.status || 'unknown')) },
      personDiff: {
        onlyBackend: backIds.filter((i) => !setS.has(i)).slice(0, 5),
        onlyStore: storeIds.filter((i) => !setB.has(i)).slice(0, 5),
        counts: [backIds.length, storeIds.length],
      },
      personFP: posFP(ps),
      posDetail: ps.map((p) => {
        const q = p.position || p.pos || {}
        return [String(p.id), q.x || 0, q.z || 0, p.progress ?? null, p.floorId || null]
      }),
      deviceFP: posFP(ds),
      persons: {
        total: ps.length,
        byStatus: tally(ps.map((p) => p.status || 'unknown')),
        withRoutePoints: ps.filter((p) => Array.isArray(p.routePoints) && p.routePoints.length > 1).length,
        sample: ps.slice(0, 3).map((p) => `${p.id}:${p.status}:${p.progress ?? '-'}`),
      },
      devices: {
        total: ds.length,
        byMode: tally(ds.map((d) => d.currentMode || d.status || 'unknown')),
        flash: ds.filter((d) => d.emergencyFlash).length,
        hasPos: ds.filter((d) => d.position || d.pos).length,
        directions: tally(ds.filter((d) => d.type === 'evacuation_light').map((d) => d.direction || 'none')),
      },
      ui: {
        panel: Boolean(document.querySelector('.demo-panel')),
        demoMode: Boolean(store.demoMode),
        flowBtn: text('.demo-panel .demo-btn.demo-flow'),
        planChips: Array.from(document.querySelectorAll('.demo-panel .plan-chip')).map((e) => (e.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 28)),
        planPicker: Boolean(document.querySelector('.demo-panel .plan-picker')),
        steps: Array.from(document.querySelectorAll('.demo-panel .flow-step')).map((e) => `${(e.querySelector('.step-name') || {}).textContent || '?'}:${e.className.includes('done') ? 'D' : e.className.includes('processing') ? 'P' : '-'}`),
        dialogs: Array.from(document.querySelectorAll('.biz-dialog-title')).map((e) => (e.textContent || '').trim()),
        fipPanel: Boolean(document.querySelector('.fip-alert')),
        progress: text('.demo-panel .el-progress__text'),
        stranded: (store.strandedPersons || []).length,
        rescueState: Boolean(store.rescueState),
        rescueCompleted: Boolean(store.rescueCompleted),
        fireAlertVisible: Boolean(store.fireAlertVisible),
        fireConfirmed: Boolean(store.fireConfirmed),
      },
      twin: (() => {
        const w = window.__dtwin
        if (!w || !w.scene || !w.scene.renderer) return { mounted: false }
        const pd = (w.persons && w.persons.data ? w.persons.data.filter(Boolean) : [])
        return {
          mounted: Boolean(w.scene.renderer.domElement.isConnected),
          persons: pd.length,
          personSample: pd.slice(0, 3).map((d) => `${d.id}:${String(d.routeKey || '').slice(0, 18)}:${(d.pts || []).length}`),
          route: w.route ? { visible: Boolean(w.route.group.visible), planId: w.route.currentPlanId || null, curves: (w.route.activeCurves || []).length } : null,
          fire: w.fire ? { visible: Boolean(w.fire.group.visible), floorId: w.fire.activeFloorId || null, zone: w.fire.activeZone || null } : null,
          rescue: w.rescue ? { visible: Boolean(w.rescue.group.visible), active: Boolean(w.rescue.active) } : null,
        }
      })(),
    }
  })
}

async function collectBackend() {
  try {
    const s = await demoState()
    const ps = s.persons || []
    const tally = (list) => list.reduce((m, k) => { m[k] = (m[k] || 0) + 1; return m }, {})
    return {
      stage: s.stage, seq: s.seq, tick: s.tick,
      activeBuildingPlanId: s.activeBuildingPlanId || null,
      plans: (s.buildingPlans || []).map((p) => p.id),
      fire: s.fire ? [s.fire.buildingId, s.fire.floorId, s.fire.zone].join('/') : null,
      metrics: s.metrics || {},
      personsByStatus: tally(ps.map((p) => p.status || 'unknown')),
      personsTotal: ps.length,
      lastEvents: (s.eventLog || []).slice(0, 3).map((e) => `${e.stage}/${e.action}`),
    }
  } catch (e) {
    return { error: e.message }
  }
}

async function snap() {
  return { fe: await collectFrontend(), be: await collectBackend() }
}

const shortBk = (b) => (b.error ? `ERR ${b.error}` : `${b.stage} seq=${b.seq} tick=${b.tick} persons=${b.personsTotal} ${JSON.stringify(b.personsByStatus)}`)

async function record(label, before, clickInfo, moved, expect) {
  await sleep(350) // 让 WS 广播先落一遍
  const after = await snap()
  const row = {
    label, t: Date.now() - T0, click: clickInfo, moved, expect,
    before: before.fe, after: before.fe === after.fe ? null : before.fe,
    fe: after.fe, be: after.be,
  }
  rows.push(row)
  const fe = after.fe
  console.log(`\n── ${label} ${'─'.repeat(Math.max(2, 56 - label.length))}`)
  if (clickInfo) console.log(`   点击   ${clickInfo.ok ? JSON.stringify(clickInfo.label || clickInfo) : '失败 → ' + JSON.stringify(clickInfo)}`)
  console.log(`   等待   ${moved.changed ? `${before.fe.stage} → ${fe.stage}（${moved.waitedMs}ms）` : `阶段未变化（${fe.stage}，${moved.waitedMs}ms，${moved.reason || '超时'}）`}`)
  console.log(`   后端   ${shortBk(after.be)}`)
  console.log(`   指标   ${JSON.stringify(fe.metrics)}  疏散进度=${fe.evacPct}%`)
  console.log(`   人员   total=${fe.persons.total} ${JSON.stringify(fe.persons.byStatus)} 有路线=${fe.persons.withRoutePoints} 位置指纹=${fe.personFP}`)
  console.log(`   2D/后端 persons2d=${fe.persons2d.total} ${JSON.stringify(fe.persons2d.byStatus)} id差=${JSON.stringify(fe.personDiff.counts)} 仅后端=${JSON.stringify(fe.personDiff.onlyBackend)} 仅store=${JSON.stringify(fe.personDiff.onlyStore)}`)
  const mv = compareMovement(fe.posDetail, moved.waitedMs)
  if (mv) console.log(`   移动   间隔=${mv.intervalMs}ms 位移人数=${mv.moved} 最大位移=${mv.maxD}（${mv.maxId} ${JSON.stringify(mv.maxFrom)}→${JSON.stringify(mv.maxTo)}） 进度倒退=${mv.back} 新增=${mv.newCount}`)
  console.log(`   设备   total=${fe.devices.total} ${JSON.stringify(fe.devices.byMode)} 强闪=${fe.devices.flash} 有坐标=${fe.devices.hasPos} 方向=${JSON.stringify(fe.devices.directions)} 位置指纹=${fe.deviceFP}`)
  console.log(`   方案   ${JSON.stringify(fe.plans)} selected=${fe.selectedPlanId} active=${fe.activePlanId} scope=${fe.scope}`)
  console.log(`         细则=${JSON.stringify(fe.buildingPlansDetail)}`)
  console.log(`         activePlan=${JSON.stringify(fe.activePlan)} routePlans=${JSON.stringify(fe.routePlans)} routeBuildingId=${fe.routeBuildingId}`)
  console.log(`   Store  fire=${JSON.stringify(fe.storeFire)} flags=${JSON.stringify(fe.storeFlags)} 当前楼栋=${fe.selectedBuildingId}`)
  console.log(`         evacRun=${JSON.stringify(fe.evacRun)} 滞留=${JSON.stringify(fe.strandedList)} rescueTask=${JSON.stringify(fe.rescueTask)}`)
  console.log(`   日志   ${fe.logs.count} 条 最近=${JSON.stringify(fe.logs.last)}`)
  console.log(`   UI     按钮=${fe.ui.flowBtn}  弹窗=${JSON.stringify(fe.ui.dialogs)}  chips=${fe.ui.planChips.length}  进度=${fe.ui.progress}  火警面板=${fe.ui.fipPanel}`)
  console.log(`         步骤=${JSON.stringify(fe.ui.steps)}`)
  console.log(`         滞留=${fe.ui.stranded} 救援=${fe.ui.rescueState}/${fe.ui.rescueCompleted} 火警弹窗=${fe.ui.fireAlertVisible} 已确认火情=${fe.ui.fireConfirmed}`)
  console.log(`   3D     ${JSON.stringify(fe.twin)}`)
  if (fe.demoError) console.log(`   ⚠ 前端报错 ${fe.demoError}`)

  // ── 断裂点观察（只记录，不判红）──
  if (clickInfo && clickInfo.ok === false) {
    breaks.push(`${label}：UI 上找不到该操作入口 → ${clickInfo.reason}`)
  }
  if (expect && expect !== fe.stage) {
    breaks.push(`${label}：预期阶段 ${expect}，实际停在 ${fe.stage}`)
  }
  if (fe.demoError) {
    breaks.push(`${label}：前端显式报错「${fe.demoError}」`)
  }
  return row
}

async function waitStageChange(beforeStage, timeout = 12000) {
  const t0 = Date.now()
  let cur = beforeStage
  while (Date.now() - t0 < timeout) {
    cur = await page.evaluate(() => window.__demo.demoStore.stage)
    if (cur !== beforeStage) return { changed: true, newStage: cur, waitedMs: Date.now() - t0 }
    await sleep(250)
  }
  return { changed: false, newStage: cur, waitedMs: Date.now() - t0, reason: '超时未收到阶段变化' }
}

/** 执行一次用户操作并记账 */
async function step(label, action, { expect = null, timeout = 12000 } = {}) {
  const before = await snap()
  const clickInfo = action ? await action() : null
  const moved = await waitStageChange(before.fe.stage, timeout)
  return record(label, before, clickInfo, moved, expect)
}

/** 纯采样（不点击） */
async function sample(label, waitMs) {
  const before = await snap()
  await sleep(waitMs)
  return record(label, before, null, { changed: false, newStage: before.fe.stage, waitedMs: waitMs, reason: '仅采样' }, null)
}

// ─────────────────────────── J. RESET 干净态核对 ───────────────────────────
function printResetChecklist(baseIdx = 0) {
  const r = rows[rows.length - 1]
  const base = rows[baseIdx] || r
  const f = r.fe
  const items = [
    ['DO stage', 'IDLE', String(f.stage)],
    ['fire（WS）', 'null', String(f.fire)],
    ['fire（store）', 'null', String(f.storeFire)],
    ['activeBuildingPlanId', 'null', String(f.activePlanId)],
    ['activeBuildingPlan', 'null', String(f.activePlan)],
    ['routePlans', '0', String(f.routePlans.count)],
    ['routeBuildingId', String(base.fe.routeBuildingId), String(f.routeBuildingId)],
    ['evacRun', JSON.stringify(base.fe.evacRun), JSON.stringify(f.evacRun)],
    ['evacPct', String(base.fe.evacPct), String(f.evacPct)],
    ['strandedPersons', '0', String(f.ui.stranded)],
    ['rescue / completed', 'false/false', `${f.ui.rescueState}/${f.ui.rescueCompleted}`],
    ['rescueTask', 'null', String(f.rescueTask)],
    ['legacy emergencyStage', String(base.fe.legacyStage), String(f.legacyStage)],
    ['persons byStatus', JSON.stringify(base.fe.persons.byStatus), JSON.stringify(f.persons.byStatus)],
    ['persons routePoints', String(base.fe.persons.withRoutePoints), String(f.persons.withRoutePoints)],
    ['device modes', JSON.stringify(base.fe.devices.byMode), JSON.stringify(f.devices.byMode)],
    ['device 位置指纹', String(base.fe.deviceFP), String(f.deviceFP)],
    ['metrics', JSON.stringify(base.fe.metrics), JSON.stringify(f.metrics)],
    ['3D fire / route 可见', 'false/false', `${f.twin && f.twin.fire ? f.twin.fire.visible : '?'}/${f.twin && f.twin.route ? f.twin.route.visible : '?'}`],
    ['operationLogs 含复位记录', 'true', String((f.logs.last || []).some((x) => x.includes('重置') || x.includes('复位') || x.includes('解除')))],
  ]
  console.log('\n   ── J. RESET 干净初始状态核对（与本次第 00 步基线对比；观察，非断言）──')
  items.forEach(([k, exp, act]) => {
    const same = String(exp) === String(act)
    console.log(`   ${same ? '·' : '✗'} ${k.padEnd(22)} 期望=${exp}  实际=${act}`)
    if (!same) breaks.push(`RESET 残留：${k} 期望 ${exp}，实际 ${act}`)
  })
}

// ─────────────────────────── 一趟完整旅程 ───────────────────────────
async function runRound(n) {
  console.log(`\n${'='.repeat(64)}\n  第 ${n} 趟 · 完整演示流程（真实点击）\n${'='.repeat(64)}`)
  // 每趟开始前确保演示控制台可见（点「正常状态」等本地复位会把控制台关掉）
  await openDemoPanel(page)
  const panelState = await page.evaluate(() => ({ demoMode: Boolean(window.__demo.store.demoMode), panel: Boolean(document.querySelector('.demo-panel')) }))
  console.log(`  ℹ 控制台状态：${JSON.stringify(panelState)}`)
  const mark = []
  const S = async (label, action, opts) => { const r = await step(label, action, opts); mark.push({ label, ...pick(r) }); return r }

  await S('00 基线（进入页面后的初始状态）', null, { timeout: 1000 })
  const roundBase = rows.length - 1
  await S('01 模拟火灾', () => clickByText(page, '模拟火灾'), { expect: 'FIRE_DETECTED' })
  await S('02 查看火情（业务弹窗①）', () => clickInDialog(page, '发现火灾', '查看火情'), { timeout: 3000 })
  await sleep(1000) // 「确认火情」是查看火情后 800ms 自动弹出
  await S('03 确认火情（业务弹窗①b，任务书第 4 步）', () => clickInDialog(page, '确认火情', '确认火情'), { timeout: 3000 })
  await sleep(1000) // 「是否启动应急预案」是确认火情后 800ms 自动弹出
  // P1.7.2 / P1-04：业务弹窗必须驱动后端状态机 —— 这里强制要求后端落到 EMERGENCY_RESPONSE
  await S('04 启动应急预案（业务弹窗②）', () => clickInDialog(page, '是否启动应急预案', '启动应急预案'), { timeout: 3000, expect: 'EMERGENCY_RESPONSE' })
  await S('05 [A链] 演示控制台推进 → 疏散路径规划', () => clickFlowButton(page), { expect: 'ROUTE_PLANNING' })
  // P0-01 验证：查看火情后「发现火灾」弹窗不得再出现（连续 10s，期间 WS 快照会持续到来）
  const dlg = await sample('06 P0-01 弹窗残留监控（10s）', 10000)
  if ((dlg.fe.ui.dialogs || []).some((d) => d.includes('发现火灾'))) {
    breaks.push('P0-01 未修复：「发现火灾」弹窗在查看火情后仍被 WS 快照重新打开')
  } else {
    console.log('   ✓ P0-01：查看火情后 10s 内「发现火灾」弹窗未再出现')
  }
  await sample('07 查看 A/B/C 三套方案信息', 800)
  await S('08 选择方案（PLAN-B）', () => clickPlanChip(page, 1), { timeout: 3000 })
  // 11/12 查看 2D / 3D 疏散路线：先确保 3D 视图处于挂载态（可能需点「3D 模型」浮层）
  const mounted = await ensureTwinMounted(page)
  console.log(`   ℹ 3D 已挂载：${mounted}`)
  await sample('09 查看 2D / 3D 疏散路线', 2500)
  await S('10 确认当前疏散路径', () => clickFlowButton(page), { expect: 'SMART_EVACUATION' })
  await sample('11 疏散采样 t0+3s', TICK_WAIT)
  await sample('12 疏散采样 t0+6s', TICK_WAIT)
  await sample('13 疏散采样 t0+9s', TICK_WAIT)
  await S('14 [A链] 推进 → 滞留人员识别', () => clickFlowButton(page), { expect: 'RETAINED_PERSONS' })
  await sample('15 查看滞留人员位置', 1200)
  await S('16 [B链] 确认人员位置（楼层火处置面板）', () => clickByText(page, '确认人员位置', null, 'button'), { timeout: 3000 })
  await S('17 [B链] 启动应急协同救援（业务弹窗③）', () => clickInDialog(page, '启动应急协同救援', '启动应急协同救援'), { timeout: 3000 })
  await S('18 [A链] 推进 → 协同救援', () => clickFlowButton(page), { expect: 'RESCUE_COORDINATION' })
  await S('19 [A链] 推进 → 处置完成', () => clickFlowButton(page), { expect: 'COMPLETED' })
  await sample('20 救援完成后状态', 1200)
  // RESET：真实用户会先试「正常状态」，无效再试「停止重置」——两种都记录下来
  // P1-05：「正常状态」必须走后端 RESET，且不得关闭演示控制台
  const r21 = await S('21 RESET 尝试①「正常状态」', () => clickByText(page, '正常状态'), { expect: 'IDLE' })
  if (r21.fe.stage !== 'IDLE') {
    if (!r21.fe.ui.panel) {
      console.log('   ✗ P1-05：「正常状态」把演示控制台一并关掉了，用户必须重新打开才能继续操作')
      breaks.push('P1-05 未修复：「正常状态」关闭了演示控制台（demoMode=false）')
      await openDemoPanel(page)
    }
    await S('22 RESET 尝试②「停止重置」', () => clickByText(page, '停止重置'), { expect: 'IDLE' })
  } else if (!r21.fe.ui.panel) {
    console.log('   ✗ P1-05：RESET 生效但演示控制台被关掉了')
    breaks.push('P1-05：RESET 后演示控制台不可见')
  }
  await sample('24 RESET 后 3s 静置', 3000)
  printResetChecklist(roundBase)
  // 25：重新挂载 3D（真实用户会再打开「3D 模型」浮层），看残留是否会在这里被修正
  const remount = await ensureTwinMounted(page)
  console.log(`   ℹ 重新挂载 3D：${remount}`)
  await sample('25 重新打开 3D 后的场景状态', 2500)
  const tail = rows[rows.length - 1].fe
  console.log(`   ℹ 3D 残留检查：fire=${JSON.stringify(tail.twin && tail.twin.fire)} route=${JSON.stringify(tail.twin && tail.twin.route)} rescue=${JSON.stringify(tail.twin && tail.twin.rescue)}`)
  if (tail.twin && tail.twin.fire && tail.twin.fire.visible) breaks.push('RESET 并重新打开 3D 后，火灾区域仍然可见（未随 store.fireEvent=null 收敛）')
  if (tail.twin && tail.twin.route && tail.twin.route.visible) breaks.push('RESET 并重新打开 3D 后，疏散路线仍然可见（旧的 activeCurves / group.visible 未清理）')
  return mark
}

function pick(r) {
  const fe = r.fe
  return {
    stage: fe.stage, legacy: fe.legacyStage, expect: r.expect, ok: !r.expect || r.expect === fe.stage,
    personsTotal: fe.persons.total, byStatus: fe.persons.byStatus,
    evacuated: (fe.metrics || {}).evacuated, routePoints: fe.persons.withRoutePoints,
    devices: fe.devices.byMode, plans: fe.plans.length, active: fe.activePlanId,
    dialogs: fe.ui.dialogs, chips: fe.ui.planChips.length, stranded: fe.ui.stranded,
    rescue: `${fe.ui.rescueState}/${fe.ui.rescueCompleted}`,
  }
}

// ─────────────────────────── 主流程 ───────────────────────────
;(async () => {
  console.log(`\n=== P1.7 第一阶段 · 演示全流程旅程记录（${PAGE_URL}）===\n`)
  const ctx = await openPage()
  page = ctx.page
  const roundMarks = []

  try {
    const mode = await page.evaluate(() => window.__demo.dataSource.mode)
    console.log(`  ℹ 运行模式：${mode}`)
    await ensureTwinMounted(page)
    await openDemoPanel(page)
    console.log(`  ℹ 演示控制台已打开；测试隔离：确保会话从 IDLE 开始`)
    await resetDemoSession()

    for (let n = 1; n <= ROUNDS; n++) roundMarks.push(await runRound(n))

    // ── 旅程时间线 ──
    console.log(`\n${'='.repeat(64)}\n  时间线\n${'='.repeat(64)}`)
    console.log('  #  时间ms  阶段                  legacy  所得-over-预期            人数(撤离)  弹窗')
    rows.forEach((r, i) => {
      const ev = r.fe.metrics ? r.fe.metrics.evacuated : '-'
      console.log(`  ${String(i + 1).padStart(2)} ${String(r.t).padStart(6)}  ${String(r.fe.stage).padEnd(20)}  ${String(r.fe.legacyStage).padEnd(6)}  ${String(r.expect || '-').padEnd(24)}  ${r.fe.persons.total}(${ev})  ${JSON.stringify(r.fe.ui.dialogs)}`)
    })

    // ── 幂等对比 ──
    if (roundMarks.length >= 2) {
      console.log(`\n${'='.repeat(64)}\n  第 1 趟 vs 第 2 趟（幂等对比）\n${'='.repeat(64)}`)
      const [a, b] = [roundMarks[0], roundMarks[1]]
      const n = Math.max(a.length, b.length)
      for (let i = 0; i < n; i++) {
        const x = a[i], y = b[i]
        if (!x || !y) { console.log(`  ${i} 步骤缺失：${x ? '第2趟' : '第1趟'}缺少 ${(x || y).label}`); continue }
        const same = JSON.stringify({ ...x, t: 0 }) === JSON.stringify({ ...y, t: 0 })
        console.log(`  ${same ? '=' : '≠'} ${x.label}`)
        if (!same) {
          ;['stage', 'expect', 'ok', 'personsTotal', 'evacuated', 'routePoints', 'active', 'plans', 'dialogs', 'chips', 'stranded', 'rescue'].forEach((k) => {
            if (JSON.stringify(x[k]) !== JSON.stringify(y[k])) {
              console.log(`      ${k}: 第1趟=${JSON.stringify(x[k])}  第2趟=${JSON.stringify(y[k])}`)
            }
          })
        }
      }
    }

    // ── 断裂点清单 ──
    console.log(`\n${'='.repeat(64)}\n  断裂点清单（观察记录，非失败判定）\n${'='.repeat(64)}`)
    if (!breaks.length) console.log('  （无）')
    else breaks.forEach((b, i) => console.log(`  ${i + 1}. ${b}`))

    const errs = ctx.logs.filter((l) => l.startsWith('[error]') || l.startsWith('[pageerror]'))
    console.log(`\n  控制台错误 / 未捕获异常：${errs.length} 条`)
    errs.slice(0, 12).forEach((l) => console.log(`    ${l.slice(0, 200)}`))

    if (WRITE_REPORT) {
      fs.writeFileSync(REPORT_FILE, JSON.stringify({ startedAt: new Date(T0).toISOString(), rows, breaks, errors: errs }, null, 2), 'utf8')
      console.log(`\n  ℹ 报告已写入 ${REPORT_FILE}`)
    }
  } catch (e) {
    console.log(`\n⚠ 旅程中断：${e.stack || e.message}`)
    if (WRITE_REPORT) {
      fs.writeFileSync(REPORT_FILE, JSON.stringify({ startedAt: new Date(T0).toISOString(), rows, breaks, fatal: String(e.stack || e.message) }, null, 2), 'utf8')
      console.log(`  ℹ 已尽力写入 ${REPORT_FILE}`)
    }
    process.exitCode = 1
  } finally {
    try { await resetDemoSession() } catch (e) { console.log(`⚠ 复位失败：${e.message}`) }
    await ctx.browser.close()
  }
})()

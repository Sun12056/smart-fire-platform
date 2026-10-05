/**
 * P1.7.2 第二批 · P1-03 调查脚本（只读 + 真实点击）
 * 目的：查明「确认滞留人员位置」业务入口在 UI 上是否可达。
 * 运行：npm run test:e2e:retention
 */
const {
  PAGE_URL, SESSION_ID,
  sleep, openPage, openDemoPanel, clickByText, clickFlowButton, clickInDialog,
  clickPlanChip, waitStage, resetDemoSession,
} = require('./e2e-lib.cjs')

function VIEW_PROBE() {
  const has = (s) => Boolean(document.querySelector(s))
  return {
    view: has('.building-overview') ? 'buildings(3D总览)'
      : has('.expanded-head') ? 'floorplan(内联楼层)'
        : has('.floor-grid') ? 'floors(六层总览)' : 'unknown',
    fipPanel: has('.fip-alert'),
    fipBtns: Array.from(document.querySelectorAll('.fip-clear-btn')).map((b) => (b.textContent || '').trim()),
    confirmBtnInPage: Array.from(document.querySelectorAll('button')).filter((b) => (b.textContent || '').includes('确认人员位置')).length,
    stage: window.__demo.demoStore.stage,
    legacyStage: window.__demo.store.emergencyStage,
    stranded: (window.__demo.store.strandedPersons || []).length,
  }
}

async function dump(page, label) {
  const v = await page.evaluate(VIEW_PROBE)
  console.log(`  [${label}] view=${v.view} fip=${v.fipPanel} 确认人员位置按钮=${v.confirmBtnInPage} fipButtons=${JSON.stringify(v.fipBtns)} stage=${v.stage}/legacy=${v.legacyStage} 滞留=${v.stranded}`)
  return v
}

async function main() {
  console.log(`\n  P1-03 调查：滞留人员入口可达性  PAGE_URL=${PAGE_URL} SESSION=${SESSION_ID}`)
  const { browser, page, logs } = await openPage()
  try {
    await openDemoPanel(page)
    await dump(page, '00 初始')
    await clickByText(page, '模拟火灾')
    await waitStage(page, 'FIRE_DETECTED')
    await sleep(400)
    await clickInDialog(page, '发现火灾', '查看火情')
    await sleep(1200)
    await clickInDialog(page, '确认火情', '确认火情')
    await sleep(1200)
    await clickInDialog(page, '是否启动应急预案', '启动应急预案')
    await waitStage(page, 'EMERGENCY_RESPONSE')
    await sleep(300)
    await dump(page, '02 EMERGENCY_RESPONSE')
    await clickFlowButton(page)
    await waitStage(page, 'ROUTE_PLANNING')
    await clickPlanChip(page, 1)
    await sleep(400)
    await dump(page, '03 ROUTE_PLANNING')
    await clickFlowButton(page)
    await waitStage(page, 'SMART_EVACUATION')
    await sleep(1500)
    await dump(page, '04 SMART_EVACUATION')
    await clickFlowButton(page)
    await waitStage(page, 'RETAINED_PERSONS', 30000)
    await sleep(1200)
    const v = await dump(page, '05 RETAINED_PERSONS')
    console.log('  STAGE5_ROW=' + JSON.stringify(v))
    if (v.confirmBtnInPage === 0) {
      const nav = await page.evaluate(() => {
        const chip = Array.from(document.querySelectorAll('.floor-chip')).find((x) => (x.textContent || '').trim() === '5F')
        if (chip) { chip.click(); return 'floor-chip:5F' }
        const card = Array.from(document.querySelectorAll('.floor-card')).find((x) => (x.textContent || '').includes('5F'))
        if (card) { card.click(); return 'floor-card:5F' }
        return null
      })
      console.log(`  手动导航回火警楼层：${nav || '未找到任何楼层入口'}`)
      await sleep(900)
      await dump(page, '05b 手动导航后')
    }
    const clicked = await clickByText(page, '确认人员位置', null, 'button')
    console.log(`  点击「确认人员位置」：${JSON.stringify(clicked)}`)
    await sleep(900)
    const dlg = await page.evaluate(() => Array.from(document.querySelectorAll('.biz-dialog-title')).map((e) => (e.textContent || '').trim()))
    console.log(`  业务弹窗③：${JSON.stringify(dlg)}`)
    const go = await clickInDialog(page, '启动应急协同救援', '启动应急协同救援')
    await waitStage(page, 'RESCUE_COORDINATION', 15000)
    const st = await page.evaluate(() => window.__demo.demoStore.stage)
    console.log(`  弹窗③点击=${JSON.stringify(go)} → 后端 stage=${st}`)
    await dump(page, '06 RESCUE_COORDINATION')

    // 阶段6 → 启动消防救援协同（FIP面板）→ COMPLETED
    const dr = await clickByText(page, '启动消防救援协同', null, 'button')
    await waitStage(page, 'COMPLETED', 15000)
    console.log(`  点击「启动消防救援协同」=${JSON.stringify(dr)} → ${await page.evaluate(() => window.__demo.demoStore.stage)}`)

    // P2-03：打开后台日志页，检查能否看到 demo 六阶段权威记录
    const nav = await page.evaluate(() => {
      const a = document.querySelector('.side-nav a[href$="/emergency"]')
      if (!a) return { ok: false, reason: '侧边导航未找到后台日志入口' }
      a.click()
      return { ok: true, label: (a.textContent || '').trim() }
    })
    console.log(`  导航到后台日志页：${JSON.stringify(nav)}`)
    await page.waitForSelector('.log-header', { timeout: 15000 }).catch(() => {})
    await sleep(1500)
    console.log(`  当前 URL=${page.url()}`)
    const logView = await page.evaluate(() => ({
      count: document.querySelectorAll('.log-entry').length,
      actions: Array.from(document.querySelectorAll('.log-entry')).map((e) => ((e.querySelector('.log-action') || {}).textContent || '').trim()).slice(0, 24),
      modules: Array.from(document.querySelectorAll('.log-entry')).map((e) => ((e.querySelector('.log-module') || {}).textContent || '').trim()).slice(0, 24),
    }))
    console.log(`  后台日志页：渲染 ${logView.count} 条`)
    console.log(`  前 24 条 action：${JSON.stringify(logView.actions)}`)
    const need = ['发现火灾', '启动应急响应', '生成疏散方案', '确认疏散路径', '识别滞留人员', '确认滞留人员位置', '协同救援完成']
    const hit = need.filter((a) => logView.actions.includes(a))
    console.log(`  demo 六阶段记录命中 ${hit.length}/${need.length}：${JSON.stringify(hit)}  缺失=${JSON.stringify(need.filter((a) => !hit.includes(a)))}`)
    console.log(`  控制台错误 ${logs.length} 条（仅供人工查看）`)
  } finally {
    await browser.close()
    await resetDemoSession()
  }
}

main().catch((e) => { console.error('执行失败：', e); process.exit(1) })

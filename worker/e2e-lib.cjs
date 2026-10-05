/**
 * E2E 公共工具（worker/e2e-lib.cjs）
 * ────────────────────────────────────────────────
 * 抽取自 worker/e2e-phase2-browser.cjs 的通用能力，供 P1.7 journey 类脚本复用。
 * 约定：
 *   • 现有三套脚本（e2e-phase2 / e2e-phase2-browser / e2e-phase2-consistency）保持原样，不在本轮改动范围；
 *   • 本文件只提供「驱动 + 读取」能力，业务判定留给各脚本自己写。
 *
 * 环境变量：
 *   PAGE_URL    前端地址（默认 http://localhost:5199/）
 *   API_BASE    后端地址（默认 http://127.0.0.1:8787）
 *   SESSION_ID  DO session（默认 default）
 */
const { chromium } = require('playwright-core')

const PAGE_URL = process.env.PAGE_URL || 'http://localhost:5199/'
const API_BASE = process.env.API_BASE || 'http://127.0.0.1:8787'
const SESSION_ID = process.env.SESSION_ID || 'default'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitFor(fn, timeout = 8000, interval = 250) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) { if (await fn()) return true; await sleep(interval) }
  return false
}

// ── 断言（需在其它脚本里做判红时使用；journey 记录脚本不调用） ──
const results = { passed: 0, failed: 0, failures: [] }
function check(name, cond, extra) {
  if (cond) { results.passed++; console.log(`  ✓ ${name}`) }
  else { results.failed++; results.failures.push(name); console.log(`  ✗ ${name}${extra !== undefined ? ' → ' + JSON.stringify(extra) : ''}`) }
  return Boolean(cond)
}
function summary(title) {
  console.log(`\n=== ${title}：${results.passed} 通过 / ${results.failed} 失败 ===`)
  if (results.failed) console.log('失败项：\n  - ' + results.failures.join('\n  - '))
  return results
}

// ── 后端统一调用入口（默认 session 的持久状态机：Durable Object） ──
async function api(path, init = {}) {
  const res = await fetch(`${API_BASE}${path}`, init)
  if (!res.ok) throw new Error(`请求 ${path} 失败：HTTP ${res.status}`)
  return res.json()
}
function unwrap(json) {
  // REST 有 { ok, body } 与裸结构两种形态，统一摊平
  if (json && typeof json === 'object' && json.body && typeof json.body === 'object') return json.body
  return json
}
async function cmd(command, payload = {}, sessionId = SESSION_ID) {
  return unwrap(await api(`/api/v1/demo/command?sessionId=${encodeURIComponent(sessionId)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ command, payload }),
  }))
}
async function demoState(sessionId = SESSION_ID) {
  return unwrap(await api(`/api/v1/demo/state?sessionId=${encodeURIComponent(sessionId)}`))
}

/**
 * 测试隔离：journey 脚本会把状态机推到目标阶段，DO session 持久存在，
 * 必须在 finally 中无条件检查并复位，否则污染后续测试套件。
 */
async function resetDemoSession(sessionId = SESSION_ID) {
  try {
    const st = await demoState(sessionId)
    if (st && st.stage === 'IDLE') {
      console.log('  ℹ 测试隔离：session 已处于 IDLE，无需复位')
      return true
    }
    const r = await cmd('RESET', {}, sessionId)
    await sleep(600)
    console.log(`  ℹ 测试隔离：session 已从 ${st && st.stage} 复位到 ${r && r.stage}`)
    return Boolean(r && r.stage === 'IDLE')
  } catch (e) {
    console.log(`  ⚠ 测试隔离失败：${e.message}`)
    return false
  }
}

// ── 浏览器 ──
async function openPage() {
  const browser = await chromium.launch({ channel: 'msedge', headless: true })
  const page = await browser.newPage()
  const logs = []
  page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`))
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`))
  await page.goto(PAGE_URL, { waitUntil: 'load', timeout: 60000 })
  await waitFor(() => page.evaluate(() => Boolean(window.__demo)), 30000)
  return { browser, page, logs }
}

async function openDemoPanel(page) {
  await page.evaluate(() => { if (!window.__demo.store.demoMode) window.__demo.store.toggleDemoMode() })
  await page.waitForSelector('.demo-panel', { timeout: 15000 })
}

/** 3D 按需挂载（DashboardView「3D 模型」浮层）：未挂载时 __dtwin 是不再更新的旧快照 */
async function ensureTwinMounted(page, timeout = 40000) {
  const mounted = () => page.evaluate(
    () => Boolean(window.__dtwin && window.__dtwin.scene && window.__dtwin.scene.renderer.domElement.isConnected),
  )
  if (await mounted()) return true
  await page.evaluate(() => { const b = document.querySelector('.open-3d-btn'); if (b) b.click() })
  return waitFor(mounted, timeout)
}

/**
 * 直接派发 DOM click（页面可能存在弹窗遮罩，避免 Playwright actionability 拦截）。
 * scope 传 null 表示在整个 document 里找。
 */
async function clickByText(page, text, scope = '.demo-panel', tags = 'button') {
  const r = await page.evaluate(({ t, s, g }) => {
    const root = s ? document.querySelector(s) : document
    if (!root) return { ok: false, reason: `未找到容器 ${s}` }
    const list = Array.from(root.querySelectorAll(g))
      .filter((b) => (b.textContent || '').includes(t))
    if (!list.length) return { ok: false, reason: `未找到含「${t}」的 ${g}`, candidates: Array.from(root.querySelectorAll(g)).map((b) => (b.textContent || '').trim().slice(0, 16)) }
    list[0].click()
    return { ok: true, label: (list[0].textContent || '').trim() }
  }, { t: text, s: scope, g: tags })
  return r
}

/** 点击演示控制台的流程推进按钮（文案会随阶段变化）；返回点击时的按钮文案 */
async function clickFlowButton(page) {
  return page.evaluate(() => {
    const b = document.querySelector('.demo-panel .demo-btn.demo-flow')
    if (!b) return { ok: false, reason: '未找到演示推进按钮' }
    const label = (b.textContent || '').trim()
    b.click()
    return { ok: true, label }
  })
}

/** 点击整栋楼方案 chip（index：0=A 1=B 2=C） */
async function clickPlanChip(page, index = 0) {
  return page.evaluate((i) => {
    const chips = Array.from(document.querySelectorAll('.demo-panel .plan-chip'))
    if (!chips.length) return { ok: false, reason: '未找到方案 chip' }
    const c = chips[i] || chips[0]
    const label = (c.textContent || '').trim()
    c.click()
    return { ok: true, label, count: chips.length }
  }, index)
}

/**
 * 点击业务弹窗里的按钮。
 * matchName：弹窗标题包含的关键字；matchBtn：按钮文案关键字（不传则取 primary/danger 优先的最后一个）。
 */
async function clickInDialog(page, matchName, matchBtn = null) {
  return page.evaluate(({ dlgName, btnName }) => {
    const dialogs = Array.from(document.querySelectorAll('.biz-dialog'))
    const dlg = dialogs.find((d) => ((d.querySelector('.biz-dialog-title') || {}).textContent || '').includes(dlgName))
    if (!dlg) {
      return { ok: false, reason: `未出现弹窗「${dlgName}」`, visibleDialogs: dialogs.map((d) => ((d.querySelector('.biz-dialog-title') || {}).textContent || '').trim()) }
    }
    const btns = Array.from(dlg.querySelectorAll('.biz-btn'))
    if (!btns.length) return { ok: false, reason: `弹窗「${dlgName}」没有可点按钮` }
    let target = btnName ? btns.find((b) => (b.textContent || '').includes(btnName)) : null
    if (!target) target = btns.find((b) => b.className.includes('primary')) || btns.find((b) => b.className.includes('danger')) || btns[btns.length - 1]
    const label = (target.textContent || '').trim()
    target.click()
    return { ok: true, label, allLabels: btns.map((b) => (b.textContent || '').trim()) }
  }, { dlgName: matchName, btnName: matchBtn })
}

/** 等待 demoStore.stage 变成目标阶段 */
async function waitStage(page, stage, timeout = 12000) {
  const t0 = Date.now()
  const ok = await waitFor(() => page.evaluate((s) => window.__demo.demoStore.stage === s, stage), timeout)
  return { ok, waitedMs: Date.now() - t0 }
}

module.exports = {
  PAGE_URL, API_BASE, SESSION_ID,
  sleep, waitFor, check, summary, results,
  api, cmd, demoState, resetDemoSession,
  openPage, openDemoPanel, ensureTwinMounted,
  clickByText, clickFlowButton, clickPlanChip, clickInDialog, waitStage,
}

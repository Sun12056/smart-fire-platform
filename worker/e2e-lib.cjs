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
const { performance: nodePerf } = require('node:perf_hooks')

/** 单调时钟源（WP-A3.3）：仅此处直接引用 performance，便于将来替换 */
const perfNow = () => nodePerf.now()

const PAGE_URL = process.env.PAGE_URL || 'http://localhost:5199/'
const API_BASE = process.env.API_BASE || 'http://127.0.0.1:8787'
const SESSION_ID = process.env.SESSION_ID || 'default'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ────────────────────────────────────────────────────────────────
// WP-A3.3：统一超时基础设施
//
// 设计要点：
//   • 全部使用单调时钟（performance.now），墙钟回拨不会延长等待；
//   • 超时只表示「不再等待」，**不代表底层操作已被取消** ——
//     page.evaluate 无法取消，超时后该次调用仍在页面内继续执行，
//     调用方必须在收到 EVAL_TIMEOUT 后立即终止本轮，不得复用其结果；
//   • api() 走 AbortController，超时会真正 abort 底层请求（与 evaluate 不同）；
//   • 所有被放弃的 Promise 都挂了消费回调，避免迟到 reject 变成 unhandledRejection。
// ────────────────────────────────────────────────────────────────

const DEFAULT_EVAL_TIMEOUT = 15000   // 单次 page.evaluate
const DEFAULT_CHECK_TIMEOUT = 5000   // waitFor 单次检查
const DEFAULT_API_TIMEOUT = 15000    // 单次 HTTP
const PAGE_READY_TIMEOUT = 30000     // 页面 window.__demo 就绪

/** 单调时钟（毫秒） */
const monoNow = () => perfNow()

function timeoutError(code, message, extra) {
  const err = new Error(message)
  err.code = code
  if (extra) Object.assign(err, extra)
  return err
}

/**
 * 给已有 Promise 套一个截止时间。
 * @param {Promise} promise 已发起的操作
 * @param {number} ms 超时毫秒
 * @param {string} code 超时错误码
 * @param {string} label 用于日志/错误文案
 */
function withDeadline(promise, ms, code, label) {
  const budget = Number(ms) > 0 ? Number(ms) : DEFAULT_EVAL_TIMEOUT
  let timer = null
  // 迟到结果必须被消费：既避免 unhandledRejection，也不影响已判定的超时
  Promise.resolve(promise).then(() => {}, () => {})
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(timeoutError(
        code,
        `${label} 超过 ${budget}ms 未返回；超时仅表示停止等待，底层操作并未被取消`,
        { timeoutMs: budget },
      ))
    }, budget)
  })
  return Promise.race([Promise.resolve(promise), guard]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

/**
 * 带超时的 page.evaluate。
 * @param {object} page Playwright page（只需具备 evaluate 方法，便于纯 Node 测试）
 * @param {Function|string} fn
 * @param {*} arg
 * @param {{timeoutMs?:number,label?:string}} options
 */
async function evaluateWithTimeout(page, fn, arg, options = {}) {
  const budget = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_EVAL_TIMEOUT
  const label = options.label || 'page.evaluate'
  if (!page || typeof page.evaluate !== 'function') {
    throw timeoutError('EVAL_NO_PAGE', `${label}: 传入的 page 无效（缺少 evaluate 方法）`)
  }
  let call
  try {
    call = arguments.length >= 3 ? page.evaluate(fn, arg) : page.evaluate(fn)
  } catch (e) {
    throw timeoutError('EVAL_FAILED', `${label} 同步抛错：${e && e.message ? e.message : e}`, { cause: e })
  }
  try {
    return await withDeadline(call, budget, 'EVAL_TIMEOUT', label)
  } catch (e) {
    if (e && e.code === 'EVAL_TIMEOUT') throw e
    throw timeoutError('EVAL_FAILED', `${label} 执行失败：${e && e.message ? e.message : e}`, { cause: e })
  }
}

/**
 * 给 page 安装一次 evaluate 超时守卫：此后**所有** page.evaluate（包括
 * 各脚本、以及 waitFor 回调内部的调用）都会自动受统一超时保护。
 * 幂等：重复安装不会叠加。
 */
function installEvalTimeout(page, options = {}) {
  if (!page || typeof page.evaluate !== 'function' || page.__evalTimeoutInstalled) return page
  const orig = page.evaluate.bind(page)
  const budget = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_EVAL_TIMEOUT
  const label = options.label || 'page.evaluate'
  function patchedEvaluate(fn, arg) {
    const call = arguments.length >= 2 ? orig(fn, arg) : orig(fn)
    return withDeadline(call, budget, 'EVAL_TIMEOUT', label)
  }
  // R-A：用 defineProperty 安装，enumerable:false ⇒ Object.keys(page) / for...in 不会
  // 看到被替换的 evaluate，尽量贴近「原型方法」的可观察语义；writable/configurable 保留
  // 以便再次替换或还原。
  Object.defineProperty(page, 'evaluate', {
    value: patchedEvaluate,
    enumerable: false,
    writable: true,
    configurable: true,
  })
  Object.defineProperty(page, '__evalTimeoutInstalled', { value: true, enumerable: false })
  return page
}

// R-C：单次检查阈值分层
const LONG_WAIT_THRESHOLD = 30000      // 视为「长等待」的整体预算下限
const LONG_WAIT_CHECK_TIMEOUT = 15000  // 长等待下单次检查上限

/**
 * 解析单次检查的超时预算（R-C 分层策略）。
 *
 * 依据（对 b401/b402/b403 + e2e-lib 共 27 处 waitFor 调用点的逐个审计）：
 *   • 绝大多数回调只做**一次** page.evaluate 读 store/DOM 字段，正常在毫秒级返回；
 *     对这些等待沿用 5s，保持「快速失败」——这正是 WP-A3.3 要解决的挂死场景。
 *   • 共 6 处使用 ≥30s 总预算：b401 `open3D`(45000)、b403 `waitFor(twinAlive, 40000)` ×2、
 *     b403 `readLightingView`(30000)、e2e-lib `openPage`(30000)、e2e-lib `ensureTwinMounted`(40000)。
 *     首帧渲染 / 着色器编译 / 页面就绪可能阻塞主线程数秒，5s 可能把「慢」误判为「挂死」，
 *     故放宽到 15s（其中 `openPage` 另显式传入 perCheckTimeout，取值同为 15s）。
 *   • 不使用「所有阈值统一放宽到 15s」的做法：其余 21 处短查询仍保持 5s。
 */
function resolvePerCheckTimeout(explicit, overallTimeout) {
  const e = Number(explicit)
  if (e > 0) return e
  const overall = Number(overallTimeout) || 0
  return overall >= LONG_WAIT_THRESHOLD ? LONG_WAIT_CHECK_TIMEOUT : DEFAULT_CHECK_TIMEOUT
}

/**
 * 轮询等待。双重约束：
 *   • 单次检查超时（perCheckTimeout）⇒ 抛 CHECK_TIMEOUT（页面已不可用，继续等只会再次挂起）
 *   • 整体截止时间（timeout）⇒ 返回 false（保持历史语义）
 */
async function waitFor(fn, timeout = 8000, interval = 250, options = {}) {
  const perCheck = resolvePerCheckTimeout(options.perCheckTimeout, timeout)
  const label = options.label || 'waitFor'
  const deadline = monoNow() + Math.max(0, Number(timeout) || 0)
  let attempts = 0
  for (;;) {
    const remaining = deadline - monoNow()
    if (!(remaining > 0)) return false
    attempts += 1
    const ok = await withDeadline(
      Promise.resolve().then(fn),
      Math.min(perCheck, remaining),
      'CHECK_TIMEOUT',
      `${label}（第 ${attempts} 次检查）`,
    )
    if (ok) return true
    const rest = deadline - monoNow()
    if (!(rest > 0)) return false
    await sleep(Math.min(interval, rest))
  }
}

// ── 断言（需在其它脚本里做判红时使用；journey 记录脚本不调用） ──
// WP-A3 / A3-1：断言台账与退出码判定统一由 e2e-exit.cjs 提供（零依赖，可单测）。
// summary() 在存在失败时会把 process.exitCode 提升为非零，且永不写回 0；
// 因此调用方不需要、也不允许再自行设置「成功」退出码。
const {
  createLedger, record, finalize, markFailure, exitCodeFor, safeCleanup,
  cleanupCheck: cleanupCheckBase, resetToIdle: resetToIdleBase,
} = require('./e2e-exit.cjs')

const results = createLedger()
function check(name, cond, extra) {
  return record(results, name, cond, extra)
}
function summary(title) {
  return finalize(results, title)
}
/**
 * WP-A3.2：清理入账的**公共接口** —— 绑定本模块的 results 台账。
 *
 * 底层 cleanupCheck(ledger, name, action, options) 需要 4 个参数；
 * b401 / b402 / b403 以 cleanupCheck(name, action) 两参调用。
 * 若直接导出底层函数，参数会整体左移（ledger 变成字符串），
 * 清理失败时 record() 会在 finally 中抛 TypeError，破坏清理链路
 * （WP-A3 浏览器 E2E 第 1 轮 P0 缺陷）。此处绑定后对外签名保持两参不变。
 */
function cleanupCheck(name, action, options = {}) {
  return cleanupCheckBase(results, name, action, options)
}

// ── 后端统一调用入口（默认 session 的持久状态机：Durable Object） ──
/**
 * WP-A3.3：带 AbortSignal 与超时的 HTTP 调用。
 * 与 page.evaluate 不同，这里超时会**真正 abort** 底层请求（取消，而非仅放弃等待）。
 * 兼容：旧调用方仍可传标准 fetch init；新增可选 timeoutMs / fetchImpl（后者仅测试注入）。
 */
async function api(path, init = {}) {
  const { timeoutMs, fetchImpl, signal: externalSignal, ...rest } = init
  const budget = Number(timeoutMs) > 0 ? Number(timeoutMs) : DEFAULT_API_TIMEOUT
  const doFetch = fetchImpl || fetch

  // R-B：调用方 signal 已 abort ⇒ 不发起请求，直接以中止错误失败
  if (externalSignal && externalSignal.aborted) {
    throw timeoutError('API_ABORTED', `请求 ${path} 未发出：调用方 signal 已处于 aborted 状态`, { path })
  }
  const controller = typeof AbortController === 'function' ? new AbortController() : null
  // R-B：同时尊重调用方 signal 与内部超时 signal —— 任一触发都取消请求。
  let signal
  if (controller && externalSignal) {
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function') {
      signal = AbortSignal.any([externalSignal, controller.signal])
    } else {
      // 兜底（无 AbortSignal.any）：把外部 abort 转发到内部 controller
      externalSignal.addEventListener('abort', () => controller.abort(externalSignal.reason), { once: true })
      signal = controller.signal
    }
  } else {
    signal = controller ? controller.signal : externalSignal
  }

  const request = Promise.resolve()
    .then(() => doFetch(`${API_BASE}${path}`, { ...rest, signal }))
    .then((res) => {
      if (!res.ok) throw new Error(`请求 ${path} 失败：HTTP ${res.status}`)
      return res.json()
    })
  // 迟到结果必须被消费，避免 unhandledRejection
  request.then(() => {}, () => {})
  let timer = null
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => {
      if (controller) controller.abort()
      reject(timeoutError('API_TIMEOUT', `请求 ${path} 超过 ${budget}ms 未完成（已 abort）`, {
        timeoutMs: budget, path,
      }))
    }, budget)
  })
  try {
    return await Promise.race([request, guard])
  } finally {
    if (timer) clearTimeout(timer)
  }
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

/**
 * WP-A3.1 / F-3：结束 RESET 的严格复位（绑定真实 transport）。
 * 与 resetDemoSession 的区别：会复读状态确认为 IDLE，失败一律抛错，
 * 由调用方用 cleanupCheck 记入台账并判红。
 */
function resetToIdle(sessionId = SESSION_ID, options = {}) {
  return resetToIdleBase({ demoState, cmd, sleep, sessionId, ...options })
}

// ── 浏览器 ──
/**
 * 打开页面并确认运行时就绪。
 * WP-A3.3：就绪失败必须**抛错并关闭浏览器**，绝不返回未就绪的 page
 * （旧实现返回 false 后脚本继续执行，会在后续 evaluate 处永久挂起）。
 * 同时在此安装 evaluate 超时守卫，使三个脚本的全部 page.evaluate 自动受保护。
 */
async function openPage(options = {}) {
  const readyTimeout = Number(options.readyTimeoutMs) > 0 ? Number(options.readyTimeoutMs) : PAGE_READY_TIMEOUT
  const browser = await chromium.launch({ channel: 'msedge', headless: true })
  try {
    const page = await browser.newPage()
    installEvalTimeout(page)
    const logs = []
    page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`))
    page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`))
    await page.goto(PAGE_URL, { waitUntil: 'load', timeout: 60000 })
    const ready = await waitFor(
      () => page.evaluate(() => Boolean(window.__demo)),
      readyTimeout,
      250,
      { label: '页面就绪 window.__demo', perCheckTimeout: DEFAULT_EVAL_TIMEOUT },
    )
    if (!ready) {
      throw timeoutError(
        'PAGE_NOT_READY',
        `页面在 ${readyTimeout}ms 内未就绪：window.__demo 不可用（${PAGE_URL}）`,
        { pageUrl: PAGE_URL },
      )
    }
    return { browser, page, logs }
  } catch (e) {
    // 就绪/导航失败：不得泄漏浏览器进程
    await safeCleanup('浏览器关闭（页面未就绪）', () => browser.close())
    throw e
  }
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
  // WP-A3 / A3-2：清理与退出码辅助（供各脚本在 finally / catch 中复用）
  markFailure, exitCodeFor, safeCleanup,
  // WP-A3.1：清理入账 + 严格复位
  cleanupCheck, resetToIdle,
  // WP-A3.3：统一超时机制
  monoNow, timeoutError, withDeadline, evaluateWithTimeout, installEvalTimeout,
  resolvePerCheckTimeout,
  DEFAULT_EVAL_TIMEOUT, DEFAULT_CHECK_TIMEOUT, DEFAULT_API_TIMEOUT, PAGE_READY_TIMEOUT,
  LONG_WAIT_THRESHOLD, LONG_WAIT_CHECK_TIMEOUT,
  api, cmd, demoState, resetDemoSession,
  openPage, openDemoPanel, ensureTwinMounted,
  clickByText, clickFlowButton, clickPlanChip, clickInDialog, waitStage,
}

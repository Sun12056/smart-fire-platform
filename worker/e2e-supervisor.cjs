'use strict'
/**
 * E2E 进程级 supervisor（WP-A3.3）
 * ────────────────────────────────────────────────
 * 职责（只做四件事，不含任何业务断言）：
 *   ① 以子进程方式运行一个 E2E 脚本，并施加**整体执行期限**；
 *   ② 超时后终止子进程**及其浏览器子孙进程**（进程树），避免 Edge / workerd 残留；
 *   ③ 子进程结束后，由**父进程**执行一次有界 RESET（子进程自身可能已卡死，不能依赖它的 finally）；
 *   ④ 记录退出码、超时原因、清理结果，并据此给出最终退出码。
 *
 * 退出码约定：
 *   0 = 子进程 0 退出且 RESET 成功
 *   1 = 子进程非 0 退出（或 spawn 失败）
 *   2 = 子进程超时被强制终止
 *   3 = 子进程正常但 RESET 失败（清理不确定）
 *
 * 依赖：仅 node:child_process / node:timers。可注入 spawn / killTree / fetch，便于纯 Node 测试。
 */

const { spawn, spawnSync } = require('node:child_process')

const EXIT_OK = 0
const EXIT_CHILD_FAIL = 1
const EXIT_TIMEOUT = 2
const EXIT_CLEANUP_FAIL = 3

const DEFAULT_CHILD_TIMEOUT = 10 * 60 * 1000   // 单个脚本 10 分钟
const DEFAULT_KILL_GRACE = 5000                // 强杀后等待其退出的宽限
const DEFAULT_RESET_TIMEOUT = 8000             // 父进程 RESET 的有界期限
const DEFAULT_API_BASE = 'http://127.0.0.1:8787'
const DEFAULT_SESSION_ID = 'default'

/**
 * 终止进程树。
 * Windows 用 taskkill /T 才能一并杀掉 Edge 子孙进程；
 * POSIX 依赖 spawn 时的 detached（进程组）后对 -pid 发 SIGKILL。
 * @returns {{ok:boolean, method:string, detail?:string}}
 */
function killProcessTree(pid, options = {}) {
  const platform = options.platform || process.platform
  const log = options.log || console
  const spawnSyncImpl = options.spawnSyncImpl || spawnSync
  if (!pid) return { ok: false, method: 'none', detail: '缺少 pid' }
  try {
    if (platform === 'win32') {
      const r = spawnSyncImpl('taskkill', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8' })
      const ok = Boolean(r && (r.status === 0 || r.status === 128))
      return { ok, method: 'taskkill /T /F', detail: (r && (r.stderr || r.stdout) || '').trim().slice(0, 200) }
    }
    // POSIX：先杀进程组，再兜底杀单体
    try { process.kill(-pid, 'SIGKILL') } catch (_) { /* 组可能不存在 */ }
    try { process.kill(pid, 'SIGKILL') } catch (_) { /* 可能已退出 */ }
    return { ok: true, method: 'kill(-pid, SIGKILL)' }
  } catch (e) {
    log.log(`  ⚠ supervisor 终止进程树失败（pid=${pid}）：${e && e.message ? e.message : e}`)
    return { ok: false, method: platform === 'win32' ? 'taskkill' : 'kill', detail: String(e && e.message) }
  }
}

/**
 * 父进程侧的有界 RESET。**只尝试一次**，不重试，不抛出。
 * 超时会 abort 底层请求（AbortController），区别于 page.evaluate 的“放弃等待”。
 */
async function performReset(options = {}) {
  const apiBase = options.apiBase || DEFAULT_API_BASE
  const sessionId = options.sessionId || DEFAULT_SESSION_ID
  const budget = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_RESET_TIMEOUT
  const doFetch = options.fetchImpl || fetch
  const url = `${apiBase}/api/v1/demo/command?sessionId=${encodeURIComponent(sessionId)}`
  const controller = typeof AbortController === 'function' ? new AbortController() : null
  let timer = null
  try {
    const request = Promise.resolve().then(() => doFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'RESET', payload: {} }),
      signal: controller ? controller.signal : undefined,
    }))
    request.then(() => {}, () => {})
    const guard = new Promise((_, reject) => {
      timer = setTimeout(() => {
        if (controller) controller.abort()
        const e = new Error(`RESET 超时（${budget}ms），已 abort`)
        e.code = 'RESET_TIMEOUT'
        reject(e)
      }, budget)
    })
    const res = await Promise.race([request, guard])
    const ok = Boolean(res && res.ok)
    return { attempted: true, ok, status: res && res.status, error: ok ? null : `HTTP ${res && res.status}` }
  } catch (e) {
    return {
      attempted: true,
      ok: false,
      status: null,
      error: e && e.code === 'RESET_TIMEOUT' ? 'timeout' : String((e && e.message) || e),
    }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** 跟踪子进程退出（只挂一次监听，避免 exit 只触发一次导致的漏接） */
function trackChild(child) {
  // R-E：exited 只由 'exit' 事件置位；settled 仅表示"等待已结束"，二者严格分离。
  //      'error'（spawn 失败 / kill 失败 / IPC 失败）**不得**被当作已退出。
  const state = { exited: false, settled: false, code: null, signal: null, error: null, spawnError: null }
  let resolveExit = null
  const exited = new Promise((resolve) => { resolveExit = resolve })
  const settle = () => {
    if (state.settled) return
    state.settled = true
    resolveExit(state)
  }
  if (typeof child.once === 'function') {
    child.once('exit', (code, signal) => {
      state.code = code
      state.signal = signal
      state.exited = true          // ← 唯一置位点
      settle()
    })
    child.once('error', (err) => {
      state.error = err
      if (!state.exited) state.spawnError = err   // 仅记录，绝不置 exited
      // P1 修复：'error' 不得结束整个监管周期（否则会清除整体 timeout、跳过 killTree、
      //          导致子进程与 Edge 子孙泄漏）。唯一例外——进程从未建立（无 pid，如 ENOENT），
      //          此时无可监管对象，允许结束等待，避免白等满整轮 timeoutMs。
      if (!state.exited && !child.pid) settle()
    })
  }
  return { state, exited }
}

/**
 * R-F：残留探测状态归一化（四种互斥状态）。
 *   not_checked —— 未配置检测（或探测自身抛错）：**不代表通过**
 *   checked     —— 已执行检测（与 none/found 组合使用）
 *   none        —— 已检查且没有残留
 *   found       —— 确认存在残留
 */
function probeLeftoversSafe(fn, log = console) {
  if (typeof fn !== 'function') return { status: 'not_checked', checked: false }
  try {
    const r = fn()
    if (r && r.found) return { status: 'found', checked: true, detail: r.detail || null }
    return { status: 'none', checked: true, detail: (r && r.detail) || null }
  } catch (e) {
    log.log(`  ⚠ supervisor：残留探测失败（按未检查处理）：${e && e.message ? e.message : e}`)
    return { status: 'not_checked', checked: false, error: String((e && e.message) || e) }
  }
}

/**
 * 最终退出码判定（纯函数，便于单测）。
 * 判定顺序：spawn 失败 → 超时 → 退出未确认 → 子进程非零 → RESET 未确认成功 → 残留 → 0
 */
function decideExitCode(result) {
  if (result.spawnError) return EXIT_CHILD_FAIL
  if (result.timedOut) return EXIT_TIMEOUT
  // R-E：fail-closed —— 只有**显式 true** 才算确认退出；
  //      false / undefined / null / 字段缺失 一律判非零（不得 fail-open）。
  if (result.childExitConfirmed !== true) return EXIT_CHILD_FAIL
  if (result.childExitCode !== 0) return EXIT_CHILD_FAIL
  // R-E：RESET 被跳过 / 未执行 / 未成功，都不得判绿
  if (!result.reset) return EXIT_CLEANUP_FAIL
  if (result.reset.skipped === true) return EXIT_CLEANUP_FAIL
  if (result.reset.ok !== true) return EXIT_CLEANUP_FAIL
  // R-F：只有「确认存在残留」判红；not_checked / none 均不误报
  if (result.leftovers && result.leftovers.status === 'found') return EXIT_CLEANUP_FAIL
  return EXIT_OK
}

/**
 * 运行被监管的脚本。
 * @param {object} options
 * @param {string} options.scriptPath  子进程脚本（相对 cwd）
 * @param {number} [options.timeoutMs] 整体期限
 * @param {object} [options.env]       子进程环境变量
 * @param {Function} [options.spawnImpl] 测试注入
 * @param {Function} [options.killTree]  测试注入
 * @param {Function} [options.fetchImpl] 测试注入（RESET）
 * @param {boolean} [options.reset]    false 表示跳过父进程 RESET（**会被判为清理失败**）
 * @param {Function} [options.probeLeftovers] 可选：返回 {found:boolean, detail?}；
 *        未提供 ⇒ leftovers.status = 'not_checked'（不代表通过，也不判红）
 */
async function runSupervised(options = {}) {
  const scriptPath = options.scriptPath
  if (!scriptPath) throw new Error('runSupervised: 需要 scriptPath')
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_CHILD_TIMEOUT
  const killGraceMs = Number(options.killGraceMs) > 0 ? Number(options.killGraceMs) : DEFAULT_KILL_GRACE
  const spawnImpl = options.spawnImpl || spawn
  const killTree = options.killTree || killProcessTree
  const log = options.log || console
  const startedAt = Date.now()

  let child
  try {
    child = spawnImpl(options.execPath || process.execPath, [scriptPath, ...(options.scriptArgs || [])], {
      cwd: options.cwd || process.cwd(),
      env: options.env || process.env,
      stdio: options.stdio || 'inherit',
      // POSIX 需要独立进程组，才能整组杀死（含浏览器子孙）
      detached: (options.platform || process.platform) !== 'win32',
    })
  } catch (e) {
    return {
      ok: false,
      scriptPath,
      spawnError: String((e && e.message) || e),
      timedOut: false,
      childExitCode: null,
      signal: null,
      killed: null,
      reset: null,
      leftovers: null,
      durationMs: Date.now() - startedAt,
      exitCode: EXIT_CHILD_FAIL,
    }
  }

  const { state, exited } = trackChild(child)
  let timer = null
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ __timeout: true }), timeoutMs)
  })
  const first = await Promise.race([exited, deadline])
  if (timer) clearTimeout(timer)

  const timedOut = Boolean(first && first.__timeout)
  let killed = null
  let leftovers = null

  if (timedOut) {
    log.log(`  ⚠ supervisor：子进程超过 ${timeoutMs}ms 未退出，开始终止进程树（pid=${child.pid}）`)
    killed = killTree(child.pid, { log, platform: options.platform })
    // 有界等待其真正退出，避免把“仍在运行”当成已清理
    let graceTimer = null
    const grace = new Promise((resolve) => { graceTimer = setTimeout(() => resolve({ __graceTimeout: true }), killGraceMs) })
    const after = await Promise.race([exited, grace])
    if (graceTimer) clearTimeout(graceTimer)
    if (after && after.__graceTimeout) {
      log.log(`  ⚠ supervisor：强杀后 ${killGraceMs}ms 仍未退出（pid=${child.pid}）`)
    }
  }

  leftovers = probeLeftoversSafe(options.probeLeftovers, log)

  // R-E：以「exit 事件是否真的到达」作为退出确认依据；
  //      已发出 taskkill ≠ 已退出，因此这里只认 state.exited。
  const exitConfirmed = state.exited === true

  let reset
  if (!exitConfirmed) {
    // 子进程仍未确认退出 ⇒ 绝不发父进程 RESET（避免与仍在运行的进程并发操作状态机）
    reset = { attempted: false, skipped: true, reason: 'child-exit-unconfirmed', ok: false }
    log.log('  ⚠ supervisor：子进程退出未确认，跳过父进程 RESET（退出码将非零）')
  } else if (options.reset === false) {
    reset = { attempted: false, skipped: true, reason: 'disabled', ok: false }
    log.log('  ⚠ supervisor：RESET 被显式跳过（退出码将判清理失败）')
  } else {
    reset = await performReset({
      apiBase: options.apiBase,
      sessionId: options.sessionId,
      timeoutMs: options.resetTimeoutMs,
      fetchImpl: options.fetchImpl,
    })
    if (!reset.ok) log.log(`  ⚠ supervisor：父进程 RESET 失败（${reset.error}）`)
  }

  const result = {
    scriptPath,
    timedOut,
    childExitConfirmed: exitConfirmed,
    childExitCode: exitConfirmed ? state.code : null,
    signal: exitConfirmed ? state.signal : null,
    childError: state.error ? String(state.error.message || state.error) : null,
    killed,
    reset,
    leftovers,
    durationMs: Date.now() - startedAt,
  }
  result.exitCode = decideExitCode(result)
  result.ok = result.exitCode === EXIT_OK
  return result
}

module.exports = {
  EXIT_OK,
  EXIT_CHILD_FAIL,
  EXIT_TIMEOUT,
  EXIT_CLEANUP_FAIL,
  DEFAULT_CHILD_TIMEOUT,
  DEFAULT_RESET_TIMEOUT,
  killProcessTree,
  performReset,
  trackChild,
  probeLeftoversSafe,
  decideExitCode,
  runSupervised,
}

// ── CLI：node e2e-supervisor.cjs <script> [timeoutMs] ──
if (require.main === module) {
  const argv = process.argv.slice(2)
  const scriptPath = argv[0]
  if (!scriptPath) {
    console.error('用法: node worker/e2e-supervisor.cjs <script.cjs> [timeoutMs]')
    process.exit(64)
  }
  const timeoutMs = Number(argv[1]) > 0 ? Number(argv[1]) : DEFAULT_CHILD_TIMEOUT
  runSupervised({ scriptPath, timeoutMs })
    .then((r) => {
      console.log(`\n[supervisor] ${JSON.stringify({
        script: r.scriptPath,
        exitCode: r.exitCode,
        childExitCode: r.childExitCode,
        timedOut: r.timedOut,
        killed: r.killed,
        reset: r.reset,
        leftovers: r.leftovers,
        durationMs: r.durationMs,
      })}`)
      process.exit(r.exitCode)
    })
    .catch((e) => {
      console.error('[supervisor] 运行失败：', e)
      process.exit(EXIT_CHILD_FAIL)
    })
}

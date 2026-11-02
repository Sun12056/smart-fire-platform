'use strict'

const { performance } = require('node:perf_hooks')
/**
 * E2E 退出码单一权威（WP-A3 / A3-1）
 * ────────────────────────────────────────────────
 * 设计目标：让「测试失败」这件事只有一套判定与一套写入路径。
 *
 * 铁律：
 *   ① 只有 failed === 0 的进程才允许以 0 退出；
 *   ② 退出码只能被「提升」为非零，任何公共函数都不得把它写回 0，
 *      因此 finally / 清理 / 关闭浏览器都不可能把失败改写成成功；
 *   ③ 公共辅助函数（check / finalize）是唯一写退出码的入口，
 *      调用方不再各自实现互不相同的退出码逻辑；
 *   ④ 清理动作必须通过 safeCleanup 执行：清理异常只告警，
 *      绝不覆盖原始断言失败或原始异常。
 *
 * 依赖约束：本文件 **零第三方依赖**，可被纯 Node 单元测试直接 require，
 * 也可在无 Edge / 无 playwright-core 的 CI 环境中执行。
 */

const EXIT_OK = 0
const EXIT_FAIL = 1

/** 断言台账（每个脚本一份；e2e-lib 持有一份默认实例） */
function createLedger() {
  return { passed: 0, failed: 0, failures: [] }
}

/**
 * 记录一条断言结果。输出格式与历史实现保持一致（现有报告可继续阅读）。
 * @returns {boolean} 断言是否通过
 */
function record(ledger, name, cond, extra, log = console) {
  const ok = Boolean(cond)
  if (ok) {
    ledger.passed += 1
    log.log(`  ✓ ${name}`)
  } else {
    ledger.failed += 1
    ledger.failures.push(name)
    log.log(`  ✗ ${name}${extra !== undefined ? ' → ' + JSON.stringify(extra) : ''}`)
  }
  return ok
}

/** 台账 → 退出码（纯函数，便于单测） */
function exitCodeFor(results) {
  return results && Number(results.failed) > 0 ? EXIT_FAIL : EXIT_OK
}

/**
 * 把退出码提升为非零。已是非零时保持不变；**永不写入 0**。
 * @param {object} target 目标（默认 process，单测可传假对象）
 * @returns {number} 调用后的退出码
 */
function markFailure(target = process) {
  if (!target) return EXIT_FAIL
  if (!target.exitCode) target.exitCode = EXIT_FAIL
  return target.exitCode
}

/**
 * 打印总结并按台账设置退出码（唯一写退出码的公共入口）。
 * @returns {{passed:number, failed:number, failures:string[]}} 台账快照
 */
function finalize(ledger, title, options = {}) {
  const target = options.target || process
  const log = options.log || console
  const results = {
    passed: ledger.passed,
    failed: ledger.failed,
    failures: ledger.failures.slice(),
  }
  log.log(`\n=== ${title}：${results.passed} 通过 / ${results.failed} 失败 ===`)
  if (results.failed) log.log('失败项：\n  - ' + results.failures.join('\n  - '))
  if (exitCodeFor(results) === EXIT_FAIL) markFailure(target)
  return results
}

/**
 * 安全清理：清理动作抛错时只打印告警，不改变退出码、不抛出。
 * 这样 finally 中的复位 / 关闭浏览器不会掩盖原始断言失败或原始异常。
 *
 * WP-A3.1 / F-1：返回契约可判定成败（不再用 undefined 表示失败）
 *   { ok: true,  label, value, error: undefined }
 *   { ok: false, label, value: undefined, error }
 */
async function safeCleanup(label, action, options = {}) {
  const log = options.log || console
  try {
    const value = await action()
    return { ok: true, label, value, error: undefined }
  } catch (e) {
    log.log(`  ⚠ ${label}失败（不覆盖原始结果）：${e && e.message ? e.message : String(e)}`)
    return { ok: false, label, value: undefined, error: e }
  }
}

/**
 * WP-A3.1 / F-1：把清理结果写入统一台账。
 * 仅用于「失败必须判红」的清理（如测试隔离复位）；浏览器关闭仍走 safeCleanup。
 */
async function cleanupCheck(ledger, name, action, options = {}) {
  const r = await safeCleanup(name, action, options)
  record(ledger, name, r.ok, r.ok ? undefined : {
    error: r.error && r.error.message ? String(r.error.message).slice(0, 200) : String(r.error),
  }, options.log || console)
  return r
}

/**
 * WP-A3.1-D-R1 / F-2：单调时钟（毫秒，浮点）。
 * 总截止时间必须基于单调时钟：墙钟回拨或系统日期变化不得延长等待。
 * 函数仍保留可注入的 now 参数，便于纯 Node 测试。默认值**不是** Date.now()。
 */
function monotonicNow() {
  return performance.now()
}

/**
 * WP-A3.1-D-R1 / F-1：同一 Node.js 进程内的 RESET 在途登记（按 sessionId 隔离）。
 * ⚠ 只保证单进程内不重复发起；**不解决跨进程并发**（两个进程各自持有一份 Map）。
 */
const inflightResets = new Map()

/**
 * WP-A3.1-D-R1.2 / R1：正在执行中的 resetToIdle（按 sessionId 占位）。
 * 占位发生在**任何 await 之前**，因此覆盖 pre-read 期间的竞争窗口；
 * 释放放在 finally，覆盖正常返回、抛错与提前 return 全部路径。
 */
const activeResets = new Set()

/**
 * 登记一次已发出的 RESET 请求，直到它真正 resolve / reject 才标记 settled。
 * 同时挂载成功与失败处理器：既用于解除在途保护，也避免迟到的 reject 变成 unhandledRejection。
 */
function trackInflightReset(sessionId, promise, startedAt) {
  const rec = { settled: false, rejected: false, value: undefined, error: undefined, startedAt }
  promise.then(
    (value) => { rec.settled = true; rec.value = value },
    (error) => { rec.settled = true; rec.rejected = true; rec.error = error },
  )
  inflightResets.set(sessionId, rec)
  return rec
}

/**
 * WP-A3.1 / F-3：严格复位 —— 发出 RESET 后必须复读到 stage === 'IDLE' 才算成功。
 * WP-A3.1-D-R1：有限等待语义
 *   · 进入函数即建立**总截止时间** deadline = now() + timeout；
 *   · 前置读 / RESET 请求 / 每次后置复读，都经 runBounded 受「剩余预算」约束；
 *   · 预算耗尽时**不再发起新调用**，也**不再等待**；
 *   · 任何结果若在 deadline 之后才返回（late），一律判为超时失败，**不接受迟到的 IDLE**；
 *   · RESET 请求超时/迟到 ⇒ 只抛错一次，**绝不重发 RESET**，并显式声明
 *     「服务端可能已执行、结果不确定」（不得把请求超时等同于未执行）。
 *
 * 依赖以参数注入（本文件零第三方依赖，可在纯 Node 中模拟测试）。
 *
 * 失败一律抛错（交由 cleanupCheck 记入台账并判红）：
 *   code = 'RESET_NOT_IDLE'         —— 无法在总截止内确认 IDLE（前置/后置读 失败/超时/迟到）
 *   code = 'RESET_REQUEST_UNKNOWN'  —— RESET 请求在总截止内未完成，服务端结果不确定
 *   code = 'RESET_INFLIGHT'         —— 上一次 RESET 请求仍未 settle
 *   code = 'RESET_CONCURRENT'       —— 同一 session 已有一次调用正在执行（含 pre-read 阶段）
 * 原始读取异常（非超时）原样抛出，不包装成超时。
 *
 * WP-A3.1-D-R1.2：
 *   · R1 并发门禁：同一 session 的调用串行化，占位在任何 await 之前完成，
 *     因此不存在"两次调用同时通过前置读、各自发出一次 RESET"的窗口；
 *   · R2 sleep 受总截止约束：sleep 与剩余预算竞速，过冲 / 迟到 / 永不 resolve
 *     都会在 deadline 处结束等待并判总截止失败（不会挂死，也不会多读一轮）。
 */
async function resetToIdle({
  demoState, cmd, sleep, sessionId,
  timeout = 3000, interval = 250, now = monotonicNow,
}) {
  if (typeof demoState !== 'function' || typeof cmd !== 'function' || typeof sleep !== 'function') {
    throw new TypeError('resetToIdle: 需要注入 demoState / cmd / sleep')
  }

  // ⓪-A 并发门禁（R1）：同一 session 同一时刻只允许一次 resetToIdle 在执行。
  //      占位发生在**任何 await 之前**（同步），因此覆盖 pre-read 期间的竞争窗口：
  //      第二个并发调用在第一次还没发出 RESET 时就会被拒绝，不会叠加出第二次 RESET。
  if (activeResets.has(sessionId)) {
    const err = new Error(
      '同一 session 已有一个 resetToIdle 正在执行（含前置状态读取阶段），'
      + '本次拒绝并发发起；无法判定对方是否已发出 RESET，最终状态不确定',
    )
    err.code = 'RESET_CONCURRENT'
    err.reason = 'reset-concurrent-active'
    err.serverMayHaveExecuted = true
    throw err
  }
  activeResets.add(sessionId)

  try {
    const startedAt = now()
    const deadline = startedAt + timeout
    const intervalMs = Number(interval) > 0 ? Number(interval) : 0
    // 终止保护（不是超时框架）：即使注入时钟不前进，也不会退化成死循环
    const maxAttempts = Math.max(1, Math.ceil(timeout / Math.max(1, intervalMs)) + 2)

    // ⓪-B 在途请求门禁（F-1）：上一次调用的 RESET 尚未 settle ⇒ 拒绝再次发起
    const pending = inflightResets.get(sessionId)
    if (pending && !pending.settled) {
      const err = new Error(
        '检测到同一 session 的上一次 RESET 请求仍在途（未 settle），'
        + '本次拒绝再次发起 RESET；上一次请求的结果仍不确定，'
        + '不得据此认为服务端未执行 RESET',
      )
      err.code = 'RESET_INFLIGHT'
      err.reason = 'reset-inflight-pending'
      err.serverMayHaveExecuted = true
      err.inflightSince = pending.startedAt
      throw err
    }

    /** 在剩余预算内执行一次异步调用；不越过 deadline，不接受迟到结果 */
    const runBounded = async (fn) => {
      const remaining = deadline - now()
      if (!(remaining > 0)) return { status: 'skipped' }
      let timer = null
      const guard = new Promise((resolve) => {
        timer = setTimeout(() => resolve({ status: 'timeout' }), remaining)
      })
      let call
      try {
        call = Promise.resolve(fn())
      } catch (e) {
        clearTimeout(timer)
        return { status: 'error', error: e }
      }
      try {
        const r = await Promise.race([
          call.then(
            (value) => ({ status: 'done', value, at: now() }),
            (error) => ({ status: 'error', error, at: now() }),
          ),
          guard,
        ])
        // 迟到判定：已完成但完成时刻已过 deadline ⇒ 不接受
        if (r.status === 'done' && r.at > deadline) return { status: 'late', value: r.value }
        return r
      } finally {
        if (timer) clearTimeout(timer)
      }
    }

    const timeoutError = (reason, lastStage, attempts) => {
      const err = new Error(
        `RESET 未在 ${timeout}ms 总截止内确认 IDLE（${reason}；${attempts} 次复读；最后状态 ${lastStage}）`,
      )
      err.code = 'RESET_NOT_IDLE'
      err.reason = reason
      err.lastStage = lastStage
      err.attempts = attempts
      return err
    }

    // ① 前置读：IDLE 阶段不接受 RESET（状态机转移表 IDLE 只有 START_FIRE），先读避免 409
    const pre = await runBounded(() => demoState(sessionId))
    if (pre.status === 'error') throw pre.error
    if (pre.status === 'skipped') throw timeoutError('deadline-exceeded', undefined, 0)
    if (pre.status !== 'done') throw timeoutError(`pre-read-${pre.status}`, undefined, 0)
    if (pre.value && String(pre.value.stage) === 'IDLE') {
      return { ok: true, stage: 'IDLE', skipped: true, attempts: 0, waitedMs: now() - startedAt }
    }

    // ② RESET 请求：只发一次；登记在途状态（F-1），超时/迟到绝不重发
    const reset = await runBounded(() => {
      const call = Promise.resolve(cmd('RESET', {}, sessionId))
      trackInflightReset(sessionId, call, now())
      return call
    })
    if (reset.status === 'error') throw reset.error
    // 预算耗尽 ⇒ 请求从未发出（服务端一定未执行），按「未确认 IDLE」记录
    if (reset.status === 'skipped') throw timeoutError('deadline-exceeded', pre.value && pre.value.stage, 0)
    if (reset.status !== 'done') {
      const err = new Error(
        `RESET 请求未在 ${timeout}ms 总截止内完成（${reset.status}）；`
        + '服务端可能已执行该 RESET，最终状态不确定，禁止重发以免产生并发复位',
      )
      err.code = 'RESET_REQUEST_UNKNOWN'
      err.reason = `reset-request-${reset.status}`
      err.serverMayHaveExecuted = true
      throw err
    }

    // ③ 后置复读：每轮都受剩余预算约束
    let attempts = 0
    let last = pre.value && pre.value.stage
    for (;;) {
      // 终止保护：注入时钟不前进时也必须结束
      if (attempts >= maxAttempts) throw timeoutError('deadline-exceeded', last, attempts)
      const rd = await runBounded(() => demoState(sessionId))
      if (rd.status === 'error') throw rd.error
      // 预算耗尽 ⇒ 不再发起新读取，按总截止超时处理
      if (rd.status === 'skipped') throw timeoutError('deadline-exceeded', last, attempts)
      if (rd.status !== 'done') throw timeoutError(`post-read-${rd.status}`, last, attempts)
      attempts += 1
      last = rd.value && rd.value.stage
      if (String(last) === 'IDLE') {
        return { ok: true, stage: 'IDLE', skipped: false, attempts, waitedMs: now() - startedAt }
      }
      const rest = deadline - now()
      if (!(rest > 0)) throw timeoutError('deadline-exceeded', last, attempts)
      // R2：sleep **本身**也纳入总截止约束（不只限制请求时长）。
      //     与剩余预算竞速：sleep 过冲、迟到或永不 resolve，
      //     都会在 deadline 处结束等待并判总截止失败，函数不会挂死。
      const nap = await runBounded(() => sleep(Math.min(intervalMs, rest)))
      // sleep 自身抛错 ⇒ 保留原始异常（与"读取异常原样抛出"一致，不包装成超时）
      if (nap.status === 'error') throw nap.error
      if (nap.status !== 'done') throw timeoutError('deadline-exceeded', last, attempts)
      // 防御：sleep 正常返回但时钟已越过 deadline（注入时钟跳变等）
      if (now() >= deadline) throw timeoutError('deadline-exceeded', last, attempts)
    }
  } finally {
    // 门禁释放覆盖：正常返回 / 抛错 / 提前 return 全部路径
    activeResets.delete(sessionId)
  }
}

module.exports = {
  EXIT_OK,
  EXIT_FAIL,
  createLedger,
  record,
  exitCodeFor,
  markFailure,
  finalize,
  safeCleanup,
  cleanupCheck,
  resetToIdle,
}

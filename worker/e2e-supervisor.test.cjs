'use strict'
/**
 * WP-A3.3 / R1 纯 Node 测试：进程级 supervisor
 * ────────────────────────────────────────────────
 * 覆盖：整体期限、超时终止、进程树清理、父进程有界 RESET、
 *       R-E 退出确认 / RESET 跳过与失败、R-F 残留探测四态、不重试、退出码。
 * 不启动真实子进程 / 浏览器：spawn / killTree / fetch 全部注入。
 */
const { EventEmitter } = require('node:events')

const sup = require('./e2e-supervisor.cjs')

let pass = 0
let failed = 0
const failedNames = []
function check(name, cond, extra) {
  if (cond) {
    pass += 1
    console.log(`  ✓ ${name}`)
  } else {
    failed += 1
    failedNames.push(name)
    console.log(`  ✗ ${name}${extra !== undefined ? ' → ' + JSON.stringify(extra) : ''}`)
  }
}

/** 可控假子进程（只实现 supervisor 用到的部分） */
function makeChild(pid = 4321) {
  const em = new EventEmitter()
  return {
    pid,
    once: em.once.bind(em),
    on: em.on.bind(em),
    exit: (code, signal = null) => em.emit('exit', code, signal),
    fail: (err) => em.emit('error', err),
  }
}

const silent = { log() {} }
const okFetch = (counter) => async () => { if (counter) counter.n += 1; return { ok: true, status: 200 } }

;(async () => {
  console.log('\n=== 一、退出码判定（纯函数） ===')
  {
    // R-E fail-closed：只有显式 true 才可能判 0，其余基准用例都必须显式给出 true
    const base = { childExitConfirmed: true, childExitCode: 0, reset: { ok: true } }
    check('子进程 0 + RESET 成功 ⇒ 0',
      sup.decideExitCode({ ...base }) === sup.EXIT_OK)
    check('子进程 1 ⇒ 1（CHILD_FAIL）',
      sup.decideExitCode({ ...base, childExitCode: 1 }) === sup.EXIT_CHILD_FAIL)
    check('超时 ⇒ 2（TIMEOUT，优先于子进程码）',
      sup.decideExitCode({ ...base, timedOut: true, childExitCode: null }) === sup.EXIT_TIMEOUT)
    check('子进程 0 但 RESET 失败 ⇒ 3（CLEANUP_FAIL）',
      sup.decideExitCode({ ...base, reset: { ok: false } }) === sup.EXIT_CLEANUP_FAIL)
    check('R-E 子进程 0 但 RESET 被跳过 ⇒ 3',
      sup.decideExitCode({ ...base, reset: { skipped: true } }) === sup.EXIT_CLEANUP_FAIL)
    check('R-E 子进程 0 且 RESET 缺失（null）⇒ 3（状态不明不得判绿）',
      sup.decideExitCode({ ...base, reset: null }) === sup.EXIT_CLEANUP_FAIL)
    check('R-F 残留 found ⇒ 3',
      sup.decideExitCode({ ...base, leftovers: { status: 'found' } }) === sup.EXIT_CLEANUP_FAIL)
    check('R-F 残留 none（已检查无残留）⇒ 0',
      sup.decideExitCode({ ...base, leftovers: { status: 'none' } }) === sup.EXIT_OK)
    check('R-F not_checked（未配置检测）不误报 ⇒ 0',
      sup.decideExitCode({ ...base, leftovers: { status: 'not_checked' } }) === sup.EXIT_OK)
    check('spawn 失败 ⇒ 1',
      sup.decideExitCode({ spawnError: 'boom', childExitConfirmed: false, childExitCode: null }) === sup.EXIT_CHILD_FAIL)

    // R-E fail-closed 四态矩阵（缺陷修复后新增）
    check('R-E childExitConfirmed=false ⇒ 非零（CHILD_FAIL）',
      sup.decideExitCode({ ...base, childExitConfirmed: false }) === sup.EXIT_CHILD_FAIL)
    check('R-E childExitConfirmed=undefined ⇒ 非零（fail-closed，此前会误判 0）',
      sup.decideExitCode({ ...base, childExitConfirmed: undefined }) === sup.EXIT_CHILD_FAIL)
    check('R-E childExitConfirmed=null ⇒ 非零（fail-closed，此前会误判 0）',
      sup.decideExitCode({ ...base, childExitConfirmed: null }) === sup.EXIT_CHILD_FAIL)
    {
      const missing = { childExitCode: 0, reset: { ok: true } }
      check('R-E 完全缺少 childExitConfirmed ⇒ 非零（fail-closed，此前会误判 0）',
        sup.decideExitCode(missing) === sup.EXIT_CHILD_FAIL)
    }
    check('R-E childExitConfirmed=true 且其余正常 ⇒ 允许 EXIT_OK',
      sup.decideExitCode({ ...base }) === sup.EXIT_OK)
  }

  console.log('\n=== 二、正常执行 ===')
  {
    const child = makeChild()
    let resetCalls = 0
    const r = await sup.runSupervised({
      scriptPath: 'fake.cjs',
      log: silent,
      spawnImpl: () => { setTimeout(() => child.exit(0), 10); return child },
      killTree: () => ({ ok: true, method: 'fake' }),
      fetchImpl: async () => { resetCalls += 1; return { ok: true, status: 200 } },
      timeoutMs: 1000,
    })
    check('子进程 0 退出 ⇒ exitCode 0', r.exitCode === 0 && r.ok === true, r.exitCode)
    check('timedOut=false 且记录 childExitCode', r.timedOut === false && r.childExitCode === 0,
      { timedOut: r.timedOut, code: r.childExitCode })
    check('父进程执行了 1 次 RESET 且成功', resetCalls === 1 && r.reset.ok === true,
      { resetCalls, reset: r.reset })
    check('未触发 killTree', r.killed === null)
    check('R-E 记录退出已确认且 RESET 未跳过',
      r.childExitConfirmed === true && r.reset.skipped !== true,
      { confirmed: r.childExitConfirmed, reset: r.reset })
  }

  console.log('\n=== 三、子进程失败 ===')
  {
    const child = makeChild()
    const r = await sup.runSupervised({
      scriptPath: 'fake.cjs',
      log: silent,
      spawnImpl: () => { setTimeout(() => child.exit(1), 10); return child },
      killTree: () => ({ ok: true, method: 'fake' }),
      fetchImpl: okFetch(),
      timeoutMs: 1000,
    })
    check('子进程非 0 ⇒ exitCode 1', r.exitCode === 1, r.exitCode)
    check('失败时仍执行 RESET（清理不因失败跳过）', r.reset && r.reset.attempted === true && r.reset.ok === true,
      r.reset)
  }

  console.log('\n=== 四、超时终止（子进程最终确认退出） ===')
  {
    const child = makeChild(999)
    let killArg = null
    const r = await sup.runSupervised({
      scriptPath: 'hang.cjs',
      log: silent,
      spawnImpl: () => child,
      killTree: (pid) => { killArg = pid; setTimeout(() => child.exit(null, 'SIGKILL'), 20); return { ok: true, method: 'fake-kill' } },
      fetchImpl: okFetch(),
      timeoutMs: 80,
      killGraceMs: 500,
    })
    check('超时 ⇒ exitCode 2', r.exitCode === sup.EXIT_TIMEOUT, r.exitCode)
    check('timedOut=true', r.timedOut === true, { timedOut: r.timedOut })
    check('killTree 收到子进程 pid', killArg === 999, { killArg })
    check('记录终止方式', r.killed && r.killed.method === 'fake-kill', r.killed)
    check('R-E 强杀后子进程确实退出 ⇒ childExitConfirmed=true', r.childExitConfirmed === true,
      { confirmed: r.childExitConfirmed })
    check('R-E 确认退出后才执行 RESET（1 次且成功）',
      r.reset.attempted === true && r.reset.ok === true, r.reset)
  }

  console.log('\n=== 五、强杀后仍未确认退出（R-E 核心） ===')
  {
    const child = makeChild(777)
    let resetCalls = 0
    const r = await sup.runSupervised({
      scriptPath: 'stuck.cjs',
      log: silent,
      spawnImpl: () => child,
      killTree: () => ({ ok: false, method: 'fake-kill-failed' }),
      fetchImpl: async () => { resetCalls += 1; return { ok: true, status: 200 } },
      timeoutMs: 60,
      killGraceMs: 60,
    })
    check('宽限内未退出仍返回 TIMEOUT（不把“已 taskkill”当已退出）',
      r.exitCode === sup.EXIT_TIMEOUT && r.killed.ok === false, { exitCode: r.exitCode, killed: r.killed })
    check('childExitConfirmed=false 且 childExitCode=null',
      r.childExitConfirmed === false && r.childExitCode === null,
      { confirmed: r.childExitConfirmed, code: r.childExitCode })
    check('未确认退出 ⇒ RESET 未被调用（请求次数 0）', resetCalls === 0, { resetCalls })
    check('RESET 被标记为 skipped 且原因正确',
      r.reset.skipped === true && r.reset.reason === 'child-exit-unconfirmed' && r.reset.attempted === false,
      r.reset)
    check('宽限等待有界（总耗时 < 1500ms）', r.durationMs < 1500, { durationMs: r.durationMs })
  }

  console.log('\n=== 六、RESET 失败 / 跳过 / 不重试 ===')
  {
    const child = makeChild()
    let calls = 0
    const r = await sup.runSupervised({
      scriptPath: 'fake.cjs',
      log: silent,
      spawnImpl: () => { setTimeout(() => child.exit(0), 10); return child },
      killTree: () => ({ ok: true, method: 'fake' }),
      fetchImpl: async () => { calls += 1; return { ok: false, status: 500 } },
      timeoutMs: 1000,
    })
    check('子进程成功但 RESET 失败 ⇒ exitCode 3', r.exitCode === sup.EXIT_CLEANUP_FAIL, r.exitCode)
    check('RESET 失败被记录（HTTP 500）', r.reset.ok === false && /500/.test(r.reset.error), r.reset)
    check('RESET 不重试（仅 1 次请求）', calls === 1, { calls })
  }
  {
    const child = makeChild()
    let calls = 0
    const t0 = Date.now()
    const r = await sup.runSupervised({
      scriptPath: 'fake.cjs',
      log: silent,
      spawnImpl: () => { setTimeout(() => child.exit(0), 10); return child },
      killTree: () => ({ ok: true, method: 'fake' }),
      fetchImpl: () => { calls += 1; return new Promise(() => {}) },
      timeoutMs: 1000,
      resetTimeoutMs: 80,
    })
    check('RESET 永不返回 ⇒ 有界超时并记 error=timeout',
      r.reset.ok === false && r.reset.error === 'timeout', r.reset)
    check('RESET 超时 ⇒ exitCode 3', r.exitCode === sup.EXIT_CLEANUP_FAIL, r.exitCode)
    check('RESET 超时不重试（仅 1 次）', calls === 1, { calls })
    check('RESET 超时有界（< 1500ms）', Date.now() - t0 < 1500, { elapsed: Date.now() - t0 })
  }
  {
    const child = makeChild()
    let calls = 0
    const r = await sup.runSupervised({
      scriptPath: 'fake.cjs',
      log: silent,
      spawnImpl: () => { setTimeout(() => child.exit(0), 10); return child },
      killTree: () => ({ ok: true, method: 'fake' }),
      fetchImpl: async () => { calls += 1; return { ok: true, status: 200 } },
      timeoutMs: 1000,
      reset: false,
    })
    check('R-E 显式跳过 RESET ⇒ exitCode 3（不得静默判绿）',
      r.exitCode === sup.EXIT_CLEANUP_FAIL, r.exitCode)
    check('R-E 跳过时 RESET 请求次数 0 且标记 skipped',
      calls === 0 && r.reset.skipped === true && r.reset.reason === 'disabled',
      { calls, reset: r.reset })
  }

  console.log('\n=== 七、spawn 失败与 R-F 残留探测 ===')
  {
    const r = await sup.runSupervised({
      scriptPath: 'nope.cjs',
      log: silent,
      spawnImpl: () => { throw new Error('spawn-boom') },
      killTree: () => ({ ok: true, method: 'fake' }),
      fetchImpl: okFetch(),
      timeoutMs: 500,
    })
    check('spawn 抛错 ⇒ exitCode 1 且记录原因',
      r.exitCode === 1 && /spawn-boom/.test(r.spawnError), { exitCode: r.exitCode, spawnError: r.spawnError })
  }
  {
    const child = makeChild()
    const r = await sup.runSupervised({
      scriptPath: 'fake.cjs',
      log: silent,
      spawnImpl: () => { setTimeout(() => child.exit(0), 10); return child },
      killTree: () => ({ ok: true, method: 'fake' }),
      fetchImpl: okFetch(),
      timeoutMs: 1000,
      probeLeftovers: () => ({ found: true, detail: '2 headless msedge' }),
    })
    check('R-F 探测到残留 ⇒ leftovers.status=found 且 exitCode 3',
      r.leftovers.status === 'found' && r.exitCode === sup.EXIT_CLEANUP_FAIL,
      { leftovers: r.leftovers, exitCode: r.exitCode })
  }
  {
    const child = makeChild()
    const r = await sup.runSupervised({
      scriptPath: 'fake.cjs',
      log: silent,
      spawnImpl: () => { setTimeout(() => child.exit(0), 10); return child },
      killTree: () => ({ ok: true, method: 'fake' }),
      fetchImpl: okFetch(),
      timeoutMs: 1000,
      probeLeftovers: () => ({ found: false }),
    })
    check('R-F 已检查且无残留 ⇒ status=none 且 exitCode 0',
      r.leftovers.status === 'none' && r.exitCode === 0, { leftovers: r.leftovers, exitCode: r.exitCode })
  }
  {
    const child = makeChild()
    const r = await sup.runSupervised({
      scriptPath: 'fake.cjs',
      log: silent,
      spawnImpl: () => { setTimeout(() => child.exit(0), 10); return child },
      killTree: () => ({ ok: true, method: 'fake' }),
      fetchImpl: okFetch(),
      timeoutMs: 1000,
    })
    check('R-F 未配置探测 ⇒ status=not_checked（不等于通过，也不判红）',
      r.leftovers.status === 'not_checked' && r.leftovers.checked === false && r.exitCode === 0,
      { leftovers: r.leftovers, exitCode: r.exitCode })
  }
  {
    const r = sup.probeLeftoversSafe(() => { throw new Error('probe-boom') }, silent)
    check('R-F 探测自身抛错 ⇒ not_checked（不误报为 found）',
      r.status === 'not_checked' && r.checked === false && /probe-boom/.test(r.error || ''),
      r)
  }

  console.log('\n=== 八、killProcessTree 平台分支 ===')
  {
    let cmd = null
    let args = null
    const r = sup.killProcessTree(1234, {
      platform: 'win32',
      log: silent,
      spawnSyncImpl: (c, a) => { cmd = c; args = a; return { status: 0, stdout: '', stderr: '' } },
    })
    check('win32 使用 taskkill /T /F（含子孙进程）',
      cmd === 'taskkill' && args.join(' ') === '/PID 1234 /T /F', { cmd, args })
    check('win32 返回 ok', r.ok === true && /taskkill/.test(r.method), r)

    const noPid = sup.killProcessTree(null, { platform: 'win32', log: silent, spawnSyncImpl: () => ({ status: 0 }) })
    check('缺少 pid ⇒ ok=false', noPid.ok === false)
  }

  console.log('\n=== 九、trackChild 只解析一次 ===')
  {
    const child = makeChild()
    const { state, exited } = sup.trackChild(child)
    child.exit(0)
    const first = await exited
    child.exit(1)
    const second = await exited
    check('exit 只解析一次（重复事件不改写结果）',
      first === second && state.code === 0, { code: state.code })
  }

  console.log('\n=== 十、R-E：只有 exit 事件才算退出确认 ===')
  {
    // ① 'error' 事件不得设置 exited，且（有 pid 时）不得结束监管等待
    {
      const child = makeChild()          // 有 pid：进程已建立
      const { state } = sup.trackChild(child)
      child.fail(new Error('runtime-error'))
      check("R-E 'error'（有 pid）不设置 state.exited", state.exited === false, { exited: state.exited })
      check("R-E 'error'（有 pid）记录到 state.error / spawnError",
        state.error instanceof Error && state.spawnError instanceof Error,
        { error: state.error && state.error.message })
      check("R-E 'error'（有 pid）不结束等待（settled=false，监管继续）", state.settled === false)
    }

    // ② 'error' 之后若真的收到 'exit'，才置 exited
    {
      const child = makeChild()
      const { state, exited } = sup.trackChild(child)
      child.fail(new Error('io-fail'))
      check("R-E 'error' 之后 exited 仍为 false", state.exited === false)
      child.exit(0)
      await exited
      check("R-E 收到真正的 'exit' 后才置 exited=true", state.exited === true && state.code === 0,
        { exited: state.exited, code: state.code })
    }

    // ③ 'error' 且始终无 'exit' ⇒ 监管不中断：等满 timeout → killTree → 跳过 RESET → TIMEOUT(2)
    {
      const child = makeChild()
      let resetCalls = 0
      let killCalls = 0
      const r = await sup.runSupervised({
        scriptPath: 'fake.cjs',
        log: silent,
        spawnImpl: () => { setTimeout(() => child.fail(new Error('child-error')), 10); return child },
        killTree: () => { killCalls += 1; return { ok: true, method: 'fake' } },
        fetchImpl: async () => { resetCalls += 1; return { ok: true, status: 200 } },
        timeoutMs: 120,
        killGraceMs: 80,
      })
      check("R-E 'error' 且无 'exit' ⇒ RESET 调用次数为 0", resetCalls === 0, { resetCalls })
      check("R-E 'error' 且无 'exit' ⇒ childExitConfirmed=false", r.childExitConfirmed === false,
        { confirmed: r.childExitConfirmed })
      check("R-E 'error' 且无 'exit' ⇒ 仍执行 killTree 且退出码为 TIMEOUT(2)",
        killCalls === 1 && r.exitCode === sup.EXIT_TIMEOUT,
        { killCalls, exitCode: r.exitCode })
      check("R-E 'error' 且无 'exit' ⇒ RESET 记录为 skipped(child-exit-unconfirmed)",
        r.reset && r.reset.skipped === true && r.reset.reason === 'child-exit-unconfirmed',
        r.reset)
      check("R-E 'error' 原因被记录（childError）", /child-error/.test(r.childError || ''), r.childError)
    }

    // ④ spawn error（spawnImpl 抛错）不得被当作退出确认，且不执行 RESET
    {
      let resetCalls = 0
      const r = await sup.runSupervised({
        scriptPath: 'nope.cjs',
        log: silent,
        spawnImpl: () => { throw new Error('spawn-refused') },
        killTree: () => ({ ok: true, method: 'fake' }),
        fetchImpl: async () => { resetCalls += 1; return { ok: true, status: 200 } },
        timeoutMs: 500,
      })
      check('R-E spawn error ⇒ 退出码非零且不执行 RESET',
        r.exitCode === sup.EXIT_CHILD_FAIL && resetCalls === 0,
        { exitCode: r.exitCode, resetCalls })
    }

    // ⑤ 真正的 'exit' 之后才允许进入 RESET
    {
      const child = makeChild()
      let resetCalls = 0
      const r = await sup.runSupervised({
        scriptPath: 'fake.cjs',
        log: silent,
        spawnImpl: () => { setTimeout(() => child.exit(0), 10); return child },
        killTree: () => ({ ok: true, method: 'fake' }),
        fetchImpl: async () => { resetCalls += 1; return { ok: true, status: 200 } },
        timeoutMs: 1000,
      })
      check("R-E 收到真正的 'exit' 后才执行 RESET（1 次）",
        r.childExitConfirmed === true && resetCalls === 1 && r.reset.attempted === true,
        { confirmed: r.childExitConfirmed, resetCalls })
      check('R-E 确认退出 + RESET 成功 ⇒ EXIT_OK', r.exitCode === sup.EXIT_OK, r.exitCode)
    }
  }

  console.log('\n=== 十一、P1 监管断裂回归：error 不得终止监管 ===')
  {
    // ① 有 pid 的 error ⇒ 不得 settle（监管必须继续）
    {
      const child = makeChild(4321)
      const { state } = sup.trackChild(child)
      child.fail(new Error('runtime-error'))
      check('P1 有 pid 的 error 后 settled 仍为 false（监管未结束）', state.settled === false,
        { settled: state.settled })
    }

    // ②③④⑤ 有 pid 的 error + 始终无 exit ⇒ timeout 生效 / killTree 执行 / TIMEOUT / RESET 0
    {
      const child = makeChild(888)
      let resetCalls = 0
      let killArg = null
      const t0 = Date.now()
      const r = await sup.runSupervised({
        scriptPath: 'fake.cjs',
        log: silent,
        spawnImpl: () => { setTimeout(() => child.fail(new Error('runtime-error')), 10); return child },
        killTree: (pid) => { killArg = pid; return { ok: true, method: 'fake-kill' } },
        fetchImpl: async () => { resetCalls += 1; return { ok: true, status: 200 } },
        timeoutMs: 150,
        killGraceMs: 80,
      })
      const elapsed = Date.now() - t0
      check('P1 error 后整体 timeout 仍生效（耗时 ≥ timeout）', elapsed >= 140, { elapsed })
      check('P1 error 后仍调用 killTree 且 pid 正确', killArg === 888, { killArg })
      check('P1 error 后无 exit ⇒ 退出码 EXIT_TIMEOUT(2)', r.exitCode === sup.EXIT_TIMEOUT, r.exitCode)
      check('P1 error 后无 exit ⇒ RESET 调用 0 次', resetCalls === 0, { resetCalls })
    }

    // ⑥⑦ error 后真实 exit(0) ⇒ 正常收尾（RESET 执行）且诊断信息保留
    {
      const child = makeChild()
      let resetCalls = 0
      const r = await sup.runSupervised({
        scriptPath: 'fake.cjs',
        log: silent,
        spawnImpl: () => {
          setTimeout(() => child.fail(new Error('transient-error')), 10)
          setTimeout(() => child.exit(0), 60)
          return child
        },
        killTree: () => ({ ok: true, method: 'fake' }),
        fetchImpl: async () => { resetCalls += 1; return { ok: true, status: 200 } },
        timeoutMs: 1000,
      })
      check('P1 error 后真实 exit ⇒ 确认退出且 RESET 执行 1 次',
        r.childExitConfirmed === true && resetCalls === 1 && r.reset.attempted === true,
        { confirmed: r.childExitConfirmed, resetCalls })
      check('P1 error 后真实 exit(0) ⇒ 退出码 0 且 childError 诊断保留',
        r.exitCode === sup.EXIT_OK && /transient-error/.test(r.childError || ''),
        { exitCode: r.exitCode, childError: r.childError })
    }

    // ⑧ error 不得覆盖真实 exit code
    {
      const child = makeChild()
      const r = await sup.runSupervised({
        scriptPath: 'fake.cjs',
        log: silent,
        spawnImpl: () => {
          setTimeout(() => child.fail(new Error('transient-error')), 10)
          setTimeout(() => child.exit(3), 60)
          return child
        },
        killTree: () => ({ ok: true, method: 'fake' }),
        fetchImpl: async () => ({ ok: true, status: 200 }),
        timeoutMs: 1000,
      })
      check('P1 error 不覆盖真实 exit code（exit(3) ⇒ 退出码 1）',
        r.exitCode === sup.EXIT_CHILD_FAIL && r.childExitCode === 3,
        { exitCode: r.exitCode, childExitCode: r.childExitCode })
    }

    // ⑨ 无 pid 的 spawn 失败 ⇒ 立即结束，不白等 timeout
    {
      const child = makeChild(null)
      let resetCalls = 0
      let killCalls = 0
      const t0 = Date.now()
      const r = await sup.runSupervised({
        scriptPath: 'fake.cjs',
        log: silent,
        spawnImpl: () => { setTimeout(() => child.fail(new Error('ENOENT')), 10); return child },
        killTree: () => { killCalls += 1; return { ok: true, method: 'fake' } },
        fetchImpl: async () => { resetCalls += 1; return { ok: true, status: 200 } },
        timeoutMs: 5000,
        killGraceMs: 50,
      })
      const elapsed = Date.now() - t0
      check('P1 无 pid 的 error ⇒ 立即结束（< 1000ms）、不 kill、不 RESET、退出码 1',
        elapsed < 1000 && killCalls === 0 && resetCalls === 0 && r.exitCode === sup.EXIT_CHILD_FAIL,
        { elapsed, killCalls, resetCalls, exitCode: r.exitCode })
    }
  }

  console.log(`\n=== WP-A3.3-R1 supervisor 测试：${pass} 通过 / ${failed} 失败 ===`)
  if (failed) console.log('失败项：\n  - ' + failedNames.join('\n  - '))
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error('异步测试异常：', e)
  process.exit(1)
})

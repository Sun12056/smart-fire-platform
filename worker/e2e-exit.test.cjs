'use strict'
/**
 * WP-A3 / A3-1 退出码单元验证（第一层）
 * ────────────────────────────────────────────────
 * 全部用子进程 + 纯 Node 完成，不启动浏览器、不依赖 Edge / playwright-core，
 * 因此可在 CI 与本地任意环境执行。
 *
 * 覆盖场景：
 *   ① 全部断言通过                         → 退出码 0
 *   ② 存在断言失败                         → 退出码非零
 *   ③ 测试过程发生未处理异常               → 退出码非零
 *   ④ 断言失败 + finally 清理成功          → 退出码非零（不得被改写为成功）
 *   ⑤ 断言失败 + 清理过程抛异常            → 退出码非零，且原始失败信息不丢失
 *   ⑥ 全部通过 + 清理过程抛异常            → 退出码 0，清理异常只告警（不伪造失败）
 *   ⑦ markFailure 只升不降，永不清零
 *   ⑧ finalize 无失败时不得清除既有非零退出码
 *   ⑨ 真正未处理的 Promise 拒绝            → 退出码非零
 *   ⑩ 源码级：B4 脚本不得再出现 `process.exitCode = 0`，且清理必须走 WP-A3.1 新路径
 *   ⑪ WP-A3.1：safeCleanup / cleanupCheck 的返回值与入账契约
 *   ⑫ WP-A3.1：resetToIdle 严格状态确认（已是 IDLE / 立即 IDLE / 多次复读 / 请求失败 / 状态不可读 / 超时 / 未知状态 / 有限等待）
 *   ⑬ WP-A3.1：结束 RESET 失败 ⇒ 退出码非零（子进程验证）
 *
 * 用法：node worker/e2e-exit.test.cjs
 */
const { spawnSync } = require('node:child_process')
const { readFileSync } = require('node:fs')
const path = require('node:path')

const EXIT_LIB = path.join(__dirname, 'e2e-exit.cjs')
// 本进程内直接引用（十一/十二节的契约与模拟测试用）
const exitLib = require('./e2e-exit.cjs')

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

/** 在子进程中运行一段脚本；把 e2e-exit.cjs 以 exitLib 注入 */
function runNode(code) {
  const src = `const exitLib = require(${JSON.stringify(EXIT_LIB)})\n${code}`
  const r = spawnSync(process.execPath, ['-e', src], { encoding: 'utf8' })
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' }
}

console.log('=== 一、全部断言通过 → 0 ===')
{
  const r = runNode(`
const ledger = exitLib.createLedger()
exitLib.record(ledger, 'a 通过', true)
exitLib.record(ledger, 'b 通过', 1 === 1)
exitLib.finalize(ledger, '全绿')
`)
  check('退出码 === 0', r.status === 0, { status: r.status, stderr: r.stderr.slice(-200) })
  check('报告仍正常输出（通过 / 失败计数）', r.stdout.includes('2 通过 / 0 失败'), r.stdout.trim().split('\n').slice(-1))
}

console.log('\n=== 二、存在断言失败 → 非零 ===')
{
  const r = runNode(`
const ledger = exitLib.createLedger()
exitLib.record(ledger, 'ok', true)
exitLib.record(ledger, 'broken', false, { want: 1, got: 2 })
exitLib.finalize(ledger, '有失败')
`)
  check('退出码非零', r.status !== 0, { status: r.status })
  check('失败被如实统计', r.stdout.includes('1 通过 / 1 失败'), r.stdout.trim().split('\n').slice(-1))
  check('失败项名称与附加信息仍输出', r.stdout.includes('broken') && r.stdout.includes('"want":1'), r.stdout.includes('broken'))
}

console.log('\n=== 三、未处理异常 → 非零 ===')
{
  const r = runNode(`
const ledger = exitLib.createLedger()
exitLib.record(ledger, 'ok', true)
;(async () => {
  try { throw new Error('boom-in-body') } finally {
    await exitLib.safeCleanup('清理', async () => {})
    exitLib.finalize(ledger, '异常场景')
  }
})().catch((e) => { console.error('回归异常：', e.message); exitLib.markFailure() })
`)
  check('退出码非零', r.status !== 0, { status: r.status })
  check('异常信息未被吞掉', r.stderr.includes('boom-in-body'), r.stderr.slice(0, 120))
}

console.log('\n=== 四、断言失败 + finally 清理成功 → 仍为非零 ===')
{
  const r = runNode(`
const ledger = exitLib.createLedger()
exitLib.record(ledger, 'must-not-be-green', false)
;(async () => {
  try { await new Promise((res) => setTimeout(res, 1)) } finally {
    await exitLib.safeCleanup('测试隔离复位', async () => true)
    exitLib.finalize(ledger, 'finally 场景')
  }
})()
`)
  check('退出码非零（finally 未改写为成功）', r.status !== 0, { status: r.status })
  check('原始断言失败仍被列出', r.stdout.includes('must-not-be-green'), r.stdout.slice(-160))
}

console.log('\n=== 五、断言失败 + 清理抛异常 → 非零且原始失败不被掩盖 ===')
{
  const r = runNode(`
const ledger = exitLib.createLedger()
exitLib.record(ledger, 'must-not-be-green', false)
;(async () => {
  try { await new Promise((res) => setTimeout(res, 1)) } finally {
    await exitLib.safeCleanup('浏览器关闭', async () => { throw new Error('cleanup-boom') })
    exitLib.finalize(ledger, '清理异常场景')
  }
})()
`)
  check('退出码非零', r.status !== 0, { status: r.status })
  check('清理异常只告警且可见', r.stdout.includes('cleanup-boom'), r.stdout.slice(-160))
  check('原始断言失败仍在报告中', r.stdout.includes('must-not-be-green'), r.stdout.slice(-160))
}

console.log('\n=== 六、全部通过 + 清理抛异常 → 0（不伪造失败） ===')
{
  const r = runNode(`
const ledger = exitLib.createLedger()
exitLib.record(ledger, 'ok', true)
;(async () => {
  try { await new Promise((res) => setTimeout(res, 1)) } finally {
    await exitLib.safeCleanup('浏览器关闭', async () => { throw new Error('cleanup-boom') })
    exitLib.finalize(ledger, '清理异常但断言全绿')
  }
})()
`)
  check('退出码 === 0', r.status === 0, { status: r.status })
  check('清理失败有告警', r.stdout.includes('cleanup-boom'), r.stdout.slice(-160))
}

console.log('\n=== 七、markFailure 只升不降 ===')
{
  const r = runNode(`
const fresh = { exitCode: undefined }
const a = exitLib.markFailure(fresh)
const b = exitLib.markFailure(fresh)
const preset = { exitCode: 7 }
exitLib.markFailure(preset)
console.log(JSON.stringify({ a, b, fresh: fresh.exitCode, preset: preset.exitCode }))
`)
  const out = JSON.parse(r.stdout.trim().split('\n').pop())
  check('初始未设置 → 提升为 1', out.a === 1 && out.fresh === 1, out)
  check('重复调用保持 1（不降级）', out.b === 1, out)
  check('已为非零（7）时保持原值', out.preset === 7, out)
}

console.log('\n=== 八、finalize 无失败时不得清除既有非零退出码 ===')
{
  const r = runNode(`
process.exitCode = 7
const ledger = exitLib.createLedger()
exitLib.record(ledger, 'ok', true)
const res = exitLib.finalize(ledger, '预设非零')
console.log('failed=' + res.failed + ' exitCode=' + process.exitCode)
`)
  check('既有非零退出码未被清零', r.status === 7, { status: r.status })
  check('汇总仍如实反映 0 失败', r.stdout.includes('failed=0'), r.stdout.trim())
}

console.log('\n=== 九、真正未处理的 Promise 拒绝 → 非零 ===')
{
  const r = runNode(`
;(async () => { throw new Error('unhandled-rejection') })()
`)
  check('退出码非零', r.status !== 0, { status: r.status })
}

console.log('\n=== 十、源码级：B4 脚本不得再无条件下调退出码 ===')
{
  const files = [
    'e2e-lib.cjs',
    'e2e-p173-b401-3d-plan-watch.cjs',
    'e2e-p173-b402-lighting-source.cjs',
    'e2e-p173-b403-runtime-unity.cjs',
  ]
  for (const f of files) {
    const src = readFileSync(path.join(__dirname, f), 'utf8')
    check(`${f}：无 process.exitCode = 0（不得无条件置成功）`, !/process\.exitCode\s*=\s*0/.test(src))
    check(`${f}：无 process.exit(0) 硬写入`, !/process\.exit\(\s*0\s*\)/.test(src))
  }
  const b4 = ['e2e-p173-b401-3d-plan-watch.cjs', 'e2e-p173-b402-lighting-source.cjs', 'e2e-p173-b403-runtime-unity.cjs']
  for (const f of b4) {
    const src = readFileSync(path.join(__dirname, f), 'utf8')
    check(`${f}：清理走 safeCleanup`, src.includes('safeCleanup('))
    check(`${f}：外层有异常兜底 markFailure`, /\.catch\(\(e\)[\s\S]{0,200}markFailure\(\)/.test(src))
    check(`${f}：结束 RESET 走 cleanupCheck（失败计入台账）`,
      src.includes('cleanupCheck(') && src.includes('测试隔离复位（结束 RESET）'))
    check(`${f}：不再用 safeCleanup 处理结束 RESET（WP-A3.1 回归守卫）`,
      !/safeCleanup\('测试隔离复位/.test(src))
    check(`${f}：结束 RESET 使用严格复位 resetToIdle`, src.includes('resetToIdle()'))
    check(`${f}：启动隔离失败会记录并中止本轮`,
      /if \(!isolated\)[\s\S]{0,160}return/.test(src))
  }
  const lib = readFileSync(path.join(__dirname, 'e2e-lib.cjs'), 'utf8')
  check('e2e-lib.cjs：退出码逻辑委托给 e2e-exit.cjs', lib.includes("require('./e2e-exit.cjs')"))
  check('e2e-lib.cjs：summary 仅是 finalize 的薄适配（不再自行打印/统计）',
    /function summary\(title\)\s*\{\s*return finalize\(results,\s*title\)\s*\}/.test(lib))
  check('e2e-lib.cjs：不再自行维护断言台账字面量',
    !/const results = \{ passed: 0, failed: 0, failures: \[\] \}/.test(lib))
  check('e2e-lib.cjs：导出 cleanupCheck 与 resetToIdle（WP-A3.1）',
    /cleanupCheck,\s*resetToIdle/.test(lib))
}

async function runAsyncChecks() {
  console.log('\n=== 十一、WP-A3.1：safeCleanup / cleanupCheck 契约 ===')
  {
    const ledger = exitLib.createLedger()
    const silent = { log() {} }

    const okRes = await exitLib.safeCleanup('ok', async () => 42, { log: silent })
    check('safeCleanup 成功 ⇒ { ok:true, value:42 }',
      okRes.ok === true && okRes.value === 42 && okRes.error === undefined, okRes)

    const voidRes = await exitLib.safeCleanup('void', async () => undefined, { log: silent })
    check('safeCleanup 成功但 action 返回 undefined ⇒ 仍是 ok:true（可与失败区分）',
      voidRes.ok === true && voidRes.value === undefined, voidRes)

    const errRes = await exitLib.safeCleanup('boom', async () => { throw new Error('cleanup-boom') }, { log: silent })
    check('safeCleanup 失败 ⇒ { ok:false, error }，且不抛出',
      errRes.ok === false && errRes.error instanceof Error && errRes.error.message === 'cleanup-boom', errRes)

    const ccOk = await exitLib.cleanupCheck(ledger, '隔离复位', async () => true, { log: silent })
    check('cleanupCheck 成功 ⇒ 台账 1 通过 / 0 失败',
      ccOk.ok === true && ledger.passed === 1 && ledger.failed === 0, { passed: ledger.passed, failed: ledger.failed })

    const ccFail = await exitLib.cleanupCheck(ledger, '隔离复位失败', async () => { throw new Error('reset-timeout') }, { log: silent })
    check('cleanupCheck 失败 ⇒ 台账 1 失败且失败项含名称',
      ccFail.ok === false && ledger.failed === 1 && ledger.failures.includes('隔离复位失败'),
      { failed: ledger.failed, failures: ledger.failures })
    check('cleanupCheck 失败 ⇒ exitCodeFor 返回 1', exitLib.exitCodeFor({ failed: ledger.failed }) === 1)
  }

  console.log('\n=== 十二、WP-A3.1：resetToIdle 严格状态确认（依赖注入模拟） ===')
  {
    const noSleep = async () => {}
    // WP-A3.1-D-R1 / F-1：在途 RESET 保护按 sessionId 隔离，
    // 因此每个用例使用独立 sessionId，避免上一用例遗留的 pending 请求串扰。
    let seq = 0
    const run = (opts) => exitLib.resetToIdle({
      sleep: noSleep, timeout: 300, interval: 0, sessionId: `s12-${++seq}`, ...opts,
    })

    let resetCalls = 0
    const skipped = await run({
      demoState: async () => ({ stage: 'IDLE' }),
      cmd: async () => { resetCalls += 1; return { ok: true, stage: 'IDLE' } },
    })
    check('前置已是 IDLE ⇒ skipped:true 且不发送 RESET（避免 409）',
      skipped.ok === true && skipped.skipped === true && resetCalls === 0, { skipped, resetCalls })

    {
      const seq = [{ stage: 'SMART_EVACUATION' }, { stage: 'IDLE' }]
      let i = 0
      const r = await run({ demoState: async () => seq[Math.min(i++, seq.length - 1)], cmd: async () => ({ ok: true }) })
      check('RESET 后首次复读即 IDLE ⇒ ok、attempts=1、skipped=false',
        r.ok === true && r.skipped === false && r.attempts === 1, r)
    }

    {
      const seq = [{ stage: 'ROUTE_PLANNING' }, { stage: 'ROUTE_PLANNING' }, { stage: 'IDLE' }]
      let i = 0
      const r = await run({ demoState: async () => seq[Math.min(i++, seq.length - 1)], cmd: async () => ({ ok: true }) })
      check('需要多次复读才 IDLE ⇒ ok、attempts=2', r.ok === true && r.attempts === 2, r)
    }

    {
      let threw = null
      try {
        await run({
          demoState: async () => ({ stage: 'FIRE_DETECTED' }),
          cmd: async () => { throw new Error('请求 /api/v1/demo/command 失败：HTTP 409') },
        })
      } catch (e) { threw = e }
      check('RESET 请求抛错 ⇒ 抛出，不判成功',
        threw instanceof Error && /HTTP 409/.test(threw.message), threw && threw.message)
    }

    {
      let threw = null
      let n = 0
      try {
        await run({
          demoState: async () => {
            n += 1
            if (n === 1) return { stage: 'FIRE_DETECTED' }
            throw new Error('state unreadable')
          },
          cmd: async () => ({ ok: true }),
        })
      } catch (e) { threw = e }
      check('RESET 后状态读取失败 ⇒ 抛出，不判成功',
        threw instanceof Error && /state unreadable/.test(threw.message), threw && threw.message)
    }

    {
      let threw = null
      let reads = 0
      const realSleep = (ms) => new Promise((r) => setTimeout(r, ms))
      try {
        await run({
          demoState: async () => { reads += 1; return { stage: 'SMART_EVACUATION' } },
          cmd: async () => ({ ok: true }),
          sleep: realSleep,
          timeout: 200,
          interval: 50,
        })
      } catch (e) { threw = e }
      check('状态始终非 IDLE ⇒ 超时抛错（code=RESET_NOT_IDLE）',
        threw instanceof Error && threw.code === 'RESET_NOT_IDLE', threw && threw.message)
      check('超时路径确有复读（reads ≥ 2：前置 1 次 + 复读 ≥1 次）', reads >= 2, { reads })
    }

    {
      let threw = null
      const realSleep = (ms) => new Promise((r) => setTimeout(r, ms))
      try {
        await run({
          demoState: async () => ({}),
          cmd: async () => ({ ok: true }),
          sleep: realSleep,
          timeout: 150,
          interval: 40,
        })
      } catch (e) { threw = e }
      check('未知状态（无 stage）⇒ 不得判成功',
        threw instanceof Error && threw.code === 'RESET_NOT_IDLE', threw && threw.message)
    }

    {
      let reads = 0
      const realSleep = (ms) => new Promise((r) => setTimeout(r, ms))
      try {
        await run({
          demoState: async () => { reads += 1; return { stage: 'ROUTE_PLANNING' } },
          cmd: async () => ({ ok: true }),
          sleep: realSleep,
          timeout: 300,
          interval: 50,
        })
      } catch (_) { /* 预期超时抛错 */ }
      check('有限等待：读取次数有界（>1 且 ≤10）', reads > 1 && reads <= 10, { reads })
    }
  }

  console.log('\n=== 十三、WP-A3.1：清理失败对退出码的影响（子进程） ===')
  {
    const r1 = runNode(`
const ledger = exitLib.createLedger()
exitLib.record(ledger, '业务断言全绿', true)
;(async () => {
  try { await new Promise((r) => setTimeout(r, 1)) } finally {
    await exitLib.cleanupCheck(ledger, '测试隔离复位（结束 RESET）', async () => { throw new Error('RESET 后未回到 IDLE') })
    await exitLib.safeCleanup('浏览器关闭', async () => {})
    exitLib.finalize(ledger, '全绿但清理失败')
  }
})()
`)
    check('业务全绿 + 结束 RESET 失败 ⇒ 退出码 1（D-1 核心回归）', r1.status === 1, { status: r1.status })
    check('失败项中包含清理名称', r1.stdout.includes('测试隔离复位（结束 RESET）'), r1.stdout.slice(-200))

    const r2 = runNode(`
const ledger = exitLib.createLedger()
exitLib.record(ledger, '业务断言失败', false)
;(async () => {
  try { await new Promise((r) => setTimeout(r, 1)) } finally {
    await exitLib.cleanupCheck(ledger, '测试隔离复位（结束 RESET）', async () => { throw new Error('boom') })
    exitLib.finalize(ledger, '双重失败')
  }
})()
`)
    check('断言失败 + 清理失败 ⇒ 退出码 1，两条失败项都在',
      r2.status === 1 && r2.stdout.includes('业务断言失败') && r2.stdout.includes('测试隔离复位（结束 RESET）'),
      { status: r2.status })

    const r3 = runNode(`
const ledger = exitLib.createLedger()
exitLib.record(ledger, '业务断言全绿', true)
;(async () => {
  try { await new Promise((r) => setTimeout(r, 1)) } finally {
    await exitLib.cleanupCheck(ledger, '测试隔离复位（结束 RESET）', async () => ({ ok: true, stage: 'IDLE' }))
    await exitLib.safeCleanup('浏览器关闭', async () => { throw new Error('close-boom') })
    exitLib.finalize(ledger, '全绿')
  }
})()
`)
    check('业务全绿 + 浏览器关闭失败 ⇒ 退出码 0（关闭失败只告警）', r3.status === 0, { status: r3.status })
    check('浏览器关闭失败仍有告警输出', r3.stdout.includes('close-boom'), r3.stdout.slice(-160))
  }

  console.log('\n=== 十四、WP-A3.1-D-R1：总截止时间 / 单次 I/O 有限等待 / 迟到拒绝 ===')
  {
    const never = () => new Promise(() => {})
    const realSleep = (ms) => new Promise((r) => setTimeout(r, ms))
    // 每个用例独立 sessionId（在途保护按 session 隔离）
    let dseq = 0
    const base = () => ({ sleep: realSleep, sessionId: `d14-${++dseq}` })

    // ① 前置状态读取挂起
    {
      let cmdCalls = 0
      let threw = null
      const t0 = Date.now()
      try {
        await exitLib.resetToIdle({
          ...base(), timeout: 120, interval: 40,
          demoState: never,
          cmd: async () => { cmdCalls += 1; return { ok: true } },
        })
      } catch (e) { threw = e }
      check('① 前置状态读取挂起 ⇒ RESET_NOT_IDLE(pre-read-timeout)',
        threw instanceof Error && threw.code === 'RESET_NOT_IDLE'
        && String(threw.reason) === 'pre-read-timeout',
        threw && { code: threw.code, reason: threw.reason })
      check('① 前置读超时后不发送 RESET（cmd 调用 0 次）', cmdCalls === 0, { cmdCalls })
      check('① 有限等待：总耗时 < 1000ms', Date.now() - t0 < 1000, { elapsed: Date.now() - t0 })
    }

    // ② RESET 请求挂起
    {
      let threw = null
      const t0 = Date.now()
      try {
        await exitLib.resetToIdle({
          ...base(), timeout: 120, interval: 40,
          demoState: async () => ({ stage: 'FIRE_DETECTED' }),
          cmd: never,
        })
      } catch (e) { threw = e }
      check('② RESET 请求挂起 ⇒ RESET_REQUEST_UNKNOWN',
        threw instanceof Error && threw.code === 'RESET_REQUEST_UNKNOWN', threw && threw.code)
      check('② 明确标注「服务端可能已执行」',
        threw && threw.serverMayHaveExecuted === true, threw && threw.serverMayHaveExecuted)
      check('② 有限等待：总耗时 < 1000ms', Date.now() - t0 < 1000, { elapsed: Date.now() - t0 })
    }

    // ③ RESET 请求超时后不重复发起
    {
      let cmdCalls = 0
      try {
        await exitLib.resetToIdle({
          ...base(), timeout: 100, interval: 30,
          demoState: async () => ({ stage: 'FIRE_DETECTED' }),
          cmd: async () => { cmdCalls += 1; return new Promise(() => {}) },
        })
      } catch (_) { /* 预期抛错 */ }
      await realSleep(200)
      check('③ RESET 超时后不重复发起（cmd 累计调用 = 1）', cmdCalls === 1, { cmdCalls })
    }

    // ④ RESET 后状态读取挂起
    {
      let n = 0
      let threw = null
      try {
        await exitLib.resetToIdle({
          ...base(), timeout: 150, interval: 40,
          demoState: async () => {
            n += 1
            if (n === 1) return { stage: 'FIRE_DETECTED' }
            return never()
          },
          cmd: async () => ({ ok: true }),
        })
      } catch (e) { threw = e }
      check('④ RESET 后状态读取挂起 ⇒ RESET_NOT_IDLE(post-read-timeout)',
        threw instanceof Error && threw.code === 'RESET_NOT_IDLE'
        && String(threw.reason) === 'post-read-timeout',
        threw && { code: threw.code, reason: threw.reason })
    }

    // ⑤ 状态读取超过总截止时间才返回 IDLE ⇒ 拒绝迟到结果
    {
      let clock = 0
      let n = 0
      let threw = null
      try {
        await exitLib.resetToIdle({
          ...base(), timeout: 100, interval: 0, now: () => clock,
          demoState: async () => {
            n += 1
            if (n === 1) return { stage: 'FIRE_DETECTED' }
            clock = 10000                       // 返回时已远超总截止
            return { stage: 'IDLE' }
          },
          cmd: async () => ({ ok: true }),
        })
      } catch (e) { threw = e }
      check('⑤ 迟到的 IDLE 不被接受 ⇒ RESET_NOT_IDLE(post-read-late)',
        threw instanceof Error && threw.code === 'RESET_NOT_IDLE'
        && String(threw.reason) === 'post-read-late',
        threw && { code: threw.code, reason: threw.reason })
    }

    // ⑥ 正常在截止时间内进入 IDLE（对照）
    {
      let n = 0
      const r = await exitLib.resetToIdle({
        ...base(), timeout: 300, interval: 10,
        demoState: async () => { n += 1; return { stage: n === 1 ? 'FIRE_DETECTED' : 'IDLE' } },
        cmd: async () => ({ ok: true }),
      })
      check('⑥ 截止内进入 IDLE ⇒ ok、attempts=1', r.ok === true && r.attempts === 1, r)
    }

    // ⑦ 状态读取异常（非超时）⇒ 原样抛出，不包装成超时
    {
      let n = 0
      let threw = null
      try {
        await exitLib.resetToIdle({
          ...base(), timeout: 300, interval: 10,
          demoState: async () => {
            n += 1
            if (n === 1) return { stage: 'FIRE_DETECTED' }
            throw new Error('state unreadable')
          },
          cmd: async () => ({ ok: true }),
        })
      } catch (e) { threw = e }
      check('⑦ 状态读取异常 ⇒ 抛出原始错误（不被包装成 RESET_NOT_IDLE）',
        threw instanceof Error && threw.message === 'state unreadable' && threw.code === undefined,
        threw && { message: threw.message, code: threw.code })
    }

    // ⑧ 总截止时间优先于单次操作的剩余等待时间
    {
      let reads = 0
      let threw = null
      const t0 = Date.now()
      try {
        await exitLib.resetToIdle({
          ...base(), timeout: 200, interval: 60,
          demoState: async () => { reads += 1; return { stage: 'ROUTE_PLANNING' } },
          cmd: async () => ({ ok: true }),
        })
      } catch (e) { threw = e }
      const elapsed = Date.now() - t0
      check('⑧ 总截止优先 ⇒ deadline-exceeded 且总耗时 < 700ms',
        threw instanceof Error && threw.reason === 'deadline-exceeded' && elapsed < 700,
        threw && { reason: threw.reason, elapsed })
      check('⑧ 复读次数有界（>1 且 ≤6）', reads > 1 && reads <= 6, { reads })
    }

    // ⑨ 超时失败进入统一 ledger
    {
      const ledger = exitLib.createLedger()
      const r = await exitLib.cleanupCheck(ledger, '测试隔离复位（结束 RESET）', async () => {
        await exitLib.resetToIdle({ ...base(), timeout: 80, interval: 20, demoState: never, cmd: async () => ({ ok: true }) })
      }, { log: { log() {} } })
      check('⑨ 超时失败 ⇒ 台账 failed=1 且失败项含名称',
        r.ok === false && ledger.failed === 1 && ledger.failures.includes('测试隔离复位（结束 RESET）'),
        { failed: ledger.failed, failures: ledger.failures })
    }

    // ⑩ 迟到的异步结果不改变已经确定的失败结果
    {
      let resolveLate
      const late = new Promise((res) => { resolveLate = res })
      let threw = null
      try {
        await exitLib.resetToIdle({
          ...base(), timeout: 60, interval: 20,
          demoState: async () => late,
          cmd: async () => ({ ok: true }),
        })
      } catch (e) { threw = e }
      const codeBefore = threw && threw.code
      resolveLate({ stage: 'IDLE' })            // 迟到的 IDLE
      await realSleep(60)
      check('⑩ 迟到结果不改变已确定的失败（仍为 RESET_NOT_IDLE）',
        codeBefore === 'RESET_NOT_IDLE' && threw.code === 'RESET_NOT_IDLE',
        { codeBefore, codeAfter: threw && threw.code })
    }
  }

  console.log('\n=== 十五、WP-A3.1-D-R1 补充：在途 RESET 保护 / 单调时钟 / sleep 预算 ===')
  {
    const realSleep = (ms) => new Promise((r) => setTimeout(r, ms))

    // ① RESET 超时但底层仍 pending ⇒ 第二次调用必须拒绝发起 RESET
    {
      const sid = 'f1-a'
      let cmdCalls = 0
      let firstErr = null
      try {
        await exitLib.resetToIdle({
          sleep: realSleep, timeout: 100, interval: 30, sessionId: sid,
          demoState: async () => ({ stage: 'FIRE_DETECTED' }),
          cmd: () => { cmdCalls += 1; return new Promise(() => {}) },
        })
      } catch (e) { firstErr = e }
      check('① 首次调用因 RESET 未完成而失败（RESET_REQUEST_UNKNOWN）',
        firstErr && firstErr.code === 'RESET_REQUEST_UNKNOWN', firstErr && firstErr.code)

      let secondErr = null
      try {
        await exitLib.resetToIdle({
          sleep: realSleep, timeout: 100, interval: 30, sessionId: sid,
          demoState: async () => ({ stage: 'FIRE_DETECTED' }),
          cmd: () => { cmdCalls += 1; return new Promise(() => {}) },
        })
      } catch (e) { secondErr = e }
      check('① 第二次调用被在途保护拒绝（RESET_INFLIGHT）',
        secondErr && secondErr.code === 'RESET_INFLIGHT', secondErr && secondErr.code)
      check('① 第二次调用未发出新的 RESET（cmd 累计 1 次）', cmdCalls === 1, { cmdCalls })
      check('① 明确标注服务端可能已执行',
        Boolean(secondErr) && secondErr.serverMayHaveExecuted === true)
    }

    // ② 底层请求真正 settle 后，在途保护解除
    {
      const sid = 'f1-b'
      let cmdCalls = 0
      let release
      const gate = new Promise((res) => { release = res })
      try {
        await exitLib.resetToIdle({
          sleep: realSleep, timeout: 80, interval: 20, sessionId: sid,
          demoState: async () => ({ stage: 'FIRE_DETECTED' }),
          cmd: () => { cmdCalls += 1; return gate },
        })
      } catch (_) { /* 预期超时 */ }
      release({ ok: true })
      await realSleep(20)

      const r = await exitLib.resetToIdle({
        sleep: realSleep, timeout: 300, interval: 20, sessionId: sid,
        demoState: async () => ({ stage: 'IDLE' }),
        cmd: () => { cmdCalls += 1; return Promise.resolve({ ok: true }) },
      })
      check('② settle 后在途保护解除（本次调用正常返回）', r.ok === true, r)
      check('② 解除后不再抛 RESET_INFLIGHT（未额外发送 RESET）', cmdCalls === 1, { cmdCalls })
    }

    // ③ 迟到 resolve 不改变第一次调用的超时结果
    {
      const sid = 'f1-c'
      let release
      const gate = new Promise((res) => { release = res })
      let firstErr = null
      try {
        await exitLib.resetToIdle({
          sleep: realSleep, timeout: 80, interval: 20, sessionId: sid,
          demoState: async () => ({ stage: 'FIRE_DETECTED' }),
          cmd: () => gate,
        })
      } catch (e) { firstErr = e }
      const codeBefore = firstErr && firstErr.code
      release({ ok: true, stage: 'IDLE' })
      await realSleep(30)
      check('③ 迟到 resolve 不改变已确定的超时结果',
        codeBefore === 'RESET_REQUEST_UNKNOWN' && firstErr.code === 'RESET_REQUEST_UNKNOWN',
        { codeBefore, codeAfter: firstErr && firstErr.code })
    }

    // ④ 迟到 reject 不产生未处理拒绝、也不改变结果（子进程）
    {
      const r = runNode(`
process.on('unhandledRejection', (e) => { console.log('UNHANDLED:' + (e && e.message)); process.exit(9) })
;(async () => {
  let release
  const gate = new Promise((_, rej) => { release = rej })
  let err = null
  try {
    await exitLib.resetToIdle({
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      timeout: 60, interval: 20, sessionId: 'f1-d',
      demoState: async () => ({ stage: 'FIRE_DETECTED' }),
      cmd: () => gate,
    })
  } catch (e) { err = e }
  release(new Error('late-reject'))
  await new Promise((r) => setTimeout(r, 80))
  console.log('CODE=' + (err && err.code))
  process.exit(err && err.code === 'RESET_REQUEST_UNKNOWN' ? 0 : 3)
})().catch((e) => { console.log('OUTER:' + e.message); process.exit(4) })
`)
      check('④ 迟到 reject 不产生未处理拒绝且不改变结果',
        r.status === 0 && r.stdout.includes('CODE=RESET_REQUEST_UNKNOWN'),
        { status: r.status, out: r.stdout.slice(-120) })
    }

    // ⑤ 默认时钟不使用 Date.now()
    {
      const originalNow = Date.now
      let dateNowCalls = 0
      Date.now = () => { dateNowCalls += 1; return originalNow() }
      let r = null
      try {
        r = await exitLib.resetToIdle({
          sleep: async () => {}, timeout: 300, interval: 10, sessionId: 'f2-a',
          demoState: async () => ({ stage: 'IDLE' }),
          cmd: async () => ({ ok: true }),
        })
      } finally { Date.now = originalNow }
      check('⑤ 默认时钟不使用 Date.now()（禁用后仍能正常完成）',
        Boolean(r) && r.ok === true && dateNowCalls === 0, { dateNowCalls })
    }
    {
      const src = readFileSync(path.join(__dirname, 'e2e-exit.cjs'), 'utf8')
      check('⑤ e2e-exit.cjs 使用 node:perf_hooks 的 performance.now()',
        /require\('node:perf_hooks'\)/.test(src) && /performance\.now\(\)/.test(src))
      check('⑤ resetToIdle 默认时钟参数不是 Date.now()',
        !/now\s*=\s*\(\)\s*=>\s*Date\.now\(\)/.test(src) && !/now\s*=\s*Date\.now/.test(src))
    }

    // ⑥ 注入时钟推进后总截止时间正确
    {
      let clock = 0
      let reads = 0
      let threw = null
      try {
        await exitLib.resetToIdle({
          sleep: async () => { clock += 100 },
          timeout: 100, interval: 100, now: () => clock, sessionId: 'f2-b',
          demoState: async () => {
            reads += 1
            return { stage: reads === 1 ? 'FIRE_DETECTED' : 'ROUTE_PLANNING' }
          },
          cmd: async () => ({ ok: true }),
        })
      } catch (e) { threw = e }
      check('⑥ 注入时钟推进到 deadline ⇒ deadline-exceeded（不越过总截止）',
        Boolean(threw) && threw.reason === 'deadline-exceeded', threw && { reason: threw.reason, reads })
    }

    // ⑦⑧⑨ sleep 不得超过剩余预算；截断后不再读取、不得误报 IDLE
    {
      const t0 = Date.now()
      let reads = 0
      let threw = null
      try {
        await exitLib.resetToIdle({
          sleep: realSleep, timeout: 120, interval: 5000, sessionId: 'f3-a',
          demoState: async () => { reads += 1; return { stage: 'ROUTE_PLANNING' } },
          cmd: async () => ({ ok: true }),
        })
      } catch (e) { threw = e }
      const elapsed = Date.now() - t0
      check('⑦ sleep 被截断到剩余预算（总耗时 < 700ms，而非 5000ms）', elapsed < 700, { elapsed })
      check('⑦ 截断后返回明确的截止失败', Boolean(threw) && threw.reason === 'deadline-exceeded',
        threw && threw.reason)
      check('⑧ 截断后不再进入下一次状态读取（reads = 2：前置 1 + 复读 1）', reads === 2, { reads })
      check('⑨ 截断后不得误报 IDLE 成功', Boolean(threw) && threw.code === 'RESET_NOT_IDLE',
        threw && threw.code)
    }
  }

  console.log('\n=== 十六、WP-A3.1-D-R1.2：并发门禁 / sleep 实际等待 / settle 后重发 ===')
  {
    const realSleep = (ms) => new Promise((r) => setTimeout(r, ms))

    // R4：同一 session 的 Promise.all 并发 —— 只允许 1 次 RESET
    {
      const sid = 'g-a'
      let cmdCalls = 0
      let bCmdSnapshot = -1
      const opts = () => ({
        sleep: realSleep, timeout: 400, interval: 30, sessionId: sid,
        // pre-read 故意慢 60ms，使两次调用在 pre-read 期间真实重叠
        demoState: async () => {
          await realSleep(60)
          return { stage: cmdCalls === 0 ? 'FIRE_DETECTED' : 'IDLE' }
        },
        cmd: async () => { cmdCalls += 1; return { ok: true } },
      })
      const pa = exitLib.resetToIdle(opts())
      const pb = exitLib.resetToIdle(opts())
      pb.catch(() => { bCmdSnapshot = cmdCalls })
      const [ra, rb] = await Promise.allSettled([pa, pb])

      check('R4 并发调用中恰好一个成功',
        ra.status === 'fulfilled' && ra.value.ok === true, { status: ra.status })
      check('R4 另一个被并发门禁拒绝（RESET_CONCURRENT）',
        rb.status === 'rejected' && rb.reason && rb.reason.code === 'RESET_CONCURRENT',
        rb.status === 'rejected' ? rb.reason.code : rb.status)
      check('R4 全程只发送 1 次 RESET', cmdCalls === 1, { cmdCalls })
      check('R4 被拒方在 pre-read 期间即被拦下（当时尚未发出 RESET）',
        bCmdSnapshot === 0, { bCmdSnapshot })
      check('R4 被拒方明确标注状态不确定',
        rb.status === 'rejected' && rb.reason.serverMayHaveExecuted === true)
    }

    // R3：settle 之后确实**重新发送** RESET（不只是"跳过"）
    {
      const sid = 'g-b'
      let cmdCalls = 0
      let release
      const gate = new Promise((res) => { release = res })
      try {
        await exitLib.resetToIdle({
          sleep: realSleep, timeout: 80, interval: 20, sessionId: sid,
          demoState: async () => ({ stage: 'FIRE_DETECTED' }),
          cmd: () => { cmdCalls += 1; return gate },
        })
      } catch (_) { /* 预期超时 */ }
      check('R3 第一次调用确实发出过 1 次 RESET', cmdCalls === 1, { cmdCalls })

      release({ ok: true })
      await realSleep(20)

      let reads = 0
      const r = await exitLib.resetToIdle({
        sleep: realSleep, timeout: 400, interval: 20, sessionId: sid,
        demoState: async () => {
          reads += 1
          return { stage: reads === 1 ? 'FIRE_DETECTED' : 'IDLE' }
        },
        cmd: async () => { cmdCalls += 1; return { ok: true } },
      })
      check('R3 settle 后第二次调用**重新发送**了 RESET（cmd 累计 2）', cmdCalls === 2, { cmdCalls })
      check('R3 第二次调用真正成功（非 skipped）',
        r.ok === true && r.skipped === false, r)
    }

    // R2：sleep 的**实际等待**受总截止约束（注入 sleep 故意过冲）
    {
      const sid = 'g-c'
      let reads = 0
      let threw = null
      try {
        await exitLib.resetToIdle({
          // 请求 120ms，实际睡 420ms（过冲 300ms）
          sleep: (ms) => new Promise((r) => setTimeout(r, ms + 300)),
          timeout: 120, interval: 5000, sessionId: sid,
          demoState: async () => { reads += 1; return { stage: 'ROUTE_PLANNING' } },
          cmd: async () => ({ ok: true }),
        })
      } catch (e) { threw = e }
      check('R2 sleep 实际过冲后不再发起新的状态读取（reads = 2）', reads === 2, { reads })
      check('R2 过冲后返回明确的总截止失败',
        Boolean(threw) && threw.reason === 'deadline-exceeded', threw && { reason: threw.reason })
      check('R2 过冲后不得误报 IDLE 成功',
        Boolean(threw) && threw.code === 'RESET_NOT_IDLE', threw && threw.code)
    }
  }

  console.log('\n=== 十七、WP-A3.1-D-R1.3：sleep 本身受总截止约束 ===')
  {
    const realSleep = (ms) => new Promise((r) => setTimeout(r, ms))
    const never = () => new Promise(() => {})

    // ① sleep 过冲：函数应在 deadline 附近结束，而不是等完整的过冲时间
    {
      const sid = 'h-a'
      let reads = 0
      let result = null
      let threw = null
      const t0 = Date.now()
      try {
        result = await exitLib.resetToIdle({
          // 请求 150ms，实际睡 950ms（过冲 800ms）
          sleep: (ms) => new Promise((r) => setTimeout(r, ms + 800)),
          timeout: 150, interval: 5000, sessionId: sid,
          demoState: async () => { reads += 1; return { stage: 'ROUTE_PLANNING' } },
          cmd: async () => ({ ok: true }),
        })
      } catch (e) { threw = e }
      const elapsed = Date.now() - t0
      check('R2-1 sleep 过冲时函数在 deadline 附近结束（< 600ms，而非约 950ms）',
        elapsed < 600, { elapsed })
      check('R2-3 sleep 超时后不再发起新的状态读取（reads = 2）', reads === 2, { reads })
      check('R2-4 错误为 RESET_NOT_IDLE 且 reason = deadline-exceeded',
        Boolean(threw) && threw.code === 'RESET_NOT_IDLE' && threw.reason === 'deadline-exceeded',
        threw && { code: threw.code, reason: threw.reason })
      check('R2-5 绝不误报成功（未返回 ok:true）',
        result === null || result.ok !== true, { result })
    }

    // ② sleep 永不 resolve：仍能在 deadline 耗尽后失败（不挂死）
    {
      const sid = 'h-b'
      let reads = 0
      let threw = null
      const t0 = Date.now()
      try {
        await exitLib.resetToIdle({
          sleep: never,
          timeout: 150, interval: 5000, sessionId: sid,
          demoState: async () => { reads += 1; return { stage: 'ROUTE_PLANNING' } },
          cmd: async () => ({ ok: true }),
        })
      } catch (e) { threw = e }
      const elapsed = Date.now() - t0
      check('R2-2 sleep 永不 resolve ⇒ 仍在 deadline 附近失败（< 600ms）', elapsed < 600, { elapsed })
      check('R2-2 不进入下一轮读取（reads = 2）', reads === 2, { reads })
      check('R2-2 错误语义正确（RESET_NOT_IDLE / deadline-exceeded）',
        Boolean(threw) && threw.code === 'RESET_NOT_IDLE' && threw.reason === 'deadline-exceeded',
        threw && { code: threw.code, reason: threw.reason })
    }

    // ③ R1 回归：sleep 超时不会破坏 activeResets 的 finally 释放
    {
      const sid = 'h-c'
      try {
        await exitLib.resetToIdle({
          sleep: never, timeout: 120, interval: 5000, sessionId: sid,
          demoState: async () => ({ stage: 'ROUTE_PLANNING' }),
          cmd: async () => ({ ok: true }),
        })
      } catch (_) { /* 预期 sleep 超时 */ }

      let reads = 0
      const r = await exitLib.resetToIdle({
        sleep: realSleep, timeout: 400, interval: 20, sessionId: sid,
        demoState: async () => {
          reads += 1
          return { stage: reads === 1 ? 'FIRE_DETECTED' : 'IDLE' }
        },
        cmd: async () => ({ ok: true }),
      })
      check('R1 回归：sleep 超时后 activeResets 已释放（同 session 可再次执行）', r.ok === true, r)
    }

    // ④ R1 在途回归：未 settle 的 RESET 记录不会被任何退出路径解除
    {
      const sid = 'h-d'
      let cmdCalls = 0
      let release
      const gate = new Promise((res) => { release = res })
      try {
        await exitLib.resetToIdle({
          sleep: realSleep, timeout: 80, interval: 20, sessionId: sid,
          demoState: async () => ({ stage: 'FIRE_DETECTED' }),
          cmd: () => { cmdCalls += 1; return gate },
        })
      } catch (_) { /* 预期 RESET 超时 */ }

      let secondErr = null
      try {
        await exitLib.resetToIdle({
          sleep: never, timeout: 120, interval: 5000, sessionId: sid,
          demoState: async () => ({ stage: 'FIRE_DETECTED' }),
          cmd: () => { cmdCalls += 1; return gate },
        })
      } catch (e) { secondErr = e }
      check('R1 在途回归：入口保护先于读取/等待生效（RESET_INFLIGHT）',
        secondErr && secondErr.code === 'RESET_INFLIGHT', secondErr && secondErr.code)
      check('R1 在途回归：退出路径未解除在途保护（未发出新的 RESET）',
        cmdCalls === 1, { cmdCalls })

      release({ ok: true })
      await realSleep(20)
    }

    // ⑤ sleep 抛错：保留原始异常语义（不被包装成 deadline-exceeded）
    {
      const sid = 'h-e'
      let threw = null
      try {
        await exitLib.resetToIdle({
          sleep: async () => { throw new Error('sleep-boom') },
          timeout: 300, interval: 10, sessionId: sid,
          demoState: async () => ({ stage: 'ROUTE_PLANNING' }),
          cmd: async () => ({ ok: true }),
        })
      } catch (e) { threw = e }
      check('R2-6 sleep 抛错 ⇒ 原样抛出原始异常（不包装成超时）',
        threw instanceof Error && threw.message === 'sleep-boom' && threw.code === undefined,
        threw && { message: threw.message, code: threw.code })
    }
  }

  console.log('\n=== 十八、WP-A3.2：e2e-lib 公共 cleanupCheck 接口（绑定 results） ===')
  {
    // e2e-lib.cjs 顶层 require('playwright-core')。
    // 这里用 Module._load 注入占位实现，使得在「无 worker 依赖」的环境（CI unit 作业）
    // 也能加载**真实的** e2e-lib 模块并测试其公共导出，而不是伪造一个同名函数。
    const Module = require('node:module')
    const origLoad = Module._load
    let lib = null
    let loadErr = null
    Module._load = function (request, parent, isMain) {
      if (request === 'playwright-core') {
        return { chromium: { launch: async () => ({ newPage: async () => ({}), close: async () => {} }) } }
      }
      return origLoad.apply(this, arguments)
    }
    try {
      lib = require('./e2e-lib.cjs')
    } catch (e) {
      loadErr = e
    } finally {
      Module._load = origLoad
    }
    check('十八·加载 e2e-lib 公共导出（playwright-core 以占位替代）',
      Boolean(lib) && typeof lib.cleanupCheck === 'function',
      loadErr && loadErr.message)

    if (!lib) {
      check('十八·后续用例因模块加载失败而跳过', false, loadErr && loadErr.message)
    } else {
      const silent = { log() {} }
      const p0 = lib.results.passed
      const f0 = lib.results.failed

      // ① 成功清理：不抛异常，且成功被记入台账
      let okRes = null
      let okThrew = null
      try {
        okRes = await lib.cleanupCheck('wp-a3.2 成功用例', async () => {}, { log: silent })
      } catch (e) { okThrew = e }
      check('十八·① 公共 cleanupCheck 成功时不抛异常', okThrew === null, okThrew && okThrew.message)
      check('十八·① 返回 {ok:true} 且台账 passed +1 / failed 不变',
        Boolean(okRes) && okRes.ok === true
        && lib.results.passed === p0 + 1 && lib.results.failed === f0,
        { passed: lib.results.passed, failed: lib.results.failed })

      // ② 清理动作失败：不得因参数错位抛 TypeError，且失败要入账
      let failRes = null
      let failThrew = null
      try {
        failRes = await lib.cleanupCheck('wp-a3.2 失败用例', async () => {
          throw new Error('cleanup-boom')
        }, { log: silent })
      } catch (e) { failThrew = e }
      check('十八·② 失败用例不抛异常（参数错位会抛 TypeError，此处必须为 null）',
        failThrew === null, failThrew && (failThrew.name + ': ' + failThrew.message))
      check('十八·② 返回 {ok:false} 且原始错误被保留',
        Boolean(failRes) && failRes.ok === false
        && failRes.error instanceof Error && failRes.error.message === 'cleanup-boom',
        failRes && { ok: failRes.ok, err: failRes.error && failRes.error.message })
      check('十八·② 失败已写入台账 failures（failed +1）',
        lib.results.failed === f0 + 1
        && lib.results.failures.includes('wp-a3.2 失败用例'),
        { failed: lib.results.failed, failures: lib.results.failures })

      // ③ 退出码：清理失败必须能抬升为 1
      check('十八·③ 清理失败后 exitCodeFor(results) === 1',
        exitLib.exitCodeFor(lib.results) === 1, exitLib.exitCodeFor(lib.results))

      // ④ 接口兼容：check / safeCleanup / 既有导出不受影响
      const p1 = lib.results.passed
      const cRet = lib.check('wp-a3.2 兼容：check 仍可用', true)
      check('十八·④ check 仍返回布尔并记入台账',
        cRet === true && lib.results.passed === p1 + 1, { cRet })
      const sc = await lib.safeCleanup('wp-a3.2 兼容：safeCleanup', async () => 7)
      check('十八·④ safeCleanup 契约不变（{ok:true, value:7}）',
        Boolean(sc) && sc.ok === true && sc.value === 7, sc)
      check('十八·④ 既有导出未被移除',
        ['check', 'summary', 'safeCleanup', 'cleanupCheck', 'resetToIdle', 'results', 'cmd', 'demoState']
          .every((k) => lib[k] !== undefined))
      check('十八·④ 公共 cleanupCheck 为绑定包装（形参 2 个，底层为 3 个）',
        lib.cleanupCheck.length === 2 && exitLib.cleanupCheck.length === 3,
        { wrapper: lib.cleanupCheck.length, base: exitLib.cleanupCheck.length })
    }
  }
}

runAsyncChecks()
  .catch((e) => {
    console.error('异步检查异常：', e)
    failed += 1
    failedNames.push(`异步检查异常：${e && e.message ? e.message : e}`)
  })
  .then(() => {
    console.log(`\n=== 退出码单元验证：${pass} 通过 / ${failed} 失败 ===`)
    if (failed) console.log('失败项：\n  - ' + failedNames.join('\n  - '))
    process.exit(failed ? 1 : 0)
  })

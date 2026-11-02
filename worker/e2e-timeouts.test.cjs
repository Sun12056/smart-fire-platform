'use strict'
/**
 * WP-A3.3 / R1 纯 Node 测试：统一超时机制
 * ────────────────────────────────────────────────
 * 覆盖：evaluateWithTimeout / waitFor（单次检查 + 整体截止 + R-C 分层阈值）/
 *       api（AbortSignal + R-B 外部 signal 合并）/ openPage（就绪失败必须抛错并关闭浏览器）/
 *       installEvalTimeout（R-A 属性语义）。
 *
 * 不启动浏览器：用 Module._load 注入 playwright-core 占位实现，
 * 加载**真实的** e2e-lib 模块并调用其公共导出。
 */
const Module = require('node:module')
const { setTimeout: delay } = require('node:timers/promises')

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

// ── 加载真实的 e2e-lib（仅替代 playwright-core） ──
const holder = { launch: async () => ({ newPage: async () => ({ on() {}, goto: async () => {}, evaluate: async () => true }), close: async () => {} }) }
const origLoad = Module._load
let lib = null
let loadErr = null
Module._load = function (request, parent, isMain) {
  if (request === 'playwright-core') {
    return { chromium: { launch: (...args) => holder.launch(...args) } }
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

console.log('\n=== 零、模块加载 ===')
check('可从 e2e-lib 加载超时相关导出',
  Boolean(lib) && typeof lib.evaluateWithTimeout === 'function' && typeof lib.waitFor === 'function'
  && typeof lib.installEvalTimeout === 'function' && typeof lib.api === 'function'
  && typeof lib.resolvePerCheckTimeout === 'function',
  loadErr && loadErr.message)

;(async () => {
  console.log('\n=== 一、evaluateWithTimeout ===')
  {
    const okPage = { evaluate: async () => 42 }
    const v = await lib.evaluateWithTimeout(okPage, () => 1, undefined, { timeoutMs: 500 })
    check('① 正常返回透传结果', v === 42, v)

    let calls = 0
    const hangPage = { evaluate: () => { calls += 1; return new Promise(() => {}) } }
    let err = null
    const t0 = Date.now()
    try {
      await lib.evaluateWithTimeout(hangPage, () => 1, undefined, { timeoutMs: 120 })
    } catch (e) { err = e }
    const elapsed = Date.now() - t0
    check('② 永不返回 ⇒ EVAL_TIMEOUT', Boolean(err) && err.code === 'EVAL_TIMEOUT', err && err.code)
    check('② 在截止时间附近抛错（< 800ms）', elapsed < 800, { elapsed })
    check('② 超时后不重试（evaluate 仅调用 1 次）', calls === 1, { calls })
    check('② 错误对象声明「底层未取消」', Boolean(err) && /并未被取消/.test(err.message), err && err.message)

    let rejections = 0
    const onRej = () => { rejections += 1 }
    process.on('unhandledRejection', onRej)
    let resolveLate
    const latePage = { evaluate: () => new Promise((res) => { resolveLate = res }) }
    let lateErr = null
    try {
      await lib.evaluateWithTimeout(latePage, () => 1, undefined, { timeoutMs: 80 })
    } catch (e) { lateErr = e }
    const codeBefore = lateErr && lateErr.code
    resolveLate('迟到结果')
    await delay(60)
    process.removeListener('unhandledRejection', onRej)
    check('③ 迟到 resolve 不改变已确定的超时结果',
      codeBefore === 'EVAL_TIMEOUT' && lateErr.code === 'EVAL_TIMEOUT',
      { codeBefore, codeAfter: lateErr && lateErr.code })
    check('③ 迟到结果不产生未处理拒绝', rejections === 0, { rejections })

    const throwPage = { evaluate: () => { throw new Error('boom-sync') } }
    let syncErr = null
    try {
      await lib.evaluateWithTimeout(throwPage, () => 1, undefined, { timeoutMs: 200 })
    } catch (e) { syncErr = e }
    check('④ 同步抛错 ⇒ EVAL_FAILED 且保留原因',
      Boolean(syncErr) && syncErr.code === 'EVAL_FAILED' && /boom-sync/.test(syncErr.message),
      syncErr && syncErr.code)

    let noPageErr = null
    try { await lib.evaluateWithTimeout(null, () => 1) } catch (e) { noPageErr = e }
    check('⑤ 无效 page ⇒ EVAL_NO_PAGE', Boolean(noPageErr) && noPageErr.code === 'EVAL_NO_PAGE',
      noPageErr && noPageErr.code)
  }

  console.log('\n=== 二、waitFor（单次检查超时 + 整体截止 + R-C 分层） ===')
  {
    const t0 = Date.now()
    const ok = await lib.waitFor(() => true, 1000, 50, { perCheckTimeout: 200 })
    check('① 立即为真 ⇒ true 且很快返回', ok === true && Date.now() - t0 < 300, { ok })

    let calls = 0
    const t1 = Date.now()
    const never = await lib.waitFor(() => { calls += 1; return false }, 250, 50, { perCheckTimeout: 200 })
    const elapsed = Date.now() - t1
    check('② 始终为假 ⇒ 整体截止后返回 false', never === false, { never })
    check('② 整体耗时有界（< 1200ms）且确实多次检查', elapsed < 1200 && calls > 1, { elapsed, calls })

    let hangCalls = 0
    let hangErr = null
    const t2 = Date.now()
    try {
      await lib.waitFor(() => { hangCalls += 1; return new Promise(() => {}) }, 5000, 50, { perCheckTimeout: 100 })
    } catch (e) { hangErr = e }
    const elapsed2 = Date.now() - t2
    check('③ 单次检查挂起 ⇒ CHECK_TIMEOUT', Boolean(hangErr) && hangErr.code === 'CHECK_TIMEOUT',
      hangErr && hangErr.code)
    check('③ 不进入下一轮检查（仅 1 次）', hangCalls === 1, { hangCalls })
    check('③ 单次检查超时不等待整体截止（< 1200ms）', elapsed2 < 1200, { elapsed: elapsed2 })

    let realErr = null
    try { await lib.waitFor(() => { throw new Error('check-boom') }, 500, 50, { perCheckTimeout: 200 }) } catch (e) { realErr = e }
    check('④ 检查函数抛错 ⇒ 原样传播', Boolean(realErr) && /check-boom/.test(realErr.message),
      realErr && realErr.message)

    // R-C：分层阈值（纯函数）
    check('R-C 短等待（8s）沿用 5s 单次阈值',
      lib.resolvePerCheckTimeout(undefined, 8000) === 5000, lib.resolvePerCheckTimeout(undefined, 8000))
    check('R-C 长等待（40s）放宽到 15s 单次阈值',
      lib.resolvePerCheckTimeout(undefined, 40000) === 15000, lib.resolvePerCheckTimeout(undefined, 40000))
    check('R-C 边界（30s）按长等待处理',
      lib.resolvePerCheckTimeout(undefined, 30000) === 15000, lib.resolvePerCheckTimeout(undefined, 30000))
    check('R-C 显式 perCheckTimeout 优先于分层',
      lib.resolvePerCheckTimeout(2000, 40000) === 2000, lib.resolvePerCheckTimeout(2000, 40000))
    check('R-C 未统一放宽：20s 等待仍是 5s',
      lib.resolvePerCheckTimeout(undefined, 20000) === 5000, lib.resolvePerCheckTimeout(undefined, 20000))
  }

  console.log('\n=== 三、api（AbortSignal + 超时 + R-B 外部 signal） ===')
  {
    const okRes = await lib.api('/x', {
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ hello: 1 }) }),
      timeoutMs: 500,
    })
    check('① 正常返回 JSON', okRes && okRes.hello === 1, okRes)

    let httpErr = null
    try {
      await lib.api('/x', { fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }), timeoutMs: 500 })
    } catch (e) { httpErr = e }
    check('② 非 2xx ⇒ 抛出含 HTTP 状态', Boolean(httpErr) && /HTTP 503/.test(httpErr.message),
      httpErr && httpErr.message)

    let capturedSignal = null
    let fetchCalls = 0
    let apiErr = null
    const t0 = Date.now()
    try {
      await lib.api('/x', {
        timeoutMs: 120,
        fetchImpl: (url, init) => { fetchCalls += 1; capturedSignal = init && init.signal; return new Promise(() => {}) },
      })
    } catch (e) { apiErr = e }
    check('③ 永不返回 ⇒ API_TIMEOUT', Boolean(apiErr) && apiErr.code === 'API_TIMEOUT', apiErr && apiErr.code)
    check('③ 超时后底层请求已被 abort（signal.aborted === true）',
      Boolean(capturedSignal) && capturedSignal.aborted === true,
      capturedSignal && { aborted: capturedSignal.aborted })
    check('③ 超时不重试（fetch 仅 1 次）', fetchCalls === 1, { fetchCalls })
    check('③ 耗时有界（< 800ms）', Date.now() - t0 < 800, { elapsed: Date.now() - t0 })

    let overrideErr = null
    const t1 = Date.now()
    try {
      await lib.api('/x', { timeoutMs: 80, fetchImpl: () => new Promise(() => {}) })
    } catch (e) { overrideErr = e }
    check('④ timeoutMs 覆盖生效（< 800ms）',
      Boolean(overrideErr) && overrideErr.code === 'API_TIMEOUT' && Date.now() - t1 < 800,
      { elapsed: Date.now() - t1 })

    // R-B-1：外部 signal 主动 abort ⇒ 请求取消，且错误不是 API_TIMEOUT
    {
      const ac = new AbortController()
      let err2 = null
      const p = lib.api('/x', {
        timeoutMs: 5000,
        signal: ac.signal,
        fetchImpl: (url, init) => new Promise((_, rej) => {
          init.signal.addEventListener('abort', () => {
            const e = new Error('aborted-by-caller')
            e.name = 'AbortError'
            rej(e)
          })
        }),
      })
      setTimeout(() => ac.abort(), 60)
      try { await p } catch (e) { err2 = e }
      check('R-B 外部 signal abort ⇒ 请求被取消（错误非 API_TIMEOUT）',
        Boolean(err2) && err2.code !== 'API_TIMEOUT' && /aborted-by-caller/.test(err2.message || ''),
        err2 && { name: err2.name, code: err2.code, msg: err2.message })
    }

    // R-B-2：外部 signal 与内部超时合并后，内部超时仍生效
    {
      const ac = new AbortController()
      let captured = null
      let err3 = null
      try {
        await lib.api('/x', {
          timeoutMs: 100,
          signal: ac.signal,
          fetchImpl: (url, init) => { captured = init.signal; return new Promise(() => {}) },
        })
      } catch (e) { err3 = e }
      check('R-B 合并后内部超时仍触发 API_TIMEOUT 且 abort 生效',
        Boolean(err3) && err3.code === 'API_TIMEOUT' && captured && captured.aborted === true,
        { code: err3 && err3.code, aborted: captured && captured.aborted })
      check('R-B 合并 signal 与外部 signal 不是同一对象（组合语义）',
        Boolean(captured) && captured !== ac.signal, { same: captured === ac.signal })
    }

    // R-B-3：外部 signal 已提前 abort ⇒ 不发起请求
    {
      const ac = new AbortController()
      ac.abort()
      let calls2 = 0
      let err4 = null
      try {
        await lib.api('/x', {
          signal: ac.signal,
          fetchImpl: () => { calls2 += 1; return Promise.resolve({ ok: true, status: 200, json: async () => ({}) }) },
        })
      } catch (e) { err4 = e }
      check('R-B 外部 signal 已 abort ⇒ 不发起请求（fetch 0 次）', calls2 === 0, { calls2 })
      check('R-B 外部 signal 已 abort ⇒ API_ABORTED',
        Boolean(err4) && err4.code === 'API_ABORTED', err4 && err4.code)
    }

    // R-B-4：带 signal 的正常请求仍成功
    {
      const ac = new AbortController()
      const r = await lib.api('/x', {
        signal: ac.signal,
        timeoutMs: 500,
        fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ ok: 1 }) }),
      })
      check('R-B 带 signal 的正常请求仍成功', r && r.ok === 1, r)
    }
  }

  console.log('\n=== 四、openPage 与 R-A 属性语义 ===')
  {
    let closeCount = 0
    holder.launch = async () => ({
      newPage: async () => ({ on() {}, goto: async () => {}, evaluate: async () => false }),
      close: async () => { closeCount += 1 },
    })
    let notReadyErr = null
    const t0 = Date.now()
    try {
      await lib.openPage({ readyTimeoutMs: 300 })
    } catch (e) { notReadyErr = e }
    check('① 页面不就绪 ⇒ 抛 PAGE_NOT_READY',
      Boolean(notReadyErr) && notReadyErr.code === 'PAGE_NOT_READY', notReadyErr && notReadyErr.code)
    check('① 不就绪时不返回未就绪 page（确实抛错，未 return）', Boolean(notReadyErr))
    check('① 浏览器已被关闭（避免泄漏）', closeCount === 1, { closeCount })
    check('① 就绪等待有界（< 2000ms）', Date.now() - t0 < 2000, { elapsed: Date.now() - t0 })

    closeCount = 0
    holder.launch = async () => ({
      newPage: async () => ({ on() {}, goto: async () => {}, evaluate: async () => true }),
      close: async () => { closeCount += 1 },
    })
    const opened = await lib.openPage({ readyTimeoutMs: 300 })
    check('② 就绪成功 ⇒ 返回 {browser,page,logs}', Boolean(opened && opened.page && opened.browser))
    check('② page.evaluate 已被安装超时守卫', opened.page.__evalTimeoutInstalled === true)

    // R-A：属性描述符语义
    check('R-A Object.keys(page) 不含 evaluate',
      !Object.keys(opened.page).includes('evaluate'), Object.keys(opened.page))
    const desc = Object.getOwnPropertyDescriptor(opened.page, 'evaluate')
    check('R-A evaluate 描述符 enumerable:false / writable:true / configurable:true',
      Boolean(desc) && desc.enumerable === false && desc.writable === true && desc.configurable === true,
      desc && { enumerable: desc.enumerable, writable: desc.writable, configurable: desc.configurable })
    const wrappedVal = await opened.page.evaluate(() => 1)
    check('R-A 包装后仍可正常求值', wrappedVal === true || wrappedVal !== undefined, { wrappedVal })

    const before = opened.page.evaluate
    lib.installEvalTimeout(opened.page)
    check('R-A 重复安装仍然幂等（函数未被替换）', opened.page.evaluate === before)

    const hangPage = { evaluate: () => new Promise(() => {}) }
    lib.installEvalTimeout(hangPage, { timeoutMs: 80 })
    let guardErr = null
    try { await hangPage.evaluate(() => 1) } catch (e) { guardErr = e }
    check('R-A 守卫对挂起 evaluate 仍生效（EVAL_TIMEOUT）',
      Boolean(guardErr) && guardErr.code === 'EVAL_TIMEOUT', guardErr && guardErr.code)
    check('R-A 守卫安装后 evaluate 不可枚举', !Object.keys(hangPage).includes('evaluate'), Object.keys(hangPage))
  }

  console.log(`\n=== WP-A3.3-R1 超时机制测试：${pass} 通过 / ${failed} 失败 ===`)
  if (failed) console.log('失败项：\n  - ' + failedNames.join('\n  - '))
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error('异步测试异常：', e)
  process.exit(1)
})

#!/usr/bin/env node
// AUTH-3 · Pages 全站访问保护本地测试
// 仅本地：esbuild 打包 functions/_middleware.ts，注入 stub Service Binding。
// 不连接任何 Cloudflare 资源，不部署。

import { createRequire } from 'node:module'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TRIAL_DIR = resolve(__dirname, '..')
const WORKER_DIR = resolve(TRIAL_DIR, '..', 'worker')
const requireFromWorker = createRequire(join(WORKER_DIR, 'package.json'))
const { build } = requireFromWorker('esbuild')

const ORIGIN = 'https://trial.example'
const outdir = mkdtempSync(join(tmpdir(), 'auth3-'))
const outfile = join(outdir, 'middleware.mjs')

const result = await build({
  entryPoints: [join(TRIAL_DIR, 'functions', '_middleware.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  write: false,
  logLevel: 'silent',
})
writeFileSync(outfile, result.outputFiles[0].text)
const { onRequest } = await import(pathToFileURL(outfile).href)

// ── 测试框架 ────────────────────────────────────────────────────────────────
let passed = 0
let failed = 0
const failures = []

function ok(cond, detail) {
  if (!cond) throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail))
}

async function test(id, name, fn) {
  try {
    await fn()
    passed++
    console.log(`  ✓ ${id} ${name}`)
  } catch (e) {
    failed++
    failures.push({ id, name, error: e.message })
    console.log(`  ✗ ${id} ${name} → ${e.message}`)
  }
}

// ── 辅助 ────────────────────────────────────────────────────────────────────
function makeCtx({ path = '/', method = 'GET', cookie, api, nextImpl }) {
  const url = ORIGIN + path
  const headers = {}
  if (cookie) headers.cookie = cookie
  const request = new Request(url, { method, headers })
  const env = api === undefined ? {} : { API: api }
  const tracker = { calls: 0 }
  const next = async () => {
    tracker.calls++
    if (nextImpl) return nextImpl()
    return new Response('APP_OK', { status: 200, headers: { 'Content-Type': 'text/plain' } })
  }
  return { ctx: { request, env, next }, tracker }
}

function apiStub(status, opts = {}) {
  const captured = []
  return {
    captured,
    async fetch(req) {
      captured.push(req)
      if (opts.throw) throw new Error('SERVICE_BINDING_DOWN')
      if (opts.delay) await new Promise((r) => setTimeout(r, opts.delay))
      return new Response('{"ok":true}', { status, headers: { 'Content-Type': 'application/json' } })
    },
  }
}

const COOKIE = 'sf_session=' + 'A'.repeat(43)

// ═══════════════════════════════════════════════════════════════════════════
console.log('=== AUTH-3 · 未认证访问 ===')
// ═══════════════════════════════════════════════════════════════════════════

await test('A3-1', '未认证访问首页 → 302 /login', async () => {
  const { ctx, tracker } = makeCtx({ path: '/', api: apiStub(401) })
  const res = await onRequest(ctx)
  ok(res.status === 302, 'status=' + res.status)
  const loc = res.headers.get('location')
  ok(loc === ORIGIN + '/login', 'location=' + loc)
  ok(tracker.calls === 0, '不得调用 next()')
})

await test('A3-2', '未认证访问业务页面 → 302 且带 next', async () => {
  const { ctx } = makeCtx({ path: '/dashboard?tab=1', api: apiStub(401) })
  const res = await onRequest(ctx)
  const loc = res.headers.get('location') || ''
  ok(res.status === 302, 'status=' + res.status)
  ok(loc.startsWith(ORIGIN + '/login?next='), 'location=' + loc)
  ok(decodeURIComponent(loc).includes('/dashboard?tab=1'), 'next 应保留原路径与查询串')
})

await test('A3-3', '未认证访问静态资源 → 302（全站保护）', async () => {
  const { ctx } = makeCtx({ path: '/assets/index-EBug1aIU.js', api: apiStub(401) })
  const res = await onRequest(ctx)
  ok(res.status === 302, 'status=' + res.status)
})

await test('A3-4', '302 响应带 Cache-Control: no-store', async () => {
  const { ctx } = makeCtx({ path: '/', api: apiStub(401) })
  const res = await onRequest(ctx)
  ok(res.headers.get('cache-control') === 'no-store', 'cache-control=' + res.headers.get('cache-control'))
})

await test('A3-5', '302 Location 为同源绝对地址（不被开放重定向利用）', async () => {
  const { ctx } = makeCtx({ path: '/x/../dashboard', api: apiStub(401) })
  const res = await onRequest(ctx)
  ok(res.status === 302, 'status=' + res.status)
  const loc = new URL(res.headers.get('location'))
  ok(loc.origin === ORIGIN, 'origin=' + loc.origin)
  ok(loc.pathname === '/login', 'pathname=' + loc.pathname)
})

// ═══════════════════════════════════════════════════════════════════════════
console.log('=== AUTH-3 · 登录页匿名例外 ===')
// ═══════════════════════════════════════════════════════════════════════════

await test('A3-6', '/login 匿名放行（不触发 Session 查询）', async () => {
  const api = apiStub(401)
  const { ctx, tracker } = makeCtx({ path: '/login', api })
  const res = await onRequest(ctx)
  ok(res.status === 200, 'status=' + res.status)
  ok(tracker.calls === 1, 'next() 应调用 1 次')
  ok(api.captured.length === 0, '登录页不应触发 session 探测')
})

await test('A3-7', '/login.html 匿名放行', async () => {
  const { ctx } = makeCtx({ path: '/login.html', api: apiStub(401) })
  const res = await onRequest(ctx)
  ok(res.status === 200, 'status=' + res.status)
})

await test('A3-8', '/favicon.ico 匿名放行', async () => {
  const { ctx } = makeCtx({ path: '/favicon.ico', api: apiStub(401) })
  ok((await onRequest(ctx)).status === 200)
})

await test('A3-9', '登录页在 Worker 完全不可用时仍可打开（无循环）', async () => {
  const { ctx } = makeCtx({ path: '/login', api: apiStub(503, { throw: true }) })
  const res = await onRequest(ctx)
  ok(res.status === 200, 'status=' + res.status)
})

// ═══════════════════════════════════════════════════════════════════════════
console.log('=== AUTH-3 · 有效 Session ===')
// ═══════════════════════════════════════════════════════════════════════════

await test('A3-10', '有效 Session 访问首页 → 200', async () => {
  const { ctx, tracker } = makeCtx({ path: '/', cookie: COOKIE, api: apiStub(200) })
  const res = await onRequest(ctx)
  ok(res.status === 200, 'status=' + res.status)
  ok(tracker.calls === 1, 'next() 应放行')
})

await test('A3-11', 'Session 探测请求携带原 Cookie 且路径为 /api/auth/session', async () => {
  const api = apiStub(200)
  const { ctx } = makeCtx({ path: '/dashboard', cookie: COOKIE, api })
  await onRequest(ctx)
  ok(api.captured.length === 1, 'captured=' + api.captured.length)
  const req = api.captured[0]
  ok(req.headers.get('cookie') === COOKIE, 'cookie 未透传')
  ok(new URL(req.url).pathname === '/api/auth/session', 'path=' + new URL(req.url).pathname)
  ok(new URL(req.url).origin === ORIGIN, '同源探测')
})

await test('A3-12', '有效 Session 访问静态资源 → 200', async () => {
  const { ctx } = makeCtx({ path: '/assets/index-DPCy_Uhc.css', cookie: COOKIE, api: apiStub(200) })
  ok((await onRequest(ctx)).status === 200)
})

// ═══════════════════════════════════════════════════════════════════════════
console.log('=== AUTH-3 · fail-closed ===')
// ═══════════════════════════════════════════════════════════════════════════

await test('A3-13', 'Worker 503 → 503 且不放行', async () => {
  const { ctx, tracker } = makeCtx({ path: '/', cookie: COOKIE, api: apiStub(503) })
  const res = await onRequest(ctx)
  ok(res.status === 503, 'status=' + res.status)
  ok(tracker.calls === 0, '不得调用 next()')
})

await test('A3-14', 'Worker 500 → 503（非 302、非放行）', async () => {
  const { ctx, tracker } = makeCtx({ path: '/dashboard', cookie: COOKIE, api: apiStub(500) })
  const res = await onRequest(ctx)
  ok(res.status === 503, 'status=' + res.status)
  ok(tracker.calls === 0, '不得调用 next()')
})

await test('A3-15', 'Service Binding 抛异常 → 503', async () => {
  const { ctx, tracker } = makeCtx({ path: '/', cookie: COOKIE, api: apiStub(200, { throw: true }) })
  const res = await onRequest(ctx)
  ok(res.status === 503, 'status=' + res.status)
  ok(tracker.calls === 0, '不得调用 next()')
})

await test('A3-16', 'env.API 缺失 → 503（受保护路径）', async () => {
  const { ctx, tracker } = makeCtx({ path: '/', cookie: COOKIE })
  const res = await onRequest(ctx)
  ok(res.status === 503, 'status=' + res.status)
  ok(tracker.calls === 0, '不得调用 next()')
})

await test('A3-17', '503 响应带 Cache-Control: no-store 且不回显内部错误', async () => {
  const { ctx } = makeCtx({ path: '/', cookie: COOKIE, api: apiStub(200, { throw: true }) })
  const res = await onRequest(ctx)
  const body = await res.text()
  ok(res.headers.get('cache-control') === 'no-store')
  ok(!body.includes('SERVICE_BINDING_DOWN') && !body.includes('sf_session'), '不得泄露内部信息或 token')
})

// ═══════════════════════════════════════════════════════════════════════════
console.log('=== AUTH-3 · API 边界 ===')
// ═══════════════════════════════════════════════════════════════════════════

await test('A3-18', '/api/auth/login 匿名透传（登录不被拦截）', async () => {
  const api = apiStub(200)
  const { ctx, tracker } = makeCtx({ path: '/api/auth/login', method: 'POST', api })
  const res = await onRequest(ctx)
  ok(res.status === 200, 'status=' + res.status)
  ok(api.captured.length === 1, '应透传 1 次')
  ok(tracker.calls === 0, '不应调用 next()')
})

await test('A3-19', '/api/auth/session 匿名透传（不递归、不二次校验）', async () => {
  const api = apiStub(200)
  const { ctx } = makeCtx({ path: '/api/auth/session', api })
  await onRequest(ctx)
  ok(api.captured.length === 1, '仅 1 次透传')
  ok(new URL(api.captured[0].url).pathname === '/api/auth/session')
})

await test('A3-20', '/api/auth/users 透传（鉴权由 Worker 承担）', async () => {
  const api = apiStub(403)
  const { ctx } = makeCtx({ path: '/api/auth/users', method: 'POST', api })
  const res = await onRequest(ctx)
  ok(res.status === 403, 'status=' + res.status)
  ok(api.captured.length === 1)
})

await test('A3-21', '/api/v1/buildings 透传且不改写（deny_all 由 Worker 返回 403）', async () => {
  const api = apiStub(403)
  const { ctx } = makeCtx({ path: '/api/v1/buildings', cookie: COOKIE, api })
  const res = await onRequest(ctx)
  ok(res.status === 403, 'status=' + res.status)
  ok(api.captured.length === 1)
})

await test('A3-22', '/api/v1/* 未登录也直接透传（保持既有网关语义）', async () => {
  const api = apiStub(403)
  const { ctx } = makeCtx({ path: '/api/v1/devices', api })
  const res = await onRequest(ctx)
  ok(res.status === 403, 'status=' + res.status)
  ok(api.captured.length === 1)
})

await test('A3-23', 'API 路径不进入页面重定向逻辑（无 302）', async () => {
  const { ctx } = makeCtx({ path: '/api/v1/devices', api: apiStub(403) })
  ok((await onRequest(ctx)).status !== 302)
})

await test('A3-31', '/api/v10/* 不被当作业务 API 透传（走登录保护）', async () => {
  const api = apiStub(401)
  const { ctx, tracker } = makeCtx({ path: '/api/v10/anything', api })
  const res = await onRequest(ctx)
  ok(res.status === 302, 'status=' + res.status)
  ok(api.captured.length === 1 && new URL(api.captured[0].url).pathname === '/api/auth/session', '应仅探测 session')
  ok(tracker.calls === 0, '不得放行')
})

// ═══════════════════════════════════════════════════════════════════════════
console.log('=== AUTH-3 · 登录页静态安全检查 ===')
// ═══════════════════════════════════════════════════════════════════════════

const loginHtml = readFileSync(join(TRIAL_DIR, 'login.html'), 'utf8')

await test('A3-24', '登录页不硬编码 workers.dev / 绝对后端地址', async () => {
  ok(!loginHtml.includes('workers.dev'), '不应出现 workers.dev')
  ok(!/https?:\/\/(?!www\.w3\.org)/.test(loginHtml.replace(/<script[\s\S]*?<\/script>/g, '')), '不应出现外部绝对地址')
})

// AUTH-9：登录页复用设计稿后，交互逻辑外置到同源相对静态资源 auth.js，
// 故对「登录页整体」做联合断言，而非仅 login.html。
const AUTH_JS_PATH = join(TRIAL_DIR, 'auth.js')
const authJs = existsSync(AUTH_JS_PATH) ? readFileSync(AUTH_JS_PATH, 'utf8') : ''
const loginBundle = loginHtml + '\n' + authJs

await test('A3-25', '登录页仅使用同源相对接口 /api/auth/login', async () => {
  ok(authJs !== '', '缺少 auth.js（登录交互脚本）')
  ok(loginBundle.includes('/api/auth/login'), '未引用 /api/auth/login')
  ok(!/fetch\(\s*['"`]https?:/i.test(loginBundle), '存在绝对 URL 的 fetch')
  ok(!/loginUrl:\s*['"]https?:/i.test(loginBundle), 'loginUrl 指向绝对地址')
})

await test('A3-26', '登录页 next 参数有同源白名单（防开放重定向）', async () => {
  ok(loginBundle.includes("raw.charAt(1) === '/'") && loginBundle.includes('return \'/\''), '缺少 next 白名单校验')
  ok(loginBundle.includes('raw.charAt(0)'), '缺少首字符校验')
})

await test('A3-27', '登录页不含任何明文凭据或 token 常量', async () => {
  ok(!/sf_session\s*=\s*['"][A-Za-z0-9_-]{20,}/.test(loginHtml), '出现疑似 token')
  ok(!/password\s*[:=]\s*['"][^'"]{6,}['"]/i.test(loginHtml), '出现疑似明文密码')
})

await test('A3-28', '登录页未引入任何外部（跨域）脚本/样式资源', async () => {
  // 允许同源相对资源（auth.css / auth.js / orb-particles.js / favicon.svg），
  // 仅禁止协议相对或绝对外链。
  const scriptTags = loginHtml.match(/<script[^>]+src=["']([^"']+)["']/gi) || []
  for (const tag of scriptTags) {
    ok(!/src=["'](https?:)?\/\//i.test(tag), '存在外部脚本: ' + tag)
  }
  ok(!/<link[^>]+href=["'](https?:)?\/\//i.test(loginHtml), '存在外部样式')
})

await test('A3-34', '登录页必需静态资源均在匿名白名单内', async () => {
  const mw = readFileSync(join(TRIAL_DIR, 'functions', '_middleware.ts'), 'utf8')
  for (const p of ['/auth.css', '/auth.js', '/orb-particles.js', '/favicon.svg']) {
    ok(mw.includes("'" + p + "'"), '白名单缺少 ' + p)
  }
})

// ═══════════════════════════════════════════════════════════════════════════
console.log('=== AUTH-3 · 构建产物约定 ===')
// ═══════════════════════════════════════════════════════════════════════════

const routes = JSON.parse(readFileSync(join(TRIAL_DIR, '_routes.json'), 'utf8'))
await test('A3-29', '_routes.json 全站启用 Functions', async () => {
  ok(Array.isArray(routes.include) && routes.include.includes('/*'), 'include=' + JSON.stringify(routes.include))
  ok(Array.isArray(routes.exclude) && routes.exclude.length === 0, 'exclude 应为空')
})

await test('A3-30', 'build.mjs 会发布 login.html', async () => {
  const b = readFileSync(join(TRIAL_DIR, 'scripts', 'build.mjs'), 'utf8')
  ok(b.includes('login.html'), 'build.mjs 未处理 login.html')
})

await test('A3-32', '_redirects 不得包含 /login rewrite（避免与 html_handling 形成 308 循环）', async () => {
  // AUTH-5 线上验收发现：显式 `/login /login.html 200` 会与 Pages html_handling 的
  // 「剥离 .html → 308 回 /login」互相触发，导致 /login 指向自身的重定向循环。
  // 因此正确语义是**不配置该 rewrite**，由 Pages 默认映射提供 200。
  const rd = readFileSync(join(TRIAL_DIR, '_redirects'), 'utf8')
  const active = rd
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
  const bad = active.filter((l) => /^\/login(\.html)?\s+\/login\.html\s+/.test(l))
  ok(bad.length === 0, '不应存在 /login → /login.html rewrite: ' + JSON.stringify(bad))
})

await test('A3-33', 'build.mjs 会发布 _redirects', async () => {
  const b = readFileSync(join(TRIAL_DIR, 'scripts', 'build.mjs'), 'utf8')
  ok(b.includes('_redirects'), 'build.mjs 未处理 _redirects')
})

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n=== 汇总 ===')
console.log(
  JSON.stringify(
    { passed, failed, total: passed + failed, node: process.version, failures },
    null,
    2,
  ),
)
process.exit(failed ? 1 : 0)

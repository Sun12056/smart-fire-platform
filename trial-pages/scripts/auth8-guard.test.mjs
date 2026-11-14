#!/usr/bin/env node
// AUTH-8 · 前端路由守卫与 401 清理逻辑测试（纯本地、无浏览器、无网络）
// 覆盖：未认证跳转、next 安全、强制改密、管理员路由、会话过期后清空、登录后回原页。

import { createRequire } from 'node:module'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TRIAL_DIR = resolve(__dirname, '..')
const WORKER_DIR = resolve(TRIAL_DIR, '..', 'worker')
const requireFromWorker = createRequire(join(WORKER_DIR, 'package.json'))
const { build } = requireFromWorker('esbuild')

// ── 打包被测模块（纯 JS，无 Vue 运行时依赖）────────────────────────────────
const outdir = mkdtempSync(join(tmpdir(), 'auth8-guard-'))
const outfile = join(outdir, 'guard.mjs')

await build({
  entryPoints: [join(TRIAL_DIR, '..', 'src', 'router', 'guard.js')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  write: false,
  logLevel: 'silent',
}).then((r) => writeFileSync(outfile, r.outputFiles[0].text))

const { resolveGuard, sanitizeNext, buildLoginUrl, LOGIN_PATH } = await import(pathToFileURL(outfile).href)

// ── 迷你断言框架 ────────────────────────────────────────────────────────────
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

const AUTHED = { isAuthenticated: true, mustChangePassword: false, isAdmin: false }
const ADMIN = { isAuthenticated: true, mustChangePassword: false, isAdmin: true }
const MUST_CHANGE = { isAuthenticated: true, mustChangePassword: true, isAdmin: false }
const ANON = { isAuthenticated: false, mustChangePassword: false, isAdmin: false }

const route = (path, meta = {}) => ({ path, fullPath: path, meta })

// ═══════════════════════════════════════════════════════════════════════════
console.log('=== AUTH-8 路由守卫 ===')
// ═══════════════════════════════════════════════════════════════════════════

await test('RG-1', '已登录普通用户访问业务路由 → 放行', () => {
  ok(resolveGuard(AUTHED, route('/devices')) === null)
  ok(resolveGuard(AUTHED, route('/dashboard')) === null)
  ok(resolveGuard(AUTHED, route('/account')) === null)
})

await test('RG-2', '未认证访问业务路由 → 整页跳 /login 且带 next', () => {
  const d = resolveGuard(ANON, route('/devices'))
  ok(d && d.external, '应返回 external 跳转')
  ok(d.external.startsWith('/login?next='), d.external)
  ok(decodeURIComponent(d.external).includes('/#/devices'), decodeURIComponent(d.external))
})

await test('RG-3', '未认证访问根路径 → next=/', () => {
  const d = resolveGuard(ANON, route('/'))
  ok(decodeURIComponent(d.external) === '/login?next=/', decodeURIComponent(d.external))
})

await test('RG-4', 'Session 过期（isAuthenticated=false）→ 不得放行管理员路由', () => {
  const d = resolveGuard(ANON, route('/admin/users', { requiresAdmin: true }))
  ok(d && d.external && d.external.startsWith('/login'), JSON.stringify(d))
})

await test('RG-5', '非管理员访问 requiresAdmin → 回 /dashboard', () => {
  const d = resolveGuard(AUTHED, route('/admin/users', { requiresAdmin: true }))
  ok(d && d.path === '/dashboard' && d.replace === true, JSON.stringify(d))
})

await test('RG-6', '管理员访问 requiresAdmin → 放行', () => {
  ok(resolveGuard(ADMIN, route('/admin/users', { requiresAdmin: true })) === null)
})

await test('RG-7', 'mustChangePassword 访问业务页 → /account', () => {
  const d = resolveGuard(MUST_CHANGE, route('/devices'))
  ok(d && d.path === '/account' && d.replace === true, JSON.stringify(d))
})

await test('RG-8', 'mustChangePassword 访问 /account → 放行', () => {
  ok(resolveGuard(MUST_CHANGE, route('/account')) === null)
})

await test('RG-9', 'mustChangePassword 访问管理员路由 → 仍回 /account（优先级更高）', () => {
  const d = resolveGuard({ isAuthenticated: true, mustChangePassword: true, isAdmin: true }, route('/admin/users', { requiresAdmin: true }))
  ok(d && d.path === '/account', JSON.stringify(d))
})

// ═══════════════════════════════════════════════════════════════════════════
console.log('=== next 安全（防开放重定向）===')
// ═══════════════════════════════════════════════════════════════════════════

await test('RG-10', '协议相对地址 //evil.com → 降级 /', () => {
  ok(sanitizeNext('//evil.com') === '/')
  ok(sanitizeNext('//evil.com/path') === '/')
})

await test('RG-11', '反斜杠绕过 /\\evil.com → 降级 /', () => {
  ok(sanitizeNext('/\\evil.com') === '/')
})

await test('RG-12', '绝对 URL → 降级 /', () => {
  ok(sanitizeNext('https://evil.com') === '/')
  ok(sanitizeNext('javascript:alert(1)') === '/')
})

await test('RG-13', '指回登录页 → 降级 /（避免循环）', () => {
  ok(sanitizeNext('/login') === '/')
  ok(sanitizeNext('/login?next=/x') === '/')
  ok(sanitizeNext('/login/extra') === '/')
})

await test('RG-14', '合法站内路径（含 hash）保留', () => {
  ok(sanitizeNext('/#/devices') === '/#/devices')
  ok(sanitizeNext('/dashboard') === '/dashboard')
})

await test('RG-15', '控制字符 → 降级 /', () => {
  ok(sanitizeNext('/a\u0000b') === '/')
})

await test('RG-16', 'buildLoginUrl 对根路径与子路径分别编码', () => {
  ok(buildLoginUrl('/') === '/login?next=%2F', buildLoginUrl('/'))
  const u = buildLoginUrl('/devices')
  ok(decodeURIComponent(u) === '/login?next=/#/devices', decodeURIComponent(u))
})

await test('RG-17', 'LOGIN_PATH 常量正确', () => {
  ok(LOGIN_PATH === '/login')
})

// ═══════════════════════════════════════════════════════════════════════════
console.log('=== 登录成功回原页 ===')
// ═══════════════════════════════════════════════════════════════════════════

await test('RG-18', '未认证访问 /route-plan → next 可还原为原页面', () => {
  const d = resolveGuard(ANON, route('/route-plan'))
  const next = new URL(d.external, 'https://x').searchParams.get('next')
  ok(next === '/#/route-plan', 'next=' + next)
  // 模拟 login.html 的白名单判定
  ok(next.charAt(0) === '/' && next.charAt(1) !== '/' && next.charAt(1) !== '\\')
})

await test('RG-19', '带查询串的路由同样保留', () => {
  const d = resolveGuard(ANON, { path: '/devices', fullPath: '/devices?floor=3F' })
  const next = new URL(d.external, 'https://x').searchParams.get('next')
  ok(next === '/#/devices?floor=3F', 'next=' + next)
})

// ═══════════════════════════════════════════════════════════════════════════
console.log('=== 401 清空语义（纯函数等价断言）===')
// ═══════════════════════════════════════════════════════════════════════════

await test('RG-20', '清空后（isAuthenticated=false）任何业务路由都不放行', () => {
  for (const p of ['/dashboard', '/devices', '/alarms', '/evacuation', '/admin/users', '/account', '/emergency']) {
    const d = resolveGuard(ANON, route(p, p === '/admin/users' ? { requiresAdmin: true } : {}))
    ok(d && d.external, p + ' 应跳登录')
  }
})

await test('RG-21', '清空后不会命中 mustChange 或 admin 分支（短路于未认证）', () => {
  const d = resolveGuard(ANON, route('/account'))
  ok(d && d.external, '未认证不应放行 /account')
})

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n=== 汇总 ===')
console.log(JSON.stringify({ passed, failed, total: passed + failed, failures }, null, 2))
process.exit(failed ? 1 : 0)

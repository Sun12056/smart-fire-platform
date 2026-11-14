#!/usr/bin/env node
// AUTH-2b · 自建认证本地测试（U 单元 + I 集成）
// 仅本地：node:sqlite 内存库 + esbuild 打包真实 index.ts；不触远程 D1 / Cloudflare API / 部署。
// 分层：U = 纯函数；I = HTTP 集成（真实 Hono app）。R（真实 Workers）/ A（AUTH-3 联调）不在本脚本内。
import { DatabaseSync } from 'node:sqlite'
import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const __dirname = dirname(fileURLToPath(import.meta.url))
const WORKER_DIR = resolve(__dirname, '..')
const MIGRATION = readFileSync(join(WORKER_DIR, 'migrations', '0003_auth.sql'), 'utf8')

// ── 加载真实 index.ts（stub cloudflare:workers，仅为本地可执行）─────────────
const stub = {
  name: 'stub-cloudflare-workers',
  setup(b) {
    b.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: 'cw', namespace: 'stub' }))
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
      contents: 'export class DurableObject { constructor() {} }', loader: 'js',
    }))
  },
}
const ENTRY = `
export { default as app } from './src/index.ts'
export * as password from './src/auth/password.ts'
export * as session from './src/auth/session.ts'
export * as ratelimit from './src/auth/ratelimit.ts'
export * as guard from './src/auth/guard.ts'
export { authRoute } from './src/routes/auth.ts'
export { gatewayGuard } from './src/middleware/gateway.ts'
`
const outdir = mkdtempSync(join(tmpdir(), 'auth2b-'))
const bundlePath = join(outdir, 'full.mjs')
await build({
  stdin: { contents: ENTRY, resolveDir: WORKER_DIR, sourcefile: 'entry.ts', loader: 'ts' },
  bundle: true, format: 'esm', platform: 'node', target: 'node20',
  write: false, logLevel: 'silent', plugins: [stub],
}).then((r) => writeFileSync(bundlePath, r.outputFiles[0].text))
const M = await import(pathToFileURL(bundlePath).href)
const { app, password, session, ratelimit } = M

// ── D1 兼容适配器（node:sqlite）─────────────────────────────────────────────
class Stmt {
  constructor(db, sql) { this.db = db; this.sql = sql; this.args = [] }
  bind(...args) { this.args = args; return this }
  async all() { return { results: this.db._all(this.sql, this.args), success: true, meta: {} } }
  async first() { return this.db._get(this.sql, this.args) ?? null }
  async run() { return { success: true, meta: this.db._run(this.sql, this.args) } }
}
class D1Local {
  constructor() {
    this.raw = new DatabaseSync(':memory:')
    this.raw.exec('PRAGMA foreign_keys = ON;')
    this.raw.exec(MIGRATION)
    this.failRule = null          // (sql, phase) => boolean，true 表示抛出模拟故障
    this.auditErrors = []         // 捕获 console.error
  }
  _check(sql, phase) {
    if (this.failRule && this.failRule(sql, phase)) {
      throw new Error('SIMULATED_D1_FAILURE')
    }
  }
  _all(sql, args) { this._check(sql, 'all'); return this.raw.prepare(sql).all(...args) }
  _get(sql, args) { this._check(sql, 'get'); return this.raw.prepare(sql).get(...args) ?? null }
  _run(sql, args) {
    this._check(sql, 'run')
    const r = this.raw.prepare(sql).run(...args)
    return { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) }
  }
  prepare(sql) { return new Stmt(this, sql) }
  async batch(statements) {
    const out = []
    this.raw.exec('BEGIN')
    try {
      for (const s of statements) {
        this._check(s.sql, 'batch')
        const r = this.raw.prepare(s.sql).run(...s.args)
        out.push({ success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } })
      }
      this.raw.exec('COMMIT')
      return out
    } catch (e) {
      try { this.raw.exec('ROLLBACK') } catch { /* ignore */ }
      throw e
    }
  }
  q(sql, ...args) { return this.raw.prepare(sql).all(...args) }
  exec(sql, ...args) { return this.raw.prepare(sql).run(...args) }
}

// ── 测试框架 ───────────────────────────────────────────────────────────────
let passed = 0, failed = 0, blocked = 0
const failures = []
const rows = []
function ok(cond, detail) { if (!cond) throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail)) }
function test(id, layer, name, fn) {
  try {
    fn()
    passed++
    rows.push({ id, layer, name, result: 'PASS' })
    console.log(`  ✓ ${id} [${layer}] ${name}`)
  } catch (e) {
    failed++
    failures.push({ id, name, error: e.message })
    rows.push({ id, layer, name, result: 'FAIL', error: e.message })
    console.log(`  ✗ ${id} [${layer}] ${name} → ${e.message}`)
  }
}
async function atest(id, layer, name, fn) {
  try {
    await fn()
    passed++
    rows.push({ id, layer, name, result: 'PASS' })
    console.log(`  ✓ ${id} [${layer}] ${name}`)
  } catch (e) {
    failed++
    failures.push({ id, name, error: e.message })
    rows.push({ id, layer, name, result: 'FAIL', error: e.message })
    console.log(`  ✗ ${id} [${layer}] ${name} → ${e.message}`)
  }
}
/** I 层用例：每个用例独立 DB + 首个管理员，避免 login_attempts 跨用例串扰。 */
async function itest(id, name, fn) {
  try {
    DB = new D1Local()
    ADM = await bootstrap(DB)
    await fn(DB, ADM)
    passed++
    rows.push({ id, layer: 'I', name, result: 'PASS' })
    console.log(`  ✓ ${id} [I] ${name}`)
  } catch (e) {
    failed++
    failures.push({ id, name, error: e.message })
    rows.push({ id, layer: 'I', name, result: 'FAIL', error: e.message })
    console.log(`  ✗ ${id} [I] ${name} → ${e.message}`)
  }
}
function blockedCase(id, layer, name, reason) {
  blocked++
  rows.push({ id, layer, name, result: 'BLOCKED', reason })
  console.log(`  ⚠ ${id} [${layer}] ${name} → ${reason}`)
}

// ── 环境 / 请求辅助 ────────────────────────────────────────────────────────
const NOW = '2026-11-08T10:00:00.000Z'
const ITER = password.DEFAULT_ITERATIONS
function env(db, extra = {}) {
  return { DB: db, GATEWAY_MODE: 'deny_all', PBKDF2_ITERATIONS: String(ITER), ...extra }
}
const SAME_ORIGIN = 'http://localhost'
/**
 * csrf 选项：
 *   origin: 缺省 'http://localhost'；显式 null 表示不发送 Origin
 *   site:   显式字符串才发送 Sec-Fetch-Site；缺省不发送
 * 显式 headers 优先级最高（用于构造异常场景）。
 */
async function req(db, method, path, { body, rawBody, streamBody, cookie, ip, headers = {}, envExtra = {}, csrf = {} } = {}) {
  const h = {}
  const origin = 'origin' in csrf ? csrf.origin : SAME_ORIGIN
  if (origin !== null) h.origin = origin
  if ('site' in csrf && csrf.site !== null) h['sec-fetch-site'] = csrf.site
  Object.assign(h, headers)
  if (cookie) h.cookie = cookie
  if (ip !== undefined) h['CF-Connecting-IP'] = ip
  const init = { method, headers: h }
  if (streamBody !== undefined) {
    // 流式 body：不设置 Content-Length（由 Node Request 决定），用于验证读取过程限流
    init.body = streamBody
    init.duplex = 'half'
    h['Content-Type'] = 'application/json'
  } else if (rawBody !== undefined) {
    init.body = rawBody
    h['Content-Type'] = 'application/json'
  } else if (body !== undefined) {
    init.body = JSON.stringify(body)
    h['Content-Type'] = 'application/json'
  }
  return app.request(`${SAME_ORIGIN}${path}`, init, env(db, envExtra))
}

/** 构造可控分块流，并记录 cancel 与 enqueue 次数。 */
function makeChunkStream(chunks, state) {
  let i = 0
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) {
        state.enqueued += 1
        controller.enqueue(chunks[i++])
      } else {
        controller.close()
      }
    },
    cancel() {
      state.cancelled = true
      state.enqueuedAtCancel = state.enqueued
    },
  })
}
const utf8 = (s) => new TextEncoder().encode(s)
async function jres(r) { try { return await r.json() } catch { return null } }
function cookieOf(r) {
  const s = r.headers.get('set-cookie') || ''
  return s.split(';')[0]
}

let DB = new D1Local()
async function bootstrap(db, { id = 'ADM', username = 'admin', pw = 'AdminPass12345', mustChange = 0 } = {}) {
  const salt = password.generateSaltB64()
  const hash = await password.deriveHash(pw, salt, ITER)
  db.exec(
    `INSERT INTO users (id, username, display_name, password_hash, salt, iterations,
       role, status, must_change_password, created_by, password_updated_at, created_at, updated_at)
     SELECT ?, ?, ?, ?, ?, ?, 'admin', 'active', ?, 'bootstrap', ?, ?, ?
     WHERE COALESCE((SELECT admin_created FROM bootstrap_state WHERE id=1),-1)=0
       AND (SELECT closed_at FROM bootstrap_state WHERE id=1) IS NULL`,
    id, username, username, hash, salt, ITER, mustChange, NOW, NOW, NOW,
  )
  return { id, username, pw, hash, salt }
}
async function addUser(db, { id, username, pw, role = 'teacher', status = 'active', mustChange = 0 } = {}) {
  const salt = password.generateSaltB64()
  const hash = await password.deriveHash(pw, salt, ITER)
  db.exec(
    `INSERT INTO users (id, username, display_name, password_hash, salt, iterations,
       role, status, must_change_password, created_by, password_updated_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ADM', ?, ?, ?)`,
    id, username, username, hash, salt, ITER, role, status, mustChange, NOW, NOW, NOW,
  )
  return { id, username, pw }
}
async function login(db, username, pw, opts = {}) {
  return req(db, 'POST', '/api/auth/login', { body: { username, password: pw }, ...opts })
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('=== U 单元层 ===')
// ═══════════════════════════════════════════════════════════════════════════
await atest('U-1', 'U', 'PBKDF2 派生/校验一致（32B base64）', async () => {
  const s = password.generateSaltB64()
  const h = await password.deriveHash('Password12345', s, ITER)
  ok(Buffer.from(h, 'base64').length === 32, 'hash 长度')
  ok(await password.verifyHash('Password12345', h, s, ITER), 'verify')
})
await atest('U-2', 'U', '错误密码返回 false', async () => {
  const s = password.generateSaltB64()
  const h = await password.deriveHash('Password12345', s, ITER)
  ok(!await password.verifyHash('WrongPassword1', h, s, ITER))
})
await atest('U-3', 'U', '不同盐产生不同哈希', async () => {
  const a = await password.deriveHash('Password12345', password.generateSaltB64(), ITER)
  const b = await password.deriveHash('Password12345', password.generateSaltB64(), ITER)
  ok(a !== b)
})
test('U-4', 'U', 'timingSafeEqualStr 等/不等/长度差', () => {
  ok(password.timingSafeEqualStr('abc', 'abc'))
  ok(!password.timingSafeEqualStr('abc', 'abd'))
  ok(!password.timingSafeEqualStr('abc', 'abcd'))
})
await atest('U-5', 'U', 'token 43 字符 / tokenHash 64 hex', async () => {
  const t = password.generateToken()
  ok(/^[A-Za-z0-9_-]{43}$/.test(t), 'token 形态')
  ok(/^[0-9a-f]{64}$/.test(await password.tokenHash(t)), 'hash 形态')
  ok(password.isValidToken(t) && !password.isValidToken('bad'))
})
test('U-6', 'U', 'parseIterations 边界与越界 fail-closed', () => {
  ok(password.parseIterations(100000) === 100000)
  ok(password.parseIterations(1000000) === 1000000)
  for (const v of [0, 1, 99999, 1000001, 1e20, -1, 1.5, NaN, 'abc', '', ' 100000', '100000x', null, undefined, {}, true]) {
    let threw = false
    try { password.parseIterations(v) } catch (e) { threw = e instanceof password.AuthConfigError }
    ok(threw, `应拒绝 ${String(v)}`)
  }
})
await atest('U-7', 'U', 'deriveHash/verifyHash 对越界 iterations 拒绝且不执行 KDF', async () => {
  const s = password.generateSaltB64()
  for (const v of [99999, 1000001]) {
    let threw = false
    try { await password.deriveHash('Password12345', s, v) } catch (e) { threw = e instanceof password.AuthConfigError }
    ok(threw, 'deriveHash ' + v)
  }
  const h = await password.deriveHash('Password12345', s, ITER)
  let threw = false
  try { await password.verifyHash('Password12345', h, s, 99999) } catch (e) { threw = e instanceof password.AuthConfigError }
  ok(threw, 'verifyHash DB 越界')
})
test('U-8', 'U', 'validatePasswordInput：12 字符下限/Unicode/控制字符/字节上限', () => {
  ok(password.validatePasswordInput('12345678901') === 'INVALID_INPUT', '11 字符应拒绝')
  ok(password.validatePasswordInput('123456789012') === null, '12 字符应通过')
  ok(password.validatePasswordInput('中文密码十二个字呀abcd') === null, '中文 Unicode')
  ok(password.validatePasswordInput('Passw0rd!@#😀中文') === null, '特殊字符+emoji')
  ok(password.validatePasswordInput('Password1234\u0000') === 'INVALID_INPUT', '控制字符')
  ok(password.validatePasswordInput('  Password12345  ') === null, '不 trim 密码')
  ok(password.validatePasswordInput('A'.repeat(129)) === 'INVALID_INPUT', '>128 字符')
  ok(password.validatePasswordInput('😀'.repeat(129)) === 'INVALID_INPUT', '>512 UTF8 字节')
})
test('U-9', 'U', 'normalizeUsername 只 trim 不折叠大小写', () => {
  ok(ratelimit.normalizeUsername('  Alice  ') === 'Alice')
  ok(ratelimit.normalizeUsername('Alice') !== ratelimit.normalizeUsername('alice'))
  ok(ratelimit.normalizeUsername('   ') === null)
  ok(ratelimit.normalizeUsername('A'.repeat(33)) === null)
  ok(ratelimit.normalizeUsername(null) === null)
})
test('U-10', 'U', 'trustedIp 仅 CF-Connecting-IP；XFF/X-Real-IP 不可信', () => {
  ok(ratelimit.trustedIp(new Headers({ 'CF-Connecting-IP': '1.2.3.4' })) === '1.2.3.4')
  ok(ratelimit.trustedIp(new Headers({ 'CF-Connecting-IP': '2001:db8::1' })) === '2001:db8::1')
  ok(ratelimit.trustedIp(new Headers({ 'X-Forwarded-For': '9.9.9.9' })) === 'unknown')
  ok(ratelimit.trustedIp(new Headers({ 'X-Real-IP': '9.9.9.9' })) === 'unknown')
  ok(ratelimit.trustedIp(new Headers({ 'CF-Connecting-IP': '9.9.9.9', 'X-Forwarded-For': '1.1.1.1' })) === '9.9.9.9')
  ok(ratelimit.trustedIp(new Headers({ 'CF-Connecting-IP': 'fake' })) === 'unknown')
  ok(ratelimit.trustedIp(new Headers({ 'CF-Connecting-IP': '1.2.3.4, 5.6.7.8' })) === 'unknown')
})
test('U-11', 'U', '限速常量：账号 5 / 正常 IP 20 / unknown 5 / 窗口 5min', () => {
  ok(ratelimit.ACCOUNT_LIMIT === 5)
  ok(ratelimit.IP_NORMAL_LIMIT === 20)
  ok(ratelimit.IP_UNKNOWN_LIMIT === 5)
  ok(ratelimit.WINDOW_MS === 300000)
  ok(ratelimit.ipLimit('1.2.3.4') === 20)
  ok(ratelimit.ipLimit('unknown') === 5)
})
await atest('U-12', 'U', '限速 SQL 全部位置参数 ?，:ipLimit 已消除，两档 IP 阈值由 bind 传入', async () => {
  const src = readFileSync(join(WORKER_DIR, 'src', 'auth', 'ratelimit.ts'), 'utf8')
  ok(!src.includes(':ipLimit'), '不应存在命名占位符')
  // 精确核对：acquireSlot 内的 SQL 恰好 9 个 ?，且无任何命名占位符
  const start = src.indexOf('INSERT INTO login_attempts', src.indexOf('acquireSlot'))
  const end = src.indexOf(').bind(', start)
  const sqlText = src.slice(start, end)
  ok((sqlText.match(/\?/g) || []).length === 9, 'SQL 应有 9 个位置参数 ?')
  ok(!/:[A-Za-z_]\w*/.test(sqlText), 'SQL 不应含命名占位符')
  const probe = new D1Local()
  const ddl = probe.raw.prepare("SELECT sql FROM sqlite_master WHERE name='login_attempts'").get().sql
  ok(ddl.includes('success INTEGER'), '表结构')
  // 正常 IP：第 21 次应被拒；unknown：第 6 次应被拒
  let d = new D1Local()
  for (let i = 0; i < 20; i++) {
    const r = await ratelimit.acquireSlot(d, 'u' + i, '1.2.3.4', NOW)
    ok(r.allowed, '正常 IP 第 ' + (i + 1) + ' 次应允许')
  }
  ok(!(await ratelimit.acquireSlot(d, 'u21', '1.2.3.4', NOW)).allowed, '正常 IP 第 21 次应拒绝')
  d = new D1Local()
  for (let i = 0; i < 5; i++) ok((await ratelimit.acquireSlot(d, 'v' + i, 'unknown', NOW)).allowed)
  ok(!(await ratelimit.acquireSlot(d, 'v6', 'unknown', NOW)).allowed, 'unknown 第 6 次应拒绝')
})
test('U-13', 'U', 'Cookie 构造含 HttpOnly/Secure/SameSite=Lax；清除 Max-Age=0', () => {
  const c = session.sessionCookie('tok')
  for (const s of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/', 'Max-Age=28800']) ok(c.includes(s), s)
  ok(session.clearCookie().includes('Max-Age=0'))
  ok(session.readCookie('a=1; sf_session=abc; b=2') === 'abc')
  ok(session.readCookie(null) === null)
})

// ═══════════════════════════════════════════════════════════════════════════
console.log('=== I 集成层（真实 Hono app）===')
// ═══════════════════════════════════════════════════════════════════════════
DB = new D1Local()
let ADM = await bootstrap(DB)
await itest('I-1', '正确密码登录 200 + Set-Cookie 安全属性 + user 结构', async () => {
  const r = await login(DB, ADM.username, ADM.pw)
  ok(r.status === 200, 'status=' + r.status)
  const c = r.headers.get('set-cookie') || ''
  for (const s of ['HttpOnly', 'Secure', 'SameSite=Lax']) ok(c.includes(s), s)
  const b = await jres(r)
  ok(b.user.username === ADM.username && b.user.role === 'admin')
  ok(!JSON.stringify(b).includes('password'), '响应不含密码')
})
await itest('I-2', '错误密码 401 统一文案', async () => {
  const r = await login(DB, ADM.username, 'WrongPassword1')
  ok(r.status === 401, 'status=' + r.status)
  ok((await jres(r)).error === 'INVALID_CREDENTIALS')
})
await itest('I-3', '不存在用户 401 同文案（虚拟 KDF）', async () => {
  const r = await login(DB, 'nobody', 'Password12345')
  ok(r.status === 401)
  ok((await jres(r)).error === 'INVALID_CREDENTIALS')
})
await itest('I-4', '禁用用户 401 同文案', async () => {
  const u = await addUser(DB, { id: 'DIS', username: 'disabled1', pw: 'Password12345', status: 'disabled' })
  const r = await login(DB, u.username, u.pw)
  ok(r.status === 401)
  ok((await jres(r)).error === 'INVALID_CREDENTIALS')
})
await itest('I-5', '所有失败路径统一 INVALID_CREDENTIALS', async () => {
  const a = await jres(await login(DB, ADM.username, 'WrongPassword1'))
  const b = await jres(await login(DB, 'ghostuser', 'Password12345'))
  const c = await jres(await login(DB, 'disabled1', 'Password12345'))
  ok(JSON.stringify(a) === JSON.stringify(b) && JSON.stringify(b) === JSON.stringify(c))
})
await itest('I-6', 'GET session 200 返回 user/expiresAt/mustChangePassword', async () => {
  const r = await login(DB, ADM.username, ADM.pw)
  const ck = cookieOf(r)
  const s = await req(DB, 'GET', '/api/auth/session', { cookie: ck })
  ok(s.status === 200, 'status=' + s.status)
  const b = await jres(s)
  ok(b.user.username === ADM.username && b.expiresAt && b.mustChangePassword === false)
})
await itest('I-7', '无 Cookie 访问 session → 401', async () => {
  ok((await req(DB, 'GET', '/api/auth/session')).status === 401)
})
await itest('I-8', '伪造 Cookie → 401', async () => {
  ok((await req(DB, 'GET', '/api/auth/session', { cookie: 'sf_session=' + 'A'.repeat(43) })).status === 401)
})
await itest('I-9', '绝对过期 session → 401', async () => {
  const ck = cookieOf(await login(DB, ADM.username, ADM.pw))
  const h = await password.tokenHash(ck.split('=')[1])
  DB.exec("UPDATE sessions SET expires_at='2000-01-01T00:00:00.000Z' WHERE token_hash=?", h)
  ok((await req(DB, 'GET', '/api/auth/session', { cookie: ck })).status === 401)
})
await itest('I-10', '空闲超时（>30min+60s）→ 401', async () => {
  const ck = cookieOf(await login(DB, ADM.username, ADM.pw))
  const h = await password.tokenHash(ck.split('=')[1])
  DB.exec("UPDATE sessions SET last_seen_at='2026-11-08T09:20:00.000Z' WHERE token_hash=?", h)
  ok((await req(DB, 'GET', '/api/auth/session', { cookie: ck })).status === 401)
})
await itest('I-11', '登出后旧 Cookie → 401', async () => {
  const ck = cookieOf(await login(DB, ADM.username, ADM.pw))
  const out = await req(DB, 'POST', '/api/auth/logout', { cookie: ck })
  ok(out.status === 200, 'logout=' + out.status)
  ok((out.headers.get('set-cookie') || '').includes('Max-Age=0'))
  ok((await req(DB, 'GET', '/api/auth/session', { cookie: ck })).status === 401)
})
await itest('I-12', '改密后全部 Session 撤销', async () => {
  const c1 = cookieOf(await login(DB, ADM.username, ADM.pw))
  const c2 = cookieOf(await login(DB, ADM.username, ADM.pw))
  const r = await req(DB, 'POST', '/api/auth/change-password', {
    cookie: c1, body: { currentPassword: ADM.pw, newPassword: 'NewAdminPass123' },
  })
  ok(r.status === 200, 'status=' + r.status + ' ' + JSON.stringify(await jres(r)))
  ok((await req(DB, 'GET', '/api/auth/session', { cookie: c1 })).status === 401, 'c1')
  ok((await req(DB, 'GET', '/api/auth/session', { cookie: c2 })).status === 401, 'c2')
  ok((await login(DB, ADM.username, 'NewAdminPass123')).status === 200, '新密码可登录')
  ADM.pw = 'NewAdminPass123'
})
await itest('I-13', '禁用用户后已有 Session 失效（T3 触发器）', async () => {
  const u = await addUser(DB, { id: 'T13', username: 't13user', pw: 'Password12345' })
  const ck = cookieOf(await login(DB, u.username, u.pw))
  const admCk = cookieOf(await login(DB, ADM.username, ADM.pw))
  const r = await req(DB, 'PATCH', '/api/auth/users/T13', { cookie: admCk, body: { status: 'disabled' } })
  ok(r.status === 200, 'patch=' + r.status)
  ok((await req(DB, 'GET', '/api/auth/session', { cookie: ck })).status === 401)
})
await itest('I-14', '角色变更后已有 Session 失效（T5 触发器）', async () => {
  const u = await addUser(DB, { id: 'T14', username: 't14user', pw: 'Password12345' })
  const ck = cookieOf(await login(DB, u.username, u.pw))
  const admCk = cookieOf(await login(DB, ADM.username, ADM.pw))
  const r = await req(DB, 'PATCH', '/api/auth/users/T14', { cookie: admCk, body: { role: 'admin' } })
  ok(r.status === 200)
  ok((await req(DB, 'GET', '/api/auth/session', { cookie: ck })).status === 401)
})
await itest('I-15', '强制改密：仅 session/change-password/logout 放行，管理接口 403', async () => {
  const d = new D1Local()
  await bootstrap(d, { id: 'MC', username: 'mustchange', pw: 'TempPass12345', mustChange: 1 })
  const ck = cookieOf(await login(d, 'mustchange', 'TempPass12345'))
  const s = await req(d, 'GET', '/api/auth/session', { cookie: ck })
  ok(s.status === 200)
  ok((await jres(s)).mustChangePassword === true, '返回 mustChangePassword')
  const u = await req(d, 'POST', '/api/auth/users', { cookie: ck, body: { username: 'x', role: 'teacher', tempPassword: 'Password12345' } })
  ok(u.status === 403, 'users=' + u.status)
  ok((await jres(u)).error === 'PASSWORD_CHANGE_REQUIRED')
  const cp = await req(d, 'POST', '/api/auth/change-password', { cookie: ck, body: { currentPassword: 'TempPass12345', newPassword: 'FinalPass12345' } })
  ok(cp.status === 200, 'change=' + cp.status)
  const ck2 = cookieOf(await login(d, 'mustchange', 'FinalPass12345'))
  const s2 = await jres(await req(d, 'GET', '/api/auth/session', { cookie: ck2 }))
  ok(s2.mustChangePassword === false)
})
await itest('I-16', '新密码与当前/历史重复 → 409；历史保留最近 5 条', async () => {
  const d = new D1Local()
  const a = await bootstrap(d, { id: 'PH', username: 'phuser', pw: 'PasswordAAA111' })
  let ck = cookieOf(await login(d, a.username, a.pw))
  let r = await req(d, 'POST', '/api/auth/change-password', { cookie: ck, body: { currentPassword: a.pw, newPassword: 'PasswordBBB222' } })
  ok(r.status === 200)
  ck = cookieOf(await login(d, a.username, 'PasswordBBB222'))
  r = await req(d, 'POST', '/api/auth/change-password', { cookie: ck, body: { currentPassword: 'PasswordBBB222', newPassword: 'PasswordAAA111' } })
  ok(r.status === 409, '历史重复=' + r.status)
  ok((await jres(r)).error === 'PASSWORD_REUSED')
  const hist = d.q("SELECT COUNT(*) c FROM password_history WHERE user_id='PH'")[0].c
  ok(hist === 1, '历史条数=' + hist)
})
await itest('I-17', '管理员创建用户 201，响应不含 tempPassword，强制改密', async () => {
  const d = new D1Local()
  const a = await bootstrap(d, { id: 'CR', username: 'creator', pw: 'Password12345' })
  const ck = cookieOf(await login(d, a.username, a.pw))
  const r = await req(d, 'POST', '/api/auth/users', {
    cookie: ck, body: { username: '  NewTeacher  ', role: 'teacher', tempPassword: 'TempPass12345' },
  })
  const b = await jres(r)
  ok(r.status === 201, 'status=' + r.status + ' ' + JSON.stringify(b))
  ok(b.user.username === 'NewTeacher', 'trim 生效')
  ok(b.user.mustChangePassword === 1)
  ok(!JSON.stringify(b).includes('TempPass12345'), '响应不含临时密码')
  const audit = JSON.stringify(d.q("SELECT * FROM auth_audit WHERE event='user_created'"))
  ok(!audit.includes('TempPass12345') && !audit.includes('password_hash'), '审计无敏感字段')
})
await itest('I-18', '老师调用管理接口 → 403（服务端校验）', async () => {
  const d = new D1Local()
  await bootstrap(d, { id: 'AD', username: 'adm18', pw: 'Password12345' })
  const t = await addUser(d, { id: 'TC', username: 'teacher18', pw: 'Password12345' })
  const ck = cookieOf(await login(d, t.username, t.pw))
  const r = await req(d, 'POST', '/api/auth/users', { cookie: ck, body: { username: 'hack', role: 'admin', tempPassword: 'Password12345' } })
  ok(r.status === 403, 'status=' + r.status)
  ok((await jres(r)).error === 'FORBIDDEN')
})
await itest('I-19', '老师自我提权 → 403', async () => {
  const d = new D1Local()
  await bootstrap(d, { id: 'AD', username: 'adm19', pw: 'Password12345' })
  const t = await addUser(d, { id: 'TC', username: 'teacher19', pw: 'Password12345' })
  const ck = cookieOf(await login(d, t.username, t.pw))
  ok((await req(d, 'PATCH', '/api/auth/users/AD', { cookie: ck, body: { role: 'teacher' } })).status === 403)
})
await itest('I-20', '管理员禁用/降级自己 → 409 SELF_MODIFY_FORBIDDEN', async () => {
  const d = new D1Local()
  const a = await bootstrap(d, { id: 'SELF', username: 'selfadm', pw: 'Password12345' })
  const ck = cookieOf(await login(d, a.username, a.pw))
  const r1 = await req(d, 'PATCH', '/api/auth/users/SELF', { cookie: ck, body: { status: 'disabled' } })
  ok(r1.status === 409, 'disable=' + r1.status)
  const r2 = await req(d, 'PATCH', '/api/auth/users/SELF', { cookie: ck, body: { role: 'teacher' } })
  ok(r2.status === 409, 'demote=' + r2.status)
})
await itest('I-21', '最后一个有效管理员禁用/降权 → 数据库层 T1 拒绝', async () => {
  const d = new D1Local()
  await bootstrap(d, { id: 'LAST', username: 'lastadm', pw: 'Password12345' })
  let threw = 0
  try { d.exec("UPDATE users SET status='disabled', updated_at=? WHERE id='LAST'", NOW) } catch { threw++ }
  try { d.exec("UPDATE users SET role='teacher', updated_at=? WHERE id='LAST'", NOW) } catch { threw++ }
  ok(threw === 2, 'T1 应拒绝两次，实际=' + threw)
})
await itest('I-22', '最后一个有效管理员 REPLACE → T12/T13 拒绝', async () => {
  const d = new D1Local()
  await bootstrap(d, { id: 'LST', username: 'lst', pw: 'Password12345' })
  let a = false, b = false
  try { d.exec("INSERT OR REPLACE INTO users (id,username,password_hash,salt,iterations,role,status,created_at,updated_at) VALUES ('LST','lst','h','s',100000,'teacher','active',?,?)", NOW, NOW) } catch { a = true }
  try { d.exec("UPDATE OR REPLACE users SET id='NEWID' WHERE id='LST'") } catch { b = true }
  ok(a && b, 'REPLACE 应被拒绝 a=' + a + ' b=' + b)
  ok(d.q("SELECT COUNT(*) c FROM users WHERE id='LST' AND role='admin' AND status='active'")[0].c === 1)
})
await itest('I-23', '管理员允许创建另一个管理员 201', async () => {
  const d = new D1Local()
  const a = await bootstrap(d, { id: 'A1', username: 'adm23', pw: 'Password12345' })
  const ck = cookieOf(await login(d, a.username, a.pw))
  const r = await req(d, 'POST', '/api/auth/users', { cookie: ck, body: { username: 'adm23b', role: 'admin', tempPassword: 'Password12345' } })
  ok(r.status === 201, 'status=' + r.status)
  ok((await jres(r)).user.role === 'admin')
})
await itest('I-24', '首次 Bootstrap 后重复初始化失败（0 行 / T6 拒绝裸 INSERT）', async () => {
  const d = new D1Local()
  await bootstrap(d, { id: 'B1', username: 'boot1', pw: 'Password12345' })
  const r = await bootstrap(d, { id: 'B2', username: 'boot2', pw: 'Password12345' })
  ok(r.hash, 'helper 完成')
  ok(d.q("SELECT COUNT(*) c FROM users WHERE created_by='bootstrap'")[0].c === 1, '仅 1 个 bootstrap 用户')
  let threw = false
  try {
    d.exec(`INSERT INTO users (id,username,password_hash,salt,iterations,role,status,created_at,updated_at)
      VALUES ('B3','boot3','h','s',100000,'admin','active',?,?)`, NOW, NOW)
    // 裸 INSERT 不带 created_by 不属于 bootstrap；补一条带 created_by 的
    d.exec(`INSERT INTO users (id,username,password_hash,salt,iterations,role,status,created_by,created_at,updated_at)
      VALUES ('B4','boot4','h','s',100000,'admin','active','bootstrap',?,?)`, NOW, NOW)
  } catch { threw = true }
  ok(threw, '裸 bootstrap INSERT 应被 T6 拒绝')
  ok(d.q("SELECT COUNT(*) c FROM users WHERE created_by='bootstrap'")[0].c === 1)
})
await itest('I-25', '临时密码不进入审计/响应/日志', async () => {
  const d = new D1Local()
  const a = await bootstrap(d, { id: 'RS', username: 'resetadm', pw: 'Password12345' })
  const t = await addUser(d, { id: 'RU', username: 'resetuser', pw: 'OldPassword123' })
  const ck = cookieOf(await login(d, a.username, a.pw))
  const r = await req(d, 'POST', '/api/auth/users/RU/reset-password', { cookie: ck, body: { tempPassword: 'BrandNewTemp99' } })
  ok(r.status === 200, 'status=' + r.status)
  ok(!JSON.stringify(await jres(r)).includes('BrandNewTemp99'), '响应不含')
  const audit = JSON.stringify(d.q('SELECT * FROM auth_audit'))
  ok(!audit.includes('BrandNewTemp99') && !audit.includes('password_hash') && !audit.includes('sf_session'), '审计不含')
  ok((await login(d, 'resetuser', 'BrandNewTemp99')).status === 200, '临时密码可登录')
  ok((await login(d, 'resetuser', 'OldPassword123')).status === 401, '旧密码失效')
})
await itest('I-26', '重置密码后旧 Session 全部撤销且强制改密', async () => {
  const d = new D1Local()
  const a = await bootstrap(d, { id: 'RA', username: 'radm', pw: 'Password12345' })
  const t = await addUser(d, { id: 'RT', username: 'ruser', pw: 'Password12345' })
  const old = cookieOf(await login(d, t.username, t.pw))
  const ck = cookieOf(await login(d, a.username, a.pw))
  ok((await req(d, 'POST', '/api/auth/users/RT/reset-password', { cookie: ck, body: { tempPassword: 'ResetPass12345' } })).status === 200)
  ok((await req(d, 'GET', '/api/auth/session', { cookie: old })).status === 401)
  const nw = cookieOf(await login(d, t.username, 'ResetPass12345'))
  ok((await jres(await req(d, 'GET', '/api/auth/session', { cookie: nw }))).mustChangePassword === true)
})
await itest('I-27', 'Session 节流 60s：连续查询不重复写 last_seen_at', async () => {
  const d = new D1Local()
  const a = await bootstrap(d, { id: 'TH', username: 'throttle', pw: 'Password12345' })
  const ck = cookieOf(await login(d, a.username, a.pw))
  const h = await password.tokenHash(ck.split('=')[1])
  const before = d.q('SELECT last_seen_at FROM sessions WHERE token_hash=?', h)[0].last_seen_at
  ok((await req(d, 'GET', '/api/auth/session', { cookie: ck })).status === 200)
  const after = d.q('SELECT last_seen_at FROM sessions WHERE token_hash=?', h)[0].last_seen_at
  ok(before === after, '节流内不应更新')
  const stale = new Date(Date.now() - 90 * 1000).toISOString()
  d.exec('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?', stale, h)
  ok((await req(d, 'GET', '/api/auth/session', { cookie: ck })).status === 200)
  const after2 = d.q('SELECT last_seen_at FROM sessions WHERE token_hash=?', h)[0].last_seen_at
  ok(after2 !== stale, '超过 60s 应更新')
})
await itest('I-28', '登出幂等：无 Cookie / 无效 Cookie 均 200 且清 Cookie', async () => {
  const d = new D1Local()
  await bootstrap(d, { id: 'LO', username: 'logout', pw: 'Password12345' })
  for (const c of [undefined, 'sf_session=invalid', 'sf_session=' + 'A'.repeat(43)]) {
    const r = await req(d, 'POST', '/api/auth/logout', { cookie: c })
    ok(r.status === 200, 'status=' + r.status)
    ok((r.headers.get('set-cookie') || '').includes('Max-Age=0'), '应清 Cookie')
  }
})
await itest('I-29', '限速：成功与失败尝试均占额度，第 6 次 429', async () => {
  const d = new D1Local()
  const a = await bootstrap(d, { id: 'RL', username: 'ratelimit', pw: 'Password12345' })
  for (let i = 0; i < 5; i++) {
    const r = await login(d, a.username, i % 2 === 0 ? a.pw : 'WrongPassword1', { ip: '10.0.0.1' })
    ok(r.status === 200 || r.status === 401, '第 ' + (i + 1) + ' 次=' + r.status)
  }
  ok(d.q("SELECT COUNT(*) c FROM login_attempts WHERE username='ratelimit'")[0].c === 5, '5 条尝试')
  ok(d.q("SELECT COUNT(*) c FROM login_attempts WHERE username='ratelimit' AND success=1")[0].c === 3, '成功 3 条')
  const r6 = await login(d, a.username, a.pw, { ip: '10.0.0.1' })
  ok(r6.status === 429, '第 6 次=' + r6.status)
  ok((await jres(r6)).error === 'RATE_LIMITED')
  ok(Number(r6.headers.get('retry-after')) > 0, 'Retry-After')
})
await itest('I-30', '限速窗口过期后恢复；已登录 Session 不受影响', async () => {
  const d = new D1Local()
  const a = await bootstrap(d, { id: 'RW', username: 'window', pw: 'Password12345' })
  const ck = cookieOf(await login(d, a.username, a.pw, { ip: '10.0.0.2' }))
  for (let i = 0; i < 4; i++) await login(d, a.username, 'WrongPassword1', { ip: '10.0.0.2' })
  ok((await login(d, a.username, a.pw, { ip: '10.0.0.2' })).status === 429)
  ok((await req(d, 'GET', '/api/auth/session', { cookie: ck })).status === 200, '已登录 Session 不受影响')
  d.exec("UPDATE login_attempts SET attempted_at='2026-11-08T09:00:00.000Z'")
  ok((await login(d, a.username, a.pw, { ip: '10.0.0.2' })).status === 200, '窗口过期后恢复')
})
await itest('I-31', '已知用户名反复失败的 DoS 边界（5 次后 429，窗口后恢复）', async () => {
  const d = new D1Local()
  const a = await bootstrap(d, { id: 'DS', username: 'dosuser', pw: 'Password12345' })
  for (let i = 0; i < 5; i++) ok((await login(d, a.username, 'WrongPassword1', { ip: '10.0.0.9' })).status === 401)
  ok((await login(d, a.username, a.pw, { ip: '10.0.0.9' })).status === 429, '合法用户也被限')
  d.exec("UPDATE login_attempts SET attempted_at='2026-11-08T09:00:00.000Z'")
  ok((await login(d, a.username, a.pw, { ip: '10.0.0.9' })).status === 200, '自动恢复')
})
await itest('I-32', '不可信转发头不能改变可信 IP', async () => {
  const d = new D1Local()
  const a = await bootstrap(d, { id: 'IP', username: 'ipuser', pw: 'Password12345' })
  await login(d, a.username, 'WrongPassword1', { headers: { 'X-Forwarded-For': '9.9.9.9', 'X-Real-IP': '8.8.8.8' } })
  const rows = d.q('SELECT ip FROM login_attempts')
  ok(rows.length === 1 && rows[0].ip === 'unknown', JSON.stringify(rows))
})
await itest('I-33', 'unknown 共享桶按 5 次/5min 工作（不同账号共用）', async () => {
  const d = new D1Local()
  await bootstrap(d, { id: 'UK', username: 'ukuser', pw: 'Password12345' })
  for (let i = 0; i < 5; i++) ok((await login(d, 'ghost' + i, 'WrongPassword1')).status === 401)
  ok((await login(d, 'ghost6', 'WrongPassword1')).status === 429, 'unknown 第 6 次')
})
await itest('I-34', 'CSRF：异源 Origin / cross-site → 403', async () => {
  const d = new D1Local()
  const a = await bootstrap(d, { id: 'CS', username: 'csrfadm', pw: 'Password12345' })
  const ck = cookieOf(await login(d, a.username, a.pw))
  const r1 = await req(d, 'POST', '/api/auth/users', {
    cookie: ck, headers: { Origin: 'https://evil.example' },
    body: { username: 'x', role: 'teacher', tempPassword: 'Password12345' },
  })
  ok(r1.status === 403, 'origin=' + r1.status)
  const r2 = await req(d, 'POST', '/api/auth/change-password', {
    cookie: ck, headers: { 'Sec-Fetch-Site': 'cross-site' },
    body: { currentPassword: a.pw, newPassword: 'OtherPass12345' },
  })
  ok(r2.status === 403, 'sec-fetch-site=' + r2.status)
})
await itest('I-35', '/api/v1/* 在登录成功后仍 403（deny_all 不变）', async () => {
  const d = new D1Local()
  const a = await bootstrap(d, { id: 'GW', username: 'gwadm', pw: 'Password12345' })
  const ck = cookieOf(await login(d, a.username, a.pw))
  const r = await req(d, 'GET', '/api/v1/buildings', { cookie: ck })
  ok(r.status === 403, 'status=' + r.status)
  const b = await jres(r)
  ok(b.error === '服务未开放', JSON.stringify(b))
})
await itest('I-36', '/api/auth/* 不被 gatewayGuard 拦截（401/200 而非 403）', async () => {
  const d = new D1Local()
  await bootstrap(d, { id: 'AG', username: 'agadm', pw: 'Password12345' })
  ok((await req(d, 'GET', '/api/auth/session')).status === 401)
  ok((await req(d, 'POST', '/api/auth/logout')).status === 200)
  ok((await req(d, 'GET', '/healthz')).status === 200, 'healthz 仍放行')
})
await itest('I-37', '环境变量 PBKDF2_ITERATIONS 越界 → 503 且不执行 KDF', async () => {
  for (const v of ['50', '1000001', 'abc', '']) {
    const d = new D1Local()
    await bootstrap(d, { id: 'EV', username: 'evuser', pw: 'Password12345' })
    const r = await login(d, 'evuser', 'Password12345', { envExtra: { PBKDF2_ITERATIONS: v } })
    ok(r.status === 503, `env=${v} status=${r.status}`)
    ok((await jres(r)).error === 'AUTH_CONFIG_INVALID')
  }
  ok(password.envIterations({}) === 100000, '默认值')
})
await itest('I-38', 'DB users.iterations 越界 → 503，不执行 KDF', async () => {
  const d = new D1Local()
  await bootstrap(d, { id: 'DV', username: 'dbiter', pw: 'Password12345' })
  d.exec("UPDATE users SET iterations=2000000 WHERE id='DV'")
  const r = await login(d, 'dbiter', 'Password12345')
  ok(r.status === 503, 'status=' + r.status)
  ok((await jres(r)).error === 'AUTH_CONFIG_INVALID', JSON.stringify(await jres(r).catch(() => null)))
})
await itest('I-39', '核心事务中途失败 → 503 且整体回滚（无部分成功）', async () => {
  const d = new D1Local()
  const a = await bootstrap(d, { id: 'TX', username: 'txuser', pw: 'Password12345' })
  const ck = cookieOf(await login(d, a.username, a.pw))
  const before = d.q("SELECT password_hash, must_change_password FROM users WHERE id='TX'")[0]
  d.failRule = (sql, phase) => phase === 'batch' && /UPDATE users/.test(sql)
  const r = await req(d, 'POST', '/api/auth/change-password', {
    cookie: ck, body: { currentPassword: a.pw, newPassword: 'AnotherPass123' },
  })
  ok(r.status === 503, 'status=' + r.status)
  const after = d.q("SELECT password_hash, must_change_password FROM users WHERE id='TX'")[0]
  ok(before.password_hash === after.password_hash, '密码未变')
  ok(d.q("SELECT COUNT(*) c FROM sessions WHERE revoked_at IS NOT NULL")[0].c === 0, 'Session 未撤销')
  ok(d.q('SELECT COUNT(*) c FROM password_history')[0].c === 0, '历史未写入')
})
await itest('I-40', '核心成功但审计写入失败 → 核心仍成功，独立错误记录，审计可缺失', async () => {
  const d = new D1Local()
  const a = await bootstrap(d, { id: 'AU', username: 'audituser', pw: 'Password12345' })
  const ck = cookieOf(await login(d, a.username, a.pw))
  const origErr = console.error
  const captured = []
  console.error = (...args) => { captured.push(args.map(String).join(' ')) }
  try {
    d.failRule = (sql) => /INSERT INTO auth_audit/.test(sql)
    const r = await req(d, 'POST', '/api/auth/change-password', {
      cookie: ck, body: { currentPassword: a.pw, newPassword: 'AuditPass12345' },
    })
    ok(r.status === 200, '核心应成功 status=' + r.status)
  } finally { console.error = origErr }
  ok((await login(d, a.username, 'AuditPass12345')).status === 200, '新密码生效')
  ok((await login(d, a.username, a.pw)).status === 401, '旧密码失效')
  ok(captured.some((x) => x.includes('[auth-audit-write-failed]')), '独立错误记录')
  ok(captured.every((x) => !x.includes('AuditPass12345') && !x.includes(a.pw)), '错误记录不含密码')
  ok(d.q("SELECT COUNT(*) c FROM auth_audit WHERE event='password_change'")[0].c === 0, '审计可缺失')
})
await itest('I-41', 'D1 查询异常 → 503 fail-closed（不放行）', async () => {
  const d = new D1Local()
  await bootstrap(d, { id: 'DQ', username: 'dbquery', pw: 'Password12345' })
  const ck = cookieOf(await login(d, 'dbquery', 'Password12345'))
  d.failRule = (sql, phase) => phase === 'get' && /FROM sessions/.test(sql)
  const r = await req(d, 'GET', '/api/auth/session', { cookie: ck })
  ok(r.status === 503, 'status=' + r.status)
  ok((await jres(r)).error === 'AUTH_UNAVAILABLE')
})
await itest('I-42', 'D1 写入异常 / 限速异常 → 503 fail-closed', async () => {
  const d = new D1Local()
  await bootstrap(d, { id: 'DW', username: 'dbwrite', pw: 'Password12345' })
  d.failRule = (sql) => /INSERT INTO login_attempts/.test(sql)
  const r = await login(d, 'dbwrite', 'Password12345')
  ok(r.status === 503, '限速异常=' + r.status)
})
await itest('I-43', '审计 detail 白名单：仅 code/field/空对象', async () => {
  const d = new D1Local()
  const a = await bootstrap(d, { id: 'WD', username: 'whitelist', pw: 'Password12345' })
  const ck = cookieOf(await login(d, a.username, a.pw))
  await req(d, 'POST', '/api/auth/users', { cookie: ck, body: { username: 'wdu', role: 'teacher', tempPassword: 'Password12345' } })
  const details = d.q('SELECT detail FROM auth_audit').map((x) => JSON.parse(x.detail))
  ok(details.length > 0)
  for (const x of details) {
    for (const k of Object.keys(x)) ok(['code', 'field'].includes(k), '非法键 ' + k)
  }
})
await itest('I-44', '审计不含 Token/Hash/Salt/临时密码', async () => {
  const d = new D1Local()
  const a = await bootstrap(d, { id: 'SN', username: 'sensitive', pw: 'Password12345' })
  const ck = cookieOf(await login(d, a.username, a.pw))
  await req(d, 'POST', '/api/auth/users', { cookie: ck, body: { username: 'snu', role: 'teacher', tempPassword: 'UniqueTemp9981' } })
  const dump = JSON.stringify(d.q('SELECT * FROM auth_audit'))
  for (const s of ['UniqueTemp9981', 'Password12345', 'sf_session', 'salt', 'password_hash']) {
    ok(!dump.includes(s), '审计含 ' + s)
  }
})
await itest('I-45', '参数边界：非法 body / 短密码 / 非法角色 → 400', async () => {
  const d = new D1Local()
  const a = await bootstrap(d, { id: 'BD', username: 'badreq', pw: 'Password12345' })
  const ck = cookieOf(await login(d, a.username, a.pw))
  const r1 = await req(d, 'POST', '/api/auth/users', { cookie: ck, body: { username: 'x', role: 'teacher', tempPassword: 'short' } })
  ok(r1.status === 400, '短临时密码=' + r1.status)
  const r2 = await req(d, 'POST', '/api/auth/users', { cookie: ck, body: { username: 'x', role: 'superadmin', tempPassword: 'Password12345' } })
  ok(r2.status === 400, '非法角色=' + r2.status)
  const r3 = await req(d, 'POST', '/api/auth/change-password', { cookie: ck, body: { currentPassword: 'short', newPassword: 'Password12345' } })
  ok(r3.status === 400, '短当前密码=' + r3.status)
})
await itest('I-46', '多 Session 并发有效', async () => {
  const d = new D1Local()
  const a = await bootstrap(d, { id: 'MS', username: 'multisess', pw: 'Password12345' })
  const c1 = cookieOf(await login(d, a.username, a.pw))
  const c2 = cookieOf(await login(d, a.username, a.pw))
  ok(c1 !== c2, '两个不同 token')
  ok((await req(d, 'GET', '/api/auth/session', { cookie: c1 })).status === 200)
  ok((await req(d, 'GET', '/api/auth/session', { cookie: c2 })).status === 200)
})
await itest('I-47', '用户名冲突 → 409；未知用户管理操作 → 404', async () => {
  const d = new D1Local()
  const a = await bootstrap(d, { id: 'CF', username: 'conflict', pw: 'Password12345' })
  const ck = cookieOf(await login(d, a.username, a.pw))
  const r = await req(d, 'POST', '/api/auth/users', { cookie: ck, body: { username: 'conflict', role: 'teacher', tempPassword: 'Password12345' } })
  ok(r.status === 409, 'conflict=' + r.status)
  const p = await req(d, 'PATCH', '/api/auth/users/NOPE', { cookie: ck, body: { status: 'disabled' } })
  ok(p.status === 404, 'notfound=' + p.status)
})
await itest('I-48', '审计错误不影响核心：禁用用户后状态正确、Session 撤销', async () => {
  const d = new D1Local()
  const a = await bootstrap(d, { id: 'DA', username: 'disadmin', pw: 'Password12345' })
  const t = await addUser(d, { id: 'DT', username: 'disuser', pw: 'Password12345' })
  const targetCk = cookieOf(await login(d, t.username, t.pw))
  const ck = cookieOf(await login(d, a.username, a.pw))
  const origErr = console.error
  console.error = () => {}
  try {
    d.failRule = (sql) => /INSERT INTO auth_audit/.test(sql)
    const r = await req(d, 'PATCH', '/api/auth/users/DT', { cookie: ck, body: { status: 'disabled' } })
    ok(r.status === 200, '核心成功=' + r.status)
  } finally { console.error = origErr; d.failRule = null }
  ok(d.q("SELECT status FROM users WHERE id='DT'")[0].status === 'disabled')
  ok((await req(d, 'GET', '/api/auth/session', { cookie: targetCk })).status === 401)
})

// ═══════════════════════════════════════════════════════════════════════════
console.log('=== N 修正专项（限速覆盖 / KDF 边界 / CSRF / 清理 / 代理项 / 故障注入）===')
// ═══════════════════════════════════════════════════════════════════════════

// ── N-1 无效用户名也占用限速槽位 ────────────────────────────────────────────
await itest('N-1', '空用户名持续请求消耗额度：5 次后第 6 次 429（invalid 账号桶）', async (d) => {
  for (let k = 0; k < 5; k++) {
    const r = await login(d, '   ', 'Password12345', { ip: '10.1.0.1' })
    ok(r.status === 401, '第 ' + (k + 1) + ' 次=' + r.status)
  }
  const r6 = await login(d, '   ', 'Password12345', { ip: '10.1.0.1' })
  ok(r6.status === 429, '第 6 次=' + r6.status)
  ok(d.q('SELECT COUNT(*) c FROM login_attempts').at(0).c === 5, '仅 5 条尝试')
})
await itest('N-2', '超长用户名（>32）持续请求消耗额度', async (d) => {
  const long = 'a'.repeat(33)
  for (let k = 0; k < 5; k++) ok((await login(d, long, 'Password12345', { ip: '10.1.0.2' })).status === 401)
  ok((await login(d, long, 'Password12345', { ip: '10.1.0.2' })).status === 429, '第 6 次应 429')
})
await itest('N-3', '控制字符用户名持续请求消耗额度', async (d) => {
  const bad = 'bad' + String.fromCharCode(0) + 'user'
  for (let k = 0; k < 5; k++) ok((await login(d, bad, 'Password12345', { ip: '10.1.0.3' })).status === 401)
  ok((await login(d, bad, 'Password12345', { ip: '10.1.0.3' })).status === 429, '第 6 次应 429')
})
await itest('N-4', '无效用户名也受账号维度 5 次/5min 约束（不同无效名共享 invalid 桶）', async (d) => {
  const names = ['', '   ', 'x'.repeat(33), 'a' + String.fromCharCode(0) + 'b', String.fromCharCode(0x7f)]
  let last = 0
  for (const nm of names) {
    for (let k = 0; k < 4; k++) {
      last = (await login(d, nm, 'Password12345', { ip: '10.1.0.4' })).status
      if (last === 429) break
    }
    if (last === 429) break
  }
  ok(last === 429, 'invalid 桶应在 5 次后 429，实际末次=' + last)
  const total = d.q("SELECT COUNT(*) c FROM login_attempts WHERE ip='10.1.0.4'").at(0).c
  ok(total <= 20, 'IP 桶不应超发，实际=' + total)
})
await itest('N-5', '达到限速后不再执行 KDF', async (d) => {
  for (let k = 0; k < 5; k++) await login(d, 'kdfuser', 'WrongPassword1', { ip: '10.1.0.5' })
  const before = password.kdfCallCount.value
  const r = await login(d, 'kdfuser', 'WrongPassword1', { ip: '10.1.0.5' })
  ok(r.status === 429, 'status=' + r.status)
  ok(password.kdfCallCount.value === before, 'KDF 调用数应不变 before=' + before + ' after=' + password.kdfCallCount.value)
})
await itest('N-6', '限速仍统计成功/失败/pending 全部尝试', async (d, adm) => {
  await login(d, adm.username, adm.pw, { ip: '10.1.0.6' })
  await login(d, adm.username, 'WrongPassword1', { ip: '10.1.0.6' })
  await login(d, 'ghostn6', 'WrongPassword1', { ip: '10.1.0.6' })
  await login(d, '   ', 'Password12345', { ip: '10.1.0.6' })
  const rows = d.q("SELECT success FROM login_attempts WHERE ip='10.1.0.6'")
  ok(rows.length === 4, '应有 4 条，实际=' + rows.length)
  ok(rows.filter((x) => x.success === 1).length === 1, '成功 1 条')
  ok(rows.filter((x) => x.success === 0).length === 3, '未成功 3 条')
})

// ── N-2 KDF 输入边界 ───────────────────────────────────────────────────────
await itest('N-7', '超过请求体上限的 JSON 被拒（实读字节，不只看 Content-Length）', async (d) => {
  const huge = JSON.stringify({ username: 'a', password: 'x'.repeat(9000) })
  const r = await req(d, 'POST', '/api/auth/login', { rawBody: huge })
  ok(r.status === 413, 'status=' + r.status)
  ok((await jres(r)).error === 'PAYLOAD_TOO_LARGE')
})
await itest('N-8', '声明 Content-Length 超限时提前 413', async (d) => {
  const r = await req(d, 'POST', '/api/auth/login', {
    rawBody: '{"username":"a","password":"b"}',
    headers: { 'content-length': String(999999) },
  })
  ok(r.status === 413, 'status=' + r.status)
})
await itest('N-9', '超长密码（>128 码点）不进入 KDF', async (d, adm) => {
  const before = password.kdfCallCount.value
  const r = await login(d, adm.username, 'x'.repeat(200), { ip: '10.2.0.1' })
  ok(r.status === 401, 'status=' + r.status)
  ok(password.kdfCallCount.value === before, '不应触发 KDF')
})
await itest('N-10', '超 UTF-8 字节限制（>512B）不进入 KDF', async (d, adm) => {
  const before = password.kdfCallCount.value
  const r = await login(d, adm.username, String.fromCodePoint(0x1f600).repeat(200), { ip: '10.2.0.2' })
  ok(r.status === 401, 'status=' + r.status)
  ok(password.kdfCallCount.value === before, '不应触发 KDF')
})
await itest('N-11', '无效用户名 + 超长密码不触发无界 KDF', async (d) => {
  const before = password.kdfCallCount.value
  const r = await login(d, '   ', 'x'.repeat(500), { ip: '10.2.0.3' })
  ok(r.status === 401, 'status=' + r.status)
  ok(password.kdfCallCount.value === before, '不应触发 KDF')
})
await itest('N-12', '合法 Unicode / emoji 密码仍可正常验证', async (d) => {
  const pw = '中文密码十二个字' + String.fromCodePoint(0x1f600) + 'Abc'
  ok(password.validatePasswordInput(pw) === null, '测试密码应合法')
  const u = await addUser(d, { id: 'N12', username: 'n12user', pw })
  ok((await login(d, u.username, pw, { ip: '10.2.0.4' })).status === 200, 'Unicode 登录')
  ok((await login(d, u.username, pw + 'x', { ip: '10.2.0.4' })).status === 401, '错误密码')
})
await atest('N-13', 'U', 'pbkdf2 内部守卫：超长密码抛 AuthInputError 且不计数', async () => {
  const before = password.kdfCallCount.value
  let threw = false
  try { await password.deriveHash('x'.repeat(200), password.generateSaltB64(), ITER) } catch (e) {
    threw = e instanceof password.AuthInputError
  }
  ok(threw, '应抛 AuthInputError')
  ok(password.kdfCallCount.value === before, 'KDF 计数不应增加')
})

// ── N-3 CSRF 完整 Origin ───────────────────────────────────────────────────
await itest('N-14', '同 host 不同 scheme → 403', async (d, adm) => {
  const ck = cookieOf(await login(d, adm.username, adm.pw))
  const r = await req(d, 'POST', '/api/auth/change-password', {
    cookie: ck, csrf: { origin: 'https://localhost' },
    body: { currentPassword: adm.pw, newPassword: 'AnotherPass123' },
  })
  ok(r.status === 403, 'status=' + r.status)
  ok((await jres(r)).error === 'CSRF_REJECTED')
})
await itest('N-15', '同 scheme 不同 port → 403', async (d, adm) => {
  const ck = cookieOf(await login(d, adm.username, adm.pw))
  const r = await req(d, 'POST', '/api/auth/change-password', {
    cookie: ck, csrf: { origin: 'http://localhost:8080' },
    body: { currentPassword: adm.pw, newPassword: 'AnotherPass123' },
  })
  ok(r.status === 403, 'status=' + r.status)
})
await itest('N-16', '非法 Origin → 403', async (d, adm) => {
  const ck = cookieOf(await login(d, adm.username, adm.pw))
  const r = await req(d, 'POST', '/api/auth/change-password', {
    cookie: ck, csrf: { origin: 'not-a-url' },
    body: { currentPassword: adm.pw, newPassword: 'AnotherPass123' },
  })
  ok(r.status === 403, 'status=' + r.status)
})
await itest('N-17', 'Origin 与 Sec-Fetch-Site 同时缺失 → 403（fail-closed）', async (d, adm) => {
  const ck = cookieOf(await login(d, adm.username, adm.pw))
  const r = await req(d, 'POST', '/api/auth/change-password', {
    cookie: ck, csrf: { origin: null },
    body: { currentPassword: adm.pw, newPassword: 'AnotherPass123' },
  })
  ok(r.status === 403, 'status=' + r.status)
  ok((await jres(r)).error === 'CSRF_REJECTED')
})
await itest('N-18', 'Sec-Fetch-Site: none / same-site → 403', async (d, adm) => {
  const ck = cookieOf(await login(d, adm.username, adm.pw))
  for (const site of ['none', 'same-site']) {
    const r = await req(d, 'POST', '/api/auth/change-password', {
      cookie: ck, csrf: { origin: null, site },
      body: { currentPassword: adm.pw, newPassword: 'AnotherPass123' },
    })
    ok(r.status === 403, 'site=' + site + ' status=' + r.status)
  }
})
await itest('N-19', '合法同源（Origin 同源 / Sec-Fetch-Site: same-origin）均通过', async (d, adm) => {
  const ck = cookieOf(await login(d, adm.username, adm.pw))
  const r1 = await req(d, 'POST', '/api/auth/change-password', {
    cookie: ck, csrf: { origin: SAME_ORIGIN },
    body: { currentPassword: adm.pw, newPassword: 'NewPass12345A' },
  })
  ok(r1.status === 200, 'origin only=' + r1.status)
  const ck2 = cookieOf(await login(d, adm.username, 'NewPass12345A'))
  const r2 = await req(d, 'POST', '/api/auth/change-password', {
    cookie: ck2, csrf: { origin: null, site: 'same-origin' },
    body: { currentPassword: 'NewPass12345A', newPassword: 'NewPass12345B' },
  })
  ok(r2.status === 200, 'site only=' + r2.status)
})
await itest('N-20', 'Login CSRF：login 接口同样拒绝异源 / 双缺失', async (d, adm) => {
  const r1 = await login(d, adm.username, adm.pw, { csrf: { origin: 'https://evil.example' } })
  ok(r1.status === 403, '异源=' + r1.status)
  const r2 = await login(d, adm.username, adm.pw, { csrf: { origin: null } })
  ok(r2.status === 403, '双缺失=' + r2.status)
  const r3 = await login(d, adm.username, adm.pw)
  ok(r3.status === 200, '同源=' + r3.status)
})

// ── N-4 login_attempts 清理 ───────────────────────────────────────────────
await itest('N-21', '有界清理：过期记录被删除，窗口内有效记录保留', async (d, adm) => {
  const nowReal = new Date().toISOString()
  await login(d, adm.username, adm.pw, { ip: '10.4.0.1' })
  const old = new Date(Date.now() - 25 * 3600 * 1000).toISOString()
  d.exec("INSERT INTO login_attempts (username, ip, attempted_at, success, reason) VALUES ('old','10.4.0.9',?,0,'old')", old)
  ok(d.q('SELECT COUNT(*) c FROM login_attempts').at(0).c === 2)
  await ratelimit.pruneAttempts(d, nowReal)
  const rows = d.q('SELECT username FROM login_attempts')
  ok(rows.length === 1 && rows[0].username === adm.username, JSON.stringify(rows))
})
await itest('N-22', '清理不删除窗口内有效限速记录', async (d, adm) => {
  const nowReal = new Date().toISOString()
  for (let k = 0; k < 3; k++) await login(d, adm.username, 'WrongPassword1', { ip: '10.4.0.2' })
  await ratelimit.pruneAttempts(d, nowReal)
  ok(d.q('SELECT COUNT(*) c FROM login_attempts').at(0).c === 3, '窗口内记录应全部保留')
})
await itest('N-23', '清理失败不放行登录（maybePrune 吞错，认证判定不受影响）', async (d, adm) => {
  d.failRule = (sql) => /DELETE FROM login_attempts/.test(sql)
  const r = await login(d, adm.username, adm.pw, { ip: '10.4.0.3' })
  ok(r.status === 200, '登录应成功=' + r.status)
  d.failRule = null
  ok(d.q('SELECT COUNT(*) c FROM login_attempts WHERE username=?', adm.username).at(0).c >= 1)
})
await itest('N-24', '清理不影响 auth_audit', async (d, adm) => {
  const nowReal = new Date().toISOString()
  await login(d, adm.username, adm.pw, { ip: '10.4.0.4' })
  const before = d.q('SELECT COUNT(*) c FROM auth_audit').at(0).c
  const old = new Date(Date.now() - 30 * 3600 * 1000).toISOString()
  d.exec("INSERT INTO login_attempts (username, ip, attempted_at, success, reason) VALUES ('old2','10.4.0.9',?,0,'old')", old)
  await ratelimit.pruneAttempts(d, nowReal)
  ok(d.q('SELECT COUNT(*) c FROM auth_audit').at(0).c === before, '审计行数应不变')
})
await atest('N-25', 'U', 'maybePrune 触发条件：仅 attemptId 为 32 倍数时执行', async () => {
  const d = new D1Local()
  const old = new Date(Date.now() - 30 * 3600 * 1000).toISOString()
  const seed = () => d.exec("INSERT INTO login_attempts (username, ip, attempted_at, success, reason) VALUES ('o','10.4.1.1',?,0,'o')", old)
  await seed()
  await ratelimit.maybePrune(d, 31, new Date().toISOString())
  ok(d.q('SELECT COUNT(*) c FROM login_attempts').at(0).c === 1, '31 不应清理')
  await ratelimit.maybePrune(d, 32, new Date().toISOString())
  ok(d.q('SELECT COUNT(*) c FROM login_attempts').at(0).c === 0, '32 应清理')
})

// ── N-5 UTF-16 代理项 ─────────────────────────────────────────────────────
const HI = String.fromCharCode(0xd800)
const LO = String.fromCharCode(0xdc00)
test('N-26', 'U', '孤立高代理项（开头/中间/结尾）均拒绝', () => {
  for (const v of [HI + 'Abcdefghijk1', 'Abcde' + HI + 'fghijk1', 'Abcdefghijk1' + HI]) {
    ok(password.validatePasswordInput(v) === 'INVALID_INPUT', JSON.stringify(v))
  }
})
test('N-27', 'U', '孤立低代理项（开头/中间/结尾）均拒绝', () => {
  for (const v of [LO + 'Abcdefghijk1', 'Abcde' + LO + 'fghijk1', 'Abcdefghijk1' + LO]) {
    ok(password.validatePasswordInput(v) === 'INVALID_INPUT', JSON.stringify(v))
  }
})
test('N-28', 'U', '合法代理对（非 BMP）通过', () => {
  const emoji = String.fromCodePoint(0x1f600)
  ok(password.validatePasswordInput(emoji.repeat(12)) === null, '12 emoji')
  ok(password.validatePasswordInput('中文' + emoji + '密码🎉12345abc') === null)
  ok(password.validatePasswordInput(String.fromCharCode(0xd83d, 0xde00).repeat(12)) === null, '合法代理对 x12')
})
test('N-29', 'U', '普通中文/英文/特殊字符通过', () => {
  ok(password.validatePasswordInput('Password1234') === null)
  ok(password.validatePasswordInput('中文密码十二个字呀abcd') === null)
  ok(password.validatePasswordInput('P@ssw0rd!#$%^&*()_+') === null)
})
test('N-30', 'U', 'hasLoneSurrogate 精确判定', () => {
  ok(password.hasLoneSurrogate(HI) === true)
  ok(password.hasLoneSurrogate(LO) === true)
  ok(password.hasLoneSurrogate(String.fromCharCode(0xd83d, 0xde00)) === false)
  ok(password.hasLoneSurrogate('abc') === false)
})

// ── N-6 登录成功故障注入 ───────────────────────────────────────────────────
await itest('N-31', 'loadPrincipal 失败 → 撤销刚创建 Session 并 503（不留孤立凭据）', async (d, adm) => {
  let calls = 0
  d.failRule = (sql, phase) => {
    if (phase === 'get' && /FROM sessions/.test(sql)) {
      calls += 1
      if (calls === 1) return true
    }
    return false
  }
  const r = await login(d, adm.username, adm.pw, { ip: '10.6.0.1' })
  ok(r.status === 503, 'status=' + r.status)
  d.failRule = null
  const live = d.q('SELECT COUNT(*) c FROM sessions WHERE revoked_at IS NULL').at(0).c
  ok(live === 0, '不应留下有效 Session，实际=' + live)
})
await itest('N-32', '核心 after-createSession 异常 → Session 撤销且 503', async (d, adm) => {
  d.failRule = (sql, phase) => phase === 'run' && /UPDATE users SET last_login_at/.test(sql)
  const r = await login(d, adm.username, adm.pw, { ip: '10.6.0.2' })
  ok(r.status === 503, 'status=' + r.status)
  d.failRule = null
  ok(d.q('SELECT COUNT(*) c FROM sessions WHERE revoked_at IS NULL').at(0).c === 0, '不应留下有效 Session')
})
await itest('N-33', '审计写入失败不影响登录成功（核心不回滚）', async (d, adm) => {
  const orig = console.error
  console.error = () => {}
  try {
    d.failRule = (sql) => /INSERT INTO auth_audit/.test(sql)
    const r = await login(d, adm.username, adm.pw, { ip: '10.6.0.3' })
    ok(r.status === 200, 'status=' + r.status)
  } finally { console.error = orig; d.failRule = null }
  ok(d.q('SELECT COUNT(*) c FROM sessions WHERE revoked_at IS NULL').at(0).c === 1, 'Session 应有效')
})
await itest('N-34', 'markAttempt 失败（best-effort）不影响登录成功', async (d, adm) => {
  d.failRule = (sql, phase) => phase === 'run' && /UPDATE login_attempts SET success/.test(sql)
  const r = await login(d, adm.username, adm.pw, { ip: '10.6.0.4' })
  ok(r.status === 200, 'status=' + r.status)
  d.failRule = null
  ok(d.q('SELECT COUNT(*) c FROM sessions WHERE revoked_at IS NULL').at(0).c === 1)
})

// ── N-7 畸形 salt / hash ──────────────────────────────────────────────────
await itest('N-35', '畸形 salt（非 Base64 / 长度错误）→ 503，不绕过验证', async (d, adm) => {
  const cases = ['not-base64!!', 'AAAA', 'A'.repeat(24), '']
  for (const sv of cases) {
    d.exec('UPDATE users SET salt = ? WHERE id = ?', sv, adm.id)
    const r = await login(d, adm.username, adm.pw, { ip: '10.7.0.1' })
    ok(r.status === 503, 'salt=' + JSON.stringify(sv) + ' status=' + r.status)
  }
})
await itest('N-36', '畸形 hash（非 Base64 / 长度错误）→ 503，不绕过验证', async (d, adm) => {
  for (const hv of ['zzz', 'AAAA', 'A'.repeat(44), '']) {
    d.exec('UPDATE users SET password_hash = ? WHERE id = ?', hv, adm.id)
    const r = await login(d, adm.username, adm.pw, { ip: '10.7.0.2' })
    ok(r.status === 503, 'hash=' + JSON.stringify(hv) + ' status=' + r.status)
  }
})
test('N-37', 'U', 'decodeB64Exact / assertStoredCredential 单元边界', () => {
  ok(password.decodeB64Exact(password.generateSaltB64(), 16).length === 16)
  for (const pair of [['AAAA', 16], ['A'.repeat(24), 32], ['', 16], ['!!!!', 16], [null, 16], [123, 16]]) {
    let threw = false
    try { password.decodeB64Exact(pair[0], pair[1]) } catch (e) { threw = e instanceof password.AuthConfigError }
    ok(threw, '应拒绝 ' + String(pair[0]))
  }
  let threw = false
  try { password.assertStoredCredential('bad', password.generateSaltB64()) } catch (e) { threw = e instanceof password.AuthConfigError }
  ok(threw)
})

// ── N-8 P1：流式硬限制（ReadableStream 边读边限） ──────────────────────────
await itest('N-38', '无 Content-Length 的流式超限 body → 413 且调用 reader.cancel', async (d) => {
  const proto = ReadableStreamDefaultReader.prototype
  const orig = proto.cancel
  let cancels = 0
  proto.cancel = function patchedCancel(...args) { cancels += 1; return orig.apply(this, args) }
  try {
    const state = { enqueued: 0, cancelled: false, enqueuedAtCancel: 0 }
    const stream = makeChunkStream([utf8('x'.repeat(9 * 1024))], state)
    const r = await req(d, 'POST', '/api/auth/login', { streamBody: stream })
    ok(r.status === 413, 'status=' + r.status)
    ok((await jres(r)).error === 'PAYLOAD_TOO_LARGE')
    ok(cancels >= 1, '应调用 reader.cancel，实际=' + cancels)
  } finally { proto.cancel = orig }
})
await itest('N-39', 'Content-Length 缺失但实读超 8KB（两块累计）→ 413 且取消', async (d) => {
  const proto = ReadableStreamDefaultReader.prototype
  const orig = proto.cancel
  let cancels = 0
  proto.cancel = function patchedCancel2(...args) { cancels += 1; return orig.apply(this, args) }
  try {
    const state = { enqueued: 0, cancelled: false, enqueuedAtCancel: 0 }
    const stream = makeChunkStream([utf8('a'.repeat(5000)), utf8('b'.repeat(5000))], state)
    const r = await req(d, 'POST', '/api/auth/login', { streamBody: stream })
    ok(r.status === 413, 'status=' + r.status)
    ok(cancels >= 1, '应调用 reader.cancel，实际=' + cancels)
  } finally { proto.cancel = orig }
})
await itest('N-40', '多个小 chunk 累计超 8KB → 413 且提前停止', async (d) => {
  const chunks = Array.from({ length: 20 }, () => utf8('z'.repeat(512))) // 10KB
  const state = { enqueued: 0, cancelled: false, enqueuedAtCancel: 0 }
  const r = await req(d, 'POST', '/api/auth/login', { streamBody: makeChunkStream(chunks, state) })
  ok(r.status === 413, 'status=' + r.status)
  ok(state.enqueued < chunks.length, '不应读完所有 chunk，实际 enqueued=' + state.enqueued)
})
await itest('N-41', '恰好 8KB 的合法 body 可通过（不误杀边界值）', async (d, adm) => {
  const base = { username: adm.username, password: adm.pw }
  const make = (padLen) => JSON.stringify({ ...base, pad: 'p'.repeat(padLen) })
  let padLen = Math.max(0, 8192 - utf8(make(0)).byteLength)
  while (utf8(make(padLen)).byteLength < 8192) padLen += 1
  while (utf8(make(padLen)).byteLength > 8192 && padLen > 0) padLen -= 1
  const payload = make(padLen)
  ok(utf8(payload).byteLength === 8192, '构造后应恰为 8192 字节，实际=' + utf8(payload).byteLength)
  const r = await req(d, 'POST', '/api/auth/login', { rawBody: payload })
  ok(r.status === 200, 'status=' + r.status)
  ok((r.headers.get('set-cookie') || '').includes('sf_session='), '应下发 Cookie')
})
await itest('N-42', '超限后立即取消且不再继续读取（无限流拉取次数有界）', async (d) => {
  let enqueued = 0
  const stream = new ReadableStream({
    pull(controller) {
      enqueued += 1
      controller.enqueue(utf8('q'.repeat(512)))
    },
  })
  const r = await req(d, 'POST', '/api/auth/login', { streamBody: stream })
  ok(r.status === 413, 'status=' + r.status)
  const at = enqueued
  await new Promise((res) => setTimeout(res, 60))
  ok(enqueued === at, '取消后不应继续 pull，at=' + at + ' now=' + enqueued)
  ok(at < 40, '读取块数应有界，实际=' + at)
})
await itest('N-43', '正常 JSON 请求（含 Content-Length）仍通过', async (d, adm) => {
  const r = await login(d, adm.username, adm.pw, { ip: '10.9.0.1' })
  ok(r.status === 200)
  ok((r.headers.get('set-cookie') || '').includes('HttpOnly'))
})
await itest('N-44', '空 body / 非法 JSON / 非对象 → 400（流式路径同样生效）', async (d) => {
  ok((await req(d, 'POST', '/api/auth/login', { rawBody: '' })).status === 400, 'empty')
  ok((await req(d, 'POST', '/api/auth/login', { rawBody: '{bad' })).status === 400, 'bad json')
  ok((await req(d, 'POST', '/api/auth/login', { rawBody: '[1,2,3]' })).status === 400, 'array')
  ok((await req(d, 'POST', '/api/auth/login', { rawBody: '"str"' })).status === 400, 'string')
})

// ── N-9 P2：Session 清理边界 ───────────────────────────────────────────────
await itest('N-45', 'Token 哈希阶段异常 → 无 Session 残留且 503', async (d, adm) => {
  const origDesc = Object.getOwnPropertyDescriptor(crypto.subtle, 'digest')
  const orig = crypto.subtle.digest.bind(crypto.subtle)
  let failNext = true
  try {
    Object.defineProperty(crypto.subtle, 'digest', {
      configurable: true,
      value: async (...args) => {
        if (failNext) { failNext = false; throw new Error('SIM_DIGEST_FAILURE') }
        return orig(...args)
      },
    })
    const r = await login(d, adm.username, adm.pw, { ip: '10.10.0.1' })
    ok(r.status === 503, 'status=' + r.status)
  } finally {
    if (origDesc) Object.defineProperty(crypto.subtle, 'digest', origDesc)
    else delete crypto.subtle.digest
  }
  ok(d.q('SELECT COUNT(*) c FROM sessions').at(0).c === 0, '不应创建 Session')
})
await itest('N-46', 'Session 创建后任意异常 → 撤销且 503（Cookie 未交付）', async (d, adm) => {
  d.failRule = (sql, phase) => phase === 'get' && /FROM sessions/.test(sql)
  const r = await login(d, adm.username, adm.pw, { ip: '10.10.0.2' })
  ok(r.status === 503, 'status=' + r.status)
  d.failRule = null
  ok(d.q('SELECT COUNT(*) c FROM sessions WHERE revoked_at IS NULL').at(0).c === 0, '不应留下可用 Session')
  ok(!(r.headers.get('set-cookie') || '').includes('sf_session='), '失败响应不应下发 Cookie')
})
await itest('N-47', '审计 / 限速回写失败不撤销已成功的登录 Session', async (d, adm) => {
  const orig = console.error
  console.error = () => {}
  try {
    d.failRule = (sql) => /INSERT INTO auth_audit/.test(sql) || /UPDATE login_attempts SET success/.test(sql)
    const r = await login(d, adm.username, adm.pw, { ip: '10.10.0.3' })
    ok(r.status === 200, 'status=' + r.status)
  } finally { console.error = orig; d.failRule = null }
  ok(d.q('SELECT COUNT(*) c FROM sessions WHERE revoked_at IS NULL').at(0).c === 1, 'Session 应仍然有效')
})
await atest('N-48', 'U', 'createSession 返回 tokenHash 且与 tokenHash(token) 一致', async () => {
  const d = new D1Local()
  await bootstrap(d, { id: 'N48', username: 'n48user', pw: 'Password12345' })
  const created = await session.createSession(d, 'N48', { ip: '1.2.3.4', userAgent: '' })
  ok(typeof created.token === 'string' && created.token.length === 43)
  ok(/^[0-9a-f]{64}$/.test(created.tokenHash))
  ok(created.tokenHash === await password.tokenHash(created.token))
  const row = d.q('SELECT token_hash FROM sessions WHERE user_id=?', 'N48')
  ok(row.length === 1 && row[0].token_hash === created.tokenHash, 'DB 仅存 hash')
})

// ── AUTH-8：GET /api/auth/users（管理员分页列表）────────────────────────────
await itest('G-1', '管理员 GET /users → 200 且不含敏感字段', async (d, adm) => {
  const ck = cookieOf(await login(d, adm.username, adm.pw))
  const r = await req(d, 'GET', '/api/auth/users', { cookie: ck })
  ok(r.status === 200, 'status=' + r.status)
  const body = await jres(r)
  ok(Array.isArray(body.users), 'users 应为数组')
  ok(body.users.length >= 1, '至少 1 个用户')
  const raw = JSON.stringify(body)
  ok(!/password_hash|passwordHash/i.test(raw), '不得返回 password_hash')
  ok(!/"salt"/i.test(raw), '不得返回 salt')
  ok(!/token_hash|tokenHash/i.test(raw), '不得返回 token')
  ok(body.users.every((u) => u.id && u.username && u.role), '字段完整')
})

await itest('G-2', '教师 GET /users → 403', async (d, adm) => {
  const admCk = cookieOf(await login(d, adm.username, adm.pw))
  await addUser(d, { id: 'G2T', username: 'g2teacher', pw: 'TeacherPass12345', mustChange: 0 })
  const tCk = cookieOf(await login(d, 'g2teacher', 'TeacherPass12345'))
  ok(tCk !== '', '教师应能登录', {})
  const r = await req(d, 'GET', '/api/auth/users', { cookie: tCk })
  ok(r.status === 403, 'status=' + r.status)
  ok((await jres(r)).error === 'FORBIDDEN')
})

await itest('G-3', '未认证 GET /users → 401', async (d) => {
  const r = await req(d, 'GET', '/api/auth/users')
  ok(r.status === 401, 'status=' + r.status)
})

await itest('G-4', '分页 limit/offset 生效且被限幅', async (d, adm) => {
  const ck = cookieOf(await login(d, adm.username, adm.pw))
  await addUser(d, { id: 'G4T', username: 'g4t1', pw: 'TeacherPass12345', mustChange: 0 })
  const r1 = await req(d, 'GET', '/api/auth/users?limit=1&offset=0', { cookie: ck })
  const b1 = await jres(r1)
  ok(r1.status === 200 && b1.users.length === 1 && b1.limit === 1, JSON.stringify({ n: b1.users?.length, limit: b1.limit }))
  const r2 = await req(d, 'GET', '/api/auth/users?limit=999', { cookie: ck })
  ok((await jres(r2)).limit === 100, 'limit 应被限幅为 100')
  const r3 = await req(d, 'GET', '/api/auth/users?limit=0', { cookie: ck })
  ok((await jres(r3)).limit === 1, 'limit 下限 1')
})

await itest('G-5', 'status/role 过滤生效', async (d, adm) => {
  const ck = cookieOf(await login(d, adm.username, adm.pw))
  await addUser(d, { id: 'G5T', username: 'g5t1', pw: 'TeacherPass12345', mustChange: 0 })
  const r = await req(d, 'GET', '/api/auth/users?role=admin', { cookie: ck })
  const b = await jres(r)
  ok(r.status === 200 && b.users.every((u) => u.role === 'admin'), JSON.stringify(b.users?.map((u) => u.role)))
  const r2 = await req(d, 'GET', '/api/auth/users?role=teacher', { cookie: ck })
  const b2 = await jres(r2)
  ok(r2.status === 200 && b2.users.every((u) => u.role === 'teacher') && b2.users.length >= 1)
})

// R / A 层：明确标注未执行（需真实 Workers / AUTH-3 联调）
for (const [id, name, reason] of [
  ['R-1', 'PBKDF2 平台 CPU（含改密 8 次叠加）', '需 AUTH-2a-R 真实 Workers，本轮未授权'],
  ['R-2', 'D1 真实并发限速原子性', '需真实 D1 并发，本轮未授权'],
  ['R-3', 'D1 meta.changes / last_row_id 语义', '需真实 D1，本轮未授权'],
  ['R-4', 'D1 db.batch() 事务语义', '需真实 D1，本轮未授权'],
  ['R-5', 'D1 读一致性', '需真实 D1，本轮未授权'],
  ['A-1', 'Cookie 经 Service Binding 透传', '需 AUTH-3 联调，本轮未授权'],
  ['A-2', 'CF-Connecting-IP 经 Functions→Worker 保留', '需 AUTH-3 联调，本轮未授权'],
  ['A-3', '全站静态资源请求触发量与成本模型', '需 AUTH-3 联调，本轮未授权'],
  ['A-4', '匿名例外与重定向循环 / 未登录 302', '需 AUTH-3 联调，本轮未授权'],
]) blockedCase(id, id.startsWith('R') ? 'R' : 'A', name, reason)

console.log('\n=== 汇总 ===')
console.log(JSON.stringify({
  passed, failed, blocked,
  total: passed + failed + blocked,
  sqlite_version: new DatabaseSync(':memory:').prepare('select sqlite_version() v').get().v,
  node: process.version,
  failures,
}, null, 2))
process.exit(failed ? 1 : 0)

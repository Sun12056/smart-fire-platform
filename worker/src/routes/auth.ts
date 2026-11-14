// AUTH-2b · 自建认证控制面 /api/auth/*（独立于 GATEWAY_MODE 与 /api/v1/*）。
// 冻结约束：deny_all 下 /api/v1/* 始终 403；自建 Session 不替代 auth_only 的 Access JWT。
// 事务边界：核心状态写 + Session 撤销在核心 db.batch() 内；auth_audit 在批次成功后独立写入（best-effort）。
// 审计最小化：detail 仅 {code} / {field} / {}；永不写入密码、临时密码、Token、Hash、Salt。
// 输入边界：请求体有明确上限；所有 KDF 路径先经密码输入校验；畸形 salt/hash fail-closed。

import { Hono } from 'hono'
import type { Env } from '../types'
import {
  AuthConfigError, AuthInputError, deriveHash, envIterations, dbIterations,
  generateSaltB64, validatePasswordInput, verifyHash, virtualVerify,
} from '../auth/password'
import {
  clearCookie, createSession, loadPrincipal, nowIso, readCookie,
  revokeSession, sessionCookie, type Principal,
} from '../auth/session'
import {
  acquireSlot, markAttempt, maybePrune, normalizeUsername,
  rateLimitKey, trustedIp,
} from '../auth/ratelimit'
import { AuthError, requireAdmin, requirePasswordChanged, requireSession } from '../auth/guard'

export const authRoute = new Hono<{ Bindings: Env }>()

/** 认证 JSON 请求体上限（Content-Length 与实读字节双重校验）。 */
export const MAX_AUTH_BODY_BYTES = 8 * 1024

// ── 错误映射 ────────────────────────────────────────────────────────────────
function err(status: number, code: string, headers?: Record<string, string>) {
  return new Response(JSON.stringify({ error: code }), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...(headers ?? {}) },
  })
}

/**
 * 每个处理器显式包装错误映射。
 * 原因：app.route() 将子应用 handler 展开注册到主 app 后，子应用中间件 / onError
 * 不再可靠捕获 handler 抛出的异常；显式 wrap 保证 fail-closed 语义稳定。
 */
function wrap(fn: (c: any) => Promise<Response>) {
  return async (c: any): Promise<Response> => {
    try {
      return await fn(c)
    } catch (e) {
      if (e instanceof AuthError) return err(e.status, e.code)
      if (e instanceof AuthInputError) return err(400, 'INVALID_INPUT')
      if (e instanceof AuthConfigError) return err(503, 'AUTH_CONFIG_INVALID')
      // 认证/D1 异常一律 fail-closed，不放行
      return err(503, 'AUTH_UNAVAILABLE')
    }
  }
}

authRoute.use('*', async (c, next) => {
  await next()
  c.header('Cache-Control', 'no-store')
})

function mapWriteError(e: unknown): AuthError {
  const msg = e instanceof Error ? e.message : String(e)
  if (/LAST_ADMIN_PROTECTED|USER_CONFLICT_ON_UPDATE|LAST_ADMIN_REPLACE_PROTECTED/.test(msg)) {
    return new AuthError(409, 'LAST_ADMIN_PROTECTED')
  }
  if (/BOOTSTRAP/.test(msg)) return new AuthError(409, 'CONFLICT')
  if (/UNIQUE/.test(msg)) return new AuthError(409, 'CONFLICT')
  return new AuthError(503, 'AUTH_WRITE_FAILED')
}

// ── 审计：独立于核心事务，失败 best-effort ──────────────────────────────────
interface AuditRow {
  event: string
  username?: string | null
  actor?: string | null
  ip?: string | null
  detail?: Record<string, string>
}

/** detail 白名单：只允许 code / field 两个键。 */
function safeDetail(d?: Record<string, string>): string {
  const out: Record<string, string> = {}
  if (d?.code) out.code = d.code
  if (d?.field) out.field = d.field
  return JSON.stringify(out)
}

async function writeAudit(c: { env: Env }, row: AuditRow): Promise<void> {
  try {
    await c.env.DB.prepare(
      `INSERT INTO auth_audit (event, username, actor, ip, user_agent, detail, created_at)
       VALUES (?, ?, ?, ?, NULL, ?, ?)`,
    ).bind(
      row.event, row.username ?? null, row.actor ?? null, row.ip ?? null,
      safeDetail(row.detail), nowIso(),
    ).run()
  } catch {
    // 独立、明确的错误记录机制：仅事件/主体/错误码/时间，无任何敏感内容
    console.error('[auth-audit-write-failed]', JSON.stringify({
      event: row.event, actorId: row.actor ?? null, code: 'AUDIT_WRITE_FAILED', ts: nowIso(),
    }))
  }
}

async function coreBatch(db: D1Database, statements: D1PreparedStatement[]): Promise<void> {
  try {
    await db.batch(statements)
  } catch (e) {
    throw mapWriteError(e)
  }
}

// ── 公共校验 ────────────────────────────────────────────────────────────────
function clientIp(c: { req: { raw: Request } }): string {
  return trustedIp(c.req.raw.headers)
}

/**
 * CSRF：完整 origin 比较 + 双缺失 fail-closed。
 *  · Origin 与 Sec-Fetch-Site 同时缺失 → 拒绝（不得默认信任非浏览器客户端）；
 *  · Sec-Fetch-Site 仅允许 same-origin；cross-site / same-site / none 一律拒绝；
 *  · Origin 存在时按 URL.origin 全量比较（协议 + 主机 + 端口），非法格式拒绝。
 */
function assertSameOrigin(c: { req: { url: string; header(name: string): string | undefined } }): void {
  const site = c.req.header('sec-fetch-site')
  const origin = c.req.header('origin')

  if (!site && !origin) throw new AuthError(403, 'CSRF_REJECTED')
  if (site !== undefined && site !== 'same-origin') throw new AuthError(403, 'CSRF_REJECTED')

  if (origin !== undefined) {
    let originUrl: URL
    try {
      originUrl = new URL(origin)
    } catch {
      throw new AuthError(403, 'CSRF_REJECTED')
    }
    if (originUrl.origin !== new URL(c.req.url).origin) throw new AuthError(403, 'CSRF_REJECTED')
  } else if (site !== 'same-origin') {
    // 无 Origin 且 Sec-Fetch-Site 非 same-origin（含缺失）→ 拒绝
    throw new AuthError(403, 'CSRF_REJECTED')
  }
}

/**
 * 流式读取请求体，边读边累计字节，超限立即取消 reader 并 413。
 * 绝不在超限后继续缓存剩余字节，也不做截断/忽略。
 */
async function readBodyWithLimit(req: Request): Promise<string> {
  const body = req.body
  if (!body) return ''

  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value || value.byteLength === 0) continue

      total += value.byteLength
      if (total > MAX_AUTH_BODY_BYTES) {
        // 立即取消，停止拉取剩余请求体；cancel 失败不影响 413 语义
        try { await reader.cancel() } catch { /* ignore */ }
        throw new AuthError(413, 'PAYLOAD_TOO_LARGE')
      }
      chunks.push(value)
    }
  } catch (e) {
    if (e instanceof AuthError) throw e
    try { await reader.cancel() } catch { /* ignore */ }
    throw new AuthError(400, 'INVALID_INPUT')
  }

  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }

  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(merged)
  } catch {
    throw new AuthError(400, 'INVALID_INPUT')
  }
  // 去除 UTF-8 BOM（仅影响 JSON 头部，不触碰字段值）
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  return text
}

/**
 * 读取并限制 JSON 请求体：
 *  · Content-Length 超限 → 413（提前拒绝）；
 *  · 流式累计字节超限 → 立即 cancel reader 并 413；
 *  · 空 body / 非法 UTF-8 / 非法 JSON / 非对象 → 400。
 */
async function jsonBody(c: { req: { header(name: string): string | undefined; raw: Request } }): Promise<Record<string, unknown>> {
  const declared = c.req.header('content-length')
  if (declared !== undefined) {
    const n = Number(declared)
    if (!Number.isSafeInteger(n) || n < 0 || n > MAX_AUTH_BODY_BYTES) {
      throw new AuthError(413, 'PAYLOAD_TOO_LARGE')
    }
  }

  const raw = await readBodyWithLimit(c.req.raw)
  if (raw.length === 0) throw new AuthError(400, 'INVALID_INPUT')

  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new AuthError(400, 'INVALID_INPUT')
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new AuthError(400, 'INVALID_INPUT')
  }
  return value as Record<string, unknown>
}

function publicUser(p: Principal) {
  return {
    id: p.userId, username: p.username, displayName: p.displayName,
    role: p.role, mustChangePassword: p.mustChangePassword,
  }
}

// ── ① POST /api/auth/login ──────────────────────────────────────────────────
authRoute.post('/login', wrap(async (c) => {
  // Login CSRF：登录接口同样执行同源校验（防止被强制登入攻击者账号）
  assertSameOrigin(c)
  // 配置越界：不执行任何 KDF
  const iterations = envIterations(c.env)
  const body = await jsonBody(c)
  const rawUsername = body.username
  const passwordValue = body.password
  const now = nowIso()
  const ip = clientIp(c)

  // 所有登录请求（含空/超长/控制字符用户名）先占用限速槽位，杜绝绕过 KDF 限速
  const key = rateLimitKey(rawUsername)
  const slot = await acquireSlot(c.env.DB, key, ip, now)
  if (!slot.allowed) {
    return err(429, 'RATE_LIMITED', { 'Retry-After': String(slot.retryAfter) })
  }

  const username = normalizeUsername(rawUsername)
  const passwordCode = validatePasswordInput(passwordValue)

  // 无效用户名：仍消耗一次虚拟 KDF（仅当密码合法），统一 401
  if (!username) {
    if (passwordCode === null) await virtualVerify(passwordValue, iterations)
    await markAttempt(c.env.DB, slot.attemptId!, false, 'bad_username')
    await writeAudit(c, { event: 'login_fail', username: null, ip, detail: { code: 'bad_username' } })
    await maybePrune(c.env.DB, slot.attemptId, now)
    return err(401, 'INVALID_CREDENTIALS')
  }

  // 密码越界：不进入 KDF，直接统一 401（不泄露账号是否存在）
  if (passwordCode !== null) {
    await markAttempt(c.env.DB, slot.attemptId!, false, 'bad_cred')
    await writeAudit(c, { event: 'login_fail', username, ip, detail: { code: 'bad_cred' } })
    await maybePrune(c.env.DB, slot.attemptId, now)
    return err(401, 'INVALID_CREDENTIALS')
  }

  const row = await c.env.DB.prepare(
    `SELECT id, username, display_name, password_hash, salt, iterations, role, status,
            must_change_password
       FROM users WHERE username = ?`,
  ).bind(username).first<Record<string, unknown>>()

  if (!row || row.status !== 'active') {
    await virtualVerify(passwordValue, iterations)
    await markAttempt(c.env.DB, slot.attemptId!, false, 'bad_cred')
    await writeAudit(c, { event: 'login_fail', username, ip, detail: { code: 'bad_cred' } })
    await maybePrune(c.env.DB, slot.attemptId, now)
    return err(401, 'INVALID_CREDENTIALS')
  }

  const match = await verifyHash(
    passwordValue as string, String(row.password_hash), String(row.salt), row.iterations,
  )
  if (!match) {
    await markAttempt(c.env.DB, slot.attemptId!, false, 'bad_cred')
    await writeAudit(c, { event: 'login_fail', username, ip, detail: { code: 'bad_cred' } })
    await maybePrune(c.env.DB, slot.attemptId, now)
    return err(401, 'INVALID_CREDENTIALS')
  }

  // 核心状态：Session 创建。createSession 内部已先算好 tokenHash，
  // 因此「创建成功」与「具备撤销凭据」是同一时刻，不存在无法清理的窗口。
  // 从这一步起，任何异常都必须撤销该 Session（Cookie 尚未交付）。
  let session: { token: string; tokenHash: string } | null = null
  try {
    session = await createSession(c.env.DB, String(row.id), { ip, userAgent: '' }, now)

    // best-effort：计数回写 / 登录时间 / 有界清理 / 审计（均不得回滚核心状态）
    await markAttempt(c.env.DB, slot.attemptId!, true, 'ok').catch(() => {})
    await c.env.DB.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').bind(now, row.id).run()
    await maybePrune(c.env.DB, slot.attemptId, now)
    await writeAudit(c, { event: 'login_ok', username, actor: String(row.id), ip })

    const p = await loadPrincipal(c.env.DB, session.token, now)
    if (!p) {
      // 未交付 Cookie 前判定失败：撤销刚创建的 Session，绝不留下可用凭据
      await revokeSession(c.env.DB, session.tokenHash).catch(() => {})
      return err(503, 'AUTH_UNAVAILABLE')
    }
    return new Response(JSON.stringify({ user: publicUser(p) }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json', 'Cache-Control': 'no-store',
        'Set-Cookie': sessionCookie(session.token),
      },
    })
  } catch (e) {
    // 核心路径异常：撤销已创建的 Session（fail-closed），再交给 wrap 统一 503
    if (session) await revokeSession(c.env.DB, session.tokenHash).catch(() => {})
    throw e
  }
}))

// ── ② POST /api/auth/logout（幂等，始终清 Cookie）──────────────────────────
authRoute.post('/logout', wrap(async (c) => {
  assertSameOrigin(c)
  const token = readCookie(c.req.header('cookie'))
  let principal: Principal | null = null
  try {
    principal = token ? await loadPrincipal(c.env.DB, token) : null
  } catch {
    return err(503, 'AUTH_UNAVAILABLE', { 'Set-Cookie': clearCookie() })
  }
  if (principal) {
    try {
      await revokeSession(c.env.DB, principal.tokenHash)
    } catch {
      return err(503, 'AUTH_UNAVAILABLE', { 'Set-Cookie': clearCookie() })
    }
  }
  await writeAudit(c, { event: 'logout', username: principal?.username ?? null, actor: principal?.userId ?? null })
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Set-Cookie': clearCookie() },
  })
}))

// ── ③ GET /api/auth/session ─────────────────────────────────────────────────
authRoute.get('/session', wrap(async (c) => {
  const p = await requireSession(c)
  requirePasswordChanged(c, p) // session 在白名单内，必须允许恢复并返回 mustChangePassword
  return c.json({ user: publicUser(p), expiresAt: p.expiresAt, mustChangePassword: p.mustChangePassword })
}))

// ── ④ POST /api/auth/change-password ───────────────────────────────────────
authRoute.post('/change-password', wrap(async (c) => {
  const p = await requireSession(c)
  requirePasswordChanged(c, p)
  assertSameOrigin(c)
  const iterations = envIterations(c.env)
  const body = await jsonBody(c)

  const current = body.currentPassword
  const next = body.newPassword
  if (validatePasswordInput(current) || validatePasswordInput(next)) return err(400, 'INVALID_INPUT')
  if (current === next) return err(409, 'PASSWORD_REUSED')

  const row = await c.env.DB.prepare(
    'SELECT password_hash, salt, iterations FROM users WHERE id = ?',
  ).bind(p.userId).first<Record<string, unknown>>()
  if (!row) return err(401, 'UNAUTHENTICATED')

  // 当前密码：使用用户记录自身的 iterations（越界 fail-closed，不执行 KDF）
  if (!await verifyHash(current as string, String(row.password_hash), String(row.salt), row.iterations)) {
    return err(401, 'INVALID_CREDENTIALS')
  }
  // 历史检查：新密码不得与当前或最近 5 条历史重复（逐条用各自 iterations）
  if (await verifyHash(next as string, String(row.password_hash), String(row.salt), row.iterations)) {
    return err(409, 'PASSWORD_REUSED')
  }
  const history = await c.env.DB.prepare(
    'SELECT password_hash, salt, iterations FROM password_history WHERE user_id = ? ORDER BY id DESC LIMIT 5',
  ).bind(p.userId).all<Record<string, unknown>>()
  for (const h of history.results ?? []) {
    if (await verifyHash(next as string, String(h.password_hash), String(h.salt), h.iterations)) {
      return err(409, 'PASSWORD_REUSED')
    }
  }

  const salt = generateSaltB64()
  const hash = await deriveHash(next as string, salt, iterations)
  const now = nowIso()
  await coreBatch(c.env.DB, [
    c.env.DB.prepare(
      'INSERT INTO password_history (user_id, password_hash, salt, iterations, created_at) VALUES (?, ?, ?, ?, ?)',
    ).bind(p.userId, row.password_hash, row.salt, dbIterations(row.iterations), now),
    c.env.DB.prepare(
      `UPDATE users SET password_hash = ?, salt = ?, iterations = ?,
              must_change_password = 0, password_updated_at = ?, updated_at = ? WHERE id = ?`,
    ).bind(hash, salt, iterations, now, now, p.userId),
    c.env.DB.prepare(
      `DELETE FROM password_history WHERE user_id = ? AND id NOT IN
        (SELECT id FROM password_history WHERE user_id = ? ORDER BY id DESC LIMIT 5)`,
    ).bind(p.userId, p.userId),
    c.env.DB.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL')
      .bind(now, p.userId),
  ])
  await writeAudit(c, { event: 'password_change', username: p.username, actor: p.userId })
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Set-Cookie': clearCookie() },
  })
}))

// ── ⑤a GET /api/auth/users（管理员：用户列表，分页，不含敏感字段）──────────
authRoute.get('/users', wrap(async (c) => {
  const p = await requireSession(c)
  requirePasswordChanged(c, p)
  requireAdmin(p)

  const rawLimit = Number(c.req.query('limit') ?? 50)
  const rawOffset = Number(c.req.query('offset') ?? 0)
  const limit = Number.isSafeInteger(rawLimit) ? Math.min(Math.max(rawLimit, 1), 100) : 50
  const offset = Number.isSafeInteger(rawOffset) ? Math.max(rawOffset, 0) : 0

  const status = c.req.query('status')
  const role = c.req.query('role')
  const where: string[] = []
  const binds: unknown[] = []
  if (status === 'active' || status === 'disabled') { where.push('status = ?'); binds.push(status) }
  if (role === 'admin' || role === 'teacher') { where.push('role = ?'); binds.push(role) }
  const whereSql = where.length ? ` WHERE ${where.join(' AND ')}` : ''

  const totalRow = await c.env.DB.prepare(`SELECT COUNT(*) AS c FROM users${whereSql}`)
    .bind(...binds).first<Record<string, unknown>>()

  // 明确列清单：绝不返回 password_hash / salt / iterations / session 相关字段
  const rows = await c.env.DB.prepare(
    `SELECT id, username, display_name, role, status, must_change_password,
            created_by, created_at, updated_at, last_login_at
       FROM users${whereSql}
      ORDER BY created_at ASC, username ASC
      LIMIT ? OFFSET ?`,
  ).bind(...binds, limit, offset).all<Record<string, unknown>>()

  return c.json({
    total: Number(totalRow?.c ?? 0),
    limit,
    offset,
    users: (rows.results ?? []).map((r) => ({
      id: String(r.id),
      username: String(r.username),
      displayName: r.display_name === null || r.display_name === undefined ? null : String(r.display_name),
      role: String(r.role),
      status: String(r.status),
      mustChangePassword: Number(r.must_change_password) === 1,
      createdBy: r.created_by === null || r.created_by === undefined ? null : String(r.created_by),
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
      lastLoginAt: r.last_login_at === null || r.last_login_at === undefined ? null : String(r.last_login_at),
    })),
  })
}))

// ── ⑤ POST /api/auth/users（管理员创建用户）────────────────────────────────
authRoute.post('/users', wrap(async (c) => {
  const p = await requireSession(c)
  requirePasswordChanged(c, p)
  requireAdmin(p)
  assertSameOrigin(c)
  const iterations = envIterations(c.env)
  const body = await jsonBody(c)

  const username = normalizeUsername(body.username)
  const temp = body.tempPassword
  const role = body.role
  if (!username || validatePasswordInput(temp)) return err(400, 'INVALID_INPUT')
  if (role !== 'admin' && role !== 'teacher') return err(400, 'INVALID_INPUT')
  const displayName = typeof body.displayName === 'string' ? body.displayName.slice(0, 64) : null

  const salt = generateSaltB64()
  const hash = await deriveHash(temp as string, salt, iterations)
  const now = nowIso()
  const id = `USR-${crypto.randomUUID()}`
  try {
    await c.env.DB.prepare(
      `INSERT INTO users (id, username, display_name, password_hash, salt, iterations, role,
                          status, must_change_password, created_by, password_updated_at,
                          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 1, ?, ?, ?, ?)`,
    ).bind(id, username, displayName, hash, salt, iterations, role, p.userId, now, now, now).run()
  } catch (e) {
    throw mapWriteError(e)
  }
  await writeAudit(c, {
    event: 'user_created', username, actor: p.userId, ip: clientIp(c), detail: { field: 'role' },
  })
  return c.json({
    user: { id, username, displayName, role, mustChangePassword: 1 },
  }, 201)
}))

// ── ⑥ PATCH /api/auth/users/:id ────────────────────────────────────────────
authRoute.patch('/users/:id', wrap(async (c) => {
  const p = await requireSession(c)
  requirePasswordChanged(c, p)
  requireAdmin(p)
  assertSameOrigin(c)
  const body = await jsonBody(c)
  const targetId = c.req.param('id')
  const status = body.status
  const role = body.role
  if (status !== undefined && status !== 'active' && status !== 'disabled') return err(400, 'INVALID_INPUT')
  if (role !== undefined && role !== 'admin' && role !== 'teacher') return err(400, 'INVALID_INPUT')
  if (status === undefined && role === undefined) return err(400, 'INVALID_INPUT')

  const target = await c.env.DB.prepare('SELECT id, role, status FROM users WHERE id = ?')
    .bind(targetId).first<Record<string, unknown>>()
  if (!target) return err(404, 'NOT_FOUND')

  // 禁止管理员禁用或降级自己
  if (targetId === p.userId && (status === 'disabled' || (role && role !== 'admin'))) {
    return err(409, 'SELF_MODIFY_FORBIDDEN')
  }

  const now = nowIso()
  const stmts: D1PreparedStatement[] = []
  if (status !== undefined && status !== target.status) {
    stmts.push(c.env.DB.prepare('UPDATE users SET status = ?, updated_at = ? WHERE id = ?')
      .bind(status, now, targetId))
  }
  if (role !== undefined && role !== target.role) {
    stmts.push(c.env.DB.prepare('UPDATE users SET role = ?, updated_at = ? WHERE id = ?')
      .bind(role, now, targetId))
  }
  if (stmts.length) {
    // Session 撤销与核心状态写同批（T3/T5 触发器亦自动撤销，幂等双保险）
    stmts.push(c.env.DB.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL')
      .bind(now, targetId))
    await coreBatch(c.env.DB, stmts)
    const ev = status === 'disabled' ? 'user_disabled'
      : status === 'active' ? 'user_enabled' : 'role_changed'
    await writeAudit(c, {
      event: ev, username: String(target.id), actor: p.userId, ip: clientIp(c),
      detail: { field: status !== undefined ? 'status' : 'role' },
    })
  }
  return c.json({ ok: true })
}))

// ── ⑦ POST /api/auth/users/:id/reset-password ──────────────────────────────
authRoute.post('/users/:id/reset-password', wrap(async (c) => {
  const p = await requireSession(c)
  requirePasswordChanged(c, p)
  requireAdmin(p)
  assertSameOrigin(c)
  const iterations = envIterations(c.env)
  const body = await jsonBody(c)
  const temp = body.tempPassword
  if (validatePasswordInput(temp)) return err(400, 'INVALID_INPUT')

  const targetId = c.req.param('id')
  const target = await c.env.DB.prepare(
    'SELECT id, username, password_hash, salt, iterations FROM users WHERE id = ?',
  ).bind(targetId).first<Record<string, unknown>>()
  if (!target) return err(404, 'NOT_FOUND')

  const salt = generateSaltB64()
  const hash = await deriveHash(temp as string, salt, iterations)
  const now = nowIso()
  await coreBatch(c.env.DB, [
    c.env.DB.prepare(
      'INSERT INTO password_history (user_id, password_hash, salt, iterations, created_at) VALUES (?, ?, ?, ?, ?)',
    ).bind(targetId, target.password_hash, target.salt, dbIterations(target.iterations), now),
    c.env.DB.prepare(
      `UPDATE users SET password_hash = ?, salt = ?, iterations = ?,
              must_change_password = 1, password_updated_at = ?, updated_at = ? WHERE id = ?`,
    ).bind(hash, salt, iterations, now, now, targetId),
    c.env.DB.prepare(
      `DELETE FROM password_history WHERE user_id = ? AND id NOT IN
        (SELECT id FROM password_history WHERE user_id = ? ORDER BY id DESC LIMIT 5)`,
    ).bind(targetId, targetId),
    c.env.DB.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL')
      .bind(now, targetId),
  ])
  // 临时密码不进入响应、审计与日志
  await writeAudit(c, {
    event: 'password_reset', username: String(target.username), actor: p.userId, ip: clientIp(c),
  })
  return c.json({ ok: true })
}))

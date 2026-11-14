// AUTH-2b · Session 创建/校验/撤销。
// 冻结约束：绝对过期 8h（不滑动延长）+ 空闲 30min（节流 60s，接受 <=60s 宽限）。
// D1/查询异常一律 fail-closed（由 guard 映射 503），不放行。

import { isValidToken, tokenHash, generateToken } from './password'

export const COOKIE_NAME = 'sf_session'
export const SESSION_TTL_HOURS = 8
export const IDLE_TIMEOUT_MS = 30 * 60 * 1000
export const TOUCH_THROTTLE_MS = 60 * 1000

export interface Principal {
  userId: string
  username: string
  displayName: string | null
  role: 'admin' | 'teacher'
  mustChangePassword: boolean
  expiresAt: string
  tokenHash: string
  lastSeenAt: string
}

export interface SessionMeta {
  ip: string
  userAgent: string
}

export function nowIso(): string {
  return new Date().toISOString()
}

export function isoAfter(ms: number, from = Date.now()): string {
  return new Date(from + ms).toISOString()
}

export function sessionCookie(token: string, maxAgeSeconds = SESSION_TTL_HOURS * 3600): string {
  return `${COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}`
}

export function clearCookie(): string {
  return `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`
}

export function readCookie(header: string | null | undefined, name = COOKIE_NAME): string | null {
  if (!header) return null
  for (const part of header.split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim()
  }
  return null
}

export interface CreatedSession {
  /** 明文 token，仅在 Set-Cookie 中交付一次 */
  token: string
  /** 与 token 对应的 sha256 摘要，用于失败时撤销 */
  tokenHash: string
}

/** 创建 Session：仅存 sha256(token)，明文只在 Set-Cookie 返回一次。 */
export async function createSession(
  db: D1Database, userId: string, meta: SessionMeta, now = nowIso(),
): Promise<CreatedSession> {
  const token = generateToken()
  const hash = await tokenHash(token)
  const expiresAt = isoAfter(SESSION_TTL_HOURS * 3600 * 1000, Date.parse(now))
  await db.prepare(
    `INSERT INTO sessions (token_hash, user_id, created_at, expires_at, revoked_at, last_seen_at, ip, user_agent)
     VALUES (?, ?, ?, ?, NULL, ?, ?, ?)`,
  ).bind(hash, userId, now, expiresAt, now, meta.ip, meta.userAgent).run()
  // hash 在 INSERT 之前已算出：调用方即使后续失败也始终具备撤销凭据
  return { token, tokenHash: hash }
}

/**
 * 单次 D1 查询完成全部 9 项检查（Cookie 合法性由调用方先做）。
 * 任一条件不满足返回 null；D1 异常向上抛出（fail-closed）。
 * 节流写 last_seen_at：仅当距上次更新 >= 60s 才写。
 */
export async function loadPrincipal(
  db: D1Database, token: string, now = nowIso(),
): Promise<Principal | null> {
  if (!isValidToken(token)) return null
  const hash = await tokenHash(token)
  const row = await db.prepare(
    `SELECT s.token_hash, s.expires_at, s.revoked_at, s.last_seen_at,
            u.id AS user_id, u.username, u.display_name, u.role, u.status,
            u.must_change_password
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?`,
  ).bind(hash).first<Record<string, unknown>>()
  if (!row) return null
  if (row.revoked_at !== null && row.revoked_at !== undefined) return null

  const nowMs = Date.parse(now)
  const expiresMs = Date.parse(String(row.expires_at))
  if (!Number.isFinite(expiresMs) || nowMs >= expiresMs) return null

  const lastSeenMs = Date.parse(String(row.last_seen_at))
  if (!Number.isFinite(lastSeenMs)) return null
  // 空闲超时 + 节流宽限
  if (nowMs - lastSeenMs > IDLE_TIMEOUT_MS + TOUCH_THROTTLE_MS) return null

  if (row.status !== 'active') return null
  if (row.role !== 'admin' && row.role !== 'teacher') return null

  if (nowMs - lastSeenMs >= TOUCH_THROTTLE_MS) {
    await db.prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ? AND last_seen_at < ?')
      .bind(now, hash, isoAfter(-TOUCH_THROTTLE_MS, nowMs)).run()
  }

  return {
    userId: String(row.user_id),
    username: String(row.username),
    displayName: row.display_name === null || row.display_name === undefined ? null : String(row.display_name),
    role: row.role as 'admin' | 'teacher',
    mustChangePassword: Number(row.must_change_password) === 1,
    expiresAt: String(row.expires_at),
    tokenHash: hash,
    lastSeenAt: String(row.last_seen_at),
  }
}

/** 登出：撤销当前 session。D1 异常向上抛（调用方仍须清 Cookie）。 */
export async function revokeSession(db: D1Database, hash: string, now = nowIso()): Promise<void> {
  await db.prepare('UPDATE sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL')
    .bind(now, hash).run()
}

/** 撤销用户全部 session（与冻结触发器 T3/T4/T5 幂等双保险）。 */
export async function revokeAllForUser(db: D1Database, userId: string, now = nowIso()): Promise<void> {
  await db.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL')
    .bind(now, userId).run()
}

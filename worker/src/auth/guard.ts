// AUTH-2b · 认证守卫：requireSession / requirePasswordChanged / requireAdmin。
// 调用关系：requireSession（1 次 D1 查询完成 9 项检查）→ 白名单 → requireAdmin → handler。
// D1/查询异常一律 fail-closed（503），不 next() 放行。

import type { Context } from 'hono'
import { loadPrincipal, readCookie, type Principal } from './session'

export class AuthError extends Error {
  constructor(public status: number, public code: string) {
    super(code)
    this.name = 'AuthError'
  }
}

/** 强制改密状态下允许的三个路径（method + path）。 */
const MUST_CHANGE_ALLOW = new Set([
  'GET /api/auth/session',
  'POST /api/auth/change-password',
  'POST /api/auth/logout',
])

/**
 * 每次受保护请求调用。基于 D1 当前用户记录，不信任 Cookie/前端字段/缓存。
 * 失败抛 AuthError(401)；D1 异常抛 AuthError(503)。
 */
export async function requireSession(c: Context): Promise<Principal> {
  const token = readCookie(c.req.header('cookie'))
  if (!token) throw new AuthError(401, 'UNAUTHENTICATED')
  try {
    const p = await loadPrincipal(c.env.DB, token)
    if (!p) throw new AuthError(401, 'UNAUTHENTICATED')
    return p
  } catch (e) {
    if (e instanceof AuthError) throw e
    throw new AuthError(503, 'AUTH_UNAVAILABLE')
  }
}

/** must_change_password=1 时仅放行 session / change-password / logout。 */
export function requirePasswordChanged(c: Context, p: Principal): void {
  if (!p.mustChangePassword) return
  const key = `${c.req.method} ${c.req.path}`
  if (!MUST_CHANGE_ALLOW.has(key)) throw new AuthError(403, 'PASSWORD_CHANGE_REQUIRED')
}

/** 基于本次 D1 查出的当前 users.role，不信任任何前端字段。 */
export function requireAdmin(p: Principal): void {
  if (p.role !== 'admin') throw new AuthError(403, 'FORBIDDEN')
}

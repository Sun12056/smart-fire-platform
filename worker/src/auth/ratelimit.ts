// AUTH-2b · 登录限速（原子单语句条件插入）。
// 统计口径：窗口内「所有尝试」（含成功/pending/失败）；success 仅供审计，不参与阈值计数。
// 冻结策略：账号 5 次/5min；正常 IP 20 次/5min；unknown 共用桶 5 次/5min。
// 占位符：全部使用位置参数 ?，由 D1 .bind() 稳定绑定；不使用命名参数。
// 可信 IP：仅 CF-Connecting-IP；绝不采信 X-Forwarded-For / X-Real-IP。
// 覆盖范围：无效用户名（空/超长/控制字符）同样占用限速槽位，杜绝绕过 KDF 限速。

export const ACCOUNT_LIMIT = 5
export const IP_NORMAL_LIMIT = 20
export const IP_UNKNOWN_LIMIT = 5
export const WINDOW_MS = 5 * 60 * 1000
export const RETENTION_MS = 24 * 60 * 60 * 1000
export const UNKNOWN_IP = 'unknown'

/** 无效用户名使用的账号维度占位键（与真实用户名不可能冲突）。 */
export const INVALID_USERNAME_KEY = '\u0000invalid-username'

/** 每 N 次尝试触发一次有界清理（确定性、无需额外状态）。 */
export const PRUNE_EVERY_ATTEMPTS = 32

export function normalizeUsername(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const v = raw.trim() // 只 trim，不折叠大小写
  if (v.length === 0 || v.length > 32) return null
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F]/.test(v)) return null
  return v
}

/**
 * 限速账号键：合法用户名用规范化值；非法（空/超长/含控制字符/非字符串）
 * 统一归入 INVALID_USERNAME_KEY。保证所有登录请求都占用账号维度额度。
 */
export function rateLimitKey(raw: unknown): string {
  return normalizeUsername(raw) ?? INVALID_USERNAME_KEY
}

/** 可信 IP：只取 CF-Connecting-IP；缺失/非法一律归入 unknown 共享桶。 */
export function trustedIp(headers: Headers): string {
  const raw = headers.get('CF-Connecting-IP')
  if (!raw) return UNKNOWN_IP
  const v = raw.trim()
  if (v.length === 0 || v.length > 64) return UNKNOWN_IP
  // IPv4 或 IPv6 字面量；不接受逗号列表、不接受任何转发头
  const ipv4 = /^(\d{1,3}\.){3}\d{1,3}$/.test(v)
  const ipv6 = /^[0-9A-Fa-f:]{2,45}$/.test(v) && v.includes(':')
  return ipv4 || ipv6 ? v : UNKNOWN_IP
}

export function ipLimit(ip: string): number {
  return ip === UNKNOWN_IP ? IP_UNKNOWN_LIMIT : IP_NORMAL_LIMIT
}

export interface SlotResult {
  allowed: boolean
  attemptId: number | null
  retryAfter: number
}

/**
 * 原子申请槽位：单条 INSERT ... SELECT ... WHERE 同时完成双维度计数判定与占槽。
 * 不退回「先查后插」。所有参数均为位置参数 ?，顺序与 .bind() 一致。
 */
export async function acquireSlot(
  db: D1Database, username: string, ip: string, now: string,
): Promise<SlotResult> {
  const cutoff = new Date(Date.parse(now) - WINDOW_MS).toISOString()
  const limit = ipLimit(ip)
  const res = await db.prepare(
    `INSERT INTO login_attempts (username, ip, attempted_at, success, reason)
     SELECT ?, ?, ?, 0, 'pending'
     WHERE (SELECT COUNT(*) FROM login_attempts WHERE username = ? AND attempted_at >= ?) < ?
       AND (SELECT COUNT(*) FROM login_attempts WHERE ip = ? AND attempted_at >= ?) < ?`,
  ).bind(
    username, ip, now,                    // 1-3  INSERT 值
    username, cutoff, ACCOUNT_LIMIT,     // 4-6  账号维度
    ip, cutoff, limit,                   // 7-9  IP 维度（limit 由 .bind() 传入）
  ).run()
  const changes = Number(res.meta?.changes ?? 0)
  const allowed = changes === 1
  return {
    allowed,
    attemptId: allowed ? Number(res.meta?.last_row_id ?? 0) : null,
    retryAfter: Math.max(1, Math.ceil(WINDOW_MS / 1000)),
  }
}

/** 回写尝试结果（success 仅供审计，不改变统计口径）。last_row_id 语义在真实 D1 为 [NV]。 */
export async function markAttempt(
  db: D1Database, attemptId: number, success: boolean, reason: string,
): Promise<void> {
  if (!attemptId) return
  await db.prepare('UPDATE login_attempts SET success = ?, reason = ? WHERE id = ?')
    .bind(success ? 1 : 0, reason, attemptId).run()
}

/** 有界清理：只删除 24h 之前的记录；限速计数窗口（5min）不受影响。 */
export async function pruneAttempts(db: D1Database, now: string): Promise<void> {
  const cutoff = new Date(Date.parse(now) - RETENTION_MS).toISOString()
  await db.prepare('DELETE FROM login_attempts WHERE attempted_at < ?').bind(cutoff).run()
}

/**
 * 失败路径也能触发的有界清理。
 * 触发条件：本次占槽成功且 attemptId 为 PRUNE_EVERY_ATTEMPTS 的整数倍。
 * 语义：确定性节流（每 32 次尝试至多 1 次 DELETE），不随每次失败增加写放大。
 * 失败处理：异常被吞掉，绝不影响已作出的认证判定，也绝不因此放行。
 */
export async function maybePrune(
  db: D1Database, attemptId: number | null, now: string,
): Promise<void> {
  if (!attemptId || attemptId % PRUNE_EVERY_ATTEMPTS !== 0) return
  try {
    await pruneAttempts(db, now)
  } catch {
    // 清理失败不影响认证结果（已在认证判定之后调用）
  }
}

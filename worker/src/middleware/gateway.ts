// 网关守卫（P1d 阶段：仅 deny_all 生效；auth_only / enforce 降级为 deny_all）
// 边界：
//   · OPTIONS 任意路径放行（CORS 预检）；
//   · /healthz 仅 GET 放行；
//   · /api/v1 及其子路径（按路径段边界）统一返回 403；
//   · 其他路径交给后续处理（保留 404）。
// P1d 不实现 JWT 验签、角色授权、数据范围授权与 WS Ticket。
import type { Context, Next } from 'hono'

const API_PREFIX = '/api/v1'
const VALID_MODES = new Set(['deny_all', 'auth_only', 'enforce'])

/** 按路径段边界判断是否属于 API 前缀（避免 /api/v10 被误判）。 */
export function isApiPath(path: string): boolean {
  return path === API_PREFIX || path.startsWith(`${API_PREFIX}/`)
}

export async function gatewayGuard(c: Context, next: Next): Promise<Response | void> {
  if (c.req.method === 'OPTIONS') return next()
  if (c.req.method === 'GET' && c.req.path === '/healthz') return next()

  const configured = (c.env as unknown as { GATEWAY_MODE?: unknown }).GATEWAY_MODE

  if (configured === undefined) {
    console.warn('[gateway] GATEWAY_MODE undefined -> degrade deny_all')
  } else if (typeof configured !== 'string') {
    console.warn('[gateway] GATEWAY_MODE non-string -> degrade deny_all')
  } else if (configured.trim() === '') {
    console.warn('[gateway] GATEWAY_MODE empty -> degrade deny_all')
  } else if (!VALID_MODES.has(configured.trim())) {
    console.warn('[gateway] GATEWAY_MODE invalid:', configured, '-> degrade deny_all')
  } else if (configured.trim() !== 'deny_all') {
    console.warn('[gateway] GATEWAY_MODE not implemented in P1d:', configured.trim())
  }

  if (isApiPath(c.req.path)) {
    return c.json({ error: '服务未开放' }, 403)
  }
  return next()
}

// AUTH-8 · 路由守卫决策（纯函数，便于单元测试）
//
// 设计要点：
//   · Pages Middleware 只保护「网络请求入口」，SPA 内部路由切换不产生新请求，
//     因此必须由 Vue Router 守卫独立判断，不能依赖中间件。
//   · 未认证 → 整页跳转 `/login?next=/#<spa路径>`（登录页为独立 HTML，非 vue-router 路由）。
//   · next 只接受站内相对路径；`//`、`/\`、`/login` 一律降级为 `/`，防开放重定向。
//   · 返回 null 表示放行；返回 { external } 表示整页跳转；返回 { path } 表示 SPA 内重定向。

export const LOGIN_PATH = '/login'

/**
 * 规范化 next 参数：
 *   · 必须是 `/` 开头；
 *   · 不能是协议相对地址（`//evil.com`）或反斜杠绕过（`/\evil.com`）；
 *   · 不能指回登录页自身（避免循环）。
 */
export function sanitizeNext(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return '/'
  if (raw.charAt(0) !== '/') return '/'
  if (raw.charAt(1) === '/' || raw.charAt(1) === '\\') return '/'
  if (raw === LOGIN_PATH || raw.startsWith(`${LOGIN_PATH}?`) || raw.startsWith(`${LOGIN_PATH}/`)) return '/'
  // 禁止控制字符
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F]/.test(raw)) return '/'
  return raw
}

/**
 * 构造登录页地址。SPA 路径以 hash 形式保留：
 *   `/devices` → `/login?next=%2F%23%2Fdevices`
 * 登录成功后 login.html 会跳回 `/#/devices`，即原页面。
 */
export function buildLoginUrl(spaPath) {
  const safePath = typeof spaPath === 'string' && spaPath.startsWith('/') ? spaPath : '/'
  const target = safePath === '/' ? '/' : `/#${safePath}`
  return `${LOGIN_PATH}?next=${encodeURIComponent(sanitizeNext(target))}`
}

/**
 * 计算导航决策。
 * @param {{ isAuthenticated: boolean, mustChangePassword: boolean, isAdmin: boolean }} auth
 * @param {{ path: string, fullPath: string }} to
 * @param {{ requiresAdmin?: boolean }} meta
 * @returns {null | { external: string } | { path: string, replace: true }}
 */
export function resolveGuard(auth, to, meta) {
  const path = to?.path || '/'
  const fullPath = to?.fullPath || path
  // 允许 meta 从第三参数或 to.meta 传入（router 中为 to.meta）
  const m = meta || to?.meta || {}

  if (!auth || !auth.isAuthenticated) {
    return { external: buildLoginUrl(fullPath) }
  }

  // 强制改密：仅允许 /account，其余一律回 /account
  if (auth.mustChangePassword && path !== '/account') {
    return { path: '/account', replace: true }
  }

  // 管理员路由：非管理员回首页（后端 requireAdmin 为最终授权边界）
  if (m.requiresAdmin && !auth.isAdmin) {
    return { path: '/dashboard', replace: true }
  }

  return null
}

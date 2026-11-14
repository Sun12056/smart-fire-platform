// AUTH-8 · 认证 API 客户端
// 约束：
//   · 一律使用**同源相对路径** `/api/auth/*`，不硬编码任何主机名（含 localhost）。
//   · `credentials: 'same-origin'`，依赖浏览器自动携带 HttpOnly Cookie，前端不读取 token。
//   · 统一返回 { ok, status, body }，不抛异常；调用方自行决定 UI 行为。
//   · 所有写操作由浏览器自动附加 Origin / Sec-Fetch-Site，满足后端 CSRF 校验。

const BASE = '/api/auth'

/**
 * 全局 401 处理器：任意认证接口返回 401 时调用，确保 authStore 立即清空，
 * 避免过期 Session 在前端残留。`/session` 的 401 属正常「未登录」探测，不触发。
 */
let onUnauthorized = null
export function setUnauthorizedHandler(fn) {
  onUnauthorized = typeof fn === 'function' ? fn : null
}

async function request(path, options = {}) {
  const headers = { Accept: 'application/json', ...(options.headers || {}) }
  if (options.body !== undefined) headers['Content-Type'] = 'application/json'

  let res
  try {
    res = await fetch(`${BASE}${path}`, {
      ...options,
      headers,
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'manual',
    })
  } catch (e) {
    return { ok: false, status: 0, body: { error: 'NETWORK_ERROR' }, networkError: true, message: String(e?.message || e) }
  }

  const text = await res.text()
  let body = null
  if (text) {
    try {
      body = JSON.parse(text)
    } catch {
      body = { raw: text }
    }
  }

  // 统一 401：会话已失效（过期/被撤销/被禁用）→ 立即清空前端认证状态
  if (res.status === 401 && path !== '/session' && onUnauthorized) {
    try {
      onUnauthorized()
    } catch {
      /* 处理器异常不影响调用方 */
    }
  }

  return { ok: res.ok, status: res.status, body }
}

const post = (path, payload) => request(path, { method: 'POST', body: JSON.stringify(payload ?? {}) })
const patch = (path, payload) => request(path, { method: 'PATCH', body: JSON.stringify(payload ?? {}) })

export const authClient = {
  /** 当前会话（401 表示未登录） */
  session: () => request('/session'),
  /** 登录（由独立登录页调用；此处保留以便本地联调与测试） */
  login: (username, password) => post('/login', { username, password }),
  logout: () => post('/logout'),
  changePassword: (currentPassword, newPassword) => post('/change-password', { currentPassword, newPassword }),

  /** 管理员：用户列表（分页） */
  listUsers: (params = {}) => {
    const q = new URLSearchParams()
    if (params.limit !== undefined) q.set('limit', String(params.limit))
    if (params.offset !== undefined) q.set('offset', String(params.offset))
    if (params.status) q.set('status', params.status)
    if (params.role) q.set('role', params.role)
    const qs = q.toString()
    return request(`/users${qs ? `?${qs}` : ''}`)
  },
  createUser: (payload) => post('/users', payload),
  updateUser: (id, payload) => patch(`/users/${encodeURIComponent(id)}`, payload),
  resetPassword: (id, tempPassword) => post(`/users/${encodeURIComponent(id)}/reset-password`, { tempPassword }),
}

export default authClient

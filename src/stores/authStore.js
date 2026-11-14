// AUTH-8 · 全局用户态
// 职责：
//   · 启动时向后端查询当前 Session（唯一身份来源）；
//   · 暴露 user / role / mustChangePassword 给路由守卫与 UI；
//   · 提供 logout / changePassword，并在改密后清空本地态（后端已撤销全部 Session）。
// 约束：前端角色判断仅用于 UI（菜单/路由），**不是授权边界**；授权由 Worker requireAdmin 负责。

import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { authClient, setUnauthorizedHandler } from '../api/authClient'

export const useAuthStore = defineStore('auth', () => {
  const user = ref(null)
  const loading = ref(false)
  const checked = ref(false)
  const error = ref(null)

  const isAuthenticated = computed(() => Boolean(user.value))
  const role = computed(() => user.value?.role || null)
  const isAdmin = computed(() => role.value === 'admin')
  const mustChangePassword = computed(() => Boolean(user.value?.mustChangePassword))
  const displayName = computed(() => user.value?.displayName || user.value?.username || '')

  /** 查询当前 Session；401 视为未登录（不抛错）。 */
  async function refresh() {
    loading.value = true
    error.value = null
    try {
      const res = await authClient.session()
      if (res.status === 200 && res.body?.user) {
        user.value = res.body.user
      } else if (res.status === 401) {
        user.value = null
      } else {
        // 503 / 网络异常：不臆造登录态，保持 null 并记录错误
        user.value = null
        error.value = res.body?.error || 'SESSION_UNAVAILABLE'
      }
    } catch (e) {
      user.value = null
      error.value = String(e?.message || e)
    } finally {
      loading.value = false
      checked.value = true
    }
    return user.value
  }

  /** 登出：无论后端结果如何，本地一律清空（后端失败时 Cookie 由服务端清除）。 */
  async function logout() {
    try {
      await authClient.logout()
    } finally {
      user.value = null
      checked.value = true
    }
  }

  /**
   * 改密：成功后后端已撤销全部 Session，必须清空本地态并重新登录。
   * 返回 { ok, status, error }。
   */
  async function changePassword(currentPassword, newPassword) {
    const res = await authClient.changePassword(currentPassword, newPassword)
    if (res.ok) {
      user.value = null
      return { ok: true, status: res.status, error: null }
    }
    return { ok: false, status: res.status, error: res.body?.error || 'UNKNOWN' }
  }

  /** 供路由守卫使用：确保已查询过一次 Session。 */
  async function ensureChecked() {
    if (!checked.value) await refresh()
    return user.value
  }

  /** 会话状态有效期：60s 内复用，避免每次路由切换都请求 /api/auth/session。 */
  const FRESH_MS = 60 * 1000
  let lastCheckedAt = 0

  /**
   * 路由守卫专用：返回"足够新鲜"的认证状态。
   * · 首次（未查询过）→ 请求；
   * · 超过 TTL → 重新请求（可发现 Session 过期/被撤销）；
   * · 未过期 → 直接复用，避免循环请求。
   */
  async function ensureFresh(ttlMs = FRESH_MS) {
    const now = Date.now()
    if (!checked.value || now - lastCheckedAt > ttlMs) {
      await refresh()
      lastCheckedAt = Date.now()
    }
    return user.value
  }

  /** 强制标记为未登录（供 401 统一处理调用，幂等）。 */
  function clearSession() {
    user.value = null
    checked.value = true
    lastCheckedAt = Date.now()
  }

  // 任意认证接口返回 401（会话过期/撤销/被禁用）→ 立即清空用户、角色与认证状态
  setUnauthorizedHandler(clearSession)

  return {
    user,
    loading,
    checked,
    error,
    isAuthenticated,
    role,
    isAdmin,
    mustChangePassword,
    displayName,
    refresh,
    logout,
    changePassword,
    ensureChecked,
    ensureFresh,
    clearSession,
  }
})

// AUTH-3 · Pages 全站访问保护中间件
// 职责：
//   · 全站（页面 + 静态资源）默认要求有效 Session；
//   · Session 验证以 Worker /api/auth/session 为唯一权威（Service Binding "API"）；
//   · 未认证页面请求 → 302 /login?next=<原路径>；
//   · Worker 不可用 / 非 200/401 响应 → 503 fail-closed（绝不放行）；
//   · 登录页及其必要资源为明确匿名例外，防止重定向循环；
//   · /api/auth/* 与 /api/v1/* 直接透传，不改变既有网关与 deny_all 语义。

interface ApiFetcher {
  fetch(request: Request): Promise<Response>
}

interface MiddlewareEnv {
  API?: ApiFetcher
}

interface MiddlewareContext {
  request: Request
  env: MiddlewareEnv
  next: () => Promise<Response>
}

/**
 * 登录页匿名例外（**精确匹配**，不做前缀放宽）。
 * 登录页已复用设计稿：auth.css / auth.js / orb-particles.js / favicon.svg 为其必要资源，
 * 若不放行则登录页只能渲染裸 HTML（样式与动效全部失效）。
 * 这些是被保护资源之外的**登录页专属静态文件**，不承载业务数据。
 */
const PUBLIC_EXACT = new Set([
  '/login',
  '/login.html',
  '/favicon.ico',
  '/favicon.svg',
  '/auth.css',
  '/auth.js',
  '/orb-particles.js',
])

/** 登录页专用资源的匿名例外前缀（保留扩展位）。 */
const PUBLIC_PREFIXES = ['/assets/login-']

const LOGIN_PATH = '/login'

function isPublicPath(pathname: string): boolean {
  if (PUBLIC_EXACT.has(pathname)) return true
  for (const p of PUBLIC_PREFIXES) {
    if (pathname.startsWith(p)) return true
  }
  return false
}

/** 认证控制面：必须匿名可达（登录、登出、改密、session 查询）。 */
function isAuthApi(pathname: string): boolean {
  return pathname === '/api/auth' || pathname.startsWith('/api/auth/')
}

/** 业务 API：保持既有 Service Binding 透传与 Worker 侧 deny_all 语义。 */
function isV1Api(pathname: string): boolean {
  return pathname === '/api/v1' || pathname.startsWith('/api/v1/')
}

function redirectToLogin(request: Request): Response {
  const url = new URL(request.url)
  const target = new URL(LOGIN_PATH, url.origin)
  const next = url.pathname + url.search
  if (next && next !== '/' && next !== LOGIN_PATH) {
    target.searchParams.set('next', next)
  }
  return new Response(null, {
    status: 302,
    headers: {
      Location: target.toString(),
      'Cache-Control': 'no-store',
    },
  })
}

function serviceUnavailable(): Response {
  const html = [
    '<!DOCTYPE html>',
    '<html lang="zh-CN"><head><meta charset="UTF-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1.0" />',
    '<title>服务暂不可用</title>',
    '<style>body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;background:#0b1220;color:#e5e7eb;',
    'display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}',
    '.box{max-width:520px;padding:32px;border:1px solid #1f2a44;border-radius:12px;background:#111a2e}',
    'h1{font-size:20px;margin:0 0 12px}p{color:#94a3b8;line-height:1.7;margin:0}</style>',
    '</head><body><div class="box"><h1>503 · 服务暂不可用</h1>',
    '<p>认证服务当前不可用，为保护数据安全已暂停访问。请稍后重试。</p></div></body></html>',
  ].join('')
  return new Response(html, {
    status: 503,
    headers: {
      'Content-Type': 'text/html; charset=UTF-8',
      'Cache-Control': 'no-store',
    },
  })
}

type SessionState = 'ok' | 'unauthenticated' | 'unavailable'

/**
 * 以 Worker 为唯一权威验证当前 Session。
 * 仅 200 视为通过；401 视为未认证；其余状态码与网络异常一律视为不可用（fail-closed）。
 */
async function verifySession(request: Request, api: ApiFetcher): Promise<SessionState> {
  const url = new URL(request.url)
  const cookie = request.headers.get('cookie')
  const headers = new Headers()
  if (cookie) headers.set('cookie', cookie)
  headers.set('accept', 'application/json')

  const probe = new Request(`${url.origin}/api/auth/session`, {
    method: 'GET',
    headers,
    redirect: 'manual',
  })

  try {
    const res = await api.fetch(probe)
    if (res.status === 200) return 'ok'
    if (res.status === 401) return 'unauthenticated'
    return 'unavailable'
  } catch {
    return 'unavailable'
  }
}

export const onRequest = async (context: MiddlewareContext): Promise<Response> => {
  const { request, env, next } = context
  const pathname = new URL(request.url).pathname

  // 认证控制面：匿名透传（登录本身不能被登录保护拦截）
  if (isAuthApi(pathname)) {
    if (!env.API) return serviceUnavailable()
    return env.API.fetch(request)
  }

  // 业务 API：保持既有透传；deny_all 由 Worker 统一返回 403
  if (isV1Api(pathname)) {
    if (!env.API) return serviceUnavailable()
    return env.API.fetch(request)
  }

  // 登录页及必要资源：明确匿名例外，避免重定向循环
  if (isPublicPath(pathname)) {
    return next()
  }

  if (!env.API) return serviceUnavailable()

  const state = await verifySession(request, env.API)
  if (state === 'unauthenticated') return redirectToLogin(request)
  if (state === 'unavailable') return serviceUnavailable()

  return next()
}

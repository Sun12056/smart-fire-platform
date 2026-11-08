// Pages Functions：/api/v1/* → Service Binding "API" → smart-fire-api-trial
// 仅透传 Request / Response；不实现认证、授权、WebSocket 或任何业务逻辑。
// 目标 Worker 无公网入口（workers_dev=false / 无 routes），只能经此 binding 访问。

interface ApiFetcher {
  fetch(request: Request): Promise<Response>
}

interface ProxyEnv {
  API: ApiFetcher
}

interface ProxyContext {
  request: Request
  env: ProxyEnv
}

export const onRequest = async (context: ProxyContext): Promise<Response> => {
  return context.env.API.fetch(context.request)
}

// 绿智哨兵平台 API · Cloudflare Workers + Hono + D1
// 契约：docs/API_CONTRACT.md（阶段一 REST；阶段二 DO+WS / Demo Simulation Engine 在此扩展）
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type { Env } from './types'
import { buildingsRoute } from './routes/buildings'
import { devicesRoute } from './routes/devices'
import { telemetryRoute } from './routes/telemetry'
import { alarmsRoute } from './routes/alarms'
import { inspectionsRoute } from './routes/inspections'
import { evacuationPlansRoute } from './routes/evacuationPlans'
import { personPresenceRoute } from './routes/personPresence'
import { operationLogsRoute } from './routes/operationLogs'
import { adminRoute } from './routes/admin'

const app = new Hono<{ Bindings: Env }>()

// 开发期允许本地 Vite dev server 跨域；生产建议收紧为 Pages 域名
app.use('*', cors())

app.get('/healthz', (c) => c.json({ ok: true, service: 'smart-fire-api', version: 'v1' }))

app.route('/api/v1/buildings', buildingsRoute)
app.route('/api/v1/devices', devicesRoute)
app.route('/api/v1/telemetry', telemetryRoute)
app.route('/api/v1/alarms', alarmsRoute)
app.route('/api/v1/inspections', inspectionsRoute)
app.route('/api/v1/evacuation-plans', evacuationPlansRoute)
app.route('/api/v1/person-presence', personPresenceRoute)
app.route('/api/v1/operation-logs', operationLogsRoute)
app.route('/api/v1/admin', adminRoute)

app.notFound((c) => c.json({ error: '接口不存在' }, 404))
app.onError((err, c) => {
  console.error('[smart-fire-api]', err)
  return c.json({ error: '服务器内部错误' }, 500)
})

export default app

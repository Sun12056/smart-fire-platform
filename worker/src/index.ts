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
import { buildingEvacuationPlansRoute } from './routes/buildingEvacuationPlans'
import { personPresenceRoute } from './routes/personPresence'
import { operationLogsRoute } from './routes/operationLogs'
import { adminRoute } from './routes/admin'
import { demoRoute } from './routes/demo'

// Durable Object 必须由入口模块导出，供 wrangler 绑定
export { DemoRoom } from './durable/DemoRoom'

const app = new Hono<{ Bindings: Env }>()

// 开发期允许本地 Vite dev server 跨域；生产建议收紧为 Pages 域名
app.use('*', cors())

app.get('/healthz', (c) => c.json({ ok: true, service: 'smart-fire-api', version: 'v1' }))

app.route('/api/v1/buildings', buildingsRoute)
app.route('/api/v1/devices', devicesRoute)
app.route('/api/v1/telemetry', telemetryRoute)
app.route('/api/v1/alarms', alarmsRoute)
app.route('/api/v1/inspections', inspectionsRoute)
// ⚠️ LEGACY：旧「单火灾区域 A/B/C 方案」，仅历史/兼容，不再是 Demo 疏散方案来源
app.route('/api/v1/evacuation-plans', evacuationPlansRoute)
// 权威：整栋楼疏散方案（scope = BUILDING，PLAN-A/B/C = 均衡/快速/安全）
app.route('/api/v1/building-evacuation-plans', buildingEvacuationPlansRoute)
app.route('/api/v1/person-presence', personPresenceRoute)
app.route('/api/v1/operation-logs', operationLogsRoute)
app.route('/api/v1/admin', adminRoute)
// 阶段二：Demo 六阶段状态机（REST + WebSocket，状态在 Durable Object）
app.route('/api/v1/demo', demoRoute)

app.notFound((c) => c.json({ error: '接口不存在' }, 404))
app.onError((err, c) => {
  console.error('[smart-fire-api]', err)
  return c.json({ error: '服务器内部错误' }, 500)
})

export default app

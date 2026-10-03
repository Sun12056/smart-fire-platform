// Telemetry 路由：遥测查询 / 单条与批量上报（阶段三 ESP32 + 毫米波雷达入口）
import { Hono } from 'hono'
import type { Env, TelemetryEntry } from '../types'
import { all, run, now, mapTelemetryRow, batch } from '../db'

export const telemetryRoute = new Hono<{ Bindings: Env }>()

const KINDS = ['battery', 'temperature', 'signal', 'voltage', 'brightness', 'personCount', 'status', 'direction', 'mode', 'heartbeat']

telemetryRoute.get('/', async (c) => {
  const q = c.req.query()
  const limit = Math.min(Number(q.limit || 200), 500)
  const conds: string[] = []
  const params: unknown[] = []
  if (q.deviceId) { conds.push('device_id = ?'); params.push(q.deviceId) }
  if (q.kind) { conds.push('kind = ?'); params.push(q.kind) }
  if (q.from) { conds.push('reported_at >= ?'); params.push(q.from) }
  if (q.to) { conds.push('reported_at <= ?'); params.push(q.to) }
  const where = conds.length ? ` WHERE ${conds.join(' AND ')}` : ''
  const rows = await all(c.env.DB, `SELECT * FROM telemetry${where} ORDER BY reported_at DESC, id DESC LIMIT ${limit}`, params)
  return c.json(rows.map(mapTelemetryRow))
})

telemetryRoute.post('/', async (c) => {
  const body = await c.req.json<TelemetryEntry>().catch(() => null)
  if (!body?.deviceId || !body.kind || body.value === undefined) {
    return c.json({ error: '缺少 deviceId / kind / value' }, 400)
  }
  if (!KINDS.includes(body.kind)) return c.json({ error: `非法 kind，允许值：${KINDS.join(', ')}` }, 400)
  await run(c.env.DB, 'INSERT INTO telemetry (device_id, kind, value, reported_at) VALUES (?, ?, ?, ?)', [
    body.deviceId, body.kind, String(body.value), body.reportedAt || now(),
  ])
  return c.json({ ok: true }, 201)
})

telemetryRoute.post('/batch', async (c) => {
  const body = await c.req.json<{ entries?: TelemetryEntry[] }>().catch(() => null)
  const entries = body?.entries
  if (!Array.isArray(entries) || !entries.length) return c.json({ error: '缺少 entries 数组' }, 400)
  const stmts: D1PreparedStatement[] = []
  for (const e of entries) {
    if (!e?.deviceId || !e.kind || e.value === undefined) return c.json({ error: 'entries 中存在缺少 deviceId / kind / value 的条目' }, 400)
    if (!KINDS.includes(e.kind)) return c.json({ error: `非法 kind: ${e.kind}` }, 400)
    // 注意：bind() 返回新的 PreparedStatement，必须收集返回值
    stmts.push(c.env.DB.prepare('INSERT INTO telemetry (device_id, kind, value, reported_at) VALUES (?, ?, ?, ?)')
      .bind(e.deviceId, e.kind, String(e.value), e.reportedAt || now()))
  }
  await batch(c.env.DB, stmts)
  return c.json({ ok: true, count: entries.length }, 201)
})

// Inspection 路由：远程一键巡检历史与结果归档
import { Hono } from 'hono'
import type { Env, Inspection } from '../types'
import { all, first, run, mapInspectionRow, fmtSH } from '../db'

export const inspectionsRoute = new Hono<{ Bindings: Env }>()

inspectionsRoute.get('/', async (c) => {
  const q = c.req.query()
  const limit = Math.min(Number(q.limit || 50), 200)
  const conds: string[] = []
  const params: unknown[] = []
  if (q.deviceId) { conds.push('device_id = ?'); params.push(q.deviceId) }
  if (q.result) { conds.push('result = ?'); params.push(q.result) }
  const where = conds.length ? ` WHERE ${conds.join(' AND ')}` : ''
  const rows = await all(c.env.DB, `SELECT * FROM inspections${where} ORDER BY created_at DESC LIMIT ${limit}`, params)
  return c.json(rows.map(mapInspectionRow))
})

inspectionsRoute.post('/', async (c) => {
  const body = await c.req.json<Partial<Inspection>>().catch(() => null)
  if (!body?.id || !body.deviceId || !body.result) {
    return c.json({ error: '缺少 id / deviceId / result' }, 400)
  }
  await run(c.env.DB, `INSERT OR REPLACE INTO inspections (id, device_id, device_name, result, duration_ms, details, operator, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [
    body.id, body.deviceId, body.deviceName ?? null, body.result, body.durationMs ?? null,
    body.details ? JSON.stringify(body.details) : null, body.operator ?? '系统自动', body.createdAt || fmtSH(),
  ])
  const row = await first(c.env.DB, 'SELECT * FROM inspections WHERE id = ?', [body.id])
  return c.json(mapInspectionRow(row!), 201)
})

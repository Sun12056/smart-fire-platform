// Alarm 路由：告警查询 / 新建 / 七步处置流转（pending→processing→reviewing→resolved）
import { Hono } from 'hono'
import type { Alarm, Env } from '../types'
import { all, first, run, now, mapAlarmRow, ALARM_JOIN_SQL } from '../db'

export const alarmsRoute = new Hono<{ Bindings: Env }>()

const STATUS_PROGRESS: Record<string, number> = { pending: 10, processing: 30, reviewing: 60, resolved: 100 }
const STATUSES = Object.keys(STATUS_PROGRESS)

alarmsRoute.get('/', async (c) => {
  const q = c.req.query()
  const limit = Math.min(Number(q.limit || 200), 500)
  const conds: string[] = []
  const params: unknown[] = []
  if (q.status) { conds.push('a.status = ?'); params.push(q.status) }
  if (q.level) { conds.push('a.level = ?'); params.push(q.level) }
  if (q.buildingId) { conds.push('a.building_id = ?'); params.push(q.buildingId) }
  const where = conds.length ? ` WHERE ${conds.join(' AND ')}` : ''
  const rows = await all(c.env.DB, `${ALARM_JOIN_SQL}${where} ORDER BY a.occurred_at DESC LIMIT ${limit}`, params)
  return c.json(rows.map(mapAlarmRow))
})

alarmsRoute.get('/:id', async (c) => {
  const row = await first(c.env.DB, `${ALARM_JOIN_SQL} WHERE a.id = ?`, [c.req.param('id')])
  if (!row) return c.json({ error: '告警不存在' }, 404)
  return c.json(mapAlarmRow(row))
})

alarmsRoute.post('/', async (c) => {
  const body = await c.req.json<Partial<Alarm>>().catch(() => null)
  if (!body?.id || !body.type || !body.level || !body.buildingId) {
    return c.json({ error: '缺少 id / type / level / buildingId' }, 400)
  }
  await run(c.env.DB, `INSERT INTO alarms (id, device_id, building_id, floor_id, zone, type, level, status, progress, description, occurred_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
    body.id, body.deviceId ?? null, body.buildingId, body.floorId ?? null, body.zone ?? null,
    body.type, body.level, body.status ?? 'pending', body.progress ?? 10, body.description ?? null,
    body.occurredAt || now(),
  ])
  const row = await first(c.env.DB, `${ALARM_JOIN_SQL} WHERE a.id = ?`, [body.id])
  return c.json(mapAlarmRow(row!), 201)
})

alarmsRoute.patch('/:id', async (c) => {
  const id = c.req.param('id')
  const existing = await first(c.env.DB, 'SELECT * FROM alarms WHERE id = ?', [id])
  if (!existing) return c.json({ error: '告警不存在' }, 404)

  const body = await c.req.json<{ status?: string; progress?: number; handledBy?: string }>().catch(() => ({}))
  const sets: string[] = []
  const params: unknown[] = []

  if (body.status !== undefined) {
    if (!STATUSES.includes(body.status)) return c.json({ error: `非法 status，允许值：${STATUSES.join(' → ')}` }, 400)
    sets.push('status = ?')
    params.push(body.status)
    // 契约：status 变化时自动补全 progress
    const progress = body.progress ?? STATUS_PROGRESS[body.status]
    sets.push('progress = ?')
    params.push(progress)
    if (body.status === 'resolved') {
      sets.push('handled_at = ?')
      params.push(now())
    }
  } else if (body.progress !== undefined) {
    sets.push('progress = ?')
    params.push(Number(body.progress))
  }
  if (body.handledBy !== undefined) { sets.push('handled_by = ?'); params.push(body.handledBy) }
  if (!sets.length) return c.json({ error: '无可更新字段' }, 400)

  sets.push('updated_at = ?')
  params.push(now())
  params.push(id)
  await run(c.env.DB, `UPDATE alarms SET ${sets.join(', ')} WHERE id = ?`, params)

  const row = await first(c.env.DB, `${ALARM_JOIN_SQL} WHERE a.id = ?`, [id])
  return c.json(mapAlarmRow(row!))
})

// EvacuationPlan 路由：疏散预案（自动 k 短路 / 手动编辑）保存与生命周期流转
import { Hono } from 'hono'
import type { Env, EvacuationPlan } from '../types'
import { all, first, run, now, mapPlanRow } from '../db'

export const evacuationPlansRoute = new Hono<{ Bindings: Env }>()

const PLAN_STATUSES = ['NORMAL', 'WARNING', 'BLOCKED', 'CONFIRMED', 'EXECUTING', 'DONE']

evacuationPlansRoute.get('/', async (c) => {
  const q = c.req.query()
  const conds: string[] = []
  const params: unknown[] = []
  if (q.buildingId) { conds.push('building_id = ?'); params.push(q.buildingId) }
  if (q.floorId) { conds.push('start_floor = ?'); params.push(q.floorId) }
  if (q.status) { conds.push('status = ?'); params.push(q.status) }
  const where = conds.length ? ` WHERE ${conds.join(' AND ')}` : ''
  const rows = await all(c.env.DB, `SELECT * FROM evacuation_plans${where} ORDER BY created_at DESC LIMIT 500`, params)
  return c.json(rows.map(mapPlanRow))
})

evacuationPlansRoute.get('/:id', async (c) => {
  const row = await first(c.env.DB, 'SELECT * FROM evacuation_plans WHERE id = ?', [c.req.param('id')])
  if (!row) return c.json({ error: '预案不存在' }, 404)
  return c.json(mapPlanRow(row))
})

evacuationPlansRoute.post('/', async (c) => {
  const body = await c.req.json<Partial<EvacuationPlan>>().catch(() => null)
  if (!body?.id || !body.buildingId || !body.startFloor || !body.startArea) {
    return c.json({ error: '缺少 id / buildingId / startFloor / startArea' }, 400)
  }
  const extra = {
    corridor: body.corridor,
    stair: body.stair,
    manualNodes: body.manualNodes,
    manualEdges: body.manualEdges,
  }
  await run(c.env.DB, `INSERT OR REPLACE INTO evacuation_plans
    (id, name, building_id, building_name, start_floor, start_area, exit_id, exit_label, exit_side, type, status, recommended,
     risk_level, score, distance, estimated_time, device_count, congestion, zone_color, floors_passed, path, extra, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
    body.id, body.name ?? null, body.buildingId, body.buildingName ?? null, body.startFloor, body.startArea,
    body.exit ?? null, body.exitLabel ?? null, body.exitSide ?? null, body.type ?? 'auto', body.status ?? 'NORMAL',
    body.recommended ? 1 : 0, body.riskLevel ?? null, body.score ?? null, body.distance ?? null, body.estimatedTime ?? null,
    body.deviceCount ?? null, body.congestion ?? null, body.zoneColor ?? null,
    JSON.stringify(body.floorsPassed ?? []), JSON.stringify(body.path ?? []), JSON.stringify(extra), now(), now(),
  ])
  const row = await first(c.env.DB, 'SELECT * FROM evacuation_plans WHERE id = ?', [body.id])
  return c.json(mapPlanRow(row!), 201)
})

evacuationPlansRoute.patch('/:id', async (c) => {
  const id = c.req.param('id')
  const existing = await first(c.env.DB, 'SELECT * FROM evacuation_plans WHERE id = ?', [id])
  if (!existing) return c.json({ error: '预案不存在' }, 404)

  const body = await c.req.json<{ status?: string; recommended?: boolean }>().catch(() => ({}))
  const sets: string[] = []
  const params: unknown[] = []
  if (body.status !== undefined) {
    if (!PLAN_STATUSES.includes(body.status)) return c.json({ error: `非法 status，允许值：${PLAN_STATUSES.join(' | ')}` }, 400)
    sets.push('status = ?')
    params.push(body.status)
  }
  if (body.recommended !== undefined) { sets.push('recommended = ?'); params.push(body.recommended ? 1 : 0) }
  if (!sets.length) return c.json({ error: '无可更新字段（仅支持 status / recommended）' }, 400)

  sets.push('updated_at = ?')
  params.push(now())
  params.push(id)
  await run(c.env.DB, `UPDATE evacuation_plans SET ${sets.join(', ')} WHERE id = ?`, params)

  const row = await first(c.env.DB, 'SELECT * FROM evacuation_plans WHERE id = ?', [id])
  return c.json(mapPlanRow(row!))
})

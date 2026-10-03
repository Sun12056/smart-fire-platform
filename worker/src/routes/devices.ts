// Device 路由：设备台账查询 / 详情 / 状态与参数下发（阶段三 ESP32 command 复用 PATCH）
import { Hono } from 'hono'
import type { Env } from '../types'
import { all, first, run, now, mapDeviceRow, DEVICE_JOIN_SQL, DEVICE_PATCH_COLUMNS } from '../db'

export const devicesRoute = new Hono<{ Bindings: Env }>()

devicesRoute.get('/', async (c) => {
  const conds: string[] = []
  const params: unknown[] = []
  const q = c.req.query()
  if (q.buildingId) { conds.push('d.building_id = ?'); params.push(q.buildingId) }
  if (q.floorId) { conds.push('d.floor_id = ?'); params.push(q.floorId) }
  if (q.zone) { conds.push('d.zone = ?'); params.push(q.zone) }
  if (q.type) { conds.push('d.type = ?'); params.push(q.type) }
  if (q.status) { conds.push('d.status = ?'); params.push(q.status) }
  if (q.controllable !== undefined && q.controllable !== '') { conds.push('d.controllable = ?'); params.push(q.controllable === 'true' || q.controllable === '1' ? 1 : 0) }
  const where = conds.length ? ` WHERE ${conds.join(' AND ')}` : ''
  const rows = await all(c.env.DB, `${DEVICE_JOIN_SQL}${where} ORDER BY d.id`, params)
  return c.json(rows.map(mapDeviceRow))
})

devicesRoute.get('/:id', async (c) => {
  const row = await first(c.env.DB, `${DEVICE_JOIN_SQL} WHERE d.id = ?`, [c.req.param('id')])
  if (!row) return c.json({ error: '设备不存在' }, 404)
  return c.json(mapDeviceRow(row))
})

devicesRoute.patch('/:id', async (c) => {
  const id = c.req.param('id')
  const existing = await first(c.env.DB, 'SELECT * FROM devices WHERE id = ?', [id])
  if (!existing) return c.json({ error: '设备不存在' }, 404)

  const body = await c.req.json().catch(() => ({}))
  const sets: string[] = []
  const params: unknown[] = []
  const telemetryWrites: Array<{ kind: string; value: string }> = []

  for (const [field, def] of Object.entries(DEVICE_PATCH_COLUMNS)) {
    if (body[field] === undefined) continue
    let value: unknown
    if (def.kind === 'num') value = Number(body[field])
    else if (def.kind === 'bool') value = body[field] ? 1 : 0
    else value = String(body[field])
    sets.push(`${def.col} = ?`)
    params.push(value)
    // 状态类变更自动补写事件型遥测，形成审计轨迹（契约 1.3）
    if (def.telemetry) telemetryWrites.push({ kind: def.telemetry, value: JSON.stringify(value) })
  }
  if (!sets.length) return c.json({ error: '无可更新字段' }, 400)

  sets.push('updated_at = ?')
  params.push(now())
  params.push(id)
  await run(c.env.DB, `UPDATE devices SET ${sets.join(', ')} WHERE id = ?`, params)

  for (const t of telemetryWrites) {
    await run(c.env.DB, 'INSERT INTO telemetry (device_id, kind, value, reported_at) VALUES (?, ?, ?, ?)', [id, t.kind, t.value, now()])
  }

  const row = await first(c.env.DB, `${DEVICE_JOIN_SQL} WHERE d.id = ?`, [id])
  return c.json(mapDeviceRow(row!))
})

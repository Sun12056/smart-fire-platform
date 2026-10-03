// PersonPresence 路由：人员感知列表 / 聚合统计 / 热力图 / 批量 upsert
import { Hono } from 'hono'
import type { Env, PersonPresence } from '../types'
import { all, first, batch, fmtSH, mapPersonRow, PERSON_JOIN_SQL } from '../db'

export const personPresenceRoute = new Hono<{ Bindings: Env }>()

personPresenceRoute.get('/', async (c) => {
  const q = c.req.query()
  const conds: string[] = []
  const params: unknown[] = []
  if (q.buildingId) { conds.push('p.building_id = ?'); params.push(q.buildingId) }
  if (q.floorId) { conds.push('p.floor_id = ?'); params.push(q.floorId) }
  if (q.zone) { conds.push('p.zone = ?'); params.push(q.zone) }
  if (q.status) { conds.push('p.status = ?'); params.push(q.status) }
  const where = conds.length ? ` WHERE ${conds.join(' AND ')}` : ''
  const rows = await all(c.env.DB, `${PERSON_JOIN_SQL}${where} ORDER BY p.id LIMIT 2000`, params)
  return c.json(rows.map(mapPersonRow))
})

// personStats 聚合（对齐 mock/person.js 的 personStats 结构）
personPresenceRoute.get('/stats', async (c) => {
  const totalRow = await first(c.env.DB, `SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status IN ('normal','evacuating') THEN 1 ELSE 0 END) AS active,
      SUM(CASE WHEN status = 'static' OR movement_type = 'static' THEN 1 ELSE 0 END) AS static_count,
      SUM(CASE WHEN status IN ('warning','stranded') THEN 1 ELSE 0 END) AS risk
    FROM person_presence`)
  const sensorRow = await first(c.env.DB, `SELECT COUNT(*) AS cnt FROM devices WHERE type = 'radar_sensor'`)
  const byBuilding = await all(c.env.DB, `SELECT b.name AS name, COUNT(p.id) AS cnt
    FROM buildings b LEFT JOIN person_presence p ON p.building_id = b.id GROUP BY b.id ORDER BY b.id`)
  const byStatus = await all(c.env.DB, `SELECT status, COUNT(*) AS cnt FROM person_presence GROUP BY status`)
  const statusDistribution: Record<string, number> = { normal: 0, warning: 0, static: 0 }
  for (const r of byStatus) {
    const s = String(r.status)
    if (s === 'static' || s === 'warning') statusDistribution[s] = Number(r.cnt)
    else if (s !== 'stranded' && s !== 'located' && s !== 'rescued' && s !== 'evacuating' && s !== 'safe') statusDistribution.normal += Number(r.cnt)
  }
  const buildingDistribution: Record<string, number> = {}
  for (const r of byBuilding) buildingDistribution[String(r.name)] = Number(r.cnt)
  return c.json({
    totalPersons: Number(totalRow?.total ?? 0),
    activeTargets: Number(totalRow?.active ?? 0),
    staticTargets: Number(totalRow?.static_count ?? 0),
    riskZones: Number(totalRow?.risk ?? 0),
    sensorDevices: Number(sensorRow?.cnt ?? 0),
    buildingDistribution,
    statusDistribution,
  })
})

// zoneHeatmap 聚合（按楼层区域聚合，对齐 mock/person.js zoneHeatmap 结构）
personPresenceRoute.get('/heatmap', async (c) => {
  const rows = await all(c.env.DB, `SELECT p.building_id, p.floor_id, p.zone, COUNT(*) AS cnt
    FROM person_presence p GROUP BY p.building_id, p.floor_id, p.zone`)
  const bldNames = await all(c.env.DB, 'SELECT id, name FROM buildings')
  const nameOf: Record<string, string> = {}
  for (const b of bldNames) nameOf[String(b.id)] = String(b.name)
  return c.json(rows.map((r) => {
    const cnt = Number(r.cnt)
    const density = cnt * 25
    return {
      name: `${nameOf[String(r.building_id)] ?? r.building_id}-${String(r.floor_id)}-${String(r.zone)}`,
      building: nameOf[String(r.building_id)] ?? r.building_id,
      floor: String(r.floor_id),
      zone: String(r.zone),
      density,
      personCount: cnt,
      riskLevel: density > 500 ? 'high' : density > 200 ? 'medium' : 'low',
    }
  }))
})

personPresenceRoute.post('/batch', async (c) => {
  const body = await c.req.json<{ persons?: Partial<PersonPresence>[] }>().catch(() => null)
  const persons = body?.persons
  if (!Array.isArray(persons) || !persons.length) return c.json({ error: '缺少 persons 数组' }, 400)

  const stmts: D1PreparedStatement[] = []
  const ts = fmtSH()
  for (const p of persons) {
    if (!p?.id || !p.buildingId || !p.floorId || !p.zone) {
      return c.json({ error: 'persons 中存在缺少 id / buildingId / floorId / zone 的条目' }, 400)
    }
    stmts.push(c.env.DB.prepare(`INSERT OR REPLACE INTO person_presence
      (id, building_id, floor_id, zone, x, y, status, speed, direction, distance, movement_type, source_device_id, detected_at, name, department, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
      p.id, p.buildingId, p.floorId, p.zone, p.x ?? null, p.y ?? null, p.status ?? 'normal',
      p.speed ?? null, p.direction ?? null, p.distance ?? null, p.movementType ?? null,
      p.sourceDeviceId ?? null, p.detectedAt ?? null, p.name ?? null, p.department ?? null, ts,
    ))
  }
  await batch(c.env.DB, stmts)
  return c.json({ ok: true, count: persons.length }, 201)
})

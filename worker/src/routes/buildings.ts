// Building 路由：楼栋列表（含聚合统计）与详情
import { Hono } from 'hono'
import type { Env } from '../types'
import { all, first, mapBuildingRow, BUILDING_AGGREGATE_SQL } from '../db'

export const buildingsRoute = new Hono<{ Bindings: Env }>()

buildingsRoute.get('/', async (c) => {
  const rows = await all(c.env.DB, `${BUILDING_AGGREGATE_SQL} ORDER BY b.id`)
  return c.json(rows.map(mapBuildingRow))
})

buildingsRoute.get('/:id', async (c) => {
  const row = await first(c.env.DB, `${BUILDING_AGGREGATE_SQL} WHERE b.id = ?`, [c.req.param('id')])
  if (!row) return c.json({ error: '楼栋不存在' }, 404)
  return c.json(mapBuildingRow(row))
})

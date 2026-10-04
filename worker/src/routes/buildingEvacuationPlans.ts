// 整栋楼疏散方案（权威接口）：scope = BUILDING
//
// 与旧的 GET /api/v1/evacuation-plans（LEGACY，单火灾区域 A/B/C）严格分离：
//   · 本接口只读 type = 'building' 的行（一行 = 一栋楼的一套策略 PLAN-A/B/C）
//   · 旧接口只读 type != 'building' 的历史行，明确为 legacy，仍保留兼容
// 前端整栋楼疏散（fireStore / 2D / 3D / 人员路线）统一以本接口与 demo 快照的 buildingPlans 为准。
import { Hono } from 'hono'
import type { Env } from '../types'
import { all, first } from '../db'

export const buildingEvacuationPlansRoute = new Hono<{ Bindings: Env }>()

/** 行 → BuildingEvacuationPlan（routes / summary / fire 存于 extra，与 demo 快照同构） */
export function mapBuildingPlanRow(r: Record<string, unknown>) {
  const extra = r.extra ? (JSON.parse(String(r.extra)) as Record<string, unknown>) : {}
  const summary = (extra.summary || {}) as Record<string, unknown>
  return {
    id: String(r.id),
    name: (r.name as string) ?? String(r.id),
    buildingId: String(r.building_id),
    buildingName: (r.building_name as string) ?? undefined,
    // 火灾只描述位置；疏散范围恒为整栋楼
    scope: (extra.scope as string) || 'BUILDING',
    strategy: extra.strategy as 'BALANCED' | 'FASTEST' | 'SAFEST' | undefined,
    strategyLabel: (extra.strategyLabel as string) ?? undefined,
    fire: (extra.fire as { buildingId: string; floorId: string; zone: string }) ?? null,
    startFloor: String(r.start_floor ?? ''),
    startArea: String(r.start_area ?? ''),
    status: String(r.status ?? 'NORMAL'),
    recommended: Number(r.recommended ?? 0) === 1,
    exitId: (r.exit_id as string) ?? undefined,
    exitLabel: (r.exit_label as string) ?? undefined,
    summary,
    routes: (extra.routes as unknown[]) ?? [],
    routesByZoneKeys: (extra.routesByZone as string[]) ?? [],
  }
}

// GET /api/v1/building-evacuation-plans?buildingId=&status=
buildingEvacuationPlansRoute.get('/', async (c) => {
  const q = c.req.query()
  const conds = ["type = 'building'"]
  const params: unknown[] = []
  if (q.buildingId) { conds.push('building_id = ?'); params.push(q.buildingId) }
  if (q.status) { conds.push('status = ?'); params.push(q.status) }
  const rows = await all(
    c.env.DB,
    `SELECT * FROM evacuation_plans WHERE ${conds.join(' AND ')} ORDER BY created_at DESC LIMIT 500`,
    params,
  )
  const plans = rows.map((r) => mapBuildingPlanRow(r as Record<string, unknown>))
  return c.json({
    scope: 'BUILDING',
    buildingId: q.buildingId || null,
    count: plans.length,
    plans,
  })
})

// GET /api/v1/building-evacuation-plans/:id
buildingEvacuationPlansRoute.get('/:id', async (c) => {
  const row = await first(
    c.env.DB,
    "SELECT * FROM evacuation_plans WHERE id = ? AND type = 'building'",
    [c.req.param('id')],
  )
  if (!row) return c.json({ error: '整栋楼疏散方案不存在' }, 404)
  return c.json({ scope: 'BUILDING', plan: mapBuildingPlanRow(row as Record<string, unknown>) })
})

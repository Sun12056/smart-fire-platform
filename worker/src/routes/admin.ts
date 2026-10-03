// Admin 路由：种子数据灌入（生产环境需 X-Seed-Token 与 SEED_TOKEN 匹配）
import { Hono } from 'hono'
import type { Env } from '../types'
import { seed } from '../seed'

export const adminRoute = new Hono<{ Bindings: Env }>()

adminRoute.post('/seed', async (c) => {
  const token = c.env.SEED_TOKEN
  if (token && c.req.header('X-Seed-Token') !== token) {
    return c.json({ error: '无效的种子令牌（X-Seed-Token）' }, 403)
  }
  try {
    const counts = await seed(c.env.DB)
    return c.json({ ok: true, seeded: counts })
  } catch (err) {
    return c.json({ error: `种子数据写入失败：${(err as Error).message}` }, 500)
  }
})

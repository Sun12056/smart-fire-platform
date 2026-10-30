// Admin 路由：种子数据灌入（生产环境需 X-Seed-Token 与 SEED_TOKEN 匹配）
import { Hono } from 'hono'
import type { Env } from '../types'
import { seed } from '../seed'

export const adminRoute = new Hono<{ Bindings: Env }>()

adminRoute.post('/seed', async (c) => {
  const token = c.env.SEED_TOKEN
  // fail-closed：未配置 SEED_TOKEN 时直接禁用种子接口，绝不默认开放
  if (!token) {
    return c.json({ error: '未配置 SEED_TOKEN，种子接口已禁用' }, 501)
  }
  if (c.req.header('X-Seed-Token') !== token) {
    return c.json({ error: '无效的种子令牌（X-Seed-Token）' }, 403)
  }
  try {
    const counts = await seed(c.env.DB)
    return c.json({ ok: true, seeded: counts })
  } catch (err) {
    // 不向客户端泄露底层错误细节（表名 / SQL 错误等），完整信息仅记录到服务端日志
    console.error('[seed] 种子数据写入失败', err)
    return c.json({ error: '种子数据写入失败' }, 500)
  }
})

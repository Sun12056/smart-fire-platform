// OperationLog 路由：统一操作日志查询与写入
import { Hono } from 'hono'
import type { Env, OperationLog } from '../types'
import { all, run, mapLogRow, fmtSH } from '../db'

export const operationLogsRoute = new Hono<{ Bindings: Env }>()

operationLogsRoute.get('/', async (c) => {
  const q = c.req.query()
  const limit = Math.min(Number(q.limit || 200), 500)
  const conds: string[] = []
  const params: unknown[] = []
  if (q.module) { conds.push('module = ?'); params.push(q.module) }
  if (q.level) { conds.push('level = ?'); params.push(q.level) }
  const where = conds.length ? ` WHERE ${conds.join(' AND ')}` : ''
  const rows = await all(c.env.DB, `SELECT * FROM operation_logs${where} ORDER BY created_at DESC, id DESC LIMIT ${limit}`, params)
  return c.json(rows.map(mapLogRow))
})

operationLogsRoute.post('/', async (c) => {
  const body = await c.req.json<Partial<OperationLog>>().catch(() => null)
  if (!body?.action) return c.json({ error: '缺少 action' }, 400)
  await run(c.env.DB, 'INSERT INTO operation_logs (module, action, detail, operator, level, created_at) VALUES (?, ?, ?, ?, ?, ?)', [
    body.module ?? '综合', body.action, body.detail ?? '', body.operator ?? '管理员', body.level ?? 'info',
    fmtSH(),
  ])
  return c.json({ ok: true }, 201)
})

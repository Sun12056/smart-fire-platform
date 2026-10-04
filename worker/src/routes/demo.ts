// Demo 路由：六阶段状态机的 REST 入口 + WebSocket 升级代理
// 状态唯一存在于 Durable Object（DemoRoom），本路由只做转发与静态元信息返回
import { Hono } from 'hono'
import type { Env } from '../types'
import { DEMO_TRANSITIONS, DEMO_FLOW_STAGES, STAGE_META, DEMO_STAGES, DEMO_COMMANDS } from '../demo/stages'

export const demoRoute = new Hono<{ Bindings: Env }>()

function room(c: { env: Env }, sessionId: string) {
  const id = c.env.DEMO_ROOM.idFromName(sessionId || 'default')
  return c.env.DEMO_ROOM.get(id)
}

// 状态机元信息（静态，前端据此渲染六阶段进度条与可用操作）
demoRoute.get('/transitions', (c) => c.json({
  stages: DEMO_STAGES,
  commands: DEMO_COMMANDS,
  transitions: DEMO_TRANSITIONS,
  meta: STAGE_META,
  flow: DEMO_FLOW_STAGES.map((s) => ({ id: s, ...STAGE_META[s] })),
}))

// 当前状态快照
demoRoute.get('/state', async (c) => {
  const sessionId = c.req.query('sessionId') || 'default'
  return room(c, sessionId).fetch(new Request('https://demo/state', { method: 'GET' }))
})

// 发送业务指令（唯一的状态推进入口）
demoRoute.post('/command', async (c) => {
  const sessionId = c.req.query('sessionId') || 'default'
  const body = await c.req.text()
  return room(c, sessionId).fetch(new Request('https://demo/command', { method: 'POST', body }))
})

// 重置
demoRoute.post('/reset', async (c) => {
  const sessionId = c.req.query('sessionId') || 'default'
  return room(c, sessionId).fetch(new Request('https://demo/reset', { method: 'POST', body: '{}' }))
})

// WebSocket：实时状态协调与广播（仅转发，状态仍在 DO）
demoRoute.get('/ws', async (c) => {
  const sessionId = c.req.query('sessionId') || 'default'
  return room(c, sessionId).fetch(c.req.raw)
})

// Demo Simulation Engine 服务：六阶段状态机的唯一前端入口
// 前端只发起业务指令（command）与呈现状态，不自行推演阶段
import { endpoints, DEMO_COMMANDS } from '../api/contract'

// Demo 端点不在通用 Repository 中，直接走同源 fetch（与 apiRepository 一致的 BASE_URL）
const BASE_URL = (import.meta.env.VITE_API_BASE_URL || 'http://localhost:8787').replace(/\/$/, '')
const SESSION_ID = import.meta.env.VITE_DEMO_SESSION_ID || 'default'

async function request(path, options = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  })
  const body = await res.json().catch(() => null)
  if (!res.ok) {
    const error = new Error((body && body.error) || `HTTP ${res.status}`)
    error.status = res.status
    error.payload = body
    throw error
  }
  return body
}

export const demoService = {
  sessionId: SESSION_ID,

  async getState() {
    return request(`${endpoints.demoState}?sessionId=${encodeURIComponent(SESSION_ID)}`)
  },

  async getTransitions() {
    return request(endpoints.demoTransitions)
  },

  /** 发送业务指令；非法转换由后端返回 409（含允许的命令列表） */
  async sendCommand(command, payload = {}) {
    if (!DEMO_COMMANDS.includes(command)) throw new Error(`未知指令：${command}`)
    return request(`${endpoints.demoCommand}?sessionId=${encodeURIComponent(SESSION_ID)}`, {
      method: 'POST',
      body: JSON.stringify({ command, payload }),
    })
  },

  async reset() {
    return request(`${endpoints.demoReset}?sessionId=${encodeURIComponent(SESSION_ID)}`, { method: 'POST' })
  },
}

export { BASE_URL as DEMO_API_BASE_URL }

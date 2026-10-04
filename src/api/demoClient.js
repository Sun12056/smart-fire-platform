// ================== Demo WebSocket 客户端 ==================
// 只负责「实时通道」：订阅后端状态机广播、心跳保活、断线自动重连（指数退避）。
// 业务状态一律以后端广播为准，前端不自行推演阶段。
import { endpoints, WS_MSG } from './contract'

const BASE_URL = (import.meta.env.VITE_API_BASE_URL || 'http://localhost:8787').replace(/\/$/, '')

function toWsUrl(httpUrl) {
  return httpUrl.replace(/^http/, 'ws')
}

export class DemoSocket {
  constructor(options = {}) {
    this.sessionId = options.sessionId || 'default'
    this.onMessage = options.onMessage || (() => {})
    this.onStatus = options.onStatus || (() => {})
    this.ws = null
    this.status = 'idle'
    this.retry = 0
    this.heartbeatTimer = null
    this.reconnectTimer = null
    this.manuallyClosed = false
    this.heartbeatMs = options.heartbeatMs || 15000
  }

  get url() {
    return `${toWsUrl(BASE_URL)}${endpoints.demoWs(this.sessionId)}`
  }

  connect() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return
    this.manuallyClosed = false
    this.setStatus('connecting')
    try {
      this.ws = new WebSocket(this.url)
    } catch (err) {
      this.setStatus('error')
      this.scheduleReconnect()
      return
    }

    this.ws.onopen = () => {
      this.retry = 0
      this.setStatus('open')
      this.startHeartbeat()
    }
    this.ws.onmessage = (evt) => {
      let msg = null
      try { msg = JSON.parse(evt.data) } catch { return }
      if (!msg || !msg.type) return
      this.onMessage(msg)
    }
    this.ws.onerror = () => { this.setStatus('error') }
    this.ws.onclose = () => {
      this.stopHeartbeat()
      if (this.manuallyClosed) { this.setStatus('closed'); return }
      this.setStatus('reconnecting')
      this.scheduleReconnect()
    }
  }

  scheduleReconnect() {
    if (this.reconnectTimer) return
    const delay = Math.min(1000 * 2 ** this.retry, 15000)
    this.retry += 1
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, delay)
  }

  startHeartbeat() {
    this.stopHeartbeat()
    this.heartbeatTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: WS_MSG.PING, at: new Date().toISOString() }))
      }
    }, this.heartbeatMs)
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null }
  }

  /** 重连成功后主动拉取全量快照，补齐断线期间的状态 */
  requestSync() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: WS_MSG.SYNC }))
    }
  }

  setStatus(status) {
    this.status = status
    this.onStatus(status)
  }

  close() {
    this.manuallyClosed = true
    this.stopHeartbeat()
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null }
    if (this.ws) {
      try { this.ws.close() } catch { /* ignore */ }
      this.ws = null
    }
    this.setStatus('closed')
  }
}

export const DEMO_WS_URL = `${toWsUrl(BASE_URL)}${endpoints.demoWs()}`

// ================== MockRepository ==================
// 双数据源之「本地模拟」实现：直接复用 src/mock/* 与 deviceSeed，
// 行为与改造前的前端完全一致（默认数据源）。
import { buildings as mockBuildings } from '../mock/buildings'
import { alarms as mockAlarms } from '../mock/alarms'
import { persons as mockPersons, personStats as mockPersonStats, zoneHeatmap as mockZoneHeatmap } from '../mock/person'
import { inspectionHistory as mockInspectionHistory } from '../mock/inspection'
import { buildSeedDevices } from '../mock/deviceSeed'

// 会话内可变状态（模拟远端持久化）
let sessionPlans = []
let sessionLogs = []
let sessionInspections = [...mockInspectionHistory]
let sessionAlarms = JSON.parse(JSON.stringify(mockAlarms))
let seededDevices = null

function getDevices() {
  if (!seededDevices) seededDevices = buildSeedDevices()
  return seededDevices
}

// 简易确定性伪随机（按字符串散列），保证同一设备的遥测曲线稳定可复现
function hashSeed(str) {
  let h = 2166136261
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) }
  return () => { h = Math.imul(h ^ (h >>> 15), 2246822507); h ^= h >>> 13; return (h >>> 0) / 4294967296 }
}

function filterByParams(list, params = {}) {
  return list.filter((item) => {
    if (params.buildingId && item.buildingId !== params.buildingId) return false
    if (params.floorId && item.floorId !== params.floorId) return false
    if (params.zone && item.zone !== params.zone && item.area !== params.zone) return false
    if (params.type && item.type !== params.type) return false
    if (params.status && item.status !== params.status) return false
    if (params.controllable !== undefined && params.controllable !== null && String(item.controllable) !== String(params.controllable)) return false
    return true
  })
}

export const mockRepository = {
  // ── Building ──
  buildings: {
    async list() {
      return JSON.parse(JSON.stringify(mockBuildings))
    },
  },

  // ── Device ──
  devices: {
    async list(params = {}) {
      return filterByParams(getDevices(), params)
    },
    async update(id, patch = {}) {
      const dev = getDevices().find((d) => d.id === id)
      if (dev) Object.assign(dev, patch)
      return dev ? { ...dev } : null
    },
  },

  // ── Telemetry ──
  telemetry: {
    async list({ deviceId, kind, limit = 200 } = {}) {
      if (!deviceId) return []
      const dev = getDevices().find((d) => d.id === deviceId)
      if (!dev) return []
      const rand = hashSeed(deviceId + (kind || 'battery'))
      const kinds = kind ? [kind] : ['battery', 'temperature', 'signal']
      const entries = []
      for (let i = 0; i < Math.min(limit, 200); i++) {
        const t = new Date(Date.now() - i * 15 * 60 * 1000)
        entries.push(
          ...kinds.map((k) => ({
            id: `${deviceId}-${k}-${i}`,
            deviceId,
            kind: k,
            value: String(
              k === 'battery' ? Math.max(5, Math.round((dev.battery ?? 80) - i * 0.05 * rand() * 4))
                : k === 'temperature' ? +((dev.temperature ?? 26) + (rand() - 0.5) * 2).toFixed(1)
                : Math.round((dev.signal ?? 90) + (rand() - 0.5) * 10)
            ),
            reportedAt: t.toLocaleString('zh-CN'),
          }))
        )
      }
      return entries
    },
    async create() { /* mock 模式遥测写入为空操作 */ },
    async createBatch() { /* mock 模式遥测写入为空操作 */ },
  },

  // ── Alarm ──
  alarms: {
    async list(params = {}) {
      let list = sessionAlarms
      if (params.status) list = list.filter((a) => a.status === params.status)
      if (params.level) list = list.filter((a) => a.level === params.level)
      if (params.buildingId) list = list.filter((a) => a.buildingId === params.buildingId)
      return JSON.parse(JSON.stringify(list))
    },
    async get(id) {
      const a = sessionAlarms.find((x) => x.id === id)
      return a ? JSON.parse(JSON.stringify(a)) : null
    },
    async create(alarm) {
      sessionAlarms.unshift({ ...alarm })
      return { ...alarm }
    },
    async update(id, patch = {}) {
      const a = sessionAlarms.find((x) => x.id === id)
      if (a) Object.assign(a, patch)
      return a ? { ...a } : null
    },
  },

  // ── Inspection ──
  inspections: {
    async list(params = {}) {
      let list = sessionInspections
      if (params.deviceId) list = list.filter((i) => i.deviceId === params.deviceId)
      if (params.result) list = list.filter((i) => i.result === params.result)
      return JSON.parse(JSON.stringify(list))
    },
    async create(result) {
      sessionInspections.unshift({ ...result })
      if (sessionInspections.length > 20) sessionInspections.pop()
      return { ...result }
    },
  },

  // ── EvacuationPlan ──
  evacuationPlans: {
    async list(params = {}) {
      let list = sessionPlans
      if (params.buildingId) list = list.filter((p) => p.buildingId === params.buildingId)
      if (params.floorId) list = list.filter((p) => p.startFloor === params.floorId)
      if (params.status) list = list.filter((p) => p.status === params.status)
      return JSON.parse(JSON.stringify(list))
    },
    async get(id) {
      const p = sessionPlans.find((x) => x.id === id)
      return p ? JSON.parse(JSON.stringify(p)) : null
    },
    async create(plan) {
      const created = { ...plan, createdAt: new Date().toLocaleString('zh-CN') }
      sessionPlans.push(created)
      return JSON.parse(JSON.stringify(created))
    },
    async update(id, patch = {}) {
      const p = sessionPlans.find((x) => x.id === id)
      if (p) Object.assign(p, patch)
      return p ? { ...p } : null
    },
  },

  // ── PersonPresence ──
  personPresence: {
    async list(params = {}) {
      let list = mockPersons
      if (params.buildingId) list = list.filter((p) => p.buildingId === params.buildingId)
      if (params.floorId) list = list.filter((p) => p.floorId === params.floorId)
      if (params.zone) list = list.filter((p) => p.zone === params.zone)
      if (params.status) list = list.filter((p) => p.status === params.status)
      return JSON.parse(JSON.stringify(list))
    },
    async stats() {
      return JSON.parse(JSON.stringify(mockPersonStats))
    },
    async heatmap() {
      return JSON.parse(JSON.stringify(mockZoneHeatmap))
    },
    async upsertBatch() { /* mock 模式人员基线只读 */ },
  },

  // ── OperationLog ──
  operationLogs: {
    async list(params = {}) {
      let list = sessionLogs
      if (params.module) list = list.filter((l) => l.module === params.module)
      if (params.level) list = list.filter((l) => l.level === params.level)
      return JSON.parse(JSON.stringify(list.slice(0, params.limit || 200)))
    },
    async create(log) {
      const now = new Date()
      const created = {
        id: `OP-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        time: now.toLocaleTimeString('zh-CN'),
        action: log.action || '',
        module: log.module || '综合',
        detail: log.detail || '',
        level: log.level || 'info',
      }
      sessionLogs.unshift(created)
      if (sessionLogs.length > 200) sessionLogs.pop()
      return { ...created }
    },
  },
}

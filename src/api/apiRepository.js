// ================== ApiRepository ==================
// 双数据源之「远端 API」实现：fetch → Workers(Hono) → D1。
// 与 mockRepository 方法签名一一对应；数据形状由 docs/API_CONTRACT.md 约束。
import { endpoints, buildQuery } from './contract'

const BASE_URL = (import.meta.env.VITE_API_BASE_URL || 'http://localhost:8787').replace(/\/$/, '')

async function request(path, options = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  })
  if (!res.ok) {
    let message = `HTTP ${res.status}`
    try { const body = await res.json(); if (body && body.error) message = body.error } catch { /* ignore */ }
    throw new Error(`[ApiRepository] ${path} ${message}`)
  }
  return res.status === 204 ? null : res.json()
}

const get = (path) => request(path)
const post = (path, body) => request(path, { method: 'POST', body: JSON.stringify(body ?? {}) })
const patch = (path, body) => request(path, { method: 'PATCH', body: JSON.stringify(body ?? {}) })

export const apiRepository = {
  buildings: {
    list: (params) => get(`${endpoints.buildingList}${buildQuery(params)}`),
  },

  devices: {
    list: (params) => get(`${endpoints.deviceList}${buildQuery(params)}`),
    update: (id, patchBody) => patch(endpoints.deviceUpdate(id), patchBody),
  },

  telemetry: {
    list: (params) => get(`${endpoints.telemetryList}${buildQuery(params)}`),
    create: (entry) => post(endpoints.telemetryCreate, entry),
    createBatch: (entries) => post(endpoints.telemetryBatch, { entries }),
  },

  alarms: {
    list: (params) => get(`${endpoints.alarmList}${buildQuery(params)}`),
    get: (id) => get(endpoints.alarmDetail(id)),
    create: (alarm) => post(endpoints.alarmCreate, alarm),
    update: (id, patchBody) => patch(endpoints.alarmUpdate(id), patchBody),
  },

  inspections: {
    list: (params) => get(`${endpoints.inspectionList}${buildQuery(params)}`),
    create: (result) => post(endpoints.inspectionCreate, result),
  },

  evacuationPlans: {
    list: (params) => get(`${endpoints.evacuationPlanList}${buildQuery(params)}`),
    get: (id) => get(endpoints.evacuationPlanDetail(id)),
    create: (plan) => post(endpoints.evacuationPlanCreate, plan),
    update: (id, patchBody) => patch(endpoints.evacuationPlanUpdate(id), patchBody),
  },

  personPresence: {
    list: (params) => get(`${endpoints.personPresenceList}${buildQuery(params)}`),
    stats: () => get(endpoints.personPresenceStats),
    heatmap: () => get(endpoints.personPresenceHeatmap),
    upsertBatch: (persons) => post(endpoints.personPresenceBatch, { persons }),
  },

  operationLogs: {
    list: (params) => get(`${endpoints.operationLogList}${buildQuery(params)}`),
    create: (log) => post(endpoints.operationLogCreate, log),
  },
}

export { BASE_URL }

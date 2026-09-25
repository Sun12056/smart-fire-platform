import { devices } from './devices'

function pad(num, len) {
  return String(num).padStart(len, '2')
}

function formatTime(d) {
  const Y = d.getFullYear()
  const M = String(d.getMonth() + 1).padStart(2, '0')
  const D = String(d.getDate()).padStart(2, '0')
  const h = String(d.getHours()).padStart(2, '0')
  const m = String(d.getMinutes()).padStart(2, '0')
  const s = String(d.getSeconds()).padStart(2, '0')
  return `${Y}-${M}-${D} ${h}:${m}:${s}`
}

const now = new Date()

// 初始告警从 devices 中真实 warning/fault 设备派生
const warningDevs = devices
  .filter((d) => d.status === 'warning' || d.status === 'fault')
  .slice(0, 8)

export const alarms = warningDevs.map((d, idx) => ({
  id: `AL-2026-0905-${String(idx + 1).padStart(3, '0')}`,
  time: formatTime(new Date(now.getTime() - (idx + 1) * 600000)),
  building: d.building,
  floor: d.floor,
  area: d.area,
  device: d.name,
  deviceId: d.id,
  type: d.status === 'fault' ? '设备离线' : d.type === 'temperature_sensor' ? '温度异常' : d.type === 'smoke_detector' ? '烟感异常' : '通信异常',
  level: d.status === 'fault' ? 'danger' : 'warning',
  status: idx < 2 ? 'pending' : idx < 4 ? 'processing' : 'resolved',
  progress: idx < 2 ? 10 : idx < 4 ? 50 : 100,
  description: `${d.building}${d.floor}${d.area} ${d.name} 状态异常，需要处置`,
}))

export const alarmLevels = {
  danger: { label: '严重', color: '#EF4444', bg: 'rgba(239,68,68,0.15)' },
  warning: { label: '预警', color: '#F59E0B', bg: 'rgba(245,158,11,0.15)' },
  info: { label: '提示', color: '#4CC9F0', bg: 'rgba(76,201,240,0.15)' },
}

export const alarmStatuses = {
  pending: { label: '待处理', color: '#F59E0B' },
  processing: { label: '处理中', color: '#4CC9F0' },
  reviewing: { label: '待复核', color: '#4CC9F0' },
  resolved: { label: '已完成', color: '#22C55E' },
}

export const alarmTypes = [
  '设备离线',
  '电量不足',
  '温度异常',
  '烟感异常',
  '通信异常',
  '设备故障',
  '模拟火灾告警',
]

export function getAlarmStats(alarmList) {
  const list = Array.isArray(alarmList) ? alarmList : alarms
  const total = list.length
  const pending = list.filter((a) => a && a.status === 'pending').length
  const processing = list.filter((a) => a && (a.status === 'processing' || a.status === 'reviewing')).length
  const resolved = list.filter((a) => a && a.status === 'resolved').length
  const danger = list.filter((a) => a && a.level === 'danger').length
  return { total, pending, processing, resolved, danger }
}

export function getAlarmById(id) {
  return alarms.find((a) => a.id === id)
}

import { devices, getDeviceStats, getDeviceTypeStats } from './devices'

const safeDevices = Array.isArray(devices) ? devices : []
const deviceStats = getDeviceStats(safeDevices)
const deviceTypeStats = getDeviceTypeStats(safeDevices)

export const statistics = {
  // 派生自 devices.js 的实时统计
  totalDevices: deviceStats.total,
  onlineDevices: deviceStats.online,
  abnormalDevices: deviceStats.warning + deviceStats.fault,
  offlineDevices: deviceStats.fault,
  todayAlarms: 12,
  patrolRate: 96.8,
  systemStatus: '运行正常',
  updateTime: new Date().toLocaleString('zh-CN'),

  // 设备运行状态
  deviceStatus: {
    normal: deviceStats.normal,
    warning: deviceStats.warning,
    fault: deviceStats.fault,
    emergency: deviceStats.emergency,
  },

  // 设备类型统计
  deviceTypes: deviceTypeStats,

  // 今日告警趋势 (24小时)
  alarmTrend: {
    hours: ['00:00', '04:00', '08:00', '12:00', '16:00', '20:00', '24:00'],
    values: [1, 0, 2, 3, 4, 2, 0],
  },

  // 最近7天告警
  weeklyAlarms: {
    days: ['周一', '周二', '周三', '周四', '周五', '周六', '今日'],
    values: [8, 5, 10, 7, 6, 3, 12],
  },
}

// 生成设备历史数据 (用于详情页图表)
export function generateDeviceHistory(deviceId, days = 7) {
  const batteryData = []
  const tempData = []
  const labels = []
  const now = new Date()
  for (let i = days; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 86400000)
    labels.push(`${d.getMonth() + 1}/${d.getDate()}`)
    batteryData.push(20 + Math.floor(Math.random() * 80))
    tempData.push(20 + Math.floor(Math.random() * 25))
  }
  return { labels, batteryData, tempData }
}

// 生成楼层设备分布
export function getFloorDeviceDistribution(buildingName) {
  const floors = ['1F', '2F', '3F', '4F', '5F', '6F']
  const devList = Array.isArray(devices) ? devices : []
  return floors.map((f) => {
    const floorDevs = devList.filter((d) => d && d.building === buildingName && d.floor === f)
    const total = floorDevs.length
    const abnormal = floorDevs.filter((d) => d && (d.status === 'warning' || d.status === 'fault')).length
    return {
      floor: f,
      total,
      abnormal,
      normal: total - abnormal,
    }
  })
}

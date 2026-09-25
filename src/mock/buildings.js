import { devices } from './devices'

/**
 * 楼栋数据
 * 从 devices 聚合派生楼层/设备/状态信息
 */

const buildingList = [
  { id: 'B001', name: '1号楼', type: '办公楼' },
  { id: 'B002', name: '2号楼', type: '办公楼' },
  { id: 'B003', name: '3号楼', type: '实验楼' },
  { id: 'B004', name: '4号楼', type: '综合楼' },
]

export const buildings = buildingList.map((b) => {
  const bldDevs = devices.filter((d) => d.building === b.name)
  const total = bldDevs.length
  const online = bldDevs.filter((d) => d.status !== 'fault').length
  const abnormal = bldDevs.filter((d) => d.status === 'warning' || d.status === 'emergency').length
  const offline = bldDevs.filter((d) => d.status === 'fault').length
  const hasEmergency = bldDevs.some((d) => d.status === 'emergency')
  const hasWarning = bldDevs.some((d) => d.status === 'warning' || d.status === 'fault')

  return {
    ...b,
    floors: b.floors || Math.max(...bldDevs.map((d) => parseInt(d.floor)), 0),
    deviceCount: total,
    online,
    abnormal,
    offline,
    status: hasEmergency ? 'emergency' : hasWarning ? 'warning' : 'normal',
    patrolRate: 95 + Math.floor(Math.random() * 5),
    lastAlarm: hasWarning ? new Date().toLocaleString('zh-CN') : '2026-09-04 14:30:00',
  }
})

export function getBuildingById(id) {
  return buildings.find((b) => b.id === id)
}

export function updateBuildingStatus(id, status) {
  const b = buildings.find((b) => b.id === id)
  if (b) b.status = status
}

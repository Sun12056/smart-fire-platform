import { devices } from './devices'

/**
 * 应急疏散方向动态管控 - Mock 数据
 * 疏散指示灯本身已统一在 devices.js 的 FireNode 模型中（type=evacuation_light）。
 * 本文件保留：方向映射、操作日志、楼层选项。
 */

// 方向映射
export const directionMap = {
  left: '向左',
  right: '向右',
}

// 方向角度映射（用于箭头旋转）
export const directionAngle = {
  left: 180,
  right: 0,
}

// 疏散指示设备从 devices 派生（兼容旧引用）
export const evacuationDevices = devices.filter((d) => d.type === 'evacuation_light')

// 按楼层获取疏散设备
export function getDevicesByFloor(floor) {
  return devices.filter((d) => d.type === 'evacuation_light' && d.floor === floor)
}

// 初始操作日志
export const initialEvacuationLogs = [
  {
    id: 'LOG-001',
    time: '22:30:12',
    action: '系统自动检测到设备在线',
    detail: '3F-A区疏散指示灯 通信正常',
    operator: '系统',
    level: 'info',
  },
  {
    id: 'LOG-002',
    time: '22:30:46',
    action: '管理员查看3F-A区疏散指示灯',
    detail: '当前方向：向左',
    operator: '管理员',
    level: 'info',
  },
  {
    id: 'LOG-003',
    time: '22:31:08',
    action: '管理员手动触发方向切换，避开火源',
    detail: '3F-A区疏散指示灯 向左 → 向右',
    operator: '管理员',
    floor: '3F',
    device: 'A区疏散指示灯',
    fromDirection: 'left',
    toDirection: 'right',
    reason: '避开火源',
    result: '执行成功',
    level: 'warning',
  },
]

// 楼层选项
export const floorOptions = ['1F', '2F', '3F', '4F', '5F', '6F']

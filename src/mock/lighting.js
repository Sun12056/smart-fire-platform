import { devices } from './devices'

/**
 * 智能照明 Mock 数据
 * 纯本地模拟，不接真实接口
 * 照明设备本身已统一在 devices.js 的 FireNode 模型中（type=emergency_light）。
 * 本文件只保留：模式定义、聚合状态、亮度历史。
 */

// 照明模式定义（唯一权威来源）
export const lightingModes = {
  daily: {
    id: 'daily',
    name: '日常节能',
    description: '根据环境光照自动调节亮度，兼顾舒适与节能',
    brightness: 60,
    icon: 'Sunny',
    color: '#22C55E',
  },
  induction: {
    id: 'induction',
    name: '人员感应增强',
    description: '检测到人员活动时自动增强照明，无人时降低亮度',
    brightness: 85,
    icon: 'Cpu',
    color: '#4CC9F0',
  },
  emergency: {
    id: 'emergency',
    name: '应急照明',
    description: '紧急情况下全功率照明，保障人员疏散安全',
    brightness: 100,
    icon: 'Warning',
    color: '#EF4444',
  },
}

// 从 devices 派生的照明设备列表（兼容旧引用）
export const lightingDevices = devices.filter((d) => d.type === 'emergency_light')

// 默认照明状态：取第一个照明设备聚合
const firstLight = lightingDevices[0]
export const defaultLighting = {
  currentDevice: firstLight || null,
  currentMode: lightingModes.daily,
  brightness: firstLight ? firstLight.brightness : 60,
  detectedPerson: firstLight ? firstLight.detectedPerson : true,
  ambientLight: 320,
  temperature: 24.5,
  humidity: 55,
  powerConsumption: firstLight ? firstLight.powerConsumption : 24.5,
  todayEnergy: 0.65,
  monthEnergy: 18.6,
  status: firstLight ? firstLight.status : 'online',
}

// 亮度历史数据（24小时，每小时一个点）
export const brightnessHistory = {
  time: ['00:00', '01:00', '02:00', '03:00', '04:00', '05:00', '06:00', '07:00', '08:00', '09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00', '18:00', '19:00', '20:00', '21:00', '22:00', '23:00'],
  values: [20, 15, 15, 10, 10, 20, 40, 55, 60, 60, 60, 58, 55, 58, 60, 60, 62, 65, 70, 75, 80, 60, 40, 25],
}

export function getLightingByBuilding(building) {
  return devices.filter((d) => d.type === 'emergency_light' && d.building === building)
}

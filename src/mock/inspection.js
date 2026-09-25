import { devices } from './devices'

/**
 * 巡检 Mock 数据
 * 纯本地模拟，不接真实接口
 * 巡检设备本身已统一在 devices.js 的 FireNode 模型中（type=radar_sensor）。
 * 本文件保留：巡检项定义、步骤定义、历史记录、结果生成器、巡检设备列表。
 */

// 巡检设备从 devices 派生（兼容旧引用）
export const inspectionDevices = devices
  .filter((d) => d.type === 'radar_sensor')
  .map((d) => ({
    id: d.id,
    name: d.name,
    building: d.building,
    floor: d.floor,
    type: '雷达感知终端',
  }))

// 巡检项目定义
export const inspectionItems = [
  {
    id: 'comm',
    name: '通信状态',
    icon: 'Connection',
    description: '检查设备与服务器之间的通信链路状态',
    checkItems: [
      { id: 'comm-1', name: 'Wi-Fi连接', target: '信号强度≥-70dBm' },
      { id: 'comm-2', name: 'MQTT连接', target: '心跳正常' },
      { id: 'comm-3', name: '数据上报', target: '间隔≤30s' },
      { id: 'comm-4', name: '网络延迟', target: '≤200ms' },
    ],
  },
  {
    id: 'radar',
    name: '雷达模块',
    icon: 'Aim',
    description: '检测毫米波雷达探测功能是否正常',
    checkItems: [
      { id: 'radar-1', name: '探测距离', target: '0-10m' },
      { id: 'radar-2', name: '目标识别', target: '≥95%准确率' },
      { id: 'radar-3', name: '抗干扰能力', target: '正常' },
      { id: 'radar-4', name: '灵敏度', target: 'Level 3' },
    ],
  },
  {
    id: 'lighting',
    name: '照明模块',
    icon: 'Sunny',
    description: '检查照明设备的工作状态和亮度调节',
    checkItems: [
      { id: 'lighting-1', name: '灯具开关', target: '响应正常' },
      { id: 'lighting-2', name: '亮度调节', target: '0-100%可调' },
      { id: 'lighting-3', name: '感应功能', target: '人员检测正常' },
      { id: 'lighting-4', name: '功耗', target: '≤50W' },
    ],
  },
  {
    id: 'config',
    name: '参数配置',
    icon: 'Setting',
    description: '验证设备配置参数是否正确加载',
    checkItems: [
      { id: 'config-1', name: '设备ID', target: '已配置' },
      { id: 'config-2', name: '楼栋/楼层', target: '已配置' },
      { id: 'config-3', name: '工作模式', target: '已设置' },
      { id: 'config-4', name: '阈值参数', target: '在范围内' },
    ],
  },
  {
    id: 'power',
    name: '电源状态',
    icon: 'Lightning',
    description: '检测设备供电情况和电源稳定性',
    checkItems: [
      { id: 'power-1', name: '输入电压', target: 'AC 220V±10%' },
      { id: 'power-2', name: '供电稳定性', target: '波动≤5%' },
      { id: 'power-3', name: '备用电池', target: '电量≥80%' },
      { id: 'power-4', name: '功耗', target: '≤50W' },
    ],
  },
]

// 巡检步骤定义
export const inspectionSteps = [
  { id: 'step-1', name: '连接设备', icon: 'Link', duration: 2000, description: '建立与目标设备的通信连接，验证链路可达性' },
  { id: 'step-2', name: '检测通信', icon: 'Connection', duration: 3000, description: '全面检查Wi-Fi、MQTT及数据上报链路状态' },
  { id: 'step-3', name: '检测雷达', icon: 'Aim', duration: 4000, description: '测试雷达模块探测距离、识别精度和抗干扰能力' },
  { id: 'step-4', name: '检测照明', icon: 'Sunny', duration: 3500, description: '验证照明模块开关、亮度调节和人员感应功能' },
  { id: 'step-5', name: '检测参数', icon: 'Setting', duration: 2500, description: '核对设备配置参数，确认所有设置项正确加载' },
  { id: 'step-6', name: '生成报告', icon: 'Document', duration: 1500, description: '汇总所有检测项结果，生成完整巡检报告' },
]

// 巡检历史记录 - 8条
export const inspectionHistory = [
  {
    id: 'INS-20260905-001',
    deviceName: '1号楼1F雷达感知终端',
    deviceId: inspectionDevices[0]?.id || 'RDR-001',
    time: '2026-09-05 09:15:00',
    result: 'pass',
    duration: 16500,
    details: [
      { itemId: 'comm', name: '通信状态', result: 'pass', message: '所有通信链路正常' },
      { itemId: 'radar', name: '雷达模块', result: 'pass', message: '探测距离10m，识别准确率97%' },
      { itemId: 'lighting', name: '照明模块', result: 'pass', message: '亮度调节正常，感应功能正常' },
      { itemId: 'config', name: '参数配置', result: 'pass', message: '所有参数配置正确' },
      { itemId: 'power', name: '电源状态', result: 'pass', message: '电压220V，电池电量95%' },
    ],
    operator: '系统自动',
  },
  {
    id: 'INS-20260905-002',
    deviceName: '2号楼1F雷达感知终端',
    deviceId: inspectionDevices[1]?.id || 'RDR-002',
    time: '2026-09-05 08:30:00',
    result: 'warning',
    duration: 18200,
    details: [
      { itemId: 'comm', name: '通信状态', result: 'pass', message: '通信正常，网络延迟180ms' },
      { itemId: 'radar', name: '雷达模块', result: 'pass', message: '探测功能正常' },
      { itemId: 'lighting', name: '照明模块', result: 'warning', message: '亮度调节响应延迟2.3s，建议检查驱动' },
      { itemId: 'config', name: '参数配置', result: 'pass', message: '参数配置正确' },
      { itemId: 'power', name: '电源状态', result: 'pass', message: '供电正常' },
    ],
    operator: '张工程师',
  },
  {
    id: 'INS-20260904-003',
    deviceName: '3号楼1F雷达感知终端',
    deviceId: inspectionDevices[2]?.id || 'RDR-003',
    time: '2026-09-04 17:45:00',
    result: 'pass',
    duration: 15000,
    details: [
      { itemId: 'comm', name: '通信状态', result: 'pass', message: '通信正常' },
      { itemId: 'radar', name: '雷达模块', result: 'pass', message: '探测正常' },
      { itemId: 'lighting', name: '照明模块', result: 'pass', message: '照明正常' },
      { itemId: 'config', name: '参数配置', result: 'pass', message: '配置正确' },
      { itemId: 'power', name: '电源状态', result: 'pass', message: '电源正常' },
    ],
    operator: '系统自动',
  },
  {
    id: 'INS-20260904-004',
    deviceName: '4号楼2F雷达感知终端',
    deviceId: inspectionDevices[3]?.id || 'RDR-004',
    time: '2026-09-04 14:20:00',
    result: 'fail',
    duration: 22000,
    details: [
      { itemId: 'comm', name: '通信状态', result: 'pass', message: '通信正常' },
      { itemId: 'radar', name: '雷达模块', result: 'fail', message: '雷达模块无响应，疑似硬件故障' },
      { itemId: 'lighting', name: '照明模块', result: 'pass', message: '照明正常' },
      { itemId: 'config', name: '参数配置', result: 'pass', message: '配置正确' },
      { itemId: 'power', name: '电源状态', result: 'pass', message: '电源正常' },
    ],
    operator: '李工程师',
  },
  {
    id: 'INS-20260904-005',
    deviceName: '1号楼3F雷达感知终端',
    deviceId: inspectionDevices[4]?.id || 'RDR-005',
    time: '2026-09-04 10:00:00',
    result: 'pass',
    duration: 16000,
    details: [
      { itemId: 'comm', name: '通信状态', result: 'pass', message: '通信正常' },
      { itemId: 'radar', name: '雷达模块', result: 'pass', message: '探测正常' },
      { itemId: 'lighting', name: '照明模块', result: 'pass', message: '照明正常' },
      { itemId: 'config', name: '参数配置', result: 'pass', message: '配置正确' },
      { itemId: 'power', name: '电源状态', result: 'pass', message: '电源正常' },
    ],
    operator: '系统自动',
  },
  {
    id: 'INS-20260903-006',
    deviceName: '2号楼3F雷达感知终端',
    deviceId: inspectionDevices[5]?.id || 'RDR-006',
    time: '2026-09-03 16:30:00',
    result: 'warning',
    duration: 19500,
    details: [
      { itemId: 'comm', name: '通信状态', result: 'warning', message: 'MQTT心跳间隔偏长(35s)，略超阈值' },
      { itemId: 'radar', name: '雷达模块', result: 'pass', message: '探测正常' },
      { itemId: 'lighting', name: '照明模块', result: 'pass', message: '照明正常' },
      { itemId: 'config', name: '参数配置', result: 'pass', message: '配置正确' },
      { itemId: 'power', name: '电源状态', result: 'warning', message: '备用电池电量78%，建议充电' },
    ],
    operator: '王工程师',
  },
  {
    id: 'INS-20260903-007',
    deviceName: '3号楼2F雷达感知终端',
    deviceId: inspectionDevices[6]?.id || 'RDR-007',
    time: '2026-09-03 09:00:00',
    result: 'pass',
    duration: 15500,
    details: [
      { itemId: 'comm', name: '通信状态', result: 'pass', message: '通信正常' },
      { itemId: 'radar', name: '雷达模块', result: 'pass', message: '探测正常' },
      { itemId: 'lighting', name: '照明模块', result: 'pass', message: '照明正常' },
      { itemId: 'config', name: '参数配置', result: 'pass', message: '配置正确' },
      { itemId: 'power', name: '电源状态', result: 'pass', message: '电源正常' },
    ],
    operator: '系统自动',
  },
  {
    id: 'INS-20260902-008',
    deviceName: '4号楼1F雷达感知终端',
    deviceId: inspectionDevices[7]?.id || 'RDR-008',
    time: '2026-09-02 11:15:00',
    result: 'pass',
    duration: 17000,
    details: [
      { itemId: 'comm', name: '通信状态', result: 'pass', message: '通信正常' },
      { itemId: 'radar', name: '雷达模块', result: 'pass', message: '探测正常' },
      { itemId: 'lighting', name: '照明模块', result: 'pass', message: '照明正常' },
      { itemId: 'config', name: '参数配置', result: 'pass', message: '配置正确' },
      { itemId: 'power', name: '电源状态', result: 'pass', message: '电源正常' },
    ],
    operator: '张工程师',
  },
]

// 随机结果池
const resultPool = ['pass', 'pass', 'pass', 'pass', 'warning', 'fail']
const messagePool = {
  comm: {
    pass: ['通信链路正常', 'Wi-Fi信号良好，MQTT连接稳定', '数据上报间隔正常'],
    warning: ['网络延迟略高(210ms)', 'MQTT心跳间隔偏长(32s)'],
    fail: ['Wi-Fi连接断开', 'MQTT连接失败', '数据上报超时'],
  },
  radar: {
    pass: ['探测距离10m，识别准确率97%', '雷达模块工作正常', '目标检测正常，灵敏度达标'],
    warning: ['探测距离略缩(8.5m)', '灵敏度偏低(Level 2)'],
    fail: ['雷达模块无响应', '目标识别率低于阈值(82%)'],
  },
  lighting: {
    pass: ['亮度调节正常，感应功能正常', '照明模块工作正常', '灯具开关响应正常'],
    warning: ['亮度调节响应延迟2.1s', '感应灵敏度偏低'],
    fail: ['灯具无法开启', '亮度调节失效'],
  },
  config: {
    pass: ['所有参数配置正确', '配置项加载完整'],
    warning: ['部分阈值参数接近边界值'],
    fail: ['设备ID未配置', '工作模式参数丢失'],
  },
  power: {
    pass: ['电压220V，电池电量95%', '供电稳定，功耗正常', '电源状态良好'],
    warning: ['备用电池电量78%', '电压波动偏大(±8%)'],
    fail: ['输入电压异常', '备用电池电量过低(15%)'],
  },
}

export function generateInspectionResult(deviceId) {
  const now = new Date()
  const timeStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`

  const details = inspectionItems.map((item) => {
    const result = resultPool[Math.floor(Math.random() * resultPool.length)]
    const messages = messagePool[item.id][result]
    const message = messages[Math.floor(Math.random() * messages.length)]
    return { itemId: item.id, name: item.name, result, message }
  })

  let overallResult = 'pass'
  if (details.some((d) => d.result === 'fail')) overallResult = 'fail'
  else if (details.some((d) => d.result === 'warning')) overallResult = 'warning'

  const totalDuration = inspectionSteps.reduce((sum, s) => sum + s.duration, 0)

  return {
    id: `INS-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(Math.floor(Math.random() * 900) + 100)}`,
    deviceName: `雷达感知终端-${deviceId}`,
    deviceId,
    time: timeStr,
    result: overallResult,
    duration: totalDuration + Math.floor(Math.random() * 5000),
    details,
    operator: '系统自动',
  }
}

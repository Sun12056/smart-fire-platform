/**
 * 设备参数配置 Mock 数据
 * 纯本地模拟，不接真实接口
 */

// 雷达参数
const radarParams = {
  detectionRange: 8,       // 探测距离 0-10m
  sensitivity: 3,          // 灵敏度 1-5
  mode: 'both',            // 模式: motion / microWave / both
  filterLevel: 2           // 滤波等级 1-3
}

// 照明参数
const lightingParams = {
  defaultBrightness: 60,       // 默认亮度 0-100
  inductionBrightness: 85,     // 感应亮度 0-100
  delayTime: 30,               // 延迟时间(秒)
  emergencyBrightness: 100     // 应急亮度
}

// 通信参数
const communicationParams = {
  wifiStatus: 'connected',     // Wi-Fi状态
  mqttStatus: 'connected',     // MQTT状态
  heartbeatInterval: 15,       // 心跳间隔(秒)
  reportInterval: 30           // 上报间隔(秒)
}

// 默认设备配置（合并以上三个）
const defaultDeviceConfig = {
  deviceId: 'RDR-DEFAULT-001',
  deviceName: '默认雷达感知终端',
  ...radarParams,
  ...lightingParams,
  ...communicationParams
}

// 配置下发历史 - 5条
const configHistory = [
  {
    id: 'CFG-20260905-001',
    deviceId: 'RDR-1F-001',
    deviceName: '1号楼1F雷达感知终端',
    time: '2026-09-05 08:00:00',
    changes: [
      { param: 'detectionRange', oldValue: 6, newValue: 8, label: '探测距离' },
      { param: 'sensitivity', oldValue: 2, newValue: 3, label: '灵敏度' },
      { param: 'mode', oldValue: 'motion', newValue: 'both', label: '检测模式' }
    ],
    operator: '张工程师',
    status: 'success'
  },
  {
    id: 'CFG-20260904-002',
    deviceId: 'RDR-2F-004',
    deviceName: '4号楼2F雷达感知终端',
    time: '2026-09-04 15:30:00',
    changes: [
      { param: 'defaultBrightness', oldValue: 50, newValue: 60, label: '默认亮度' },
      { param: 'inductionBrightness', oldValue: 80, newValue: 90, label: '感应亮度' },
      { param: 'delayTime', oldValue: 20, newValue: 30, label: '延迟时间' }
    ],
    operator: '李工程师',
    status: 'success'
  },
  {
    id: 'CFG-20260904-003',
    deviceId: 'RDR-3F-005',
    deviceName: '1号楼3F雷达感知终端',
    time: '2026-09-04 10:15:00',
    changes: [
      { param: 'heartbeatInterval', oldValue: 10, newValue: 15, label: '心跳间隔' },
      { param: 'reportInterval', oldValue: 20, newValue: 30, label: '上报间隔' }
    ],
    operator: '系统自动',
    status: 'success'
  },
  {
    id: 'CFG-20260903-004',
    deviceId: 'RDR-2F-006',
    deviceName: '2号楼3F雷达感知终端',
    time: '2026-09-03 14:00:00',
    changes: [
      { param: 'mode', oldValue: 'microWave', newValue: 'both', label: '检测模式' },
      { param: 'filterLevel', oldValue: 1, newValue: 2, label: '滤波等级' }
    ],
    operator: '王工程师',
    status: 'fail'
  },
  {
    id: 'CFG-20260902-005',
    deviceId: 'RDR-1F-008',
    deviceName: '4号楼1F雷达感知终端',
    time: '2026-09-02 09:30:00',
    changes: [
      { param: 'detectionRange', oldValue: 5, newValue: 7, label: '探测距离' },
      { param: 'sensitivity', oldValue: 3, newValue: 4, label: '灵敏度' },
      { param: 'defaultBrightness', oldValue: 55, newValue: 65, label: '默认亮度' },
      { param: 'inductionBrightness', oldValue: 75, newValue: 85, label: '感应亮度' },
      { param: 'emergencyBrightness', oldValue: 90, newValue: 100, label: '应急亮度' }
    ],
    operator: '张工程师',
    status: 'success'
  }
]

// 参数范围定义（用于滑块控件）
const paramRanges = {
  detectionRange: {
    label: '探测距离',
    min: 0,
    max: 10,
    step: 0.5,
    unit: 'm'
  },
  sensitivity: {
    label: '灵敏度',
    min: 1,
    max: 5,
    step: 1,
    unit: '级'
  },
  filterLevel: {
    label: '滤波等级',
    min: 1,
    max: 3,
    step: 1,
    unit: '级'
  },
  defaultBrightness: {
    label: '默认亮度',
    min: 0,
    max: 100,
    step: 5,
    unit: '%'
  },
  inductionBrightness: {
    label: '感应亮度',
    min: 0,
    max: 100,
    step: 5,
    unit: '%'
  },
  delayTime: {
    label: '延迟时间',
    min: 5,
    max: 120,
    step: 5,
    unit: '秒'
  },
  emergencyBrightness: {
    label: '应急亮度',
    min: 50,
    max: 100,
    step: 5,
    unit: '%'
  },
  heartbeatInterval: {
    label: '心跳间隔',
    min: 5,
    max: 60,
    step: 5,
    unit: '秒'
  },
  reportInterval: {
    label: '上报间隔',
    min: 10,
    max: 120,
    step: 10,
    unit: '秒'
  }
}

export {
  radarParams,
  lightingParams,
  communicationParams,
  defaultDeviceConfig,
  configHistory,
  paramRanges
}

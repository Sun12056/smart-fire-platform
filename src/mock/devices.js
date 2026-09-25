/**
 * 消防智能节点统一模型 (FireNode)
 * 纯本地模拟，不接真实接口
 *
 * 所有消防相关终端统一为 FireNode，通过 type 区分功能：
 * - emergency_light   消防应急照明灯   control=true
 * - evacuation_light  疏散指示灯       control=true（方向控制）
 * - radar_sensor      雷达感知终端     control=false
 * - smoke_detector    烟感探测器       control=false
 * - temperature_sensor 温感探测器      control=false
 * - sound_alarm       声光报警器       control=false
 * - fire_hydrant      消防栓           control=false
 * - sprinkler         喷淋头           control=false
 */

// 固定种子伪随机，保证每次初始化数据一致
let _seed = 20260905
function random() {
  _seed = (_seed * 9301 + 49297) % 233280
  return _seed / 233280
}
function randInt(min, max) {
  return Math.floor(random() * (max - min + 1)) + min
}
function randItem(arr) {
  return arr[Math.floor(random() * arr.length)]
}
function pad(num, len) {
  return String(num).padStart(len, '0')
}
function formatDate(d) {
  const Y = d.getFullYear()
  const M = pad(d.getMonth() + 1, 2)
  const D = pad(d.getDate(), 2)
  const h = pad(d.getHours(), 2)
  const m = pad(d.getMinutes(), 2)
  const s = pad(d.getSeconds(), 2)
  return `${Y}-${M}-${D} ${h}:${m}:${s}`
}

// 楼栋定义
export const buildings = [
  { id: 'B001', name: '1号楼', floors: 6, type: '办公楼' },
  { id: 'B002', name: '2号楼', floors: 6, type: '办公楼' },
  { id: 'B003', name: '3号楼', floors: 6, type: '实验楼' },
  { id: 'B004', name: '4号楼', floors: 6, type: '综合楼' },
]

// 类型元数据
export const nodeTypes = {
  emergency_light: { label: '消防应急照明灯', controllable: true, icon: 'Lightbulb' },
  evacuation_light: { label: '疏散指示灯', controllable: true, icon: 'Signpost' },
  radar_sensor: { label: '雷达感知终端', controllable: false, icon: 'ScanLine' },
  smoke_detector: { label: '烟感探测器', controllable: false, icon: 'Flame' },
  temperature_sensor: { label: '温感探测器', controllable: false, icon: 'Thermometer' },
  sound_alarm: { label: '声光报警器', controllable: false, icon: 'Bell' },
  fire_hydrant: { label: '消防栓', controllable: false, icon: 'Droplets' },
  sprinkler: { label: '喷淋头', controllable: false, icon: 'ShowerHead' },
}

// 楼层区域模板
const floorAreaTemplates = {
  office: ['A区', 'B区', 'C区', '走廊'],
  lab: ['A区', 'B区', '实验室', '走廊'],
  complex: ['A区', 'B区', '大厅', '走廊'],
}

// 方向定义（疏散指示灯专用）
export const directions = ['left', 'right']
export const directionMap = {
  left: '向左',
  right: '向右',
}
export const directionAngle = {
  left: 180,
  right: 0,
}

// 生成设备
export const devices = []
let idCounter = 1

function getAreasByBuildingType(type) {
  if (type === '实验楼') return floorAreaTemplates.lab
  if (type === '综合楼') return floorAreaTemplates.complex
  return floorAreaTemplates.office
}

buildings.forEach((bld) => {
  const areas = getAreasByBuildingType(bld.type)
  for (let f = 1; f <= bld.floors; f++) {
    const floorStr = `${f}F`
    areas.forEach((area) => {
      // 每个区域必配：应急照明灯 + 疏散指示灯 + 雷达 + 烟感 + 温感
      const baseName = `${bld.name}${floorStr}${area}`
      const location = { building: bld.name, floor: floorStr, area }

      // 应急照明灯
      devices.push(createNode('emergency_light', baseName + '应急照明灯', location))
      // 疏散指示灯
      devices.push(createNode('evacuation_light', baseName + '疏散指示灯', location))
      // 雷达感知终端
      devices.push(createNode('radar_sensor', baseName + '雷达感知终端', location))
      // 烟感探测器
      devices.push(createNode('smoke_detector', baseName + '烟感探测器', location))
      // 温感探测器
      devices.push(createNode('temperature_sensor', baseName + '温感探测器', location))

      // 走廊额外加声光报警器；楼梯/出口区域不加传统探测器避免重复
      if (area === '走廊') {
        devices.push(createNode('sound_alarm', baseName + '声光报警器', location))
      }
    })

    // 每层楼楼梯间加疏散指示灯
    devices.push(createNode('evacuation_light', `${bld.name}${floorStr}东侧楼梯疏散指示灯`, {
      building: bld.name, floor: floorStr, area: '东侧楼梯'
    }))
    devices.push(createNode('evacuation_light', `${bld.name}${floorStr}西侧楼梯疏散指示灯`, {
      building: bld.name, floor: floorStr, area: '西侧楼梯'
    }))
  }

  // 每栋楼每 2 层加消防栓、喷淋头
  for (let f = 1; f <= bld.floors; f += 2) {
    const floorStr = `${f}F`
    devices.push(createNode('fire_hydrant', `${bld.name}${floorStr}消防栓`, {
      building: bld.name, floor: floorStr, area: '公共区域'
    }))
    devices.push(createNode('sprinkler', `${bld.name}${floorStr}喷淋头`, {
      building: bld.name, floor: floorStr, area: '公共区域'
    }))
  }
})

function createNode(type, name, location) {
  const statusRoll = random()
  let status = 'normal'
  if (statusRoll > 0.97) status = 'fault'
  else if (statusRoll > 0.93) status = 'warning'

  const lastTime = new Date(Date.now() - Math.floor(random() * 3600000))
  const id = `FN-${pad(idCounter++, 4)}`

  const node = {
    id,
    name,
    type,
    building: location.building,
    floor: location.floor,
    area: location.area,
    status,
    controllable: nodeTypes[type].controllable,
    battery: status === 'fault' ? 0 : randInt(20, 100),
    temperature: status === 'fault' ? 0 : randInt(20, 35),
    communication: status === 'fault' ? 'offline' : 'online',
    lastReport: formatDate(lastTime),
    installPosition: `${location.floor}${location.area}`,
    workHours: randInt(100, 8760),
    voltage: status === 'fault' ? 0 : (3.0 + random() * 1.2).toFixed(2),
    signal: status === 'fault' ? 0 : randInt(60, 100),
    // 疏散指示灯专用
    ...(type === 'evacuation_light' ? {
      direction: randItem(directions),
      recommendedDirection: randItem(directions),
    } : {}),
    // 照明类通用
    ...(type === 'emergency_light' || type === 'evacuation_light' ? {
      brightness: status === 'fault' ? 0 : randInt(30, 100),
      currentMode: status === 'fault' ? 'offline' : 'daily',
      detectedPerson: random() > 0.5,
      powerConsumption: randInt(10, 45),
    } : {}),
    // 雷达专用
    ...(type === 'radar_sensor' ? {
      detectionRange: randInt(5, 10),
      sensitivity: randInt(1, 5),
      detectedPersons: randInt(0, 5),
    } : {}),
  }
  return node
}

// 预设火灾演示设备：3号楼5F A区域关键节点
const demoArea = { building: '3号楼', floor: '5F', area: 'A区' }
const demoNodes = devices.filter(
  (d) => d.building === demoArea.building && d.floor === demoArea.floor && d.area === demoArea.area
)
demoNodes.forEach((d) => {
  // 应急照明灯保持 normal，等 simulateFireAlarm 时再切换为 emergency
  if (d.type === 'smoke_detector' || d.type === 'temperature_sensor') {
    d.status = 'warning'
    d.temperature = d.type === 'temperature_sensor' ? 41 : d.temperature
    d.battery = Math.max(10, d.battery - 20)
  }
})

// 旧兼容函数
export function getDevicesByBuilding(bldName) {
  return devices.filter((d) => d.building === bldName)
}

export function getDevicesByBuildingAndFloor(bldName, floor) {
  return devices.filter((d) => d.building === bldName && d.floor === floor)
}

export function getDeviceById(id) {
  return devices.find((d) => d.id === id)
}

export function getDeviceStats(deviceList) {
  const list = Array.isArray(deviceList) ? deviceList : devices
  const total = list.length
  const normal = list.filter((d) => d && d.status === 'normal').length
  const warning = list.filter((d) => d && d.status === 'warning').length
  const fault = list.filter((d) => d && d.status === 'fault').length
  const emergency = list.filter((d) => d && d.status === 'emergency').length
  return { total, normal, warning, fault, emergency, online: total - fault }
}

export function getDeviceTypeStats(deviceList) {
  const list = Array.isArray(deviceList) ? deviceList : devices
  const stats = {}
  Object.keys(nodeTypes).forEach((t) => {
    stats[nodeTypes[t].label] = list.filter((d) => d && d.type === t).length
  })
  return stats
}

export function getDevicesByType(type) {
  return devices.filter((d) => d.type === type)
}

export function getNodesByLocation(building, floor, area) {
  return devices.filter(
    (d) => d.building === building && d.floor === floor && (area ? d.area === area : true)
  )
}

// 旧兼容：deviceTypes 保留中文数组
export const deviceTypes = Object.values(nodeTypes).map((t) => t.label)

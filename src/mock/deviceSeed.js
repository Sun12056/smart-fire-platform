// ================== 设备种子数据（4 栋 × 6 层，与 floorPlanData / 首页平面图同源） ==================
// 每台设备都带 x/y 坐标与疏散方向，首页、设备管理、联动、路线规划读的是同一批对象；id 含楼栋前缀保证全局唯一
// 从 fireStore 抽出为纯函数模块：store 与 MockRepository 共用，保证 mock / api 双数据源形状完全一致
import { generateFloorDevices } from './floorPlanData'

export function buildSeedDevices() {
  const list = []
  const bldNames = { B001: '1号楼', B002: '2号楼', B003: '3号楼', B004: '4号楼' }
  const FLOORS = ['1F', '2F', '3F', '4F', '5F', '6F']
  let _dSeed = 20260905
  const _rand = () => { _dSeed = (_dSeed * 9301 + 49297) % 233280; return _dSeed / 233280 }
  const _randInt = (min, max) => Math.floor(_rand() * (max - min + 1)) + min
  const typeName = (t) => ({
    evacuation_light: '疏散指示灯',
    emergency_light: '应急照明灯',
    smoke_detector: '烟感探测器',
    radar_sensor: '雷达感知终端',
    exit_sign: '安全出口标识',
  }[t] || '消防设备')
  const lastReport = () => new Date(Date.now() - Math.floor(_rand() * 3600000)).toLocaleString('zh-CN')

  Object.entries(bldNames).forEach(([bid, bname]) => {
    FLOORS.forEach((fid) => {
      generateFloorDevices(fid, bid).forEach((pd) => {
        const roll = _rand()
        const status = roll > 0.97 ? 'fault' : roll > 0.93 ? 'warning' : 'normal'
        const fault = status === 'fault'
        const isLight = pd.type === 'evacuation_light' || pd.type === 'emergency_light'
        const isRadar = pd.type === 'radar_sensor'
        const areaSuffix = pd.type === 'exit_sign' ? '' : pd.area || ''
        list.push({
          id: `${bid}-${pd.id}`,          // 楼栋前缀，跨楼唯一（如 B003-EL-5F-01）
          planId: pd.id,
          name: `${bname}${fid}${areaSuffix}${typeName(pd.type)}`,
          type: pd.type,
          building: bname,
          buildingId: bid,
          floor: fid,
          floorId: fid,
          area: pd.area,
          zoneName: pd.zoneName || pd.area,
          x: pd.x,
          y: pd.y,
          status,
          controllable: isLight,
          battery: fault ? 0 : _randInt(30, 100),
          temperature: fault ? 0 : _randInt(20, 34),
          communication: fault ? 'offline' : 'online',
          lastReport: lastReport(),
          installPosition: `${bname}${fid}${areaSuffix}`,
          workHours: _randInt(100, 8760),
          voltage: fault ? 0 : +(3.0 + _rand() * 1.2).toFixed(2),
          signal: fault ? 0 : _randInt(60, 100),
          direction: pd.direction || 'right',
          recommendedDirection: pd.direction || 'right',
          brightness: fault ? 0 : _randInt(50, 100),
          currentMode: fault ? 'offline' : 'daily',
          detectionRange: isRadar ? 8 : undefined,
          detectedPersons: isRadar ? _randInt(0, 5) : undefined,
          exitId: pd.exitId,
          stairId: pd.stairId,
          doorId: pd.doorId,
          emergencyFlash: false,
        })
      })
    })
  })
  return list
}

/**
 * 应急救援 Mock 数据
 */

export const rescueResources = [
  { id: 'RS-001', name: '微型消防站', type: 'station', status: 'ready', count: 1, location: '1号楼西侧' },
  { id: 'RS-002', name: '消防巡逻队', type: 'team', status: 'ready', count: 6, location: '园区南门' },
  { id: 'RS-003', name: '应急救护车', type: 'vehicle', status: 'ready', count: 2, location: '园区北门' },
  { id: 'RS-004', name: '疏散引导员', type: 'staff', status: 'ready', count: 12, location: '各楼栋' },
  { id: 'RS-005', name: '排烟设备', type: 'equipment', status: 'ready', count: 4, location: '3号楼地下车库' },
  { id: 'RS-006', name: '灭火机器人', type: 'robot', status: 'ready', count: 2, location: '消防控制室' },
  { id: 'RS-007', name: '应急物资车', type: 'vehicle', status: 'ready', count: 1, location: '园区东门' },
]

export const emergencySteps = [
  { id: 'ES-001', name: '接警确认', description: '接收告警并确认火情位置', status: 'pending' },
  { id: 'ES-002', name: '人员疏散', description: '启动应急广播与疏散指引', status: 'pending' },
  { id: 'ES-003', name: '消防联动', description: '启动喷淋、排烟、防火卷帘', status: 'pending' },
  { id: 'ES-004', name: '救援力量调度', description: '派遣消防站、巡逻队、救护车', status: 'pending' },
  { id: 'ES-005', name: '现场处置', description: '初期灭火与人员搜救', status: 'pending' },
  { id: 'ES-006', name: '善后恢复', description: '确认安全后恢复系统状态', status: 'pending' },
]

export const disposalPlan = [
  { step: 1, content: '立即启动3号楼5F应急广播，通知人员疏散' },
  { step: 2, content: '启动该楼层排烟系统与喷淋系统' },
  { step: 3, content: '派遣微型消防站与灭火机器人赶赴现场' },
  { step: 4, content: '联动120救护车在园区北门待命' },
  { step: 5, content: '封锁3号楼周边道路，引导救援车辆进入' },
  { step: 6, content: '火势控制后逐步恢复供电与照明' },
]

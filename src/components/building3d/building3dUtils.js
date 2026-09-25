// 楼宇数字孪生 3D · 共享工具与视觉规范
// ────────────────────────────────────────────────────────────
// 颜色语义（用户硬规范）：
//   蓝灰系 = 建筑主体 / 楼板 / 选中楼层 → 数字孪生基底
//   电弧蓝 = 边缘 / 数据 / 设备
//   红     = 火灾 / 危险 / 警示
//   绿     = 疏散 / 出口 / 救援完成 / 疏散指示灯箭头（永远）
//   暖白   = 应急照明灯（呼吸 + 强闪）
//   救援橙 = 救援队伍 / 应急协同
// ────────────────────────────────────────────────────────────
import * as THREE from 'three'

export const COLORS = {
  // ── 数字孪生基底（深色但不沉闷） ──
  bg:          0x101827,  // 场景背景（用户指定 #101827）
  building:    0x26364D,  // 建筑主体（用户指定）
  slab:        0x30435C,  // 楼板（用户指定）
  edge:        0x4CC9F0,  // 建筑边缘（电弧蓝）
  zoneHi:      0x4361EE,  // 选中区域 / 选中楼层（用户指定 #4361EE）
  zoneHiSoft:  0x3949AB,
  floorDim:    0x1A2235,  // 非选中楼层底色
  // ── 消防语义 ──
  fire:        0xFF4D4F,  // 火灾（用户指定）
  fireEdge:    0xFF7875,
  evac:        0x39FF88,  // 疏散指示灯 / 疏散路线 / 安全出口（用户硬规范 #39FF88）
  evacDeep:    0x0B1F14,  // 疏散指示灯底色（深绿）
  emLight:     0xF8F3E4,  // 应急照明灯暖白（用户指定）
  rescue:      0xFF9F43,  // 救援（用户指定）
  warn:        0xF59E0B,  // 预警（橙）
  // ── 人员状态色 ──
  personNormal:    0x4CC9F0, // 青：正常
  personMoving:    0x67E8F9, // 浅青：移动
  personWarning:   0xF59E0B, // 橙：预警
  personEmergency: 0xEF4444, // 红：被困/应急
  personStranded:  0xFF7875, // 浅红：滞留
  personLocated:   0x22C55E, // 绿：已定位/已获救
  personStatic:    0x94A3B8, // 灰：静止
}

// 把 hex 转成 THREE.Color 副本
export function toColor(hex) {
  return new THREE.Color(hex)
}

// ── 当前楼栋名（Pinia 唯一状态源：dashboardView.selectedBuildingId → buildings.name）──
export function currentBuildingName(store) {
  const bv = store.dashboardView || {}
  const bid = bv.selectedBuildingId
  const b = (store.buildings || []).find((x) => x && x.id === bid)
  return b ? b.name : null
}

// ── 解析 GLB 节点名 → { floor, floorId, zone, kind }
// 命名规则（来自真实平面图生成的模型）：
//   Floor_N_Slab / Floor_N_Corridor       → 楼板 / 走廊
//   F{N}_{A区|B区|C区|D区}_{Zone|WallV}   → 区域 / 隔墙
//   F{N}_Stair_k                          → 楼梯
//   F{N}_EL_*                             → 应急灯
//   F{N}_Exit_k                           → 出口
//   F{N}_FloorMarker                      → 楼层标记
export function parseNodeName(name) {
  if (!name) return { floor: null, floorId: null, zone: null, kind: null }
  let m
  if ((m = name.match(/^Floor_(\d)_Slab$/)))      return { floor: +m[1], floorId: `${m[1]}F`, zone: null, kind: 'slab' }
  if ((m = name.match(/^Floor_(\d)_Corridor$/))) return { floor: +m[1], floorId: `${m[1]}F`, zone: null, kind: 'corridor' }
  if ((m = name.match(/^F(\d)_FloorMarker$/)))   return { floor: +m[1], floorId: `${m[1]}F`, zone: null, kind: 'floormarker' }
  if ((m = name.match(/^F(\d)_Stair_/)))         return { floor: +m[1], floorId: `${m[1]}F`, zone: null, kind: 'stair' }
  if ((m = name.match(/^F(\d)_EL_/)))            return { floor: +m[1], floorId: `${m[1]}F`, zone: null, kind: 'el' }
  if ((m = name.match(/^F(\d)_Exit_/)))          return { floor: +m[1], floorId: `${m[1]}F`, zone: null, kind: 'exit' }
  if ((m = name.match(/^F(\d)_(A区|B区|C区|D区)_/))) {
    const kindRaw = name.split('_').pop()
    const kind =
      kindRaw === 'Zone'  ? 'zone'  :
      kindRaw === 'WallV' ? 'wall'  :
      /Person/.test(name) ? 'person':
      'zone'
    return { floor: +m[1], floorId: `${m[1]}F`, zone: m[2], kind }
  }
  return { floor: null, floorId: null, zone: null, kind: null }
}

// 设备类型推断（按 GLB 节点名 → 业务设备类型）
export function parseDeviceType(name) {
  if (!name) return null
  if (/^F(\d)_EL_/i.test(name)) {
    if (/arrow|dir|sign/i.test(name)) return 'evacuation_light'
    return 'emergency_light'
  }
  return null
}

// 确定性伪随机（FNV-1a 变种）：人员稳定散布、相机抖动等
export function seededRand(str) {
  let h = 2166136261 >>> 0
  const s = String(str)
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  h ^= h >>> 13
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 16
  return (h >>> 0) / 4294967296
}

// 人员状态 → 颜色
export function personColor(status) {
  switch (status) {
    case 'warning':   return COLORS.personWarning
    case 'emergency':
    case 'stranded':  return COLORS.personStranded
    case 'located':   return COLORS.personLocated
    case 'static':    return COLORS.personStatic
    case 'normal':
    case 'moving':
    default:          return COLORS.personNormal
  }
}

// 记录材质基线，用于高亮后恢复
export function snapshotMaterial(mat) {
  if (!mat) return null
  return {
    color: mat.color ? mat.color.getHex() : 0xffffff,
    emissive: mat.emissive ? mat.emissive.getHex() : 0x000000,
    emissiveIntensity: mat.emissiveIntensity != null ? mat.emissiveIntensity : 1,
    opacity: mat.opacity != null ? mat.opacity : 1,
    transparent: !!mat.transparent,
    depthWrite: mat.depthWrite != null ? mat.depthWrite : true,
    hasEmissive: !!(mat.emissive && mat.emissive.isColor),
  }
}

// 把彩色箭头纹理画到 canvas（←/→ 绿）
export function makeArrowTexture(dir, color = '#39FF88', bgFill = null) {
  const size = 128
  const c = document.createElement('canvas')
  c.width = size
  c.height = size
  const ctx = c.getContext('2d')
  ctx.clearRect(0, 0, size, size)
  if (bgFill) {
    ctx.fillStyle = bgFill
    ctx.fillRect(0, 0, size, size)
  }
  ctx.strokeStyle = color
  ctx.fillStyle = color
  ctx.lineWidth = 14
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  const cx = size / 2, cy = size / 2
  if (dir === 'left') {
    ctx.beginPath()
    ctx.moveTo(cx + 26, cy - 30)
    ctx.lineTo(cx - 26, cy)
    ctx.lineTo(cx + 26, cy + 30)
    ctx.stroke()
  } else {
    ctx.beginPath()
    ctx.moveTo(cx - 26, cy - 30)
    ctx.lineTo(cx + 26, cy)
    ctx.lineTo(cx - 26, cy + 30)
    ctx.stroke()
  }
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.needsUpdate = true
  return tex
}

// 数字孪生人员简笔图标（CanvasTexture，用于 Sprite 头顶标签）
export function makePersonTexture(status) {
  const size = 96
  const c = document.createElement('canvas')
  c.width = size
  c.height = size
  const ctx = c.getContext('2d')
  ctx.clearRect(0, 0, size, size)
  const col = '#' + personColor(status).toString(16).padStart(6, '0')
  // 浅色底盘
  const grd = ctx.createRadialGradient(size/2, size/2, 6, size/2, size/2, size/2)
  grd.addColorStop(0, col + 'cc')
  grd.addColorStop(0.65, col + '33')
  grd.addColorStop(1, col + '00')
  ctx.fillStyle = grd
  ctx.fillRect(0, 0, size, size)
  // 头
  ctx.fillStyle = col
  ctx.beginPath()
  ctx.arc(size/2, size/2 - 10, 9, 0, Math.PI * 2)
  ctx.fill()
  // 身体
  ctx.beginPath()
  ctx.arc(size/2, size/2 + 16, 14, Math.PI, 0)
  ctx.lineTo(size/2 + 14, size/2 + 16)
  ctx.lineTo(size/2 + 10, size/2 + 38)
  ctx.lineTo(size/2 - 10, size/2 + 38)
  ctx.lineTo(size/2 - 14, size/2 + 16)
  ctx.closePath()
  ctx.fill()
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.needsUpdate = true
  return tex
}

// 路线流动贴图（不透明底 + 亮绿流动段，配合 MeshBasicMaterial 使用）
export function makeRouteFlowTexture(base = '#39FF88') {
  const w = 256, h = 32
  const c = document.createElement('canvas')
  c.width = w; c.height = h
  const ctx = c.getContext('2d')
  // 不透明深绿底
  ctx.fillStyle = '#0D7A3C'
  ctx.fillRect(0, 0, w, h)
  // 高亮流动段（三个循环）
  for (let i = 0; i < 3; i++) {
    const x = (i / 3) * w
    const grd = ctx.createLinearGradient(x, 0, x + w / 3, 0)
    grd.addColorStop(0,   'rgba(57,255,136,0)')
    grd.addColorStop(0.5, 'rgba(57,255,136,1)')
    grd.addColorStop(1,   'rgba(57,255,136,0)')
    ctx.fillStyle = grd
    ctx.fillRect(x, 0, w / 3, h)
  }
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.wrapS = THREE.RepeatWrapping
  tex.wrapT = THREE.ClampToEdgeWrapping
  tex.needsUpdate = true
  return tex
}
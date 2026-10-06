// EmergencyLight3D · 消防设备（疏散指示灯 + 应急照明灯）
// ────────────────────────────────────────────────
// 职责：
//   • 疏散指示灯（evacuation_light）：箭头恒绿 #39FF88；应急时脉冲
//   • 应急照明灯（emergency_light）：暖白 #F8F3E4 呼吸 + 强闪
//   • 设备位置永远不变（仅 emissive / opacity / glow）
//   • 设备编号不显示在 3D 中（仅右侧设备信息栏）
// ────────────────────────────────────────────────
import * as THREE from 'three'
import { COLORS, makeArrowTexture, seededRand, currentBuildingName } from './building3dUtils.js'
// P1.7.3-B3-03：设备楼栋归属只认 canonical（buildingId），别名 building 仅在 canonical 缺失时兜底
import { buildingIdOf, buildingNameOf } from '../../../shared/person/personRuntime.js'

export class EmergencyLight3D {
  constructor(threeScene, model) {
    this.ts = threeScene
    this.model = model
    this.evacGroup = new THREE.Group()
    this.evacGroup.name = 'evacLightGroup'
    threeScene.scene.add(this.evacGroup)
    this.emGroup = new THREE.Group()
    this.emGroup.name = 'emergencyLightGroup'
    threeScene.scene.add(this.emGroup)

    this.arrowTexL = makeArrowTexture('left')
    this.arrowTexR = makeArrowTexture('right')

    // 已绑定的 mesh/light 缓存（避免每帧重建）
    this.evacMap = new Map() // deviceId → { sprite, baseY, dir }
    this.emMap = new Map()   // deviceId → { light, baseIntensity, baseY }
  }

  // ── 从 store 同步：按统一楼层归属（buildingId，兼容旧 building 名）+ type 筛选 ──
  update(store) {
    if (!this.model.idx.entries.length) return
    const bldName = currentBuildingName(store)
    const bldId = (store.dashboardView || {}).selectedBuildingId
    // canonical 存在 → 只认 canonical；canonical 缺失 → 才允许旧别名兜底（与「是否选中楼栋」无关）
    const devs = (store.devices || []).filter((d) => {
      if (!d) return false
      const did = String(buildingIdOf(d) || '')
      if (did) return Boolean(bldId) && did === String(bldId)
      return Boolean(buildingNameOf(d)) && buildingNameOf(d) === bldName
    })
    if (!devs.length) {
      this.evacGroup.visible = false
      this.emGroup.visible = false
      return
    }

    const seen = new Set()
    devs.forEach((d) => {
      if (d.type === 'evacuation_light') this._bindEvac(d)
      else if (d.type === 'emergency_light') this._bindEm(d)
      seen.add(d.id)
    })

    // 清理未在 store 中的设备（仅在开发期，可能永远不发生）
    // 这里简单处理：不再创建新的就保留旧的，由 store 生命周期管理
  }

  // ── 设备定位：A区~D区 → 区域盒；走廊 → 走廊中心；楼梯N → 楼梯中心（均确定性散开） ──
  // canonical 楼层归属三元组：buildingId / floorId / zone（floor / area 只是派生别名）
  _resolveDevicePos(dev, jitterScale = 1) {
    const floorId = dev.floorId
    const zone = dev.zone
    const top = this.model.getFloorTopY(parseInt(floorId)) || 0
    let minX, maxX, minZ, maxZ
    const zk = this.model.getZoneBox(floorId, zone)
    if (zk) {
      minX = zk.box.min.x; maxX = zk.box.max.x
      minZ = zk.box.min.z; maxZ = zk.box.max.z
    } else if (zone === '走廊' && this.model.corridorCenter[floorId]) {
      const c = this.model.corridorCenter[floorId]
      const s = this.model.getSize()
      minX = c.x - s.x * 0.28; maxX = c.x + s.x * 0.28
      minZ = c.z - 0.8; maxZ = c.z + 0.8
    } else if (/楼梯/.test(zone || '') && this.model.stairCenters[floorId]) {
      const arr = this.model.stairCenters[floorId]
      // 楼梯1~4 按名称序号取，否则取第一档
      const m = (zone || '').match(/(\d+)/)
      const idx = m ? (parseInt(m[1]) - 1) % arr.length : 0
      const c = arr[idx] || arr[0]
      minX = c.x - 0.5; maxX = c.x + 0.5
      minZ = c.z - 0.5; maxZ = c.z + 0.5
    } else {
      return null
    }
    const r1 = seededRand(dev.id + 'x'), r2 = seededRand(dev.id + 'z')
    const x = minX + r1 * (maxX - minX) * jitterScale + (1 - jitterScale) * (minX + maxX) / 2
    const z = minZ + r2 * (maxZ - minZ) * jitterScale + (1 - jitterScale) * (minZ + maxZ) / 2
    return { x, z, top }
  }

  _bindEvac(dev) {
    let rec = this.evacMap.get(dev.id)
    if (rec) {
      const newDir = dev.direction || 'right'
      if (rec.dir !== newDir) {
        rec.sprite.material.map = newDir === 'left' ? this.arrowTexL : this.arrowTexR
        rec.sprite.material.needsUpdate = true
        rec.dir = newDir
      }
      rec.device = dev
      return
    }
    const pos = this._resolveDevicePos(dev, 0.6)
    if (!pos) return
    const dir = dev.direction || 'right'
    const spr = new THREE.Sprite(new THREE.SpriteMaterial({
      map: dir === 'left' ? this.arrowTexL : this.arrowTexR,
      color: 0xffffff,
      transparent: true,
      depthWrite: false,
    }))
    spr.scale.set(0.8, 0.8, 1)
    spr.position.set(pos.x, pos.top + 0.75, pos.z)
    this.evacGroup.add(spr)
    rec = { sprite: spr, dir, device: dev }
    this.evacMap.set(dev.id, rec)
  }

  _bindEm(dev) {
    let rec = this.emMap.get(dev.id)
    if (rec) { rec.device = dev; return }
    const pos = this._resolveDevicePos(dev, 0.5)
    if (!pos) return
    // 暖白球 + PointLight（呼吸）——位置永远不变
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.2, 10, 8),
      new THREE.MeshStandardMaterial({
        color: COLORS.emLight,
        emissive: COLORS.emLight,
        emissiveIntensity: 0.7,
        transparent: true, opacity: 0.95,
      })
    )
    mesh.position.set(pos.x, pos.top + 0.45, pos.z)
    this.emGroup.add(mesh)
    const light = new THREE.PointLight(COLORS.emLight, 0.9, 4.5, 2)
    light.position.set(pos.x, pos.top + 0.55, pos.z)
    this.emGroup.add(light)
    rec = { mesh, light, device: dev }
    this.emMap.set(dev.id, rec)
  }

  // ── 每帧：脉冲 / 强闪（仅 emissive 与 opacity，position 不变） ──
  tick(t, store) {
    const emergency = !!store.emergencyMode

    this.evacMap.forEach((rec) => {
      // 应急时绿色强闪 + glow；正常时绿箭头恒亮
      if (emergency) {
        const pulse = 0.4 + 0.6 * Math.abs(Math.sin(t * 4))
        rec.sprite.material.opacity = 0.55 + 0.45 * pulse
      } else {
        rec.sprite.material.opacity = 0.9
      }
    })

    this.emMap.forEach((rec) => {
      // 暖白呼吸 + 应急时强闪
      const breath = 0.5 + 0.4 * Math.abs(Math.sin(t * 1.6))
      if (emergency) {
        const flash = 1.2 + 1.6 * Math.abs(Math.sin(t * 6))
        rec.mesh.material.emissiveIntensity = flash
        rec.light.intensity = 1.2 + flash * 0.8
        rec.mesh.material.opacity = 0.85 + 0.15 * Math.abs(Math.sin(t * 6))
      } else {
        rec.mesh.material.emissiveIntensity = 0.5 + breath * 0.5
        rec.light.intensity = 0.7 + breath * 0.5
        rec.mesh.material.opacity = 0.9
      }
    })
  }
}
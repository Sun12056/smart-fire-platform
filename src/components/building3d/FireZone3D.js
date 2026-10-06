// FireZone3D · 火灾区域可视化（半透明红面 + 红边 + PointLight + 脉冲）
// ────────────────────────────────────────────────
// 职责：
//   • 读 store.fireEvent，匹配当前楼栋
//   • 在火区中心放半透明红面 + RingGeometry + ConeGeometry 火焰 + PointLight
//   • 脉冲只改 opacity / scale / emissiveIntensity
//   • 不让整栋建筑闪烁
// ────────────────────────────────────────────────
import * as THREE from 'three'
import { COLORS, currentBuildingName } from './building3dUtils.js'
// P1.7.3-B3-03：火灾楼栋归属只认 canonical（buildingId），别名 building 仅在 canonical 缺失时兜底
import { buildingIdOf, buildingNameOf, floorIdOf, zoneOf } from '../../../shared/person/personRuntime.js'

export class FireZone3D {
  constructor(threeScene, model, cameraDirector) {
    this.ts = threeScene
    this.model = model
    this.camera = cameraDirector

    this.group = new THREE.Group()
    this.group.name = 'fireGroup'
    this.group.visible = false
    threeScene.scene.add(this.group)

    // ── 火焰锥（ConeGeometry）──
    this.flame = new THREE.Mesh(
      new THREE.ConeGeometry(0.45, 1.4, 18),
      new THREE.MeshStandardMaterial({
        color: COLORS.fire, emissive: COLORS.fire, emissiveIntensity: 1.0,
        roughness: 0.4, transparent: true, opacity: 0.85,
      })
    )
    this.flame.position.y = 0.85
    this.group.add(this.flame)

    // ── 红色光晕球 ──
    this.glow = new THREE.Mesh(
      new THREE.SphereGeometry(0.4, 12, 10),
      new THREE.MeshStandardMaterial({
        color: 0xffb199, emissive: 0xff7a45, emissiveIntensity: 1.3,
        transparent: true, opacity: 0.75,
      })
    )
    this.glow.position.y = 0.7
    this.group.add(this.glow)

    // ── 地面红色危险区（半透明 + 红边） ──
    this.zoneMat = new THREE.MeshStandardMaterial({
      color: COLORS.fire, emissive: COLORS.fire, emissiveIntensity: 0.45,
      transparent: true, opacity: 0.35, depthWrite: false, side: THREE.DoubleSide,
    })
    this.zoneMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.zoneMat)
    this.zoneMesh.rotation.x = -Math.PI / 2
    this.zoneMesh.position.y = 0.05
    this.group.add(this.zoneMesh)

    // ── 火区边缘描边 ──
    this.ring = new THREE.Mesh(
      new THREE.RingGeometry(0.5, 0.8, 36),
      new THREE.MeshBasicMaterial({
        color: COLORS.fireEdge, transparent: true, opacity: 0.8,
        side: THREE.DoubleSide, depthWrite: false,
      })
    )
    this.ring.rotation.x = -Math.PI / 2
    this.ring.position.y = 0.12
    this.group.add(this.ring)

    // ── 火光 PointLight（弱） ──
    this.light = new THREE.PointLight(COLORS.fire, 1.6, 6, 2)
    this.light.position.y = 1.5
    this.group.add(this.light)

    this.activeFloorId = null
    this.activeZone = null
  }

  update(store) {
    const fe = store.fireEvent
    // canonical 优先：buildingId 与当前查看楼栋比；别名（中文楼栋名）仅在 buildingId 缺失时兜底
    const bldId = String((store.dashboardView || {}).selectedBuildingId || '')
    const bldName = currentBuildingName(store)
    // canonical 存在 → 只认 canonical；canonical 缺失 → 才允许旧别名兜底（与「是否选中楼栋」无关）
    const feBid = String(buildingIdOf(fe || {}) || '')
    const feName = buildingNameOf(fe || {})
    const match = Boolean(fe) && (
      feBid ? (Boolean(bldId) && feBid === String(bldId))
        : (Boolean(feName) && Boolean(bldName) && feName === bldName)
    )
    if (!match) {
      this.group.visible = false
      this.activeFloorId = null
      this.activeZone = null
      return
    }
    // P1.7.3-B3-03：火源楼层 / 区域同样只读 canonical（floorId / zone）
    const fireFloorId = floorIdOf(fe)
    const fireZone = zoneOf(fe)
    const zk = this.model.getZoneBox(fireFloorId, fireZone)
    if (!zk) {
      this.group.visible = false
      return
    }
    this.activeFloorId = fireFloorId
    this.activeZone = fireZone
    this.group.visible = true
    const top = this.model.getFloorTopY(parseInt(fireFloorId)) || 0
    this.group.position.set(zk.center.x, top + 0.1, zk.center.z)

    // 区域贴片尺寸
    const w = zk.box.max.x - zk.box.min.x
    const d = zk.box.max.z - zk.box.min.z
    if (Math.abs(w) > 0.1 && Math.abs(d) > 0.1) {
      this.zoneMesh.scale.set(w * 0.95, d * 0.95, 1)
      this.ring.scale.set(Math.max(w, d) * 0.55, Math.max(w, d) * 0.55, 1)
    }

    // 高亮火区墙体
    this.model.applyFireHighlight(fe)

    // 相机自动聚焦火灾
    this.camera.focusFire(fe, false)
  }

  tick(t) {
    if (!this.group.visible) return
    const pulse = 0.6 + 0.4 * Math.abs(Math.sin(t * 3))
    this.flame.material.emissiveIntensity = 0.8 + 0.6 * Math.sin(t * 6)
    this.glow.material.opacity = 0.45 + 0.4 * Math.abs(Math.sin(t * 4))
    this.ring.scale.multiplyScalar(1)
    this.ring.material.opacity = 0.2 + 0.6 * Math.abs(Math.sin(t * 3))
    this.light.intensity = 1.2 + 0.8 * Math.abs(Math.sin(t * 5))
    this.zoneMat.emissiveIntensity = 0.35 + 0.35 * pulse
  }
}
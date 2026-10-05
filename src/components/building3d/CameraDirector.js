// CameraDirector · GSAP 驱动的相机平滑切换
// ────────────────────────────────────────────────
// 关键：禁止写死 camera.position！
//   • 根据 GLB BoundingBox → 包围球半径 → 自动计算相机距离
//   • 默认视角：斜 45° 数字孪生等轴视角（azimuth 45°, elevation 35°）
//   • focusFloor / focusZone / focusFire 平滑 GSAP 过渡
// ────────────────────────────────────────────────
import * as THREE from 'three'
import gsap from 'gsap'

export class CameraDirector {
  constructor(threeScene, model) {
    this.ts = threeScene
    this.model = model || null
    this.camera = threeScene.camera
    this.controls = threeScene.controls
  }

  // 根据目标点和包围球半径，计算标准 45° 视角相机位置
  //   azimuth: 水平方位角（弧度），elevation: 仰角（弧度）
  //   最小飞行距离：模型最大维度的 0.8 倍 —— 保证相机绝不在建筑内部
  _isoPosition(target, radius, azimuthDeg = 45, elevationDeg = 35, distScale = 1.0) {
    const fov = (this.camera.fov * Math.PI) / 180
    let dist = (radius / Math.sin(fov / 2)) * distScale
    const maxDim = this.model ? Math.max(this.model.getSize().x, this.model.getSize().y, this.model.getSize().z) : 20
    dist = Math.max(dist, maxDim * 0.8)
    const az = (azimuthDeg * Math.PI) / 180
    const el = (elevationDeg * Math.PI) / 180
    return new THREE.Vector3(
      target.x + dist * Math.cos(el) * Math.sin(az),
      target.y + dist * Math.sin(el),
      target.z + dist * Math.cos(el) * Math.cos(az)
    )
  }

  // 目标对象的包围球半径（用于自动取景）
  _radiusAround(target, fallbackRadius) {
    return fallbackRadius
  }

  _flyTo(targetPos, camPos, duration = 0.9) {
    gsap.killTweensOf(this.camera.position)
    gsap.killTweensOf(this.controls.target)
    gsap.to(this.camera.position, {
      x: camPos.x, y: camPos.y, z: camPos.z,
      duration, ease: 'power2.inOut',
      onUpdate: () => this.controls.update(),
    })
    gsap.to(this.controls.target, {
      x: targetPos.x, y: targetPos.y, z: targetPos.z,
      duration, ease: 'power2.inOut',
    })
  }

  // ── 楼栋总览（六层完整可见，45° 等轴） ──
  focusBuilding(immediate = false) {
    if (!this.model) return
    const c = this.model.getCenter().clone()
    const s = this.model.getSize().clone()
    const radius = Math.max(s.x, s.y, s.z) * 0.62
    const target = c
    const camPos = this._isoPosition(target, radius, 45, 32, 1.05)
    if (immediate) {
      this.controls.target.copy(target)
      this.camera.position.copy(camPos)
      this.controls.update()
    } else this._flyTo(target, camPos, 1.0)
  }

  // ── 聚焦楼层（相机距离按该层半径自动算） ──
  focusFloor(floorId, immediate = false) {
    if (!this.model || !floorId) return this.focusBuilding(immediate)
    const n = parseInt(floorId)
    const cy = this.model.getFloorCenterY(n)
    if (cy == null) return this.focusBuilding(immediate)
    const c = this.model.getCenter()
    const s = this.model.getSize()
    // 单层的包围球半径：取水平对角线的一半（该层约占模型高度 1/6）
    const floorH = s.y / 6
    const radius = Math.max(Math.hypot(s.x, s.z) / 2, floorH * 1.2)
    const target = new THREE.Vector3(c.x, cy, c.z)
    const camPos = this._isoPosition(target, radius, 45, 30, 0.85)
    if (immediate) {
      this.controls.target.copy(target)
      this.camera.position.copy(camPos)
      this.controls.update()
    } else this._flyTo(target, camPos, 0.8)
  }

  // ── 聚焦区域 ──
  focusZone(floorId, zone) {
    if (!this.model) return
    const z = this.model.getZoneBox(floorId, zone)
    if (!z) return this.focusFloor(floorId)
    const cy = this.model.getFloorCenterY(parseInt(floorId)) ?? 0
    const s = z.box.getSize(new THREE.Vector3())
    const radius = Math.max(Math.hypot(s.x, s.z) / 2, 2.2)
    const target = new THREE.Vector3(z.center.x, cy, z.center.z)
    const camPos = this._isoPosition(target, radius, 45, 32, 0.75)
    this._flyTo(target, camPos, 0.8)
  }

  // ── 聚焦火灾 ──
  focusFire(fe, immediate = false) {
    if (!fe || !this.model) return
    const z = this.model.getZoneBox(fe.floorId, fe.zone)
    if (!z) return this.focusFloor(fe.floorId, immediate)
    const cy = this.model.getFloorCenterY(parseInt(fe.floorId)) ?? 0
    const s = z.box.getSize(new THREE.Vector3())
    const radius = Math.max(Math.hypot(s.x, s.z) / 2, 2.5)
    const target = new THREE.Vector3(z.center.x, cy, z.center.z)
    const camPos = this._isoPosition(target, radius, 45, 30, 0.7)
    if (immediate) {
      this.controls.target.copy(target)
      this.camera.position.copy(camPos)
      this.controls.update()
    } else this._flyTo(target, camPos, 1.0)
  }

  // ── 重置：默认 45° 斜视角 ──
  resetView() { this.focusBuilding(true) }
}
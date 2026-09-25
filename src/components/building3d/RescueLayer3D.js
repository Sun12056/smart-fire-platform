// RescueLayer3D · 协同救援可视化（阶段6）
// ────────────────────────────────────────────────
// 职责：
//   • store.rescueState 为 true 时显示
//   • 橙色 #FF9F43 救援路线（从 1F 安全出口 → 楼梯 → 火源楼层，复用疏散路网节点反向）
//   • 救援队伍（橙色小球）沿路线移动，到达火区后悬停脉冲
//   • 设备/位置规则与疏散一致：仅 opacity/emissive/位置沿路线推进
// ────────────────────────────────────────────────
import * as THREE from 'three'
import { COLORS } from './building3dUtils.js'

export class RescueLayer3D {
  constructor(threeScene, model) {
    this.ts = threeScene
    this.model = model
    this.group = new THREE.Group()
    this.group.name = 'rescueGroup'
    this.group.visible = false
    threeScene.scene.add(this.group)

    this.tube = null
    this.curve = null
    this.team = []        // 救援队员 mesh
    this.progress = 0
    this.active = false
  }

  update(store) {
    const shouldShow = !!store.rescueState && !!store.fireEvent && store.emergencyStage >= 6
    if (shouldShow && !this.active) this._build(store)
    if (!shouldShow && this.active) this._clear()
  }

  _build(store) {
    this.active = true
    const fe = store.fireEvent
    // 反向路线：从当前方案路线取点反转（出口 → 火源）
    const w = window.__dtwin
    const routeLayer = w && w.route
    let pts = []
    if (routeLayer && routeLayer._lastPoints && routeLayer._lastPoints.length) {
      pts = [...routeLayer._lastPoints].reverse()
    }
    if (pts.length < 2) {
      // 兜底：出口中心 → 火区中心 直连（极少发生；正常时都有方案路线）
      const zk = this.model.getZoneBox(fe.floor, fe.area)
      if (!zk) { this.active = false; return }
      const exits = this.model.getExits(1)
      const from = exits.length ? exits[0].center : new THREE.Vector3(0, 2, 0)
      const topY = this.model.getFloorTopY(parseInt(fe.floor)) || 0
      pts = [from.clone(), new THREE.Vector3(zk.center.x, topY + 0.3, zk.center.z)]
    }

    this.curve = new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.35)
    const tube = new THREE.TubeGeometry(this.curve, 80, 0.12, 10, false)
    const mat = new THREE.MeshBasicMaterial({
      color: COLORS.rescue,
      transparent: true,
      opacity: 0.85,
      depthTest: false,
      toneMapped: false,
    })
    this.tube = new THREE.Mesh(tube, mat)
    this.tube.renderOrder = 19
    this.group.add(this.tube)

    // 救援队（3 名橙色小球）
    for (let i = 0; i < 3; i++) {
      const m = new THREE.Mesh(
        new THREE.SphereGeometry(0.26, 12, 10),
        new THREE.MeshBasicMaterial({ color: COLORS.rescue, toneMapped: false })
      )
      m.renderOrder = 21
      this.group.add(m)
      this.team.push(m)
    }
    this.progress = 0
    this.group.visible = true
  }

  _clear() {
    this.active = false
    this.group.visible = false
    if (this.tube) {
      this.group.remove(this.tube)
      this.tube.geometry.dispose()
      this.tube.material.dispose()
      this.tube = null
    }
    this.team.forEach((m) => {
      this.group.remove(m)
      m.geometry.dispose()
      m.material.dispose()
    })
    this.team = []
    this.progress = 0
  }

  tick(t, dt) {
    if (!this.active || !this.curve) return
    // 队伍沿路线推进（5 → 火区）
    this.progress = Math.min(1, this.progress + dt * 0.12)
    this.team.forEach((m, i) => {
      const p = Math.max(0, Math.min(1, this.progress - i * 0.04))
      const pos = this.curve.getPointAt(p)
      m.position.copy(pos)
      // 到达后轻微呼吸（仅 emissive 不可用 → 用 scale 微脉冲，队伍非固定设备，允许）
      if (this.progress >= 1) {
        const s = 1 + 0.15 * Math.sin(t * 4 + i)
        m.scale.setScalar(s)
      }
    })
    if (this.tube) this.tube.material.opacity = 0.6 + 0.25 * Math.abs(Math.sin(t * 2))
  }
}
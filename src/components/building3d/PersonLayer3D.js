// PersonLayer3D · 3D 人员系统（InstancedMesh + Billboard Sprite）
// ────────────────────────────────────────────────
// 职责：
//   • 从 store.persons 读取，按 building 过滤
//   • InstancedMesh 复用几何与材质（性能）
//   • Sprite 头顶朝向相机（Billboard）
//   • 分散在 A/B/C/D 各区（基于 zone.box 范围）
//   • 阶段 ≥ 4 时按路线 progress 沿曲线移动
// ────────────────────────────────────────────────
import * as THREE from 'three'
import { COLORS, personColor, seededRand, parseNodeName, makePersonTexture, currentBuildingName } from './building3dUtils.js'

const MAX = 600

export class PersonLayer3D {
  constructor(threeScene, model) {
    this.ts = threeScene
    this.model = model
    this.group = new THREE.Group()
    this.group.name = 'personGroup'
    threeScene.scene.add(this.group)

    // ── InstancedMesh 主体（球体简化）──
    // MeshBasicMaterial + instanceColor：状态色不受灯光/色调映射影响，恒定鲜明
    const geo = new THREE.SphereGeometry(0.18, 10, 8)
    const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false })
    this.mesh = new THREE.InstancedMesh(geo, mat, MAX)
    this.mesh.count = 0
    this.mesh.frustumCulled = false
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    // 每实例颜色
    const colors = new Float32Array(MAX * 3)
    for (let i = 0; i < MAX; i++) {
      colors[i * 3 + 0] = 1; colors[i * 3 + 1] = 1; colors[i * 3 + 2] = 1
    }
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(colors, 3)
    this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage)
    this.group.add(this.mesh)

    // ── Sprite 头顶图标（可选：状态色装饰） ──
    this.spriteGroup = new THREE.Group()
    this.spriteGroup.name = 'personSpriteGroup'
    this.group.add(this.spriteGroup)
    this.sprites = [] // 每个 sprite 跟随一个 person

    // 状态映射：mesh.instance → sprite / data
    this.data = [] // { id, floor, zone, status, pos, target, routeProgress, routeId, curve }

    this._tmp = new THREE.Object3D()
    this._tmpCol = new THREE.Color()
    this._lastPersons = []
  }

  // ── 从 store 同步 ──
  update(store) {
    if (!this.model.idx.entries.length) return
    const bldName = currentBuildingName(store)
    const list = (store.persons || []).filter((p) => p && p.building === bldName)
    const N = Math.min(list.length, MAX)
    this.mesh.count = N
    this.data.length = N

    for (let i = 0; i < N; i++) {
      const p = list[i]
      const zoneKey = p.zone || p.area
      const zk = this.model.getZoneBox(p.floor, zoneKey)
      let x, y, z
      if (zk) {
        const r1 = seededRand(p.id + 'x')
        const r2 = seededRand(p.id + 'z')
        x = zk.box.min.x + r1 * (zk.box.max.x - zk.box.min.x)
        z = zk.box.min.z + r2 * (zk.box.max.z - zk.box.min.z)
        y = (this.model.getFloorTopY(parseInt(p.floor)) || 0) + 0.4 + seededRand(p.id + 'y') * 0.3
        this._tmp.position.set(x, y, z)
        this._tmp.scale.setScalar(1)
      } else {
        // 无区域信息（走廊等）：缩放为 0 隐藏，避免堆在原点
        this._tmp.position.set(0, -100, 0)
        this._tmp.scale.setScalar(0.0001)
      }
      this._tmp.updateMatrix()
      this.mesh.setMatrixAt(i, this._tmp.matrix)

      const col = personColor(p.status)
      this._tmpCol.setHex(col)
      this.mesh.setColorAt(i, this._tmpCol)

      this.data[i] = {
        ...(this.data[i] || {}),
        id: p.id, floor: p.floor, zone: zoneKey, status: p.status,
        x, y, z,
        target: this.data[i]?.target || null,
        routeProgress: this.data[i]?.routeProgress || 0,
      }
    }
    this.mesh.instanceMatrix.needsUpdate = true
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true
    this._lastPersons = list
  }

  // ── 阶段 ≥ 4：全员沿当前方案曲线疏散（错峰起步，不瞬移） ──
  startEvacuation(curves) {
    if (!curves || !curves.length) return
    this.data.forEach((d, i) => {
      if (!d || d.curves) return // 已在疏散中
      d.curves = curves
      d.routeProgress = -(seededRand(d.id + 'stagger') * 0.35) // 负值 = 还未出发（错峰）
      d.routeIdx = i % curves.length
    })
  }

  stopEvacuation() {
    this.data.forEach((d) => { if (d) { d.curves = null; d.routeProgress = 0 } })
  }

  // ── 每帧推进 ──
  tick(t, dt) {
    if (!this.data.length) return
    let dirty = false
    const v = this._v3 || (this._v3 = new THREE.Vector3())
    for (let i = 0; i < this.data.length; i++) {
      const d = this.data[i]
      if (!d || !d.curves || !d.curves.length) continue
      // 负 progress → 等待出发；线性增速（不同人速度微差）
      d.routeProgress += dt * (0.05 + 0.02 * seededRand(d.id + 'v'))
      const clamped = Math.max(0, Math.min(1, d.routeProgress))
      const curve = d.curves[d.routeIdx] || d.curves[0]
      curve.getPointAt(clamped, v)
      this._tmp.position.set(v.x, v.y, v.z)
      this._tmp.scale.setScalar(1)
      // 到达终点后隐藏（已安全疏散）
      if (d.routeProgress >= 1) this._tmp.scale.setScalar(0.0001)
      this._tmp.updateMatrix()
      this.mesh.setMatrixAt(i, this._tmp.matrix)
      dirty = true
    }
    if (dirty) this.mesh.instanceMatrix.needsUpdate = true
  }
}
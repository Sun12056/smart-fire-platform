// PersonLayer3D · 3D 人员系统（InstancedMesh）
// ────────────────────────────────────────────────
// 数据权威来源（不再由 3D 自己“编”位置）：
//   ① 后端 WebSocket 下发的 p.x / p.y（SVG 平面图坐标）+ p.route / p.routePoints / p.progress
//   ② mock 模式的运行时 p.x / p.y（store 沿合法路线推进）
//   ③ 兜底：无坐标人员才按 zone 盒子散点（理论上已不存在）
//
// 移动语义：
//   后端位置 = 权威；3D 只做视觉插值（lerp），绝不自己算速度/路线
//   人员沿 routePoints 折线移动 → 会转弯、经楼梯、跨层连续下降（不会瞬移、不会穿墙）
// ────────────────────────────────────────────────
import * as THREE from 'three'
import { personColor, seededRand, currentBuildingName } from './building3dUtils.js'
import {
  polylineFromSvg, arcLengths, pointAtArc, svgToStand, PERSON_Y,
} from './coords.js'

const MAX = 600
/** 视觉插值系数（每 1/60 秒），越大越紧跟服务器 */
const LERP = 0.18
/** 视觉错峰上限（秒）—— 只影响 3D 起步观感，不改后端人员状态 */
const STAGGER_MAX = 2.2
/** 已疏散 / 滞留等状态 */
const FROZEN_STATUS = ['stranded', 'located', 'safe', 'rescued']

export class PersonLayer3D {
  constructor(threeScene, model) {
    this.ts = threeScene
    this.model = model
    this.group = new THREE.Group()
    this.group.name = 'personGroup'
    threeScene.scene.add(this.group)

    // ── InstancedMesh 主体（球体简化）──
    const geo = new THREE.SphereGeometry(0.18, 10, 8)
    const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false })
    this.mesh = new THREE.InstancedMesh(geo, mat, MAX)
    this.mesh.count = 0
    this.mesh.frustumCulled = false
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    const colors = new Float32Array(MAX * 3)
    for (let i = 0; i < MAX; i++) {
      colors[i * 3 + 0] = 1; colors[i * 3 + 1] = 1; colors[i * 3 + 2] = 1
    }
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(colors, 3)
    this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage)
    this.group.add(this.mesh)

    // 每个 instance 的运行态
    this.data = [] // { id, floorId, zone, status, routeKey, pts, acc, total, cur, elapsed, delay, hidden }
    this._tmp = new THREE.Object3D()
    this._tmpCol = new THREE.Color()
    this._v = new THREE.Vector3()
  }

  // ── 从 store 同步（成员 / 路线 / 颜色）──
  update(store) {
    if (!this.model.idx.entries.length) return
    const bldName = currentBuildingName(store)
    const list = (store.persons || []).filter((p) => p && (p.building === bldName || !bldName))
    const N = Math.min(list.length, MAX)
    this.mesh.count = N

    const prevById = new Map(this.data.map((d) => [d && String(d.id), d]))
    const next = []
    for (let i = 0; i < N; i++) {
      const p = list[i]
      const prev = prevById.get(String(p.id))
      const d = prev || {
        id: p.id,
        cur: null,
        elapsed: 0,
        delay: seededRand(p.id + 'stagger') * STAGGER_MAX,
      }
      d.floorId = p.floorId || p.floor
      d.zone = p.zone || p.area
      d.status = p.status
      const rt = this._resolveRoute(store, p)
      if (rt.key !== d.routeKey) {
        d.routeKey = rt.key
        d.pts = rt.pts
        d.acc = rt.acc
        d.total = rt.total
        d.arc = 0
        d.elapsed = 0
      }
      next.push(d)
      this.data[i] = d

      // 初始/复位：直接落位（不做从原点插值）
      const target = this._targetFor(d, p)
      if (!d.cur) {
        d.cur = target ? target.clone() : this._fallbackPos(d)
      }
      this._writeMatrix(i, d.cur, false)

      const col = personColor(p.status)
      this._tmpCol.setHex(col)
      this.mesh.setColorAt(i, this._tmpCol)
    }
    this.data = next
    this.mesh.instanceMatrix.needsUpdate = true
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true
  }

  /** 路线指纹（廉价比较用）：仅在后端路线 / 方案切换时才重建折线 */
  _routeKey(p, store) {
    if (Array.isArray(p.routePoints) && p.routePoints.length > 1) {
      return `backend:${(p.route || []).length}:${p.routePoints.length}:${(p.route || [])[0] || ''}`
    }
    if (p._evac && Array.isArray(p._evac.pts) && p._evac.pts.length > 1) {
      return `mock:${p._evac.pts.length}:${p._evac.pts[0].x}`
    }
    return `plan:${store.activeRoutePlanId || ''}:${(store.routePlans || []).length}`
  }

  /**
   * 路线来源（优先级即「权威性」顺序）：
   *   ① 后端 routePoints —— 已确认执行时后端下发的权威路线（demo / api 模式）
   *   ② mock 运行时 p._evac —— 本地演示沿合法路线推进的点列
   *   ③ store 方案（activeRoutePlanId）—— 未确认前的 A/B/C 预览，与 2D 平面图同源
   * 阶段 3 未确认 → 走 ③，点选 A/B/C 时 3D 立即换线预览；
   * 阶段 4 执行中 → 走 ①，后端位置权威，避免与服务器状态脱节。
   */
  _resolveRoute(store, p) {
    // ① 后端权威路线（demo / api 模式：WebSocket 下发）
    if (Array.isArray(p.routePoints) && p.routePoints.length > 1) {
      const pts = polylineFromSvg(this.model, p.routePoints, p.route || [], PERSON_Y)
      if (pts.length > 1) return this._pack(pts, `backend:${p.route ? p.route.length : 0}:${pts.length}`)
    }
    // ② mock 运行时路线（store 沿合法路线推进的点列，同层）
    if (p._evac && Array.isArray(p._evac.pts) && p._evac.pts.length > 1) {
      const pts = polylineFromSvg(
        this.model,
        p._evac.pts.map((q) => ({ x: q.x, y: q.y, floorId: p.floorId || p.floor })),
        [],
        PERSON_Y,
      )
      if (pts.length > 1) return this._pack(pts, `mock:${p._evac.pts.length}:${p._evac.pts[0].x}`)
    }
    // ③ store 方案（activeRoutePlanId 优先；与 2D 平面图、RouteLayer3D 完全同源）
    const plans = store.routePlans || []
    const m = store.routeMatrix
    const zone = p.zone || p.area
    const info = m && m.perZone ? m.perZone[zone] : null
    const plan = (info && info.plans ? info.plans : [])
      .find((pp) => pp && pp.id === store.activeRoutePlanId)
      || (info && info.plans ? info.plans : []).find((pp) => pp && pp.id === info.recommendedId)
      || (info && info.plans ? info.plans[0] : null)
      || plans.find((pp) => pp && pp.id === store.activeRoutePlanId)
    if (plan && Array.isArray(plan.path) && plan.path.length > 1) {
      const pts = polylineFromSvg(this.model, plan.path, plan.path.map((n) => n.id), PERSON_Y)
      if (pts.length > 1) return this._pack(pts, `plan:${plan.id}`)
    }
    return { key: 'none', pts: [], acc: [], total: 0 }
  }

  _pack(pts, key) {
    const acc = arcLengths(pts)
    return { key, pts, acc, total: acc[acc.length - 1] || 0 }
  }

  /** 权威弧长：后端 progress（demo/api）或 mock 的路线进度 */
  _authArc(d, p) {
    if (!d.total) return 0
    if (typeof p.progress === 'number') return Math.max(0, Math.min(1, p.progress)) * d.total
    if (p._evac && p._evac.pts && p._evac.pts.length > 1) {
      return Math.max(0, Math.min(1, p._evac.idx / (p._evac.pts.length - 1))) * d.total
    }
    return 0
  }

  /** 当前应由权威数据决定的目标点（沿折线，含跨层 Y） */
  _targetFor(d, p) {
    if (d.pts && d.pts.length > 1) {
      const arc = this._authArc(d, p)
      return pointAtArc(d.pts, d.acc, arc) || this._staticPos(p)
    }
    return this._staticPos(p)
  }

  /** 非疏散态：直接取权威平面坐标（后端 x/y） */
  _staticPos(p) {
    const v = svgToStand(this.model, p.x, p.y, p.floorId || p.floor, PERSON_Y)
    return v || this._fallbackPos({ zone: p.zone || p.area, floorId: p.floorId || p.floor, id: p.id })
  }

  /** 兜底：无坐标人员在所属区域盒内确定性散点（正常情况下不会走到这里） */
  _fallbackPos(d) {
    const zk = this.model.getZoneBox(d.floorId, d.zone)
    if (!zk) return new THREE.Vector3(0, -100, 0)
    const r1 = seededRand((d.id || '') + 'x')
    const r2 = seededRand((d.id || '') + 'z')
    const top = this.model.getFloorTopY(parseInt(String(d.floorId), 10)) || 0
    return new THREE.Vector3(
      zk.box.min.x + r1 * (zk.box.max.x - zk.box.min.x),
      top + PERSON_Y + seededRand((d.id || '') + 'y') * 0.3,
      zk.box.min.z + r2 * (zk.box.max.z - zk.box.min.z),
    )
  }

  _writeMatrix(i, pos, hidden) {
    this._tmp.position.copy(pos)
    this._tmp.scale.setScalar(hidden ? 0.0001 : 1)
    this._tmp.updateMatrix()
    this.mesh.setMatrixAt(i, this._tmp.matrix)
  }

  // ── 每帧推进：权威位置 → 视觉插值 ──
  tick(t, dt, store) {
    if (!this.data.length) return
    const map = new Map()
    if (store && Array.isArray(store.persons)) {
      store.persons.forEach((p) => { if (p) map.set(String(p.id), p) })
    }
    // 帧率无关插值
    const alpha = 1 - Math.pow(1 - LERP, Math.min(dt, 0.1) * 60)
    let dirty = false
    for (let i = 0; i < this.data.length; i++) {
      const d = this.data[i]
      if (!d) continue
      const p = map.get(String(d.id))
      if (p) {
        d.status = p.status
        // 路线变化（A/B/C 切换、后端重规划）→ 立即换线
        const key = this._routeKey(p, store)
        if (key !== d.routeKey) {
          const rt = this._resolveRoute(store, p)
          d.routeKey = rt.key || key
          d.pts = rt.pts
          d.acc = rt.acc
          d.total = rt.total
          d.arc = 0
          d.elapsed = 0
        }
      }
      const evacuating = !!p && (p.evacuating === true || p.status === 'evacuating' || (p._evac && !p._evacDone))
      const frozen = !!p && (FROZEN_STATUS.includes(p.status) || p._stranded || p.retained)
      const arrived = !!p && (p.status === 'safe' || p._evacDone === true)

      let target
      if (d.pts && d.pts.length > 1 && (evacuating || arrived)) {
        d.elapsed += dt
        if (arrived) {
          target = d.pts[d.pts.length - 1]
        } else if (frozen || d.elapsed < d.delay) {
          // 滞留人员 / 视觉错峰等待：停在原地，不跟随疏散路线离开
          target = pointAtArc(d.pts, d.acc, frozen ? this._authArc(d, p) : 0)
        } else {
          target = this._targetFor(d, p)
        }
      } else if (p) {
        target = this._staticPos(p)
      } else {
        target = d.cur
      }
      if (!target || !d.cur) continue

      if (!d.cur.equals(target)) {
        d.cur.lerp(target, alpha)
        dirty = true
      }
      this._writeMatrix(i, d.cur, arrived && d.cur.distanceTo(target) < 0.05)
    }
    if (dirty) this.mesh.instanceMatrix.needsUpdate = true
  }

  /** 阶段进入疏散：重置视觉时钟（错峰重新计时） */
  startEvacuation() {
    this.data.forEach((d) => { if (d) { d.elapsed = 0; d.arc = 0 } })
  }

  stopEvacuation() {
    this.data.forEach((d) => { if (d) { d.elapsed = 0; d.arc = 0 } })
  }
}

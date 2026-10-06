// PersonLayer3D · 3D 人员系统（InstancedMesh）
// ────────────────────────────────────────────────
// P1.6.1 人员数据链统一：
//   DemoRoom(PersonRuntime) → WebSocket snapshot → demoStore → fireStore（2D）→ 本层（3D）
//   统一字段：id / buildingId / floorId / zone / status / routeId / routePoints / progress / position
//
// 权威来源（3D 只消费，绝不生产）：
//   ① 后端下发的 routeId + routePoints + progress + position（demo / api 模式）
//   ② 整栋楼方案（activeBuildingPlanId → 该人员 floor+zone 的 route）—— 未确认前的 A/B/C 预览
//   ③ mock 模式 store 沿合法路线推进的 p._evac（本地模拟，同样不是 3D 生成）
//
// 禁止：3D 自行生成路线、速度或路径。
//   位置目标点 = 权威 progress 沿权威折线求得的弧长点；3D 只对该目标点做视觉插值（lerp）。
//   兜底：后端完全未提供坐标时才用 zone 盒内确定性散点（不是路线，也不是速度）。
// ────────────────────────────────────────────────
import * as THREE from 'three'
import { personColor, seededRand, currentBuildingName } from './building3dUtils.js'
// 人员统一契约（与后端 / 2D 同一套字段解析规则）
// P1.7.3-B3：楼栋 / 楼层 / 区域归属一律走 canonical helper（buildingIdOf / floorIdOf / zoneOf）
import {
  positionOf, BUILDING_NAME_TO_ID, buildingIdOf, floorIdOf, zoneOf,
} from '../../../shared/person/personRuntime.js'
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
    const bldId = (store.dashboardView || {}).selectedBuildingId
    // P1.7.3-B3：canonical buildingId 唯一权威（与后端 PersonRuntime 同一个 id 空间）；
    // 只有人员自身完全没有 canonical 时才允许按中文名兜底（别名与 canonical 冲突 → 以 canonical 为准）
    const wantBldId = bldId ? String(bldId) : (bldName ? BUILDING_NAME_TO_ID[bldName] || '' : '')
    const list = (store.persons || []).filter((p) => {
      if (!p) return false
      const bid = buildingIdOf(p)
      if (bid || wantBldId) return bid === wantBldId
      // 只有 p.buildingId 完全缺失时才按旧别名兜底（别名与 canonical 冲突 → 以 canonical 为准）
      return !p.buildingId && (p.building === bldName || !bldName)
    })
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
      // 统一字段（后端 / 2D / 3D 同一个 id、同一个 routeId）
      d.id = p.id
      // P1.7.3-B3：canonical 三元组（别名仅作兜底）
      d.buildingId = buildingIdOf(p)
      d.floorId = floorIdOf(p)
      d.zone = zoneOf(p)
      d.status = p.status
      d.routeId = p.routeId === undefined ? null : p.routeId
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

  /**
   * 路线指纹（廉价比较用）：仅在后端路线 / 方案切换时才重建折线。
   * 指纹一律携带「权威 routeId」（backend:<routeId>:<点数> / bp:<方案id>:<routeId>），
   * 便于校验 2D / 3D / 后端使用的是同一条路线。
   */
  /**
   * mock 本地疏散运行态 p._evac（P1.6.1）：
   *   mock 模式才有 —— p._evac 是 store 沿合法路线推进的本地模拟点列；
   *   demo / api 模式不存在该字段（路由/位置/进度一律来自后端 snapshot / tick），
   *   即使历史残留也必须忽略，否则 3D 会出现「本地模拟」与后端权威并存的第二套位置来源。
   */
  _mockRuntime(store, p) {
    if (store && store.demoMode) return null
    const ev = p._evac
    return ev && Array.isArray(ev.pts) && ev.pts.length > 1 ? ev : null
  }

  _routeKey(p, store) {
    if (Array.isArray(p.routePoints) && p.routePoints.length > 1) {
      return `backend:${p.routeId || 'none'}:${p.routePoints.length}`
    }
    const ev = this._mockRuntime(store, p)
    if (ev) return `mock:${ev.pts.length}:${ev.pts[0].x}`
    // 整栋楼方案（authoritative）：buildingPlanId + 该人员 floor+zone 的路线
    const bp = store.activeBuildingPlan
    if (bp) {
      const r = store.buildingRouteOfPerson
        ? store.buildingRouteOfPerson(bp, { floorId: floorIdOf(p), zone: zoneOf(p) })
        : null
      if (r) return `bp:${bp.id}:${r.routeId}`
    }
    return `none:${p.routeId || ''}`
  }

  /**
   * 路线来源（优先级即「权威性」顺序；3D 绝不自己算路线）：
   *   ① 后端 routePoints —— 已确认执行时后端下发的权威路线（demo / api 模式）
   *   ② mock 运行时 p._evac —— 本地演示沿合法路线推进的点列
   *   ③ 整栋楼方案（activeBuildingPlanId + 该人员 floor/zone 的 route）—— 未确认前的 A/B/C 预览，
   *      与 2D 平面图、RouteLayer3D 完全同源；不使用 routeMatrix.perZone（只读投影）
   * 阶段 3 未确认 → 走 ③，点选 A/B/C 时 3D 立即换线预览；
   * 阶段 4 执行中 → 走 ①，后端位置权威，避免与服务器状态脱节。
   */
  _resolveRoute(store, p) {
    // ① 后端权威路线（demo / api 模式：WebSocket 下发）
    if (Array.isArray(p.routePoints) && p.routePoints.length > 1) {
      const pts = polylineFromSvg(this.model, p.routePoints, p.route || [], PERSON_Y)
      if (pts.length > 1) return this._pack(pts, `backend:${p.routeId || 'none'}:${pts.length}`)
    }
    // ② mock 运行时路线（store 沿合法路线推进的点列，同层；demo / api 模式不存在）
    const ev = this._mockRuntime(store, p)
    if (ev) {
      const pts = polylineFromSvg(
        this.model,
        ev.pts.map((q) => ({ x: q.x, y: q.y, floorId: floorIdOf(p) })),
        [],
        PERSON_Y,
      )
      if (pts.length > 1) return this._pack(pts, `mock:${ev.pts.length}:${ev.pts[0].x}`)
    }
    // ③ 整栋楼方案（未确认前的 A/B/C 预览）：activeBuildingPlanId 唯一决定
    //    ⚠️ 不读 store.routeMatrix.perZone —— 它只是只读兼容投影，不能驱动 3D 人员路线
    const bp = store.activeBuildingPlan
    if (bp) {
      const route = store.buildingRouteOfPerson
        ? store.buildingRouteOfPerson(bp, { floorId: floorIdOf(p), zone: zoneOf(p) })
        : null
      if (route && Array.isArray(route.points) && route.points.length > 1) {
        const pts = polylineFromSvg(this.model, route.points, route.nodes || [], PERSON_Y)
        if (pts.length > 1) return this._pack(pts, `bp:${bp.id}:${route.routeId}`)
      }
      // 该人员所属区域没有路线（如走廊已归并）：回退到同层任意一条同方案路线做预览
      const fallback = (bp.routes || []).find((r) => r && r.floorId === floorIdOf(p))
      if (fallback && Array.isArray(fallback.points) && fallback.points.length > 1) {
        const pts = polylineFromSvg(this.model, fallback.points, fallback.nodes || [], PERSON_Y)
        if (pts.length > 1) return this._pack(pts, `bp:${bp.id}:${fallback.routeId}`)
      }
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

  /** 非疏散态：直接取权威平面坐标（统一字段 position，旧别名 x/y 由它派生） */
  _staticPos(p) {
    const pos = positionOf(p)
    // P1.7.3-B3：落层 / 落区读 canonical（floorId / zone）；_fallbackPos 机制本身保持不变
    if (!pos) {
      return this._fallbackPos({ zone: zoneOf(p), floorId: floorIdOf(p), id: p.id })
    }
    const v = svgToStand(this.model, pos.x, pos.y, floorIdOf(p), PERSON_Y)
    return v || this._fallbackPos({ zone: zoneOf(p), floorId: floorIdOf(p), id: p.id })
  }

  /**
   * 兜底：后端/基线完全未提供坐标时才用「所属区域盒内确定性散点」。
   * ⚠️ 仅生成静止位置，绝不生成路线、速度或路径（正常情况下不会走到这里）。
   */
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
        d.routeId = p.routeId === undefined ? null : p.routeId
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

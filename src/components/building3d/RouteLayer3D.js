// RouteLayer3D · 疏散路线（A/B/C 方案切换 + CatmullRomCurve3 + TubeGeometry）
// ────────────────────────────────────────────────
// 职责：
//   • 当前方案 = store.activeBuildingPlan（P1.7.3-B4-01：直接权威，由 BuildingDigitalTwin watch 驱动）
//   • legacy store.activeRoutePlanId 仅作为「无整栋楼方案」时的单路线兼容分支，不是权威
//   • 路线基于 store 路网节点（房间出口→走廊→楼梯→安全出口），严禁直线穿墙
//   • SVG 平面图坐标 → GLB 世界坐标（BuildingModel.svgToWorld）
//   • CatmullRomCurve3 + TubeGeometry，绿色 #39FF88，流动贴图
//   • 只显示当前方案，切换方案 = 换 mesh 数据（不重建 Scene）
// ────────────────────────────────────────────────
import * as THREE from 'three'
import { COLORS, makeRouteFlowTexture } from './building3dUtils.js'
import { svgToStand, ROUTE_Y } from './coords.js'

export class RouteLayer3D {
  constructor(threeScene, model) {
    this.ts = threeScene
    this.model = model
    this.group = new THREE.Group()
    this.group.name = 'routeGroup'
    threeScene.scene.add(this.group)

    this.flowTex = makeRouteFlowTexture('#39FF88')
    this.flowTex.repeat.set(3, 1)
    this.currentPlanId = null
    this._tubes = []
    // 供人员层取用：当前方案的曲线集合
    this.activeCurves = []
  }

  // ── 方案切换：仅当方案 id 变化时重建 tube ──
  update(store) {
    // 整栋楼方案：一次绘制该方案下「全部区域」的路线（每个 floorId+zone 一条）
    const bp = store.activeBuildingPlan
    // 楼栋归属校验（3D 渲染层的最后一道边界保护）：
    // 方案所属楼栋 ≠ 当前查看楼栋 → 不渲染，并清空上一栋楼残留的路线。
    // 只做校验，不在这里管理楼栋方案状态（状态归 fireStore）。
    const curBuildingId = String((store.dashboardView || {}).selectedBuildingId || '')
    const planBuildingId = String(bp && bp.buildingId ? bp.buildingId : '')
    if (planBuildingId && curBuildingId && bp.buildingId !== curBuildingId) {
      this._clearRoutes()
      return
    }
    if (bp && Array.isArray(bp.routes) && bp.routes.length) {
      const activeId = `${bp.id}:${bp.routes.length}`
      if (activeId === this.currentPlanId && this.group.visible) return
      this.currentPlanId = activeId
      this._disposeTubes()
      this.group.visible = true
      this.activeCurves = []
      bp.routes.forEach((r) => {
        const pts = this._pointsOfNodes(r.nodes || [], r.points || [])
        if (pts.length >= 2) this._buildTube(pts)
      })
      return
    }
    const plans = store.routePlans || []
    if (!plans.length) {
      // 无方案（RESET / 新一轮开始前）：3D 不得继续自称持有旧方案
      this.currentPlanId = null
      if (this.group.visible) {
        this.group.visible = false
        this.activeCurves = []
      }
      return
    }
    const legacyId = store.activeRoutePlanId || plans[0].id
    if (legacyId === this.currentPlanId && this.group.visible) return
    this.currentPlanId = legacyId

    this._disposeTubes()
    const plan = plans.find((p) => p.id === legacyId)
    if (!plan) {
      this.group.visible = false
      this.activeCurves = []
      return
    }
    this.group.visible = true
    this.activeCurves = []

    const pts = this._planToPoints(plan)
    if (pts.length < 2) return
    this._buildTube(pts)
  }

  /** 节点序列（shared/evacuation 的 route.nodes/points）→ 世界坐标点列 */
  _pointsOfNodes(nodes, points) {
    const pts = []
    nodes.forEach((id, i) => {
      const pt = points[i]
      if (!pt || pt.x == null || pt.y == null) return
      const floorId = String(id).split(':')[0]
      const w = svgToStand(this.model, pt.x, pt.y, floorId, ROUTE_Y)
      if (w) pts.push(w)
    })
    return pts
  }

  _buildTube(pts) {
    this._lastPoints = pts // 供救援层反向使用（出口 → 火源）
    const curve = new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.35)
    const tube = new THREE.TubeGeometry(curve, Math.max(80, pts.length * 12), 0.16, 12, false)
    // MeshBasicMaterial：不受灯光/色调映射影响 → 恒定鲜明绿色；toneMapped=false 防 ACES 去饱和
    const mat = new THREE.MeshBasicMaterial({
      map: this.flowTex,
      transparent: true,
      opacity: 0.98,
      depthTest: false,   // X-ray：路线穿透墙体可见（指挥中心惯例）
      toneMapped: false,
    })
    const mesh = new THREE.Mesh(tube, mat)
    mesh.renderOrder = 20 // 最后绘制，确保覆盖建筑
    mesh.frustumCulled = false
    this.group.add(mesh)
    this._tubes.push(mesh)
    this.activeCurves.push(curve)
  }

  // ── 把 store 路线节点序列 → 世界坐标点列 ──
  // path 节点: { id, floorId, key, x, y, type }（x/y 是 SVG 560×300 平面图坐标）
  // 用 CatmullRomCurve3 平滑拐角，但节点本身严格沿路网 → 不穿墙
  _planToPoints(plan) {
    const pts = []
    const path = plan.path || []
    // 坐标转换唯一入口（与人员层同源）：SVG 平面图 → 世界坐标 + 楼层高度
    path.forEach((n) => {
      if (!n || n.x == null || n.y == null) return
      const w = svgToStand(this.model, n.x, n.y, n.floorId, ROUTE_Y)
      if (w) pts.push(w)
    })
    return pts
  }

  /** 清空已渲染的路线（跨楼栋 / 无方案时，避免残留上一栋楼的路线） */
  _clearRoutes() {
    this._disposeTubes()
    this.group.visible = false
    this.activeCurves = []
    this.currentPlanId = null
  }

  _disposeTubes() {
    this._tubes.forEach((m) => {
      this.group.remove(m)
      m.geometry.dispose()
      m.material.dispose()
    })
    this._tubes = []
  }

  tick(t) {
    if (this.flowTex) this.flowTex.offset.x = (t * 0.25) % 1
  }
}
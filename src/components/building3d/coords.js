// coords.js · 坐标唯一转换层
// ────────────────────────────────────────────────
// 平面图（2D）、路线算法（shared/evacuation）、3D（Three.js）共用同一套换算，
// 任何图层都不要自己写 svgX * k 之类的比例系数。
//
//   SVG 平面图坐标（viewBox 560 × 300，1m = 10px）
//          ↓ svgToWorld()
//   Three.js 世界坐标（X = 左右，Y = 高度，Z = 前后）
//
// 唯一实现在 BuildingModel.svgToWorld（按每层 GLB 包围盒线性映射），
// 本模块只做语义封装：楼层高度、人员/路线的离地高度。
// ────────────────────────────────────────────────
import * as THREE from 'three'

/** 平面图 viewBox（与 shared/evacuation、floorPlanData 完全一致） */
export const PLAN_W = 560
export const PLAN_H = 300
/** 1 米 = 10 px（平面图比例） */
export const PX_PER_M = 10

/** 人员站立高度（相对本层楼面） */
export const PERSON_Y = 0.45
/** 疏散路线悬浮高度（贴楼面之上，避免与楼板 z-fighting） */
export const ROUTE_Y = 0.32

/**
 * SVG 平面图坐标 → 世界坐标（X/Z）
 * @returns {THREE.Vector3|null} y 恒为 0（高度由 floorTopY 决定）
 */
export function svgToWorld(model, svgX, svgY, floorId) {
  if (!model || svgX == null || svgY == null) return null
  return model.svgToWorld(svgX, svgY, floorId)
}

/** 楼层号 → 该层楼面世界高度（'5F' → parseFloat → 5） */
export function floorTopY(model, floorId) {
  if (!model || floorId == null) return 0
  const n = parseInt(String(floorId), 10)
  if (Number.isNaN(n)) return 0
  return model.getFloorTopY(n) || 0
}

/**
 * SVG 平面图点 → 3D 站位（含楼层高度）
 * @param {number} lift 离楼面高度
 */
export function svgToStand(model, svgX, svgY, floorId, lift = PERSON_Y) {
  const w = svgToWorld(model, svgX, svgY, floorId)
  if (!w) return null
  return new THREE.Vector3(w.x, floorTopY(model, floorId) + lift, w.z)
}

/**
 * 路线节点序列 → 3D 折线（用于人员沿折线移动 / 楼层下降动画）
 * @param {{x:number,y:number,floorId?:string}[]} pts 平面图点列
 * @param {string[]} nodeIds 节点 id 序列（形如 '5F:STAIR_SE'，用于取楼层）
 */
export function polylineFromSvg(model, pts, nodeIds = [], lift = PERSON_Y) {
  const out = []
  const n = Math.min(pts.length, nodeIds.length || pts.length)
  for (let i = 0; i < n; i++) {
    const p = pts[i]
    const floorId = nodeIds[i] ? String(nodeIds[i]).split(':')[0] : p.floorId
    const v = svgToStand(model, p.x, p.y, floorId, lift)
    if (v) out.push(v)
  }
  return out
}

/** 折线累计长度表（[0, l1, l1+l2, ...]） */
export function arcLengths(points) {
  const acc = [0]
  for (let i = 1; i < points.length; i++) {
    acc.push(acc[i - 1] + points[i].distanceTo(points[i - 1]))
  }
  return acc
}

/** 按弧长取折线上的点（线性插值；跨楼层时 Y 连续下降 —— 不会瞬移） */
export function pointAtArc(points, acc, arc) {
  if (!points.length) return null
  if (points.length === 1) return points[0].clone()
  const total = acc[acc.length - 1]
  const a = Math.max(0, Math.min(arc, total))
  let i = 1
  while (i < acc.length - 1 && acc[i] < a) i++
  const segLen = acc[i] - acc[i - 1] || 1
  const k = (a - acc[i - 1]) / segLen
  return points[i - 1].clone().lerp(points[i], k)
}

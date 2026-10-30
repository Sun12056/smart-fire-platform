/**
 * 疏散指示灯方向裁决（P1.8.2）
 *
 * 背景（已验证缺陷）：
 *   旧实现 fireStore.applyRouteToDevices() 对整栋楼方案逐条路线调用，每次都把
 *   「路线途经楼层」的全部 evacuation_light 改写成 plan.exitSide —— 于是最终全场
 *   方向由**最后一条被遍历的路线**单方面决定，同一台灯还会产生 4 条互相矛盾的绑定。
 *
 * 本模块的最小修复原则：
 *   ① 方向取自**真实路线路径的局部走向**，不取整层统一的 exitSide；
 *   ② 裁决只看「设备 ↔ 路径」的几何关系，**与路线数组的遍历顺序无关**；
 *   ③ 每台设备**至多产出一条绑定**，天然唯一，不做「去重数组」式表面处理；
 *   ④ 路径局部走向为垂直（楼梯上下 / 楼梯口）时，当前 left/right 模型无法表达，
 *      一律判为**未定（direction = null）**，不得伪造方向、不得回退到位置启发式。
 *   ⑤ 同样贴近的路线要求**相反**方向时判为**冲突**，**不产出任何方向** ——
 *      不得用 routeId 字典序或人数权重把冲突压成一个"看似有效"的方向。
 *
 * ⚠️ 边界（本轮不解决，另立任务）：
 *   - 楼梯平台的「下行 / 上行」语义：需要新增方向枚举，本轮不扩展，相关灯具判为未定。
 *   - 「灯具 ↔ 拓扑节点 / 路径段」的显式归属契约：本模块用最近点距离近似，
 *     不是完整的逐段方向模型。
 */

/** 判定「水平走向」的最小位移（平面图坐标单位）。真实走廊段位移远大于此值。 */
export const DIRECTION_MIN_DX = 1

/**
 * 判定「等距」的浮点容差。仅用于吸收浮点误差，**不是**几何阈值：
 * 两条路线到同一台灯的距离差小于该值时视为同样贴近。
 */
export const DIRECTION_TIE_EPS = 1e-6

/**
 * 判定「设备落在这条边上」的垂距容差（P1.8.2 第二阶段）。
 *
 * 只有当我们能**确认**设备位于某条边上（垂距 ≈ 0 且投影落在段内）时，才据此判定；
 * 否则一律视为「关联不明确」，保持既有近似行为 —— 不做基于模糊阈值的猜测。
 */
export const CORNER_ON_EDGE_EPS = 1e-6

/**
 * 本轮路线裁决结果的状态词汇（P1.8.2 第一阶段）。
 *
 * ⚠️ 这是**前端/审计词汇**，不是设备协议字段：不写入设备、不改变 direction 取值域。
 * 引入它的目的是：不得再用设备旧有的 `direction` 字段反推「本轮路线是否已裁决」。
 */
export const DIRECTION_VERDICT = {
  /** 本轮路线已唯一裁决出方向 */
  RESOLVED: 'resolved',
  /** 同样贴近的多条路线要求**相反**方向 —— 不产出方向，等待人工/规则裁决 */
  CONFLICT: 'conflict',
  /** 最近处为垂直段（楼梯上下）等当前模型无法表达的情形 */
  UNDETERMINED: 'undetermined',
  /** 本轮没有任何路线为该设备提供可用路径几何（含手动路线无 path） */
  UNLINKED: 'unlinked',
  /** 方向由**本机覆盖**产生（管理员手动切换 / 避火自动反向），不是本轮路线裁决结果 */
  OVERRIDDEN: 'overridden',
  /** 根本没有参与过任何一轮路线裁决（UI 不得拿设备旧 direction 顶替） */
  NONE: 'none',
}

export const DIRECTION_VERDICT_LABELS = {
  [DIRECTION_VERDICT.RESOLVED]: '本轮路线已裁决',
  [DIRECTION_VERDICT.CONFLICT]: '本轮路线方向冲突，未裁决',
  [DIRECTION_VERDICT.UNDETERMINED]: '本轮路线未裁决（方向未知）',
  [DIRECTION_VERDICT.UNLINKED]: '未参与本轮路线联动',
  [DIRECTION_VERDICT.OVERRIDDEN]: '本机覆盖（非本轮路线裁决）',
  [DIRECTION_VERDICT.NONE]: '暂无本轮裁决',
}

export const DIRECTION_OVERRIDE_SOURCE_LABELS = {
  manual: '管理员手动切换，未下发设备',
  'fire-avoidance': '避火自动反向，非路线裁决',
}

/** 路线负载（人数）读取：仅作**诊断信息**，不得用于裁决方向。 */
function routeLoadOf(route) {
  if (!route) return null
  const v = route.weight ?? route.personCount ?? route.congestion
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** 两点间的水平位移；任一侧坐标缺失时返回 null（无法判定，而非当作 0） */
function dxBetween(a, b) {
  if (!a || !b) return null
  const ax = num(a.x)
  const bx = num(b.x)
  if (ax === null || bx === null) return null
  return bx - ax
}

/**
 * 点到线段的距离（投影参数 t 已夹在 [0,1]）。
 * @returns {{distance:number,t:number}} t=0 表示最近点落在 a 端，t=1 表示落在 b 端。
 */
function pointSegmentDistance(px, py, ax, ay, bx, by) {
  const vx = bx - ax
  const vy = by - ay
  const len2 = vx * vx + vy * vy
  let t = len2 === 0 ? 0 : ((px - ax) * vx + (py - ay) * vy) / len2
  if (t < 0) t = 0
  else if (t > 1) t = 1
  return { distance: Math.hypot(px - (ax + vx * t), py - (ay + vy * t)), t }
}

/**
 * 单台设备相对**一条**路线的局部走向。
 *
 * 取该路线上与设备**同层**且距离最近的路径点，用其前后邻点的水平位移
 * （中心差分）作为该处的行进方向。
 *
 * ★ P1.8.2 第二阶段改动（拐角 / 折返保守判定 + 几何关联距离）：
 *
 *   ① 关联距离 `distance` 改为**设备到路线折线的最小距离**（只计同层线段），
 *      不再是「到最近节点的距离」。原因：两条路线到同一节点的距离相等，并不代表
 *      它们同样贴近设备（实测 EL-5F-05：到 CORRIDOR_N 节点都是 65.49，
 *      但到 B区东向路线走廊段只有 8 ⇒ 之前的"冲突"是**几何归因错误**，不是真实冲突）。
 *   ② 节点的**中心差分**只在两条腿轴向一致时才可信。若入边垂直、出边水平，
 *      `next.x - prev.x` 的全部水平分量都来自**出边** —— 设备明明落在垂直入边上，
 *      却被赋予出边的 left/right（实测 EL-5F-03：落在 A_CENTER→CORRIDOR_N 竖段上，
 *      却被判 left）。此时保守返回 null。
 *   ③ 两条腿都水平但**方向相反**（折返点）时，该节点处不存在单一行进方向，保守返回 null。
 *   ④ 对称拐角：入边水平、出边垂直，且**确认**设备落在垂直出边（走廊→楼梯引入段）上时，
 *      同样保守返回 null（原因 `corner-vertical-out-edge`）—— 产品决策 Q1 = 规则乙：
 *      现有数据无法可靠区分走廊指示与楼梯指示时，不输出 left/right。
 *
 * @param {{id:string,x:number,y:number,floorId:string}} device 设备（floorId 用 canonical 值）
 * @param {{id:string,path:Array<{floorId:string,x:number,y:number}>}} route 路线（含逐节点几何）
 * @returns {{
 *   routeId:string, distance:number, nodeDistance:number, dx:number, dxCentered:number,
 *   direction:'left'|'right'|null, reason:string|null
 * }|null}
 *   direction === null 表示该处无法可靠判定（垂直段 / 拐角 / 折返）；`reason` 说明原因。
 */
export function routeDirectionAtDevice(device, route) {
  if (!device || !route || !Array.isArray(route.path)) return null
  const devX = num(device.x)
  const devY = num(device.y)
  const devFloor = device.floorId || ''
  if (devX === null || devY === null || !devFloor) return null

  const path = route.path
  let bestIdx = -1
  let bestDist = Infinity
  for (let i = 0; i < path.length; i += 1) {
    const p = path[i]
    // 只匹配同层节点：跨层节点的平面坐标可能重合，混用会误判
    if (!p || p.floorId !== devFloor) continue
    const px = num(p.x)
    const py = num(p.y)
    if (px === null || py === null) continue
    const dist = Math.hypot(px - devX, py - devY)
    if (dist < bestDist) {
      bestDist = dist
      bestIdx = i
    }
  }
  if (bestIdx < 0) return null

  // ① 设备到路线折线的关联距离（只计两端同层的线段）
  let assocDist = Infinity
  for (let i = 0; i < path.length - 1; i += 1) {
    const a = path[i]
    const b = path[i + 1]
    if (!a || !b || a.floorId !== devFloor || b.floorId !== devFloor) continue
    const ax = num(a.x)
    const ay = num(a.y)
    const bx = num(b.x)
    const by = num(b.y)
    if (ax === null || ay === null || bx === null || by === null) continue
    const d = pointSegmentDistance(devX, devY, ax, ay, bx, by).distance
    if (d < assocDist) assocDist = d
  }
  // 该层只有一个节点（如竖井层的楼梯节点）⇒ 无同层线段可投影，退回节点距离
  if (!Number.isFinite(assocDist)) assocDist = bestDist

  const cur = path[bestIdx]
  const prev = path[bestIdx - 1]
  const next = path[bestIdx + 1]
  let centered = 0
  if (prev && next) {
    const v = dxBetween(prev, next)
    if (v === null) return null
    centered = v
  } else if (next) {
    const v = dxBetween(cur, next)
    if (v === null) return null
    centered = v
  } else if (prev) {
    const v = dxBetween(prev, cur)
    if (v === null) return null
    centered = v
  }
  // 单点路径：无走向可言

  // ② 拐角 / 折返保守判定
  const reason = cornerOrReversalReason(devX, devY, cur, prev, next)
  // 被判为不可靠时，dx 归零（该处不存在可表达的水平走向），原始中心差分保留在 dxCentered 供审计
  const dx = reason ? 0 : centered
  const direction = reason ? null : Math.abs(centered) < DIRECTION_MIN_DX ? null : centered < 0 ? 'left' : 'right'

  return {
    routeId: route.id,
    distance: assocDist,
    nodeDistance: bestDist,
    dx,
    dxCentered: centered,
    direction,
    reason: reason || (direction ? null : 'no-horizontal-movement'),
  }
}

/**
 * 拐角 / 折返判定：最近节点处的中心差分是否可信。
 *
 * 判定必须满足「**确认**设备落在那条垂直边上」（垂距 ≈ 0 且投影落在段内）才降级，
 * 不做基于模糊阈值的猜测；否则保持既有行为。
 *
 * @returns {'corner-vertical-in-edge'|'corner-vertical-out-edge'|'direction-reversal-at-node'|null}
 *   非 null 表示此处方向不可靠，调用方**不得**产出 left/right。
 */
function cornerOrReversalReason(devX, devY, cur, prev, next) {
  if (!cur || !prev || !next) return null
  const dxIn = dxBetween(prev, cur)
  const dxOut = dxBetween(cur, next)
  if (dxIn === null || dxOut === null) return null

  const inHorizontal = Math.abs(dxIn) >= DIRECTION_MIN_DX
  const outHorizontal = Math.abs(dxOut) >= DIRECTION_MIN_DX

  // ③ 折返点：两条腿都水平但方向相反 ⇒ 该节点处不存在单一行进方向
  if (inHorizontal && outHorizontal && dxIn > 0 !== dxOut > 0) {
    return 'direction-reversal-at-node'
  }
  // ② 拐角：入边垂直、出边水平，且**确认**设备落在垂直入边上
  //    ⇒ 设备处的行进方向是垂直的，left/right 无法表达，禁止用出边方向冒充
  if (!inHorizontal && outHorizontal) {
    const on = pointSegmentDistance(devX, devY, prev.x, prev.y, cur.x, cur.y)
    if (on.distance <= CORNER_ON_EDGE_EPS) return 'corner-vertical-in-edge'
  }
  // ④ 对称拐角（★ P1.8.2 收尾，产品决策 Q1 = 规则乙）：
  //    入边水平、出边垂直，且**确认**设备落在通往楼梯的垂直出边上。
  //    此时中心差分的水平分量**全部来自入边**（即设备身后那段走廊），而设备实际
  //    已位于走廊端头→楼梯的竖向引入段上。现有数据无法可靠区分「走廊指示」与
  //    「楼梯指示」（设备无安装/朝向/指示类型字段，也不引用节点），
  //    因此按规则乙保守返回未定，**不得**用入边的 left/right 冒充设备处的方向。
  if (inHorizontal && !outHorizontal) {
    const on = pointSegmentDistance(devX, devY, cur.x, cur.y, next.x, next.y)
    if (on.distance <= CORNER_ON_EDGE_EPS) return 'corner-vertical-out-edge'
  }
  return null
}

/**
 * 多台设备 × 多条路线的方向裁决。
 *
 * 裁决链（**顺序无关**，只看数据本身）：
 *   ① 收集每条路线对该设备的候选（同层最近点 + 中心差分）；
 *   ② 取**距离最小**的一组候选（容差 DIRECTION_TIE_EPS，仅吸收浮点误差）；
 *   ③ 该组内的**非空方向若不一致 ⇒ 冲突**：**不产出绑定**，记入 conflicts
 *      —— 绝不用 routeId 字典序或人数权重把冲突压成一个"看似有效"的方向；
 *   ④ 该组内没有非空方向 ⇒ 未定（垂直段），记入 undetermined，不产出绑定；
 *   ⑤ 该组内方向唯一 ⇒ 产出绑定。
 *
 * ⚠️ routeId 字典序**只**用于 ② 之后的稳定排序（保证正序/逆序输出一致），
 *    不得用它决定冲突设备的方向。
 * ⚠️ route.weight / personCount / congestion **只**进入 candidates 作诊断信息，
 *    不得用于方向裁决。
 *
 * @param {Array<{id:string,x:number,y:number,floorId:string}>} devices
 * @param {Array<{id:string,path:Array,weight?:number}>} routes
 * @returns {{
 *   bindings: Array<{routeId:string,deviceId:string,direction:string,distance:number,dx:number}>,
 *   undetermined: Array<{deviceId:string,routeId:string,distance:number,dx:number}>,
 *   conflicts: Array<{deviceId:string,distance:number,reason:string,
 *     candidates:Array<{routeId:string,direction:string|null,distance:number,dx:number,load:number|null}>}>,
 *   unlinked: Array<{deviceId:string,reason:string}>,
 *   noPathRoutes: Array<string>
 * }}
 *   bindings 中 deviceId 唯一（每台设备至多一条）；
 *   未产出绑定的设备必出现在 undetermined / conflicts / unlinked 之一，可审计、不静默。
 */
export function resolveDeviceDirections(devices, routes = []) {
  const bindings = []
  const undetermined = []
  const conflicts = []
  const unlinked = []
  const list = Array.isArray(devices) ? devices : []
  const routeList = Array.isArray(routes) ? routes.filter(Boolean) : []

  // 缺几何的路线（典型：手动路线无 path）：无法参与裁决，单独记录而非静默跳过
  const noPathRoutes = []
  routeList.forEach((route) => {
    if (!Array.isArray(route.path) || route.path.length === 0) {
      noPathRoutes.push(route.id === undefined ? null : route.id)
    }
  })

  list.forEach((device) => {
    if (!device || !device.id) return
    const candidates = []
    routeList.forEach((route) => {
      const cand = routeDirectionAtDevice(device, route)
      if (!cand) return
      candidates.push({ ...cand, load: routeLoadOf(route) })
    })

    if (!candidates.length) {
      unlinked.push({
        deviceId: device.id,
        reason: noPathRoutes.length ? 'no-path-route' : 'no-candidate',
      })
      return
    }

    const minDistance = Math.min(...candidates.map((c) => c.distance))
    // 稳定排序：字典序仅用于让「最近组」的顺序与 routes 遍历顺序无关
    const nearest = candidates
      .filter((c) => c.distance <= minDistance + DIRECTION_TIE_EPS)
      .sort((a, b) => {
        const ka = String(a.routeId)
        const kb = String(b.routeId)
        return ka < kb ? -1 : ka > kb ? 1 : 0
      })
    const distinct = [...new Set(nearest.map((c) => c.direction).filter(Boolean))]

    // ③ 同样贴近的路线要求相反方向 ⇒ 冲突，不产出方向
    if (distinct.length > 1) {
      conflicts.push({
        deviceId: device.id,
        distance: minDistance,
        reason: 'opposite-directions-at-same-proximity',
        candidates: nearest.map((c) => ({
          routeId: c.routeId,
          direction: c.direction,
          distance: c.distance,
          nodeDistance: c.nodeDistance,
          dx: c.dx,
          dxCentered: c.dxCentered,
          reason: c.reason,
          load: c.load,
        })),
      })
      return
    }
    // ④ 最近处无水平走向 ⇒ 未定
    if (distinct.length === 0) {
      const first = nearest[0]
      undetermined.push({
        deviceId: device.id,
        routeId: first.routeId,
        distance: first.distance,
        nodeDistance: first.nodeDistance,
        dx: first.dx,
        dxCentered: first.dxCentered,
        reason: first.reason || 'no-horizontal-movement',
      })
      return
    }
    // ⑤ 方向唯一 ⇒ 绑定
    const chosen = nearest.find((c) => c.direction === distinct[0])
    bindings.push({
      routeId: chosen.routeId,
      deviceId: device.id,
      direction: distinct[0],
      distance: chosen.distance,
      dx: chosen.dx,
    })
  })

  return { bindings, undetermined, conflicts, unlinked, noPathRoutes }
}

/**
 * ★ UI 方向显示判定（P1.8.2 第二阶段 问题 A）——**纯函数，可独立单测**。
 *
 * 解决的问题：设备对象里始终保留着上一次写入的 `direction` 值。当本轮没有可靠裁决时
 * （未裁决 / 冲突 / 未联动 / 从未裁决），界面不能拿这个历史值当作当前有效疏散方向。
 *
 * 设计原则：**不删除任何历史字段**（保留兼容性与状态记录），只区分
 * 「存储中保留了方向值」与「当前路线已可靠裁决方向」。
 *
 * @param {{state?:string,direction?:string,overrideSource?:string}|null|undefined} verdict
 *        本轮裁决结果（getRouteDirectionVerdict 的返回值）；null / 无条目 = 从未裁决。
 * @param {string|null|undefined} storedDirection 设备上当前保留的 `direction` 值（历史值）。
 * @returns {{
 *   state:string, direction:string|null, storedDirection:string|null,
 *   isValidRouteGuidance:boolean, isManualOverride:boolean,
 *   showArrow:boolean, stale:boolean, hasStoredButUnverified:boolean
 * }}
 */
export function resolveDirectionDisplay(verdict, storedDirection) {
  const state = verdict && verdict.state ? verdict.state : DIRECTION_VERDICT.NONE
  const isResolved = state === DIRECTION_VERDICT.RESOLVED
  const isOverride = state === DIRECTION_VERDICT.OVERRIDDEN
  // 只有「本轮路线已裁决」或「本机覆盖」才给出可用于指引的方向；其余一律为 null
  const direction = isResolved || isOverride ? verdict.direction || null : null
  const stored = storedDirection || null
  return {
    state,
    direction,
    storedDirection: stored,
    /** 该方向是否来自本轮路线裁决（手动覆盖不算） */
    isValidRouteGuidance: isResolved,
    isManualOverride: isOverride,
    /** 是否渲染有效箭头：未裁决 / 冲突 / 未联动 / 从未裁决一律 false */
    showArrow: !!direction,
    /** 设备里还留着方向值，但它不是本轮有效指引 ⇒ 必须提示，不得渲染为有效箭头 */
    stale: !isResolved && !isOverride && !!stored,
    hasStoredButUnverified: !!stored && !isResolved,
  }
}

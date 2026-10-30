/**
 * 整栋楼疏散规划器 —— BuildingEvacuationPlan 的唯一产出者
 *
 * 约束（严格遵守，避免重复造轮子）：
 *   ① 不修改 shared/evacuation/routeGraph.js 的基础拓扑；
 *   ② 不修改 Dijkstra / Yen K 最短路实现 —— 仍然调用 routePlanner.findPaths()；
 *   ③ 不修改 routeValidator 的基础能力 —— 每条路线仍然过 validateRoute()；
 *   ④ 火灾只作为「动态障碍」，不改变 evacuationScope（永远是整栋楼 BUILDING）。
 *
 * 流程：
 *   整栋楼人员 → 按 floorId + zone 分组 → 每组调用 findPaths() 取候选
 *   → 按 strategy 为每组选一条 → 汇总为 BuildingEvacuationPlan
 *   → 全量校验（不穿墙 / 不经火区 / 必达 1F 出口 / 跨层必经楼梯）
 */
import {
  EVACUATION_SCOPE, STRATEGY, STRATEGY_META, RISK_RANK,
  emptyRoute, emptyBuildingPlan, emptySummary, zoneKeyOf,
} from './buildingEvacuationTypes.js'
import { RISK_LEVEL, NODE_TYPE } from './routeTypes.js'
import {
  buildBuildingGraph, exitIdsOf, blockedNodesForFire, blockedEdgesForFire,
  floorNum, ZONE_NODE_KEY, ZONE_CORRIDOR_KEY,
} from './routeGraph.js'
// P1.8.1：出口成为可参与路径约束的实体（available / status / capacity）
import { EXIT_DEFS, EXIT_STATUS, isExitUsable } from './floorTopology.js'
import { findPaths, startNodeId } from './routePlanner.js'
import { validateRoute } from './routeValidator.js'

const finite = (v) => (isFinite(v) ? v : 0)

/**
 * 坐标是否可用作「空间位置」。
 * null / undefined / 空串 / NaN / Infinity / 非数字字符串一律视为无效 ——
 * 无效坐标绝不能被当成 (0,0) 参与最近区域比较（那会产生一个确定的错误归属）。
 */
export function isValidCoordinate(v) {
  if (v === null || v === undefined || v === '') return false
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n)
}

/**
 * 人员 → 规划区域（起点必须在拓扑里是房间节点，否则路线无法通过 validateRoute）
 * 「走廊」等公共区域没有房间节点，按最近房间节点归属到同层某个区域，
 * 保证整栋楼每一个人都有合法起点与路线（不修改 routeGraph 的基础拓扑）。
 *
 * 三级判定：
 *   ① 本身是房间区域（ZONE_NODE_KEY 命中且节点存在）→ 原值（归一化等价）
 *   ② 公共区域 + 同层存在房间节点 + 坐标有效 → 最近房间节点的 zone
 *   ③ 坐标无效 / 同层无房间节点 → 返回原始 zone（**不猜测**）。
 *      此时该人员所在分组无法推导合法起点，由 planZoneRoutes 返回空候选，
 *      最终进入 missingZones 使方案 valid=false —— 即「明确失败」，不静默回退。
 */
export function resolvePlanningZone(graph, person) {
  if (!person) return ''
  const floorId = String(person.floorId)
  const key = ZONE_NODE_KEY[person.zone]
  if (key && graph && graph.nodes && graph.nodes[`${floorId}:${key}`]) return person.zone
  if (!graph || !graph.nodes) return person.zone
  if (!isValidCoordinate(person.x) || !isValidCoordinate(person.y)) return person.zone
  const px = Number(person.x)
  const py = Number(person.y)
  let best = null
  let bestD = Infinity
  Object.values(graph.nodes).forEach((n) => {
    if (n.floorId !== floorId || n.type !== NODE_TYPE.ROOM || !n.zone) return
    const d = (n.x - px) ** 2 + (n.y - py) ** 2
    if (d < bestD) { bestD = d; best = n }
  })
  return best ? best.zone : person.zone
}

/**
 * ① 整栋楼人员 → 按 floorId + zone 分组（ evacuationScope = BUILDING 的基础）
 *
 * 分组对象字段（RG-01 语义契约，三者必须同源）：
 *   · zoneKey      —— `${floorId}:${zone}`，由**归一化后**的 zone 生成
 *   · zone         —— 归一化后的规划区域（走廊人员 = 归属到的房间区域）
 *   · sourceZones  —— 该组内出现过的**原始**区域（去重、按输入顺序；如 ['A区','走廊']）
 * 因此 `zoneKey === zoneKeyOf(floorId, zone)` 恒成立，下游取路线不会出现
 * 「键按归属后区域、区域字段仍是走廊」的错位。
 *
 * @param {Array<{id:string, buildingId:string, floorId:string, zone:string, status?:string, x?:number, y?:number}>} persons
 * @param {object} opts
 * @param {string} [opts.buildingId] 只统计该楼栋（不传则全部）
 * @param {string[]} [opts.excludeStatuses] 排除的状态（如已撤离 safe）
 * @param {object} [opts.graph] 楼栋拓扑图；传入时走廊人员才会被归属到最近房间区域
 */
export function groupPersonsByZone(persons = [], opts = {}) {
  const { buildingId = null, excludeStatuses = [], graph = null } = opts
  const map = new Map()
  for (const p of persons) {
    if (!p || !p.floorId || !p.zone) continue
    if (buildingId && p.buildingId && String(p.buildingId) !== String(buildingId)) continue
    if (excludeStatuses.length && excludeStatuses.includes(p.status)) continue
    // 走廊等公共区域不是房间节点 → 归到同层最近的房间区域（保证人人有合法起点）
    const zone = graph ? resolvePlanningZone(graph, p) : p.zone
    const key = zoneKeyOf(p.floorId, zone)
    let g = map.get(key)
    if (!g) {
      // RG-01：zone 与 zoneKey 必须同源 —— zoneKey 由归一化后的 zone 生成，
      // zone 就保存同一个归一化区域；原始区域另存 sourceZones，绝不回写 zone。
      // （修复前这里写的是 p.zone，导致「分组键归到 A区、取路线却按走廊」）
      g = { zoneKey: key, floorId: p.floorId, zone, sourceZones: [], personCount: 0, personIds: [] }
      map.set(key, g)
    }
    if (!g.sourceZones.includes(p.zone)) g.sourceZones.push(p.zone)
    g.personCount += 1
    // G5（RG-01-R1.3）：人员 id 是否入组必须与 normalizePersonId 的判定同源，
    // 不再用真假值判断 —— 否则数字 0 会被丢弃（falsy），而 auditZoneGroups 却认它为有效 id '0'。
    if (normalizePersonId(p.id)) g.personIds.push(p.id)
  }
  return [...map.values()].sort(
    (a, b) => floorNum(b.floorId) - floorNum(a.floorId) || String(a.zone).localeCompare(String(b.zone), 'zh'),
  )
}

/**
 * 人员 id 规范化（RG-01-R1.2）：返回 '' 表示「无有效 id」，调用方必须据此报错，不得静默跳过。
 *   · 字符串：只用 trim 结果判断是否空白，**不改变有效字符串原值**（'A001' 仍为 'A001'）
 *   · 有限数字：转字符串（0 → '0'，不因 falsy 被拒绝）
 *   · null / undefined / 对象 / 数组 / 布尔值 / NaN / Infinity / 其它类型：一律返回 ''
 */
const normalizePersonId = (v) => {
  if (typeof v === 'string') {
    return v.trim() === '' ? '' : v
  }
  if (typeof v === 'number' && Number.isFinite(v)) {
    return String(v)
  }
  return ''
}

/**
 * 安全描述一个非法 id 原始值（RG-01-R1.3 / R1.4）—— 只用于构造错误文案，**不抛出**。
 * JSON.stringify 对 BigInt 直接抛 TypeError、对循环引用对象也会抛，
 * 因此这里只做类型安全的摘要：原始类型给值，引用类型只给类型标签，不做序列化。
 *
 * R1.4：仍有一类值会在摘要过程中抛错 —— 已撤销的 Proxy（`Array.isArray(revoked)` 抛
 * TypeError）、以及被改写过的 `Symbol.prototype.toString` / `BigInt.prototype.toString`。
 * 这里用**仅包住格式化**的局部 try/catch 兜住，返回占位符 `<unprintable>`。
 * 严禁把 try/catch 上移到 auditZoneGroups 主体 —— 那会吞掉真正的审计业务异常。
 */
const describeIdValue = (v) => {
  try {
    if (v === null) return 'null'
    if (v === undefined) return 'undefined'
    const t = typeof v
    if (t === 'string') return JSON.stringify(v)
    if (t === 'number') return String(v)
    if (t === 'boolean') return String(v)
    if (t === 'bigint') return `${v.toString()}n`
    if (t === 'symbol') return v.toString()
    if (Array.isArray(v)) return '<array>'
    return `<${t}>`
  } catch {
    // 只兜「文案格式化」本身：不影响任何判定规则，也不掩盖审计逻辑错误
    return '<unprintable>'
  }
}

/**
 * 分组 → 方案覆盖一致性审计（Worker validateConfirmedBuildingPlan 与单测共用的唯一规则来源）
 *
 * 任一检查不通过 ⇒ ok=false，方案不可确认执行，客户端必须被拒绝：
 *
 *   ⓪ 输入结构：groups / persons / plan 缺失（null、undefined、非数组）**不等于**合法空集合 ——
 *      返回明确失败，既不抛异常，也不静默跳过覆盖校验。合法空集合必须显式传 []。
 *   ① 人员记录合法：persons 中每条记录必须是对象（拒绝 null / 非对象 / 数组），
 *      且必须带有效 id（拒绝 null / 空串 / 纯空白串 / 对象 / 数组 / 布尔 / NaN / Infinity）。
 *      非法记录一律写入 inputErrors 并参与最终 ok —— **任何人员记录都不允许被静默跳过**。
 *   ② 组内自洽：zoneKey === zoneKeyOf(floorId, zone)；personIds 必须是数组且不含空 id；
 *      personCount === personIds.length。
 *   ③ 人员唯一性：每个人员 id 在全部分组中必须**恰好出现一次**（跨组重复或组内重复都拒绝）；
 *      输入人员集合自身出现重复 id 同样拒绝。
 *   ④ 人员覆盖：输入人员集合中的每个 id 都必须出现在某个分组里（不静默丢人）。
 *   ⑤ 无越界：分组中不允许出现不属于输入人员集合的 id。
 *   ⑥ 路线区域对应：routesByZone[zoneKey] 必须存在，且该路线对象必须属于本区域
 *      （route.zone === group.zone 且 route.floorId === group.floorId）——
 *      不允许其他区域的路线对象冒充当前区域路线。
 *
 * 明确不做（属 RG-02 执行门禁）：不重跑 validateRoute()，不校验墙体几何 / 完整拓扑 /
 * 出口运行状态 / 路线评分 / routeId 唯一性。
 *
 * @param {object} opts
 * @param {Array} opts.groups   groupPersonsByZone 的结果（必填；合法空集合请传 []）
 * @param {Array} opts.persons  参与分组的人员（必填；合法空集合请传 []）
 * @param {object} opts.plan    待校验的整栋楼方案（必填，需含 routesByZone）
 * @returns {{
 *   ok:boolean, reasons:string[],
 *   inputErrors:string[], inconsistent:Array, missing:string[], missingPersons:string[],
 *   duplicatePersons:Array, duplicatePersonIds:Array, extraPersonIds:string[],
 *   countMismatch:Array, invalidRoutes:Array
 * }}
 */
export function auditZoneGroups(opts = {}) {
  const { groups, persons, plan } = opts || {}
  const result = {
    ok: false,
    reasons: [],
    inputErrors: [],
    inconsistent: [],
    missing: [],
    missingPersons: [],
    duplicatePersons: [],
    duplicatePersonIds: [],
    extraPersonIds: [],
    countMismatch: [],
    invalidRoutes: [],
  }

  // ⓪ 输入结构：缺失参数 ≠ 合法空集合
  if (!Array.isArray(groups)) result.inputErrors.push('groups 缺失或不是数组（合法空集合请显式传 []）')
  if (!Array.isArray(persons)) result.inputErrors.push('persons 缺失或不是数组（合法空集合请显式传 []）')
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) result.inputErrors.push('plan 缺失或不是对象')
  if (result.inputErrors.length) {
    result.reasons.push(...result.inputErrors)
    return result
  }

  // ① 输入人员集合（非法记录必须留痕：不得静默跳过）
  const inputIds = new Map() // id → 出现次数
  persons.forEach((p, index) => {
    // G1：null / undefined / 非对象 / 数组 一律判为非法记录
    if (!p || typeof p !== 'object' || Array.isArray(p)) {
      result.inputErrors.push(`persons[${index}] 不是有效的人员记录（null / 非对象 / 数组）`)
      return
    }
    // G2 + G3：缺失 id、null id、空串、纯空白串、非字符串非有限数字 → 明确报错
    const id = normalizePersonId(p.id)
    if (!id) {
      // 错误文案使用安全格式化：BigInt / Symbol / 循环引用对象都不能让审计自身抛异常
      result.inputErrors.push(`persons[${index}] 缺少有效 id（原始值 ${describeIdValue(p.id)}）`)
      return
    }
    inputIds.set(id, (inputIds.get(id) || 0) + 1)
  })
  inputIds.forEach((count, id) => {
    if (count > 1) {
      result.duplicatePersons.push({ id, count })
      result.reasons.push(`输入人员 id 重复：${id} 出现 ${count} 次`)
    }
  })
  if (result.inputErrors.length) result.reasons.push(...result.inputErrors)

  // ② 分组结构自洽 + ⑤ 路线区域对应
  const groupedIds = new Map() // id → 在全部 personIds 中出现的次数
  groups.forEach((g, index) => {
    if (!g) {
      result.inconsistent.push({ index, reason: '分组对象为空' })
      result.reasons.push(`第 ${index} 个分组对象为空`)
      return
    }
    const expectedKey = zoneKeyOf(g.floorId, g.zone)
    if (g.zoneKey !== expectedKey) {
      result.inconsistent.push({ zoneKey: g.zoneKey, floorId: g.floorId, zone: g.zone, expectedKey })
      result.reasons.push(`分组键不一致：zoneKey=${g.zoneKey}，但 floorId+zone 推导为 ${expectedKey}`)
    }
    if (!Array.isArray(g.personIds)) {
      result.inconsistent.push({ zoneKey: g.zoneKey, reason: 'personIds 缺失或不是数组' })
      result.reasons.push(`${g.zoneKey} 的 personIds 缺失或不是数组`)
    } else {
      if (g.personCount !== g.personIds.length) {
        result.countMismatch.push({ zoneKey: g.zoneKey, personCount: g.personCount, idCount: g.personIds.length })
        result.reasons.push(`${g.zoneKey} personCount=${g.personCount} 与 personIds.length=${g.personIds.length} 不一致`)
      }
      g.personIds.forEach((rawId) => {
        const id = normalizePersonId(rawId)
        if (!id) {
          result.inconsistent.push({ zoneKey: g.zoneKey, reason: 'personIds 含空 id' })
          result.reasons.push(`${g.zoneKey} 的 personIds 含空 id`)
          return
        }
        groupedIds.set(id, (groupedIds.get(id) || 0) + 1)
      })
    }

    const route = plan.routesByZone ? plan.routesByZone[g.zoneKey] : null
    if (!route) {
      result.missing.push(g.zoneKey)
      result.reasons.push(`${g.zoneKey} 有 ${g.personCount} 人但没有疏散路线`)
    } else if (route.zone !== g.zone || String(route.floorId) !== String(g.floorId)) {
      result.invalidRoutes.push({
        zoneKey: g.zoneKey, routeZone: route.zone, routeFloorId: route.floorId,
        routeId: route.routeId,
      })
      result.reasons.push(
        `${g.zoneKey} 的路线属于其他区域（route.zone=${route.zone} / route.floorId=${route.floorId}），`
        + '不允许其他区域路线冒充当前区域路线',
      )
    }
  })

  // ③ 分组 id 唯一性 + ④ 越界检查
  groupedIds.forEach((count, id) => {
    if (count > 1) {
      result.duplicatePersonIds.push({ id, count })
      result.reasons.push(`分组中人员 id 重复：${id} 出现 ${count} 次（每个人员必须恰好出现在一个分组中）`)
    }
    if (!inputIds.has(id)) {
      result.extraPersonIds.push(id)
      result.reasons.push(`分组中出现不属于输入人员集合的 id：${id}`)
    }
  })

  // ⑤ 人员覆盖：输入侧每个 id 都必须被分组吸收
  inputIds.forEach((_, id) => {
    if (!groupedIds.has(id)) result.missingPersons.push(id)
  })
  if (result.missingPersons.length) {
    result.reasons.push(`${result.missingPersons.length} 名人员未纳入任何区域分组`)
  }

  result.ok = result.inputErrors.length === 0   // G4：输入错误必须参与最终结论
    && result.inconsistent.length === 0
    && result.missing.length === 0
    && result.missingPersons.length === 0
    && result.duplicatePersons.length === 0
    && result.duplicatePersonIds.length === 0
    && result.extraPersonIds.length === 0
    && result.countMismatch.length === 0
    && result.invalidRoutes.length === 0
  return result
}

/**
 * 火灾 → 动态障碍集合（只影响拓扑可达性，不改变疏散范围）
 * 火源房间封死；火源门厅对「不同门厅的区域」也封闭（火势蔓延走廊）。
 * 与火源共用同一门厅的区域（如 A区/B区 同门厅）不能被封死 —— 那是它唯一的出路。
 *
 * @param {Array} [baseExits] 运行态出口实体（默认 EXIT_DEFS）。
 *       作为「基底」参与合并：本函数只在其上叠加火灾导致的 BLOCKED，
 *       **不会**用 EXIT_DEFS 覆盖调用方已有的 available/status ——
 *       从而保证运行态维护性关闭（CLOSED）与人工阻断（BLOCKED）不因进入本函数而丢失。
 */
export function fireBlockSets(graph, fire, floorId, zone, startId, baseExits = EXIT_DEFS) {
  const base = baseExits || EXIT_DEFS
  const empty = {
    blockedNodes: new Set(),
    blockedEdges: new Set(),
    fireNodeIds: new Set(),
    exits: base,
  }
  if (!fire || !fire.floorId || !fire.zone) return empty
  const fireFloor = String(fire.floorId)
  const fireKey = ZONE_NODE_KEY[fire.zone]
  if (!fireKey) return empty

  const fireNodeIds = blockedNodesForFire({ floorId: fireFloor, zone: fire.zone, spreadToCorridor: false })
  const startHall = ZONE_CORRIDOR_KEY[ZONE_NODE_KEY[zone]]
  const fireHall = ZONE_CORRIDOR_KEY[fireKey]
  const sameHall = Boolean(startHall) && startHall === fireHall && String(floorId) === fireFloor
  const blockedNodes = blockedNodesForFire({
    floorId: fireFloor, zone: fire.zone, spreadToCorridor: !sameHall,
  })
  // 火源区人员必须从火源房间撤离 —— 起点落在火源节点时允许进入（撤离动作本身不可避免）
  if (startId && blockedNodes.has(startId)) blockedNodes.delete(startId)

  // P1.8.1：阻断从「节点」显式扩展到「边」与「出口可用状态」
  //   · blockedEdges —— 任何一端落在封锁节点上的边即视为被火灾切断（供 Dijkstra / Yen 消费）
  //   · exits        —— **通用机制**：出口节点若出现在封锁集合中，其实体状态同步为 BLOCKED
  //
  // ⚠️ 重要边界（勿混淆两种语义）：
  //   (a) 「出口节点被通用阻断机制封锁」= 上面的 if 分支，机制存在且已接通下游；
  //   (b) 「火灾逻辑自动识别出口不可用」= **尚未实现**。
  //   现有 blockedNodesForFire 只会产出 ZONE_NODE_KEY（房间门口）与
  //   ZONE_CORRIDOR_KEY（门厅），从不产出出口节点 —— 因此当前火灾规则下
  //   (a) 分支永远走不到，火灾**不会**直接导致出口不可用。
  //   出口不可用目前只能由运行态显式传入 exits 数组（available=false / CLOSED / BLOCKED）。
  //   若后续（P1.8.2）扩展 fireBlockSets 使其封锁出口节点，(a) 分支即自动生效，无需改下游。
  const blockedEdges = blockedEdgesForFire(graph, blockedNodes)
  const exits = base.map((e) => (
    blockedNodes.has(e.nodeId)
      ? { ...e, available: false, status: EXIT_STATUS.BLOCKED }
      : e
  ))
  return { blockedNodes, blockedEdges, fireNodeIds, exits }
}

/**
 * ② 单个 floorId + zone 的候选路线（复用现有 findPaths / Dijkstra / Yen / validateRoute）
 */
export function planZoneRoutes(opts = {}) {
  const {
    graph, floorId, zone, fire = null, personCount = 0,
    k = 3, limit = 3, idPrefix = 'R', exits = EXIT_DEFS,
  } = opts
  const startId = startNodeId(graph, floorId, zone)
  if (!startId) {
    return { startId: null, candidates: [], blockedNodes: [], blockedEdges: [], fireNodeIds: [] }
  }
  // exits 作为运行态基底传入 fireBlockSets，避免运行态出口状态被默认值覆盖
  const { blockedNodes, blockedEdges, fireNodeIds, exits: exitStates } = fireBlockSets(graph, fire, floorId, zone, startId, exits)
  const candidates = findPaths({
    graph, startId, blockedNodes, blockedEdges, fireNodeIds, exits: exitStates,
    congestion: personCount, k, limit, idPrefix: `${idPrefix}-${floorId}-${zone}`,
  })
  return {
    startId,
    candidates,
    blockedNodes: [...blockedNodes],
    blockedEdges: [...blockedEdges],
    fireNodeIds: [...fireNodeIds],
    exits: exitStates,
  }
}

/**
 * ③ 按策略为单个区域选择路线
 *   BALANCED：综合评分优先 + 出口负载均衡（人流分摊到不同安全出口）
 *   FASTEST ：预计耗时最短
 *   SAFEST  ：风险最低 / 远离火源
 */
export function pickRouteByStrategy(candidates = [], strategy = STRATEGY.BALANCED, ctx = {}) {
  const list = (candidates || []).filter((c) => c && c.valid)
  if (!list.length) return null

  if (strategy === STRATEGY.FASTEST) {
    return [...list].sort(
      (a, b) => a.estimatedTime - b.estimatedTime || a.distance - b.distance,
    )[0]
  }
  if (strategy === STRATEGY.SAFEST) {
    return [...list].sort(
      (a, b) => (RISK_RANK[a.riskLevel] ?? 9) - (RISK_RANK[b.riskLevel] ?? 9)
        || finite(b.fireDistance) - finite(a.fireDistance)
        || finite(b.escapeDistance) - finite(a.escapeDistance)
        || a.estimatedTime - b.estimatedTime,
    )[0]
  }
  // BALANCED
  const exitLoad = ctx.exitLoad || new Map()
  return [...list].sort((a, b) => {
    const la = exitLoad.get(a.exitId) || 0
    const lb = exitLoad.get(b.exitId) || 0
    // 负载差达到 1 人及以上时优先走人少的出口，否则按综合评分
    if (Math.abs(la - lb) >= 1) return la - lb
    return (b.score || 0) - (a.score || 0)
  })[0]
}

/** 候选方案 → EvacuationRoute（结构对齐 buildingEvacuationTypes） */
function routeFromCandidate(cand, { planId, floorId, zone, personCount }) {
  return emptyRoute({
    routeId: `${planId}:${floorId}:${zone}`,
    floorId,
    zone,
    startNode: cand.startNode,
    exitId: cand.exitId,
    exitLabel: cand.exitLabel,
    nodes: [...(cand.nodes || [])],
    points: (cand.points || []).map((p) => ({ x: p.x, y: p.y })),
    distance: cand.distance,
    estimatedTime: cand.estimatedTime,
    riskLevel: cand.riskLevel,
    valid: Boolean(cand.valid),
    reasons: [...(cand.reasons || [])],
    floorsPassed: [...(cand.floorsPassed || [])],
    fireDistance: cand.fireDistance,
    escapeDistance: cand.escapeDistance,
    exitDistance: cand.exitDistance,
    personCount,
    sourcePlanId: cand.id,
  })
}

/** 汇总指标（UI / 后端校验直接消费） */
export function summarizeBuildingPlan(routes = [], groups = []) {
  const list = routes.filter(Boolean)
  const floors = [...new Set(list.map((r) => r.floorId))]
    .sort((a, b) => floorNum(b) - floorNum(a))
  const exits = {}
  list.forEach((r) => {
    exits[r.exitId] = (exits[r.exitId] || 0) + (r.personCount || 0)
  })
  const times = list.map((r) => r.estimatedTime || 0)
  const riskLevel = list.reduce((acc, r) => (
    (RISK_RANK[r.riskLevel] ?? 0) > (RISK_RANK[acc] ?? 0) ? r.riskLevel : acc
  ), RISK_LEVEL.LOW)
  const personCount = list.reduce((s, r) => s + (r.personCount || 0), 0)
  return emptySummary({
    zoneCount: groups.length,
    routeCount: list.length,
    validRouteCount: list.filter((r) => r.valid).length,
    personCount,
    floors,
    exits,
    exitLabels: [...new Set(list.map((r) => r.exitLabel).filter(Boolean))],
    totalDistance: Math.round(list.reduce((s, r) => s + (r.distance || 0), 0) * 10) / 10,
    maxEstimatedTime: times.length ? Math.max(...times) : 0,
    avgEstimatedTime: times.length ? Math.round((times.reduce((s, t) => s + t, 0) / times.length) * 10) / 10 : 0,
    riskLevel,
    stairRouteCount: list.filter((r) => (r.floorsPassed || []).length > 1).length,
  })
}

/**
 * ④ 生成一整套整栋楼疏散方案（一个 strategy = 一个 BuildingEvacuationPlan）
 */
export function planBuildingEvacuation(opts = {}) {
  const {
    buildingId = '', buildingName = '', strategy = STRATEGY.BALANCED,
    persons = [], fire = null, maxFloor = 6, graph = null,
    k = 3, limit = 3, idPrefix = 'PLAN', createdAt = null,
    excludeStatuses = [], exits = EXIT_DEFS,
  } = opts
  const g = graph || buildBuildingGraph(maxFloor)
  const meta = STRATEGY_META[strategy] || STRATEGY_META[STRATEGY.BALANCED]
  const planId = `${idPrefix}-${meta.label}`
  const groups = groupPersonsByZone(persons, { buildingId: buildingId || null, excludeStatuses, graph: g })

  const exitLoad = new Map()
  const routes = []
  const missingZones = []
  for (const grp of groups) {
    const { candidates } = planZoneRoutes({
      graph: g, floorId: grp.floorId, zone: grp.zone, fire,
      personCount: grp.personCount, k, limit, idPrefix, exits,
    })
    const chosen = pickRouteByStrategy(candidates, strategy, { exitLoad })
    if (!chosen) { missingZones.push(grp.zoneKey); continue }
    exitLoad.set(chosen.exitId, (exitLoad.get(chosen.exitId) || 0) + grp.personCount)
    routes.push(routeFromCandidate(chosen, {
      planId, floorId: grp.floorId, zone: grp.zone, personCount: grp.personCount,
    }))
  }

  const plan = emptyBuildingPlan({
    id: planId,
    name: `方案${meta.label}·${meta.name}`,
    buildingId,
    buildingName,
    strategy,
    strategyLabel: meta.label,
    fire: fire
      ? { buildingId: fire.buildingId || buildingId, floorId: fire.floorId, zone: fire.zone }
      : null,
    createdAt,
  })
  plan.routes = routes
  plan.routesByZone = Object.fromEntries(
    routes.map((r) => [zoneKeyOf(r.floorId, r.zone), r]),
  )
  plan.summary = summarizeBuildingPlan(routes, groups)

  const v = validateBuildingEvacuationPlan(plan, { graph: g, groups, fire })
  plan.valid = v.valid
  plan.reasons = v.reasons
  return { plan, graph: g, groups, missingZones }
}

/**
 * 一次生成 PLAN-A / PLAN-B / PLAN-C 三套「整栋楼」方案
 * A = 均衡疏散 / B = 快速疏散 / C = 安全优先
 */
export function planBuildingStrategies(opts = {}) {
  const { strategies = [STRATEGY.BALANCED, STRATEGY.FASTEST, STRATEGY.SAFEST], maxFloor = 6, graph = null } = opts
  let g = graph || buildBuildingGraph(maxFloor)
  const plans = []
  let groups = []
  const missing = {}
  strategies.forEach((strategy) => {
    const res = planBuildingEvacuation({ ...opts, strategy, graph: g })
    g = res.graph
    groups = res.groups
    missing[strategy] = res.missingZones
    plans.push(res.plan)
  })
  // A 为默认推荐（均衡）
  plans.forEach((p, i) => { p.recommended = i === 0 })
  return { plans, graph: g, groups, missingZonesByStrategy: missing }
}

/**
 * ⑤ 整栋楼方案合法性校验（逐条路线复用现有 validateRoute）
 *   - scope 必须为 BUILDING
 *   - 每个「有人员的 floorId + zone」都必须有合法路线
 *   - 每条路线：不穿墙 / 不经过火区 / 终点为 1F 安全出口 / 跨层必经楼梯
 */
export function validateBuildingEvacuationPlan(plan, opts = {}) {
  const { graph, groups = null, fire = null, blockedNodes = null } = opts
  const reasons = []
  const invalidRoutes = []
  if (!plan) return { valid: false, reasons: ['方案为空'], invalidRoutes }
  if (plan.scope !== EVACUATION_SCOPE.BUILDING) reasons.push(`疏散范围必须为 BUILDING，实际 ${plan.scope}`)

  const routes = plan.routes || []
  if (!routes.length) reasons.push('整栋楼方案不包含任何路线')

  const f = fire || plan.fire
  const exitIds = graph ? exitIdsOf(graph, '1F') : null
  routes.forEach((r) => {
    if (!graph) return
    // 火灾障碍按「该路线所属区域」推导：与火源共用门厅的区域（同层 A区/B区）不被封死，
    // 因此不能用全楼并集校验，否则会误判火源区唯一出路为非法。
    const blocked = blockedNodes
      || fireBlockSets(graph, f, r.floorId, r.zone, r.startNode).blockedNodes
    const v = validateRoute(r, { graph, blockedNodes: blocked })
    if (!v.valid) {
      invalidRoutes.push({ zoneKey: zoneKeyOf(r.floorId, r.zone), reasons: v.reasons })
      reasons.push(`${r.floorId}-${r.zone} 路线非法：${v.reasons.join('；')}`)
    }
    if (exitIds && !exitIds.includes(r.exitId)) {
      invalidRoutes.push({ zoneKey: zoneKeyOf(r.floorId, r.zone), reasons: ['终点不是 1F 安全出口'] })
      reasons.push(`${r.floorId}-${r.zone} 终点不是 1F 安全出口：${r.exitId}`)
    }
    if (floorNum(r.floorId) > 1 && !(r.floorsPassed || []).includes('1F')) {
      reasons.push(`${r.floorId}-${r.zone} 未下降到 1F`)
    }
  })

  // 覆盖度：有人员的区域必须都有路线
  if (groups && groups.length) {
    groups.forEach((g) => {
      if (!plan.routesByZone || !plan.routesByZone[g.zoneKey]) {
        reasons.push(`${g.zoneKey} 有 ${g.personCount} 人但没有疏散路线`)
      }
    })
  }
  return { valid: reasons.length === 0, reasons, invalidRoutes }
}

/** 取某个区域（floorId + zone）的路线 */
export function routeOfZone(plan, floorId, zone) {
  if (!plan) return null
  return (plan.routesByZone || {})[zoneKeyOf(floorId, zone)] || null
}

/** 取某个人员（buildingId/floorId/zone）的路线 —— 后端下发 routePoints 与前端 3D 消费同一个 routeId */
export function routeOfPerson(plan, person) {
  if (!plan || !person) return null
  return routeOfZone(plan, person.floorId, person.zone)
}

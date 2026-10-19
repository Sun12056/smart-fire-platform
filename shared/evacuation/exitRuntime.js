/**
 * 出口运行态（P1.8.2 Stage 1）
 *
 * 与项目既有惯例一致：person / device 各有 personRuntime / deviceRuntime 作为
 * 「后端 → 快照 → 前端」的统一契约层，出口状态同样需要一个共用层，避免前后端各判一次。
 *
 * 职责边界（严格）：
 *   · 只做「出口实体状态的规范化 / 可用性判定 / 版本指纹」；
 *   · **不**做容量（capacity 恒为 null，本阶段不定义、不计算、不实施）；
 *   · **不**做 Zone→Exit 分配（属 Stage 2，未批准）；
 *   · **不**接入任何外部状态源（门禁 / 烟感 / 外部告警），只服务静态定义与内存态覆盖。
 */
import {
  EXIT_DEFS, EXIT_STATUS, EXIT_BY_NODE_ID, EXIT_BY_KEY, EXIT_NODE_IDS,
} from './floorTopology.js'
// 路线状态枚举来自 shared/evacuation/routeTypes.js（PLAN_STATUS，与 Demo 六阶段严格区分）
import { PLAN_STATUS } from './routeTypes.js'

/**
 * 默认出口状态：静态权威定义的一份拷贝。
 * 每次调用返回新数组，避免调用方就地修改污染 EXIT_DEFS。
 */
export function defaultExitStates() {
  return EXIT_DEFS.map((e) => ({ ...e }))
}

/**
 * 取出口条目的**原始标识**（nodeId / key / id 三种下发形式的统一入口）。
 *
 * ⚠️ 本函数是「标识解析」与「未知条目检测」的**唯一**来源。
 *    修复前两处各写一条解析链：解析处为 `nodeId ?? key ?? id`，
 *    未知条目检测处却漏了 `key`（写成了 `nodeId ?? id`）。
 *    后果：以 `key` 字段下发的**未知**条目既不解析、也不计入 unknownRawIds，
 *    degraded 保持 false ⇒ 明确的异常输入被**完全静默吞掉**（fail-open）。
 *    统一由本函数承载后，两处口径不可能再次分叉。
 *
 * @returns {string|number|null} 原始标识；非对象 / 空串 / null / undefined 一律返回 null
 */
export function rawExitIdOf(raw) {
  if (!raw || typeof raw !== 'object') return null
  const rawId = raw.nodeId ?? raw.key ?? raw.id ?? null
  return rawId === null || rawId === undefined || rawId === '' ? null : rawId
}

/**
 * 出口 id → 出口实体的**真实**查表。
 *
 * ⚠️ floorTopology.js 只导出 EXIT_BY_KEY / EXIT_BY_NODE_ID，**没有** EXIT_BY_ID。
 *    本轮授权范围不含 floorTopology.js，故在此直接由 EXIT_DEFS 本地构造，
 *    **不修改该文件、不扩大范围**。
 *
 *    修复前 resolveExitKey 只查 nodeId / key 两张表：所谓「裸 id 形式」能命中，
 *    **仅仅因为当前 EXIT_DEFS 两项恰好 id === key**，属**巧合**而非设计支撑。
 *    一旦某个出口定义为 id !== key，该形式即静默失效（条目被丢弃、路线被判失效），
 *    而既有测试因**硬编码** 'EXIT_W'（未取 EXIT_DEFS[].id）无法发现 —— 这是
 *    第二次独立复审 P3-1 / P3-3 指出的覆盖盲区。
 *
 *    ℹ️ 更合理的位置是 floorTopology.js 导出 EXIT_BY_ID；如需迁移，须先取得
 *       负责人批准（本轮不得自行扩展授权文件范围）。
 */
const EXIT_BY_ID = Object.fromEntries(EXIT_DEFS.map((e) => [e.id, e]))

/**
 * 解析出口标识到规范 { key, nodeId }：命中顺序 nodeId → key → id。
 *
 * ⚠️ 修复前只认 `raw.nodeId || raw.id`，而 `EXIT_DEFS[].id === .key`（如 'EXIT_W'）
 *    与 `nodeId`（如 '1F:EXIT_W'）**不是同一个值**。当调用方按 key/id 形式下发时，
 *    `EXIT_BY_NODE_ID['EXIT_W']` 查不到 → base=null → 合并阶段按 base.nodeId 也取不到
 *    → 该条目被**静默丢弃**，出口回落静态默认 OPEN（fail-open，安全侧风险）。
 *
 * @returns {{key: string, nodeId: string}|null} 无法解析到已知出口时返回 null
 */
export function resolveExitKey(raw) {
  const rawId = rawExitIdOf(raw)
  if (rawId === null || typeof rawId !== 'string') return null
  const byNode = EXIT_BY_NODE_ID[rawId]
  if (byNode) return { key: byNode.key, nodeId: byNode.nodeId }
  const byKey = EXIT_BY_KEY[rawId]
  if (byKey) return { key: byKey.key, nodeId: byKey.nodeId }
  const byId = EXIT_BY_ID[rawId]
  if (byId) return { key: byId.key, nodeId: byId.nodeId }
  return null
}

/**
 * 规范化未知 / 异常状态：
 *   · 缺失 available 视为 false（不可用）
 *   · 缺失 status 视为 CLOSED（不可用）
 *   · 非 EXIT_STATUS 枚举值视为 CLOSED
 *   · 出口标识按 nodeId / key / id 解析；解析失败整条丢弃并计入 unknown
 * 原则：任何不确定一律判为**不可用**（fail-safe），绝不静默当作可用。
 */
function normalizeOne(raw) {
  const resolved = resolveExitKey(raw)
  if (!resolved) return null
  const nodeId = resolved.nodeId
  const base = EXIT_BY_NODE_ID[nodeId] || null
  const status = Object.values(EXIT_STATUS).includes(raw.status) ? raw.status : EXIT_STATUS.CLOSED
  return {
    ...(base || {}),
    ...raw,
    // id / key / nodeId 一律取规范值：即使调用方下发了互相矛盾的标识
    // （如 nodeId 指向 W 而 id 指向 E），输出对象内部仍保持自洽。
    id: (base && base.id) || resolved.key,
    key: resolved.key,
    nodeId,
    // available 缺失 → false；否则严格取布尔
    available: raw.available === undefined ? false : Boolean(raw.available),
    status: raw.status === undefined ? EXIT_STATUS.CLOSED : status,
    // capacity 本阶段恒为 null（无业务含义），不接受外部覆盖
    capacity: null,
  }
}

/**
 * 归一化结果的**唯一**构造出口。
 *
 * ⚠️ 修复前两条早退分支（missing / invalid）各只返回 4 个字段，而正常路径返回 8 个，
 *    导致**最需要告警**的降级路径上 duplicate / unknown / partial / unknownRawIds
 *    为 undefined：调用方 `r.unknownRawIds.join()` 抛 TypeError，
 *    `if (r.unknown)` 因 undefined 短路而**不告警**。
 *    统一由本函数构造 ⇒ 返回结构与字段类型在**所有**分支上恒定。
 *
 * @typedef {object} ExitStatesResult
 * @property {Array}       exits          规范化后的完整出口状态（必然覆盖 EXIT_DEFS 全集）
 * @property {string[]}    usableNodeIds  当前可用出口节点 id —— **可含**未上报出口的
 *                         静态补齐项
 * @property {string[]}    reportedUsableNodeIds 【P2-1 策略 B】**仅由已上报且可解析**
 *                         的**可用**出口条目派生，**不含**静态补齐项。策略 B 下由它
 *                         派生有效可用集（见 applyExitInvalidation）。
 *
 *                         ### 与 usableNodeIds 的集合关系
 *
 *                         本字段恒为 usableNodeIds 的**子集**。
 *
 *                         **两者是否恒等以 `partial` 为唯一判据**（前提：当前实现的
 *                         partial 定义与出口不变式成立 —— 解析结果必属 EXIT_DEFS、
 *                         且各出口 nodeId 唯一）：
 *                           · partial === false ⇒ 已上报条目已覆盖 EXIT_DEFS 全集，
 *                             不存在静态补齐项 ⇒ 两者**恒等**；
 *                           · partial === true ⇒ 未上报出口的静态补齐项**只进入**
 *                             usableNodeIds、**不进入**本字段 ⇒ 两者**存在差异**。
 *
 *                         ⚠️ `duplicate` / `unknown` 等标志**可以**与 `partial`
 *                         同时成立，但**不能代替 `partial`** 判断两集合是否恒等 ——
 *                         判据始终只看有无静态补齐项参与，即只看 `partial`。
 *
 *                         ⚠️ **不得据 `reason` 推断两集合是否恒等**：reason 是**单值
 *                         优先级编码**（优先级见 normalizeExitStates），只保留优先级
 *                         最高的那个原因，无法完整表示**同时成立**的状态标志 ——
 *                         `duplicate` / `unknown` 都可能与 `partial === true` 同时成立：
 *                           · reason === 'duplicate' 且 partial === false ⇒ 恒等；
 *                           · reason === 'duplicate' 且 partial === true  ⇒ 有差异；
 *                           · reason === 'unknown'   且 partial === true  ⇒ 有差异。
 *
 *                         ### 各标志的组合语义（与上述判据一致）
 *                           · missing / invalid ⇒ 已上报条目数为 0，**且必伴随
 *                             partial === true** ⇒ 本字段恒为 []，而 usableNodeIds
 *                             **全部**来自静态默认回落（全 OPEN）⇒ 差异最大。正因如此，
 *                             这两种情形**严禁**据 usableNodeIds 派生可用集（P1-1 守卫）。
 *                           · duplicate ⇒ 仍算已上报：重复项经 conservativeMerge
 *                             （任一不可用 ⇒ 不可用）合并后**同步**影响两个集合 ⇒
 *                             重复本身**不决定**两者是否恒等（恒等与否仍看 partial）。
 *                           · unknown ⇒ 未知条目被丢弃，且**不牵连**其他已解析条目；
 *                             同样**不决定**两者是否恒等（恒等与否仍看 partial）。
 * @property {boolean}     degraded       是否降级（调用方须告警，不得当作可信运行态）
 * @property {string|null} reason         降级原因（单值优先级编码，优先级见 normalizeExitStates）
 * @property {boolean}     duplicate      存在重复 nodeId
 * @property {boolean}     unknown        存在无法解析到已知出口的条目
 * @property {boolean}     partial        运行态未覆盖全部出口
 * @property {string[]}    unknownRawIds  未识别条目的原始标识
 */
function buildExitStatesResult(exits, flags = {}) {
  return {
    exits,
    usableNodeIds: usableExitNodeIds(exits),
    // 【P2-1 策略 B · 已批准】与 usableNodeIds 的**唯一**区别：不含静态补齐项。
    //   missing / invalid 两个早退分支恒为空数组（无已上报条目 ⇒ 无可用集）。
    reportedUsableNodeIds: Array.isArray(flags.reportedUsableNodeIds)
      ? [...flags.reportedUsableNodeIds]
      : [],
    degraded: Boolean(flags.degraded),
    reason: flags.reason === undefined ? null : flags.reason,
    duplicate: Boolean(flags.duplicate),
    unknown: Boolean(flags.unknown),
    partial: Boolean(flags.partial),
    unknownRawIds: Array.isArray(flags.unknownRawIds) ? flags.unknownRawIds : [],
  }
}

/**
 * 规范化出口状态数组。
 *
 * @param {Array} [exits] 运行态出口状态（可缺失 / 可为空 / 可部分）
 * @returns {ExitStatesResult} 结构与字段类型在所有分支上恒定
 *
 * 缺失 / 过期 / 结构非法时的处理（**不静默**）：
 *   一律回落到**静态权威默认** defaultExitStates()（建筑层面真实存在的出口），
 *   并置 degraded=true + reason，由调用方显式告警。
 *   绝不使用「陈旧的运行态」—— 陈旧状态可能把已关闭的出口误报为可用（安全侧风险）。
 *
 * reason 取值优先级（**向后兼容**：'missing' / 'invalid' / 'partial' / null 语义不变）：
 *   'missing'  > 'invalid' > 'unknown' > 'duplicate' > 'partial' > null
 *   · missing   空 / 非数组
 *   · invalid   所有条目均无法解析
 *   · unknown   存在无法解析到已知出口的条目（新增，替代原先被静默丢弃的行为）
 *   · duplicate 存在重复 nodeId（新增）
 *   · partial   已解析条目少于静态出口总数（原语义修正：原为 merged.length !== list.length）
 */
export function normalizeExitStates(exits) {
  if (!Array.isArray(exits) || exits.length === 0) {
    return buildExitStatesResult(defaultExitStates(), {
      degraded: true,
      reason: 'missing',
      partial: true,
      // 策略 B：无任何已上报条目 ⇒ 无可用集（fail-closed）
      reportedUsableNodeIds: [],
    })
  }
  // 每条只解析一次：解析结果与原始条目一并保留，供未知条目检测复用（不再二次构造）
  const parsed = exits.map((raw) => ({ raw, one: normalizeOne(raw) }))
  const list = parsed.filter((x) => x.one).map((x) => x.one)
  // 未知条目检测与标识解析共用 rawExitIdOf ⇒ 覆盖 nodeId / key / id 三种形式，
  // 修复前此处漏 `key`，导致该形式的未知条目被静默吞掉（F-B）。
  const unknownRawIds = parsed
    .filter((x) => !x.one)
    .map((x) => rawExitIdOf(x.raw))
    .filter((rid) => rid !== null)
    .map(String)
  if (!list.length) {
    return buildExitStatesResult(defaultExitStates(), {
      degraded: true,
      reason: 'invalid',
      partial: true,
      unknown: unknownRawIds.length > 0,
      unknownRawIds,
      // 策略 B：零条可解析 ⇒ 零条已上报 ⇒ 无可用集（P1-1 fail-closed）
      reportedUsableNodeIds: [],
    })
  }
  // 重复 nodeId：保守合并（任一不可用 → 不可用），废弃原先 Map 的 last-wins 隐式行为
  const groups = new Map()
  list.forEach((e) => {
    if (!groups.has(e.nodeId)) groups.set(e.nodeId, [])
    groups.get(e.nodeId).push(e)
  })
  const duplicate = [...groups.values()].some((g) => g.length > 1)
  const mergedEntries = [...groups.values()].map((g) => (g.length === 1 ? g[0] : conservativeMerge(g)))
  // 部分下发：未在数组中的出口按静态定义补全 —— ⚠️【P2-1 策略 B · 已批准】
  //   该补齐**仅用于保持 exits 输出的「全出口」口径**（展示 / 诊断），
  //   **不得**据此判定可用性：策略 B 下未上报出口一律视为不可用，
  //   可用性只看 reportedUsableNodeIds（= mergedEntries 中的可用项，不含补齐项）。
  const byId = new Map(mergedEntries.map((e) => [e.nodeId, e]))
  const merged = defaultExitStates().map((base) => byId.get(base.nodeId) || base)
  const partial = mergedEntries.length < EXIT_DEFS.length
  const unknown = unknownRawIds.length > 0
  const degraded = partial || duplicate || unknown
  const reason = unknown ? 'unknown' : (duplicate ? 'duplicate' : (partial ? 'partial' : null))
  return buildExitStatesResult(merged, {
    degraded,
    reason,
    duplicate,
    unknown,
    partial,
    unknownRawIds,
    // 策略 B：唯一可用集来源 = 已上报且可解析的条目（不含上方静态补齐项）
    reportedUsableNodeIds: usableExitNodeIds(mergedEntries),
  })
}

/**
 * 重复出口 ID 的保守合并：任一副本不可用 → 该出口不可用。
 * 状态优先级：BLOCKED > CLOSED > 其余（仅影响展示，不可用判定与顺序无关）。
 */
function conservativeMerge(group) {
  const first = group[0]
  const anyUnavailable = group.some((e) => !e.available)
  const anyBlocked = group.some((e) => e.status === EXIT_STATUS.BLOCKED)
  const anyClosed = group.some((e) => e.status === EXIT_STATUS.CLOSED)
  const status = anyBlocked
    ? EXIT_STATUS.BLOCKED
    : (anyClosed ? EXIT_STATUS.CLOSED : first.status)
  return {
    ...first,
    available: !anyUnavailable && first.available,
    status,
    capacity: null,
  }
}

/**
 * 出口状态数组是否「完整」：覆盖全部已知出口、无重复、且全部可解析。
 * 供生产入口在开发期 / 测试中自检：进入规划函数的数组应当满足此条件。
 */
export function isExitStatesFull(exits) {
  if (!Array.isArray(exits) || !exits.length) return false
  const ids = []
  for (const raw of exits) {
    const r = resolveExitKey(raw)
    if (!r) return false
    ids.push(r.nodeId)
  }
  const uniq = new Set(ids)
  if (uniq.size !== ids.length) return false
  return EXIT_DEFS.every((e) => uniq.has(e.nodeId))
}

/**
 * 出口状态变化差异：同时给出「状态指纹变化」与「可用性变化」两种口径。
 *
 * ⚠️ changed 与 availabilityChanged 的语义区别（F-I，不得混用）：
 *   · changed              —— 出口状态**字段**（available + status）发生变化。
 *                            含「CLOSED → BLOCKED」这类**可用性未变**的变化 ⇒
 *                            此时 changed=true 但 closedNodeIds / openedNodeIds 均为空。
 *   · availabilityChanged  —— 有出口**由可用变不可用**或反之。
 *                            这才是「旧路线需要失效 / 需要重规划」的触发条件。
 *
 * ⇒ 调用方**不得**将 changed 直接当作「出口被关闭」事件使用；
 *    驱动失效与重规划应以 availabilityChanged 为准。
 */
export function exitDiff(prev, next) {
  const p = normalizeExitStates(prev)
  const n = normalizeExitStates(next)
  const prevSignature = exitStatesSignature(p.exits)
  const nextSignature = exitStatesSignature(n.exits)
  const prevUsable = new Set(p.usableNodeIds.map(String))
  const nextUsable = new Set(n.usableNodeIds.map(String))
  const allIds = new Set([...EXIT_NODE_IDS, ...p.exits.map((e) => e.nodeId), ...n.exits.map((e) => e.nodeId)])
  const closedNodeIds = []
  const openedNodeIds = []
  for (const id of allIds) {
    const was = prevUsable.has(String(id))
    const now = nextUsable.has(String(id))
    if (was && !now) closedNodeIds.push(String(id))
    if (!was && now) openedNodeIds.push(String(id))
  }
  return {
    changed: prevSignature !== nextSignature,
    availabilityChanged: closedNodeIds.length > 0 || openedNodeIds.length > 0,
    closedNodeIds,
    openedNodeIds,
    prevSignature,
    nextSignature,
    prevDegraded: p.degraded,
    nextDegraded: n.degraded,
    nextReason: n.reason,
  }
}

/** 取路线的出口标识：兼容 exitId（后端投影）与 exit（本地寻路）两种字段口径 */
export function exitIdOfRoute(route) {
  if (!route) return ''
  const ex = route.exitId || route.exit
  return ex ? String(ex) : ''
}

/**
 * 【N1 补充修复 · 路线侧唯一解析入口】把路线的出口标识解析为**规范 nodeId**。
 *
 * ⚠️ 修复前 A 层（shouldInvalidateByExits）比对前调用 resolveExitKey 归一化，
 *    而 B 层（isRouteUsable）直接拿 exitIdOfRoute 的**原始结果**去比对规范 nodeId 集合，
 *    routesAffectedByExits 同样直比原始值 —— 三条链路各自一套口径。
 *    后果：以裸 key / 裸 id 形式（如 'EXIT_W'）携带出口标识的**合法**路线，
 *    A 层判「不失效」而 B 层判「不可用」 ⇒
 *    路线保持 NORMAL 却永不被推荐 / 备用 / 选中（recommendedId=null、activeRoutePlanId=null），
 *    即同一返回值内部矛盾。现三条链路共用本函数，口径不可能再次分叉。
 *
 * @param {object} route
 * @returns {string|null} 规范 nodeId；缺失 / 空串 / 无法解析到已知出口 ⇒ **null**。
 *          null 表示「无法证明该路线可达安全出口」，调用方须按各自保守规则处理，
 *          **不得**静默猜测为某个已知出口。
 */
export function resolveRouteExitNodeId(route) {
  const ex = exitIdOfRoute(route)
  if (!ex) return null
  const resolved = resolveExitKey({ nodeId: ex })
  return resolved ? resolved.nodeId : null
}

/**
 * 【N1 补充修复 · 集合侧唯一解析入口】把「可用出口标识集合」归一化为**规范 nodeId 集合**。
 *
 * 输入契约（本批次明确，见下方三条）：
 *   · **推荐**传入规范完整 nodeId（如 '1F:EXIT_W'）—— 与
 *     normalizeExitStates().usableNodeIds / EXIT_NODE_IDS 同口径；
 *   · 入口**同时接受** key / id 形式（如 'EXIT_W'），并在此**统一解析**，
 *     **不依赖调用方偶然传入某种格式**。否则调用方以 key 形式传集会因
 *     `'EXIT_W' !== '1F:EXIT_W'` 而使**全部**路线被误判失效（fail-open 反面的
 *     整批误杀，同样是不可接受的安全侧行为）；
 *   · 无法解析的标识：**保留原值**参与比较 —— 既不静默丢弃、也不静默猜测为某个已知出口。
 *     由于路线侧无法解析的标识一律判为「缺失出口标识」（保守，见 resolveRouteExitNodeId），
 *     未知标识因此**不会**产生任何"假可用"。
 *
 * @param {Array} [ids] 可用出口标识集合（nodeId / key / id 混合亦可）
 * @returns {Set<string>} 规范 nodeId 集合（已剔除 null / undefined / 空串）
 */
export function toUsableNodeIdSet(ids) {
  const out = new Set()
  ;(Array.isArray(ids) ? ids : []).forEach((raw) => {
    const s = raw === undefined || raw === null ? '' : String(raw)
    if (!s) return
    const resolved = resolveExitKey({ nodeId: s })
    out.add(resolved ? resolved.nodeId : s)
  })
  return out
}

/**
 * 【N3 · B 层契约】「路线**当前**可作为有效路线」的状态**白名单**。
 *
 * ⚠️ 修复前是「排除 'BLOCKED' 字面量」的**黑名单**：任何未知 / 新增的失效态
 *    （如 PLANNING_STATUS.INVALIDATED / FAILED）都会被默认判为**可用** ⇒
 *    结构性 fail-open。改为白名单后，未列入者一律判为不可用（fail-safe）。
 *
 * 语义界定（关键）：本白名单回答的是「**现在**能否用它疏散」，而非「它是否曾经有效」。
 *   · WARNING  途经火源附近但未被阻断 ⇒ **仍可作为**当前有效路线 ⇒ 保留。
 *   · DONE     该路线的疏散**已经走完** ⇒ 是「曾经完成」的历史事实，
 *              不再是可继续用于疏散的当前路线 ⇒ **排除**。
 *
 * ⇒ 由此产生的行为差异（相对原 fireStore.js:314-316 的「仅 BLOCKED 才改选」）：
 *     若当前选中路线处于 DONE，出口失效协调会把它**改选**到其他仍可用路线，
 *     而不是继续停在已完成路线上。
 *   该差异是上述语义界定**推导出的结果**，不是为保守而保守的技术选择；
 *   DONE 本身的状态**不会被改写**为 BLOCKED（见 shouldInvalidateByExits 边界①）。
 *
 * ✅ DONE 契约（P1.8.2 Stage 1.1 补充修复批次 · **项目负责人已明确确认**）：
 *    M5 文本曾将 PLAN_STATUS.DONE 列入白名单，本实现按上述语义将其**排除**；
 *    该偏离**已由负责人确认采纳**，不再是未决事项。确认的完整契约：
 *      ① DONE **不属于**当前可用路线白名单；
 *      ② DONE **不参与**推荐 / 备用 / 当前选中（recommendedId / backupId /
 *         activeRoutePlanId 均不会取到 DONE 路线）；
 *      ③ DONE **保留其完成状态**，出口状态变化不得仅凭失效逻辑将其改写为 BLOCKED
 *         （见 shouldInvalidateByExits 判定顺序③，先于 BLOCKED 与未知状态分支）；
 *      ④ **不删除** DONE 路线及其历史记录（applyExitInvalidation 对 routePlans /
 *         perZone[].plans 恒按 map 逐项返回，**保持数组长度**，不做 filter）；
 *      ⑤ **不将** DONE 与 BLOCKED 合并为同一状态。
 *    若日后需恢复 M5 原文语义，只需在本数组追加 PLAN_STATUS.DONE 一项（可完全回退），
 *    但**须重新取得负责人决定**，不得由实现方自行选择。
 *
 * 当前生产代码中 PLAN_STATUS.DONE / CONFIRMED / EXECUTING **均无使用点**
 * （routeToRenderable 对投影路线硬编码 status: 'NORMAL'），
 * 故该取舍**当前不产生可观察行为差异**，仅在接线后生效。
 */
export const USABLE_ROUTE_STATUSES = Object.freeze([
  PLAN_STATUS.NORMAL,
  PLAN_STATUS.WARNING,
  PLAN_STATUS.CONFIRMED,
  PLAN_STATUS.EXECUTING,
])

/** 路线缺少出口标识时的处置策略 */
export const UNKNOWN_EXIT_POLICY = Object.freeze({
  FAIL_CLOSED: 'fail-closed',
  FAIL_OPEN: 'fail-open',
})

/**
 * 单条路线在当前出口状态下是否仍可作为有效路线。
 *
 * 判定为「不可用」的全部条件（fail-safe，任一命中即不可用）：
 *   ① 路线为空
 *   ② status 不在 USABLE_ROUTE_STATUSES 白名单内（含 BLOCKED / DONE / 任何未知态）
 *   ③ 有出口标识，但该出口不在可用列表中
 *   ④ 无出口标识，且 unknownExitPolicy 为默认 'fail-closed'
 *
 * @param {object} route
 * @param {string[]} usableNodeIds
 * @param {object} [options]
 * @param {'fail-closed'|'fail-open'} [options.unknownExitPolicy]
 *        缺少 exit / exitId 时的处置。**默认 'fail-closed'（判为不可用）**。
 *        仅当调用方能证明该字段在其数据口径下不承载出口语义
 *        （例如纯 2D 展示投影、不参与疏散决策）时，才允许显式传 'fail-open'。
 *        默认不信任 ⇒ 未知出口不会被误判为安全。
 */
export function isRouteUsable(route, usableNodeIds, options = {}) {
  if (!route) return false
  if (!USABLE_ROUTE_STATUSES.includes(route.status)) return false
  // 【N1 补充修复】与 A 层（shouldInvalidateByExits）共用同一解析链：
  //   · 路线出口标识经 resolveRouteExitNodeId 归一化为规范 nodeId；
  //   · 可用集合经 toUsableNodeIdSet 归一化为规范 nodeId 集合。
  // 修复前此处直比 exitIdOfRoute 的原始值 ⇒ 裸 key / 裸 id 形式的合法路线
  // 被误判为「不可用」，出现「A 层不失效 + B 层不可用」的同对象矛盾。
  const ex = resolveRouteExitNodeId(route)
  if (ex === null) return options.unknownExitPolicy === UNKNOWN_EXIT_POLICY.FAIL_OPEN
  return toUsableNodeIdSet(usableNodeIds).has(ex)
}

/**
 * 【N2 · A 层】路线是否应因「出口状态变化」而被标记失效（BLOCKED）。
 *
 * ⚠️ 本函数与 isRouteUsable（B 层）回答的是**两个不同的问题**，因此可以给出
 *    不同的结果 —— 但这必须是**显式且有理据**的，不得靠「两个函数各自漏判」
 *    的隐式不一致来维持。（修复前正是后者：缺出口标识时本函数判「不失效」而
 *    isRouteUsable 判「不可用」，导致路线保持 NORMAL 却永不被推荐/选中。）
 *
 *   ┌── A 层（本函数 / 失效判定）──────────────────────────────────────┐
 *   │ 问题：「这条路线**本身**是否还成立？」                          │
 *   │ 判据：路线当前是否仍指向一个可用的安全出口，且状态可被改写。    │
 *   │ 用途：重写 routePlans / perZone[].plans 中每条路线的 status。    │
 *   └─────────────────────────────────────────────────────────────────┘
 *   ┌── B 层（isRouteUsable / 可用性判定）────────────────────────────┐
 *   │ 问题：「这条路线能否作为**当前**选中 / 推荐 / 备用路线？」       │
 *   │ 判据：状态处于**进行中**的生命周期，且出口当前可用。          │
 *   │ 用途：recommendedId / backupId / activeRoutePlanId 的选取。    │
 *   └─────────────────────────────────────────────────────────────────┘
 *
 * 两层结果对照（前提：EXIT_E 关闭、EXIT_W 可用）
 *
 *   路线状态 ─────── 出口 ──────── A层(失效) ── B层(可用) ── 说明
 *   NORMAL             EXIT_W(可用)     否          是       正常保留
 *   WARNING            EXIT_W(可用)     否          是       途经火源附近但未阻断
 *   CONFIRMED          EXIT_W(可用)     否          是       已确认
 *   EXECUTING          EXIT_W(可用)     否          是       执行中
 *   NORMAL             EXIT_E(关闭)     是          否     ★ 本次失效
 *   WARNING            EXIT_E(关闭)     是          否     ★ 本次失效
 *   CONFIRMED          EXIT_E(关闭)     是          否     ★ 本次失效
 *   EXECUTING          EXIT_E(关闭)     是          否     ★ 执行中出口被关闭
 *   BLOCKED            任意             是          否       已是失效态，保持(幂等)
 *   DONE               EXIT_W 或 E      否          否     ★ 终态保护，绝不改写
 *   未知状态('WEIRD') 任意             是          否     ★ 保守判为失效
 *   缺失出口标识       任意             是          否     ★ 无法证明可达安全出口
 *   空串出口标识       任意             是          否       同「缺失出口标识」
 *   未知出口标识       任意             是          否       同「缺失出口标识」
 *
 * ★ 行依据：
 *   · DONE 不失效（边界①）—— DONE 是已完成终态，出口后续变化不能把「这条路线
 *     曾经走完」改写成「被阻断」。同时 DONE 被 B 层排除，不会被推荐/选中，
 *     故「状态保留 DONE」与「不进入推荐」二者不再互相矛盾。
 *   · 未知状态 / 缺失出口标识判为失效（边界③⑤）—— 本项目既定契约要求路线必须
 *     可达安全出口（routeValidator.js:93-96，失败即 BLOCKED），无法证明即不可用；
 *     标记 BLOCKED 后，status 与「不可推荐」结论一致。
 *   · DONE 终态保护**先于 blockAll**（边界②） —— 项目负责人已明确确认：即使
 *     所有出口都不可用，blockAll **也不得**绕过 DONE 终态保护，不得为 blockAll
 *     增设例外。故 blockAll 时 DONE 路线仍保持 DONE，且不进入 affectedRouteIds。
 *     ⚠️ 本项由第二次独立复审（P2-1）提出并修正：修复前 blockAll 先于 DONE，
 *        使「全出口不可用」这一**出口状态变化**把已完成路线改写为 BLOCKED，
 *        与已确认契约第 ③ / ⑤ 条直接冲突。
 *
 * 判定顺序（**顺序即优先级，不可调换**）：
 *   ①  空路线                      ⇒ 不处理（false）
 *   ②  status === DONE             ⇒ 不失效（终态保护，**最高优先级**，高于 blockAll）
 *   ③  blockAll                    ⇒ 失效（整批；DONE 已在 ② 提前返回，不受影响）
 *   ④  status 不在 PLAN_STATUS 枚举 ⇒ 失效（未知状态保守处理）
 *   ⑤  status === BLOCKED          ⇒ 失效（保持，幂等）
 *   ⑥  出口标识缺失 / 空串          ⇒ 失效（无法证明可达安全出口）
 *   ⑦  出口标识无法解析为已知出口    ⇒ 失效
 *   ⑧  出口不在可用列表             ⇒ 失效
 *   ⑨  其余                        ⇒ 不失效
 *
 * @param {object} route
 * @param {string[]} usableNodeIds 当前可用出口节点 id
 * @param {object} [options]
 * @param {boolean} [options.blockAll] 强制整批失效
 * @returns {boolean} true ⇒ 应被标记为 BLOCKED
 */
export function shouldInvalidateByExits(route, usableNodeIds, options = {}) {
  if (!route) return false                                                   // ①
  const status = route.status
  // ② DONE 终态保护**先于 blockAll**（P2-1 修复）：负责人已确认「即使所有出口
  //    都不可用，blockAll 也不得绕过 DONE 终态保护，不得擅自为 blockAll 增加
  //    例外」。修复前 blockAll 在 DONE 之前 ⇒ 全出口不可用时 DONE 被改写为
  //    BLOCKED 并计入 affectedRouteIds，与已确认契约第 ③ / ⑤ 条冲突。
  if (status === PLAN_STATUS.DONE) return false                              // ②
  if (options.blockAll === true) return true                                 // ③
  if (!Object.values(PLAN_STATUS).includes(status)) return true             // ④
  if (status === PLAN_STATUS.BLOCKED) return true                           // ⑤
  // 【N1 补充修复】⑥⑦ 合并为 resolveRouteExitNodeId 一次调用，⑧ 的可用集合
  // 经 toUsableNodeIdSet 统一解析 —— 与 B 层（isRouteUsable）**逐函数相同**，
  // 故两层的出口标识口径不可能再次分叉。
  const ex = resolveRouteExitNodeId(route)
  if (ex === null) return true                                               // ⑥ / ⑦
  return !toUsableNodeIdSet(usableNodeIds).has(ex)                           // ⑧ / ⑨
}

/** 受「已关闭出口」影响的路线 id 列表 */
export function routesAffectedByExits(routes, closedNodeIds) {
  // 【N1 补充修复】与 A 层 / B 层共用同一解析链：
  // 修复前直比 exitIdOfRoute 的原始值 ⇒ 裸 key / 裸 id 形式的路线既不会被
  // 识别为「受影响」，也无法被识别为「可豁免」，与 A 层的失效结论互相矛盾。
  const closed = toUsableNodeIdSet(closedNodeIds)
  if (!closed.size) return []
  return (Array.isArray(routes) ? routes : [])
    .filter(Boolean)
    .filter((r) => {
      const ex = resolveRouteExitNodeId(r)
      return ex !== null && closed.has(ex)
    })
    .map((r) => r.id)
    .filter(Boolean)
}

/**
 * 重选推荐 / 备用：候选必须满足 isRouteUsable 的全部条件
 *   （status 在白名单内 + 出口在当前可用列表中）。
 *
 * 无可选时一律返回 null —— **禁止回退到已失效的旧路线**。
 * 推荐与备用按入参顺序取前两条仍可用且 id 去重后的路线。
 *
 * @param {Array} plans
 * @param {string[]} usableNodeIds
 * @param {object} [options] 透传给 isRouteUsable（如 unknownExitPolicy）
 * @returns {{recommendedId: string|null, backupId: string|null}}
 */
export function pickSafeRecommendations(plans, usableNodeIds, options = {}) {
  const list = Array.isArray(plans) ? plans.filter(Boolean) : []
  const safe = []
  const seen = new Set()
  list.forEach((p) => {
    if (!isRouteUsable(p, usableNodeIds, options)) return
    const id = p.id === undefined || p.id === null ? '' : String(p.id)
    if (!id || seen.has(id)) return
    seen.add(id)
    safe.push(p)
  })
  return {
    recommendedId: safe[0] ? safe[0].id : null,
    backupId: safe[1] ? safe[1].id : null,
  }
}

/** 过滤出口列表，仅保留当前可用出口 */
export function filterExitNodeIds(ids, usableNodeIds) {
  // 【N1 补充修复】可用集合统一解析：调用方以 key / id 形式传入时仍能正确命中，
  // 避免「exitNodeIds 非空而 exits 为空」这类同对象内部矛盾在新的调用点上复发。
  //
  // 【第三批 P3 · 入参归一化对称化】修复前**只**归一化第 2 参 usableNodeIds，
  //   第 1 参 ids 直接 map(String) 后比较 ⇒ 两侧口径不对称：
  //     filterExitNodeIds(['EXIT_W'],      ['1F:EXIT_W']) → []            （本应命中）
  //     filterExitNodeIds(['1F:EXIT_W'],   ['EXIT_W'])    → ['1F:EXIT_W'] （正常）
  //   作为**公共导出**辅助函数，输入输出语义必须与 routesAffectedByExits
  //   （路线侧与集合侧均已归一化）保持一致。现对两侧使用同一解析链：
  //   无法解析的 id **保留原值**参与比较（与 toUsableNodeIdSet 同规则），
  //   既不静默丢弃、也不静默猜测为某个已知出口。
  const ok = toUsableNodeIdSet(usableNodeIds)
  return (Array.isArray(ids) ? ids : [])
    .map((raw) => {
      const s = raw === undefined || raw === null ? '' : String(raw)
      if (!s) return null
      const resolved = resolveExitKey({ nodeId: s })
      return resolved ? resolved.nodeId : s
    })
    .filter((id) => id !== null && ok.has(id))
}

/**
 * 【F-1 共享内核】一次性协调所有兼容投影的失效状态。
 *
 * 设计要点：
 *   · **按稳定 id 匹配**，不依赖任何投影之间的对象引用相等
 *     （routePlans 与 routeMatrix.perZone[].plans 是两次独立构造的不同实例）；
 *   · 不可变：返回新数组 / 新对象，不就地修改入参；
 *   · 只做「失效」，不做「重规划」——重规划结果由权威层决定（见 PLANNING_STATUS）。
 *
 * ### ⚖️ exits 与 usableNodeIds 的权威源（**负责人已批准，D1**）
 *
 * 两者同时提供且互相矛盾时，采用 **保守取交集** 规则：
 *
 * > **任一源判为不可用 ⇒ 该出口不可用；只有双方都判为可用 ⇒ 才可用。**
 * > 即 `有效可用集 = exits 推导可用集 ∩ usableNodeIds 声明可用集`。
 *
 * ⚠️ **该交集仅在 exits 可派生时适用**（`exitStates.reason ∉ {missing, invalid}`）。
 *   守卫不通过 ⇒ exits 派生集为空 ⇒ 有效可用集恒为空，**不得**回落到调用方声明集
 *   （见下方「守卫不通过时不得回落到声明集」）。
 *
 * 依据（均取自既有证据，非新设计）：
 *   1. 与既有 `conservativeMerge`「任一不可用 ⇒ 不可用」同一原则，由其条目级
 *      提升到**入参级**；
 *   2. 与本模块安全侧取向一致 —— 宁可多失效，不可把已关闭出口误报为可用；
 *   3. 与 `fireStore.js:297-300`「全出口不可用 ⇒ 整批失效，绝不保留『看似有效』
 *      的外观」一致。
 *
 * ⚠️ **特殊情况：仅提供 exits 时由其派生**（**负责人已批准，D4**）。
 *   若调用方只提供 `exits` 而未声明 `usableNodeIds`，则有效可用集 = exits
 *   推导出的可用集。修复前此情形会回落为空集 ⇒ `blockAll = true` ⇒ 所有非 DONE
 *   路线被**静默全量失效**，而此时 `exitStates.degraded = false`（声称运行态
 *   数据完整可信）⇒ 调用方**无任何信号**可察觉。
 *
 * ⚠️ **该派生必须**以「exits 确实提供可解析条目」为守卫：若两者均缺失，exits
 *   的可用集来自**静态默认回落（全 OPEN）**，据其派生会把 fail-closed 误变为
 *   fail-open —— 严禁。（P1-1 实现：`reason ∉ {missing, invalid}` 才派生）
 *
 * ⚠️ **守卫不通过时不得回落到声明集**（**负责人已批准，P2-1 全局策略 B**）：
 *   `usableNodeIds` 只能**收窄**有效可用集，**不能**在运行态未上报任何可解析条目时
 *   **单独放行**出口。否则「运行态缺失 / 不可解析」与「调用方自行声明」被混为一谈，
 *   `exitStates.degraded` 告警形同虚设 ⇒ 由 fail-closed 退化为 fail-open。
 *   实现：守卫不通过 ⇒ `有效可用集 = []`（**刻意不读取** `usableNodeIds`）。
 *
 * ### 🔒 派生源 = **已上报且可解析**的出口（**负责人已批准，P2-1 策略 B**）
 *
 * > **未上报的出口一律视为不可用**，即使其静态定义（含补齐后的默认 OPEN）声称可用。
 * > 有效可用集只取 `exitStates.reportedUsableNodeIds`，**不取**含静态补齐项的
 * > `usableNodeIds`。
 *
 * 影响面 —— **两集合是否恒等以 `partial` 为判据**（前提：当前实现的 partial 定义
 * 与出口不变式成立 —— 解析结果必属 EXIT_DEFS、且各出口 nodeId 唯一）：
 *   · `partial === false` ⇒ `reportedUsableNodeIds` 与 `usableNodeIds`
 *     恒等，两者互换无差别；
 *   · `partial === true`（只上报了部分出口）⇒ 未上报出口的静态补齐项**只进入**
 *     `usableNodeIds`、**不进入** `reportedUsableNodeIds` ⇒ 两者存在差异，
 *     未上报出口的路线一律失效（fail-closed）；
 *   · `duplicate`（同一出口重复上报）⇒ 仍算已上报，按 conservativeMerge 保守合并；
 *     它可以**与 `partial === true` 同时成立**，但 `duplicate` **本身不决定**
 *     两集合是否恒等 —— 恒等与否仍只由 `partial` 决定；
 *   · `unknown`（含未知标识条目）⇒ 未知条目被丢弃，但**不牵连**其他已解析条目；
 *     同样可与 `partial === true` **同时成立**，也**不**作为集合恒等的判据。
 *
 * 契约登记：`docs/API_CONTRACT.md` § 3.1.5。
 *
 * @param {object} input
 * @param {Array}  [input.routePlans]      兼容投影 A（当前路线列表）
 * @param {object} [input.perZone]         兼容投影 B：{ zone: { plans, recommendedId, backupId } }
 * @param {Array}  [input.exits]            运行态出口状态（建议传 normalizeExitStates().exits）。
 *                 未提供时回落静态权威定义（全 OPEN）并置 exitStates.degraded
 * @param {Array}  [input.usableNodeIds]    当前可用出口节点 id。未提供时（D4）由
 *                 已提供的 exits 派生；两者均未提供 ⇒ 空集 ⇒ 整批失效（fail-closed）
 * @param {Array}  [input.exitNodeIds]     ⚠️ **@deprecated**（**负责人已批准，D3**）
 *                 已知出口节点 id 全集；**仅作为 exitNodeIds 输出的额外收窄条件**，
 *                 不再是第二个独立来源（P2-2 / D3 已追认）。当前无生产消费方，
 *                 且与 `exits.map(e => e.nodeId)` 信息完全重合；保留行为、不再扩展。
 * @param {boolean} [input.blockAll]       强制整批失效（全出口不可用时由调用方或本函数自动置位）
 *
 * @returns {object} 协调后的全部投影。除既有字段外本批次**纯新增**两项（向后兼容）：
 *   · exitStates     出口状态归一化的降级信息
 *                    { degraded, reason, unknown, partial, duplicate, unknownRawIds }
 *                    —— 透出后调用方可区分「出口确实可用」与「状态缺失、已回落静态
 *                    默认（全部 OPEN）」，不再静默（P2-3）。
 *
 *   · exitsConflict  exits 推导可用集 与 input.usableNodeIds 的**对称差**（双向）。
 *
 *                    **【负责人已批准，D2】检测范围收窄**：仅在
 *                    `exitStates.reason === null`（即 exits 完整、无缺失 / 无重复矛盾）
 *                    **且** 调用方确实声明了 `usableNodeIds` 时才检测。
 *
 *                    理由：`partial` / `missing` / `invalid` / `duplicate` 情形下，
 *                    缺失出口的可用性来自静态默认回落，本就可能与调用方声明不一致
 *                    ⇒ 不判定为「入参冲突」，而由 `exitStates.partial` / `.unknown` /
 *                    `.duplicate` 单独表达，避免误报告警噪点。
 *
 *                    **消费方**：调用方（未来接线时的 fireStore / Worker 快照层），
 *                    用于**诊断告警**，**不用于**自动裁定或改写 status。
 *
 *   · exitNodeIds    ⚠️ **【负责人已批准，D3】标记为 deprecated**：当前无任何生产
 *                    消费方，且与 `exits.map(e => e.nodeId)` 信息完全重合。保留行为、
 *                    不再扩展；是否移除待负责人决定。
 */
export function applyExitInvalidation(input = {}) {
  // 【N1 补充修复 · usableNodeIds 入口契约】
  //   推荐传入规范完整 nodeId（如 '1F:EXIT_W'）；入口**同时接受** key / id 形式
  //   并在此统一解析，**不依赖调用方偶然传入某种格式**。
  //   解析后 usable / usableList 一律为规范 nodeId，下游全部投影（routePlans /
  //   perZone / exits / exitNodeIds / activeRoutePlanId）共用同一口径。
  //
  // 【第四批 · D1 已批准】两个入参同时提供且互相矛盾时采用**保守取交集**：
  //   有效可用集 = exits 推导可用集 ∩ usableNodeIds 声明可用集。
  //
  // 【第四批 · D4 已批准】仅提供 exits 时**由其派生**，不再回落为空集
  //   （修复前 ⇒ blockAll=true ⇒ 非 DONE 路线被静默全量失效且 exitStates.degraded=false）。
  //
  // ⚠️ 派生**必须**以 exits 确实提供可解析条目为守卫：两者均缺失时若据静态默认
  //    回落（全 OPEN）派生，会把 fail-closed 误变为 fail-open —— 严禁。
  //
  // 【P2-1 策略 B · 已批准】派生源为 **reportedUsableNodeIds**（仅已上报且可解析的
  //   条目），**不是** usableNodeIds（后者含静态补齐项）。⇒ 未上报出口一律不可用。
  const exitsIn = Array.isArray(input.exits) ? input.exits : []
  const norm = normalizeExitStates(exitsIn)
  const declaredUsable = Array.isArray(input.usableNodeIds) ? input.usableNodeIds : null
  // 【P1-1】守卫从「exits 数组非空」**收紧**为「exits 确实提供可解析条目」。
  //   修复前写作 `exitsIn.length > 0`，只判断数组非空：当 exits 非空但**零条可解析**
  //   （如 `[{ foo: 1 }]` / `[{ nodeId: '1F:EXIT_ZZZ' }]` / `[null, 'x', 42]`）时，
  //   normalizeExitStates 置 reason='invalid' 并回落静态默认（全 OPEN），
  //   其 usableNodeIds **全部来自回落而非运行态**，据其派生 ⇒ fail-open。
  //   现改为复用 normalizeExitStates 已裁决好的 reason 本体（见其优先级说明）：
  //     · 'missing' 未传 / 空数组        ⇒ 无疑可用运行态 ⇒ 不派生（fail-closed 保持）
  //     · 'invalid' 非空但零条可解析     ⇒ 同上 ⇒ 不派生（P1-1 本批次修复点）
  //     · 其余（partial / duplicate / unknown / null）⇒ 至少一条确实可解析
  //       ⇒ 仍按**实际规范化结果**派生，不把部分有效输入一律判为无效。
  //
  // 【P2-1 全局策略 B · 已批准】守卫不通过时**不得回落到声明集**：`usableNodeIds`
  //   只能**收窄**有效可用集，**不能**单独放行出口（否则 fail-closed 退化为
  //   fail-open，`exitStates.degraded` 告警形同虚设）⇒ 此时**刻意不读取**
  //   `declaredUsable`，有效可用集恒为空。
  const exitsUsable = norm.reason !== 'missing' && norm.reason !== 'invalid'
    ? toUsableNodeIdSet(norm.reportedUsableNodeIds)
    : null

  let usableList
  if (exitsUsable === null) {
    usableList = []                                                  // 策略 B：守卫不通过 ⇒ 空集
  } else if (declaredUsable === null) {
    usableList = [...exitsUsable]                                    // D4：由 exits 派生
  } else {
    usableList = filterExitNodeIds(declaredUsable, [...exitsUsable])  // D1：保守取交集
  }
  const usable = toUsableNodeIdSet(usableList)
  const blockAll = input.blockAll !== undefined ? Boolean(input.blockAll) : usable.size === 0
  const options = { unknownExitPolicy: input.unknownExitPolicy || UNKNOWN_EXIT_POLICY.FAIL_CLOSED }

  // 失效判定统一委托给 A 层语义函数 shouldInvalidateByExits（见其文档）：
  // 判定只依赖路线自身的出口与状态，与其是否出现在其他投影中无关（F-E）。
  // 幂等：已是 BLOCKED 者保持 BLOCKED，不会被恢复。
  const isStale = (p) => shouldInvalidateByExits(p, usableList, { blockAll })

  // 投影 A：保留数组长度（不做 filter(Boolean)，避免改变依赖索引的下游行为，F-K）
  const routePlansIn = Array.isArray(input.routePlans) ? input.routePlans : []
  const routePlans = routePlansIn.map((p) => (isStale(p) ? { ...p, status: PLAN_STATUS.BLOCKED } : p))

  // affectedRouteIds = 两个投影中「本次协调后处于 BLOCKED」的路线 id 并集去重。
  // ⚠️ 含此前已因其他原因（如火情）失效者，非「本次新增失效」集合。
  const affected = new Set()
  const collect = (p) => {
    if (!p || p.status !== PLAN_STATUS.BLOCKED) return
    const id = p.id === undefined || p.id === null ? '' : String(p.id)
    if (id) affected.add(id)
  }
  routePlans.forEach(collect)

  // 投影 B：同样按每条路线自身判定，与 A 是否在场无关
  const perZoneIn = input.perZone && typeof input.perZone === 'object' ? input.perZone : {}
  const perZone = {}
  Object.entries(perZoneIn).forEach(([zone, info]) => {
    const plans = (Array.isArray(info && info.plans) ? info.plans : [])
      .map((p) => (isStale(p) ? { ...p, status: PLAN_STATUS.BLOCKED } : p))
    plans.forEach(collect)
    const picked = pickSafeRecommendations(plans, usableList, options)
    perZone[zone] = { ...(info || {}), plans, recommendedId: picked.recommendedId, backupId: picked.backupId }
  })

  // 【N1】出口展示投影必须与「标识归一化」同一口径。
  // 修复前直接读原始 e.nodeId || e.id，与 resolveExitKey 的三种合法形式
  // （nodeId / key / id）不一致 ⇒ 以 key/id 形式下发的出口被整条筛掉，
  // 出现「exitNodeIds 非空而 exits 为空」的同一返回值内部矛盾。
  // 改为先经 normalizeExitStates 归一化为规范 nodeId 再过滤：
  //   · 不新增第四套标识体系，完全复用既有契约；
  //   · 未知标识不会被静默转换为已知出口（normalizeExitStates 会置 unknown/degraded）；
  //   · 重复且矛盾的条目仍按 conservativeMerge 保守合并（任一不可用 ⇒ 不可用）。
  //
  // 【第三批 P2-3 · 降级可见性】normalizeExitStates 计算出的 degraded / reason /
  //   unknown / partial / duplicate / unknownRawIds 此前被**整体丢弃**，导致
  //   「出口状态缺失、实际已回落静态默认（全部 OPEN）」与「出口确实全部可用」
  //   在返回值上**完全无法区分** —— 与本模块「不静默」「绝不使用陈旧运行态」
  //   的自述原则直接冲突。现原样透出（纯新增字段，既有字段语义不变 ⇒ 向后兼容）。
  const normalizedExits = norm.exits
  const exits = normalizedExits.filter((e) => usable.has(String(e.nodeId)))

  // 【第三批 P2-2 · 两个输出改为同源】修复前 exits 与 exitNodeIds **各自取不同候选池**：
  //     exits       ← normalizeExitStates(exitsIn)（恒覆盖 EXIT_DEFS 全集）
  //     exitNodeIds ← input.exitNodeIds ?? EXIT_NODE_IDS
  //   两个池各自过滤 ⇒ 调用方传入部分 exitNodeIds 时，两输出**数量不一致**
  //   （exits 有 2 项而 exitNodeIds 只有 1 项）。
  //   现 exitNodeIds 改为**由 exits 派生**（同一来源、同一过滤结果，恒满足
  //   exitNodeIds === exits.map(nodeId) 的收窄），input.exitNodeIds 退化为
  //   **额外收窄条件**，不再作为第二个独立来源。
  const declaredNodeIds = Array.isArray(input.exitNodeIds) ? toUsableNodeIdSet(input.exitNodeIds) : null
  const exitNodeIds = exits
    .map((e) => String(e.nodeId))
    .filter((id) => declaredNodeIds === null || declaredNodeIds.has(id))

  // 【第三批 P2-2 · 冲突检测】【第四批 D1 + D2 已批准】
  //   D1：两者同时提供且矛盾时，处置按**保守取交集**（见函数头契约），
  //       本字段**不改变**处置结果，只做**诊断暴露**。
  //   D2：检测范围**收窄** —— 仅在 exitStates.reason === null
  //       （exits 完整、无缺失 / 无重复矛盾）**且**调用方确实声明了
  //       usableNodeIds 时才检测；partial / missing / invalid / duplicate
  //       情形下缺失出口的可用性来自静态默认回落，本就可能与调用方声明不一致
  //       ⇒ 不判定为「入参冲突」，改由 exitStates.partial / .unknown /
  //       .duplicate 单独表达，避免误报告警噪点。
  //   · **消费方 = 调用方**（未来接线时的 fireStore / Worker 快照层），
  //     用于告警与排查跨端不一致；**不用于**自动裁定或改写 status。
  // declaredSet：调用方声明的 usableNodeIds **经同一解析链归一化**后的集合
  // （与头部的 exitsUsable 口径一致，二者可直接做集合运算）
  const declaredSet = declaredUsable !== null ? toUsableNodeIdSet(declaredUsable) : null
  const exitsConflict = norm.reason === null && declaredSet !== null
    ? [
      ...[...exitsUsable].filter((id) => !declaredSet.has(id)),
      ...[...declaredSet].filter((id) => !exitsUsable.has(id)),
    ]
    : []

  // 当前选中路线失效后的重选（保留 fireStore.js:314-316 既有行为，F-D）：
  //   · 原选中项仍可用 ⇒ 保持不变
  //   · 原选中项失效 ⇒ 取第一条仍可用者；无可用者 ⇒ null
  // 绝不选回已失效路线。
  const currentId = input.activeRoutePlanId === undefined || input.activeRoutePlanId === null
    ? null
    : String(input.activeRoutePlanId)
  let activeRoutePlanId = currentId
  if (currentId !== null) {
    const current = routePlans.find((p) => p && String(p.id) === currentId) || null
    if (!current || !isRouteUsable(current, usableList, options)) {
      const fallback = routePlans.find((p) => isRouteUsable(p, usableList, options)) || null
      activeRoutePlanId = fallback ? fallback.id : null
    }
  }

  return {
    routePlans,
    perZone,
    exits,
    exitNodeIds,
    affectedRouteIds: [...affected],
    blockedAll: blockAll,
    activeRoutePlanId,
    // 【P2-3 新增】出口状态归一化的降级信息（不含 exits 本体，避免与上方 exits 重复）
    exitStates: {
      degraded: norm.degraded,
      reason: norm.reason,
      unknown: norm.unknown,
      partial: norm.partial,
      duplicate: norm.duplicate,
      unknownRawIds: norm.unknownRawIds,
    },
    // 【P2-2 新增】exits 推导可用集 与 调用方声明 usableNodeIds 的**对称差**。
    // ⚠️ 处置已由 **D1（保守取交集）** 在本函数内裁定完毕：任一源判为不可用 ⇒ 不可用。
    //    本字段**不改变**任何处置结果，仅供调用方**诊断告警**；
    //    不得据此自动裁定优先级或改写 status。
    //    （历史注释「本函数不代其裁定优先级」与已批准的 D1 矛盾，已更正。）
    exitsConflict,
  }
}

/**
 * 【F-12 状态模型】重规划状态机（纯函数）。
 *
 * ⚠️ 关键约束：**不存在** exit_changed → FAILED / NO_FEASIBLE_ROUTE 的转换。
 *    出口状态变化只能推导到 INVALIDATED（旧路线已失效、等待重规划）；
 *    FAILED 与 NO_FEASIBLE_ROUTE 只能由**真实发生过的**重规划尝试产生
 *    （replan_failed / no_feasible_route 事件）。
 *    从而在模型层面杜绝"把尚未发生的重规划结果写成事实"。
 */
export const PLANNING_STATUS = {
  NONE: 'NONE',
  INVALIDATED: 'INVALIDATED',
  REPLANNING: 'REPLANNING',
  OK: 'OK',
  FAILED: 'FAILED',
  NO_FEASIBLE_ROUTE: 'NO_FEASIBLE_ROUTE',
}

export const PLANNING_EVENT = {
  EXIT_CHANGED: 'exit_changed',
  REPLAN_STARTED: 'replan_started',
  REPLAN_SUCCEEDED: 'replan_succeeded',
  REPLAN_FAILED: 'replan_failed',
  NO_FEASIBLE_ROUTE: 'no_feasible_route',
  RESET: 'reset',
}

const PLANNING_TRANSITIONS = {
  NONE: { exit_changed: 'INVALIDATED', replan_started: 'REPLANNING', reset: 'NONE' },
  OK: { exit_changed: 'INVALIDATED', reset: 'NONE' },
  INVALIDATED: { exit_changed: 'INVALIDATED', replan_started: 'REPLANNING', reset: 'NONE' },
  REPLANNING: {
    // 重规划进行中出口再次变化 ⇒ 在途结果所依据的出口状态已过期。
    // 回到 INVALIDATED 显式表达「旧方案已失效、需重新规划」，
    // 同时由 nextPlanningGeneration 递增代次，使在途结果被丢弃（见其文档）。
    exit_changed: 'INVALIDATED',
    replan_succeeded: 'OK',
    replan_failed: 'FAILED',
    no_feasible_route: 'NO_FEASIBLE_ROUTE',
    reset: 'NONE',
  },
  FAILED: { exit_changed: 'INVALIDATED', replan_started: 'REPLANNING', reset: 'NONE' },
  NO_FEASIBLE_ROUTE: { exit_changed: 'INVALIDATED', replan_started: 'REPLANNING', reset: 'NONE' },
}

/** 合法则迁移到目标状态，非法则返回 null（调用方须拒绝并保持原状态） */
export function nextPlanningState(current, event) {
  const from = PLANNING_TRANSITIONS[current]
  if (!from) return null
  return from[event] || null
}

/**
 * 代次推进规则 —— 状态迁移与异步结果提交之间的**配套语义**（S-A）。
 *
 * 仅有状态边是不够的：若在 REPLANNING 期间出口再次变化而代次不变，
 * 在途结果仍会通过 shouldApplyReplanResult 并被提交，
 * 于是「基于旧出口状态」的方案覆盖新状态 —— 这正是要杜绝的情形。
 * 因此：任何使在途结果失去意义的事件都必须递增代次。
 *
 *   · replan_started —— 新一轮请求，旧代次作废
 *   · exit_changed   —— 出口状态已变，在途结果所依据的输入过期 ⇒ 作废
 *   · 其余事件（成功 / 失败 / 无可行路线 / 重置）不改变代次
 *
 * 调用方协议：
 *   ① 发起重规划：gen = nextPlanningGeneration(gen, 'replan_started')，携带 gen 发出请求
 *   ② 出口变化：  gen = nextPlanningGeneration(gen, 'exit_changed')（作废在途请求）
 *   ③ 结果到达：  仅当 shouldApplyReplanResult(gen, resultGen) 为真才允许提交，否则丢弃
 */
export function nextPlanningGeneration(currentGen, event) {
  const g = Number.isFinite(currentGen) ? currentGen : 0
  if (event === PLANNING_EVENT.REPLAN_STARTED || event === PLANNING_EVENT.EXIT_CHANGED) return g + 1
  return g
}

/** 异步结果代次校验：只有代次一致的结果才允许覆盖当前状态 */
export function shouldApplyReplanResult(currentGen, resultGen) {
  return Number.isFinite(currentGen) && Number.isFinite(resultGen) && currentGen === resultGen
}

/**
 * 可用出口节点 id 列表（与 floorTopology.isExitUsable 同一判定口径）。
 * 三者皆不可用：available=false / status=CLOSED / status=BLOCKED
 */
export function usableExitNodeIds(exits) {
  const list = Array.isArray(exits) ? exits : []
  return list
    .filter((e) => Boolean(e && e.available)
      && e.status !== EXIT_STATUS.BLOCKED
      && e.status !== EXIT_STATUS.CLOSED)
    .map((e) => e.nodeId || e.id)
    .filter(Boolean)
}

/** 是否至少有一个可用出口（用于「全出口不可用 → 不得静默产出空方案」的判断） */
export function hasUsableExit(exits) {
  return usableExitNodeIds(exits).length > 0
}

/**
 * 出口状态的版本指纹：用于检测变化，触发重规划 / 存量路线失效判定。
 * 只取影响可用性的字段（available + status），忽略 label / capacity 等展示字段。
 */
export function exitStatesSignature(exits) {
  const list = Array.isArray(exits) ? exits : []
  return list
    .map((e) => `${e && (e.nodeId || e.id)}:${e && e.available ? 1 : 0}:${e && e.status}`)
    .sort()
    .join('|')
}

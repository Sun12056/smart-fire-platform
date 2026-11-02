'use strict'
/**
 * 疏散指示方向的「期望侧」契约（WP-A3 / A3-3）
 * ────────────────────────────────────────────────
 * 背景（缺陷）：b403 原先用
 *     direction: norm(d.direction) === 'left' ? 'left' : 'right'
 * 生成期望值，与被测产品的兜底函数（shared/device/deviceRuntime.js 的
 * deviceDirection / directionOf）逐字符同构，于是 null / 缺失 / 非法方向
 * 在「期望侧」和「渲染侧」同时被折叠成 'right' —— 测试必然通过，无法发现缺陷。
 *
 * 本模块的独立性约定：
 *   ① 合法方向域只有一个：['left', 'right']；
 *   ② 非合法值一律归类为 missing / null / invalid，**绝不返回 'right'**；
 *   ③ 期望值对未知方向返回 DIRECTION_UNSPECIFIED，不得参与「相等即通过」的判定；
 *   ④ 权威方向未知时，该样本记为「契约缺口 D-01」，不计为产品测试失败，
 *      也不得被静默当作通过（见 bucketDirections 的 gaps 桶）；
 *   ⑤ 下游方向缺失 / 非法时，属于真实缺陷（missing 桶），不允许被跳过。
 *
 * 依赖约束：零第三方依赖，可被纯 Node 单元测试直接 require。
 */

const DIRECTION_DOMAIN = Object.freeze(['left', 'right'])
/** 未知方向的期望占位符（不是合法方向值） */
const DIRECTION_UNSPECIFIED = 'unspecified'

/**
 * 分类一个方向原始值。
 * @param {unknown} raw
 * @returns {{state:'left'|'right'|'missing'|'null'|'invalid', legal:boolean, direction?:string, raw:unknown}}
 */
function classifyDirection(raw) {
  if (raw === undefined) return { state: 'missing', legal: false, raw: null }
  if (raw === null) return { state: 'null', legal: false, raw: null }
  const s = String(raw)
  if (DIRECTION_DOMAIN.includes(s)) return { state: s, legal: true, direction: s, raw: s }
  return { state: 'invalid', legal: false, raw: s }
}

/**
 * 期望方向：合法值原样返回；非合法值返回 DIRECTION_UNSPECIFIED。
 * 禁止把 null / 缺失 / 非法值兜底成 'right'。
 */
function expectedDirection(raw) {
  const c = classifyDirection(raw)
  return c.legal ? c.direction : DIRECTION_UNSPECIFIED
}

/**
 * 比对「权威方向」与「下游渲染方向」，不做任何兜底。
 * @returns {{kind:'match'|'mismatch'|'missing'|'gap', auth:object, down:object}}
 *   match    —— 权威合法且下游合法且相等
 *   mismatch —— 两侧都合法但方向相反（真缺陷）
 *   missing  —— 权威合法，但下游缺失 / 非法（真缺陷，禁止跳过）
 *   gap      —— 权威方向本身未知（null / 缺失 / 非法）⇒ 契约缺口 D-01，不判产品失败
 */
function compareDirection(rawAuth, rawDownstream) {
  const auth = classifyDirection(rawAuth)
  const down = classifyDirection(rawDownstream)
  if (!auth.legal) return { kind: 'gap', auth, down }
  if (!down.legal) return { kind: 'missing', auth, down }
  return auth.direction === down.direction
    ? { kind: 'match', auth, down }
    : { kind: 'mismatch', auth, down }
}

/**
 * 批量分桶。保证「记录条数守恒」：四个桶的条数之和恒等于入参长度，
 * 因此不存在被条件（如 `x.dir &&`）静默过滤掉的样本。
 */
function bucketDirections(records, getAuth, getDown) {
  const authOf = typeof getAuth === 'function' ? getAuth : (r) => r.authRaw
  const downOf = typeof getDown === 'function' ? getDown : (r) => r.downRaw
  const buckets = { matched: [], mismatch: [], missing: [], gaps: [] }
  const total = Array.isArray(records) ? records.length : 0
  for (let i = 0; i < total; i += 1) {
    const rec = records[i]
    const cmp = compareDirection(authOf(rec), downOf(rec))
    const target = cmp.kind === 'match' ? buckets.matched
      : cmp.kind === 'mismatch' ? buckets.mismatch
        : cmp.kind === 'missing' ? buckets.missing
          : buckets.gaps
    target.push({ record: rec, cmp })
  }
  buckets.total = total
  return buckets
}

module.exports = {
  DIRECTION_DOMAIN,
  DIRECTION_UNSPECIFIED,
  classifyDirection,
  expectedDirection,
  compareDirection,
  bucketDirections,
}

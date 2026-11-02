'use strict'
/**
 * WP-A3 / A3-3 方向期望负向验证（第二层）
 * ────────────────────────────────────────────────
 * 目的：证明「测试期望侧」不再与被测产品的兜底逻辑同构，
 *       并能识别「未知方向被兜底成 right」这类错误实现。
 *
 * 覆盖：
 *   ① 合法方向 left / right 被正确分类
 *   ② null / 缺失 / 非法值一律不被归为合法方向
 *   ③ 期望值对未知方向返回 unspecified，永不返回 right
 *   ④ 严格比对：left≠right、下游缺失不算通过
 *   ⑤ 反自证（变异验证）：旧兜底逻辑会把 null 判成 match，新逻辑必须判成 gap
 *   ⑥ 分桶守恒：不存在被 `x.dir &&` 之类条件静默丢弃的样本
 *
 * 用法：node worker/e2e-direction.test.cjs
 */
const {
  DIRECTION_DOMAIN,
  DIRECTION_UNSPECIFIED,
  classifyDirection,
  expectedDirection,
  compareDirection,
  bucketDirections,
} = require('./e2e-direction.cjs')

let pass = 0
let failed = 0
function check(name, cond, extra) {
  if (cond) {
    pass += 1
    console.log(`  ✓ ${name}`)
  } else {
    failed += 1
    console.log(`  ✗ ${name}${extra !== undefined ? ' → ' + JSON.stringify(extra) : ''}`)
  }
}

console.log('=== 一、合法方向域 ===')
{
  check('合法域只含 left / right', DIRECTION_DOMAIN.length === 2 && DIRECTION_DOMAIN.includes('left') && DIRECTION_DOMAIN.includes('right'), DIRECTION_DOMAIN)
  const l = classifyDirection('left')
  const r = classifyDirection('right')
  check("'left' ⇒ legal=true, direction=left", l.legal === true && l.direction === 'left', l)
  check("'right' ⇒ legal=true, direction=right", r.legal === true && r.direction === 'right', r)
}

console.log('\n=== 二、null / 缺失 / 非法方向不得被视为合法 ===')
{
  const cases = [
    ['null', null, 'null'],
    ['undefined（缺失）', undefined, 'missing'],
    ["空字符串", '', 'invalid'],
    ["大写 'LEFT'", 'LEFT', 'invalid'],
    ["非法 'up'", 'up', 'invalid'],
    ["带空格 ' left'", ' left', 'invalid'],
    ["数字 0", 0, 'invalid'],
    ["布尔 true", true, 'invalid'],
  ]
  for (const [label, raw, wantState] of cases) {
    const c = classifyDirection(raw)
    check(`${label} ⇒ state=${wantState} 且 legal=false`, c.state === wantState && c.legal === false, c)
    check(`${label} ⇒ 期望值不是 'right'`, expectedDirection(raw) !== 'right', expectedDirection(raw))
    check(`${label} ⇒ 期望值 = unspecified`, expectedDirection(raw) === DIRECTION_UNSPECIFIED, expectedDirection(raw))
  }
}

console.log('\n=== 三、合法方向的期望值原样返回（不得互相颠倒） ===')
{
  check("'left' ⇒ 期望 'left'（不得判成 right）", expectedDirection('left') === 'left', expectedDirection('left'))
  check("'right' ⇒ 期望 'right'（不得判成 left）", expectedDirection('right') === 'right', expectedDirection('right'))
}

console.log('\n=== 四、严格比对：合法方向必须逐台相等 ===')
{
  check("left vs left ⇒ match", compareDirection('left', 'left').kind === 'match')
  check("right vs right ⇒ match", compareDirection('right', 'right').kind === 'match')
  check("left vs right ⇒ mismatch（合法 left 不得被判成 right）", compareDirection('left', 'right').kind === 'mismatch')
  check("right vs left ⇒ mismatch（合法 right 不得被判成 left）", compareDirection('right', 'left').kind === 'mismatch')
  check("left vs '' ⇒ missing（下游缺失不得跳过）", compareDirection('left', '').kind === 'missing')
  check("left vs null ⇒ missing", compareDirection('left', null).kind === 'missing')
  check("left vs 'up' ⇒ missing（下游非法不算通过）", compareDirection('left', 'up').kind === 'missing')
}

console.log('\n=== 五、权威方向未知 ⇒ 契约缺口（不是 match，也不是产品失败） ===')
{
  const cases = [
    [null, 'right'],
    [undefined, 'right'],
    ['', 'right'],
    ['up', 'right'],
  ]
  for (const [auth, down] of cases) {
    const c = compareDirection(auth, down)
    check(`${JSON.stringify(auth)} vs 'right' ⇒ gap（不得 match）`, c.kind === 'gap', c)
    check(`${JSON.stringify(auth)} vs 'right' ⇒ 未被当作合法 right`, c.auth.legal === false, c.auth)
  }
}

console.log('\n=== 六、反自证（变异验证）：旧兜底期望无法发现缺陷 ===')
{
  // 旧实现（缺陷版）：期望侧与产品兜底同构
  const legacyExpected = (v) => (String(v) === 'left' ? 'left' : 'right')
  for (const [auth, down] of [[null, 'right'], [undefined, 'right'], ['up', 'right']]) {
    const legacy = legacyExpected(auth) === down ? 'match' : 'mismatch'
    const current = compareDirection(auth, down).kind
    check(`旧期望把 ${JSON.stringify(auth)} 判成 match（缺陷确实存在，可被复现）`, legacy === 'match', legacy)
    check(`新期望把 ${JSON.stringify(auth)} 判成 gap（不再自证）`, current === 'gap', current)
  }
  check("旧期望把合法 'left' 与 'left' 比对仍为 match（合法场景未被误伤）",
    (legacyExpected('left') === 'left' ? 'match' : 'mismatch') === 'match')
  check("新期望对合法 'left' 与 'right' 判 mismatch（真缺陷可被发现）",
    compareDirection('left', 'right').kind === 'mismatch')
}

console.log('\n=== 七、分桶守恒：无样本被静默丢弃 ===')
{
  const records = [
    { id: 'a', authRaw: 'left', downRaw: 'left' },      // match
    { id: 'b', authRaw: 'right', downRaw: 'right' },    // match
    { id: 'c', authRaw: 'left', downRaw: 'right' },     // mismatch
    { id: 'd', authRaw: null, downRaw: 'right' },       // gap
    { id: 'e', authRaw: 'left', downRaw: '' },          // missing（旧实现会被 x.dir && 跳过）
    { id: 'f', authRaw: 'up', downRaw: 'right' },       // gap
  ]
  const b = bucketDirections(records)
  check('total === 输入条数', b.total === records.length, b.total)
  check('四个桶条数之和 === 输入条数', b.matched.length + b.mismatch.length + b.missing.length + b.gaps.length === records.length,
    { matched: b.matched.length, mismatch: b.mismatch.length, missing: b.missing.length, gaps: b.gaps.length })
  check('match 桶只含两侧都合法的记录', b.matched.every((x) => x.cmp.auth.legal && x.cmp.down.legal), b.matched.map((x) => x.record.id))
  check('mismatch 桶 = {c}', b.mismatch.length === 1 && b.mismatch[0].record.id === 'c', b.mismatch.map((x) => x.record.id))
  check('missing 桶含空方向记录 e（不得被跳过）', b.missing.length === 1 && b.missing[0].record.id === 'e', b.missing.map((x) => x.record.id))
  check('gaps 桶 = {d,f}（未知方向记为契约缺口）', b.gaps.length === 2, b.gaps.map((x) => x.record.id))
  check('未知方向记录不出现在 match 桶', b.matched.every((x) => x.record.id !== 'd' && x.record.id !== 'f'), b.matched.map((x) => x.record.id))
}

console.log('\n=== 八、分桶允许自定义取值器 ===')
{
  const b = bucketDirections(
    [{ id: 'x', myAuth: 'left', myDown: 'right' }],
    (r) => r.myAuth,
    (r) => r.myDown,
  )
  check('自定义取值器生效', b.mismatch.length === 1 && b.mismatch[0].record.id === 'x', b.mismatch.map((x) => x.record.id))
}

console.log(`\n=== 方向负向验证：${pass} 通过 / ${failed} 失败 ===`)
process.exit(failed ? 1 : 0)

#!/usr/bin/env node
// 部署守卫测试：
//   · 占位符 / 全零 / 缺失 / 无绑定 / 路径错误 / 畸形 TOML 必须拒绝；
//   · 目标 DB 绑定缺失、其它绑定合法但 DB 绑定无效必须拒绝；
//   · 合法 UUID 必须通过。
// 仅使用本地临时夹具，不连接任何远端资源。
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const guard = resolve(__dirname, 'check-d1-config.mjs')
const realConfig = resolve(__dirname, '..', 'wrangler.toml')
const dir = mkdtempSync(join(tmpdir(), 'd1-guard-'))

const VALID_UUID = '12345678-1234-1234-1234-1234567890ab'
const PLACEHOLDER = '<REPLACE_WITH_D1_DATABASE_ID>'

let pass = 0
let fail = 0

function fixture(name, content) {
  const p = join(dir, name)
  writeFileSync(p, content)
  return p
}

function run(args) {
  return spawnSync(process.execPath, [guard, ...args], { encoding: 'utf8' })
}

function expect(name, res, expectedCode, mustInclude) {
  const out = `${res.stdout || ''}${res.stderr || ''}`
  const ok = res.status === expectedCode && (!mustInclude || out.includes(mustInclude))
  console.log(`  ${ok ? '✓' : '✗'} ${name}（exit=${res.status}，期望 ${expectedCode}）`)
  if (ok) pass += 1
  else {
    fail += 1
    console.log(`    stdout: ${(res.stdout || '').trim()}`)
    console.log(`    stderr: ${(res.stderr || '').trim()}`)
  }
}

function assertTrue(name, cond) {
  console.log(`  ${cond ? '✓' : '✗'} ${name}`)
  if (cond) pass += 1
  else fail += 1
}

const db = (id) => `[[d1_databases]]\nbinding = "DB"\ndatabase_name = "smart-fire-db"\ndatabase_id = "${id}"\n`

try {
  // ── 基础拒绝 ──
  expect('真实 wrangler.toml（占位符）被拒绝', run([realConfig]), 1)
  expect('占位符 fixture 被拒绝', run([fixture('placeholder.toml', db(PLACEHOLDER))]), 1)
  expect('全零 UUID 被拒绝', run([fixture('zero.toml', db('00000000-0000-0000-0000-000000000000'))]), 1)
  expect('缺少 database_id 被拒绝', run([fixture('missing-id.toml', '[[d1_databases]]\nbinding = "DB"\n')]), 1)
  expect('无 D1 绑定被拒绝', run([fixture('no-d1.toml', 'name = "x"\n')]), 1)
  expect('不存在的路径被拒绝', run([join(dir, 'not-exist.toml')]), 1)
  expect('目录作为配置被拒绝', run([dir]), 1)

  // ── 畸形 TOML（不得静默跳过）──
  expect('畸形：缺少等号被拒绝', run([fixture('malformed-no-eq.toml',
    `[[d1_databases]]\nbinding "DB"\ndatabase_id = "${VALID_UUID}"\n`)]), 1)
  expect('畸形：字符串未闭合被拒绝', run([fixture('malformed-string.toml',
    `[[d1_databases]]\nbinding = "DB"\ndatabase_id = "12345678-1234\n`)]), 1)
  expect('畸形：表头格式非法被拒绝', run([fixture('malformed-header.toml',
    `[[d1_databases]\nbinding = "DB"\ndatabase_id = "${VALID_UUID}"\n`)]), 1)
  expect('畸形：值无法识别被拒绝', run([fixture('malformed-value.toml',
    `[[d1_databases]]\nbinding = "DB"\ndatabase_id = not-a-value\n`)]), 1)
  expect('畸形：键重复被拒绝', run([fixture('malformed-dup-key.toml',
    `[[d1_databases]]\nbinding = "DB"\nbinding = "DB"\ndatabase_id = "${VALID_UUID}"\n`)]), 1)

  // ── 绑定选择准确性 ──
  expect('目标 DB 绑定缺失（仅 OTHER）被拒绝', run([fixture('only-other.toml',
    `[[d1_databases]]\nbinding = "OTHER"\ndatabase_name = "other-db"\ndatabase_id = "${VALID_UUID}"\n`)]), 1)
  expect('其它绑定合法但 DB 绑定无效被拒绝', run([fixture('other-valid-db-invalid.toml',
    `[[d1_databases]]\nbinding = "OTHER"\ndatabase_id = "${VALID_UUID}"\n\n` + db(PLACEHOLDER))]), 1)
  expect('其它绑定在前、DB 绑定合法时通过', run([fixture('other-then-db-valid.toml',
    `[[d1_databases]]\nbinding = "OTHER"\ndatabase_id = "abcdef01-2345-6789-abcd-ef0123456789"\n\n` + db(VALID_UUID))]), 0)

  // ── 合法配置 ──
  expect('合法 UUID 通过', run([fixture('valid.toml', db(VALID_UUID))]), 0)
  expect('合法 UUID + 行内注释通过', run([fixture('valid-comment.toml',
    `[[d1_databases]]\nbinding = "DB" # 绑定名\ndatabase_id = "${VALID_UUID}" # 真实 ID\n`)]), 0)
  expect('顶层键 + 合法 D1 通过', run([fixture('valid-toplevel.toml',
    `name = "smart-fire-api"\nmain = "src/index.ts"\n\n` + db(VALID_UUID))]), 0)

  // ── 数组元素语法（复用标量解析；不支持即 fail-closed）──
  const withExtra = (extra) => `${db(VALID_UUID)}\n${extra}\n`
  expect('数组：未加引号元素被拒绝', run([fixture('array-bare.toml', withExtra('list = [foo]'))]), 1)
  expect('数组：中间空元素被拒绝', run([fixture('array-empty-elem.toml', withExtra('list = ["a", , "b"]'))]), 1)
  expect('数组：内联表元素被拒绝', run([fixture('array-inline-table.toml', withExtra('list = [{ a = 1 }]'))]), 1)
  expect('数组：未转义内嵌引号被拒绝', run([fixture('array-bad-quote.toml', withExtra('list = ["a"b"]'))]), 1)
  // 显式构造：JS 字符串中的 \\" 即“反斜杠 + 引号”，对应 TOML 的 \" 转义
  const escapedQuoteLine = 'list = ["a\\"b"]'
  const escapedQuotePath = fixture('array-escaped-quote.toml', withExtra(escapedQuoteLine))
  const escapedQuoteContent = readFileSync(escapedQuotePath, 'utf8')
  console.log(`    [fixture] array-escaped-quote.toml 实际行: ${JSON.stringify(escapedQuoteLine)}`)
  assertTrue('转义引号夹具写入预期 TOML 行', escapedQuoteContent.split(/\r?\n/).includes(escapedQuoteLine))
  expect('数组：合法转义引号通过', run([escapedQuotePath]), 0)
  expect('数组：嵌套数组通过', run([fixture('array-nested.toml', withExtra('list = [[1, 2], [3]]'))]), 0)
  expect('数组：尾逗号通过', run([fixture('array-trailing-comma.toml', withExtra('list = ["a", ]'))]), 0)
  expect('数组：空数组通过', run([fixture('array-empty.toml', withExtra('list = []'))]), 0)

  // ── 重复表头 ──
  expect('重复普通表头 [vars] 被拒绝', run([fixture('dup-table.toml',
    `${db(VALID_UUID)}\n[vars]\nA = "1"\n\n[vars]\nB = "2"\n`)]), 1)

  // ── JSON / JSONC 边界 ──
  expect('标准 JSON 合法通过', run([fixture('valid.json',
    JSON.stringify({ d1_databases: [{ binding: 'DB', database_id: VALID_UUID }] }))]), 0)
  expect('标准 JSON 占位符被拒绝', run([fixture('bad.json',
    JSON.stringify({ d1_databases: [{ binding: 'DB', database_id: PLACEHOLDER }] }))]), 1)
  expect('JSONC 显式拒绝并提示', run([fixture('config.jsonc',
    `{ // comment\n  "d1_databases": [{ "binding": "DB", "database_id": "${VALID_UUID}" }]\n}`)]), 1, 'JSONC')

  // ── 数字 / 日期边界（声明支持 vs 实际逻辑）──
  expect('数字：整数 database_id 被拒绝（非 UUID 字符串）', run([fixture('num-int.toml',
    `[[d1_databases]]\nbinding = "DB"\ndatabase_id = 12345\n`)]), 1)
  expect('数字：十进制小数/指数通过', run([fixture('num-float.toml',
    `name = 1.5e3\n` + db(VALID_UUID))]), 0)
  expect('数字：负数通过', run([fixture('num-negative.toml',
    `name = -0.5\n` + db(VALID_UUID))]), 0)
  expect('数字：下划线分隔被拒绝（不支持）', run([fixture('num-underscore.toml',
    `name = 1_000\n` + db(VALID_UUID))]), 1)
  expect('数字：十六进制被拒绝（不支持）', run([fixture('num-hex.toml',
    `name = 0x1F\n` + db(VALID_UUID))]), 1)
  expect('数字：inf 被拒绝（不支持）', run([fixture('num-inf.toml',
    `name = inf\n` + db(VALID_UUID))]), 1)
  expect('日期时间被拒绝（不支持）', run([fixture('date.toml',
    `name = 1979-05-27\n` + db(VALID_UUID))]), 1)

  // ── 提取准确性：非 D1 表的 binding/database_id 不得顶替 ──
  expect('vars 表的 binding/database_id 不参与 D1 判定', run([fixture('vars-not-d1.toml',
    `[vars]\nbinding = "DB"\ndatabase_id = "${VALID_UUID}"\n\n[[d1_databases]]\nbinding = "OTHER"\ndatabase_id = "${VALID_UUID}"\n`)]), 1)
  expect('vars 里合法 database_id 不能顶替 DB 绑定的占位符', run([fixture('vars-cannot-substitute.toml',
    `[vars]\ndatabase_id = "${VALID_UUID}"\n\n` + db(PLACEHOLDER))]), 1)
  expect('D1 字段含非 UUID 转义内容时仍被拒绝', run([fixture('d1-escape.toml',
    `[[d1_databases]]\nbinding = "DB"\ndatabase_id = "abc\\q"\n`)]), 1)
  // ── C1–C7：跨配置隔离比对（--compare）──
  // 规则：主配置（trial）必须合法 UUID；对照配置（生产）仅「精确占位符」可降级为 WARN，
  //       其余非 UUID 一律拒绝；两侧 UUID 相同 → 拒绝。
  const TRIAL_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
  const PROD_ID = '11111111-2222-3333-4444-555555555555'
  const trialDb = (id) => `[[d1_databases]]\nbinding = "DB"\ndatabase_name = "smart-fire-db-trial"\ndatabase_id = "${id}"\n`
  const trialCfg = fixture('trial-valid.toml', trialDb(TRIAL_ID))
  const prodCfg = fixture('prod-valid.toml', trialDb(PROD_ID))
  const prodPlaceholder = fixture('prod-placeholder.toml', trialDb(PLACEHOLDER))
  const prodZero = fixture('prod-zero.toml', trialDb('00000000-0000-0000-0000-000000000000'))
  const prodGarbage = fixture('prod-garbage.toml', trialDb('not-a-uuid-value'))

  expect('C1 两侧 UUID 不同 → 通过', run([trialCfg, '--compare', prodCfg]), 0, '隔离比对通过')
  expect('C2 两侧 UUID 相同 → 拒绝', run([trialCfg, '--compare', trialCfg]), 1, '相同的 database_id')
  expect('C3 生产为精确占位符 → 通过 + WARN', run([trialCfg, '--compare', prodPlaceholder]), 0, 'WARN')
  expect('C4 trial 为占位符 → 拒绝', run([prodPlaceholder, '--compare', prodCfg]), 1)
  expect('C5a 对照配置为全零 → 拒绝', run([trialCfg, '--compare', prodZero]), 1)
  expect('C5b 对照配置为非 UUID 非占位符 → 拒绝', run([trialCfg, '--compare', prodGarbage]), 1)
  expect('C6 compare 路径不存在 → 拒绝', run([trialCfg, '--compare', join(dir, 'no-such.toml')]), 1, '不存在')
  expect('C7 --compare 缺值 → 拒绝', run([trialCfg, '--compare']), 1, '缺少配置路径')

  // ── C8–C14：F-1 多绑定约束 / F-2 占位符收紧 / F-3 严格参数解析 ──
  const TRIAL_PLACEHOLDER = '<REPLACE_WITH_TRIAL_D1_DATABASE_ID>'
  const dbTwo = (id1, id2) =>
    `[[d1_databases]]\nbinding = "DB"\ndatabase_name = "a"\ndatabase_id = "${id1}"\n\n` +
    `[[d1_databases]]\nbinding = "DB"\ndatabase_name = "b"\ndatabase_id = "${id2}"\n`
  const trialPlaceholderCfg = fixture('trial-placeholder.toml', trialDb(TRIAL_PLACEHOLDER))
  const dupMain = fixture('dup-main.toml', dbTwo(TRIAL_ID, PROD_ID))
  const dupCompare = fixture('dup-compare.toml', dbTwo(PROD_ID, '99999999-8888-7777-6666-555555555555'))

  expect('C8 主配置存在 2 个 DB 绑定 → 拒绝（不静默取第一个）', run([dupMain]), 1, '恰好 1 个')
  expect('C9 对照配置存在 2 个 DB 绑定 → 拒绝', run([trialCfg, '--compare', dupCompare]), 1, '恰好 1 个')
  expect('C10 对照配置为 Trial 占位符 → 拒绝（F-2 收紧）', run([trialCfg, '--compare', trialPlaceholderCfg]), 1)
  expect('C11 未知参数 → 拒绝', run([trialCfg, '--evil']), 1, '参数顺序非法')
  expect('C12 第二个位置参数（非 --compare）→ 拒绝', run([trialCfg, prodCfg]), 1, '参数顺序非法')
  expect('C13 重复 --compare → 拒绝', run([trialCfg, '--compare', prodCfg, '--compare', prodCfg]), 1, '参数过多')
  expect('C14 裸 -- → 拒绝', run([trialCfg, '--']), 1, '--')

  // ── C15–C18：F-3 严格顺序（--compare 只能在主配置之后）──
  expect('C15 反向顺序 --compare prod trial → 拒绝', run(['--compare', prodCfg, trialCfg]), 1, '参数顺序非法')
  expect('C16 --compare 后多余参数 → 拒绝', run([trialCfg, '--compare', prodCfg, 'extra.toml']), 1, '参数过多')
  expect('C17 --compare 后跟选项而非路径 → 拒绝', run([trialCfg, '--compare', '--evil']), 1, '缺少配置路径')
  expect('C18 首参为裸 -- → 拒绝', run(['--', trialCfg]), 1, '--')

  // ── C19–C22：UUID 大小写归一化与格式边界 ──
  const UPPER_SAME = '0D92D71A-2658-4EC1-BC16-13C9628FAB80'
  const LOWER_SAME = '0d92d71a-2658-4ec1-bc16-13c9628fab80'
  const upperCfg = fixture('c19-upper.toml', trialDb(UPPER_SAME))
  const lowerCfg = fixture('c19-lower.toml', trialDb(LOWER_SAME))

  expect('C19 同一 UUID 大小写不同 → 拒绝（归一化比较）', run([upperCfg, '--compare', lowerCfg]), 1, '相同的 database_id')
  expect('C20 大写合法 UUID 单配置 → 通过', run([upperCfg]), 0)
  expect('C21 长度少 1 位 → 拒绝', run([fixture('c21-short.toml', trialDb('0d92d71a-2658-4ec1-bc16-13c9628fab8'))]), 1)
  expect('C22 含非 hex 字符 → 拒绝', run([fixture('c22-nonhex.toml', trialDb('zz92d71a-2658-4ec1-bc16-13c9628fab80'))]), 1)
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log(`\n=== 部署守卫测试：${pass} 通过 / ${fail} 失败 ===`)
process.exit(fail ? 1 : 0)

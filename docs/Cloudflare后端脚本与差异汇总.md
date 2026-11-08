# Cloudflare 后端脚本与差异汇总（转义夹具 / 包装器错误处理收尾后更新）

> 用途：供人工查阅脚本全文、配置全文与差异。
> 说明：`worker/scripts/` 为未跟踪目录，普通 `git diff` 不显示其内容，故第 5 节附 `git diff --no-index -- /dev/null <file>`。

## 目录

1. 脚本源码（6 个）
2. `worker/package.json` 完整内容
3. `worker/wrangler.toml` 完整内容
4. `git diff`（已跟踪改动）
5. 脚本的 `git diff --no-index -- /dev/null <file>`

---

## 1. 脚本源码

### 1.1 `worker/scripts/check-d1-config.mjs`

```javascript
#!/usr/bin/env node
// 部署前守卫：确保 D1 database_id 已替换为真实 UUID。
//
// 边界：
//   · 仅检查配置文件本身，不连接任何远端资源；
//   · 读取失败 / 解析失败 / 畸形 TOML / 找不到目标 DB 绑定 / 占位符 / 全零 / 非法 UUID
//     一律拒绝（fail-closed），绝不静默跳过无法识别的行；
//   · 通过 `npm run deploy` 时先于 `wrangler deploy` 执行；本地 dev 与 dry-run 构建不经过本脚本。
//
// 支持的配置格式与范围（这是面向本项目的严格子集解析器，不是完整 TOML 解析器；
// 超出范围一律 fail-closed）：
//   · wrangler.toml：严格子集
//       - 表头：[name] / [[name]]（普通表不可重复定义；数组表可重复）
//       - 键：bare key（A-Za-z0-9_.-）
//       - 字符串：单行；正确识别引号闭合与 \" 转义；
//                 不逐一校验 \b \t \n \f \r \uXXXX 等转义序列的 TOML 合法性
//                 （该限制不影响 D1 字段判定：UUID 不含反斜杠）
//       - 数字：十进制整数 / 小数 / 指数；不支持下划线、0x/0o/0b、inf/nan
//       - 布尔：true / false
//       - 数组：标量元素 / 嵌套数组 / 尾逗号；不支持内联表 {..}、跨行数组
//       - 不支持：多行字符串 """ / '''、日期时间、点号键
//   · wrangler.json：仅标准 JSON（JSON.parse），不支持注释与尾逗号。
//   · wrangler.jsonc：显式拒绝（不宣称支持 JSONC）。
//
// 用法：
//   node scripts/check-d1-config.mjs                 # 检查当前 Worker 配置（worker/wrangler.toml）
//   node scripts/check-d1-config.mjs <configPath>    # 检查指定配置（仅测试夹具使用）
// 退出码：0 = 通过；1 = 拒绝
import { readFileSync, existsSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const WORKER_DIR = resolve(__dirname, '..')
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ALL_ZERO = '00000000-0000-0000-0000-000000000000'
const BARE_KEY_RE = /^[A-Za-z0-9_.-]+$/
const TABLE_RE = /^\[\[([A-Za-z0-9_.-]+)\]\]$/
const ARRAY_TABLE_RE = /^\[([A-Za-z0-9_.-]+)\]$/
const NUMBER_RE = /^[+-]?(\d+(\.\d+)?|\.\d+)([eE][+-]?\d+)?$/

function fail(msg) {
  console.error(`\n[D1 配置守卫] ❌ 拒绝部署：${msg}\n`)
  process.exit(1)
}

/** 定位当前 Worker 配置：显式参数优先，否则在 worker 目录按优先级查找；找不到即失败（不放行）。 */
function locateConfig() {
  const explicit = process.argv[2]
  if (explicit) {
    const p = resolve(process.cwd(), explicit)
    if (!existsSync(p)) fail(`指定的配置文件不存在：${p}`)
    if (!statSync(p).isFile()) fail(`指定的路径不是文件：${p}`)
    return p
  }
  const candidates = ['wrangler.toml', 'wrangler.jsonc', 'wrangler.json'].map((f) => resolve(WORKER_DIR, f))
  const found = candidates.find((p) => existsSync(p) && statSync(p).isFile())
  if (!found) fail(`无法定位 Worker 配置（已查找：${candidates.join(', ')}）`)
  return found
}

/** 去掉 TOML 行内注释（引号内、含 \" 转义的 # 不算注释）。 */
function stripTomlComment(line) {
  let quote = null
  let escaped = false
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    if (quote) {
      if (escaped) { escaped = false; continue }
      if (ch === '\\' && quote === '"') { escaped = true; continue }
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") { quote = ch; continue }
    if (ch === '#') return line.slice(0, i)
  }
  return line
}

/** 在字符串 / 数组之外寻找第一个 '='；找不到返回 -1。 */
function findEquals(line) {
  let quote = null
  let escaped = false
  let depth = 0
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    if (quote) {
      if (escaped) { escaped = false; continue }
      if (ch === '\\' && quote === '"') { escaped = true; continue }
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") { quote = ch; continue }
    if (ch === '[') { depth += 1; continue }
    if (ch === ']') { depth -= 1; continue }
    if (ch === '=' && depth === 0) return i
  }
  return -1
}

/** 校验数组括号与引号平衡（含 \" 转义）。 */
function assertBalanced(value, lineNo, source) {
  let quote = null
  let escaped = false
  let depth = 0
  for (const ch of value) {
    if (quote) {
      if (escaped) { escaped = false; continue }
      if (ch === '\\' && quote === '"') { escaped = true; continue }
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") { quote = ch; continue }
    if (ch === '[') depth += 1
    else if (ch === ']') {
      depth -= 1
      if (depth < 0) fail(`第 ${lineNo} 行数组括号不平衡（${source}）`)
    }
  }
  if (depth !== 0 || quote) fail(`第 ${lineNo} 行值不完整（${source}）`)
}

/** 解析带引号的字符串；未闭合 / 内部未转义引号一律失败。 */
function parseQuoted(value, quote, lineNo, source) {
  if (value.length < 2 || !value.endsWith(quote)) fail(`第 ${lineNo} 行字符串未闭合（${source}）`)
  const inner = value.slice(1, -1)
  let escaped = false
  for (const ch of inner) {
    if (escaped) { escaped = false; continue }
    if (ch === '\\' && quote === '"') { escaped = true; continue }
    if (ch === quote) fail(`第 ${lineNo} 行字符串内存在未转义引号（${source}）`)
  }
  return inner
}

/** 解析标量：字符串 / 数字 / 布尔；其它一律失败。 */
function parseScalar(value, lineNo, source) {
  if (value.startsWith('"')) return parseQuoted(value, '"', lineNo, source)
  if (value.startsWith("'")) return parseQuoted(value, "'", lineNo, source)
  if (value === 'true' || value === 'false') return value
  if (NUMBER_RE.test(value)) return value
  fail(`第 ${lineNo} 行无法识别的值：${value}（${source}）`)
}

/** 按顶层逗号切分数组内部（忽略字符串内、嵌套数组内的逗号）。 */
function splitTopLevel(inner) {
  const parts = []
  let cur = ''
  let quote = null
  let escaped = false
  let depth = 0
  for (const ch of inner) {
    if (quote) {
      cur += ch
      if (escaped) { escaped = false; continue }
      if (ch === '\\' && quote === '"') { escaped = true; continue }
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue }
    if (ch === '[') { depth += 1; cur += ch; continue }
    if (ch === ']') { depth -= 1; cur += ch; continue }
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; continue }
    cur += ch
  }
  parts.push(cur)
  return parts
}

/** 解析并校验数组元素（复用 parseScalar；内联表 / 非法元素 fail-closed）。 */
function parseArray(value, lineNo, source) {
  if (!value.endsWith(']')) fail(`第 ${lineNo} 行数组未闭合（${source}）`)
  assertBalanced(value, lineNo, source)
  const inner = value.slice(1, -1)
  const isEmptyArray = inner.trim() === ''
  const parts = splitTopLevel(inner)
  for (let i = 0; i < parts.length; i += 1) {
    const raw = parts[i].trim()
    if (!raw) {
      // 允许尾逗号 / 空数组；中间的连续逗号属于非法空元素
      if (i !== parts.length - 1 && !isEmptyArray) {
        fail(`第 ${lineNo} 行数组存在空元素（${source}）`)
      }
      continue
    }
    if (raw.startsWith('{')) fail(`第 ${lineNo} 行不支持内联表元素（${source}）`)
    if (raw.startsWith('[')) { parseArray(raw, lineNo, source); continue }
    parseScalar(raw, lineNo, source)
  }
  return value
}

/** 解析值：字符串 / 数字 / 布尔 / 数组；内联表、多行字符串等一律失败。 */
function parseValue(raw, lineNo, source) {
  const value = raw.trim()
  if (!value) fail(`第 ${lineNo} 行缺少值（${source}）`)
  if (value.startsWith('"""') || value.startsWith("'''")) fail(`第 ${lineNo} 行不支持多行字符串（${source}）`)
  if (value.startsWith('[')) return parseArray(value, lineNo, source)
  if (value.startsWith('{')) fail(`第 ${lineNo} 行不支持内联表（${source}）`)
  return parseScalar(value, lineNo, source)
}

/**
 * 严格解析 TOML 子集，返回所有表块。
 * 任何非空行要么是合法表头，要么是合法 key = value；否则直接失败（不跳过）。
 */
function parseTomlStrict(text, source) {
  const root = { type: 'root', name: '', entries: {}, lineNo: 0 }
  const tables = [root]
  const seenTables = new Map() // name -> 'table' | 'array'
  let current = root

  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i]
    const lineNo = i + 1
    const line = stripTomlComment(raw).trim()
    if (!line) continue

    if (line.startsWith('[')) {
      const arrayMatch = line.match(TABLE_RE)
      const tableMatch = line.match(ARRAY_TABLE_RE)
      if (!arrayMatch && !tableMatch) fail(`第 ${lineNo} 行表头格式非法：${raw.trim()}（${source}）`)
      const type = arrayMatch ? 'array' : 'table'
      const name = (arrayMatch || tableMatch)[1]
      const prev = seenTables.get(name)
      if (type === 'table') {
        if (prev) fail(`第 ${lineNo} 行重复定义表 [${name}]（${source}）`)
        seenTables.set(name, 'table')
      } else {
        if (prev === 'table') fail(`第 ${lineNo} 行表 ${name} 已定义为普通表，不能改为数组表（${source}）`)
        seenTables.set(name, 'array')
      }
      current = { type, name, entries: {}, lineNo }
      tables.push(current)
      continue
    }

    const eq = findEquals(line)
    if (eq < 0) fail(`第 ${lineNo} 行不是合法的 key = value：${raw.trim()}（${source}）`)
    const key = line.slice(0, eq).trim()
    if (!BARE_KEY_RE.test(key)) fail(`第 ${lineNo} 行键名非法：${key}（${source}）`)
    if (Object.prototype.hasOwnProperty.call(current.entries, key)) {
      fail(`第 ${lineNo} 行键重复：${key}（${source}）`)
    }
    current.entries[key] = parseValue(line.slice(eq + 1), lineNo, source)
  }
  return tables
}

/** 仅标准 JSON（wrangler.json）：不支持注释与尾逗号。 */
function parseD1FromJson(text) {
  const json = JSON.parse(text)
  return (json.d1_databases || []).map((d) => ({ binding: d.binding, database_id: d.database_id }))
}

const configPath = locateConfig()
const ext = configPath.toLowerCase().split('.').pop()
let dbBindingEntries
try {
  const text = readFileSync(configPath, 'utf8')
  if (ext === 'toml') {
    dbBindingEntries = parseTomlStrict(text, configPath)
      .filter((t) => t.type === 'array' && t.name === 'd1_databases')
      .filter((t) => String(t.entries.binding || '').trim() === 'DB')
      .map((t) => t.entries)
  } else if (ext === 'json') {
    dbBindingEntries = parseD1FromJson(text)
      .filter((d) => String(d.binding || '').trim() === 'DB')
  } else if (ext === 'jsonc') {
    fail(`不支持 JSONC（注释 / 尾逗号）；请改用 wrangler.toml 或标准 JSON 配置（${configPath}）`)
  } else {
    fail(`不支持的配置文件类型：${configPath}`)
  }
} catch (err) {
  fail(`读取/解析配置失败：${configPath}（${err.message}）`)
}

if (!dbBindingEntries.length) {
  fail(`未找到 binding = "DB" 的 [[d1_databases]] 绑定（${configPath}）`)
}

for (const entry of dbBindingEntries) {
  const id = String(entry.database_id || '').trim()
  if (!id) fail(`binding = "DB" 的绑定缺少 database_id（${configPath}）`)
  if (id === ALL_ZERO) fail(`binding = "DB" 的 database_id 仍为全零占位值（${configPath}）`)
  if (!UUID_RE.test(id)) {
    fail(`binding = "DB" 的 database_id 不是合法 UUID，疑似仍为占位符：${id}（${configPath}）`)
  }
}

const id = String(dbBindingEntries[0].database_id).trim()
console.log(`[D1 配置守卫] ✅ 通过：${configPath} → database_id=${id.slice(0, 8)}…（完整值已隐藏）`)

```

### 1.2 `worker/scripts/deploy-guarded.mjs`

```javascript
#!/usr/bin/env node
// 受守卫保护的正式部署入口：先校验 D1 配置，通过后才调用 wrangler deploy。
// 不依赖 shell 的 && 语义（Windows cmd / PowerShell / bash 行为一致）。
// 用法：npm run deploy   （构建检查请用 npm run deploy:dry-run）
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
export const WORKER_DIR = resolve(__dirname, '..')
const DEFAULT_CHECK = resolve(__dirname, 'check-d1-config.mjs')
const DEFAULT_WRANGLER = resolve(WORKER_DIR, 'node_modules', 'wrangler', 'bin', 'wrangler.js')

/**
 * 可注入依赖，便于完全本地的控制流测试（不执行真实部署）。
 * 正式入口调用时不传任何参数，使用真实路径与 process.execPath。
 */
export function runGuardedDeploy({
  workerDir = WORKER_DIR,
  checkScript = DEFAULT_CHECK,
  wranglerJs = DEFAULT_WRANGLER,
  args = [],
  spawn = spawnSync,
  nodePath = process.execPath,
  log = console,
} = {}) {
  // 1) 守卫必须通过，否则在调用 wrangler deploy 之前终止
  const guard = spawn(nodePath, [checkScript], { stdio: 'inherit', cwd: workerDir })
  if (guard.error) {
    log.error(`[deploy-guarded] ❌ 守卫无法启动：${guard.error.message}`)
    return 1
  }
  if (guard.signal) {
    log.error(`[deploy-guarded] ❌ 守卫被信号终止：${guard.signal}`)
    return 1
  }
  if (guard.status !== 0) {
    log.error('[deploy-guarded] ❌ 守卫未通过，已终止；未调用 wrangler deploy。')
    return guard.status || 1
  }

  // 2) 守卫通过后才真正部署
  if (!existsSync(wranglerJs)) {
    log.error(`[deploy-guarded] ❌ 找不到本地 wrangler：${wranglerJs}`)
    return 1
  }
  // 显式固定 cwd 为 worker 目录，确保 wrangler 实际读取的配置与守卫检查的一致
  const res = spawn(nodePath, [wranglerJs, 'deploy', ...args], { stdio: 'inherit', cwd: workerDir })
  if (res.error) {
    log.error(`[deploy-guarded] ❌ Wrangler 无法启动：${res.error.message}`)
    return 1
  }
  if (res.signal) {
    log.error(`[deploy-guarded] ❌ Wrangler 被信号终止：${res.signal}`)
    return 1
  }
  if (res.status === null || res.status === undefined) {
    log.error('[deploy-guarded] ❌ Wrangler 未返回正常退出码')
    return 1
  }
  return res.status
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  process.exit(runGuardedDeploy({ args: process.argv.slice(2) }))
}

```

### 1.3 `worker/scripts/check-d1-config.test.mjs`

```javascript
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
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log(`\n=== 部署守卫测试：${pass} 通过 / ${fail} 失败 ===`)
process.exit(fail ? 1 : 0)

```

### 1.4 `worker/scripts/deploy-guarded.test.mjs`

```javascript
#!/usr/bin/env node
// 部署包装器测试（完全本地，不执行真实部署）：
//   · 守卫失败 / 无法启动 / 被信号终止 → Wrangler 不得启动；
//   · 守卫通过 → Wrangler 以 deploy 启动，cwd 固定 worker，参数透传；
//   · Wrangler 无法启动 / 被信号终止 / 无正常退出码 → 返回非零（不误报成功）；
//   · 从不同工作目录调用时，守卫仍能定位 worker/wrangler.toml。
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runGuardedDeploy, WORKER_DIR } from './deploy-guarded.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const guardScript = resolve(__dirname, 'check-d1-config.mjs')

let pass = 0
let fail = 0

function check(name, cond, extra) {
  console.log(`  ${cond ? '✓' : '✗'} ${name}${extra !== undefined ? ` → ${JSON.stringify(extra)}` : ''}`)
  if (cond) pass += 1
  else fail += 1
}

function makeLog() {
  const lines = []
  return {
    lines,
    log: (...args) => lines.push(args.map((a) => String(a)).join(' ')),
    error: (...args) => lines.push(args.map((a) => String(a)).join(' ')),
  }
}

function makeSpawn(results) {
  const calls = []
  const spawn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts })
    const idx = calls.length - 1
    // 返回完整结果对象（保留 null / error / signal），不得用 ?? 0 吞掉失败状态
    return idx < results.length ? results[idx] : { status: 0 }
  }
  return { spawn, calls }
}

// 1) 守卫失败（退出码非零）→ 不启动 Wrangler
{
  const log = makeLog()
  const { spawn, calls } = makeSpawn([{ status: 1 }])
  const code = runGuardedDeploy({ spawn, wranglerJs: guardScript, nodePath: 'node', log })
  check('守卫失败时返回非零', code === 1, code)
  check('守卫失败时 spawn 仅一次（未启动 Wrangler）', calls.length === 1, calls.length)
  check('唯一一次调用是守卫脚本', calls[0]?.args?.[0] === guardScript)
}

// 2) 守卫无法启动（spawn error）→ 不启动 Wrangler，输出诊断
{
  const log = makeLog()
  const { spawn, calls } = makeSpawn([{ error: new Error('spawn node ENOENT'), status: null }])
  const code = runGuardedDeploy({ spawn, wranglerJs: guardScript, nodePath: 'node', log })
  check('守卫无法启动时返回非零', code === 1, code)
  check('守卫无法启动时不启动 Wrangler', calls.length === 1, calls.length)
  check('守卫无法启动时输出诊断', log.lines.join('\n').includes('守卫无法启动'))
}

// 3) 守卫被信号终止 → 不启动 Wrangler
{
  const log = makeLog()
  const { spawn, calls } = makeSpawn([{ status: null, signal: 'SIGTERM' }])
  const code = runGuardedDeploy({ spawn, wranglerJs: guardScript, nodePath: 'node', log })
  check('守卫被信号终止时返回非零', code === 1, code)
  check('守卫被信号终止时不启动 Wrangler', calls.length === 1, calls.length)
  check('守卫被信号终止时输出诊断', log.lines.join('\n').includes('信号'))
}

// 4) 守卫 status=null 且无 error/signal → 按失败处理
{
  const { spawn, calls } = makeSpawn([{ status: null }])
  const code = runGuardedDeploy({ spawn, wranglerJs: guardScript, nodePath: 'node', log: makeLog() })
  check('守卫 status=null 时返回非零', code === 1, code)
  check('守卫 status=null 时不启动 Wrangler', calls.length === 1, calls.length)
}

// 5) 守卫通过 → 启动 Wrangler，cwd 固定 worker，参数透传
{
  const { spawn, calls } = makeSpawn([{ status: 0 }, { status: 0 }])
  const code = runGuardedDeploy({ spawn, wranglerJs: guardScript, nodePath: 'node', args: ['--some-flag'], log: makeLog() })
  check('守卫通过时返回 0', code === 0, code)
  check('守卫通过时 spawn 两次', calls.length === 2, calls.length)
  check('第二次含 deploy', calls[1]?.args?.includes('deploy'), calls[1]?.args)
  check('第二次透传额外参数', calls[1]?.args?.includes('--some-flag'), calls[1]?.args)
  check('守卫 cwd = worker', calls[0]?.opts?.cwd === WORKER_DIR, calls[0]?.opts?.cwd)
  check('Wrangler cwd = worker', calls[1]?.opts?.cwd === WORKER_DIR, calls[1]?.opts?.cwd)
}

// 6) Wrangler 无法启动 → 返回非零（不误报成功）
{
  const log = makeLog()
  const { spawn, calls } = makeSpawn([{ status: 0 }, { error: new Error('spawn wrangler ENOENT'), status: null }])
  const code = runGuardedDeploy({ spawn, wranglerJs: guardScript, nodePath: 'node', log })
  check('Wrangler 无法启动时返回非零', code === 1, code)
  check('Wrangler 无法启动时确实调用了第二次 spawn', calls.length === 2, calls.length)
  check('Wrangler 无法启动时输出诊断', log.lines.join('\n').includes('Wrangler 无法启动'))
}

// 7) Wrangler 被信号终止 → 返回非零
{
  const log = makeLog()
  const { spawn } = makeSpawn([{ status: 0 }, { status: null, signal: 'SIGKILL' }])
  const code = runGuardedDeploy({ spawn, wranglerJs: guardScript, nodePath: 'node', log })
  check('Wrangler 被信号终止时返回非零', code === 1, code)
  check('Wrangler 被信号终止时输出诊断', log.lines.join('\n').includes('信号'))
}

// 8) Wrangler 无正常退出码（undefined）→ 返回非零
{
  const { spawn } = makeSpawn([{ status: 0 }, { status: undefined }])
  const code = runGuardedDeploy({ spawn, wranglerJs: guardScript, nodePath: 'node', log: makeLog() })
  check('Wrangler 无退出码时返回非零', code === 1, code)
}

// 9) 从不同工作目录调用守卫，仍定位 worker/wrangler.toml
{
  const repoRoot = resolve(WORKER_DIR, '..')
  const res = spawnSync(process.execPath, [guardScript], { cwd: repoRoot, encoding: 'utf8' })
  const out = `${res.stdout || ''}${res.stderr || ''}`
  check('从仓库根调用守卫：占位符被拒绝（exit=1）', res.status === 1, res.status)
  check('从仓库根调用守卫：输出指向 worker/wrangler.toml', /wrangler\.toml/.test(out))
}

console.log(`\n=== 部署包装器测试：${pass} 通过 / ${fail} 失败 ===`)
process.exit(fail ? 1 : 0)

```

### 1.5 `worker/scripts/seed-local.mjs`

```javascript
#!/usr/bin/env node
// 本地种子数据灌入（仅面向本机 Worker）。
// 请求地址固定为 http://127.0.0.1:8787，不接受环境变量或参数覆盖为远端地址。
// Token 通过环境变量 SEED_TOKEN 传入，绝不写入源码 / 配置 / Git，也不输出到日志。
//
// 用法：
//   PowerShell:  $env:SEED_TOKEN='<与本地 wrangler dev --var SEED_TOKEN 一致>'; npm run seed:local
//   bash:        SEED_TOKEN='<同上>' npm run seed:local
//
// 退出码：0 = 灌入成功；1 = 失败（缺少 Token / 鉴权失败 / 连接失败）
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SEED_URL = 'http://127.0.0.1:8787/api/v1/admin/seed'

/**
 * 可注入 env / fetch / log，便于本地测试（可精确统计请求次数）。
 * 正式入口调用时不传任何参数。
 */
export async function runSeed({
  env = process.env,
  fetchImpl = globalThis.fetch,
  log = console,
} = {}) {
  // 防御性断言：任何情况下都不允许非本机地址（地址本身固定，无覆盖入口）
  if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+\//.test(SEED_URL)) {
    log.error('[seed:local] ❌ 内部错误：seed:local 仅允许访问本机地址')
    return 1
  }

  const token = env.SEED_TOKEN
  if (!token || !token.trim()) {
    // 必须在发起任何网络请求之前退出
    log.error('[seed:local] ❌ 未设置 SEED_TOKEN，已取消（不会发送请求）。')
    log.error('  请先设置与本地 Worker 一致的令牌，例如：')
    log.error("    PowerShell:  $env:SEED_TOKEN='your-local-token'; npm run seed:local")
    log.error('    bash:        SEED_TOKEN=your-local-token npm run seed:local')
    log.error('  该脚本只访问 http://127.0.0.1:8787，不会连接生产环境。')
    return 1
  }

  try {
    const res = await fetchImpl(SEED_URL, {
      method: 'POST',
      headers: { 'X-Seed-Token': token.trim() },
    })
    const text = await res.text()
    let body = text
    try { body = JSON.parse(text) } catch { /* 保留原始文本 */ }

    if (res.ok) {
      log.log(`[seed:local] ✅ HTTP ${res.status}`, body)
      return 0
    }
    log.error(`[seed:local] ❌ HTTP ${res.status}`, body)
    return 1
  } catch (err) {
    log.error(`[seed:local] ❌ 无法连接本地 Worker（http://127.0.0.1:8787）：${err.message}`)
    log.error('  请确认已运行 `npm run dev`（wrangler dev，默认端口 8787）。')
    return 1
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  process.exit(await runSeed())
}

```

### 1.6 `worker/scripts/seed-local.test.mjs`

```javascript
#!/usr/bin/env node
// seed:local 行为测试（注入 fake fetch，完全本地，不发起真实网络请求）：
//   · Token 缺失：请求次数必须为 0（在发起网络请求之前退出）；
//   · Token 错误 / 正确：三态返回码正确，Token 不写入日志；
//   · 请求地址固定为本机，不可被覆盖。
import { runSeed } from './seed-local.mjs'

const LOCAL_URL = 'http://127.0.0.1:8787/api/v1/admin/seed'

let pass = 0
let fail = 0

function check(name, cond, extra) {
  console.log(`  ${cond ? '✓' : '✗'} ${name}${extra !== undefined ? ` → ${JSON.stringify(extra)}` : ''}`)
  if (cond) pass += 1
  else fail += 1
}

function makeFetch(handler) {
  const calls = []
  const fn = async (url, opts) => {
    calls.push({ url, opts })
    return handler(url, opts)
  }
  return { fn, calls }
}

function makeLog() {
  const lines = []
  return {
    lines,
    log: (...args) => lines.push(args.map((a) => String(a)).join(' ')),
    error: (...args) => lines.push(args.map((a) => String(a)).join(' ')),
  }
}

// 1) Token 缺失：必须在任何网络请求之前退出
{
  const f = makeFetch(() => { throw new Error('fetch 不应被调用') })
  const l = makeLog()
  const code = await runSeed({ env: {}, fetchImpl: f.fn, log: l })
  check('缺失 Token 返回非零', code === 1, code)
  check('缺失 Token 请求次数为 0', f.calls.length === 0, f.calls.length)
  check('缺失 Token 输出明确提示', l.lines.join('\n').includes('未设置 SEED_TOKEN'))
}

// 1.1) Token 仅为空白：同样在请求前退出
{
  const f = makeFetch(() => { throw new Error('fetch 不应被调用') })
  const l = makeLog()
  const code = await runSeed({ env: { SEED_TOKEN: '   ' }, fetchImpl: f.fn, log: l })
  check('空白 Token 返回非零', code === 1, code)
  check('空白 Token 请求次数为 0', f.calls.length === 0, f.calls.length)
}

// 2) Token 错误：服务器返回 403 → 非零退出，Token 不写入日志
{
  const f = makeFetch(async () => ({
    ok: false,
    status: 403,
    text: async () => '{"error":"无效的种子令牌（X-Seed-Token）"}',
  }))
  const l = makeLog()
  const code = await runSeed({ env: { SEED_TOKEN: 'wrong-token' }, fetchImpl: f.fn, log: l })
  check('错误 Token 返回非零', code === 1, code)
  check('错误 Token 请求次数为 1', f.calls.length === 1, f.calls.length)
  check('请求头携带 Token', f.calls[0]?.opts?.headers?.['X-Seed-Token'] === 'wrong-token')
  check('错误 Token 未写入日志', !l.lines.join('\n').includes('wrong-token'))
}

// 3) Token 正确：200 → 0，请求地址固定本机，Token 不写入日志
{
  const f = makeFetch(async () => ({ ok: true, status: 200, text: async () => '{"ok":true}' }))
  const l = makeLog()
  const code = await runSeed({ env: { SEED_TOKEN: 'secret-token' }, fetchImpl: f.fn, log: l })
  check('正确 Token 返回 0', code === 0, code)
  check('正确 Token 请求次数为 1', f.calls.length === 1, f.calls.length)
  check('请求地址固定为本机', f.calls[0]?.url === LOCAL_URL, f.calls[0]?.url)
  check('正确 Token 未写入日志', !l.lines.join('\n').includes('secret-token'))
}

// 4) 连接失败 / 非 JSON 错误响应：均非零退出
{
  const f = makeFetch(async () => { throw new Error('ECONNREFUSED') })
  const code = await runSeed({ env: { SEED_TOKEN: 'x' }, fetchImpl: f.fn, log: makeLog() })
  check('连接失败返回非零', code === 1, code)
}
{
  const f = makeFetch(async () => ({ ok: false, status: 500, text: async () => 'Internal Error' }))
  const code = await runSeed({ env: { SEED_TOKEN: 'x' }, fetchImpl: f.fn, log: makeLog() })
  check('非 JSON 错误响应返回非零', code === 1, code)
}

console.log(`\n=== seed:local 测试：${pass} 通过 / ${fail} 失败 ===`)
process.exit(fail ? 1 : 0)

```

---

## 2. `worker/package.json` 完整内容

```json
{
  "name": "smart-fire-api",
  "private": true,
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "node scripts/deploy-guarded.mjs",
    "deploy:dry-run": "wrangler deploy --dry-run",
    "check:deploy-config": "node scripts/check-d1-config.mjs",
    "test:deploy-guard": "node scripts/check-d1-config.test.mjs",
    "test:deploy-wrapper": "node scripts/deploy-guarded.test.mjs",
    "migrate:local": "wrangler d1 migrations apply smart-fire-db --local",
    "migrate:remote": "wrangler d1 migrations apply smart-fire-db --remote",
    "seed:local": "node scripts/seed-local.mjs",
    "test:seed-local": "node scripts/seed-local.test.mjs",
    "tail": "wrangler tail",
    "test:e2e": "node e2e-phase2.cjs",
    "test:e2e:browser": "node e2e-phase2-browser.cjs"
  },
  "dependencies": {
    "hono": "^4.6.0"
  },
  "devDependencies": {
    "@cloudflare/workers-types": "^5.20261001.1",
    "playwright-core": "^1.49.0",
    "wrangler": "^4.0.0",
    "ws": "^8.18.0"
  }
}

```

---

## 3. `worker/wrangler.toml` 完整内容

```toml
name = "smart-fire-api"
main = "src/index.ts"
compatibility_date = "2026-09-20"

# D1 数据库
# 本地开发 / E2E：无需真实 database_id —— wrangler dev 与 d1 execute --local
# 依据 binding + database_name 在 .wrangler/state 下创建本地 SQLite，不校验 database_id。
#
# 生产部署前（唯一需要真实 ID 的时机）：
#   1) 执行 `npx wrangler d1 create smart-fire-db`
#   2) 将返回的 database_id 替换下方占位符
# 正式部署请用 `npm run deploy`：它先运行 scripts/check-d1-config.mjs，
# 占位符未替换时在调用 wrangler deploy 之前直接失败退出（fail-closed）。
# 本地开发（wrangler dev）与构建检查（npm run deploy:dry-run）不经过该守卫。
[[d1_databases]]
binding = "DB"
database_name = "smart-fire-db"
database_id = "<REPLACE_WITH_D1_DATABASE_ID>"

# Durable Objects：DemoRoom 负责六阶段状态机的实时协调与 WebSocket 广播
[[durable_objects.bindings]]
name = "DEMO_ROOM"
class_name = "DemoRoom"
script_name = "smart-fire-api"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["DemoRoom"]

# 种子数据保护令牌（生产环境务必设置；缺失时种子接口 fail-closed，直接 501 禁用）
# ⚠️ 生产环境请勿写入本文件：应使用 `wrangler secret put SEED_TOKEN` 管理，
#   避免真实令牌进入源码 / wrangler.toml / Git。
# 本地开发需测试 seed 时，可临时 `wrangler dev --var SEED_TOKEN:xxx` 注入。
# [vars]
# SEED_TOKEN = "change-me"

```

---

## 4. `git diff`（已跟踪改动）

```diff
diff --git a/worker/package.json b/worker/package.json
index e049e44..be587e6 100644
--- a/worker/package.json
+++ b/worker/package.json
@@ -5,10 +5,15 @@
   "type": "module",
   "scripts": {
     "dev": "wrangler dev",
-    "deploy": "wrangler deploy",
-    "migrate:local": "wrangler d1 execute smart-fire-db --local --file=migrations/0001_init.sql",
-    "migrate:remote": "wrangler d1 execute smart-fire-db --remote --file=migrations/0001_init.sql",
-    "seed:local": "curl -X POST http://localhost:8787/api/v1/admin/seed",
+    "deploy": "node scripts/deploy-guarded.mjs",
+    "deploy:dry-run": "wrangler deploy --dry-run",
+    "check:deploy-config": "node scripts/check-d1-config.mjs",
+    "test:deploy-guard": "node scripts/check-d1-config.test.mjs",
+    "test:deploy-wrapper": "node scripts/deploy-guarded.test.mjs",
+    "migrate:local": "wrangler d1 migrations apply smart-fire-db --local",
+    "migrate:remote": "wrangler d1 migrations apply smart-fire-db --remote",
+    "seed:local": "node scripts/seed-local.mjs",
+    "test:seed-local": "node scripts/seed-local.test.mjs",
     "tail": "wrangler tail",
     "test:e2e": "node e2e-phase2.cjs",
     "test:e2e:browser": "node e2e-phase2-browser.cjs"
diff --git a/worker/src/index.ts b/worker/src/index.ts
index 5f5927c..68476d6 100644
--- a/worker/src/index.ts
+++ b/worker/src/index.ts
@@ -20,8 +20,16 @@ export { DemoRoom } from './durable/DemoRoom'
 
 const app = new Hono<{ Bindings: Env }>()
 
-// 开发期允许本地 Vite dev server 跨域；生产建议收紧为 Pages 域名
-app.use('*', cors())
+// CORS：生产只放行 Pages 正式域名；本地开发通过 ALLOWED_ORIGINS（逗号分隔）追加来源，
+// 不默认放行任意来源。origin 回调返回空串时 Hono 不下发 Access-Control-Allow-Origin，浏览器端即被拦截。
+const PROD_ORIGIN = 'https://smart-fire-platform.pages.dev'
+app.use('*', cors({
+  origin: (origin, c) => {
+    const extra = (c.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean)
+    const allowed = [PROD_ORIGIN, ...extra]
+    return allowed.includes(origin) ? origin : ''
+  },
+}))
 
 app.get('/healthz', (c) => c.json({ ok: true, service: 'smart-fire-api', version: 'v1' }))
 
diff --git a/worker/src/routes/admin.ts b/worker/src/routes/admin.ts
index 62feeb1..430ff32 100644
--- a/worker/src/routes/admin.ts
+++ b/worker/src/routes/admin.ts
@@ -7,13 +7,19 @@ export const adminRoute = new Hono<{ Bindings: Env }>()
 
 adminRoute.post('/seed', async (c) => {
   const token = c.env.SEED_TOKEN
-  if (token && c.req.header('X-Seed-Token') !== token) {
+  // fail-closed：未配置 SEED_TOKEN 时直接禁用种子接口，绝不默认开放
+  if (!token) {
+    return c.json({ error: '未配置 SEED_TOKEN，种子接口已禁用' }, 501)
+  }
+  if (c.req.header('X-Seed-Token') !== token) {
     return c.json({ error: '无效的种子令牌（X-Seed-Token）' }, 403)
   }
   try {
     const counts = await seed(c.env.DB)
     return c.json({ ok: true, seeded: counts })
   } catch (err) {
-    return c.json({ error: `种子数据写入失败：${(err as Error).message}` }, 500)
+    // 不向客户端泄露底层错误细节（表名 / SQL 错误等），完整信息仅记录到服务端日志
+    console.error('[seed] 种子数据写入失败', err)
+    return c.json({ error: '种子数据写入失败' }, 500)
   }
 })
diff --git a/worker/src/types.ts b/worker/src/types.ts
index 4ba7d73..ec15ffd 100644
--- a/worker/src/types.ts
+++ b/worker/src/types.ts
@@ -5,6 +5,8 @@ export interface Env {
   /** Demo Simulation Engine 的实时状态协调器（Durable Object） */
   DEMO_ROOM: DurableObjectNamespace
   SEED_TOKEN?: string
+  /** CORS 追加允许的来源（逗号分隔，仅本地开发用；生产默认仅放行 Pages 域名） */
+  ALLOWED_ORIGINS?: string
 }
 
 // ── Building ──
diff --git a/worker/wrangler.toml b/worker/wrangler.toml
index 51f31a3..954ecec 100644
--- a/worker/wrangler.toml
+++ b/worker/wrangler.toml
@@ -2,13 +2,20 @@ name = "smart-fire-api"
 main = "src/index.ts"
 compatibility_date = "2026-09-20"
 
-# D1 数据库：首次部署前执行
-#   npx wrangler d1 create smart-fire-db
-# 并将返回的 database_id 填到下方
+# D1 数据库
+# 本地开发 / E2E：无需真实 database_id —— wrangler dev 与 d1 execute --local
+# 依据 binding + database_name 在 .wrangler/state 下创建本地 SQLite，不校验 database_id。
+#
+# 生产部署前（唯一需要真实 ID 的时机）：
+#   1) 执行 `npx wrangler d1 create smart-fire-db`
+#   2) 将返回的 database_id 替换下方占位符
+# 正式部署请用 `npm run deploy`：它先运行 scripts/check-d1-config.mjs，
+# 占位符未替换时在调用 wrangler deploy 之前直接失败退出（fail-closed）。
+# 本地开发（wrangler dev）与构建检查（npm run deploy:dry-run）不经过该守卫。
 [[d1_databases]]
 binding = "DB"
 database_name = "smart-fire-db"
-database_id = "00000000-0000-0000-0000-000000000000"
+database_id = "<REPLACE_WITH_D1_DATABASE_ID>"
 
 # Durable Objects：DemoRoom 负责六阶段状态机的实时协调与 WebSocket 广播
 [[durable_objects.bindings]]
@@ -20,6 +27,9 @@ script_name = "smart-fire-api"
 tag = "v1"
 new_sqlite_classes = ["DemoRoom"]
 
-# 种子数据保护令牌（生产环境务必设置；本地 dev 留空即可免校验）
+# 种子数据保护令牌（生产环境务必设置；缺失时种子接口 fail-closed，直接 501 禁用）
+# ⚠️ 生产环境请勿写入本文件：应使用 `wrangler secret put SEED_TOKEN` 管理，
+#   避免真实令牌进入源码 / wrangler.toml / Git。
+# 本地开发需测试 seed 时，可临时 `wrangler dev --var SEED_TOKEN:xxx` 注入。
 # [vars]
 # SEED_TOKEN = "change-me"

```

---

## 5. 脚本的 `git diff --no-index -- /dev/null <file>`

### 5.1 `worker/scripts/check-d1-config.mjs`

```diff
diff --git a/worker/scripts/check-d1-config.mjs b/worker/scripts/check-d1-config.mjs
new file mode 100644
index 0000000..eb08b95
--- /dev/null
+++ b/worker/scripts/check-d1-config.mjs
@@ -0,0 +1,293 @@
+#!/usr/bin/env node
+// 部署前守卫：确保 D1 database_id 已替换为真实 UUID。
+//
+// 边界：
+//   · 仅检查配置文件本身，不连接任何远端资源；
+//   · 读取失败 / 解析失败 / 畸形 TOML / 找不到目标 DB 绑定 / 占位符 / 全零 / 非法 UUID
+//     一律拒绝（fail-closed），绝不静默跳过无法识别的行；
+//   · 通过 `npm run deploy` 时先于 `wrangler deploy` 执行；本地 dev 与 dry-run 构建不经过本脚本。
+//
+// 支持的配置格式与范围（这是面向本项目的严格子集解析器，不是完整 TOML 解析器；
+// 超出范围一律 fail-closed）：
+//   · wrangler.toml：严格子集
+//       - 表头：[name] / [[name]]（普通表不可重复定义；数组表可重复）
+//       - 键：bare key（A-Za-z0-9_.-）
+//       - 字符串：单行；正确识别引号闭合与 \" 转义；
+//                 不逐一校验 \b \t \n \f \r \uXXXX 等转义序列的 TOML 合法性
+//                 （该限制不影响 D1 字段判定：UUID 不含反斜杠）
+//       - 数字：十进制整数 / 小数 / 指数；不支持下划线、0x/0o/0b、inf/nan
+//       - 布尔：true / false
+//       - 数组：标量元素 / 嵌套数组 / 尾逗号；不支持内联表 {..}、跨行数组
+//       - 不支持：多行字符串 """ / '''、日期时间、点号键
+//   · wrangler.json：仅标准 JSON（JSON.parse），不支持注释与尾逗号。
+//   · wrangler.jsonc：显式拒绝（不宣称支持 JSONC）。
+//
+// 用法：
+//   node scripts/check-d1-config.mjs                 # 检查当前 Worker 配置（worker/wrangler.toml）
+//   node scripts/check-d1-config.mjs <configPath>    # 检查指定配置（仅测试夹具使用）
+// 退出码：0 = 通过；1 = 拒绝
+import { readFileSync, existsSync, statSync } from 'node:fs'
+import { dirname, resolve } from 'node:path'
+import { fileURLToPath } from 'node:url'
+
+const __dirname = dirname(fileURLToPath(import.meta.url))
+const WORKER_DIR = resolve(__dirname, '..')
+const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
+const ALL_ZERO = '00000000-0000-0000-0000-000000000000'
+const BARE_KEY_RE = /^[A-Za-z0-9_.-]+$/
+const TABLE_RE = /^\[\[([A-Za-z0-9_.-]+)\]\]$/
+const ARRAY_TABLE_RE = /^\[([A-Za-z0-9_.-]+)\]$/
+const NUMBER_RE = /^[+-]?(\d+(\.\d+)?|\.\d+)([eE][+-]?\d+)?$/
+
+function fail(msg) {
+  console.error(`\n[D1 配置守卫] ❌ 拒绝部署：${msg}\n`)
+  process.exit(1)
+}
+
+/** 定位当前 Worker 配置：显式参数优先，否则在 worker 目录按优先级查找；找不到即失败（不放行）。 */
+function locateConfig() {
+  const explicit = process.argv[2]
+  if (explicit) {
+    const p = resolve(process.cwd(), explicit)
+    if (!existsSync(p)) fail(`指定的配置文件不存在：${p}`)
+    if (!statSync(p).isFile()) fail(`指定的路径不是文件：${p}`)
+    return p
+  }
+  const candidates = ['wrangler.toml', 'wrangler.jsonc', 'wrangler.json'].map((f) => resolve(WORKER_DIR, f))
+  const found = candidates.find((p) => existsSync(p) && statSync(p).isFile())
+  if (!found) fail(`无法定位 Worker 配置（已查找：${candidates.join(', ')}）`)
+  return found
+}
+
+/** 去掉 TOML 行内注释（引号内、含 \" 转义的 # 不算注释）。 */
+function stripTomlComment(line) {
+  let quote = null
+  let escaped = false
+  for (let i = 0; i < line.length; i += 1) {
+    const ch = line[i]
+    if (quote) {
+      if (escaped) { escaped = false; continue }
+      if (ch === '\\' && quote === '"') { escaped = true; continue }
+      if (ch === quote) quote = null
+      continue
+    }
+    if (ch === '"' || ch === "'") { quote = ch; continue }
+    if (ch === '#') return line.slice(0, i)
+  }
+  return line
+}
+
+/** 在字符串 / 数组之外寻找第一个 '='；找不到返回 -1。 */
+function findEquals(line) {
+  let quote = null
+  let escaped = false
+  let depth = 0
+  for (let i = 0; i < line.length; i += 1) {
+    const ch = line[i]
+    if (quote) {
+      if (escaped) { escaped = false; continue }
+      if (ch === '\\' && quote === '"') { escaped = true; continue }
+      if (ch === quote) quote = null
+      continue
+    }
+    if (ch === '"' || ch === "'") { quote = ch; continue }
+    if (ch === '[') { depth += 1; continue }
+    if (ch === ']') { depth -= 1; continue }
+    if (ch === '=' && depth === 0) return i
+  }
+  return -1
+}
+
+/** 校验数组括号与引号平衡（含 \" 转义）。 */
+function assertBalanced(value, lineNo, source) {
+  let quote = null
+  let escaped = false
+  let depth = 0
+  for (const ch of value) {
+    if (quote) {
+      if (escaped) { escaped = false; continue }
+      if (ch === '\\' && quote === '"') { escaped = true; continue }
+      if (ch === quote) quote = null
+      continue
+    }
+    if (ch === '"' || ch === "'") { quote = ch; continue }
+    if (ch === '[') depth += 1
+    else if (ch === ']') {
+      depth -= 1
+      if (depth < 0) fail(`第 ${lineNo} 行数组括号不平衡（${source}）`)
+    }
+  }
+  if (depth !== 0 || quote) fail(`第 ${lineNo} 行值不完整（${source}）`)
+}
+
+/** 解析带引号的字符串；未闭合 / 内部未转义引号一律失败。 */
+function parseQuoted(value, quote, lineNo, source) {
+  if (value.length < 2 || !value.endsWith(quote)) fail(`第 ${lineNo} 行字符串未闭合（${source}）`)
+  const inner = value.slice(1, -1)
+  let escaped = false
+  for (const ch of inner) {
+    if (escaped) { escaped = false; continue }
+    if (ch === '\\' && quote === '"') { escaped = true; continue }
+    if (ch === quote) fail(`第 ${lineNo} 行字符串内存在未转义引号（${source}）`)
+  }
+  return inner
+}
+
+/** 解析标量：字符串 / 数字 / 布尔；其它一律失败。 */
+function parseScalar(value, lineNo, source) {
+  if (value.startsWith('"')) return parseQuoted(value, '"', lineNo, source)
+  if (value.startsWith("'")) return parseQuoted(value, "'", lineNo, source)
+  if (value === 'true' || value === 'false') return value
+  if (NUMBER_RE.test(value)) return value
+  fail(`第 ${lineNo} 行无法识别的值：${value}（${source}）`)
+}
+
+/** 按顶层逗号切分数组内部（忽略字符串内、嵌套数组内的逗号）。 */
+function splitTopLevel(inner) {
+  const parts = []
+  let cur = ''
+  let quote = null
+  let escaped = false
+  let depth = 0
+  for (const ch of inner) {
+    if (quote) {
+      cur += ch
+      if (escaped) { escaped = false; continue }
+      if (ch === '\\' && quote === '"') { escaped = true; continue }
+      if (ch === quote) quote = null
+      continue
+    }
+    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue }
+    if (ch === '[') { depth += 1; cur += ch; continue }
+    if (ch === ']') { depth -= 1; cur += ch; continue }
+    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; continue }
+    cur += ch
+  }
+  parts.push(cur)
+  return parts
+}
+
+/** 解析并校验数组元素（复用 parseScalar；内联表 / 非法元素 fail-closed）。 */
+function parseArray(value, lineNo, source) {
+  if (!value.endsWith(']')) fail(`第 ${lineNo} 行数组未闭合（${source}）`)
+  assertBalanced(value, lineNo, source)
+  const inner = value.slice(1, -1)
+  const isEmptyArray = inner.trim() === ''
+  const parts = splitTopLevel(inner)
+  for (let i = 0; i < parts.length; i += 1) {
+    const raw = parts[i].trim()
+    if (!raw) {
+      // 允许尾逗号 / 空数组；中间的连续逗号属于非法空元素
+      if (i !== parts.length - 1 && !isEmptyArray) {
+        fail(`第 ${lineNo} 行数组存在空元素（${source}）`)
+      }
+      continue
+    }
+    if (raw.startsWith('{')) fail(`第 ${lineNo} 行不支持内联表元素（${source}）`)
+    if (raw.startsWith('[')) { parseArray(raw, lineNo, source); continue }
+    parseScalar(raw, lineNo, source)
+  }
+  return value
+}
+
+/** 解析值：字符串 / 数字 / 布尔 / 数组；内联表、多行字符串等一律失败。 */
+function parseValue(raw, lineNo, source) {
+  const value = raw.trim()
+  if (!value) fail(`第 ${lineNo} 行缺少值（${source}）`)
+  if (value.startsWith('"""') || value.startsWith("'''")) fail(`第 ${lineNo} 行不支持多行字符串（${source}）`)
+  if (value.startsWith('[')) return parseArray(value, lineNo, source)
+  if (value.startsWith('{')) fail(`第 ${lineNo} 行不支持内联表（${source}）`)
+  return parseScalar(value, lineNo, source)
+}
+
+/**
+ * 严格解析 TOML 子集，返回所有表块。
+ * 任何非空行要么是合法表头，要么是合法 key = value；否则直接失败（不跳过）。
+ */
+function parseTomlStrict(text, source) {
+  const root = { type: 'root', name: '', entries: {}, lineNo: 0 }
+  const tables = [root]
+  const seenTables = new Map() // name -> 'table' | 'array'
+  let current = root
+
+  const lines = text.split(/\r?\n/)
+  for (let i = 0; i < lines.length; i += 1) {
+    const raw = lines[i]
+    const lineNo = i + 1
+    const line = stripTomlComment(raw).trim()
+    if (!line) continue
+
+    if (line.startsWith('[')) {
+      const arrayMatch = line.match(TABLE_RE)
+      const tableMatch = line.match(ARRAY_TABLE_RE)
+      if (!arrayMatch && !tableMatch) fail(`第 ${lineNo} 行表头格式非法：${raw.trim()}（${source}）`)
+      const type = arrayMatch ? 'array' : 'table'
+      const name = (arrayMatch || tableMatch)[1]
+      const prev = seenTables.get(name)
+      if (type === 'table') {
+        if (prev) fail(`第 ${lineNo} 行重复定义表 [${name}]（${source}）`)
+        seenTables.set(name, 'table')
+      } else {
+        if (prev === 'table') fail(`第 ${lineNo} 行表 ${name} 已定义为普通表，不能改为数组表（${source}）`)
+        seenTables.set(name, 'array')
+      }
+      current = { type, name, entries: {}, lineNo }
+      tables.push(current)
+      continue
+    }
+
+    const eq = findEquals(line)
+    if (eq < 0) fail(`第 ${lineNo} 行不是合法的 key = value：${raw.trim()}（${source}）`)
+    const key = line.slice(0, eq).trim()
+    if (!BARE_KEY_RE.test(key)) fail(`第 ${lineNo} 行键名非法：${key}（${source}）`)
+    if (Object.prototype.hasOwnProperty.call(current.entries, key)) {
+      fail(`第 ${lineNo} 行键重复：${key}（${source}）`)
+    }
+    current.entries[key] = parseValue(line.slice(eq + 1), lineNo, source)
+  }
+  return tables
+}
+
+/** 仅标准 JSON（wrangler.json）：不支持注释与尾逗号。 */
+function parseD1FromJson(text) {
+  const json = JSON.parse(text)
+  return (json.d1_databases || []).map((d) => ({ binding: d.binding, database_id: d.database_id }))
+}
+
+const configPath = locateConfig()
+const ext = configPath.toLowerCase().split('.').pop()
+let dbBindingEntries
+try {
+  const text = readFileSync(configPath, 'utf8')
+  if (ext === 'toml') {
+    dbBindingEntries = parseTomlStrict(text, configPath)
+      .filter((t) => t.type === 'array' && t.name === 'd1_databases')
+      .filter((t) => String(t.entries.binding || '').trim() === 'DB')
+      .map((t) => t.entries)
+  } else if (ext === 'json') {
+    dbBindingEntries = parseD1FromJson(text)
+      .filter((d) => String(d.binding || '').trim() === 'DB')
+  } else if (ext === 'jsonc') {
+    fail(`不支持 JSONC（注释 / 尾逗号）；请改用 wrangler.toml 或标准 JSON 配置（${configPath}）`)
+  } else {
+    fail(`不支持的配置文件类型：${configPath}`)
+  }
+} catch (err) {
+  fail(`读取/解析配置失败：${configPath}（${err.message}）`)
+}
+
+if (!dbBindingEntries.length) {
+  fail(`未找到 binding = "DB" 的 [[d1_databases]] 绑定（${configPath}）`)
+}
+
+for (const entry of dbBindingEntries) {
+  const id = String(entry.database_id || '').trim()
+  if (!id) fail(`binding = "DB" 的绑定缺少 database_id（${configPath}）`)
+  if (id === ALL_ZERO) fail(`binding = "DB" 的 database_id 仍为全零占位值（${configPath}）`)
+  if (!UUID_RE.test(id)) {
+    fail(`binding = "DB" 的 database_id 不是合法 UUID，疑似仍为占位符：${id}（${configPath}）`)
+  }
+}
+
+const id = String(dbBindingEntries[0].database_id).trim()
+console.log(`[D1 配置守卫] ✅ 通过：${configPath} → database_id=${id.slice(0, 8)}…（完整值已隐藏）`)

```

### 5.2 `worker/scripts/deploy-guarded.mjs`

```diff
diff --git a/worker/scripts/deploy-guarded.mjs b/worker/scripts/deploy-guarded.mjs
new file mode 100644
index 0000000..571f8cd
--- /dev/null
+++ b/worker/scripts/deploy-guarded.mjs
@@ -0,0 +1,68 @@
+#!/usr/bin/env node
+// 受守卫保护的正式部署入口：先校验 D1 配置，通过后才调用 wrangler deploy。
+// 不依赖 shell 的 && 语义（Windows cmd / PowerShell / bash 行为一致）。
+// 用法：npm run deploy   （构建检查请用 npm run deploy:dry-run）
+import { spawnSync } from 'node:child_process'
+import { existsSync } from 'node:fs'
+import { dirname, resolve } from 'node:path'
+import { fileURLToPath } from 'node:url'
+
+const __dirname = dirname(fileURLToPath(import.meta.url))
+export const WORKER_DIR = resolve(__dirname, '..')
+const DEFAULT_CHECK = resolve(__dirname, 'check-d1-config.mjs')
+const DEFAULT_WRANGLER = resolve(WORKER_DIR, 'node_modules', 'wrangler', 'bin', 'wrangler.js')
+
+/**
+ * 可注入依赖，便于完全本地的控制流测试（不执行真实部署）。
+ * 正式入口调用时不传任何参数，使用真实路径与 process.execPath。
+ */
+export function runGuardedDeploy({
+  workerDir = WORKER_DIR,
+  checkScript = DEFAULT_CHECK,
+  wranglerJs = DEFAULT_WRANGLER,
+  args = [],
+  spawn = spawnSync,
+  nodePath = process.execPath,
+  log = console,
+} = {}) {
+  // 1) 守卫必须通过，否则在调用 wrangler deploy 之前终止
+  const guard = spawn(nodePath, [checkScript], { stdio: 'inherit', cwd: workerDir })
+  if (guard.error) {
+    log.error(`[deploy-guarded] ❌ 守卫无法启动：${guard.error.message}`)
+    return 1
+  }
+  if (guard.signal) {
+    log.error(`[deploy-guarded] ❌ 守卫被信号终止：${guard.signal}`)
+    return 1
+  }
+  if (guard.status !== 0) {
+    log.error('[deploy-guarded] ❌ 守卫未通过，已终止；未调用 wrangler deploy。')
+    return guard.status || 1
+  }
+
+  // 2) 守卫通过后才真正部署
+  if (!existsSync(wranglerJs)) {
+    log.error(`[deploy-guarded] ❌ 找不到本地 wrangler：${wranglerJs}`)
+    return 1
+  }
+  // 显式固定 cwd 为 worker 目录，确保 wrangler 实际读取的配置与守卫检查的一致
+  const res = spawn(nodePath, [wranglerJs, 'deploy', ...args], { stdio: 'inherit', cwd: workerDir })
+  if (res.error) {
+    log.error(`[deploy-guarded] ❌ Wrangler 无法启动：${res.error.message}`)
+    return 1
+  }
+  if (res.signal) {
+    log.error(`[deploy-guarded] ❌ Wrangler 被信号终止：${res.signal}`)
+    return 1
+  }
+  if (res.status === null || res.status === undefined) {
+    log.error('[deploy-guarded] ❌ Wrangler 未返回正常退出码')
+    return 1
+  }
+  return res.status
+}
+
+const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
+if (isMain) {
+  process.exit(runGuardedDeploy({ args: process.argv.slice(2) }))
+}

```

### 5.3 `worker/scripts/check-d1-config.test.mjs`

```diff
diff --git a/worker/scripts/check-d1-config.test.mjs b/worker/scripts/check-d1-config.test.mjs
new file mode 100644
index 0000000..709dd45
--- /dev/null
+++ b/worker/scripts/check-d1-config.test.mjs
@@ -0,0 +1,148 @@
+#!/usr/bin/env node
+// 部署守卫测试：
+//   · 占位符 / 全零 / 缺失 / 无绑定 / 路径错误 / 畸形 TOML 必须拒绝；
+//   · 目标 DB 绑定缺失、其它绑定合法但 DB 绑定无效必须拒绝；
+//   · 合法 UUID 必须通过。
+// 仅使用本地临时夹具，不连接任何远端资源。
+import { spawnSync } from 'node:child_process'
+import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
+import { tmpdir } from 'node:os'
+import { dirname, join, resolve } from 'node:path'
+import { fileURLToPath } from 'node:url'
+
+const __dirname = dirname(fileURLToPath(import.meta.url))
+const guard = resolve(__dirname, 'check-d1-config.mjs')
+const realConfig = resolve(__dirname, '..', 'wrangler.toml')
+const dir = mkdtempSync(join(tmpdir(), 'd1-guard-'))
+
+const VALID_UUID = '12345678-1234-1234-1234-1234567890ab'
+const PLACEHOLDER = '<REPLACE_WITH_D1_DATABASE_ID>'
+
+let pass = 0
+let fail = 0
+
+function fixture(name, content) {
+  const p = join(dir, name)
+  writeFileSync(p, content)
+  return p
+}
+
+function run(args) {
+  return spawnSync(process.execPath, [guard, ...args], { encoding: 'utf8' })
+}
+
+function expect(name, res, expectedCode, mustInclude) {
+  const out = `${res.stdout || ''}${res.stderr || ''}`
+  const ok = res.status === expectedCode && (!mustInclude || out.includes(mustInclude))
+  console.log(`  ${ok ? '✓' : '✗'} ${name}（exit=${res.status}，期望 ${expectedCode}）`)
+  if (ok) pass += 1
+  else {
+    fail += 1
+    console.log(`    stdout: ${(res.stdout || '').trim()}`)
+    console.log(`    stderr: ${(res.stderr || '').trim()}`)
+  }
+}
+
+function assertTrue(name, cond) {
+  console.log(`  ${cond ? '✓' : '✗'} ${name}`)
+  if (cond) pass += 1
+  else fail += 1
+}
+
+const db = (id) => `[[d1_databases]]\nbinding = "DB"\ndatabase_name = "smart-fire-db"\ndatabase_id = "${id}"\n`
+
+try {
+  // ── 基础拒绝 ──
+  expect('真实 wrangler.toml（占位符）被拒绝', run([realConfig]), 1)
+  expect('占位符 fixture 被拒绝', run([fixture('placeholder.toml', db(PLACEHOLDER))]), 1)
+  expect('全零 UUID 被拒绝', run([fixture('zero.toml', db('00000000-0000-0000-0000-000000000000'))]), 1)
+  expect('缺少 database_id 被拒绝', run([fixture('missing-id.toml', '[[d1_databases]]\nbinding = "DB"\n')]), 1)
+  expect('无 D1 绑定被拒绝', run([fixture('no-d1.toml', 'name = "x"\n')]), 1)
+  expect('不存在的路径被拒绝', run([join(dir, 'not-exist.toml')]), 1)
+  expect('目录作为配置被拒绝', run([dir]), 1)
+
+  // ── 畸形 TOML（不得静默跳过）──
+  expect('畸形：缺少等号被拒绝', run([fixture('malformed-no-eq.toml',
+    `[[d1_databases]]\nbinding "DB"\ndatabase_id = "${VALID_UUID}"\n`)]), 1)
+  expect('畸形：字符串未闭合被拒绝', run([fixture('malformed-string.toml',
+    `[[d1_databases]]\nbinding = "DB"\ndatabase_id = "12345678-1234\n`)]), 1)
+  expect('畸形：表头格式非法被拒绝', run([fixture('malformed-header.toml',
+    `[[d1_databases]\nbinding = "DB"\ndatabase_id = "${VALID_UUID}"\n`)]), 1)
+  expect('畸形：值无法识别被拒绝', run([fixture('malformed-value.toml',
+    `[[d1_databases]]\nbinding = "DB"\ndatabase_id = not-a-value\n`)]), 1)
+  expect('畸形：键重复被拒绝', run([fixture('malformed-dup-key.toml',
+    `[[d1_databases]]\nbinding = "DB"\nbinding = "DB"\ndatabase_id = "${VALID_UUID}"\n`)]), 1)
+
+  // ── 绑定选择准确性 ──
+  expect('目标 DB 绑定缺失（仅 OTHER）被拒绝', run([fixture('only-other.toml',
+    `[[d1_databases]]\nbinding = "OTHER"\ndatabase_name = "other-db"\ndatabase_id = "${VALID_UUID}"\n`)]), 1)
+  expect('其它绑定合法但 DB 绑定无效被拒绝', run([fixture('other-valid-db-invalid.toml',
+    `[[d1_databases]]\nbinding = "OTHER"\ndatabase_id = "${VALID_UUID}"\n\n` + db(PLACEHOLDER))]), 1)
+  expect('其它绑定在前、DB 绑定合法时通过', run([fixture('other-then-db-valid.toml',
+    `[[d1_databases]]\nbinding = "OTHER"\ndatabase_id = "abcdef01-2345-6789-abcd-ef0123456789"\n\n` + db(VALID_UUID))]), 0)
+
+  // ── 合法配置 ──
+  expect('合法 UUID 通过', run([fixture('valid.toml', db(VALID_UUID))]), 0)
+  expect('合法 UUID + 行内注释通过', run([fixture('valid-comment.toml',
+    `[[d1_databases]]\nbinding = "DB" # 绑定名\ndatabase_id = "${VALID_UUID}" # 真实 ID\n`)]), 0)
+  expect('顶层键 + 合法 D1 通过', run([fixture('valid-toplevel.toml',
+    `name = "smart-fire-api"\nmain = "src/index.ts"\n\n` + db(VALID_UUID))]), 0)
+
+  // ── 数组元素语法（复用标量解析；不支持即 fail-closed）──
+  const withExtra = (extra) => `${db(VALID_UUID)}\n${extra}\n`
+  expect('数组：未加引号元素被拒绝', run([fixture('array-bare.toml', withExtra('list = [foo]'))]), 1)
+  expect('数组：中间空元素被拒绝', run([fixture('array-empty-elem.toml', withExtra('list = ["a", , "b"]'))]), 1)
+  expect('数组：内联表元素被拒绝', run([fixture('array-inline-table.toml', withExtra('list = [{ a = 1 }]'))]), 1)
+  expect('数组：未转义内嵌引号被拒绝', run([fixture('array-bad-quote.toml', withExtra('list = ["a"b"]'))]), 1)
+  // 显式构造：JS 字符串中的 \\" 即“反斜杠 + 引号”，对应 TOML 的 \" 转义
+  const escapedQuoteLine = 'list = ["a\\"b"]'
+  const escapedQuotePath = fixture('array-escaped-quote.toml', withExtra(escapedQuoteLine))
+  const escapedQuoteContent = readFileSync(escapedQuotePath, 'utf8')
+  console.log(`    [fixture] array-escaped-quote.toml 实际行: ${JSON.stringify(escapedQuoteLine)}`)
+  assertTrue('转义引号夹具写入预期 TOML 行', escapedQuoteContent.split(/\r?\n/).includes(escapedQuoteLine))
+  expect('数组：合法转义引号通过', run([escapedQuotePath]), 0)
+  expect('数组：嵌套数组通过', run([fixture('array-nested.toml', withExtra('list = [[1, 2], [3]]'))]), 0)
+  expect('数组：尾逗号通过', run([fixture('array-trailing-comma.toml', withExtra('list = ["a", ]'))]), 0)
+  expect('数组：空数组通过', run([fixture('array-empty.toml', withExtra('list = []'))]), 0)
+
+  // ── 重复表头 ──
+  expect('重复普通表头 [vars] 被拒绝', run([fixture('dup-table.toml',
+    `${db(VALID_UUID)}\n[vars]\nA = "1"\n\n[vars]\nB = "2"\n`)]), 1)
+
+  // ── JSON / JSONC 边界 ──
+  expect('标准 JSON 合法通过', run([fixture('valid.json',
+    JSON.stringify({ d1_databases: [{ binding: 'DB', database_id: VALID_UUID }] }))]), 0)
+  expect('标准 JSON 占位符被拒绝', run([fixture('bad.json',
+    JSON.stringify({ d1_databases: [{ binding: 'DB', database_id: PLACEHOLDER }] }))]), 1)
+  expect('JSONC 显式拒绝并提示', run([fixture('config.jsonc',
+    `{ // comment\n  "d1_databases": [{ "binding": "DB", "database_id": "${VALID_UUID}" }]\n}`)]), 1, 'JSONC')
+
+  // ── 数字 / 日期边界（声明支持 vs 实际逻辑）──
+  expect('数字：整数 database_id 被拒绝（非 UUID 字符串）', run([fixture('num-int.toml',
+    `[[d1_databases]]\nbinding = "DB"\ndatabase_id = 12345\n`)]), 1)
+  expect('数字：十进制小数/指数通过', run([fixture('num-float.toml',
+    `name = 1.5e3\n` + db(VALID_UUID))]), 0)
+  expect('数字：负数通过', run([fixture('num-negative.toml',
+    `name = -0.5\n` + db(VALID_UUID))]), 0)
+  expect('数字：下划线分隔被拒绝（不支持）', run([fixture('num-underscore.toml',
+    `name = 1_000\n` + db(VALID_UUID))]), 1)
+  expect('数字：十六进制被拒绝（不支持）', run([fixture('num-hex.toml',
+    `name = 0x1F\n` + db(VALID_UUID))]), 1)
+  expect('数字：inf 被拒绝（不支持）', run([fixture('num-inf.toml',
+    `name = inf\n` + db(VALID_UUID))]), 1)
+  expect('日期时间被拒绝（不支持）', run([fixture('date.toml',
+    `name = 1979-05-27\n` + db(VALID_UUID))]), 1)
+
+  // ── 提取准确性：非 D1 表的 binding/database_id 不得顶替 ──
+  expect('vars 表的 binding/database_id 不参与 D1 判定', run([fixture('vars-not-d1.toml',
+    `[vars]\nbinding = "DB"\ndatabase_id = "${VALID_UUID}"\n\n[[d1_databases]]\nbinding = "OTHER"\ndatabase_id = "${VALID_UUID}"\n`)]), 1)
+  expect('vars 里合法 database_id 不能顶替 DB 绑定的占位符', run([fixture('vars-cannot-substitute.toml',
+    `[vars]\ndatabase_id = "${VALID_UUID}"\n\n` + db(PLACEHOLDER))]), 1)
+  expect('D1 字段含非 UUID 转义内容时仍被拒绝', run([fixture('d1-escape.toml',
+    `[[d1_databases]]\nbinding = "DB"\ndatabase_id = "abc\\q"\n`)]), 1)
+} finally {
+  rmSync(dir, { recursive: true, force: true })
+}
+
+console.log(`\n=== 部署守卫测试：${pass} 通过 / ${fail} 失败 ===`)
+process.exit(fail ? 1 : 0)

```

### 5.4 `worker/scripts/deploy-guarded.test.mjs`

```diff
diff --git a/worker/scripts/deploy-guarded.test.mjs b/worker/scripts/deploy-guarded.test.mjs
new file mode 100644
index 0000000..38e0a2d
--- /dev/null
+++ b/worker/scripts/deploy-guarded.test.mjs
@@ -0,0 +1,130 @@
+#!/usr/bin/env node
+// 部署包装器测试（完全本地，不执行真实部署）：
+//   · 守卫失败 / 无法启动 / 被信号终止 → Wrangler 不得启动；
+//   · 守卫通过 → Wrangler 以 deploy 启动，cwd 固定 worker，参数透传；
+//   · Wrangler 无法启动 / 被信号终止 / 无正常退出码 → 返回非零（不误报成功）；
+//   · 从不同工作目录调用时，守卫仍能定位 worker/wrangler.toml。
+import { spawnSync } from 'node:child_process'
+import { dirname, resolve } from 'node:path'
+import { fileURLToPath } from 'node:url'
+import { runGuardedDeploy, WORKER_DIR } from './deploy-guarded.mjs'
+
+const __dirname = dirname(fileURLToPath(import.meta.url))
+const guardScript = resolve(__dirname, 'check-d1-config.mjs')
+
+let pass = 0
+let fail = 0
+
+function check(name, cond, extra) {
+  console.log(`  ${cond ? '✓' : '✗'} ${name}${extra !== undefined ? ` → ${JSON.stringify(extra)}` : ''}`)
+  if (cond) pass += 1
+  else fail += 1
+}
+
+function makeLog() {
+  const lines = []
+  return {
+    lines,
+    log: (...args) => lines.push(args.map((a) => String(a)).join(' ')),
+    error: (...args) => lines.push(args.map((a) => String(a)).join(' ')),
+  }
+}
+
+function makeSpawn(results) {
+  const calls = []
+  const spawn = (cmd, args, opts) => {
+    calls.push({ cmd, args, opts })
+    const idx = calls.length - 1
+    // 返回完整结果对象（保留 null / error / signal），不得用 ?? 0 吞掉失败状态
+    return idx < results.length ? results[idx] : { status: 0 }
+  }
+  return { spawn, calls }
+}
+
+// 1) 守卫失败（退出码非零）→ 不启动 Wrangler
+{
+  const log = makeLog()
+  const { spawn, calls } = makeSpawn([{ status: 1 }])
+  const code = runGuardedDeploy({ spawn, wranglerJs: guardScript, nodePath: 'node', log })
+  check('守卫失败时返回非零', code === 1, code)
+  check('守卫失败时 spawn 仅一次（未启动 Wrangler）', calls.length === 1, calls.length)
+  check('唯一一次调用是守卫脚本', calls[0]?.args?.[0] === guardScript)
+}
+
+// 2) 守卫无法启动（spawn error）→ 不启动 Wrangler，输出诊断
+{
+  const log = makeLog()
+  const { spawn, calls } = makeSpawn([{ error: new Error('spawn node ENOENT'), status: null }])
+  const code = runGuardedDeploy({ spawn, wranglerJs: guardScript, nodePath: 'node', log })
+  check('守卫无法启动时返回非零', code === 1, code)
+  check('守卫无法启动时不启动 Wrangler', calls.length === 1, calls.length)
+  check('守卫无法启动时输出诊断', log.lines.join('\n').includes('守卫无法启动'))
+}
+
+// 3) 守卫被信号终止 → 不启动 Wrangler
+{
+  const log = makeLog()
+  const { spawn, calls } = makeSpawn([{ status: null, signal: 'SIGTERM' }])
+  const code = runGuardedDeploy({ spawn, wranglerJs: guardScript, nodePath: 'node', log })
+  check('守卫被信号终止时返回非零', code === 1, code)
+  check('守卫被信号终止时不启动 Wrangler', calls.length === 1, calls.length)
+  check('守卫被信号终止时输出诊断', log.lines.join('\n').includes('信号'))
+}
+
+// 4) 守卫 status=null 且无 error/signal → 按失败处理
+{
+  const { spawn, calls } = makeSpawn([{ status: null }])
+  const code = runGuardedDeploy({ spawn, wranglerJs: guardScript, nodePath: 'node', log: makeLog() })
+  check('守卫 status=null 时返回非零', code === 1, code)
+  check('守卫 status=null 时不启动 Wrangler', calls.length === 1, calls.length)
+}
+
+// 5) 守卫通过 → 启动 Wrangler，cwd 固定 worker，参数透传
+{
+  const { spawn, calls } = makeSpawn([{ status: 0 }, { status: 0 }])
+  const code = runGuardedDeploy({ spawn, wranglerJs: guardScript, nodePath: 'node', args: ['--some-flag'], log: makeLog() })
+  check('守卫通过时返回 0', code === 0, code)
+  check('守卫通过时 spawn 两次', calls.length === 2, calls.length)
+  check('第二次含 deploy', calls[1]?.args?.includes('deploy'), calls[1]?.args)
+  check('第二次透传额外参数', calls[1]?.args?.includes('--some-flag'), calls[1]?.args)
+  check('守卫 cwd = worker', calls[0]?.opts?.cwd === WORKER_DIR, calls[0]?.opts?.cwd)
+  check('Wrangler cwd = worker', calls[1]?.opts?.cwd === WORKER_DIR, calls[1]?.opts?.cwd)
+}
+
+// 6) Wrangler 无法启动 → 返回非零（不误报成功）
+{
+  const log = makeLog()
+  const { spawn, calls } = makeSpawn([{ status: 0 }, { error: new Error('spawn wrangler ENOENT'), status: null }])
+  const code = runGuardedDeploy({ spawn, wranglerJs: guardScript, nodePath: 'node', log })
+  check('Wrangler 无法启动时返回非零', code === 1, code)
+  check('Wrangler 无法启动时确实调用了第二次 spawn', calls.length === 2, calls.length)
+  check('Wrangler 无法启动时输出诊断', log.lines.join('\n').includes('Wrangler 无法启动'))
+}
+
+// 7) Wrangler 被信号终止 → 返回非零
+{
+  const log = makeLog()
+  const { spawn } = makeSpawn([{ status: 0 }, { status: null, signal: 'SIGKILL' }])
+  const code = runGuardedDeploy({ spawn, wranglerJs: guardScript, nodePath: 'node', log })
+  check('Wrangler 被信号终止时返回非零', code === 1, code)
+  check('Wrangler 被信号终止时输出诊断', log.lines.join('\n').includes('信号'))
+}
+
+// 8) Wrangler 无正常退出码（undefined）→ 返回非零
+{
+  const { spawn } = makeSpawn([{ status: 0 }, { status: undefined }])
+  const code = runGuardedDeploy({ spawn, wranglerJs: guardScript, nodePath: 'node', log: makeLog() })
+  check('Wrangler 无退出码时返回非零', code === 1, code)
+}
+
+// 9) 从不同工作目录调用守卫，仍定位 worker/wrangler.toml
+{
+  const repoRoot = resolve(WORKER_DIR, '..')
+  const res = spawnSync(process.execPath, [guardScript], { cwd: repoRoot, encoding: 'utf8' })
+  const out = `${res.stdout || ''}${res.stderr || ''}`
+  check('从仓库根调用守卫：占位符被拒绝（exit=1）', res.status === 1, res.status)
+  check('从仓库根调用守卫：输出指向 worker/wrangler.toml', /wrangler\.toml/.test(out))
+}
+
+console.log(`\n=== 部署包装器测试：${pass} 通过 / ${fail} 失败 ===`)
+process.exit(fail ? 1 : 0)

```

### 5.5 `worker/scripts/seed-local.mjs`

```diff
diff --git a/worker/scripts/seed-local.mjs b/worker/scripts/seed-local.mjs
new file mode 100644
index 0000000..45f496f
--- /dev/null
+++ b/worker/scripts/seed-local.mjs
@@ -0,0 +1,67 @@
+#!/usr/bin/env node
+// 本地种子数据灌入（仅面向本机 Worker）。
+// 请求地址固定为 http://127.0.0.1:8787，不接受环境变量或参数覆盖为远端地址。
+// Token 通过环境变量 SEED_TOKEN 传入，绝不写入源码 / 配置 / Git，也不输出到日志。
+//
+// 用法：
+//   PowerShell:  $env:SEED_TOKEN='<与本地 wrangler dev --var SEED_TOKEN 一致>'; npm run seed:local
+//   bash:        SEED_TOKEN='<同上>' npm run seed:local
+//
+// 退出码：0 = 灌入成功；1 = 失败（缺少 Token / 鉴权失败 / 连接失败）
+import { dirname, resolve } from 'node:path'
+import { fileURLToPath } from 'node:url'
+
+const SEED_URL = 'http://127.0.0.1:8787/api/v1/admin/seed'
+
+/**
+ * 可注入 env / fetch / log，便于本地测试（可精确统计请求次数）。
+ * 正式入口调用时不传任何参数。
+ */
+export async function runSeed({
+  env = process.env,
+  fetchImpl = globalThis.fetch,
+  log = console,
+} = {}) {
+  // 防御性断言：任何情况下都不允许非本机地址（地址本身固定，无覆盖入口）
+  if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+\//.test(SEED_URL)) {
+    log.error('[seed:local] ❌ 内部错误：seed:local 仅允许访问本机地址')
+    return 1
+  }
+
+  const token = env.SEED_TOKEN
+  if (!token || !token.trim()) {
+    // 必须在发起任何网络请求之前退出
+    log.error('[seed:local] ❌ 未设置 SEED_TOKEN，已取消（不会发送请求）。')
+    log.error('  请先设置与本地 Worker 一致的令牌，例如：')
+    log.error("    PowerShell:  $env:SEED_TOKEN='your-local-token'; npm run seed:local")
+    log.error('    bash:        SEED_TOKEN=your-local-token npm run seed:local')
+    log.error('  该脚本只访问 http://127.0.0.1:8787，不会连接生产环境。')
+    return 1
+  }
+
+  try {
+    const res = await fetchImpl(SEED_URL, {
+      method: 'POST',
+      headers: { 'X-Seed-Token': token.trim() },
+    })
+    const text = await res.text()
+    let body = text
+    try { body = JSON.parse(text) } catch { /* 保留原始文本 */ }
+
+    if (res.ok) {
+      log.log(`[seed:local] ✅ HTTP ${res.status}`, body)
+      return 0
+    }
+    log.error(`[seed:local] ❌ HTTP ${res.status}`, body)
+    return 1
+  } catch (err) {
+    log.error(`[seed:local] ❌ 无法连接本地 Worker（http://127.0.0.1:8787）：${err.message}`)
+    log.error('  请确认已运行 `npm run dev`（wrangler dev，默认端口 8787）。')
+    return 1
+  }
+}
+
+const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
+if (isMain) {
+  process.exit(await runSeed())
+}

```

### 5.6 `worker/scripts/seed-local.test.mjs`

```diff
diff --git a/worker/scripts/seed-local.test.mjs b/worker/scripts/seed-local.test.mjs
new file mode 100644
index 0000000..ab6b79e
--- /dev/null
+++ b/worker/scripts/seed-local.test.mjs
@@ -0,0 +1,95 @@
+#!/usr/bin/env node
+// seed:local 行为测试（注入 fake fetch，完全本地，不发起真实网络请求）：
+//   · Token 缺失：请求次数必须为 0（在发起网络请求之前退出）；
+//   · Token 错误 / 正确：三态返回码正确，Token 不写入日志；
+//   · 请求地址固定为本机，不可被覆盖。
+import { runSeed } from './seed-local.mjs'
+
+const LOCAL_URL = 'http://127.0.0.1:8787/api/v1/admin/seed'
+
+let pass = 0
+let fail = 0
+
+function check(name, cond, extra) {
+  console.log(`  ${cond ? '✓' : '✗'} ${name}${extra !== undefined ? ` → ${JSON.stringify(extra)}` : ''}`)
+  if (cond) pass += 1
+  else fail += 1
+}
+
+function makeFetch(handler) {
+  const calls = []
+  const fn = async (url, opts) => {
+    calls.push({ url, opts })
+    return handler(url, opts)
+  }
+  return { fn, calls }
+}
+
+function makeLog() {
+  const lines = []
+  return {
+    lines,
+    log: (...args) => lines.push(args.map((a) => String(a)).join(' ')),
+    error: (...args) => lines.push(args.map((a) => String(a)).join(' ')),
+  }
+}
+
+// 1) Token 缺失：必须在任何网络请求之前退出
+{
+  const f = makeFetch(() => { throw new Error('fetch 不应被调用') })
+  const l = makeLog()
+  const code = await runSeed({ env: {}, fetchImpl: f.fn, log: l })
+  check('缺失 Token 返回非零', code === 1, code)
+  check('缺失 Token 请求次数为 0', f.calls.length === 0, f.calls.length)
+  check('缺失 Token 输出明确提示', l.lines.join('\n').includes('未设置 SEED_TOKEN'))
+}
+
+// 1.1) Token 仅为空白：同样在请求前退出
+{
+  const f = makeFetch(() => { throw new Error('fetch 不应被调用') })
+  const l = makeLog()
+  const code = await runSeed({ env: { SEED_TOKEN: '   ' }, fetchImpl: f.fn, log: l })
+  check('空白 Token 返回非零', code === 1, code)
+  check('空白 Token 请求次数为 0', f.calls.length === 0, f.calls.length)
+}
+
+// 2) Token 错误：服务器返回 403 → 非零退出，Token 不写入日志
+{
+  const f = makeFetch(async () => ({
+    ok: false,
+    status: 403,
+    text: async () => '{"error":"无效的种子令牌（X-Seed-Token）"}',
+  }))
+  const l = makeLog()
+  const code = await runSeed({ env: { SEED_TOKEN: 'wrong-token' }, fetchImpl: f.fn, log: l })
+  check('错误 Token 返回非零', code === 1, code)
+  check('错误 Token 请求次数为 1', f.calls.length === 1, f.calls.length)
+  check('请求头携带 Token', f.calls[0]?.opts?.headers?.['X-Seed-Token'] === 'wrong-token')
+  check('错误 Token 未写入日志', !l.lines.join('\n').includes('wrong-token'))
+}
+
+// 3) Token 正确：200 → 0，请求地址固定本机，Token 不写入日志
+{
+  const f = makeFetch(async () => ({ ok: true, status: 200, text: async () => '{"ok":true}' }))
+  const l = makeLog()
+  const code = await runSeed({ env: { SEED_TOKEN: 'secret-token' }, fetchImpl: f.fn, log: l })
+  check('正确 Token 返回 0', code === 0, code)
+  check('正确 Token 请求次数为 1', f.calls.length === 1, f.calls.length)
+  check('请求地址固定为本机', f.calls[0]?.url === LOCAL_URL, f.calls[0]?.url)
+  check('正确 Token 未写入日志', !l.lines.join('\n').includes('secret-token'))
+}
+
+// 4) 连接失败 / 非 JSON 错误响应：均非零退出
+{
+  const f = makeFetch(async () => { throw new Error('ECONNREFUSED') })
+  const code = await runSeed({ env: { SEED_TOKEN: 'x' }, fetchImpl: f.fn, log: makeLog() })
+  check('连接失败返回非零', code === 1, code)
+}
+{
+  const f = makeFetch(async () => ({ ok: false, status: 500, text: async () => 'Internal Error' }))
+  const code = await runSeed({ env: { SEED_TOKEN: 'x' }, fetchImpl: f.fn, log: makeLog() })
+  check('非 JSON 错误响应返回非零', code === 1, code)
+}
+
+console.log(`\n=== seed:local 测试：${pass} 通过 / ${fail} 失败 ===`)
+process.exit(fail ? 1 : 0)

```


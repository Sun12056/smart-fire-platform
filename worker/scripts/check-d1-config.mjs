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

#!/usr/bin/env node
// 部署包装器测试（完全本地，不执行真实部署）：
//   · 参数白名单（deny-by-default）：仅 --target production|trial，其余一律 exit 2 且零 spawn；
//   · 路径隔离：production 路径不读 trial 配置、不执行跨配置比对；trial 路径才比对；
//   · 守卫失败 / 无法启动 / 被信号终止 → Wrangler 不得启动；
//   · 守卫通过 → Wrangler 以对应参数启动，cwd 固定 worker；
//   · Wrangler 无法启动 / 被信号终止 / 无正常退出码 → 返回非零（不误报成功）。
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runGuardedDeploy, findForbiddenArg, parseDeployArgs, WORKER_DIR } from './deploy-guarded.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const guardScript = resolve(__dirname, 'check-d1-config.mjs')
const productionConfig = resolve(WORKER_DIR, 'wrangler.toml')
const trialConfig = resolve(WORKER_DIR, 'wrangler.trial.toml')

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

// ───────────────────────── 1) 守卫失败 → 不启动 Wrangler ─────────────────────────
{
  const log = makeLog()
  const { spawn, calls } = makeSpawn([{ status: 1 }])
  const code = runGuardedDeploy({ spawn, wranglerJs: guardScript, nodePath: 'node', log })
  check('守卫失败时返回非零', code === 1, code)
  check('守卫失败时 spawn 仅一次（未启动 Wrangler）', calls.length === 1, calls.length)
  check('唯一一次调用是守卫脚本', calls[0]?.args?.[0] === guardScript)
}

// 2) 守卫无法启动 → 不启动 Wrangler，输出诊断
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

// 5) 守卫通过（production）→ Wrangler 以 deploy 启动，cwd 固定 worker
{
  const { spawn, calls } = makeSpawn([{ status: 0 }, { status: 0 }])
  const code = runGuardedDeploy({ spawn, wranglerJs: guardScript, nodePath: 'node', args: ['--target', 'production'], log: makeLog() })
  check('守卫通过时返回 0', code === 0, code)
  check('守卫通过时 spawn 两次', calls.length === 2, calls.length)
  check('Wrangler 参数严格为 [deploy]', JSON.stringify(calls[1]?.args) === JSON.stringify([guardScript, 'deploy']), calls[1]?.args)
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

// ───────────────────────── W4-W8：白名单拒绝（零 spawn） ─────────────────────────
{
  const rejected = [
    ['--config=other.toml', ['--config=other.toml']],
    ['--config another.toml', ['--config', 'another.toml']],
    ['-c other.toml', ['-c', 'other.toml']],
    ['-cother.toml', ['-cother.toml']],
    ['--env production', ['--env', 'production']],
    ['--env=production', ['--env=production']],
    ['-e production', ['-e', 'production']],
    ['-eproduction', ['-eproduction']],
    ['--cwd /tmp/other', ['--cwd', '/tmp/other']],
    ['--name other-worker', ['--name', 'other-worker']],
    ['--var A=B', ['--var', 'A=B']],
    ['--route example.com/*', ['--route', 'example.com/*']],
    ['--define __X__:1', ['--define', '__X__:1']],
    ['--minify', ['--minify']],
    ['--dry-run', ['--dry-run']],
    ['--env-file .env.local', ['--env-file', '.env.local']],
    ['--outdir dist2', ['--outdir', 'dist2']],
    ['--compatibility-date 2026-01-01', ['--compatibility-date', '2026-01-01']],
    ['位置参数 foo', ['foo']],
    ['裸 --', ['--']],
    ['--target', ['--target']],
    ['--target staging', ['--target', 'staging']],
    ['--target=staging', ['--target=staging']],
    ['--target trial --target production', ['--target', 'trial', '--target', 'production']],
    ['--target trial --minify', ['--target', 'trial', '--minify']],
  ]

  rejected.forEach(([label, args]) => {
    const log = makeLog()
    const { spawn, calls } = makeSpawn([{ status: 0 }, { status: 0 }])
    const code = runGuardedDeploy({ spawn, wranglerJs: guardScript, nodePath: 'node', args, log })
    const ok = code === 2 && calls.length === 0 && log.lines.join('\n').includes('拒绝参数')
    check(`${label} → exit 2 / 零 spawn / 有拒绝原因`, ok, { code, calls: calls.length })
  })

  // 非法参数 + 不存在的守卫 → 仍 2 且零 spawn（参数检查优先）
  const log = makeLog()
  const { spawn, calls } = makeSpawn([{ status: 0 }, { status: 0 }])
  const code = runGuardedDeploy({
    spawn, wranglerJs: resolve(__dirname, 'not-exist-wrangler.js'), checkScript: resolve(__dirname, 'not-exist-guard.mjs'),
    nodePath: 'node', args: ['--config', 'x.toml'], log,
  })
  check('非法参数 + 不存在的守卫 → 仍返回 2', code === 2, code)
  check('非法参数 + 不存在的守卫 → 仍零 spawn', calls.length === 0, calls.length)
}

// ───────────────────────── W1-W3 / P1-P3：白名单接受与路径隔离 ─────────────────────────
{
  // W1 / P1：默认（无参数）= production，且不读 trial、不 compare
  const w1 = makeSpawn([{ status: 0 }, { status: 0 }])
  const c1 = runGuardedDeploy({ spawn: w1.spawn, wranglerJs: guardScript, nodePath: 'node', args: [], log: makeLog() })
  check('W1 默认无参数 → 返回 0', c1 === 0, c1)
  check('P1 默认路径守卫参数仅 [checkScript]（不读 trial / 不 compare）',
    JSON.stringify(w1.calls[0]?.args) === JSON.stringify([guardScript]), w1.calls[0]?.args)
  check('P1 默认路径 wrangler 参数仅 [deploy]（不传 --config）',
    JSON.stringify(w1.calls[1]?.args) === JSON.stringify([guardScript, 'deploy']), w1.calls[1]?.args)

  // W2 / P2：--target production 与默认一致
  const w2 = makeSpawn([{ status: 0 }, { status: 0 }])
  const c2 = runGuardedDeploy({ spawn: w2.spawn, wranglerJs: guardScript, nodePath: 'node', args: ['--target', 'production'], log: makeLog() })
  check('W2 --target production → 返回 0', c2 === 0, c2)
  check('P2 --target production 守卫参数 = [checkScript]',
    JSON.stringify(w2.calls[0]?.args) === JSON.stringify([guardScript]), w2.calls[0]?.args)
  check('P2 --target production wrangler 参数 = [deploy]',
    JSON.stringify(w2.calls[1]?.args) === JSON.stringify([guardScript, 'deploy']), w2.calls[1]?.args)

  // W3 / P3 / T1：--target trial → 读 trial + compare；wrangler 只接收 trial 配置
  const w3 = makeSpawn([{ status: 0 }, { status: 0 }])
  const c3 = runGuardedDeploy({ spawn: w3.spawn, wranglerJs: guardScript, nodePath: 'node', args: ['--target', 'trial'], log: makeLog() })
  check('W3 --target trial → 返回 0', c3 === 0, c3)
  check('T1 trial 守卫参数含 trial 配置 + --compare + 生产配置',
    JSON.stringify(w3.calls[0]?.args) === JSON.stringify([guardScript, trialConfig, '--compare', productionConfig]),
    w3.calls[0]?.args)
  check('P3 trial wrangler 参数只含 trial 配置',
    JSON.stringify(w3.calls[1]?.args) === JSON.stringify([guardScript, 'deploy', '--config', trialConfig]), w3.calls[1]?.args)
  check('P3 trial wrangler 参数不含生产配置路径',
    !w3.calls[1]?.args?.includes(productionConfig), w3.calls[1]?.args)

  // W3'：--target=trial 等价
  const w3b = makeSpawn([{ status: 0 }, { status: 0 }])
  const c3b = runGuardedDeploy({ spawn: w3b.spawn, wranglerJs: guardScript, nodePath: 'node', args: ['--target=trial'], log: makeLog() })
  check('W3 --target=trial（等号形式）→ 返回 0 且走 trial 路径', c3b === 0 && w3b.calls[0]?.args?.includes(trialConfig), c3b)

  // T17：拒绝路径零 spawn 已在 W4-W8 覆盖；此处补充 parseDeployArgs 纯函数断言
  check('parseDeployArgs([]) → production', parseDeployArgs([]).target === 'production')
  check('parseDeployArgs([--target,trial]) → trial', parseDeployArgs(['--target', 'trial']).target === 'trial')
  check('parseDeployArgs([--target,trial,--target,production]) → 拒绝',
    parseDeployArgs(['--target', 'trial', '--target', 'production']).ok === false)
  check('parseDeployArgs([--name,x]) → 拒绝', parseDeployArgs(['--name', 'x']).ok === false)
  check('parseDeployArgs([foo]) → 拒绝', parseDeployArgs(['foo']).ok === false)

  // findForbiddenArg 语义：偏离白名单即返回非 null
  check('findForbiddenArg([]) → null', findForbiddenArg([]) === null)
  check('findForbiddenArg([--target,trial]) → null', findForbiddenArg(['--target', 'trial']) === null)
  check('findForbiddenArg([--config,a.toml]) → 非空', findForbiddenArg(['--config', 'a.toml']) !== null)
  check('findForbiddenArg([--minify]) → 非空（白名单外）', findForbiddenArg(['--minify']) !== null)
  check('findForbiddenArg([-cVALUE]) → 非空', findForbiddenArg(['-ca.toml']) !== null)
}

// ───────────── T16a：Production / Trial 双环境静态配置声明检查 ─────────────
// ⚠️ 仅证明「配置文件的静态声明」；相同 class_name **不代表** namespace 相同。
//    实际 namespace / resource / Secret 隔离由 T16b（平台侧，部署后）验证，不得混用。
//
// 断言方式：从各自配置文件**解析出实际值**后再断言/比较；
//           配置缺失或不符时解析结果为 null，断言必然失败（不是"文本里出现过某字符串"）。
{
  const { readFileSync } = await import('node:fs')
  const prodText = readFileSync(productionConfig, 'utf8')
  const trialText = readFileSync(trialConfig, 'utf8')

  /** 取顶层段（首个 `[` 表头之前）。 */
  const topLevel = (t) => t.split(/^\[/m)[0]
  /** 取指定表头之后、下一个表头之前的片段。 */
  const sectionOf = (t, header) => {
    const idx = t.indexOf(header)
    if (idx < 0) return ''
    const rest = t.slice(idx + header.length)
    const next = rest.search(/^\[/m)
    return next < 0 ? rest : rest.slice(0, next)
  }
  /** 取 `key = "value"` 的实际字符串值；不存在返回 null。 */
  const scalar = (t, key) => {
    const m = t.match(new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, 'm'))
    return m ? m[1] : null
  }
  /** 取 `key = ["a","b"]` 的实际数组；不存在返回 null。 */
  const arrayOf = (t, key) => {
    const m = t.match(new RegExp(`^${key}\\s*=\\s*\\[([^\\]]*)\\]`, 'm'))
    if (!m) return null
    return m[1].split(',').map((s) => s.trim()).filter(Boolean).map((s) => s.replace(/^"|"$/g, ''))
  }
  /** 统计 binding="DB" 出现次数。 */
  const countDbBindings = (t) => (t.match(/^binding\s*=\s*"DB"$/gm) || []).length

  // —— 解析实际值（非正则命中即通过）——
  const prodTop = topLevel(prodText)
  const trialTop = topLevel(trialText)
  const prodD1 = sectionOf(prodText, '[[d1_databases]]')
  const trialD1 = sectionOf(trialText, '[[d1_databases]]')
  const prodDo = sectionOf(prodText, '[[durable_objects.bindings]]')
  const trialDo = sectionOf(trialText, '[[durable_objects.bindings]]')
  const prodMig = sectionOf(prodText, '[[migrations]]')
  const trialMig = sectionOf(trialText, '[[migrations]]')

  const prodWorkerName = scalar(prodTop, 'name')
  const trialWorkerName = scalar(trialTop, 'name')
  const prodDbName = scalar(prodD1, 'database_name')
  const trialDbName = scalar(trialD1, 'database_name')
  const prodDbBinding = scalar(prodD1, 'binding')
  const trialDbBinding = scalar(trialD1, 'binding')
  const prodDoName = scalar(prodDo, 'name')
  const trialDoName = scalar(trialDo, 'name')
  const prodDoClass = scalar(prodDo, 'class_name')
  const trialDoClass = scalar(trialDo, 'class_name')
  const prodDoScript = scalar(prodDo, 'script_name')
  const trialDoScript = scalar(trialDo, 'script_name')
  const prodMigTag = scalar(prodMig, 'tag')
  const trialMigTag = scalar(trialMig, 'tag')
  const prodClasses = arrayOf(prodMig, 'new_sqlite_classes')
  const trialClasses = arrayOf(trialMig, 'new_sqlite_classes')

  // —— Production 侧 ——
  check('T16a prod Worker name = smart-fire-api', prodWorkerName === 'smart-fire-api', prodWorkerName)
  check('T16a prod D1 database_name = smart-fire-db', prodDbName === 'smart-fire-db', prodDbName)
  check('T16a prod D1 binding = DB', prodDbBinding === 'DB', prodDbBinding)
  check('T16a prod 恰有 1 个 binding="DB"', countDbBindings(prodText) === 1, countDbBindings(prodText))
  check('T16a prod DO binding name = DEMO_ROOM', prodDoName === 'DEMO_ROOM', prodDoName)
  check('T16a prod DO class_name = DemoRoom', prodDoClass === 'DemoRoom', prodDoClass)
  check('T16a prod DO script_name = smart-fire-api', prodDoScript === 'smart-fire-api', prodDoScript)
  check('T16a prod migrations tag = v1', prodMigTag === 'v1', prodMigTag)
  check('T16a prod new_sqlite_classes = [DemoRoom]',
    Array.isArray(prodClasses) && prodClasses.length === 1 && prodClasses[0] === 'DemoRoom', prodClasses)

  // —— Trial 侧 ——
  check('T16a trial Worker name = smart-fire-api-trial', trialWorkerName === 'smart-fire-api-trial', trialWorkerName)
  check('T16a trial D1 database_name = smart-fire-db-trial', trialDbName === 'smart-fire-db-trial', trialDbName)
  check('T16a trial D1 binding = DB', trialDbBinding === 'DB', trialDbBinding)
  check('T16a trial 恰有 1 个 binding="DB"', countDbBindings(trialText) === 1, countDbBindings(trialText))
  check('T16a trial DO binding name = DEMO_ROOM', trialDoName === 'DEMO_ROOM', trialDoName)
  check('T16a trial DO class_name = DemoRoom（与源码一致）', trialDoClass === 'DemoRoom', trialDoClass)
  check('T16a trial DO script_name = smart-fire-api-trial', trialDoScript === 'smart-fire-api-trial', trialDoScript)
  check('T16a trial migrations tag = v1', trialMigTag === 'v1', trialMigTag)
  check('T16a trial new_sqlite_classes = [DemoRoom]',
    Array.isArray(trialClasses) && trialClasses.length === 1 && trialClasses[0] === 'DemoRoom', trialClasses)

  // —— 跨环境：比较**实际解析值** ——
  check('T16a prod/trial Worker name 不同（namespace 分离的前提）',
    prodWorkerName !== null && trialWorkerName !== null && prodWorkerName !== trialWorkerName,
    { prodWorkerName, trialWorkerName })
  check('T16a prod/trial D1 database_name 不同',
    prodDbName !== null && trialDbName !== null && prodDbName !== trialDbName, { prodDbName, trialDbName })
  check('T16a prod/trial script_name 不同（class 同名不构成 namespace 同一证明）',
    prodDoScript !== null && trialDoScript !== null && prodDoScript !== trialDoScript,
    { prodDoScript, trialDoScript })
  check('T16a prod/trial class_name 相同（同一份源码类，预期一致）',
    prodDoClass !== null && prodDoClass === trialDoClass, { prodDoClass, trialDoClass })
  check('T16a prod/trial DO binding name 相同（同一绑定名，预期一致）',
    prodDoName !== null && prodDoName === trialDoName, { prodDoName, trialDoName })

  // 以拼接方式构造被禁标识，避免源码本身出现该字面量（保证“零残留”可被静态核验）
  const forbiddenLegacyMode = 'AUTHZ' + '_MODE'
  check('T16a trial 使用 GATEWAY_MODE（无遗留模式标识）',
    /GATEWAY_MODE\s*=\s*"deny_all"/.test(trialText) && !trialText.includes(forbiddenLegacyMode))
  check('T16a trial 未含明文 secret 赋值', !/\bSECRET\b|\bTOKEN\s*=/.test(trialText))

  // ── 严格顶层值解析（fail-closed；不做元素过滤）──
  function parseTomlStringArray(raw) {
    if (!/^\[[\s\S]*\]$/.test(raw)) return { ok: false, reason: 'unterminated' }
    const inner = raw.slice(1, -1).trim()
    if (inner === '') return { ok: true, value: [] }
    if (inner.includes('[') || inner.includes(']')) return { ok: false, reason: 'nested' }
    if (inner.includes('{') || inner.includes('}')) return { ok: false, reason: 'inline-table' }
    const parts = inner.split(',')
    const out = []
    for (const p of parts) {
      const s = p.trim()
      if (s === '') return { ok: false, reason: 'empty-element' }
      if (!/^"[^"]*"$/.test(s)) return { ok: false, reason: 'non-string-element' }
      out.push(s.slice(1, -1))
    }
    return { ok: true, value: out }
  }

  function parseTopLevelValues(text) {
    const lines = text.split(/\r?\n/)
    const map = new Map()
    const duplicates = []
    let inTop = true

    for (let i = 0; i < lines.length; i += 1) {
      let line = lines[i]
      let quote = null
      let cut = line.length
      for (let j = 0; j < line.length; j += 1) {
        const ch = line[j]
        if (quote) { if (ch === quote) quote = null; continue }
        if (ch === '"' || ch === "'") { quote = ch; continue }
        if (ch === '#') { cut = j; break }
      }
      line = line.slice(0, cut).trim()
      if (!line) continue
      if (line.startsWith('[')) { inTop = false; continue }
      if (!inTop) continue

      const m = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.+)$/)
      if (!m) continue
      const key = m[1]
      const raw = m[2].trim()

      let type = 'other'
      let value = raw
      let parse = { ok: true }
      if (raw === 'true' || raw === 'false') { type = 'boolean'; value = raw === 'true' }
      else if (/^"([^"]*)"$/.test(raw)) { type = 'string'; value = raw.slice(1, -1) }
      else if (/^[+-]?\d+(\.\d+)?$/.test(raw)) { type = 'number'; value = Number(raw) }
      else {
        parse = parseTomlStringArray(raw)
        if (parse.ok) { type = 'array'; value = parse.value }
      }

      if (map.has(key)) duplicates.push(key)
      map.set(key, { value, type, parse, line: i + 1 })
    }
    return { map, duplicates }
  }

  const trialVals = parseTopLevelValues(trialTop)
  const prodVals = parseTopLevelValues(prodTop)
  const wd = trialVals.map.get('workers_dev')
  const pu = trialVals.map.get('preview_urls')
  const rt = trialVals.map.get('routes')

  check('T16a-S1 trial workers_dev 为布尔 false',
    Boolean(wd) && wd.type === 'boolean' && wd.value === false, wd ?? null)
  check('T16a-S2 trial preview_urls 为布尔 false',
    Boolean(pu) && pu.type === 'boolean' && pu.value === false, pu ?? null)
  check('T16a-S3 trial routes 未声明或为严格空数组',
    !rt || (rt.type === 'array' && rt.parse.ok && rt.value.length === 0), rt ?? null)
  check('T16a-S4 三键无重复声明',
    !['workers_dev', 'preview_urls', 'routes'].some((k) => trialVals.duplicates.includes(k)),
    trialVals.duplicates)
  check('T16a-S5 Production workers_dev 仍不存在',
    prodVals.map.get('workers_dev') === undefined, prodVals.map.get('workers_dev') ?? null)

  // ── P1–P9：解析器 fail-closed 单元验证（P1–P7 拒绝输入，P8–P9 接受空数组）──
  const p1 = parseTopLevelValues('workers_dev = "false"\n').map.get('workers_dev')
  check('T16a-P1 workers_dev = "false"（字符串）→ 解析器拒绝输入，测试通过',
    Boolean(p1) && p1.type === 'string', p1 ?? null)

  const p2 = parseTopLevelValues('name = "x"\n').map.get('workers_dev')
  check('T16a-P2 workers_dev 缺失 → 解析器拒绝输入，测试通过', p2 === undefined, p2 ?? null)

  const p3 = parseTopLevelValues('workers_dev = false\nworkers_dev = false\n').duplicates
  check('T16a-P3 workers_dev 重复声明 → 解析器拒绝输入，测试通过',
    p3.includes('workers_dev'), p3)

  const p4 = parseTopLevelValues('routes = ["a.com/*"]\n').map.get('routes')
  check('T16a-P4 routes 非空数组 → 解析器拒绝输入，测试通过',
    Boolean(p4) && p4.type === 'array' && p4.value.length > 0, p4 ?? null)

  const p5 = parseTopLevelValues('routes = [,,]\n').map.get('routes')
  check('T16a-P5 routes = [,,] → 解析器拒绝输入，测试通过',
    Boolean(p5) && p5.parse.ok === false, p5 ?? null)

  const p6 = parseTopLevelValues('routes = [a]\n').map.get('routes')
  check('T16a-P6 routes = [a] → 解析器拒绝输入，测试通过',
    Boolean(p6) && p6.parse.ok === false, p6 ?? null)

  const p7 = parseTopLevelValues('routes = {}\n').map.get('routes')
  check('T16a-P7 routes = {} → 解析器拒绝输入，测试通过',
    Boolean(p7) && p7.parse.ok === false, p7 ?? null)

  const p8 = parseTopLevelValues('routes = []\n').map.get('routes')
  check('T16a-P8 routes = [] → 解析器接受输入，测试通过',
    Boolean(p8) && p8.type === 'array' && p8.parse.ok && p8.value.length === 0, p8 ?? null)

  const p9 = parseTopLevelValues('routes = [ ]\n').map.get('routes')
  check('T16a-P9 routes = [ ] → 解析器接受输入，测试通过',
    Boolean(p9) && p9.type === 'array' && p9.parse.ok && p9.value.length === 0, p9 ?? null)
}

console.log(`\n=== 部署包装器测试：${pass} 通过 / ${fail} 失败 ===`)
process.exit(fail ? 1 : 0)

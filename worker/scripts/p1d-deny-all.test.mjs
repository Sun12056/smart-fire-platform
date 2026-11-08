#!/usr/bin/env node
// P1d 网关拒绝测试（45 个测试用例）
//   G-1（32）+ G-2（1）+ G-3（1）+ G-4（1）= 35 基础用例
//   X-1（1）+ X-2～X-5（4）= 5 补充用例
//   B-1～B-5（5）= 5 路径边界用例
//
// 分层：
//   · 单元层（41）：直接调用 gatewayGuard，断言 Response 的 status/body 或「放行到 next」；
//   · 真实实例层（4）：G-2/G-3/G-4/X-1 通过 `wrangler dev`（生产配置、不注入 GATEWAY_MODE）实测。
//
// 仅本地：不触远程 D1 / Cloudflare API / 部署。
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, openSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const WORKER_DIR = resolve(__dirname, '..')
const PORT = 8788
const BASE = `http://127.0.0.1:${PORT}`

let cases = 0
let assertions = 0
let passed = 0
let failed = 0
let blocked = 0
const failures = []

function ok(name, cond, detail) {
  assertions += 1
  if (cond) return true
  failures.push({ name, detail })
  return false
}

function caseDone(name, cond, detail) {
  cases += 1
  if (cond) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failed += 1
    console.log(`  ✗ ${name} → ${JSON.stringify(detail)}`)
  }
}

function caseBlocked(name, reason) {
  cases += 1
  blocked += 1
  console.log(`  ⚠ ${name} → BLOCKED：${reason}`)
}

// ── 载入 gateway.ts（esbuild 打包为 ESM）────────────────────────────────
const requireFromWorker = createRequire(join(WORKER_DIR, 'package.json'))
const { build } = requireFromWorker('esbuild')
const outdir = mkdtempSync(join(tmpdir(), 'p1d-gateway-'))
const bundlePath = join(outdir, 'gateway.mjs')
await build({
  entryPoints: [join(WORKER_DIR, 'src', 'middleware', 'gateway.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  outfile: bundlePath,
  logLevel: 'silent',
})
const { gatewayGuard } = await import(pathToFileURL(bundlePath).href)

// ── 单元层工具 ──────────────────────────────────────────────────────────
const NEXT = Symbol('next')
const nextFn = async () => NEXT

function makeCtx(method, path, env = {}) {
  return {
    req: { method, path },
    env,
    json: (body, status) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
  }
}

async function runGuard(method, path, env = {}) {
  const ctx = makeCtx(method, path, env)
  const res = await gatewayGuard(ctx, nextFn)
  return { ctx, res }
}

const validBody = (b) =>
  b !== null && typeof b === 'object' && Object.keys(b).length === 1 && b.error === '服务未开放'

async function expectDeny(name, method, path, env = {}) {
  const { res } = await runGuard(method, path, env)
  const isResp = res instanceof Response
  const statusOk = ok(name, isResp && res.status === 403, { status: isResp ? res.status : res })
  let bodyOk = false
  if (isResp && res.status === 403) {
    const body = await res.json()
    bodyOk = ok(name, validBody(body), body)
  }
  caseDone(name, statusOk && bodyOk, { status: isResp ? res.status : res })
}

async function expectNext(name, method, path, env = {}) {
  const { res } = await runGuard(method, path, env)
  caseDone(name, res === NEXT, { got: res === NEXT ? 'NEXT' : res })
}

// ── G-1：32 条业务端点 ─────────────────────────────────────────────────
const BIZ = [
  ['POST', '/api/v1/admin/seed'],
  ['GET', '/api/v1/alarms'],
  ['POST', '/api/v1/alarms'],
  ['GET', '/api/v1/alarms/test-id'],
  ['PATCH', '/api/v1/alarms/test-id'],
  ['GET', '/api/v1/building-evacuation-plans'],
  ['GET', '/api/v1/building-evacuation-plans/test-id'],
  ['GET', '/api/v1/buildings'],
  ['GET', '/api/v1/buildings/test-id'],
  ['POST', '/api/v1/demo/command'],
  ['POST', '/api/v1/demo/reset'],
  ['GET', '/api/v1/demo/state'],
  ['GET', '/api/v1/demo/transitions'],
  ['GET', '/api/v1/demo/ws'],
  ['GET', '/api/v1/devices'],
  ['GET', '/api/v1/devices/test-id'],
  ['PATCH', '/api/v1/devices/test-id'],
  ['GET', '/api/v1/evacuation-plans'],
  ['POST', '/api/v1/evacuation-plans'],
  ['GET', '/api/v1/evacuation-plans/test-id'],
  ['PATCH', '/api/v1/evacuation-plans/test-id'],
  ['GET', '/api/v1/inspections'],
  ['POST', '/api/v1/inspections'],
  ['GET', '/api/v1/operation-logs'],
  ['POST', '/api/v1/operation-logs'],
  ['GET', '/api/v1/person-presence'],
  ['POST', '/api/v1/person-presence/batch'],
  ['GET', '/api/v1/person-presence/heatmap'],
  ['GET', '/api/v1/person-presence/stats'],
  ['GET', '/api/v1/telemetry'],
  ['POST', '/api/v1/telemetry'],
  ['POST', '/api/v1/telemetry/batch'],
]

console.log('\n[单元层] G-1：32 条业务端点 → 403')
for (const [m, p] of BIZ) {
  await expectDeny(`G-1 ${m} ${p}`, m, p, { GATEWAY_MODE: 'deny_all' })
}

console.log('\n[单元层] X-2～X-5：模式降级')
await expectDeny('X-2 非法值 AUTHZ_MODE → 403', 'GET', '/api/v1/buildings', { GATEWAY_MODE: 'AUTHZ_MODE' })
await expectDeny('X-3 auth_only（未实现）→ 403', 'GET', '/api/v1/buildings', { GATEWAY_MODE: 'auth_only' })
await expectDeny('X-4 enforce（未实现）→ 403', 'GET', '/api/v1/buildings', { GATEWAY_MODE: 'enforce' })

{
  const name = 'X-5 403 响应头与信息最小化'
  const { res } = await runGuard('GET', '/api/v1/buildings', { GATEWAY_MODE: 'deny_all' })
  const ct = res instanceof Response ? (res.headers.get('content-type') || '') : ''
  const body = res instanceof Response ? await res.json() : {}
  const c1 = ok(name, ct.includes('application/json'), { ct })
  const c2 = ok(name, Object.keys(body).length === 1 && !('stack' in body), body)
  caseDone(name, c1 && c2, { ct, body })
}

console.log('\n[单元层] B-1～B-5：路径边界')
await expectDeny('B-1 GET /api/v1 → 403', 'GET', '/api/v1', {})
await expectDeny('B-2 GET /api/v1/ → 403', 'GET', '/api/v1/', {})
await expectNext('B-3 GET /api/v10 → 放行（不误匹配）', 'GET', '/api/v10', {})
await expectNext('B-4 GET /api/v10/x → 放行（不误匹配）', 'GET', '/api/v10/x', {})
await expectNext('B-5 POST /healthz → 放行（例外仅 GET）', 'POST', '/healthz', {})

// ── 真实实例层 ─────────────────────────────────────────────────────────
console.log('\n[真实实例层] 启动 wrangler dev（生产配置，不注入 GATEWAY_MODE）')

let proc = null
let devLog = ''
let started = false

try {
  // 直接调用 wrangler 的 JS 入口；stderr 重定向到文件（workerd 的 console 输出继承 fd 2）
  const wranglerBin = join(WORKER_DIR, 'node_modules', 'wrangler', 'bin', 'wrangler.js')
  const devLogPath = join(outdir, 'dev.log')
  const stderrFd = openSync(devLogPath, 'w')
  // stdout 与 stderr 统一写入同一文件：workerd 的 console 输出继承 fd，管道方式无法捕获
  proc = spawn(process.execPath, [wranglerBin, 'dev', '--port', String(PORT)], {
    cwd: WORKER_DIR,
    env: { ...process.env, CI: '1' },
    stdio: ['ignore', stderrFd, stderrFd],
  })
  const readDevLogFile = () => {
    try { return readFileSync(devLogPath, 'utf8') } catch { return '' }
  }
  globalThis.__readDevLogFile = readDevLogFile
  // stdout/stderr 已重定向到 devLogPath，无需管道监听

  const deadline = Date.now() + 90000
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000))
    if (proc.exitCode !== null) break
    try {
      const r = await fetch(`${BASE}/healthz`)
      if (r.ok) { started = true; break }
    } catch { /* not ready */ }
  }
} catch (e) {
  devLog += `\n[spawn error] ${e.message}`
}

if (!started) {
  const reason = proc && proc.exitCode !== null
    ? `进程提前退出（exit=${proc.exitCode}）`
    : '90s 内未就绪'
  console.log(`  ⚠ 实例启动失败：${reason}`)
  console.log('  ---- dev log tail ----')
  console.log(devLog.split(/\r?\n/).slice(-20).join('\n'))
  caseBlocked('G-2 GET /healthz → 200', reason)
  caseBlocked('G-3 OPTIONS /api/v1/devices → 204', reason)
  caseBlocked('G-4 GET /nonexistent → 404', reason)
  caseBlocked('X-1 GATEWAY_MODE 缺失 → undefined 日志 + 403', reason)
} else {
  console.log('  ✓ 实例已就绪')

  // G-2
  {
    const name = 'G-2 GET /healthz → 200'
    const r = await fetch(`${BASE}/healthz`)
    const b = await r.json()
    const c1 = ok(name, r.status === 200, { status: r.status })
    const c2 = ok(name, b.ok === true && b.service === 'smart-fire-api' && b.version === 'v1', b)
    caseDone(name, c1 && c2, { status: r.status, b })
  }

  // G-3
  {
    const name = 'G-3 OPTIONS /api/v1/devices → 204'
    const r = await fetch(`${BASE}/api/v1/devices`, { method: 'OPTIONS' })
    caseDone(name, r.status === 204, { status: r.status })
  }

  // G-4
  {
    const name = 'G-4 GET /nonexistent → 404'
    const r = await fetch(`${BASE}/nonexistent`)
    const b = await r.json()
    const c1 = ok(name, r.status === 404, { status: r.status })
    const c2 = ok(name, b.error === '接口不存在', b)
    caseDone(name, c1 && c2, { status: r.status, b })
  }

  // X-1（同一用例内：X-1a 真实实例为主证据，X-1b 单元为辅证）
  {
    const name = 'X-1 GATEWAY_MODE 缺失 → 实例绑定清单无该变量 + 403（X-1a 主 / X-1b 辅）'
    const r = await fetch(`${BASE}/api/v1/buildings`)
    const b = await r.json()
    const c1 = ok(name, r.status === 403, { status: r.status })
    const c2 = ok(name, validBody(b), b)
    // 运行时缺失证据：wrangler 启动时打印的「实际注入绑定清单」中不含 GATEWAY_MODE
    // （workerd 的 console 输出直连终端、不入管道，故以启动绑定清单为准）
    const readLog = globalThis.__readDevLogFile || (() => '')
    let bindingLines = []
    const logDeadline = Date.now() + 8000
    while (Date.now() < logDeadline) {
      const all = `${devLog}\n${readLog()}`
      bindingLines = all.split(/\r?\n/).filter((l) => l.includes('env.'))
      if (bindingLines.some((l) => l.includes('env.DB'))) break
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    const hasDbBinding = bindingLines.some((l) => l.includes('env.DB'))
    const hasModeBinding = bindingLines.some((l) => l.includes('GATEWAY_MODE'))
    const c3 = ok(name, hasDbBinding && !hasModeBinding, {
      hasDbBinding,
      hasModeBinding,
      bindingLines: bindingLines.slice(0, 12),
    })

    const ctx = makeCtx('GET', '/api/v1/buildings', {})
    const res = await gatewayGuard(ctx, nextFn)
    const c4 = ok(name, ctx.env.GATEWAY_MODE === undefined, { env: ctx.env })
    const c5 = ok(name, res instanceof Response && res.status === 403, { status: res?.status })
    const unitBody = res instanceof Response ? await res.json() : null
    const c6 = ok(name, validBody(unitBody), unitBody)

    caseDone(name, c1 && c2 && c3 && c4 && c5 && c6, { status: r.status, b, hasLog: c3, unitBody })
  }
}

try { if (proc) proc.kill() } catch { /* ignore */ }
await new Promise((r) => setTimeout(r, 800))

// ── 汇总 ────────────────────────────────────────────────────────────────
console.log('\n=== P1d 网关拒绝测试汇总 ===')
console.log(`测试用例总数：${cases}`)
console.log(`实际断言总数：${assertions}`)
console.log(`通过用例：${passed}`)
console.log(`失败用例：${failed}`)
console.log(`BLOCKED 用例：${blocked}`)
if (failures.length) {
  console.log('--- 失败明细 ---')
  for (const f of failures) console.log(`  ✗ ${f.name} → ${JSON.stringify(f.detail)}`)
}
process.exit(failed > 0 || blocked > 0 ? 1 : 0)

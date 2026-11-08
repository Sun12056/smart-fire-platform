#!/usr/bin/env node
// P1e A-1 本地静态测试（不部署、不触远程、不修改任何 Cloudflare 资源）
//   组 G1：32 条业务端点经 Pages Function 代理 → 403 + 精确响应体
//   组 G2：OPTIONS 预检 → 204
//   组 G3：/api/v10 不被 _routes.json 纳入（配置层）
//   组 G4：静态资源不被纳入（配置层）
//   组 G5：Service Binding 失败（隔离 mock）→ 抛出（Pages 侧 500）
//   组 G6：请求头透传
//   组 G7：响应头透传
// 说明：`_routes.json` 的**平台实际路由行为**需 A-4 部署后验证；本文件仅验证配置内容。
import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TRIAL_DIR = resolve(__dirname, '..')
const REPO_ROOT = resolve(TRIAL_DIR, '..')
const WORKER_DIR = join(REPO_ROOT, 'worker')

const requireFromWorker = createRequire(join(WORKER_DIR, 'package.json'))
const { build } = requireFromWorker('esbuild')

const outdir = mkdtempSync(join(tmpdir(), 'p1e-proxy-'))
async function bundle(entry, name) {
  const outfile = join(outdir, `${name}.mjs`)
  await build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'node', target: 'node20', outfile, logLevel: 'silent' })
  return import(pathToFileURL(outfile).href)
}

const proxyMod = await bundle(join(TRIAL_DIR, 'functions', 'api', 'v1', '[[path]].ts'), 'proxy')
const gwMod = await bundle(join(WORKER_DIR, 'src', 'middleware', 'gateway.ts'), 'gateway')

const { onRequest } = proxyMod
const { gatewayGuard } = gwMod

let cases = 0
let assertions = 0
let passed = 0
let failed = 0

function ok(cond, detail) {
  assertions += 1
  if (!cond) failures.push(detail)
  return cond
}
const failures = []

function done(name, cond, detail) {
  cases += 1
  if (cond) { passed += 1; console.log(`  ✓ ${name}`) }
  else { failed += 1; console.log(`  ✗ ${name} → ${JSON.stringify(detail)}`) }
}

// ── mock 目标 Worker（复用真实 gatewayGuard，模拟 CORS 的 OPTIONS 短路）──
async function mockWorkerFetch(req) {
  const url = new URL(req.url)
  if (req.method === 'OPTIONS') return new Response(null, { status: 204 })
  const ctx = {
    req: { method: req.method, path: url.pathname },
    env: {},
    json: (body, status) =>
      new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }),
  }
  return gatewayGuard(ctx, async () =>
    new Response(JSON.stringify({ error: '接口不存在' }), { status: 404, headers: { 'Content-Type': 'application/json' } }),
  )
}

async function callProxy(method, path, { headers, fetcher } = {}) {
  const request = new Request(`https://trial.example.pages.dev${path}`, { method, headers })
  const env = { API: { fetch: fetcher || mockWorkerFetch } }
  return onRequest({ request, env })
}

const validBody = (b) =>
  b !== null && typeof b === 'object' && Object.keys(b).length === 1 && b.error === '服务未开放'

// ── G1：32 条业务端点 ──────────────────────────────────────────────────
const BIZ = [
  ['POST', '/api/v1/admin/seed'],
  ['GET', '/api/v1/alarms'],
  ['POST', '/api/v1/alarms'],
  ['GET', '/api/v1/alarms/x'],
  ['PATCH', '/api/v1/alarms/x'],
  ['GET', '/api/v1/building-evacuation-plans'],
  ['GET', '/api/v1/building-evacuation-plans/x'],
  ['GET', '/api/v1/buildings'],
  ['GET', '/api/v1/buildings/x'],
  ['POST', '/api/v1/demo/command'],
  ['POST', '/api/v1/demo/reset'],
  ['GET', '/api/v1/demo/state'],
  ['GET', '/api/v1/demo/transitions'],
  ['GET', '/api/v1/demo/ws'],
  ['GET', '/api/v1/devices'],
  ['GET', '/api/v1/devices/x'],
  ['PATCH', '/api/v1/devices/x'],
  ['GET', '/api/v1/evacuation-plans'],
  ['POST', '/api/v1/evacuation-plans'],
  ['GET', '/api/v1/evacuation-plans/x'],
  ['PATCH', '/api/v1/evacuation-plans/x'],
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

console.log('\n[G1] 32 条业务端点（经 Pages Function 代理）')
for (const [m, p] of BIZ) {
  const name = `G1 ${m} ${p}`
  const res = await callProxy(m, p)
  const sOk = ok(res.status === 403, { path: p, status: res.status })
  const body = await res.json()
  const bOk = ok(validBody(body), body)
  done(name, sOk && bOk, { status: res.status, body })
}

// ── G2：OPTIONS ────────────────────────────────────────────────────────
console.log('\n[G2] OPTIONS 预检')
{
  const name = 'G2 OPTIONS /api/v1/devices → 204'
  const res = await callProxy('OPTIONS', '/api/v1/devices')
  done(name, ok(res.status === 204, { status: res.status }), { status: res.status })
}

// ── G3/G4：_routes.json 配置层边界 ──────────────────────────────────────
const routes = JSON.parse(readFileSync(join(TRIAL_DIR, '_routes.json'), 'utf8'))
function included(path) {
  return (routes.include || []).some((p) => (p.endsWith('/*') ? path === p.slice(0, -2) || path.startsWith(p.slice(0, -1)) : p === path))
}

console.log('\n[G3] /api/v10 路径边界（配置层）')
{
  const name = 'G3 /api/v10 与 /api/v10/x 不被 _routes.json 纳入'
  const a = ok(included('/api/v10') === false, { matched: included('/api/v10') })
  const b = ok(included('/api/v10/x') === false, { matched: included('/api/v10/x') })
  done(name, a && b, { v10: included('/api/v10'), v10x: included('/api/v10/x') })
}

console.log('\n[G4] 静态资源不进入 Functions（配置层）')
{
  const name = 'G4 / 与 /assets/* 不被纳入'
  const a = ok(included('/') === false, { matched: included('/') })
  const b = ok(included('/assets/index.js') === false, { matched: included('/assets/index.js') })
  const c = ok(included('/api/v1') === true && included('/api/v1/buildings') === true, {
    apiRoot: included('/api/v1'),
    apiChild: included('/api/v1/buildings'),
  })
  done(name, a && b && c, { root: included('/'), asset: included('/assets/index.js') })
}

// ── G5：Service Binding 失败（隔离 mock，不破坏真实 binding）────────────
console.log('\n[G5] Service Binding 失败隔离')
{
  const name = 'G5 binding.fetch 抛错 → onRequest 抛出（不静默 200）'
  let threw = null
  try {
    await callProxy('GET', '/api/v1/buildings', {
      fetcher: async () => { throw new Error('service binding unavailable (mock)') },
    })
  } catch (e) { threw = e.message }
  done(name, ok(threw !== null && /unavailable/.test(threw), { threw }), { threw })
}

// ── G6：请求头透传 ─────────────────────────────────────────────────────
console.log('\n[G6] 请求头透传')
{
  const name = 'G6 自定义请求头到达目标 Worker'
  let seen = null
  await callProxy('GET', '/api/v1/buildings', {
    headers: { 'x-trace-id': 'abc-123', origin: 'https://trial.example.pages.dev' },
    fetcher: async (req) => {
      seen = { trace: req.headers.get('x-trace-id'), origin: req.headers.get('origin'), path: new URL(req.url).pathname }
      return new Response('{}', { status: 403, headers: { 'Content-Type': 'application/json' } })
    },
  })
  done(name, ok(seen?.trace === 'abc-123' && seen?.origin === 'https://trial.example.pages.dev' && seen?.path === '/api/v1/buildings', seen), seen)
}

// ── G7：响应头透传 ─────────────────────────────────────────────────────
console.log('\n[G7] 响应头透传')
{
  const name = 'G7 Worker 响应头与状态原样返回'
  const res = await callProxy('GET', '/api/v1/buildings', {
    fetcher: async () => new Response('{}', { status: 403, headers: { 'Content-Type': 'application/json', 'x-worker': 'trial' } }),
  })
  const a = ok(res.status === 403, { status: res.status })
  const b = ok(res.headers.get('x-worker') === 'trial', { xWorker: res.headers.get('x-worker') })
  done(name, a && b, { status: res.status, xWorker: res.headers.get('x-worker') })
}

// ── 汇总 ───────────────────────────────────────────────────────────────
console.log('\n=== P1e A-1 代理测试汇总 ===')
console.log(`测试用例总数：${cases}`)
console.log(`实际断言总数：${assertions}`)
console.log(`通过用例：${passed}`)
console.log(`失败用例：${failed}`)
if (failures.length) {
  console.log('--- 失败明细 ---')
  for (const f of failures) console.log(`  ✗ ${JSON.stringify(f)}`)
}
process.exit(failed > 0 ? 1 : 0)

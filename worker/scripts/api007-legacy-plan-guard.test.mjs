#!/usr/bin/env node
// WP-01 / API-007 / G-05 验收脚本：LEGACY 预案写入口守卫
//
// 安全边界：
//   · TEST_BASE_URL 默认 http://127.0.0.1:8787，且**强制**只允许回环地址
//     （localhost / 127.0.0.1 / ::1），任何远程地址在发起请求前直接退出；
//   · 不读取任何密钥，不携带 Cookie / Authorization；
//   · 测试数据使用唯一前缀 `G05-`，创建前先做冲突检测，结束后输出清理标记。
//
// 用法：
//   node worker/scripts/api007-legacy-plan-guard.test.mjs
//   TEST_BASE_URL=http://localhost:8787 node worker/scripts/api007-legacy-plan-guard.test.mjs
//
// 退出码：0 = 全部通过；1 = 存在失败 / 前置不合法

import process from 'node:process'

const DEFAULT_BASE = 'http://127.0.0.1:8787'
const RAW_BASE = process.env.TEST_BASE_URL ?? DEFAULT_BASE

const SENSITIVE_PATTERNS = [
  { name: 'mobile-11', re: /\d{11}/ },
  { name: 'employee-EMP', re: /EMP-\d{6}/ },
  { name: 'name-full', re: /张伟/ },
]

/** 回环地址硬限制：不通过则立即退出，不发起任何请求 */
function resolveLoopbackBase(raw) {
  let u
  try {
    u = new URL(raw)
  } catch {
    console.error(`[FATAL] TEST_BASE_URL 不是合法 URL：${raw}`)
    process.exit(1)
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    console.error(`[FATAL] TEST_BASE_URL 协议不允许：${u.protocol}（仅允许 http/https）`)
    process.exit(1)
  }
  if (u.username || u.password) {
    console.error('[FATAL] TEST_BASE_URL 不允许包含用户名或密码')
    process.exit(1)
  }
  // URL.hostname 对 IPv6 返回 "[::1]"，统一归一化
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  const ALLOWED = new Set(['localhost', '127.0.0.1', '::1'])
  if (!ALLOWED.has(host)) {
    console.error(`[FATAL] TEST_BASE_URL 仅允许回环地址（localhost/127.0.0.1/::1），实际为：${host}`)
    process.exit(1)
  }
  if (u.pathname !== '/' && u.pathname !== '') {
    console.error(`[FATAL] TEST_BASE_URL 不应包含路径：${u.pathname}`)
    process.exit(1)
  }
  return u.origin
}

const BASE = resolveLoopbackBase(RAW_BASE)

/** 唯一测试 ID：36 进制时间戳 + 随机后缀，避免出现 11 位连续数字触发敏感误报 */
function newTestId() {
  const ts = Date.now().toString(36).toUpperCase()
  const rnd = Math.random().toString(36).slice(2, 8).toUpperCase()
  return `G05-T${ts}-${rnd}`
}

const results = []
let cleanupId = null

function record(id, name, ok, detail) {
  results.push({ id, name, ok, detail })
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${id} ${name}${detail ? ' | ' + detail : ''}`)
}

function scanSensitive(text) {
  const hits = []
  for (const p of SENSITIVE_PATTERNS) {
    if (p.re.test(text)) hits.push(p.name)
  }
  return hits
}

async function req(method, path, body) {
  const url = `${BASE}${path}`
  const init = { method, headers: { 'content-type': 'application/json' } }
  if (body !== undefined) init.body = JSON.stringify(body)
  const res = await fetch(url, init)
  const text = await res.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = null
  }
  return { status: res.status, text, json }
}

async function main() {
  console.log(`[INFO] base=${BASE}（回环地址校验通过）`)

  // —— 前置：服务可达性 ——
  const health = await req('GET', '/api/v1/evacuation-plans')
  if (health.status !== 200) {
    console.error(`[FATAL] 本地 Worker 不可用：GET /api/v1/evacuation-plans -> ${health.status}`)
    process.exit(1)
  }
  console.log('[INFO] 本地 Worker 可达，返回 200')

  // —— 冲突检测：确保测试 ID 未被占用 ——
  let testId = newTestId()
  for (let i = 0; i < 5; i++) {
    const probe = await req('GET', `/api/v1/evacuation-plans/${encodeURIComponent(testId)}`)
    if (probe.status === 404) break
    testId = newTestId()
    if (i === 4) {
      console.error('[FATAL] 无法生成未占用的测试 ID')
      process.exit(1)
    }
  }
  cleanupId = testId
  console.log(`[INFO] 测试 ID = ${testId}（冲突检测通过：404 未占用）`)

  const baseBody = { id: testId, buildingId: 'G05-B1', startFloor: 1, startArea: 'G05-A' }

  // T1: POST type='building' → 400
  {
    const r = await req('POST', '/api/v1/evacuation-plans', { ...baseBody, type: 'building' })
    const ok =
      r.status === 400 &&
      r.json &&
      typeof r.json.error === 'string' &&
      r.json.error.includes('不允许创建整栋楼方案')
    const sens = scanSensitive(r.text)
    record('T1', "POST type='building' → 400", ok && sens.length === 0, `status=${r.status} error=${r.json?.error ?? '-'} sensitive=${sens.join(',') || 'none'}`)
  }

  // T2: POST id='DEMO-xxx' → 400
  {
    const r = await req('POST', '/api/v1/evacuation-plans', {
      id: 'DEMO-G05-PROBE',
      buildingId: 'G05-B1',
      startFloor: 1,
      startArea: 'G05-A',
    })
    const ok =
      r.status === 400 &&
      r.json &&
      typeof r.json.error === 'string' &&
      r.json.error.includes('DEMO- 前缀')
    const sens = scanSensitive(r.text)
    record('T2', "POST 指定 id='DEMO-xxx' → 400", ok && sens.length === 0, `status=${r.status} error=${r.json?.error ?? '-'} sensitive=${sens.join(',') || 'none'}`)
  }

  // T3: POST 正常 → 201（回归）
  {
    const r = await req('POST', '/api/v1/evacuation-plans', baseBody)
    const ok =
      r.status === 201 &&
      r.json &&
      r.json.id === testId &&
      String(r.json.type ?? '') !== 'building'
    const sens = scanSensitive(r.text)
    record('T3', 'POST 正常创建 → 201（回归）', ok && sens.length === 0, `status=${r.status} id=${r.json?.id ?? '-'} type=${r.json?.type ?? '-'} sensitive=${sens.join(',') || 'none'}`)
  }

  // T4: PATCH type='building' → 400
  {
    const r = await req('PATCH', `/api/v1/evacuation-plans/${encodeURIComponent(testId)}`, { type: 'building' })
    const ok =
      r.status === 400 &&
      r.json &&
      typeof r.json.error === 'string' &&
      r.json.error.includes('不支持修改 type')
    const sens = scanSensitive(r.text)
    record('T4', "PATCH type='building' → 400", ok && sens.length === 0, `status=${r.status} error=${r.json?.error ?? '-'} sensitive=${sens.join(',') || 'none'}`)
  }

  // T5: PATCH status → 200（回归）
  {
    const r = await req('PATCH', `/api/v1/evacuation-plans/${encodeURIComponent(testId)}`, { status: 'CONFIRMED' })
    const ok = r.status === 200 && r.json && r.json.status === 'CONFIRMED'
    const sens = scanSensitive(r.text)
    record('T5', 'PATCH status → 200（回归）', ok && sens.length === 0, `status=${r.status} body.status=${r.json?.status ?? '-'} sensitive=${sens.join(',') || 'none'}`)
  }

  // T6: GET 详情 → 200 + legacy=true（回归）
  {
    const r = await req('GET', `/api/v1/evacuation-plans/${encodeURIComponent(testId)}`)
    const ok = r.status === 200 && r.json && r.json.legacy === true && r.json.id === testId
    const sens = scanSensitive(r.text)
    record('T6', 'GET 详情 → 200 + legacy=true（回归）', ok && sens.length === 0, `status=${r.status} legacy=${r.json?.legacy ?? '-'} sensitive=${sens.join(',') || 'none'}`)
  }

  // —— 汇总 ——
  const failed = results.filter((x) => !x.ok)
  console.log('')
  console.log(`[SUMMARY] total=${results.length} pass=${results.length - failed.length} fail=${failed.length}`)
  console.log(`[CLEANUP_ID] ${cleanupId}`)
  if (failed.length) {
    console.log('[RESULT] FAILED')
    process.exit(1)
  }
  console.log('[RESULT] ALL PASSED')
  process.exit(0)
}

main().catch((e) => {
  console.error('[FATAL] 脚本异常：', e?.message ?? e)
  if (cleanupId) console.log(`[CLEANUP_ID] ${cleanupId}`)
  process.exit(1)
})

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

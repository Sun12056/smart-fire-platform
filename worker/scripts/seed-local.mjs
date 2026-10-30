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

#!/usr/bin/env node
// 受守卫保护的正式部署入口：先校验 D1 配置，通过后才调用 wrangler deploy。
// 不依赖 shell 的 && 语义（Windows cmd / PowerShell / bash 行为一致）。
// 用法：npm run deploy   （构建检查请用 npm run deploy:dry-run）
//
// 参数策略：拒绝 --config/-c、--env/-e、--cwd 传入（见 findForbiddenArg 注释），
// 否则守卫校验的是 worker/wrangler.toml，wrangler 实际可能部署另一份配置。
// 该检查先于任何子进程执行，命中即以退出码 2 终止。
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
export const WORKER_DIR = resolve(__dirname, '..')
const DEFAULT_CHECK = resolve(__dirname, 'check-d1-config.mjs')
const DEFAULT_WRANGLER = resolve(WORKER_DIR, 'node_modules', 'wrangler', 'bin', 'wrangler.js')

/**
 * 禁止透传给 `wrangler deploy` 的参数（守卫只校验 worker/wrangler.toml）。
 *
 * 依据 wrangler 4.147.0 的实际 CLI 定义（`wrangler-dist/cli.js`，yargs）：
 *   · config: { alias: 'c', type: 'string', requiresArg: true }
 *   · env:    { alias: 'e', type: 'string', requiresArg: true }
 *   · cwd:    { type: 'string', requiresArg: true }（改变配置查找目录）
 * 因此以下任一种写法都会让 wrangler 读取「守卫没有校验过」的配置：
 *   --config x / --config=x / -c x / -c=x / -cx / --env x / --env=x / -e x / -ex / --cwd x / --cwd=x
 * 注意：yargs 不做长参数前缀缩写匹配，故只需精确匹配长参数名；
 * 短参数按首字母匹配即可覆盖 `-cVALUE` 这类「短参数带值」写法。
 * `--env-file` 只加载环境变量文件、不改变配置文件路径，故不拦截。
 */
const FORBIDDEN_LONG = ['config', 'env', 'cwd']
const FORBIDDEN_SHORT = ['c', 'e']
const SHORT_TO_LONG = { c: 'config', e: 'env' }

/**
 * 在参数列表中查找会绕过守卫的禁用参数。
 * @param {string[]} args
 * @returns {{arg: string, reason: string} | null}
 */
export function findForbiddenArg(args = []) {
  for (const raw of args) {
    if (typeof raw !== 'string' || raw.length < 2 || raw[0] !== '-') continue
    if (raw.startsWith('--')) {
      const name = raw.slice(2).split('=')[0]
      if (FORBIDDEN_LONG.includes(name)) {
        return { arg: raw, reason: `--${name} 会改变 wrangler 实际读取的配置或环境` }
      }
      continue
    }
    const short = raw[1]
    if (FORBIDDEN_SHORT.includes(short)) {
      return { arg: raw, reason: `-${short} 是 --${SHORT_TO_LONG[short]} 的短别名` }
    }
  }
  return null
}

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
  // 0) 参数检查必须发生在任何子进程启动之前：
  //    --config/-c、--env/-e、--cwd 会让 wrangler 使用守卫没有校验过的配置，
  //    命中即拒绝（不跑守卫、不启动 wrangler、不产生任何副作用）。
  const forbidden = findForbiddenArg(args)
  if (forbidden) {
    log.error(`[deploy-guarded] ❌ 拒绝参数：${forbidden.arg}`)
    log.error(`[deploy-guarded] 原因：${forbidden.reason}；守卫只校验 worker/wrangler.toml，必须与实际部署使用的配置一致。`)
    log.error('[deploy-guarded] 已终止：未运行 D1 守卫，也未调用 wrangler deploy。')
    return 2
  }

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

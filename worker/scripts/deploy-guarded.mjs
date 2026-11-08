#!/usr/bin/env node
// 受守卫保护的部署入口（多目标版）：
//   · production（默认）：校验 worker/wrangler.toml → 调用 wrangler deploy
//   · trial            ：校验 worker/wrangler.trial.toml（并跨配置比对生产 D1 id）→ 调用 wrangler deploy --config
//
// 参数策略（deny-by-default 白名单）：
//   仅允许 `--target production` / `--target trial`（含 `--target=VALUE` 形式）；
//   任何其他参数（含位置参数、短参数、裸 `--`）一律拒绝，且拒绝发生在任何子进程启动之前（退出码 2）。
//   理由：`--config/-c`、`--env/-e`、`--cwd`、`--name`、`--var`、`--route`、`--define`、`--outdir`
//   等都会改变「部署名称 / 变量 / 路由 / 资源 / 目标」，使守卫校验的配置与实际部署的不一致。
//
// 路径隔离：
//   · production 路径只读取/部署 worker/wrangler.toml，**不读取 trial 配置、不执行跨配置比对**；
//   · trial 路径只把 trial 配置传给 wrangler deploy；生产配置**仅**用于 check-d1-config 的隔离比对，
//     绝不作为 trial 部署的配置文件。
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
export const WORKER_DIR = resolve(__dirname, '..')
const DEFAULT_CHECK = resolve(__dirname, 'check-d1-config.mjs')
const DEFAULT_WRANGLER = resolve(WORKER_DIR, 'node_modules', 'wrangler', 'bin', 'wrangler.js')

/** 目标 → 固定配置文件名（不接受外部路径）。 */
export const TARGET_CONFIG_FILES = Object.freeze({
  production: 'wrangler.toml',
  trial: 'wrangler.trial.toml',
})
const ALLOWED_TARGETS = new Set(Object.keys(TARGET_CONFIG_FILES))

/**
 * 解析部署参数（deny-by-default 白名单）。
 * 仅接受 `--target <production|trial>` / `--target=<production|trial>`，最多出现一次。
 *
 * @param {string[]} argv
 * @returns {{ ok: true, target: 'production' | 'trial' } | { ok: false, reason: string, arg: string }}
 */
export function parseDeployArgs(argv = []) {
  let target = 'production'
  let targetSeen = false

  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i]
    if (typeof raw !== 'string' || raw.length === 0) {
      return { ok: false, reason: '不接受空参数', arg: String(raw) }
    }
    if (raw === '--') {
      return { ok: false, reason: '不接受 `--` 分隔符（其后的参数无法被白名单校验）', arg: raw }
    }
    if (!raw.startsWith('--')) {
      return { ok: false, reason: '不接受位置参数或短参数（仅允许 --target）', arg: raw }
    }

    const eq = raw.indexOf('=')
    const name = eq >= 0 ? raw.slice(2, eq) : raw.slice(2)
    if (name !== 'target') {
      return { ok: false, reason: `参数不在白名单：--${name}（可能改变部署名称/变量/路由/资源/目标）`, arg: raw }
    }
    if (targetSeen) {
      return { ok: false, reason: '--target 重复出现，拒绝（不做“后者覆盖前者”推断）', arg: raw }
    }
    targetSeen = true

    let value
    if (eq >= 0) {
      value = raw.slice(eq + 1)
    } else {
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('-')) {
        return { ok: false, reason: '--target 缺少取值（production | trial）', arg: raw }
      }
      value = next
      i += 1
    }

    if (!ALLOWED_TARGETS.has(value)) {
      return { ok: false, reason: `--target 取值非法：${value}（仅允许 production | trial）`, arg: raw }
    }
    target = value
  }

  return { ok: true, target }
}

/**
 * 向后兼容的“禁止参数”查询：现在等价于「是否偏离白名单」。
 * @param {string[]} args
 * @returns {{ arg: string, reason: string } | null}
 */
export function findForbiddenArg(args = []) {
  const parsed = parseDeployArgs(args)
  if (parsed.ok) return null
  return { arg: parsed.arg, reason: parsed.reason }
}

/**
 * 可注入依赖，便于完全本地的控制流测试（不执行真实部署）。
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
  // 0) 参数白名单校验必须先于任何子进程
  const parsed = parseDeployArgs(args)
  if (!parsed.ok) {
    log.error(`[deploy-guarded] ❌ 拒绝参数：${parsed.arg}`)
    log.error(`[deploy-guarded] 原因：${parsed.reason}`)
    log.error('[deploy-guarded] 已终止：未运行 D1 守卫，也未调用 wrangler deploy。')
    return 2
  }

  const target = parsed.target
  const productionConfig = resolve(workerDir, TARGET_CONFIG_FILES.production)
  const trialConfig = resolve(workerDir, TARGET_CONFIG_FILES.trial)

  // 1) 守卫参数：production 与旧行为**逐字一致**（只传脚本，不传任何配置路径）
  const guardArgs =
    target === 'production'
      ? [checkScript]
      : [checkScript, trialConfig, '--compare', productionConfig]

  // 2) wrangler 参数：production 与旧行为一致（仅 deploy）；trial 只传 trial 配置
  const wranglerArgs =
    target === 'production' ? ['deploy'] : ['deploy', '--config', trialConfig]

  if (target === 'trial' && !existsSync(trialConfig)) {
    log.error(`[deploy-guarded] ❌ 找不到 trial 配置：${trialConfig}`)
    log.error('[deploy-guarded] 已终止：未运行 D1 守卫，也未调用 wrangler deploy。')
    return 1
  }

  const guard = spawn(nodePath, guardArgs, { stdio: 'inherit', cwd: workerDir })
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

  if (!existsSync(wranglerJs)) {
    log.error(`[deploy-guarded] ❌ 找不到本地 wrangler：${wranglerJs}`)
    return 1
  }
  const res = spawn(nodePath, [wranglerJs, ...wranglerArgs], { stdio: 'inherit', cwd: workerDir })
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

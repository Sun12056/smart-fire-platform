#!/usr/bin/env node
// 部署包装器测试（完全本地，不执行真实部署）：
//   · 守卫失败 / 无法启动 / 被信号终止 → Wrangler 不得启动；
//   · 守卫通过 → Wrangler 以 deploy 启动，cwd 固定 worker，参数透传；
//   · Wrangler 无法启动 / 被信号终止 / 无正常退出码 → 返回非零（不误报成功）；
//   · 从不同工作目录调用时，守卫仍能定位 worker/wrangler.toml。
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runGuardedDeploy, findForbiddenArg, WORKER_DIR } from './deploy-guarded.mjs'

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

// 10) 绕过守卫的参数必须被拒绝：检查先于任何子进程，命中即返回 2 且零 spawn
{
  const forbiddenCases = [
    ['--config=other.toml', ['--config=other.toml']],
    ['--config another.toml（空格分隔）', ['--config', 'another.toml']],
    ['-c other.toml', ['-c', 'other.toml']],
    ['-cother.toml（短参数带值）', ['-cother.toml']],
    ['-c=other.toml', ['-c=other.toml']],
    ['--env production（空格分隔）', ['--env', 'production']],
    ['--env=production', ['--env=production']],
    ['-e production', ['-e', 'production']],
    ['-eproduction（短参数带值）', ['-eproduction']],
    ['--cwd /tmp/other（改变配置查找目录）', ['--cwd', '/tmp/other']],
    ['--cwd=/tmp/other', ['--cwd=/tmp/other']],
  ]
  forbiddenCases.forEach(([label, args]) => {
    const log = makeLog()
    const { spawn, calls } = makeSpawn([{ status: 0 }, { status: 0 }])
    const code = runGuardedDeploy({ spawn, wranglerJs: guardScript, nodePath: 'node', args, log })
    check(`${label} → 退出码 2`, code === 2, code)
    check(`${label} → 不启动任何子进程（含守卫）`, calls.length === 0, calls.length)
    check(`${label} → 输出拒绝原因`, log.lines.join('\n').includes('拒绝参数'), log.lines)
  })

  // 参数检查优先于「守卫脚本是否存在」：即使守卫路径无效，也不得先跑守卫
  const log = makeLog()
  const { spawn, calls } = makeSpawn([{ status: 0 }, { status: 0 }])
  const code = runGuardedDeploy({
    spawn, wranglerJs: resolve(__dirname, 'not-exist-wrangler.js'), checkScript: resolve(__dirname, 'not-exist-guard.mjs'),
    nodePath: 'node', args: ['--config', 'x.toml'], log,
  })
  check('非法参数 + 不存在的守卫 → 仍返回 2', code === 2, code)
  check('非法参数 + 不存在的守卫 → 仍零 spawn', calls.length === 0, calls.length)

  // 多参数混合：任何一个命中即拒绝
  const logMix = makeLog()
  const mix = makeSpawn([{ status: 0 }, { status: 0 }])
  const codeMix = runGuardedDeploy({ spawn: mix.spawn, wranglerJs: guardScript, nodePath: 'node', args: ['--minify', '-e', 'prod'], log: logMix })
  check('合法与非法混合 → 整体拒绝', codeMix === 2 && mix.calls.length === 0, { code: codeMix, calls: mix.calls.length })

  // 重复参数也不得绕过（第二次出现同样被拒绝）
  const logDup = makeLog()
  const dup = makeSpawn([{ status: 0 }, { status: 0 }])
  const codeDup = runGuardedDeploy({ spawn: dup.spawn, wranglerJs: guardScript, nodePath: 'node', args: ['--config=a.toml', '--config=a.toml'], log: logDup })
  check('重复非法参数 → 拒绝', codeDup === 2 && dup.calls.length === 0, { code: codeDup, calls: dup.calls.length })
}

// 11) 合法参数仍按原样透传，且守卫与 Wrangler 使用同一 cwd、同一份配置
{
  const args = ['--minify']
  const { spawn, calls } = makeSpawn([{ status: 0 }, { status: 0 }])
  const code = runGuardedDeploy({ spawn, wranglerJs: guardScript, nodePath: 'node', args, log: makeLog() })
  check('合法参数 → 返回 0', code === 0, code)
  check('合法参数 → spawn 两次（守卫 + Wrangler）', calls.length === 2, calls.length)
  check('合法参数 → Wrangler 参数严格等于 [wranglerJs, deploy, ...原参数]（无静默改写）',
    JSON.stringify(calls[1]?.args) === JSON.stringify([guardScript, 'deploy', ...args]), calls[1]?.args)
  check('合法参数 → 守卫与 Wrangler 的 cwd 一致（同一配置文件）',
    calls[0]?.opts?.cwd === calls[1]?.opts?.cwd && calls[0]?.opts?.cwd === WORKER_DIR,
    { guardCwd: calls[0]?.opts?.cwd, wranglerCwd: calls[1]?.opts?.cwd })

  // --env-file 不改变配置文件路径，允许透传
  const ef = makeSpawn([{ status: 0 }, { status: 0 }])
  const codeEf = runGuardedDeploy({ spawn: ef.spawn, wranglerJs: guardScript, nodePath: 'node', args: ['--env-file', '.env.local'], log: makeLog() })
  check('--env-file 不被拦截（不改变配置路径）', codeEf === 0 && ef.calls.length === 2, { code: codeEf, calls: ef.calls.length })

  // findForbiddenArg 纯函数：安全参数返回 null
  check('findForbiddenArg 对安全参数返回 null', findForbiddenArg(['--minify', '--dry-run', '--env-file', '.env']) === null)
  check('findForbiddenArg 命中 --config', findForbiddenArg(['--config', 'a.toml'])?.arg === '--config')
  check('findForbiddenArg 命中 -cVALUE', findForbiddenArg(['-ca.toml'])?.arg === '-ca.toml')
}

console.log(`\n=== 部署包装器测试：${pass} 通过 / ${fail} 失败 ===`)
process.exit(fail ? 1 : 0)

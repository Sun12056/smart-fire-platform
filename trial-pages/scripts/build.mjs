#!/usr/bin/env node
// Trial Pages 构建：复用仓库根的前端构建能力，输出到 trial-pages/dist。
// 不修改根构建脚本、不修改生产 Pages 配置。
//
// 步骤：
//   1) 在仓库根执行 `npm run build`（除非传 --skip-frontend-build）
//   2) 复制根 dist/* → trial-pages/dist
//   3) 将 _routes.json 写入 trial-pages/dist 根部（Pages 要求）
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TRIAL_DIR = resolve(__dirname, '..')
const REPO_ROOT = resolve(TRIAL_DIR, '..')
const SRC_DIST = join(REPO_ROOT, 'dist')
const OUT_DIST = join(TRIAL_DIR, 'dist')
const ROUTES_SRC = join(TRIAL_DIR, '_routes.json')

const skipFrontend = process.argv.includes('--skip-frontend-build')

if (!skipFrontend) {
  console.log('[trial-pages] 构建前端（复用仓库根 npm run build）')
  execFileSync('npm', ['run', 'build'], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
}

if (!existsSync(SRC_DIST)) {
  console.error('[trial-pages] 缺少仓库根 dist/，请先执行 npm run build')
  process.exit(1)
}

rmSync(OUT_DIST, { recursive: true, force: true })
mkdirSync(OUT_DIST, { recursive: true })
cpSync(SRC_DIST, OUT_DIST, { recursive: true })

// _routes.json 必须位于 Pages 构建输出目录根部
writeFileSync(join(OUT_DIST, '_routes.json'), readFileSync(ROUTES_SRC, 'utf8'), 'utf8')

// AUTH-3：登录页必须随构建产物发布（匿名例外路径 /login 与 /login.html）
const LOGIN_SRC = join(TRIAL_DIR, 'login.html')
if (!existsSync(LOGIN_SRC)) {
  console.error('[trial-pages] 缺少 login.html（AUTH-3 登录页）')
  process.exit(1)
}
cpSync(LOGIN_SRC, join(OUT_DIST, 'login.html'))

// AUTH-9：登录页复用的设计稿静态资源（与 login.html 同级发布）
const LOGIN_ASSETS = ['auth.css', 'auth.js', 'orb-particles.js', 'favicon.svg']
for (const name of LOGIN_ASSETS) {
  const src = join(TRIAL_DIR, name)
  if (!existsSync(src)) {
    console.error(`[trial-pages] 缺少登录页资源 ${name}`)
    process.exit(1)
  }
  cpSync(src, join(OUT_DIST, name))
}

// AUTH-3：/login → /login.html 内部 rewrite（避免依赖 Pages 默认 html_handling）
const REDIRECTS_SRC = join(TRIAL_DIR, '_redirects')
if (existsSync(REDIRECTS_SRC)) {
  cpSync(REDIRECTS_SRC, join(OUT_DIST, '_redirects'))
}

console.log('[trial-pages] 输出就绪：dist/（含 _routes.json / _redirects / login.html）')

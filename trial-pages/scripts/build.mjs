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

console.log('[trial-pages] 输出就绪：dist/（含 _routes.json）')

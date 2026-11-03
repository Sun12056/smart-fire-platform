/**
 * DashboardView 方向显示契约 —— 源码级专项验证（P1.8.2 F2）
 *
 * ⚠️ 架构限制：本测试不挂载 Vue 组件（DashboardView 依赖 Pinia / 路由 / 组件树），
 *    以下为**源码级断言**，验证模板结构与数据接线，**不等于浏览器渲染测试**。
 *
 * 验证目标（Q2 契约在 Dashboard 三个展示面的统一落地）：
 *   1) 平面图箭头、tooltip、选中面板方向文本、左右方向键高亮共用同一「有效显示方向」；
 *   2) resolved / overridden 显示方向；none / conflict / undetermined / unlinked 显示中性占位；
 *   3) 缺失方向不再被默认伪造成「向右」；
 *   4) overridden 明确提示「未下发设备」。
 */
import { readFile } from 'node:fs/promises'
import {
  resolveDirectionDisplay,
  DIRECTION_VERDICT,
} from '../../shared/evacuation/deviceDirection.js'

let pass = 0
let fail = 0
const check = (label, ok, detail) => {
  if (ok) {
    pass += 1
    console.log(`  ✓ ${label}`)
  } else {
    fail += 1
    console.log(`  ✗ ${label}`, detail === undefined ? '' : JSON.stringify(detail))
  }
}

const src = await readFile(new URL('./DashboardView.vue', import.meta.url), 'utf8')

console.log('=== 一、五类状态 + overridden 的契约（复用纯函数，证明接线目标正确）===')
{
  const cases = [
    ['resolved', { state: DIRECTION_VERDICT.RESOLVED, direction: 'right' }, 'left', true, 'right'],
    ['none(verdict=null)', null, 'left', false, null],
    ['conflict', { state: DIRECTION_VERDICT.CONFLICT, direction: undefined }, 'left', false, null],
    ['undetermined', { state: DIRECTION_VERDICT.UNDETERMINED, direction: undefined }, 'left', false, null],
    ['unlinked', { state: DIRECTION_VERDICT.UNLINKED, direction: undefined }, 'left', false, null],
  ]
  for (const [name, verdict, stored, wantShow, wantDir] of cases) {
    const d = resolveDirectionDisplay(verdict, stored)
    check(`① ${name} ⇒ showArrow=${wantShow}`, d.showArrow === wantShow, d)
    check(`① ${name} ⇒ direction=${wantDir}`, d.direction === wantDir, d.direction)
  }
  const ov = resolveDirectionDisplay(
    { state: DIRECTION_VERDICT.OVERRIDDEN, direction: 'right', overrideSource: 'manual' },
    'left',
  )
  check('① overridden ⇒ showArrow=true 且显示覆盖方向 right', ov.showArrow === true && ov.direction === 'right' && ov.isManualOverride === true, ov)
}

console.log('=== 二、Dashboard 三处展示面统一接线（源码级）===')
{
  check('② 引入 resolveDirectionDisplay', src.includes('resolveDirectionDisplay'))
  check('② 引入 DIRECTION_VERDICT', src.includes('DIRECTION_VERDICT'))
  check('② 引入 overrideSourceLabelOf（来源文案统一解析）', src.includes('overrideSourceLabelOf'))
  check('② 定义 directionDisplayOf（复用契约函数）', /function directionDisplayOf\(dev\)/.test(src))
  check('② directionDisplayOf 读取本轮裁决 store.getRouteDirectionVerdict(dev.id)', /store\.getRouteDirectionVerdict\(dev\.id\)/.test(src))
  check('② directionText 走 directionDisplayOf，无效显示 —', /function directionText\(dev\)/.test(src) && src.includes("d.showArrow ? directionLabel(d.direction) : '—'"))
  check('② dirArrow 走 directionDisplayOf，无效显示 —', /function dirArrow\(dev\)/.test(src) && /d\.showArrow\) return '—'/.test(src))
  // 平面图 / tooltip / 面板 / 方向键
  check('② 平面图箭头仍由 dirArrow 统一渲染（:301/:552）', /{{ dirArrow\(dev\) }}/.test(src))
  check('② tooltip 使用 directionText(hoveredDevice)', /directionText\(hoveredDevice\)/.test(src))
  check('② 面板方向文本使用 directionText(selectedDeviceView)', /directionText\(selectedDeviceView\)/.test(src))
  check('② 左方向键 active 用 selectedDirectionDisplay.direction', /selectedDirectionDisplay\.direction === 'left'/.test(src))
  check('② 右方向键 active 用 selectedDirectionDisplay.direction', /selectedDirectionDisplay\.direction === 'right'/.test(src))
  check('② 存在 selectedDirectionDisplay 计算属性', /const selectedDirectionDisplay = computed/.test(src))
  // overridden 提示
  check('② 存在 selectedOverrideNote（overridden 提示）', /const selectedOverrideNote = computed/.test(src))
  check('② 覆盖提示分支绑定 v-if="selectedOverrideNote"', /v-if="selectedOverrideNote"/.test(src))
  check('② 覆盖提示改用 overrideSourceLabelOf 解析来源', /overrideSourceLabelOf\(verdict\.overrideSource\)/.test(src))
  check('② 不再回退「未下发设备」或原始来源字符串', !src.includes('未下发设备') && !/DIRECTION_OVERRIDE_SOURCE_LABELS\[/.test(src))
  // 缺失方向不得伪造为 right；不得再直接渲染历史方向
  check('② 删除「缺方向默认 right」兜底（无 dev.direction || \'right\'）', !/return dev\.direction \|\| 'right'/.test(src))
  check('② 已删除 getDeviceDirection（共享兜底函数）', !/getDeviceDirection/.test(src))
  check('② 面板不再直接渲染 selectedDeviceView.direction', !/selectedDeviceView\.direction/.test(src))
}

console.log('=== 三、变异验证（内存，不污染工作区）：把面板方向改回直读原始 dev.direction ===')
{
  const panelUsesDisplay = (s) => /directionText\(selectedDeviceView\)/.test(s)
  check('③ 变异前：面板方向文本走 directionText', panelUsesDisplay(src) === true)

  // 模拟「恢复为直接读取原始历史 direction」
  const mutated = src.replace('directionText(selectedDeviceView)', 'directionLabel(selectedDeviceView.direction)')
  check('③ 变异后：面板方向文本断言应失败', panelUsesDisplay(mutated) === false)
  check('③ 变异后：确实出现直读 selectedDeviceView.direction', /selectedDeviceView\.direction/.test(mutated) === true)

  // 变异 2：平面图箭头（dirArrow）改回直读 dev.direction（绕过裁决）。
  // 用索引切片替换，避免依赖跨行字符串（CRLF/LF 行尾差异）。
  const arrowUsesDisplay = (s) => /function dirArrow\(dev\)[\s\S]{0,160}directionDisplayOf\(dev\)/.test(s)
  const di = src.indexOf('function dirArrow(dev)')
  const seg = src.slice(di, di + 160)
  const mutated2 = src.replace(seg, seg.replace('directionDisplayOf(dev)', '{ showArrow: true, direction: dev.direction }'))
  check('③ 变异前：dirArrow 走 directionDisplayOf', arrowUsesDisplay(src) === true)
  check('③ 变异2（dirArrow 绕过裁决）被捕获', arrowUsesDisplay(mutated2) === false)
}

console.log('')
console.log(`=== 结果：${pass} 通过 / ${fail} 失败 ===`)
if (fail) process.exit(1)

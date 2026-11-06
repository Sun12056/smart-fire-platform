/**
 * EvacuationView 方向显示契约 —— F6 三字段源码级专项验证（P1.8.2 / R-01 / R-11）
 *
 * ⚠️ 架构限制：本测试**不挂载 Vue 组件**，不引入任何第三方依赖，
 *    也不修改业务实现。以下全部是「源码结构断言」：验证三个字段的
 *    数据来源、计算条件（门控 / 拼接 / 回落）与模板绑定点。
 *    **源码结构测试 ≠ Vue 运行时渲染验证** —— 它不能证明 computed 求值结果、
 *    v-if 实际分支、DOM 文本或响应式更新；UI 层实机证据见 S7 验收实施报告
 *    §10.1（Evacuation 来源文案）与 §10.3.3（V-1/V-2/V-3 属性级采样）。
 *
 * 覆盖边界（避免与既有测试重复）：
 *   - 不重跑 resolveDirectionDisplay 状态矩阵 / 方向白名单 / 覆盖来源文案
 *     （shared/evacuation/deviceDirection.test.mjs 已覆盖）；
 *   - 不重做大箭头 v-if、方向文字、方向键、占位图形、透明度弱化、
 *     旋转角 watch、历史字段保留等断言
 *     （src/stores/fireStore.deviceDirection.test.mjs 组十六 / 组十七已覆盖）；
 *   - 不重复 BuildingView 2D/3D（T3）与 Dashboard（T4）结构断言。
 *   本文件只针对 S5 收口后的三个字段：
 *     displayDirText / staleNoteText / recommendedDirectionLabel。
 *
 * 断言方式：按「标记字符串」切片定位，**不依赖绝对行号**。
 */
import { readFile } from 'node:fs/promises'

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

const src = await readFile(new URL('./EvacuationView.vue', import.meta.url), 'utf8')

/** 取 [from, to) 两个标记之间的源码；标记缺失返回空串，由调用方断言捕获 */
const block = (from, to) => {
  const a = src.indexOf(from)
  if (a < 0) return ''
  const b = src.indexOf(to, a + from.length)
  return b < 0 ? '' : src.slice(a, b)
}

const displayFn = block('function displayDirText(dev)', 'const moduleStatus = computed')
const staleNote = block('const staleNoteText = computed', 'function displayDirText(dev)')
const overrideSrc = block('const overrideSourceLabel = computed', 'const staleNoteText = computed')
const verdictLabel = block('const routeVerdictLabel = computed', 'const routeVerdictClass = computed')
const directionDisp = block('const directionDisplay = computed', 'const routeVerdictIsStale = computed')
const recBody = block('const recommendedDirection = computed', 'const recommendedDirectionLabel = computed')
const recLabel = block('const recommendedDirectionLabel = computed', 'const remoteDispatchAvailable = false')
const evacStoreObj = block('const evacStore = reactive', 'const statusClass = computed')
const staleTpl = block('v-if="routeVerdictIsStale"', '<!-- 设备状态 -->')
const riskTpl = block('<div v-if="evacStore.fireSimulation && evacStore.currentDevice?.risk"', '<button class="suggest-btn"')
const listSpan = block('class="device-item-dir', '</span>')
const writeLine = (src.match(/const newDirection =[^\r\n]*/) || [''])[0]

console.log('')
console.log('=== 一、displayDirText：列表行方向（接线与回落）===')
{
  check('F1 函数存在且签名接收 dev', displayFn.length > 0 && /function displayDirText\(dev\)/.test(displayFn))
  check('F1 判定入口为 getRouteDirectionVerdict 且显式 String(dev.id) 归一化',
    /getRouteDirectionVerdict/.test(displayFn) && /String\(dev\.id\)/.test(displayFn))
  check('F1 以 resolveDirectionDisplay(verdict, dev.direction) 收口',
    /resolveDirectionDisplay\(verdict,\s*dev\.direction\)/.test(displayFn))
  check('F1 只取 .direction 并经 directionMap 输出中文',
    /resolveDirectionDisplay\([^)]*\)\.direction/.test(displayFn) && /directionMap\[dir\]/.test(displayFn))
  check('F1 无有效方向回落「—」', /dir \? directionMap\[dir\] : '—'/.test(displayFn))
  check('F1 全文不再直读 directionMap[dev.direction]', !/directionMap\[dev\.direction\]/.test(src))
  check('F1 列表行模板绑定 displayDirText(dev)', /\{\{ displayDirText\(dev\) \}\}/.test(listSpan))
}

console.log('')
console.log('=== 二、staleNoteText：来源拼接与显示分支 ===')
{
  check('F2 computed 存在', staleNote.length > 0)
  check('F2 base 由 routeVerdictLabel + storedDirectionLabel 组成',
    /routeVerdictLabel\.value/.test(staleNote) && /storedDirectionLabel\.value/.test(staleNote))
  check('F2 base 含固定句式（旧方向 / 非本轮有效指引 / 占位图形）',
    /设备仍保留旧方向/.test(staleNote) && /该值非本轮有效指引/.test(staleNote) && /无方向占位图形/.test(staleNote))
  check('F2 来源非空才追加括号',
    /overrideSourceLabel\.value \?/.test(staleNote) && staleNote.includes('（${overrideSourceLabel.value}）'))
  check('F2 来源为空直接回落 base（不产生多余标点）', /:\s*base/.test(staleNote))
  check('F2 来源走 overrideSourceLabelOf 且无表查 / 原文回退',
    /overrideSourceLabelOf\(src\)/.test(overrideSrc) &&
    !/DIRECTION_OVERRIDE_SOURCE_LABELS\[/.test(src) &&
    !/\|\| src/.test(overrideSrc))
  check('F2 模板 stale 分支绑定 staleNoteText，manual 分支为互斥 v-else-if',
    /v-if="routeVerdictIsStale"[\s\S]{0,200}\{\{ staleNoteText \}\}/.test(staleTpl) &&
    /v-else-if="directionDisplay\.isManualOverride"/.test(staleTpl))
  // Vue 条件链要求 v-if / v-else-if 为相邻兄弟节点：两者之间只允许空白或 HTML 注释，
  // 不得插入其它元素或文本节点，否则 v-else-if 会被编译成独立 v-if，运行时不再互斥。
  check('F2 模板互斥：v-if(stale) 与 v-else-if(manual) 为相邻兄弟节点（Vue 条件链必要条件）',
    /v-if="routeVerdictIsStale"/.test(staleTpl) &&
    /v-else-if="directionDisplay\.isManualOverride"/.test(staleTpl) &&
    /v-if="routeVerdictIsStale"[^>]*>[\s\S]*?<\/div>\s*(?:<!--[\s\S]*?-->\s*)*<div\s+v-else-if="directionDisplay\.isManualOverride"/.test(staleTpl))
}

console.log('')
console.log('=== 三、recommendedDirectionLabel：showArrow 门控与写侧保持 ===')
{
  check('F3 computed 存在', recLabel.length > 0)
  check('F3 双前置门控 showArrow && recommendedDirection',
    /directionDisplay\.value\.showArrow && recommendedDirection\.value/.test(recLabel))
  check('F3 真分支 directionMap[recommendedDirection.value]、假分支「—」',
    /directionMap\[recommendedDirection\.value\]/.test(recLabel) && /:\s*'—'/.test(recLabel))
  check('F3 recommendedDirection 本体不含 showArrow',
    recBody.length > 0 && !/showArrow/.test(recBody))
  check('F3 evacStore 兼容对象暴露 recommendedDirectionLabel',
    /recommendedDirectionLabel/.test(evacStoreObj))
  check('F3 系统建议块绑定 evacStore.recommendedDirectionLabel',
    /class="risk-suggest"/.test(riskTpl) && /\{\{ evacStore\.recommendedDirectionLabel \}\}/.test(riskTpl))
  check('F3 写侧 newDirection 保持既有优先级（未被收口改动）',
    /pendingDirection\.value \|\| recommendedDirection\.value \|\| oppositeMap\[dev\.direction\] \|\| dev\.direction/.test(writeLine))
}

console.log('')
console.log('=== 四、接线一致性与防回归（不重复既有纯函数断言）===')
{
  check('F4 引入统一 resolver 与来源 helper',
    /import\s*\{[\s\S]{0,200}resolveDirectionDisplay[\s\S]{0,200}\}\s*from\s*'\.\.\/\.\.\/shared\/evacuation\/deviceDirection\.js'/.test(src) &&
    /overrideSourceLabelOf/.test(src))
  check('F4 displayDirText 保留 accessor 防御守卫',
    /typeof fn === 'function'/.test(displayFn))
  check('F4 三字段均被模板 / 兼容对象消费（无悬空定义）',
    /\{\{ displayDirText\(dev\) \}\}/.test(src) &&
    /\{\{ staleNoteText \}\}/.test(src) &&
    /\{\{ evacStore\.recommendedDirectionLabel \}\}/.test(src))
  check('F4 依赖链可见：routeVerdictLabel 读状态标签、directionDisplay 走 resolver',
    /DIRECTION_VERDICT_LABELS/.test(verdictLabel) && /resolveDirectionDisplay\(/.test(directionDisp))
}

console.log('')
console.log(`=== 结果：${pass} 通过 / ${fail} 失败 ===`)
if (fail) process.exit(1)

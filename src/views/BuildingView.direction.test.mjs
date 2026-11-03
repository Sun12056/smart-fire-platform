/**
 * BuildingView 2D 方向显示 —— resolver 口径 + 源码结构验证（P1.8.2 R-01 · F3 · S3）
 *
 * ⚠️ 本测试架构不挂载 Vue 组件（BuildingView 依赖 Pinia / Element Plus / 路由），
 *    因此分两层：① 直接验证统一 resolver 的显示口径；② 对 .vue 源码做结构断言，
 *    确认箭头/占位/探针确由 resolver 驱动，且未破坏坐标、点击、弹窗、状态颜色、应急脉冲。
 */
import { readFile } from 'node:fs/promises'
import {
  resolveDirectionDisplay, DIRECTION_VERDICT, DIRECTION_VERDICT_LABELS,
} from '../../shared/evacuation/deviceDirection.js'
import { deviceRuntimeState } from '../../shared/device/deviceRuntime.js'

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

const src = await readFile(new URL('./BuildingView.vue', import.meta.url), 'utf8')
// 「不得出现」类断言先剥离注释，避免注释里的字样造成误判
const code = src.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '')

console.log('')
console.log('=== 一、resolver 显示口径（本页显示的判定依据）===')
{
  const v = (state, direction, overrideSource) => ({ state, direction, overrideSource })

  const resolved = resolveDirectionDisplay(v(DIRECTION_VERDICT.RESOLVED, 'left'), 'right')
  check('① resolved + left ⇒ 显示箭头，方向取裁决值',
    resolved.showArrow === true && resolved.direction === 'left', resolved)

  const remote = resolveDirectionDisplay(v(DIRECTION_VERDICT.REMOTE, 'right'), 'left')
  check('② remote + right ⇒ 显示箭头（后端下发同样有效）',
    remote.showArrow === true && remote.direction === 'right', remote)

  const manual = resolveDirectionDisplay(v(DIRECTION_VERDICT.OVERRIDDEN, 'left', 'manual'), 'right')
  check('③ overridden(manual) + left ⇒ 显示箭头',
    manual.showArrow === true && manual.direction === 'left' && manual.isManualOverride === true, manual)

  const avoid = resolveDirectionDisplay(v(DIRECTION_VERDICT.OVERRIDDEN, 'right', 'fire-avoidance'), 'right')
  check('④ fire-avoidance ⇒ 不显示箭头（来源标签由 F6 收口，本页不扩范围）',
    avoid.showArrow === false && avoid.direction === null && avoid.stale === true && avoid.overrideSource === 'fire-avoidance', avoid)

  for (const st of [DIRECTION_VERDICT.CONFLICT, DIRECTION_VERDICT.UNDETERMINED, DIRECTION_VERDICT.UNLINKED, DIRECTION_VERDICT.NONE]) {
    const d = resolveDirectionDisplay(v(st, 'left'), 'left')
    check(`⑤ ${st} ⇒ 不显示箭头（有历史值只置 stale）`,
      d.showArrow === false && d.direction === null && d.stale === true, d)
  }

  const bad = resolveDirectionDisplay(v(DIRECTION_VERDICT.RESOLVED, 'up'), 'left')
  check('⑥ resolved + 非法方向 up ⇒ 无箭头且 invalidDirection=true',
    bad.showArrow === false && bad.direction === null && bad.invalidDirection === true, bad)

  const badOnHidden = resolveDirectionDisplay(v(DIRECTION_VERDICT.UNDETERMINED, 'up'), 'left')
  check('⑦ 不可显示状态 + 非法载荷 ⇒ invalidDirection=false（只在可显示状态置位）',
    badOnHidden.showArrow === false && badOnHidden.invalidDirection === false, badOnHidden)

  const badStored = resolveDirectionDisplay(v(DIRECTION_VERDICT.CONFLICT), 'RIGHT')
  check('⑧ 设备历史方向非法 ⇒ 不作为 storedDirection 输出',
    badStored.storedDirection === null && badStored.stale === false, badStored)

  check('⑨ 七态标签齐备（弹窗「方向来源」依赖）',
    Object.values(DIRECTION_VERDICT).every((st) => typeof DIRECTION_VERDICT_LABELS[st] === 'string'), DIRECTION_VERDICT_LABELS)

  const samples = [resolved, remote, manual, avoid, bad, badOnHidden, badStored]
  check('⑩ 不变式：direction !== null ⇔ showArrow',
    samples.every((d) => (d.direction !== null) === d.showArrow), samples.map((d) => [d.direction, d.showArrow]))
}

console.log('')
console.log('=== 二、源码结构：箭头与占位由 resolver 驱动 ===')
{
  check('S1 引入统一 resolver 与状态标签',
    /import\s*\{[^}]*resolveDirectionDisplay[^}]*\}\s*from\s*'\.\.\/\.\.\/shared\/evacuation\/deviceDirection\.js'/.test(code))

  check('S2 判定入口读 store.directionVerdictIndex（S2 导出的索引）',
    /function devDisplayOf\(dev\)\s*\{[\s\S]{0,160}store\.directionVerdictIndex\.get\(String\(dev\.id\)\)/.test(code))

  check('S3 devDisplayOf 以 resolveDirectionDisplay 收口（历史值只作为 storedDirection 入参）',
    /return resolveDirectionDisplay\(verdict, dev\.direction\)/.test(code))

  check('S4 全文不再直接调用 deviceDirection()', !/deviceDirection\s*\(/.test(code))

  check('S5 devDir 返回渲染方向并以空串兜底',
    /function devDir\(dev\)\s*\{\s*return devDisplayOf\(dev\)\.direction \|\| ''\s*\}/.test(code))

  check('S6 devDirPath 在无有效方向时不产出路径',
    /function devDirPath\(dev, idx\)\s*\{[\s\S]{0,120}if \(!dir\) return ''/.test(code))

  check('S7 箭头条件为 isEvacuationLight && showArrow',
    /v-if="isEvacuationLight\(dev\) && devDisplayOf\(dev\)\.showArrow"[\s\S]{0,80}class="plan-device-dir"/.test(code))

  check('S8 占位圆环使用 v-else-if 且仅疏散灯（非疏散灯不渲染圆环）',
    /v-else-if="isEvacuationLight\(dev\)"[\s\S]{0,80}class="plan-device-dir-none"/.test(code)
    && (code.match(/plan-device-dir-none/g) || []).length === 2) // 模板 1 处 + CSS 1 处

  check('S9 占位圆环半径 r="9.5" 且无填充',
    /class="plan-device-dir-none"[\s\S]{0,200}r="9\.5"/.test(code)
    && /\.plan-device-dir-none\s*\{[^}]*fill:\s*none/.test(code))

  const ringBlock = (code.match(/v-else-if="isEvacuationLight\(dev\)"[\s\S]{0,400}?\/>/) || [''])[0]
  check('S10 占位圆环无指向性几何（无 d= 路径数据）',
    ringBlock.length > 0 && !/\sd="/.test(ringBlock), ringBlock)

  const ringCss = (code.match(/\.plan-device-dir-none\s*\{[^}]*\}/) || [''])[0]
  check('S11 占位样式为中性虚线描边（dasharray + stroke-width 同属占位类）',
    /stroke-dasharray:\s*2 2/.test(ringCss) && /stroke-width:\s*1\.5/.test(ringCss), ringCss)
}

console.log('')
console.log('=== 三、源码结构：探针与弹窗 ===')
{
  check('T1 data-dir 绑定渲染方向', /:data-dir="devDir\(dev\)"/.test(code))
  check('T2 data-dir-state 绑定裁决状态', /:data-dir-state="devDirState\(dev\)"/.test(code))
  check('T3 data-dir-source 绑定覆盖来源', /:data-dir-source="devDirSource\(dev\)"/.test(code))

  check('T4 弹窗新增「方向来源」行且读取 popupDirectionState',
    /方向来源[\s\S]{0,160}popupDirectionState/.test(code))

  check('T5 方向来源行仅对疏散指示灯显示（避免给非灯具显示无意义行）',
    /v-if="isEvacuationLight\(popupDevice\)"[\s\S]{0,120}方向来源/.test(code))

  check('T6 popupDirectionState 由裁决状态标签派生',
    /const popupDirectionState = computed\([\s\S]{0,200}DIRECTION_VERDICT_LABELS\[devDisplayOf\(popupDevice\.value\)\.state\]/.test(code))
}

console.log('')
console.log('=== 四、既有行为保持（坐标 / 点击 / 弹窗 / 颜色 / 光晕 / 应急脉冲）===')
{
  check('P1 设备坐标数组未被改动',
    /const positions = \[90, 195, 300, 90, 195, 300, 140, 250\]/.test(code)
    && /const positions = \[70, 70, 70, 210, 210, 210, 150, 150\]/.test(code))

  check('P2 点击仍绑定 showDevice（浮窗行为不变）',
    /@click="showDevice\(dev\)"/.test(code)
    && /function showDevice\(dev\)\s*\{\s*popupDevice\.value = dev/.test(code))

  check('P3 状态颜色分支保留（离线灰 / 应急暖白 / 异常红 / 常态绿）',
    /if \(dev\.status === 'offline'\) return '#475569'/.test(code)
    && /return '#F8F3E4'/.test(code) && /return '#EF4444'/.test(code) && /return '#22C55E'/.test(code))

  check('P4 亮度光晕保留（deviceBrightnessRatio 驱动）',
    /function devGlowOpacity\(dev\)\s*\{[\s\S]{0,140}deviceBrightnessRatio\(dev\)/.test(code))

  check('P5 应急脉冲规则保留（真实箭头仍脉冲）',
    /\.plan-device\.emergency-pulse \.plan-device-dir\s*\{[\s\S]{0,80}evacDirPulse/.test(code)
    && /@keyframes evacDirPulse/.test(code))

  check('P6 未用透明度/灰度/删除线弱化真实箭头（箭头类内无 opacity/grayscale/line-through）',
    !/\.plan-device-dir\s*\{[^}]*(opacity|grayscale|line-through)/.test(code)
    && !/grayscale\(/.test(code) && !/line-through/.test(code))

  check('P7 占位透明度只出现在占位类内（白名单，不套用到真实箭头）',
    /\.plan-device-dir-none\s*\{[^}]*opacity:\s*0\.55/.test(code)
    && (code.match(/opacity:\s*0\.55/g) || []).length === 1)

  check('P8 弹窗既有信息行未被删（编号 / 电量 / 通信 / 上报）',
    /设备编号/.test(code) && /电量/.test(code) && /通信状态/.test(code) && /最后上报/.test(code))

  check('P9 楼层设备列表点击仍走 showDevice（列表行为不变）',
    (code.match(/@click="showDevice\(dev\)"/g) || []).length >= 2)

  check('P10 本页不出现直读方向映射（directionMap）的旁路',
    !/directionMap\s*\[/.test(code))
}

console.log('')
console.log('=== 五、3D 层（F4 / F5）：三态贴图 / tick 现算 / 权威运行态不被改写 ===')
{
  const utilsSrc = await readFile(new URL('../components/building3d/building3dUtils.js', import.meta.url), 'utf8')
  const emSrc = await readFile(new URL('../components/building3d/EmergencyLight3D.js', import.meta.url), 'utf8')
  const emCode = emSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

  const neutralBody = (utilsSrc.match(/export function makeNeutralDirectionTexture[\s\S]*?\n\}/) || [''])[0]
  check('D1 building3dUtils 导出 makeNeutralDirectionTexture', neutralBody.length > 0)
  check('D2 中性贴图只用圆弧（无 moveTo / lineTo 直线段）',
    /ctx\.arc\(/.test(neutralBody) && !/moveTo|lineTo/.test(neutralBody), neutralBody)
  check('D3 中性贴图为虚线圆环（setLineDash）', /setLineDash\(/.test(neutralBody))

  check('D4 EmergencyLight3D 引入 makeNeutralDirectionTexture',
    /import \{[^}]*makeNeutralDirectionTexture[^}]*\} from '\.\/building3dUtils\.js'/.test(emCode))
  check('D5 构造期创建 neutralTex 贴图', /this\.neutralTex = makeNeutralDirectionTexture\(\)/.test(emCode))

  check('D6 _bindEvac 接收 store（初值也走 resolver）', /_bindEvac\(dev, store\)\s*\{/.test(emCode))
  check('D7 update() 绑定设备时传入 store', /this\._bindEvac\(d, store\)/.test(emCode))

  check('D8 判定入口读 store.directionVerdictIndex',
    /_displayOf\(dev, store\)\s*\{[\s\S]{0,160}store\.directionVerdictIndex/.test(emCode))
  check('D9 判定入口以 resolveDirectionDisplay 收口',
    /return resolveDirectionDisplay\(verdict, dev\.direction\)/.test(emCode))
  check('D10 三态贴图映射：left / right / 其余中性',
    /_textureOf\(dir\)\s*\{[\s\S]{0,200}return this\.neutralTex/.test(emCode))

  check('D11 不再直接调用 deviceDirection()', !/deviceDirection\s*\(/.test(emCode))
  check('D12 不再用 dev.direction || \'right\' 兜底造方向', !/dev\.direction \|\| 'right'/.test(emCode))

  // 切片用未剥注释的源码：注释本身就是可靠的分界标记
  const tickStart = emSrc.indexOf('tick(t, store) {')
  const tickEnd = emSrc.indexOf('// 应急照明灯：暖白呼吸')
  const tickBody = (tickStart >= 0 && tickEnd > tickStart) ? emSrc.slice(tickStart, tickEnd) : ''
  check('D13 tick 内每帧现算显示结果（_displayOf）', /_displayOf\(dev, store\)/.test(tickBody))
  check('D14 tick 内按 _textureOf 选图并置 needsUpdate',
    /_textureOf\(dir\)/.test(tickBody) && /needsUpdate = true/.test(tickBody))
  check('D15 不缓存每设备显示结果（无 *Cache 字段）', !/dirCache|displayCache|dispCache/i.test(emCode))

  const rtStart = emSrc.lastIndexOf('_syncRuntime(rec, dev) {')
  const runtimeBody = rtStart >= 0 ? emSrc.slice(rtStart) : ''
  check('D16 _syncRuntime 仍以 deviceRuntimeState 为准（权威运行态）',
    /const rt = deviceRuntimeState\(dev\)/.test(runtimeBody) && /Object\.assign\(rec\.runtime, rt\)/.test(runtimeBody), runtimeBody)
  check('D17 未把渲染方向写回 rec.runtime（权威 direction 保持原值）',
    !/rec\.runtime\.direction\s*=/.test(emCode))
  check('D18 rec 记录渲染方向与状态（rec.dir / displayState / verdict）',
    /rec\.displayState = disp\.state/.test(emCode) && /rec\.verdict = disp/.test(emCode) && /sprite: spr, dir, device: dev/.test(emCode))

  check('D19 Sprite 比例与高度偏移保持原值（0.8 / top + 0.75）',
    /spr\.scale\.set\(0\.8, 0\.8, 1\)/.test(emCode) && /spr\.position\.set\(pos\.x, pos\.top \+ 0\.75, pos\.z\)/.test(emCode))
  check('D20 设备筛选逻辑保持（canonical buildingId 优先、别名兜底）',
    /const did = String\(buildingIdOf\(d\) \|\| ''\)/.test(emCode) && /buildingNameOf\(d\) === bldName/.test(emCode))
  check('D21 透明度逻辑保持（离线 0.25 / 应急脉冲 / 亮度驱动）',
    /rec\.sprite\.material\.opacity = 0\.25/.test(emCode)
    && /0\.55 \+ 0\.45 \* pulse/.test(emCode)
    && /0\.55 \+ 0\.35 \* deviceBrightnessRatio\(dev\)/.test(emCode))

  // 三态输入归一：tick 里把「无方向」统一成空串，再交给 _textureOf 落中性贴图
  check('D22 tick 内以 disp.direction || \'\' 归一三态输入',
    /const dir = disp\.direction \|\| ''/.test(tickBody))

  // 权威运行态与渲染方向解耦：rec.runtime.direction 沿用 B4-03 折叠（up→'right'），
  // 渲染侧对同一非法值 fail-closed；两者互不覆盖（D17 保证不回写）
  const rtRaw = deviceRuntimeState({ id: 'D-RAW', status: 'normal', currentMode: 'daily', direction: 'up', brightness: 80, emergencyFlash: false })
  const dispBad = resolveDirectionDisplay({ state: DIRECTION_VERDICT.RESOLVED, direction: 'up' }, null)
  check('D23 运行态沿用 B4-03 折叠（up→right），渲染方向同值 fail-closed（null），二者解耦',
    rtRaw.direction === 'right' && dispBad.direction === null && dispBad.showArrow === false,
    [rtRaw.direction, dispBad.direction])
}

console.log('')
console.log(`=== 结果：${pass} 通过 / ${fail} 失败 ===`)
if (fail) process.exit(1)

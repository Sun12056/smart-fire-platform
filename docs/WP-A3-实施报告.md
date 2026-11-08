# WP-A3 实施报告 · 验收真实性修复与基础 CI 建设

- 项目：智慧消防平台（Smart Fire Platform）
- 仓库：`Sun12056/smart-fire-platform` ／ 分支 `main`
- 唯一执行基线：`390f06b8625525dafe36c0c5702e27d65809f71e`（`390f06b`）
- 任务编号：WP-A3 ／ 所属阶段：阶段 A：安全与验收基线
- 本轮授权：代码修改 + 纯 Node 测试 + CI 工作流文件本地创建
- **未授权且未执行：浏览器 E2E 现场运行与失败注入、Commit、Push、Deploy、D1/数据库操作**
- 报告性质：**实施后报告**（替代此前同名审阅稿）。任务书 §十 的 Commit/Push 门禁仍然有效。

> 本报告区分五种状态：**已完成 / 已测试通过 / 未验证 / 未实施 / 被阻断**。
> 「代码已修改」不等于「任务已验收」。

---

## 0. 状态总览

| 状态 | 内容 |
|---|---|
| **已完成** | A3-1 ~ A3-4 全部代码修改（4 改 5 增）；执行前基线与实施后基线核验；最终 diff 越界检查 |
| **已测试通过** | 退出码验证 37 断言；方向负向验证 60 断言；`npm run test:unit` 2378 断言；Worker 三脚本 41 / 70 / 15 断言；8 个 CJS 文件 `node --check`；lint 0 诊断 |
| **未验证** | b401 / b402 / b403 浏览器 E2E 现场运行与失败注入（需 Edge + Vite + Worker + 固定端口，需单独授权）；CI 远端运行记录 |
| **未实施** | 未 commit、未 push、未部署、未执行 D1 migration / Seed；未修改 D-01 涉及的任何产品代码 |
| **被阻断** | CI 运行证据（A3-09）—— 阻断原因是 push 未授权，非技术问题 |

### 验收证据矩阵

| 编号 | 验收要求 | 状态 | 证据 |
|---|---|---|---|
| A3-01 | 公共 summary 失败时返回非零 | **已实施 + 已测试通过（纯 Node 失败注入）** | §5 场景②③④⑤；`e2e-exit.test.cjs` 37/0 |
| A3-02 | b401 不再无条件覆盖失败退出码 | **已实施**；静态验证通过，E2E 现场**未验证** | §3 差异；源码级断言 |
| A3-03 | b402 不再无条件覆盖失败退出码 | **已实施**；静态验证通过，E2E 现场**未验证** | §3 差异；源码级断言 |
| A3-04 | b403 不再无条件覆盖失败退出码 | **已实施**；静态验证通过，E2E 现场**未验证** | §3 差异；源码级断言 |
| A3-05 | b403 预期逻辑独立于 DOM 兜底 | **已实施 + 已测试通过** | §6 变异验证（旧逻辑判 match、新逻辑判 gap） |
| A3-06 | null/非法方向能被测试识别 | **已实施 + 已测试通过** | §6 第二段 24 条负向断言 |
| A3-07 | 单元测试全部通过 | **已测试通过** | §7：16 文件 / 2378 断言 / 0 失败 / exit 0 |
| A3-08 | Worker 脚本测试全部通过 | **已测试通过** | §8：41 / 70 / 15 断言，均 exit 0 |
| A3-09 | CI 配置有效且失败能阻断工作流 | 配置文件**已创建**；**未验证**（未 push，无 Actions 运行记录） | §9 |
| A3-10 | 未发生越界修改和数据库写入 | **已验证** | §11、§12；`git diff --stat` 仅 4 个授权文件 |

> A3-02 / A3-03 / A3-04 的「退出码在真实断言失败时变为非零」最终需靠浏览器 E2E 现场失败注入确认；本轮**只做到静态验证 + 纯 Node 等价验证（同一公共函数、同一 finally 结构）**，故不写成「通过」。

---

## 1. 执行前 Git 基线

| 检查项 | 实测 | 判定 |
|---|---|---|
| 分支 | `main` | ✅ |
| HEAD | `390f06b8625525dafe36c0c5702e27d65809f71e` | ✅ 与基线一致 |
| 暂存区 | 空 | ✅ |
| 未暂存差异 | `git diff --numstat` 空 | ✅ |
| `git diff --check` | 无输出 | ✅ |
| 未跟踪文件 | 22 项（20 份 docs + `$null` + `worker/e2e-journey-exit.log'`） | ✅ 与任务书 §3.2 一致 |
| 目标文件归属 | 4 个目标文件 `git hash-object` 与 `HEAD:<path>` blob 完全一致 | ✅ 无他方未提交修改 |

关于 `git status` 中的 ` M vite.config.js`：`git hash-object vite.config.js` = `1f05816dbedefff4b0b90faf5b0bc14158192015` = `HEAD:vite.config.js` = 索引 blob，**无实质内容差异**（仅 stat 缓存），非其他 Agent 改动，本任务未触碰。

实施前的 4 个目标文件 blob（用于事后对照）：

```
76f606ae2b4cdb044386cd0d316d491c1b180a78  worker/e2e-lib.cjs
8f6554fc88205b70b3a6e90ac460705cd82048d8  worker/e2e-p173-b401-3d-plan-watch.cjs
4244e3fe000f521db3bb2f19efbfd8339dbcb5f4  worker/e2e-p173-b402-lighting-source.cjs
31f44a2ab8832f72d27dc0351fb3f210a20b00d7  worker/e2e-p173-b403-runtime-unity.cjs
```

---

## 2. 目标文件清单（实测文件名，非任务书占位）

| 角色 | 实际路径 |
|---|---|
| 公共退出码 | `worker/e2e-lib.cjs` |
| b401 | `worker/e2e-p173-b401-3d-plan-watch.cjs` |
| b402 | `worker/e2e-p173-b402-lighting-source.cjs` |
| b403 | `worker/e2e-p173-b403-runtime-unity.cjs` |
| npm 入口 | `package.json` → `test:unit`、`test:e2e:b401/b402/b403`（**未改动**） |
| CI | `.github/workflows/ci.yml`（原不存在） |
| Worker 测试入口 | `worker/scripts/check-d1-config.test.mjs`、`deploy-guarded.test.mjs`、`seed-local.test.mjs` |

`summary()` 的全部 7 个调用方中，只有 b401/b402/b403 存在「无条件置 0」缺陷；其余 4 个（`batchA-bizcmd`、`batchB01-reset-ui`、`batchB02-3d-reset`、`golden-path-final`）与 `b305-p0p1` 的写法在 `summary()` 内部置位后依然幂等正确，**因此保持原样，未做无谓改动**。

---

## 3. 实际修改文件清单（4 改 5 增）

### 修改（`git diff --stat`，共 103 插入 / 39 删除）

| 文件 | 变更量 | 关键改动 |
|---|---|---|
| `worker/e2e-lib.cjs` | 19 行 | 断言台账与退出码下放 `e2e-exit.cjs`；`check/summary` 变薄适配；新增导出 `markFailure/exitCodeFor/safeCleanup` |
| `worker/e2e-p173-b401-3d-plan-watch.cjs` | 12 行 | 移除 `process.exitCode = 0`；清理走 `safeCleanup`；补外层 `.catch → markFailure()` |
| `worker/e2e-p173-b402-lighting-source.cjs` | 12 行 | 同上 |
| `worker/e2e-p173-b403-runtime-unity.cjs` | 99 行 | 同上 + 方向原始值保留、去掉兜底与 `x.dir &&` 短路、方向分桶断言、契约缺口 D-01 记录 |

### 新增

| 文件 | 作用 |
|---|---|
| `worker/e2e-exit.cjs` | 退出码单一权威（零依赖）：`createLedger / record / exitCodeFor / markFailure / finalize / safeCleanup` |
| `worker/e2e-direction.cjs` | 方向期望侧契约（零依赖）：`classifyDirection / expectedDirection / compareDirection / bucketDirections` |
| `worker/e2e-exit.test.cjs` | 第一层退出码验证（子进程 + 源码级断言，37 条） |
| `worker/e2e-direction.test.cjs` | 第二层方向负向验证（含变异验证，60 条） |
| `.github/workflows/ci.yml` | 基础 CI（unit + worker-scripts 两个作业） |

未改动：`package.json`、`package-lock.json`、任何 `src/**`、`shared/**`、`worker/scripts/**`、`vite.config.js`、既有未跟踪文件。

---

## 4. 每项修改的原因与实现方式

### 4.1 A3-1 退出码单一权威

**缺陷**：`summary()` 只打印不设退出码；`results` 为模块级单例，退出码判定散落在各调用方，7 个调用方中 3 个写错。

**实现**：新增 `worker/e2e-exit.cjs`，把「台账 + 判定 + 写入」收敛到一处。

```js
function exitCodeFor(results) { return results && Number(results.failed) > 0 ? EXIT_FAIL : EXIT_OK }

function markFailure(target = process) {
  if (!target) return EXIT_FAIL
  if (!target.exitCode) target.exitCode = EXIT_FAIL   // 只升不降，永不写 0
  return target.exitCode
}

function finalize(ledger, title, options = {}) {
  /* 打印与原实现完全一致：=== 标题：N 通过 / M 失败 === ＋ 失败项列表 */
  if (exitCodeFor(results) === EXIT_FAIL) markFailure(target)
  return results
}
```

关键性质：
1. `finalize`（即 `summary`）是全仓唯一写退出码的公共入口；
2. `markFailure` 采用「非零则不写」的写法，**任何路径都不可能把退出码写回 0**；
3. 原报告格式（通过/失败计数、失败项列表、`→ JSON` 附加信息）逐字保留，现有脚本与人工阅读习惯不受影响；
4. 现存的 `if (r.failed) process.exitCode = 1`、`process.exit(r.failed ? 1 : 0)` 写法保持幂等兼容，无需改动。

`e2e-lib.cjs` 侧只保留薄适配，`module.exports` 中 `check / summary / results` 三个名字与语义不变（**接口兼容**），并新增三个辅助导出。

### 4.2 A3-2 三个脚本的退出码覆盖与清理安全

**缺陷**：`finally` 内 `process.exitCode = 0` 无条件覆盖；`browser.close()` 无保护，抛错会顶掉 `summary()` 并替换原始异常；`cmd('RESET').catch(() => {})` 静默吞掉复位失败。

**实现**（b401/b402/b403 同构）：

```js
  } finally {
    await safeCleanup('测试隔离复位（RESET）', () => cmd('RESET'))
    await sleep(600)
    await safeCleanup('浏览器关闭', () => browser.close())
    summary('P1.7.3-B4-0X 专项回归（…）')
  }
})()
  .catch((e) => { console.error('B4-0X 回归异常：', e); markFailure() })
```

- `safeCleanup` 捕获清理异常并打印告警，**不改变退出码、不抛出**，因此不会掩盖原始断言失败；
- 复位失败从「静默」改为「可见告警」；
- 外层 `.catch` 保证异常路径的退出码非零，并保留堆栈输出；
- **未删除、未放宽任何断言**。

### 4.3 A3-3 b403 方向期望独立化

**缺陷**：`:109` 的 `norm(d.direction) === 'left' ? 'left' : 'right'` 与产品 `deviceDirection()` 逐字符同构 → 自证；`:187/:329` 的 `x.dir &&` 会静默跳过空方向。

**实现**：

1. `readRuntime` 改为保留原始方向：
   ```js
   const rawDirOf = (d) => (d && d.direction !== undefined ? d.direction : DIR_MISSING)
   // st(d) → { status, currentMode, directionRaw, dirLegal, brightness, emergencyFlash }
   ```
   不再出现任何 `=== 'left' ? 'left' : 'right'` 形式的归一化；`dirLegal` 仅做「是否属于 {left,right}」的域检查，与产品兜底无关。
2. 方向从 `d2Mismatch` / `d3RuntimeMismatch` 中剥离，改为收集原始对 `{ authRaw, downRaw }` 并交回 Node 侧分桶：
   ```js
   d3Directions: d3.map((x) => ({ id: x.id, kind: x.kind, authRaw: x.auth.directionRaw, downRaw: x.dir })),
   d2Directions,
   ```
   `d3RuntimeMismatch` 中的方向项加了 `x.auth.dirLegal &&` 前置条件，**未知方向不再被误判为产品失败**（决策 B）。
3. `e2e-direction.cjs` 提供独立分类与比对：`left/right` 严格相等；下游缺失/非法 → `missing`（真缺陷）；权威侧未知 → `gap`（契约缺口）。
4. `assertDirections()` 每个采样点产出 3 条断言：合法方向逐台严格相等、下游不得缺失、必须存在合法样本；`gap` 只打印 `⚠ 契约缺口 D-01` 清单，**既不计为通过也不判产品失败**，且分桶守恒（四桶之和 == 样本数），不可能被静默丢弃。
5. 采样点从 2 处扩展到 7 处：基线 T3-a(3D)、T6(2D)、T3-b(3D 翻转后)、T7 RESET 后(3D+2D)、T8 新一轮(2D)。

### 4.4 A3-4 基础 CI

新增 `.github/workflows/ci.yml`，两个作业（详见 §9）。触发：`push:[main]`、`pull_request`、`workflow_dispatch`；`permissions: contents: read`；`concurrency` 取消重复运行。

依据与约束：
- Node 20（决策 2）；仓库无 `.nvmrc`/`engines`，`vite@5.4.21` 声明 `^18 || >=20`；
- `npm ci` 仅用现有 `package-lock.json`（决策 3）。原因：`test:unit` 中 5 个测试文件 `import { createServer } from 'vite'`，干净环境不装依赖跑不了；
- Worker 三脚本经核查仅使用 `node:` 内置模块与同目录本地模块，**不安装 worker 依赖**（也避免 `playwright-core`）；
- 不执行 D1 migration / 真实 Seed / `wrangler deploy`；不纳入依赖 Edge 的 E2E；npm 默认任一 step 非零即作业失败。

---

## 5. 退出码失败注入结果（第一层，纯 Node）

命令：`node worker/e2e-exit.test.cjs`
结果：**37 通过 / 0 失败，退出码 0**

| # | 场景 | 期望 | 实测 | 断言数 |
|---|---|---|---|---|
| ① | 全部断言通过 | 0 | **0** | 2 |
| ② | 存在断言失败 | 非零 | **1** | 3 |
| ③ | 未处理异常（try 内抛错 + finally） | 非零 | **1**，且 `boom-in-body` 未被吞掉 | 2 |
| ④ | 断言失败 + finally 清理成功 | 非零 | **1**，失败项仍列出（`must-not-be-green`） | 2 |
| ⑤ | 断言失败 + 清理抛异常 | 非零且原失败不被掩盖 | **1**，`cleanup-boom` 与 `must-not-be-green` 同时可见 | 3 |
| ⑥ | 全部通过 + 清理抛异常 | 0（不伪造失败） | **0**，并打印清理告警 | 2 |
| ⑦ | `markFailure` 只升不降 | 1 / 1 / 保留 7 | **1 / 1 / 7** | 3 |
| ⑧ | `finalize` 无失败时不清除既有非零码 | 7 | **7** | 2 |
| ⑨ | 真正未处理的 Promise 拒绝 | 非零 | **非零** | 1 |
| ⑩ | 源码级：4 个文件无 `process.exitCode = 0` / `process.exit(0)`；B4 清理走 `safeCleanup`、有 `markFailure` 兜底；`e2e-lib` 已委托 | 全部成立 | **全部通过** | 17 |

说明：③④⑤均为「子进程 + 真实 `finally` 结构 + 真实 `summary()` 调用」，与 b401/b402/b403 的实际控制流同构；这是浏览器不可用条件下**能取得的最强证据**，但仍**不等价于**真实 E2E 失败注入（见 §10）。

---

## 6. b403 方向负向测试结果（第二层，纯 Node）

命令：`node worker/e2e-direction.test.cjs`
结果：**60 通过 / 0 失败，退出码 0**

| 分组 | 覆盖 | 结论 |
|---|---|---|
| 一、合法方向域 | 域只含 left/right；两值分类正确 | 通过 |
| 二、null/缺失/非法 | `null`、`undefined`、`''`、`'LEFT'`、`'up'`、`' left'`、`0`、`true` 共 8 类 × 3 条断言 | 全部 `legal=false`，且期望值**永不等于 `'right'`**，恒为 `unspecified` |
| 三、合法方向互不颠倒 | `left→left`、`right→right` | 通过 |
| 四、严格比对 | `left vs right` ⇒ mismatch；`right vs left` ⇒ mismatch；`left vs ''/null/'up'` ⇒ missing | 通过（下游缺失不再被跳过） |
| 五、权威未知 ⇒ 契约缺口 | `null/undefined/''/'up' vs 'right'` ⇒ **gap，不是 match** | 通过 |
| 六、反自证（变异验证） | 复现旧兜底期望：`null/undefined/'up'` 均被判 **match**（缺陷确实存在）；新逻辑一律判 **gap**；同时保留「合法 left 未被误伤」「left vs right 仍能判红」 | 通过 |
| 七、分桶守恒 | 6 条混合样本 ⇒ match 2 / mismatch 1 / missing 1 / gaps 2，四桶之和 = total = 6；含空方向的记录进 missing 桶而**不是被丢弃** | 通过 |
| 八、自定义取值器 | `bucketDirections` 支持自定义 getter | 通过 |

**结论**：测试期望侧已与产品兜底逻辑解耦，具备识别「未知方向被兜底成 right」的能力。

---

## 7. 单元测试结果

```
命令：npm run test:unit
退出码：0
测试文件：16 / 失败文件 0
断言合计：2378 通过 / 0 失败
日志：%TEMP%\wp-a3-unit-after.log
```

逐文件：57、181、410、429、237、45、216、68、58、213、100、110、64、117、38、35（均 0 失败）。与实施前基线完全一致，**无回归**。

另：8 个 CJS 文件 `node --check` 全部 exit 0；IDE lint 诊断 0 条。

---

## 8. Worker 脚本测试结果

| 命令 | 退出码 | 结果 | 日志 |
|---|---|---|---|
| `node worker/scripts/check-d1-config.test.mjs` | 0 | 41 通过 / 0 失败 | `%TEMP%\wp-a3-d1-after.log` |
| `node worker/scripts/deploy-guarded.test.mjs` | 0 | 70 通过 / 0 失败 | `%TEMP%\wp-a3-deploy-after.log` |
| `node worker/scripts/seed-local.test.mjs` | 0 | 15 通过 / 0 失败 | `%TEMP%\wp-a3-seed-after.log` |

未执行 `wrangler d1 migrations`、未执行真实 Seed、未连接任何数据库、未部署。

---

## 9. CI 配置与运行结果

### 9.1 配置

`.github/workflows/ci.yml`（新增；仓库此前无 `.github/`，因此不存在覆盖既有工作流的风险）

| 作业 | 步骤 |
|---|---|
| `unit`（Node 20） | checkout → setup-node（cache:npm）→ `npm ci` → `npm run test:unit` → `node worker/e2e-exit.test.cjs` → `node worker/e2e-direction.test.cjs` |
| `worker-scripts`（Node 20） | checkout → setup-node → `node worker/scripts/check-d1-config.test.mjs` → `deploy-guarded.test.mjs` → `seed-local.test.mjs` |

触发：`push(branches:[main])`、`pull_request`、`workflow_dispatch`。`permissions: contents: read`。任一 step 非零 ⇒ 作业失败 ⇒ 工作流失败。

### 9.2 运行结果

**未验证**。原因：触发 Actions 需要 push（或 PR），而 push 未授权。本地已完成 YAML 落盘与「所引用命令全部实跑通过」的等价核验（§7、§8），但**没有远端 Actions 运行记录**，因此 A3-09 只能标记为「未验证」。

补充说明：本地依赖中不含独立 YAML 解析器（`require.resolve('yaml')` 失败），因此该文件**未经机器语法解析**，仅经人工逐行核对；语法有效性最终以首次远端运行为准。

---

## 10. 未执行测试及原因

| 未执行项 | 原因 | 解除条件 |
|---|---|---|
| b401 / b402 / b403 浏览器 E2E 现场运行 | 需 `playwright-core` + 本机 Edge（`channel:'msedge'`）+ Vite（`localhost:5199`）+ Worker（`127.0.0.1:8787`）+ 固定端口；本轮授权明确排除 | 单独授权，并先核查端口/进程占用与清理行为 |
| 第四层真实失败注入（浏览器内） | 同上 | 同上 |
| A3-09 的 Actions 运行记录 | push 未授权 | 授权 push / PR 后采集 |

---

## 11. 副作用记录

| 项目 | 发生 | 说明 |
|---|---|---|
| 仓库文件修改 | ✅ 4 改 5 增 | 全部在授权清单内 |
| `git add` / `commit` / `push` | ❌ | 暂存区仍为空 |
| `git reset/checkout/clean/stash` | ❌ | 未执行 |
| `git add .` / `git add -A` | ❌ | 未执行 |
| D1 migration / 真实 Seed / DB 写入 | ❌ | 未执行 |
| Wrangler deploy / 远程 Secrets | ❌ | 未执行 |
| 生产数据清理 / 真实设备控制 | ❌ | 未执行 |
| E2E 浏览器启动 | ❌ | 未执行 |
| `npm install` / `npm audit` | ❌ | 未执行（未新增/升级任何依赖） |
| 既有未跟踪文件 | 未触碰 | 20 份 docs + `$null` + `worker/e2e-journey-exit.log'` 全部保持原样 |
| `vite.config.js` | 未触碰 | 无内容差异（blob 哈希一致） |
| 临时日志 | 4 个 | `%TEMP%\wp-a3-*-after.log`（仓库外） |
| 本报告 | 1 个新增未跟踪文件 | `docs/WP-A3-实施报告.md` |

---

## 12. 最终 Git 状态

```
分支：main
HEAD：390f06b8625525dafe36c0c5702e27d65809f71e（未变）
暂存区：空

已跟踪修改（4，全部在授权范围）：
 M worker/e2e-lib.cjs
 M worker/e2e-p173-b401-3d-plan-watch.cjs
 M worker/e2e-p173-b402-lighting-source.cjs
 M worker/e2e-p173-b403-runtime-unity.cjs

新增未跟踪（本轮 5 + 报告 1）：
?? .github/
?? worker/e2e-exit.cjs
?? worker/e2e-direction.cjs
?? worker/e2e-exit.test.cjs
?? worker/e2e-direction.test.cjs
?? docs/WP-A3-实施报告.md

未跟踪（既有，保持原样）：$null、20 份 docs、worker/e2e-journey-exit.log'
```

`git diff --stat`：4 files changed, 103 insertions(+), 39 deletions(-)。
`git diff --check`：无输出。
越界检查：diff 中**没有任何** `src/**`、`shared/**`、`worker/scripts/**`、`package.json`、`vite.config.js` 的改动。

---

## 13. 未解决问题与风险

### 13.1 D-01 契约缺口（按决策 B 保留，未修改产品语义）

产品内仍并存两套相反语义：

| 位置 | 未知方向语义 |
|---|---|
| `shared/device/deviceRuntime.js:29,70-74`（`DEFAULT_DEVICE_DIRECTION='right'` + `directionOf`） | 入口处就把 null/缺失/空串归一为 `'right'` |
| `shared/device/deviceRuntime.js:179-182`（`deviceDirection`） | 非法值归 `'right'` |
| `src/components/building3d/EmergencyLight3D.js:102,113` | `dev.direction \|\| 'right'` |
| `shared/evacuation/deviceDirection.js:135-137,396-411` | `null` ⇒ 不渲染有效箭头（`showArrow: !!direction`） |
| `src/views/DashboardView.vue:1635-1643` + 对应单测 | 明确禁止「缺方向默认 right」 |

**新发现（重要）**：由于 `normalizeDeviceRuntime` 在数据入口就调用 `directionOf()`，`fireStore.devices[i].direction` 实际上**几乎不可能为 null**，2D/3D 的 `deviceDirection()` 兜底在运行时基本不可观测。这带来两个后果：
1. b403 的 `gap`（契约缺口）分支在现场大概率**为空**，因此「未知方向」的行为实际上是由数据入口的归一化掩盖的，而不是被测试真正约束；
2. 若后续要真正验证未知方向的渲染行为，必须绕过 `normalizeDeviceRuntime` 构造样本 —— 属产品语义裁决范畴，本轮**未做**。

建议：D-01 单独立项，先在契约层统一「未知方向」语义，再补跨层测试。

### 13.2 修复后 E2E 将真实转红（预期行为，需知悉）

历史日志显示（`.gitignore` 的 `*.log`，只读引用）：

- `worker/e2e-b403-run.log`：`24 通过 / 7 失败`（失败项全为 LightingView 的 T4/T5/T9）
- `worker/e2e-b402-run.log`：`18 通过 / 6 失败`（T2/T3/T6 的 LightingView 断言）

这些是**既有产品缺陷**，过去因 `process.exitCode = 0` 而被伪装为成功。修复后，`npm run test:e2e:b402` / `b403` 会以**非零退出码**如实失败。这是 WP-A3 的预期效果，但意味着这两个脚本在相关产品缺陷修复前将长期为红——需项目负责人知悉并另行安排修复，**不属于 WP-A3 范围**。

### 13.3 其余风险

| 风险 | 说明 | 缓解 |
|---|---|---|
| `summary()` 只能防止「公共函数写 0」，无法阻止调用方手动写 `process.exitCode = 0` | 语言层面无法禁止 | 已加入源码级断言（§5 场景⑩）守护这 4 个文件；新增脚本若违反，`e2e-exit.test.cjs` 会红 |
| `safeCleanup` 让清理失败不失败 | 若清理真的污染了后续套件，本脚本仍可能绿 | 告警输出 + 后续可扩展为显式 `check`，本轮未改（避免行为变更） |
| CI 只覆盖纯 Node 层 | 浏览器 E2E 无自动守卫 | 由 §10 的单独授权流程补 |
| `d2Directions` 只收集 `isLight(dev)` | 非灯具设备的 `data-dir` 本就不由 `devDir` 定义（仅疏散指示灯渲染箭头） | 与产品渲染条件一致 |

---

## 14. 后续建议与待授权事项

1. **审阅本轮 diff**（§3、§12），确认无越界。
2. **单独授权浏览器 E2E 失败注入**：先核查 5199 / 8787 端口占用与 Edge 启动、进程清理，再验证「正常通过 / 人为断言失败非零 / 人为异常非零 / finally 不覆盖 / b403 方向负向可发现错误」。这是 A3-02/03/04 从「已实施」升级为「已验收」的必要步骤。
3. **单独授权 commit / push**：push 后采集 Actions 运行记录，补齐 A3-09；建议同时用一次「故意制造失败的 PR」验证 CI 阻断能力。
4. **D-01 立项**：统一产品「未知方向」语义（涉及 `deviceRuntime.js` / `EmergencyLight3D.js` / 数据入口归一化）。
5. **LightingView 既有缺陷**（§13.2）另立任务修复，使 b402/b403 回到绿色。

---

**结论：A3-1 ~ A3-4 的代码修改与纯 Node 验证已完成；浏览器 E2E 现场注入、CI 远端运行、Commit/Push 均未执行且未验证。WP-A3 尚未验收，等待项目负责人审查本报告与 diff。**

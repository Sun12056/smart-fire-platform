# 智慧消防平台 · Cloudflare 后端整改与验证报告

> 阶段：A1–A4 最小必要整改 + 本地验证（已获授权）
> 执行日期：2026-10-19
> 授权边界遵守：本阶段**未**创建 D1、未执行远端迁移/写入、未 `wrangler deploy`、未改远端配置/Secret、未改 Pages 环境变量、未提交/推送 Git。
>
> **修订记录（2026-10-31）**：追加 R-3（部署守卫参数拦截）、R-2（本地 dev CORS 注入）与 C3 最终版本复核快照（第六~八节）。
> 原文 A1–A4 内容与第三节测试数据**保持原样**，仅就地补注其时间属性（历史快照，非 C3 最终版本结果）。

---

## 一、修改文件清单及原因

| 文件 | 修改内容 | 原因（对应问题） |
|---|---|---|
| `worker/wrangler.toml` | `database_id` 由全零 UUID 改为 `<REPLACE_WITH_D1_DATABASE_ID>` 占位符 + 完善注释；更新 SEED_TOKEN 注释为 fail-closed 说明 | A1：消除“可被静默部署”的全零 ID；明确真实 ID 的配置时机与方式 |
| `worker/package.json` | `migrate:local/remote` 由 `d1 execute --file=0001` 改为 `d1 migrations apply` | A2：自动按序执行 0001+0002，避免再次遗漏迁移，并引入迁移状态跟踪 |
| `worker/src/routes/admin.ts` | seed 增加「无 token → 501」fail-closed 分支；500 错误不再回传 `err.message` | A3：Token 缺失安全失败；不泄露底层错误 |
| `worker/src/index.ts` | CORS 由 `origin:'*'` 改为白名单回调（生产仅 Pages 域名 + 可选 `ALLOWED_ORIGINS`） | A4：收紧生产跨域来源 |
| `worker/src/types.ts` | `Env` 增加 `ALLOWED_ORIGINS?: string` | A4：支撑 CORS 白名单的类型定义 |

**改动统计**：`git diff --stat` = 5 files changed, 36 insertions(+), 11 deletions(-)（**2026-10-19 历史统计**）。无无关模块重构。

> 统计口径说明：上述 `36(+)/11(-)` 是 **2026-10-19 首次整改时**、对上文 5 个已跟踪 Worker 文件的统计。C3 收口时（2026-10-31）**同一组 5 个已跟踪 Worker 文件**（`worker/package.json`、`worker/src/index.ts`、`worker/src/routes/admin.ts`、`worker/src/types.ts`、`worker/wrangler.toml`）的统计为 **45 insertions(+), 14 deletions(-)**。两者**统计范围相同、时间不同**，不可混用。

### 补充修改（R-3 / R-2，2026-10-31）

| 文件 | 修改内容 | 原因（对应问题） |
|---|---|---|
| `worker/scripts/deploy-guarded.mjs` | 新增 `findForbiddenArg()`：在启动任何子进程之前拒绝 `--config`/`-c`、`--env`/`-e`、`--cwd`（含 `=` 形式与空格分隔形式），命中即 `return 2` 终止 | R-3：原实现把 CLI 参数原样透传给 Wrangler，守卫校验的是 `worker/wrangler.toml`，而 `--config` / `--env` / `--cwd` 会让 Wrangler 读取另一份配置或另一目录，导致「校验对象 ≠ 部署对象」 |
| `worker/scripts/deploy-guarded.test.mjs` | 断言由 25 条扩充到 **70 条**（+45） | 覆盖 11 种非法参数写法、非法时零子进程、合法参数原样透传、`--env-file` 放行、`findForbiddenArg` 纯函数判定 |
| `worker/package.json` | `dev` 脚本增加 `--var ALLOWED_ORIGINS:http://localhost:3000` | R-2：CORS 收紧后本地 Vite（`vite.config.js` 实测端口 3000）需显式放行；该参数只在 `dev`，不写入 `wrangler.toml`，`deploy` / `deploy:dry-run` 不继承 |

---

## 二、A1 方案说明（真实 database_id 何时/如何配置）

- **本地开发 / E2E**：无需真实 ID。`wrangler dev` 依据 `binding` + `database_name` 在 `.wrangler/state` 下创建本地 SQLite，不校验 `database_id`（已实测确认）。Wrangler 自身提供的 `wrangler d1 execute --local` 是**本地 SQL 执行机制**，同样不校验 `database_id`；而**本项目当前的迁移脚本**使用 `wrangler d1 migrations apply --local`（见 `worker/package.json` 的 `migrate:local`），**已不再使用 `d1 execute --file`**。
- **生产部署前（唯一需要真实 ID 的时机）**：
  1. 执行 `npx wrangler d1 create smart-fire-db`（返回真实 UUID）；
  2. 用返回的 UUID 替换 `wrangler.toml` 中的 `<REPLACE_WITH_D1_DATABASE_ID>`。
- **为什么不是全零**：全零是合法 UUID 形态，可能在部署后被静默误用；本仓库改用显式占位符，并新增 `npm run deploy` 前置守卫（`deploy-guarded.mjs`，内部先执行 `check-d1-config.mjs`），占位符未替换时在调用 `wrangler deploy` 之前直接失败退出。
  - 入口：`npm run deploy` → `worker/scripts/deploy-guarded.mjs`（部署守卫，负责在启动 wrangler 前做参数与配置检查）。
  - 子步骤：`worker/scripts/check-d1-config.mjs`（D1 配置检查，由部署守卫调用，校验 `binding = "DB"` 的 `database_id` 是否为合法 UUID）。
- **边界说明（实测）**：`wrangler deploy --dry-run`（本地构建）**不会**校验 `database_id`，本地 `wrangler dev` 也不受影响；因此阻断来自仓库自带的部署守卫，而非 Wrangler 本身对占位符的校验。

---

## 三、测试证据

> **关于本节数据的时间属性**：以下数字均为 **2026-10-19 首次整改时的历史验证快照**，对应当时的代码版本与验证时间，**不是 C3 最终版本的测试结果**。
> C3 最终版本的复核结果见第七节（2026-10-31），两者不可混用或互相替代。

### 1. Worker 构建
```
npx wrangler deploy --dry-run
Total Upload: 226.20 KiB / gzip: 56.68 KiB
env.DEMO_ROOM (DemoRoom)  Durable Object
env.DB (smart-fire-db)    D1 Database
```
> 历史快照（2026-10-19）。C3 最终版本**未重新执行**该命令；C3.2 期间另有一次独立 dry-run，结果为 `Total Upload: 233.25 KiB / gzip: 58.32 KiB`，属 C3.2 的历史结果，**不是本轮执行**。

### 2. 单元测试
```
npm run test:unit  →  204 通过 / 0 失败
```
> 历史快照（2026-10-19）：当时 `test:unit` 为 10 个文件、204 条断言。C3 最终版本（2026-10-31）复核为 **16 个文件 / 2378 条断言 / 0 失败**，见第七节。

### 3. 本地 D1 迁移（`wrangler d1 migrations apply --local`）
- 按序应用 `0001_init.sql`（21 条）→ `0002_demo.sql`（5 条），状态均 ✅。
- 表结构验证（10 张业务表全部存在）：
  `buildings / devices / telemetry / alarms / inspections / evacuation_plans / person_presence / operation_logs / demo_sessions / demo_events`
- 幂等性：二次执行返回 `✅ No migrations to apply!`（`d1_migrations` 状态表生效，无重复执行）。

### 4. 种子接口鉴权（三态）
| 场景 | 请求 | 结果 |
|---|---|---|
| Token 缺失 | `POST /api/v1/admin/seed`（无 SEED_TOKEN） | **501** `未配置 SEED_TOKEN，种子接口已禁用` |
| Token 错误 | 带 `X-Seed-Token: wrong` | **403** `无效的种子令牌` |
| Token 正确 | 带 `X-Seed-Token: e2e-token` | **200** `seeded: {buildings:4, devices:552, alarms:8, inspections:8, persons:220}` |

### 5. CORS
| 场景 | Origin | 结果 |
|---|---|---|
| 允许来源 | `https://smart-fire-platform.pages.dev` | `Access-Control-Allow-Origin` 回显该域名 ✅ |
| 未允许来源 | `https://evil.example.com` | 无 `Access-Control-Allow-Origin` ✅ |
| 开发来源（经 ALLOWED_ORIGINS） | `http://localhost:3000` | `Access-Control-Allow-Origin` 回显该域名 ✅ |
| 预检 OPTIONS | Pages 域名 + `Access-Control-Request-Method: PATCH` | **204** + ACAO + ACAM + ACAH ✅ |
| DO 转发响应 | `/api/v1/demo/state`（走 Durable Object 内部 fetch） | ACAO 正常携带 ✅ |

> 补充结论：审计报告中的 P1 顾虑（DO 转发响应是否携带 CORS 头）已本地验证为**正常**——Hono 中间件会合并 `c.header()` 到 DO 返回的 Response。

### 6. 本地 E2E（REST + Demo 状态机 + WebSocket）
```
node worker/e2e-phase2.cjs  →  132 通过 / 0 失败（退出码 0）
```
覆盖：`/healthz`、`/buildings`、`/devices`、`/alarms`、`/operation-logs`、`/evacuation-plans`、`/building-evacuation-plans`、`/person-presence`、六阶段状态机全链路（START_FIRE→…→COMPLETED）、非法转换/重复操作 409、WebSocket 连接/阶段广播/实时 tick/断线重连/心跳 PING-PONG、D1 业务落库（alarms/evacuation_plans/operation_logs/demo_*）、人员·设备数据链统一（9/10 项统一契约字段）、整栋楼疏散（PLAN-A/B/C + routesByZone + 全员 routeId）。

---

## 四、未通过项 / 未覆盖场景 / 剩余风险

**未通过项**：无（本阶段所有本地测试通过）。

**未覆盖场景**：
1. 浏览器 E2E（`e2e-smoke.cjs`、`e2e-phase2-browser.cjs` 等）——需本地前端以 demo 模式 + msedge 运行；因前端模式切换决策被推迟，本阶段未运行。
2. 生产真实跨域（部署后从 Pages 域名实测）与 WS `wss://` 握手。

**剩余风险**：
1. `database_id` 仍为占位符，**生产部署前必须**执行 `wrangler d1 create` 回填（授权边界内无法代建）。
2. `SEED_TOKEN` 生产注入方式待定：推荐 `wrangler secret put SEED_TOKEN`（已写入代码注释，未落地任何真实值）。
3. 前端 `mock → demo/api` 切换留待 Worker/D1/REST/Demo/WS 全部验收后单独评估（未在本阶段选择）。
4. 本地残留 `.wrangler/e2e-state`、`.wrangler/migtest`（gitignored 测试状态目录），因环境 Safe-Delete 限制未能自动删除，可手动清理，不影响仓库与后续运行。

> 说明：以上 4 项为 2026-10-19 阶段状态。C3 收口时的完整未解决风险清单（R-1 / R-4 / R-6 / R-7 / N-4 / N-5）见第八节，**均未修复**。

---

## 五、授权边界遵守声明

本阶段仅执行了「必要代码修改 + 安全本地测试」。以下操作**均未执行**：创建 D1、远端迁移/写入、`wrangler deploy`、修改远端配置或 Secret、修改 Pages 环境变量、Git 提交或推送。

> 等待审核，未自行进入部署阶段。

---

## 六、R-3：部署守卫参数拦截（C3.1 / C3.2，2026-10-31）

### 1. 原问题

`worker/scripts/deploy-guarded.mjs` 的职责是「先校验 `worker/wrangler.toml` 的 D1 配置，通过后再调用 `wrangler deploy`」。原实现把 `process.argv.slice(2)` **原样透传**给 Wrangler，于是以下参数会让 Wrangler 读取「守卫从未校验过」的配置或目录：

| 参数 | 作用 | 后果 |
|---|---|---|
| `--config` / `-c` | 指定另一个配置文件 | 守卫校验 A 文件，实际部署 B 文件 |
| `--env` / `-e` | 选择配置中的环境段 | 使用未经守卫检查的环境配置 |
| `--cwd` | 改变工作目录 | Wrangler 改在别的目录查找配置（实测会把仓库根目录的 Vite 项目当作部署目标） |

### 2. 整改内容

新增 `findForbiddenArg(args)`，并在 `runGuardedDeploy()` 的**第一段逻辑**执行（早于任何子进程）：

- 长参数：`--config`、`--env`、`--cwd`（含 `--config=x`、`--env=x`、`--cwd=x` 形式）；
- 短参数：`-c`、`-e`（含 `-c x`、`-e x`；并按首字符拦截 `-cVALUE` / `-eVALUE` 这类写法）；
- 命中即输出明确原因并 `return 2`，**不运行 D1 守卫、不启动 wrangler、不产生任何副作用**；
- 合法参数（`--minify`、`--dry-run`、`--env-file` 等）**原样透传**，不做任何重写。

> 依据：Wrangler 4.147.0 使用 yargs，`config: { alias: 'c', requiresArg: true }`、`env: { alias: 'e', requiresArg: true }`、`cwd: { requiresArg: true }`。实测 `--con` / `--confi` / `--en` 均报 `Unknown argument`（**不支持长参数缩写**），`-cVALUE` 会被拆成布尔短参数簇（**不会被当作 config**）；因此上述规则覆盖了实际可识别的形式，并对不可识别形式额外 fail-closed。

### 3. 测试

`worker/scripts/deploy-guarded.test.mjs`：**70 条运行时断言，0 失败**（原 25 条 + 新增 45 条）。

### 4. 集成验证（已完成）

| 命令（本地，均未触发部署） | 结果 |
|---|---|
| `node scripts/deploy-guarded.mjs --config=other.toml` | `❌ 拒绝参数` + 原因说明，退出码 **2** |
| `node scripts/deploy-guarded.mjs -eproduction` | `❌ 拒绝参数` + 原因说明，退出码 **2** |
| `node scripts/deploy-guarded.mjs --minify` | 守卫正常执行（占位符下退出码 1，未调用 wrangler） |

### 5. 限制（明确声明）

该检查只针对**经由本包装器传入的 CLI 参数**。它**不能**防止所有可能的配置绕过方式，例如：直接调用 `npx wrangler deploy`、Wrangler 未来新增的参数、环境变量或账号权限层面的问题。守卫的定位是「防止误用受管入口」，不是完整的安全边界。

---

## 七、C3 最终版本复核快照（2026-10-31）

| 测试 | 断言 | 失败 | 退出码 |
|---|---|---|---|
| Worker `node scripts/check-d1-config.test.mjs` | 41 | 0 | 0 |
| Worker `node scripts/deploy-guarded.test.mjs` | **70** | 0 | 0 |
| Worker `node scripts/seed-local.test.mjs` | 15 | 0 | 0 |
| 根目录 `npm run test:unit`（16 个测试文件） | **2378** | 0 | 0 |

- 上述四项均为 2026-10-31 复核结果，与第三节的 2026-10-19 历史快照（204 / 226.20 KiB）**不是同一版本**。
- `Total Upload: 233.25 KiB / gzip: 58.32 KiB` 是 C3.2 期间的 dry-run 结果，属历史记录，**本轮未重新执行**。
- 本地 `wrangler deploy --dry-run` 无远端副作用（无凭证、构建后即退出），但该命令**不经过**正式部署守卫（见 N-4）。

---

## 八、已知未解决风险（C3 收口状态，均未修复）

| 编号 | 内容 | 状态 |
|---|---|---|
| R-1 | 业务 API（buildings / devices / alarms / demo 等）**尚未实现完整鉴权**，仅 `/api/v1/admin/seed` 有 Token 保护；CORS 只约束浏览器，不约束直连客户端 | 未修复 |
| R-4 | **Preview / Production 尚未建立完整环境隔离**：`wrangler.toml` 无 `[env.*]` 段，单配置单环境 | 未修复 |
| R-6 | `SEED_TOKEN` 比较**非恒定时间**，且种子接口**无速率限制** | 未修复 |
| R-7 | `ALLOWED_ORIGINS` 缺少 `wrangler.toml` 的 `[vars]` 示例，README 也未说明本地需注入该变量 | 未修复 |
| N-4 | `npm run deploy:dry-run` **不经过**正式部署守卫（设计如此，仅做本地构建） | 已知设计 |
| N-5 | 直接运行 `npx wrangler dev` **不会**自动注入 `ALLOWED_ORIGINS`，本地跨域需手工加 `--var` | 已知限制 |

> 以上风险**不作为 C3 的整改内容**，此处仅如实登记，避免后续误认为已解决。

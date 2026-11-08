# 智慧消防平台 · Cloudflare 后端部署审计报告与整改计划

> 审计基准：GitHub `Sun12056/smart-fire-platform` @ `main`（本地 HEAD `8a76c33`）
> 审计范围：只读审计 + 经确认的安全本地测试（构建、纯 Node 单测）
> 执行日期：2026-10-19
> 本阶段**未**执行任何远端操作：未创建 D1、未跑远端迁移、未部署 Worker、未改 Pages 环境变量、未重新发布 Pages、未提交代码。

---

## 一、结论摘要

1. **Worker 能够构建**：`npx wrangler deploy --dry-run` 成功，产物 225.70 KiB（gzip 56.51 KiB），`env.DB`（D1）与 `env.DEMO_ROOM`（Durable Object）两个绑定均被正确识别。
2. **现有单元测试通过**：`npm run test:unit` 全绿（**204 通过 / 0 失败**），覆盖 Worker Demo Engine 所依赖的 `shared/` 算法层（疏散规划 / 拓扑 / 出口运行态 / 整栋楼疏散 / 人员·设备运行时归一化）与 `fireStore` 出口失效投影。
3. **存在 4 个部署阻断级问题**（见第六节），均为配置/脚本/鉴权类，代码主体逻辑健康，不涉及大规模重构。
4. **前端当前确为 mock 模式**：`VITE_DATA_SOURCE` 未设置即默认 `mock`，与「Network 无 API 请求」现象吻合；这是**预期行为**而非缺陷。

---

## 二、审计范围与方法

| 项 | 内容 |
|---|---|
| Worker 入口与路由 | `worker/src/index.ts` + `routes/`（11 个路由文件，逐一阅读） |
| 数据库访问 | `worker/src/db.ts`（DB↔wire 双向映射） |
| SQL 迁移 | `worker/migrations/0001_init.sql`、`0002_demo.sql` |
| DemoRoom（DO） | `worker/src/durable/DemoRoom.ts` + `demo/{stages,engine,world}.ts` |
| 配置 | `worker/wrangler.toml`、`worker/package.json`、`worker/tsconfig.json`、根 `package.json`、`vite.config.js`、`.gitignore` |
| 前端契约 | `docs/API_CONTRACT.md`、`src/api/{contract,apiRepository,demoClient,index}.js`、`src/router/index.js`、`src/main.js` |
| 测试 | 根 `package.json` 的 test 脚本、`shared/**/*.test.mjs`、`worker/e2e-*.cjs`（只读审查，未运行浏览器 e2e） |
| CI/CD | 全仓库无 `.github/workflows`、无 `wrangler.jsonc`、无 `_headers/_redirects/_routes.json` |

**本地验证执行过的命令**（均为本地安全操作，未触碰远端）：
- `npx wrangler deploy --dry-run --outdir ./.wrangler-dryrun`（构建验证）
- `npm run test:unit`（纯 Node 单测）

---

## 三、Worker 与前端契约核对结论

- 后端路由前缀 `/api/v1` + `/healthz`，与 `docs/API_CONTRACT.md` §2 端点表、`src/api/contract.js` 的 `endpoints` 一一对应，**未发现路径不一致**。
- 实体字段 snake_case（DB）↔ camelCase（wire）映射完整，`zone`/`area` 别名、`occurredAt`/`time`、`createdAt`/`time` 别名均已实现。
- Demo 六阶段状态机 `DEMO_STAGES` / `DEMO_COMMANDS` / `DEMO_TRANSITIONS` 在 `worker/src/demo/stages.ts` 与 `src/api/contract.js` 两处**完全一致**。
- WS 消息类型 `demo.snapshot/stage/tick/ping/pong/sync` 前后端一致。

**发现的契约漂移（非阻断）**：
- `GET /api/v1/building-evacuation-plans`（权威整栋楼方案接口）后端已实现、`contract.js` 已定义，但 `src/api/apiRepository.js` **未暴露**对应方法。前端实际不调用该 REST 接口：mock 模式本地生成、demo 模式走 WS 快照。属「死接口/未接线」，见第八节优化项。

---

## 四、已确认的问题

### 【A 类 · 部署阻断】

**A1. D1 `database_id` 为全零占位值**
- 位置：`worker/wrangler.toml:11`
- 现象：`database_id = "00000000-0000-0000-0000-000000000000"`
- 原因：占位值未替换，需先 `npx wrangler d1 create smart-fire-db` 拿到真实 UUID 回填。
- 风险：**高**。部署后 `env.DB` 绑定无法解析到真实数据库，运行时所有 D1 调用失败。
- 修复：创建 D1 并回填真实 `database_id`。
- 测试/验收：`npx wrangler d1 list` 能看到 `smart-fire-db`；`--dry-run` 输出 `env.DB (smart-fire-db)` 绑定正常；`/healthz` 后访问任一列表接口返回数据。

**A2. 迁移脚本只执行 `0001_init.sql`，遗漏 `0002_demo.sql`**
- 位置：`worker/package.json:9-10`
- 现象：`migrate:local` 与 `migrate:remote` 均只 `--file=migrations/0001_init.sql`。
- 原因：`0002_demo.sql`（创建 `demo_sessions`、`demo_events`）没有任何脚本引用，成为孤儿迁移。
- 影响：**高**。Demo 流程运行到 `START_FIRE` 等阶段时，`DemoRoom.persistTransition` 与 RESET 处理会向 `demo_sessions`/`demo_events` 写数据，报 `no such table` → 500，整条六阶段演示链断裂。
- 修复：让脚本按序执行两份迁移（两份均 `CREATE TABLE IF NOT EXISTS`，幂等可安全重跑），或改用 `wrangler d1 migrations apply` 目录化迁移。
- 测试/验收：迁移后 `SELECT name FROM sqlite_master WHERE name IN ('demo_sessions','demo_events')` 命中 2 行；跑通一次 `START_FIRE` 命令不报 500。

**A3. 种子接口鉴权在未设置 token 时被旁路**
- 位置：`worker/src/routes/admin.ts:9-12` + `worker/wrangler.toml:23-25`
- 现象：`if (token && c.req.header('X-Seed-Token') !== token)`——`SEED_TOKEN` 未设置时 `token` 为 falsy，校验被跳过；而 wrangler.toml 里 `[vars] SEED_TOKEN` 是注释态。
- 风险：**高**。`POST /api/v1/admin/seed` 完全开放，任何人可灌入/覆盖种子数据（`INSERT OR REPLACE` 会覆盖既有业务行）。
- 修复：① 生产必须设置 `SEED_TOKEN`（建议用 `wrangler secret put SEED_TOKEN`，避免明文进仓库）；② 代码改为 **fail-closed**：未设置 token 直接拒绝（403/501），而不是跳过校验。
- 测试/验收：未设 token 时 POST `/seed` 返回 4xx/5xx 拒绝；错误 token 返回 403；正确 token 返回 200。

**A4. CORS 生产配置过宽**
- 位置：`worker/src/index.ts:24`
- 现象：`app.use('*', cors())`，默认 `origin: '*'`、允许 `GET/POST/PATCH/DELETE` 等写方法。
- 风险：**中高**。生产环境任意来源网站可跨域调用全部写接口；与 A3 叠加后风险放大。
- 修复：收紧 `origin` 为 Pages 域名白名单（如 `https://smart-fire-platform.pages.dev`），按需显式列出 `allowMethods`。
- 测试/验收：从非白名单 Origin 发起的跨域请求，响应不含 `Access-Control-Allow-Origin: *`（或直接无 CORS 放行头）。

### 【B 类 · 一般/提示】

**B1. 全量业务写接口无鉴权**（`alarms` POST/PATCH、`devices` PATCH、`telemetry` POST/batch、`person-presence` POST/batch、`operation-logs` POST、`inspections` POST、`evacuation-plans` POST/PATCH）
- 现状：除 `admin/seed`（且可被旁路）外，所有写接口无任何鉴权。
- 定性：演示平台可接受，生产化属「后续优化」，见第八节。风险等级：中。

**B2. Worker 跨目录依赖前端 mock + shared 模块**
- 位置：`worker/src/seed.ts`、`DemoRoom.ts`、`engine.ts` 通过 `../../`、`../../../` 引用仓库根的 `src/mock/*.js` 与 `shared/**/*.js`。
- 现状：已核实 dry-run 构建成功；`seed.ts` 引用的 mock 链路（devices/deviceSeed/alarms/person/inspection → floorPlanData → shared/evacuation/floorTopology）均为纯数据/纯函数，无 `window`/`document` 浏览器全局依赖（import 链已逐一核对）。
- 风险：低（当前可构建、可运行），但属隐式耦合，任一副本未来引入浏览器全局即破坏 Worker。见第八节优化项。

**B3. 仓库存在历史遗留的杂散文件**
- `$null`（PowerShell 重定向误产出的 0 字节文件名）、`worker/e2e-journey-exit.log'`（带尾引号的日志）、多个未跟踪的 `docs/*.md`。
- 定性：非本审计产生，仅提示，后续清理时需注意避免误删有效文档。

---

## 五、可能存在的问题（需部署后或进一步验证）

| # | 问题 | 依据 | 影响 |
|---|---|---|---|
| P1 | **CORS 中间件对 DO 转发的 REST 响应是否真正生效** | `demo.ts` 的 `/state` `/command` `/reset` 返回的是 DO 内部 `fetch` 的 `Response`（`DemoRoom.fetch` 用裸 `new Response`，仅设 `Content-Type`），而非 Hono `c.json()`。Hono v4 的 `c.header()` 理论上会在 `await next()` 后合并到最终响应，但需真实跨域环境验证 | 若未合并，Pages 跨域调 demo REST 会失败 |
| P2 | **DO 单实例共享** | `demoRoute` 用 `idFromName(sessionId || 'default')`，默认所有客户端共享同一 DO 与状态机 | 单演示台场景合理；多用户并发会互相干扰，生产多租户需按 session 隔离 |
| P3 | **`demo_events.seq` 语义偏弱** | `DemoRoom.persistTransition` 中同一阶段多条事件都写 `world.seq + 1`，seq 重复 | 历史流水排序/复盘的精度问题，非阻断 |
| P4 | **错误处理泛化** | `app.onError` 统一返回 `{ error: '服务器内部错误' }` 500 | 排障不便，建议保留 `console.error` 并按需返回受控错误码 |

---

## 六、尚无法验证的问题（明确不猜测）

1. **CORS 真实跨域行为**——需部署后从 Pages 域名实测（见 P1）。
2. **DO WebSocket 升级在 Pages 跨域下的握手**——需 `VITE_API_BASE_URL` 指向 Worker 后实测 `wss://…/api/v1/demo/ws` 的 101 升级与心跳。
3. **D1 远端写入量与免费额度**——seed 约 550 设备 + 告警 + 巡检 + 人员 + 事件流水，远端行数/写限流无法本地验证。
4. **e2e 浏览器全链路**——`worker/e2e-*.cjs` 需本地 `wrangler dev`（含本地 D1 + 迁移）+ Vite + msedge 浏览器；本轮未运行（需授权起本地服务，且会写入本地 `.wrangler` 状态）。
5. **Cloudflare 账号侧权限**——Worker / D1 / Durable Object 的可用区与配额、API Token 权限，无法从仓库确认（也不索取任何密钥）。

---

## 七、部署前必须解决的问题（阻塞清单）

| 优先级 | 问题 | 所属 |
|---|---|---|
| P0 | 创建 D1 `smart-fire-db` 并回填真实 `database_id` | A1 |
| P0 | 修正迁移脚本，确保 `0002_demo.sql` 被执行 | A2 |
| P0 | 生产设置 `SEED_TOKEN` + seed 接口改 fail-closed | A3 |
| P1 | 收紧 CORS origin 白名单 | A4 |
| P1 | 设置 Pages 环境变量：`VITE_DATA_SOURCE`、`VITE_API_BASE_URL`（指向 Worker URL） | 部署步骤 |

---

## 八、可以后续优化的问题（非阻塞）

1. 抽离 Worker 对前端 mock 的跨目录依赖（种子数据独立成模块 + 构建守卫）。
2. 前端 `apiRepository` 接线 `buildingEvacuationPlans`（或明确标注为死接口）。
3. DO 多租户隔离（按 sessionId 派生 DO，而非固定 `default`）。
4. 全量写接口的鉴权方案（Token/API Key 等）。
5. 错误处理细化（受控错误码 + 可观测性）。
6. `demo_events.seq` 语义修正。
7. 自动化部署：仓库无 `.github/workflows`，建议加 CI（构建 + `test:unit` + 迁移存在性检查）。
8. 清理杂散文件（`$null`、`worker/e2e-journey-exit.log'` 等）。

---

## 九、最小必要修改方案

> 仅列「部署前必须解决」的最小改动；其余见第八节。所有改动待你授权后执行。

### 变更 1 — `worker/wrangler.toml`
- `database_id` 替换为 `npx wrangler d1 create smart-fire-db` 返回的真实 UUID。
- `[vars] SEED_TOKEN` 建议不落地到 toml（避免明文进仓库），改用 `wrangler secret put SEED_TOKEN`；若坚持 toml，则取消注释并填入强随机值。

### 变更 2 — `worker/package.json`
```json
"migrate:local": "wrangler d1 execute smart-fire-db --local --file=migrations/0001_init.sql && wrangler d1 execute smart-fire-db --local --file=migrations/0002_demo.sql",
"migrate:remote": "wrangler d1 execute smart-fire-db --remote --file=migrations/0001_init.sql && wrangler d1 execute smart-fire-db --remote --file=migrations/0002_demo.sql"
```
（两份迁移均幂等；如需目录化，可后续迁到 `wrangler d1 migrations apply`，非本轮必要。）

### 变更 3 — `worker/src/routes/admin.ts`
```ts
adminRoute.post('/seed', async (c) => {
  const token = c.env.SEED_TOKEN
  if (!token) {
    return c.json({ error: '未配置 SEED_TOKEN，种子接口已禁用' }, 501) // fail-closed
  }
  if (c.req.header('X-Seed-Token') !== token) {
    return c.json({ error: '无效的种子令牌（X-Seed-Token）' }, 403)
  }
  // ...原 seed 逻辑
})
```

### 变更 4 — `worker/src/index.ts`
```ts
const allowedOrigins = ['https://smart-fire-platform.pages.dev', 'http://localhost:3000']
app.use('*', cors({
  origin: (origin) => (allowedOrigins.includes(origin) ? origin : ''),
}))
```
（本地开发放行 Vite 3000，生产只放行 Pages 域名。）

### 变更 5 — Pages 环境变量（部署步骤，非代码改动）
- `VITE_DATA_SOURCE` = `demo`（或 `api`，视启用状态机实时演示与否）
- `VITE_API_BASE_URL` = Worker URL（如 `https://smart-fire-api.<subdomain>.workers.dev`）

### 验收标准（改造后）
1. `npx wrangler deploy --dry-run` 仍成功，绑定含 `env.DB` + `env.DEMO_ROOM`。
2. `npm run test:unit` 仍 204/204。
3. 远端迁移后 `demo_sessions`/`demo_events` 表存在，`POST /api/v1/demo/command {command:'START_FIRE'}` 返回 200 且不报 500。
4. 未设 `SEED_TOKEN` 时 `POST /api/v1/admin/seed` 被拒绝；设后带正确头可用。
5. 从非白名单 Origin 跨域请求不获放行。

---

## 十、待你审核确认的事项

1. 是否同意按「第九节最小必要修改」落地（4 处代码/配置改动 + 1 项环境变量部署步骤）。
2. `SEED_TOKEN` 用 `wrangler secret`（推荐）还是 `[vars]`。
3. Pages 启用 `demo` 模式还是 `api` 模式（决定是否开启 WS 状态机）。
4. 是否授权后续运行本地 e2e（需起 `wrangler dev` + 本地 D1 + Vite + 浏览器，均为本地，不触远端）。

> 未获明确授权前，我不会执行任何代码修改、Git 提交、D1 创建/迁移、Worker 部署或 Pages 环境变量变更。

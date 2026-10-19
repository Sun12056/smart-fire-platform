# 绿智哨兵平台 · 统一数据模型与 API Contract（v1）

> 本文件是前后端唯一的契约事实来源。前端 `src/api/contract.js` 与后端 `worker/src/types.ts` 必须与本文件同步修改。
> 阶段一仅覆盖 REST；Durable Objects + WebSocket（实时人员位置 / 设备状态 / 疏散动态）与 Demo Simulation Engine（后端状态机驱动的"模拟火灾→启动预案→路径确认→智能疏散→滞留人员→救援"流程）在阶段二、三按本模型扩展，不推翻本契约。

## 0. 通用约定

- **传输格式**：JSON，字段一律 camelCase；数据库列 snake_case，由 Worker 做双向映射。
- **统一外键**：`buildingId`（`B001`~`B004`）、`floorId`（`'1F'`~`'6F'`）、`zone`（`'A区'|'B区'|'C区'|'D区'|'走廊'|'楼梯N'|'安全出口'`）。历史代码中 `zone` 与 `area` 同义——**wire 层统一使用 `zone`，同时保留 `area` 只读别名**（兼容现有视图），后端只存一列。
- **名称冗余**：实体同时携带 `buildingId` 与 `building`（名称），名称由后端 JOIN 补全，前端只读。
- **时间**：`createdAt/updatedAt/occurredAt/reportedAt` 等使用 `YYYY-MM-DD HH:mm:ss`（本地时间，与现有前端展示一致）。
- **分页**：阶段一用 `?limit=`（默认/上限见各端点），不做 offset 分页。
- **API 前缀**：`/api/v1`；健康检查 `/healthz`。

## 1. 八类核心实体

### 1.1 Building（楼栋）

| 字段 | 类型 | 说明 |
|---|---|---|
| id | string | `B001`~`B004` |
| name / type | string | `3号楼` / `办公楼\|实验楼\|综合楼` |
| floors | number | 楼层数（6） |
| deviceCount / online / abnormal / offline | number | **服务端聚合字段**（由 devices JOIN 计算，只读） |
| status | string | `normal\|warning\|emergency`（聚合派生） |
| patrolRate | number | 巡检率（0-100） |
| lastAlarm | string\|null | 最近告警时间（聚合派生） |

### 1.2 Device（设备台账）

字段与现有 `buildSeedDevices()` 产物保持一致（28 字段）：`id`（楼栋前缀全局唯一，如 `B003-EL-5F-01`）、`planId`、`name`、`type`、`buildingId/building`、`floorId/floor`、`zone`(+`area` 别名)、`zoneName`、`x/y`、`status`、`controllable`、`battery`、`temperature`、`communication`、`lastReport`、`installPosition`、`workHours`、`voltage`、`signal`、`direction`、`recommendedDirection`、`brightness`、`currentMode`、`detectionRange`、`detectedPersons`、`exitId`、`stairId`、`doorId`、`emergencyFlash`。

枚举：
- `type`：`evacuation_light | emergency_light | smoke_detector | radar_sensor | exit_sign`
- `status`：`normal | warning | fault | emergency`
- `communication`：`online | offline`
- `currentMode`：`daily | offline | emergency`（照明三态：日常节点亮 / 离线 / 应急强闪）
- `direction`：`left | right`（疏散指示灯动态换向）

### 1.3 Telemetry（遥测，新增实体）

统一承接现在散落在 Device 字段与图表 mock 中的时序数据，也是未来 ESP32 + 毫米波雷达上报的入口。

| 字段 | 类型 | 说明 |
|---|---|---|
| id | number | 自增 |
| deviceId | string | |
| kind | string | 见下方枚举 |
| value | string | 标量序列化（JSON 编码，兼容数值/字符串/布尔） |
| reportedAt | string | 上报时间 |

`kind` 枚举：`battery | temperature | signal | voltage | brightness | personCount | status | direction | mode | heartbeat`
（`status/direction/mode` 为事件型遥测：设备状态变化时由后端自动补写一条，形成完整审计轨迹。）

### 1.4 Alarm（告警）

字段沿用现有 12 字段：`id`、`time`→**`occurredAt`**（保留 `time` 别名）、`deviceId`、`buildingId/building`、`floorId/floor`、`zone`、`type`、`level`、`status`、`progress`、`description`、`handledAt`、`handledBy`。

- `level`：`danger | warning | info`
- `type`：`设备离线 | 电量不足 | 温度异常 | 烟感异常 | 通信异常 | 设备故障 | 模拟火灾告警`
- **七步处置状态机**（对齐策划书"发现异常→平台研判→告警确认→任务派发→现场处置→结果复核→事件关闭"）：
  `status`：`pending → processing → reviewing → resolved`，`progress` 同步 `10 → 30 → 60 → 100`。阶段一实现四态流转（现有 UI 只有 pending/resolved 两态），七步明细由阶段二 Demo Simulation Engine 的事件流补全。

### 1.5 Inspection（巡检）

沿用 `InspectionResult`：`id`、`deviceId`、`deviceName`、`time`→**`createdAt`**、`result`（`pass | warning | fail`）、`durationMs`、`details[]`（`{ itemId, name, result, message }`）、`operator`。检查项字典（`inspectionItems`）与六步流程（`inspectionSteps`）为前端静态配置，不入库。

### 1.6 EvacuationPlan（疏散预案）

沿用 `RoutePlan` 26 字段：`id`、`name`、`buildingId/buildingName`、`startFloor/startArea`、`corridor`、`stair`、`exit/exitLabel/exitSide`、`type`、`status`、`recommended`、`floorsPassed[]`、`riskLevel`、`score`、`distance`、`estimatedTime`、`deviceCount`、`congestion`、`zoneColor`、`path[]`、`manualNodes?`、`manualEdges?`。

`status` 扩展为生命周期枚举：`NORMAL | WARNING | BLOCKED | CONFIRMED | EXECUTING | DONE`（前三个为规划态，后三个为 Demo Simulation Engine 阶段二驱动的执行态）。

### 1.7 PersonPresence（人员感知）

归一 `person.js` Person 与 `fireStore.simulatePerson` 两套生成器：`id`、`buildingId/building`、`floorId/floor`、`zone`、`x/y`、`status`、`speed`、`direction`(角度)、`distance`、`movementType`、`sourceDeviceId`（感知雷达）、`detectedAt`、`name?`、`department?`。

- `status`：`normal | static | warning | evacuating | safe | stranded | located | rescued`
- `movementType`：`static | moving`
- 派生聚合（只读端点）：`GET /api/v1/person-presence/stats` → `personStats`；`/heatmap` → `zoneHeatmap`（按雷达设备聚合）。

### 1.8 OperationLog（操作日志）

统一现有三套日志（operationLogs / evacuationLogs / configHistory）：

| 字段 | 类型 | 说明 |
|---|---|---|
| id | number | 自增 |
| module | string | `device\|alarm\|evacuation\|inspection\|route\|lighting\|person\|system\|综合` |
| action | string | 动作名 |
| detail | string | 详情 |
| operator | string | 默认 `管理员` |
| level | string | `info\|success\|warning\|danger` |
| createdAt | string | |

前端 `notifications`（UI 通知）为 OperationLog 的展示层派生，不入库。

## 2. REST 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v1/buildings` | 楼栋列表（含聚合统计） |
| GET | `/api/v1/buildings/:id` | 楼栋详情 |
| GET | `/api/v1/devices` | 设备列表，过滤参数：`buildingId, floorId, zone, type, status, controllable` |
| GET | `/api/v1/devices/:id` | 设备详情 |
| PATCH | `/api/v1/devices/:id` | 设备更新（状态/方向/亮度/模式/雷达参数），状态类变更自动补写 telemetry |
| GET | `/api/v1/telemetry` | 遥测查询：`deviceId, kind, from, to, limit(≤500, 默认200)` |
| POST | `/api/v1/telemetry` | 单条上报（ESP32 阶段三入口）：`{ deviceId, kind, value, reportedAt? }` |
| POST | `/api/v1/telemetry/batch` | 批量上报：`{ entries: [...] }` |
| GET | `/api/v1/alarms` | 告警列表：`status, level, buildingId, limit` |
| GET | `/api/v1/alarms/:id` | 告警详情 |
| POST | `/api/v1/alarms` | 新建告警 |
| PATCH | `/api/v1/alarms/:id` | 处置流转：`{ status, progress?, handledBy? }` |
| GET | `/api/v1/inspections` | 巡检历史：`deviceId, result, limit` |
| POST | `/api/v1/inspections` | 提交巡检结果 |
| GET | `/api/v1/evacuation-plans` | 预案列表：`buildingId, floorId, status` |
| GET | `/api/v1/evacuation-plans/:id` | 预案详情 |
| POST | `/api/v1/evacuation-plans` | 保存预案（自动 / 手动规划产物） |
| PATCH | `/api/v1/evacuation-plans/:id` | 预案流转：`{ status, recommended }` |
| GET | `/api/v1/person-presence` | 人员列表：`buildingId, floorId, zone, status` |
| GET | `/api/v1/person-presence/stats` | personStats 聚合 |
| GET | `/api/v1/person-presence/heatmap` | zoneHeatmap 聚合 |
| POST | `/api/v1/person-presence/batch` | 批量 upsert（模拟器/雷达网关） |
| GET | `/api/v1/operation-logs` | 日志查询：`module, level, limit(≤500, 默认200)` |
| POST | `/api/v1/operation-logs` | 写入日志 |
| POST | `/api/v1/admin/seed` | 灌入种子数据（生产环境需 `X-Seed-Token` 头，与 `SEED_TOKEN` 环境变量匹配） |
| GET | `/api/v1/demo/transitions` | Demo 状态机元信息（阶段、命令、转移表） |
| GET | `/api/v1/demo/state` | Demo 状态快照（`sessionId` 默认 `default`） |
| POST | `/api/v1/demo/command` | 发送业务指令 `{ command, payload? }`；非法转换 409（含 `allowed`） |
| POST | `/api/v1/demo/reset` | 复位到 IDLE（IDLE 下调用视为非法转换 409） |
| GET | `/api/v1/demo/ws` | WebSocket 实时通道（Upgrade: websocket） |
| GET | `/healthz` | 健康检查 |

**响应包络**：列表直接返回数组（与现有 store 消费方式一致，减少前端适配层）；单对象返回对象；错误返回 `{ error: string }` + 4xx/5xx。

## 3. 双数据源与数据流

```
┌─────────┐   ┌────────┐   ┌───────────────────────┐   ┌──────────────────┐   ┌────┐
│ Vue 视图 │ → │ Pinia  │ → │ Service 层（8 个服务）  │ → │ Repository        │ → │ D1 │
└─────────┘   └────────┘   └───────────────────────┘   │ ├ MockRepository  │   └────┘
                                                        │ └ ApiRepository   │ → Workers(Hono) → D1
                                                        └──────────────────┘
```

- `VITE_DATA_SOURCE=mock`（默认）：MockRepository 直接复用 `src/mock/*`，行为与当前 Demo 完全一致。
- `VITE_DATA_SOURCE=api`：同一 Service 接口走 `fetch → Workers → D1`；**初始化失败不静默回退 mock**，置位 `remoteError / dataSourceDegraded` 并由 UI 明确告警，避免真实系统出现数据假象。
- `VITE_DATA_SOURCE=demo`：后端驱动演示（REST + WebSocket），六阶段处置由后端状态机驱动，前端只发起指令与呈现状态。
- 写路径（addOperationLog / resolveAlarm / completeInspection / 预案保存）在远端模式下"本地即时生效 + 远端异步落库"（fire-and-forget），保证 UI 不因网络阻塞。

## 3.1 三种运行模式

| 模式 | 数据源 | 状态来源 | 后端失败行为 |
|---|---|---|---|
| `mock` | `src/mock/*` | 前端本地推演 | 不涉及后端 |
| `api` | Workers → D1 | 后端 REST | **显式告警**（`dataSourceDegraded` + 横幅），不静默回退 |
| `demo` | Workers → D1 + DO | 后端状态机（WS 广播） | 显式告警 + WS 自动重连（指数退避） |

## 3.1.1 疏散路线统一算法（shared/evacuation）

前端（Vue/平面图/3D）与 Worker（Demo Engine）共用 `shared/evacuation/`：

```
shared/evacuation ┬ routeGraph.js     楼层拓扑（节点/边/墙）+ Dijkstra + Yen K 最短路
                  ├ routePlanner.js  A/B/C 候选方案（距离/时间/风险/距火/出口）
                  ├ routeValidator.js 绝不穿墙校验（4 项检查）
                  ├ routeTypes.js    统一数据结构与常量
                  ├ floorTopology.js 出口静态权威定义（EXIT_DEFS，只读）
                  └ exitRuntime.js   出口运行态归一化 + 跨投影失效协调（见 3.1.5）
        ┌─────────┴─────────┐
      Vue（2D/3D）      Worker Demo Engine
```

- 楼层拓扑（SVG 平面图 560×300，1m=10px）：`A/B/C/D_CENTER` → `CORRIDOR_N/S/CENTER/W/E` → `STAIR_NW/NE/SW/SE` → `EXIT_W/EXIT_E`（1F）。
- 火灾区域是**动态障碍**：`blockedNodesForFire()` 先剔除火源节点，再交由 `findPaths()` 的 K 最短路求解；校验不通过的路线一律不展示。
- 方案输出（A/B/C 唯一来源）：

```json
{ "id": "PLAN-A", "name": "方案A", "startZones": ["A区"], "exitId": "1F:EXIT_E",
  "distance": 81.3, "estimatedTime": 88, "riskLevel": "LOW",
  "fireDistance": 2, "escapeDistance": 35.8, "floorsPassed": ["5F","4F","3F","2F","1F"],
  "nodes": ["5F:A_CENTER", "...", "1F:EXIT_E"], "points": [{ "x": 140, "y": 150 }] }
```

- Worker 不再自带出口常量与硬编码方案；`engine.ts` 调用同一规划器，人员沿 `routePoints` 逐段推进。
- 前端 `src/mock/routeGraph.js` 只保留旧签名适配，算法全部转发到 shared（不再有两套实现）。

### 3.1.2 建筑拓扑单一数据源

| 层 | 唯一来源 | 说明 |
|---|---|---|
| 拓扑（节点/边/权重/出口） | `shared/evacuation/routeGraph.js` | 前端 store、Worker、3D、2D 调试层全部读它 |
| 算法 | `shared/evacuation/{routePlanner,routeValidator}.js` | 寻路 / A/B/C / 校验 |
| 3D 坐标换算 | `src/components/building3d/coords.js` | SVG 560×300 → Three.js（X/Z + 楼层高度） |
| 渲染几何 / 设备布点 | `src/mock/floorPlanData.js` | 仅房间矩形、墙体、门、设备种子（不再是拓扑） |

- `src/mock/routeGraph.js` 已是纯兼容层：只保留旧签名 `validateRoute(pathNodes,{edgeSet})` 与少量常量重导出；`getFloorTopology()` 实际返回 shared 的单层图（调试层与寻路同源）。
- ⚠️ 已从 `mock/routeGraph` 删除 `buildBuildingGraph` 别名（它曾指向 `floorPlanData.buildPlanGraph`，是最大的混淆源）；需要拓扑请直接 import `shared/evacuation/routeGraph.js`。
- 节点 id 格式为 `${floorId}:${key}`（如 `5F:A_CENTER`、`1F:EXIT_E`），出口 id 为 `1F:EXIT_W / 1F:EXIT_E`。

### 3.1.3 整栋楼疏散（scope = BUILDING）

**一次火灾事件 = 一栋楼的一次整体疏散任务。** `fireEvent` 只描述火灾位置（`buildingId + floorId + zone`），
`evacuationScope` 恒为 `BUILDING`；火灾只作为动态障碍，不改变疏散范围。

```
fireEvent { buildingId, floorId, zone }   ← 只描述位置
        ↓
buildingEvacuationPlanner.js
  ① 整栋楼人员 → 按 floorId + zone 分组
  ② 每组调用现有 findPaths()（不改动 Dijkstra / Yen）
  ③ 按 strategy 为每组选一条路线
  ④ 汇总为 BuildingEvacuationPlan（每条路线仍过 validateRoute）
```

```json
{
  "id": "PLAN-A", "name": "方案A·均衡疏散", "buildingId": "B003", "scope": "BUILDING",
  "strategy": "BALANCED", "fire": { "buildingId": "B003", "floorId": "5F", "zone": "A区" },
  "summary": { "zoneCount": 24, "personCount": 90, "maxEstimatedTime": 120, "floors": ["6F","5F","4F","3F","2F","1F"] },
  "routes": [{ "routeId": "PLAN-A:5F:A区", "floorId": "5F", "zone": "A区", "startNode": "5F:A_CENTER",
               "exitId": "1F:EXIT_E", "nodes": ["5F:A_CENTER","…","1F:EXIT_E"], "points": [{ "x": 140, "y": 150 }],
               "distance": 81.3, "estimatedTime": 88, "riskLevel": "LOW", "valid": true }],
  "routesByZone": { "5F:A区": { "routeId": "PLAN-A:5F:A区", "…": "…" } }
}
```

- **PLAN-A/B/C 是整栋楼三种策略，不再是某个区域的三条路线**：A 均衡（出口负载均衡 + 综合评分）/ B 快速（耗时最短）/ C 安全（远离火源、风险最低）。
- 每个策略内部必须为**所有「有人员的 floorId + zone」**各生成一条路线；`走廊` 等公共区域没有房间节点，按最近房间节点归属（`resolvePlanningZone`），保证人人有合法起点。
- 每条路线继续通过现有 `routeValidator`：不穿墙、不经过 `blockedNodes`（火区）、终点必须是 `1F` 安全出口、跨层必经楼梯。
- 确认的是**整栋楼方案**（`payload.buildingPlanId`）；`CONFIRM_ROUTE` 校验：`scope === BUILDING`、`buildingId` 与火情楼栋一致、所有有人 `floor+zone` 都有合法 route，否则 409。
- 阶段 4：整栋楼人员按各自 `routePoints` 移动（每人 `routeId` = `${planId}:${floorId}:${zone}`）；`PersonLayer3D` 只消费后端 `routePoints/routeId`，不重新设计。
- 前端状态从 `routeMatrix/perZone` 迁移到 `buildingEvacuationPlan/routesByZone`（`routeMatrix` 仍按当前查看楼层派生，保证 2D 逐步迁移）。

### 3.1.4 唯一权威数据源（P1.5.5 清理后）

**权威顺序（恒成立）**

```
buildingPlans（整栋楼方案）
      ↓
activeBuildingPlanId（当前执行方案，唯一）
      ↓
person.routeId / routePoints（每人所属 floorId+zone 的路线）
      ↓
2D RouteLayer / 3D RouteLayer3D / PersonLayer3D / 后端执行
```

| 数据 | 状态 | 说明 |
|---|---|---|
| `buildingPlans` / `activeBuildingPlanId` / `evacuationScope` | **权威** | 唯一疏散方案来源；`evacuationScope` 恒为 `BUILDING` |
| `person.routeId` | **权威** | `${buildingPlanId}:${floorId}:${zone}`，2D/3D/后端同一个 id |
| `world.legacyPlans` / `legacyActivePlanId`（快照字段仍为 `plans` / `activePlanId`） | ⚠️ LEGACY | 旧「单火灾区域 A/B/C 方案」，仅历史记录与旧 REST 兼容；不得参与任何疏散决策、不得覆盖 buildingPlans |
| `routeMatrix.perZone` | ⚠️ 只读投影 | "routeMatrix.perZone is a read-only compatibility projection and must not be used as authoritative evacuation state." 只能用于旧组件兼容 / 当前楼层局部展示 / 旧页面过渡 |

**接口**

| 接口 | 状态 | 返回 |
|---|---|---|
| `GET /api/v1/building-evacuation-plans?buildingId=` | ✅ 权威 | `{ scope: "BUILDING", buildingId, count, plans: [BuildingEvacuationPlan] }` |
| `GET /api/v1/building-evacuation-plans/:id` | ✅ 权威 | `{ scope: "BUILDING", plan }` |
| `GET /api/v1/evacuation-plans`（及 POST/PATCH） | ⚠️ LEGACY | 只返回 `type != 'building'` 的历史预案行，不再是 Demo 疏散方案来源 |

**CONFIRM_ROUTE 约束（阶段 3 → 4）**

1. 必须携带 `buildingPlanId`（PLAN-A/B/C），仅传旧 `planId` 返回 409；
2. `plan.scope === 'BUILDING'` 且 `world.evacuationScope === 'BUILDING'`；
3. `plan.buildingId` 与火情楼栋一致；
4. 所有「有人员的 floorId + zone」都必须有通过 `routeValidator` 的 route，否则 409；
5. 禁止只确认火源区 / 只确认某楼层 / 自动从旧 `legacyPlans` 补路线。

### 3.1.5 出口运行态统一契约（shared/evacuation/exitRuntime.js）

**登记（P1.8.2 Stage 1.1）**：`exitRuntime.js` / `floorTopology.js` 为出口运行态的唯一权威模块，前端 store 与 Worker 共用；
任何调用方**不得**自行实现出口可用性判定或路线失效（平行实现是历史上最大的不一致来源）。

**核心入口**：`applyExitInvalidation(input)` —— 纯函数、不可变、**只做「失效」不做「重规划」**（重规划结果由权威层决定）。

| 入参 | 语义 |
|---|---|
| `routePlans` | 兼容投影 A（当前路线列表） |
| `perZone` | 兼容投影 B：`{ zone: { plans, recommendedId, backupId } }` |
| `exits` | 运行态出口状态（建议传 `normalizeExitStates().exits`） |
| `usableNodeIds` | 调用方声明的当前可用出口节点 id |
| `exitNodeIds` | ⚠️ **DEPRECATED**：仅作为 `exitNodeIds` 输出的额外收窄条件，**不再是第二个独立来源** |
| `blockAll` | 强制整批失效 |

**出口标识**：三种合法形式 `nodeId`（`1F:EXIT_W`）/ `key`（`EXIT_W`）/ `id`，由 `resolveExitKey` 统一解析为规范 `nodeId`。
未知标识**不得**被猜测映射为真实出口（不产生「假可用」）。

**裁决契约**

| 编号 | 契约 |
|---|---|
| **D1 保守收窄（全局策略 B）** | **`usableNodeIds` 只能收窄有效可用集，不得单独放行出口。**<br>· `reason ∈ {missing, invalid}` ⇒ exits **不可派生** ⇒ **有效可用集恒为空**（fail-closed）；此时**刻意不读取** `usableNodeIds`，即使调用方传入非空声明集也不得放行出口。<br>· `reason ∈ {unknown, duplicate, partial, null}` ⇒ exits **可派生**（派生源 = `reportedUsableNodeIds`）：已声明 ⇒ **保守取交集**（任一源判为不可用 ⇒ 不可用）；未声明 ⇒ 由 exits 派生（D4）。<br>⚠️ 该分支规则以**当前 `reason` 定义与派生守卫**为前提，`reason` 语义或优先级变更时须**重新验证**。<br>⚠️ **旧行为已废止**：此前 `missing` / `invalid` 时「退化为声明集单方」（已声明即用声明集，不取交集）与本条冲突，自本批次起废止；该旧行为**不得**推广到其余四类 —— 实测 `unknown(部分) + declared [W,E]` ⇒ `[W]`，交集确实生效 |
| **exitsConflict 为空** | ⟺ `exitStates.reason !== null` **或** 未声明 `usableNodeIds`。仅当 `reason === null` **且**已声明时才计算对称差（计算结果可能为空）；**仅诊断，不参与裁定**，本条不扩大 D2 已限定的作用域 |
| **D2 诊断范围收窄** | `exitsConflict` 仅在 `exitStates.reason === null`（exits 完整、无缺失 / 无重复矛盾）**且**调用方确实声明了 `usableNodeIds` 时才计算；`partial` / `missing` / `invalid` / `duplicate` / `unknown` 情形**不判定为入参冲突**，改由 `exitStates` 各标志单独表达 |
| **D3 exitNodeIds** | 行为保留（由 `exits` 派生的收窄），**标记 deprecated**；无生产消费方，是否移除待定 |
| **D4 + P1-1 派生与守卫** | 仅提供 `exits` 时由其派生可用集；**守卫**为 `exitStates.reason ∉ {missing, invalid}`（即「确实提供可解析条目」）。`missing`（未传 / 空 / 非数组）与 `invalid`（非空但零条可解析）**均不得派生** ⇒ 维持 fail-closed |
| **P2-1 策略 B（已批准）** | **仅已上报且可解析的出口参与可用性判定**。派生源为 `reportedUsableNodeIds`，**不是**含静态补齐项的 `usableNodeIds`。未上报出口（`EXIT_DEFS` 中未被任何已上报条目覆盖者）一律视为**不可用**，不进入可用集、不出现在 `exits` / `exitNodeIds` 输出 |
| **fail-closed** | 两项输入均缺失 ⇒ 空集 ⇒ 非 DONE 路线整批失效；**严禁**据静态默认回落（全 OPEN）派生可用集。<br>**扩展（策略 B）**：`reason ∈ {missing, invalid}` 时**无论是否声明 `usableNodeIds`** ⇒ 有效可用集恒为空 ⇒ 非 DONE 整批失效；`exits` / `exitNodeIds` **不得**由声明集、静态补齐或额外 `exitNodeIds` 入参恢复出口 |

**`exitStates` 降级信息**（调用方须告警，**不得**当作可信运行态）

| 字段 | 含义 |
|---|---|
| `degraded` | 是否降级 |
| `reason` | 取值 `missing` > `invalid` > `unknown` > `duplicate` > `partial` > `null`（优先级顺序） |
| `unknown` / `unknownRawIds` | 存在无法解析到已知出口的条目 / 其原始标识 |
| `duplicate` | 存在重复 nodeId（按「任一不可用 ⇒ 不可用」保守合并） |
| `partial` | 运行态未覆盖全部出口 |

**`normalizeExitStates` 返回结构（`ExitStatesResult`）**

| 字段 | 含义 |
|---|---|
| `exits` | 规范化后的完整出口状态（必然覆盖 `EXIT_DEFS` 全集，**含**静态补齐项） |
| `usableNodeIds` | 当前可用出口节点 id（**含**静态补齐项） |
| `reportedUsableNodeIds` | 【P2-1 策略 B】**仅已上报且可解析**条目中的可用出口节点 id（**不含**静态补齐项） |
| `degraded` / `reason` / `duplicate` / `unknown` / `partial` / `unknownRawIds` | 见上表「`exitStates` 降级信息」 |

> `applyExitInvalidation()` 仅从 `ExitStatesResult` 中取 6 个降级字段构成 `exitStates` 并透出；
> `reportedUsableNodeIds` 是策略 B 的**派生源**，用于构造有效可用集，不作为诊断字段透出。

**`applyExitInvalidation` 返回契约分层**

① **公开契约**（变更须走契约登记流程）

| 字段 / 行为 | 契约 |
|---|---|
| 不可变 | 返回新数组 / 新对象，**不就地修改入参** |
| 只做失效 | **不做重规划**；重规划结果由权威层决定（见 `PLANNING_STATUS`） |
| 有效可用集 | `reason ∉ {missing, invalid}` 时 = 上报集 ∩ 声明集（见 D1）；`reason ∈ {missing, invalid}` 时**恒为空集**（声明集不得放行，见 D1 / fail-closed）。<br>准入唯一来源 = `reportedUsableNodeIds` |
| 未声明时的派生（D4） | 由 exits 派生，**派生源 = `reportedUsableNodeIds`** |
| 两者均不可派生且未声明 | 空集 ⇒ 非 DONE 路线整批失效（fail-closed） |
| `exits` | 规范化出口经**有效可用集**过滤后的结果，**不保证**覆盖 `EXIT_DEFS` 全集 |
| `exitNodeIds` | 由 `exits` 派生，并受 `input.exitNodeIds` 额外收窄；**deprecated**（D3） |
| `exitStates` | 仅 6 个降级字段，**不透出** `reportedUsableNodeIds` |
| `exitsConflict` | 仅作**诊断告警**，不参与裁定；为空 ⟺ `reason !== null` 或未声明 `usableNodeIds` |
| DONE 终态保护 | DONE 不改写为 `BLOCKED`、不进 `affectedRouteIds`、不参与三指针选择 |
| 当前选中项失效后 | 改选第一条可用者，**不选回**失效路线 |
| `routePlans` / `perZone[].plans` | 保持数组长度，`null` 元素原样返回 |
| `affectedRouteIds` | = 最终 BLOCKED 的并集去重，**含存量 BLOCKED** |

② **当前实现观察行为**（**非契约**，日后可能变更，测试不得锁死）

| 字段 / 行为 | 观察 |
|---|---|
| 稀疏数组「空洞」（true hole）是否保留 | 未实测、无文档承诺 |
| `perZone[zone]` 保留调用方额外键 | 由对象展开合并导致，无契约承诺 |
| `activeRoutePlanId` 未传 / 为 `null` ⇒ 返回 `null` | 无文档承诺 |
| 显式 `blockAll` 覆盖自动置位 | 无文档承诺 |
| `blockedAll` 与逐条 BLOCKED 的关系 | **双重语义，仅记录不重构**：输出 `blockedAll` 与入参为同一变量 —— 显式传入则**原样回显**，否则 = `有效可用集为空` 的派生摘要；且 `blockAll` 只在 `true` 时作门控（`false` **不阻止**逐条失效）。<br>**已知行为**：`missing + 已声明 [W] + blockAll:false` ⇒ `blockedAll=false`，但非 DONE 路线**仍全部 BLOCKED**。<br>⇒ `blockedAll === false` **不蕴含**存在可用出口，也不蕴含非 DONE 未被失效 |
| `exits` / `exitNodeIds` / `affectedRouteIds` 的**元素顺序** | 无承诺 ⇒ 断言一律用**集合语义** |

③ **待决策事项**（未登记为契约，接线前须裁决）

| 事项 | 说明 |
|---|---|
| `usableNodeIds: []`（空数组）按「已声明」处理 | 实现以数组判定 ⇒ 空声明产生空交集 ⇒ 整批失效，与「未声明」语义不同 |
| 上表 ② 的各项是否提升为契约 | 取决于接线时调用方是否依赖 |
| **`blockedAll` 是否拆分为两个语义字段** | 建议拆为「入参回显」与「派生摘要」两个字段，或统一为派生摘要并**禁止回显**。本轮**只记录不重构** |
| **FC-1 接线前置条件（静态默认回灌）** | 调用方须上报**真实运行态**出口状态。**禁止**把 `defaultExitStates()` 或已补齐的 `normalizeExitStates(...).exits` 当作 `exits` 入参回灌 —— 静态补齐项会被识别为「已上报条目」，策略 B 的「已上报 vs 补齐」区分当场失效。本阶段**未**处理该旁路，**不得**据此宣称全系统已满足策略 B |

**`usableNodeIds` 与 `reportedUsableNodeIds` 的差异**

- `reportedUsableNodeIds` **始终是** `usableNodeIds` 的**子集**。
- **两者恒等当且仅当 `partial === false`**；`partial === true` 时两者**存在差异**。
  差异来源：未上报出口被静态补齐后进入 `usableNodeIds`，但不进入 `reportedUsableNodeIds`。
  `missing` 与 `invalid` 均伴随 `partial === true`，属上述差异情形。
- ⚠️ **不得使用 `reason` 判断两集合是否恒等**。`reason` 是单值优先级编码（优先级见上表），
  **无法完整反映同时成立的状态标志**：
  · `reason === 'duplicate'` 时仍可同时成立 `partial === true` ⇒ 两集合可以不恒等；
  · `reason === 'unknown'` 时也可同时成立 `partial === true` ⇒ 两集合可以不恒等；
  · 反之，`reason === 'duplicate'` 且 `partial === false` 时，两集合**恒等**。
- **适用前提**：上述子集关系与恒等判定依赖**当前实现**中 `partial` 标志的定义，以及下列三条
  不变式：
  · ① 出口解析结果必然属于 `EXIT_DEFS`；
  · ② `EXIT_DEFS` 中各出口 `nodeId` 唯一；
  · ③ **未上报出口的静态默认判定为可用**（`EXIT_DEFS` / `defaultExitStates()` 当前全
    `available: true` + `OPEN`）。若静态默认改为不可用，则 `partial === true` 时未上报出口
    **既不进入** `usableNodeIds`、**也不进入** `reportedUsableNodeIds` ⇒ 两集合**仍恒等**，
    「恒等 ⇔ `partial === false`」随之失效。
  三者任一发生变化时，须**重新验证**该子集关系与恒等判定。

**`exitsConflict` 消费方**：仅用于**诊断告警**（未来 fireStore / Worker 快照层），**不用于**自动裁定或改写 `status`。当前无生产消费方。

**DONE 终态保护**（任何入参组合下均成立）：`DONE` 路线不被改写为 `BLOCKED`、不进入 `affectedRouteIds`、
不参与 `recommendedId` / `backupId` / `activeRoutePlanId` 选择；判定顺序中 DONE **严格先于** `blockAll`。

## 3.2 Demo 六阶段状态机（唯一定义）

```
IDLE ──START_FIRE──▶ FIRE_DETECTED ──ACTIVATE_RESPONSE──▶ EMERGENCY_RESPONSE
      ──PLAN_ROUTES──▶ ROUTE_PLANNING ──CONFIRM_ROUTE──▶ SMART_EVACUATION
      ──COMPLETE_EVACUATION──▶ RETAINED_PERSONS ──CONFIRM_RETAINED──▶ RESCUE_COORDINATION
      ──COMPLETE_RESCUE──▶ COMPLETED ──RESET──▶ IDLE
```

- 定义位置：`worker/src/demo/stages.ts`（后端权威）、`src/api/contract.js`（前端镜像），二者必须同步。
- 非法转换一律 409，响应体含当前阶段与 `allowed` 命令列表；重复同一命令亦为 409。
- 阶段 3 → 4 只能由 `CONFIRM_ROUTE` 推进，且必须基于已生成的方案：`planId` 不存在返回 409，无方案返回 409（禁止跳过确认直接进入智能疏散）。
- `RESET` 在 IDLE 下视为非法转换（409）。
- **与另两套状态严格区分**：
  - Alarm 七步事件流 `pending → processing → reviewing → resolved`（业务处置状态，落 D1）
  - EvacuationPlan 生命周期 `NORMAL|WARNING|BLOCKED → CONFIRMED → EXECUTING → DONE`（预案对象状态，落 D1）
  - Demo 阶段属于"一次演示处置流程"的推进阶段，只存在 DO；阶段推进时**写入**上述业务记录，但互不覆盖。

## 3.3 WebSocket 消息契约

| 方向 | type | 载荷 | 说明 |
|---|---|---|---|
| → | `demo.ping` | `{ at }` | 心跳（客户端每 15s） |
| → | `demo.sync` | — | 重连后请求全量快照 |
| ← | `demo.snapshot` | 全量快照 | 连接建立即下发 |
| ← | `demo.stage` | 全量快照 + `stage` | 阶段变化广播 |
| ← | `demo.tick` | `{ persons, metrics, seq, evacuationSettled }` | 疏散实时推进（1s/次，仅 SMART_EVACUATION） |
| ← | `demo.pong` | `{ at }` | 心跳应答 |

**职责边界**：Durable Object 只做实时状态协调与广播；D1 只保存业务与历史数据（alarms / evacuation_plans / operation_logs / demo_sessions / demo_events），**实时位置与设备运行时不落 D1**。

## 4. 阶段路线（与本契约的关系）

| 阶段 | 内容 | 契约影响 |
|---|---|---|
| 一 | 8 类实体 + Mock/Api 双源 + Vue→Pinia→Service→Workers→D1 闭环 | v1 |
| 二（当前） | Durable Objects + WebSocket（人员位置/设备状态/疏散动态/火灾状态/灯光状态）；Demo Simulation Engine 后端状态机驱动六阶段；mock/api/demo 三模式 | 新增 §3.1~§3.3 |
| 三 | ESP32 + 毫米波雷达接入 `POST /telemetry`、`PATCH /devices/:id`（command 下发走 DO） | 复用 telemetry/device/command 契约，新增设备鉴权 |

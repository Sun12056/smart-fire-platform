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
- `VITE_DATA_SOURCE=api`：同一 Service 接口走 `fetch → Workers → D1`；初始化失败自动回退 mock 并告警。
- 写路径（addOperationLog / resolveAlarm / completeInspection / 预案保存）在 api 模式下"本地即时生效 + 远端异步落库"（fire-and-forget），保证 UI 不因网络阻塞。

## 4. 阶段路线（与本契约的关系）

| 阶段 | 内容 | 契约影响 |
|---|---|---|
| 一（当前） | 8 类实体 + Mock/Api 双源 + Vue→Pinia→Service→Workers→D1 闭环 | 本文件 v1 |
| 二 | Durable Objects + WebSocket（实时人员/设备/疏散）；Demo Simulation Engine（后端状态机驱动六阶段） | 新增 WS 消息契约与 `/simulations` 资源；alarm 七步事件流落地 |
| 三 | ESP32 + 毫米波雷达接入 `POST /telemetry`、`PATCH /devices/:id`（command 下发走 DO） | 复用 telemetry/device 契约，新增设备鉴权 |

# 智慧消防可视化指挥平台（Smart Fire Platform）

面向高层建筑及复杂建筑消防场景的智慧消防可视化指挥平台，基于 Vue 3 + Three.js + Cloudflare Workers 构建，集成建筑数字孪生、消防设备管理、实时数据协同、火灾模拟演练、智能疏散路径规划及应急指挥等能力。

项目采用前后端分离架构，通过统一的数据契约、Repository 数据访问层和共享疏散算法，实现 Mock、API、Demo 三种运行模式。平台目前已具备前后端业务数据闭环、后端实时状态机、WebSocket 实时广播及整栋楼疏散规划能力，正在持续推进疏散算法治理和系统能力完善。

> 本项目为持续迭代中的智慧消防平台。当前重点是完善智能疏散决策链路、运行态一致性和建筑空间模型。后续将逐步推进真实物联网设备接入、火灾动力学仿真、通用建筑管理及多角色权限体系。

---

## 一、项目总体建设路线

项目采用三个阶段逐步建设，并在此基础上扩展火灾动力学仿真、建筑通用化、权限管理和移动端运维能力。

### Stage 1：平台基础建设

目标：建立统一的数据模型、业务服务和前后端数据闭环。

主要建设内容：

- 统一核心业务实体及 API Contract。
- 建立 MockRepository / ApiRepository 双数据源架构。
- 建立 Vue → Pinia → Service → Repository → Workers → D1 数据链路。
- 实现消防设备、告警、人员、巡检、疏散预案、操作日志等业务模块。
- 建立 REST API 和业务数据持久化能力。
- 实现前端本地模拟数据与远端业务数据的统一访问方式。

### Stage 2：实时系统与仿真引擎

目标：建立后端驱动的实时协同系统和消防演练仿真能力。

主要建设内容：

- Cloudflare Durable Objects 实时协调。
- WebSocket 实时通信与状态广播。
- 后端 Demo Simulation Engine。
- 八阶段消防演练状态机（IDLE + 七个业务阶段）。
- 人员位置、设备状态、火灾状态、疏散动态和灯光状态同步。
- Mock / API / Demo 三种运行模式。
- 前后端共享疏散算法与建筑空间数据。
- 整栋楼疏散方案生成、路线确认和人员动态模拟。

八阶段演练流程（IDLE + 七个业务阶段）：

```
IDLE
  ↓ START_FIRE
FIRE_DETECTED
  ↓ ACTIVATE_RESPONSE
EMERGENCY_RESPONSE
  ↓ PLAN_ROUTES
ROUTE_PLANNING
  ↓ CONFIRM_ROUTE
SMART_EVACUATION
  ↓ COMPLETE_EVACUATION
RETAINED_PERSONS
  ↓ CONFIRM_RETAINED
RESCUE_COORDINATION
  ↓ COMPLETE_RESCUE
COMPLETED
  ↓ RESET
IDLE
```

### Stage 3：真实物联网设备接入

目标：将平台从仿真演练系统逐步扩展为真实设备感知与控制系统。

主要建设内容：

- ESP32 设备接入。
- 毫米波雷达接入。
- 设备遥测数据上报。
- 设备状态与传感器数据同步。
- 设备身份认证与权限校验。
- 通过 Durable Objects 和设备通信链路实现指令下发。
- 传感器数据与平台人员位置、建筑空间和消防事件融合。
- 建立设备上报、平台处理、指令下发和设备反馈的双向闭环。

核心接口（沿用现有 `/api/v1` 前缀）：

```
POST  /api/v1/telemetry
PATCH /api/v1/devices/:id
```

- 上述两个端点**已在 Worker 中实现**：`worker/src/routes/telemetry.ts`（`POST /`、`POST /batch`）、`worker/src/routes/devices.ts`（`PATCH /:id`）。
- Stage 3 待建设的不是这两个端点本身，而是设备接入、设备身份、数据可信度、指令授权、执行反馈和异常处理等完整链路。

Stage 3 不仅是设备数据展示，还需要完成设备身份、数据可信度、指令授权、执行反馈和异常处理等完整链路。

### 后续扩展建设方向

除三个原定阶段外，平台还将逐步推进以下能力：

| 建设方向 | 主要目标 |
| --- | --- |
| FDS 火灾动力学仿真 | 火灾发展、烟气传播、温度场及危险区域计算 |
| 火灾与疏散耦合 | 将火灾动态危险信息引入疏散决策 |
| 通用建筑模型 | 支持不同建筑、楼层和空间结构 |
| 多建筑管理 | 建筑授权、建筑数据隔离和统一管理 |
| 登录与多角色权限 | 用户身份认证、角色权限和操作审计 |
| 平面图管理 | 建筑平面图上传、维护和空间信息配置 |
| 通用拓扑生成 | 从建筑空间模型生成疏散拓扑 |
| 可视化编辑器 | 建筑空间、节点、边、设备和区域的可视化编辑 |
| 移动端与设备运维 | 巡检、报修、维修和现场设备管理 |

上述方向属于后续建设规划，不代表已经完成或已经确定具体版本归属。

---

## 二、功能模块

| 模块 | 说明 |
| --- | --- |
| 楼宇态势 | 多楼栋消防态势总览、3D 数字孪生场景、火情区域、人员分布和救援力量可视化 |
| 设备状态 | 消防设备台账、设备坐标、方向、所属区域及运行状态 |
| 智能告警 | 实时告警流、分级统计、告警处置与事件流转 |
| 智能照明 | 照明设备控制、亮度历史曲线和多场景照明模式 |
| 远程巡检 | 巡检任务编排、自动巡检执行和结果生成 |
| 智能疏散 | 疏散预案、疏散设备联动、人员疏散状态和疏散日志 |
| 疏散路径 | 基于图算法的路径规划、跨楼层路线、楼梯通行代价及路线合法性校验 |
| 火灾模拟演练 | 后端状态机驱动的火灾事件、应急响应、疏散和救援演练 |
| 后台日志 | 应急处置流程、系统操作日志及关键业务事件记录 |

---

## 三、技术栈

### 前端

- 框架：Vue 3（Composition API + `<script setup>`）、Vite 5
- 路由与状态：Vue Router 4（Hash 模式）、Pinia
- UI：Element Plus、Tailwind CSS
- 3D 渲染：Three.js
- 图表：ECharts（vue-echarts）
- 动画：GSAP

### 后端

- 运行环境：Cloudflare Workers
- Web 框架：Hono
- 关系型数据存储：Cloudflare D1
- 实时协调：Cloudflare Durable Objects
- 实时通信：WebSocket
- 接口规范：REST API v1

### 算法与数据处理

- 路径搜索：Dijkstra、Yen K 最短路
- 路线规划：多方案候选生成、路线验证和策略评分
- 建筑空间：楼层、房间、走廊、门、楼梯、出口及空间拓扑
- 疏散规划：整栋楼人员分组、Zone→Exit 分配和 BuildingEvacuationPlan
- 后续火灾仿真规划：FDS（Fire Dynamics Simulator）

---

## 四、架构与三种运行模式

### 系统架构

```
Vue Views
    ↓
Pinia Stores
    ↓
Service Layer
    ↓
Repository Layer
    ├── MockRepository
    │       └── src/mock
    │
    └── ApiRepository
            ↓
        Cloudflare Workers
            ├── REST API
            │       └── D1
            │
            └── Durable Objects
                    └── WebSocket Broadcast
```

### 三种运行模式

| 模式 | `VITE_DATA_SOURCE` | 数据来源 | 状态来源 | 后端失败行为 |
| --- | --- | --- | --- | --- |
| mock | `mock`（默认） | `src/mock/*` | 前端本地推演 | 不涉及后端 |
| api | `api` | Workers → D1 | 后端 REST | 显式告警，不静默回退 mock |
| demo | `demo` | Workers → D1 + DO | 后端状态机与 WebSocket | 显式告警，WebSocket 指数退避重连 |

- 数据契约见 `docs/API_CONTRACT.md`。
- 统一核心实体、REST API、Demo 状态机和 WebSocket 消息契约。
- 远端模式下，部分业务写路径采用本地即时更新与远端异步持久化。
- Demo 模式下，关键演练状态由后端状态机驱动，前端负责发起指令与呈现状态。

---

## 五、Demo Simulation Engine

Demo Simulation Engine 是 Stage 2 的核心组成部分。

八阶段状态机（IDLE + 七个业务阶段）由后端唯一负责定义：

```
worker/src/demo/stages.ts
```

前端不自行推进演练状态，只通过后端接口发起状态转换并接收实时状态。

主要原则：

- 状态机由后端驱动。
- 前端只负责指令发起和状态展示。
- Durable Objects 负责实时协调与 WebSocket 广播。
- D1 负责业务数据与历史数据持久化。
- D1 不作为实时消息总线。
- 演练状态、告警事件流和疏散预案生命周期相互独立，不得互相覆盖。

三个需要严格区分的业务流程：

1. Demo 八阶段演练状态机（IDLE + 七个业务阶段）。
2. Alarm 事件处置流程。
3. EvacuationPlan 生命周期。

---

## 六、整栋楼智能疏散系统

### 1. 整栋楼疏散原则

一次火灾对应一栋楼的一次整体疏散。

- `fireEvent` 描述火灾位置，包括楼栋、楼层和区域。
- `evacuationScope` 固定为 `BUILDING`。
- 人员按照 `floorId + zone` 分组。
- 每个有人区域生成对应疏散路线。
- 多种疏散策略覆盖整栋楼全部有人区域。

### 2. 权威数据结构

```
buildingPlans
    ↓
activeBuildingPlanId
    ↓
person.routeId / person.routePoints
```

- `buildingPlans` 是整栋楼疏散方案的权威数据。
- `activeBuildingPlanId` 标识当前有效方案。
- 人员路线数据必须与权威方案保持一致。
- 旧 `world.plans` 已降级为 `legacyPlans`，仅用于历史及旧接口兼容，不参与疏散决策。
- `routeMatrix.perZone` 是只读兼容投影，不得作为疏散方案和执行状态的权威来源。

### 3. 疏散规划算法

核心实现：

```
shared/evacuation/buildingEvacuationPlanner.js
shared/evacuation/routePlanner.js
shared/evacuation/routeValidator.js
```

规划流程：

```
建筑人员数据
    ↓
人员 Zone 分组
    ↓
共享建筑疏散拓扑
    ↓
Dijkstra / Yen K 最短路
    ↓
候选路线生成
    ↓
路线合法性验证
    ↓
策略评分与路线选择
    ↓
BuildingEvacuationPlan
    ↓
后端确认与人员路线分配
```

### 4. 疏散策略

- `PLAN-A`：均衡策略。
- `PLAN-B`：快速策略。
- `PLAN-C`：安全策略。

三套方案均面向整栋楼，不是某个区域的三条路线。

### 5. 路线合法性要求

- 不穿越墙体。
- 不经过火灾危险区域。
- 必须到达合法安全出口。
- 跨楼层路线必须经过楼梯。
- 路线起点、终点、所属楼层和区域必须符合建筑空间模型。
- 人员分组和路线区域归属必须一致。
- 路线确认必须满足权威方案及运行态约束。

### 6. 疏散灯方向、手动可执行路线与执行门禁

- **疏散灯方向裁决**：按「路线路径几何 + 设备位置」逐台裁决，取代整层统一的出口侧描述。裁决状态：`resolved`（已裁决）、`conflict`（冲突）、`undetermined`（无法确定）、`unlinked`（未关联路线）。展示层只消费裁决结果，不自行推断方向。
- **手动可执行路线**：支持基于权威建筑图选点生成可执行路线，包含拓扑邻接校验、编辑、保存与删除，并在复位时清理投影数据。
- **执行门禁**：路线确认与方向写入前执行前置校验（`BLOCKED` / `DONE` / 未知运行状态一律拒绝），校验先于任何副作用发生。

上述能力保证「路线的区域与楼层归属一致、邻接关系合法、执行前完成校验」，不保证任意手工构造的路线都自动可执行。

### 7. 一套算法，多端共用

```
shared/evacuation
    ├── Vue
    │     ├── 2D 平面图
    │     └── 3D 数字孪生
    │
    └── Worker
          └── Demo Simulation Engine
```

前端和 Worker 共用疏散规划算法及建筑空间数据，避免两端各自实现一套寻路逻辑。

---

## 七、疏散系统迭代路线

P1.8 是智能疏散系统的持续深化阶段，内部版本编号与平台 Stage 1/2/3 相互独立。

### P1.7：Golden Path 全链路验收

完成智能疏散关键链路的阶段性收口，建立后续疏散系统治理的基线。

### P1.8.1：智能疏散拓扑审计

主要工作：

- 建筑疏散拓扑现状审计。
- 房间、走廊、楼梯和出口连通关系检查。
- 既有拓扑与平面空间模型一致性核查。
- 识别不合理连接、缺失节点和路线可达性问题。

### P1.8.2：疏散数据与路线生命周期治理

主要工作：

- 出口运行态和失效状态处理。
- 疏散方案选择与有效性校验。
- Zone→Exit 分配。
- 路线生命周期管理。
- 方案确认与人员路线绑定。
- 路线失效和重新规划时的数据一致性。
- 关键状态变更和间接写入路径审查。

RG-01：人员 Zone 归属一致性

已完成（随 `fix(evacuation): harden zone attribution and group audit` 提交）：

- 修复走廊人员区域归属问题。
- 保证人员分组不受输入顺序影响。
- 保证人员 ID 在分组中恰好出现一次。
- 校验人员覆盖、重复 ID 和越界 ID。
- 校验分组人数与人员 ID 数量一致。
- 校验路线与分组区域及楼层一致。
- 对非法输入明确失败，不静默跳过。

RG-02：疏散路线完整性审查

后续工作：

- 路线几何合法性。
- 路线拓扑连续性。
- 路线起点和终点有效性。
- 出口状态和路线可用性。
- 路线对象与建筑空间模型一致性。
- 路线验证结果与实际执行链路一致性。

### P1.8.3：疏散展示与动态联动深化

后续规划方向：

- 智能疏散照明。
- 2D 平面图动态路线展示。
- 3D 数字孪生疏散动态展示。
- 人员、路线、出口和设备状态同步。
- 火灾场景与疏散展示联动。

具体实施以各项独立审查和授权为准。

---

## 八、3D 数字孪生与人员动态展示

### 3D 数字孪生

`src/components/building3d/` 负责模块化管理：

- 建筑模型。
- 火灾区域。
- 应急照明设备。
- 人员图层。
- 救援力量图层。
- 疏散路径图层。
- 相机控制和场景运镜。

支持建筑楼层逐层浏览及多类业务状态的可视化呈现。

### 人员沿后端路线移动

权威数据：

```
x / y
routePoints
progress
```

- 人员位置和路线进度由后端状态驱动。
- WebSocket 负责实时状态同步。
- 3D 只做视觉插值，不自行计算人员疏散速度。
- 人员沿路线折线移动，支持转弯和跨楼层楼梯移动。
- 到达安全出口后按业务规则处理展示状态。
- 滞留人员不跟随正常疏散路线移动。

坐标转换统一由：

```
src/components/building3d/coords.js
```

负责。

---

## 九、FDS 火灾动力学仿真规划

### 1. 建设定位

FDS（Fire Dynamics Simulator）是独立的火灾动力学仿真引擎，用于计算建筑火灾发展、烟气流动和热量传输。

FDS 不替代现有疏散算法，也不重新维护一套与平台冲突的建筑拓扑。

它的主要职责是提供火灾物理环境数据，为平台危险区域识别和动态疏散决策提供依据。

### 2. 后续建设内容

| 阶段 | 建设内容 |
| --- | --- |
| FDS-01 | FDS 版本、运行环境、计算资源和数据接口研究 |
| FDS-02 | 建筑几何转换、网格划分和火灾场景建模 |
| FDS-03 | 火源、热释放速率、材料、通风及边界条件配置 |
| FDS-04 | 温度、烟气、能见度、CO 等仿真结果提取 |
| FDS-05 | 火灾仿真结果与建筑楼层、Zone、路线空间映射 |
| FDS-06 | 火灾危险评估与现有疏散规划引擎耦合 |
| FDS-07 | 多火灾场景联合仿真与结果验证 |

### 3. 预期数据链路

```
FDS 火灾仿真
    ↓
温度 / 烟气 / 能见度 / CO
    ↓
时空数据处理
    ↓
建筑空间映射
    ↓
区域与路线危险评估
    ↓
智能疏散规划引擎
    ↓
动态路线调整
    ↓
2D / 3D 展示与应急指挥
```

### 4. 技术原则

- FDS 负责物理场仿真，不负责直接决定人员疏散路线。
- 建筑空间权威数据仍由平台统一管理。
- FDS 输入模型由平台建筑数据转换生成。
- 火灾仿真结果需要经过数据映射和危险判据处理。
- 不把未经验证的温度、能见度或 CO 数据直接当作人员安全结论。
- 初期优先采用预计算典型火灾场景和时间序列结果，后续再评估实时计算能力。

FDS 属于后续独立建设方向，目前不视为已接入平台的生产能力，也不预先指定为原有 Stage 4。

---

## 十、后续平台通用化建设

在现有单建筑和固定建筑空间模型基础上，后续需要逐步提高平台的通用性。

### 1. 登录与多角色权限

- 用户注册和登录。
- 身份认证与会话管理。
- 管理员、消防管理人员、巡检人员、普通用户等角色。
- 功能级和数据级权限控制。
- 关键操作审计。

### 2. 多建筑管理

- 建筑创建与维护。
- 用户与建筑授权关系。
- 多建筑数据隔离。
- 建筑级设备、人员、告警和疏散数据管理。
- 建筑切换与统一管理。

### 3. 平面图上传与建筑空间配置

- 建筑平面图上传。
- 楼层图管理。
- 房间、走廊、门、楼梯和出口配置。
- 空间坐标标定。
- 设备位置和方向配置。

### 4. 通用拓扑生成

- 从建筑空间数据提取疏散节点。
- 建立房间、走廊、门、楼梯和出口之间的连通关系。
- 生成统一疏散拓扑。
- 拓扑完整性检查。
- 支持人工修正和版本管理。

### 5. 可视化建筑编辑器

- 平面图空间标注。
- 节点和边编辑。
- 区域及出口配置。
- 设备布点。
- 拓扑可视化检查。
- 建筑模型保存和版本管理。

上述功能需要与现有建筑空间权威数据模型统一，避免前端编辑器、疏散算法和 FDS 模型各自维护不同的建筑结构。

---

## 十一、消防设备维修与移动端业务扩展

平台后续还可以与独立的消防设备运维业务系统协同。

规划方向：

- 消防设备台账。
- 设备故障上报。
- 维修任务创建。
- 维修人员分配。
- 维修过程记录。
- 设备维修历史。
- 巡检与维修任务关联。
- 设备生命周期管理。

未来可以探索与消防设备维修微信小程序的数据和业务协同，但需要先明确统一身份、设备 ID、接口契约和数据归属，不能默认两个独立项目已经完成系统集成。

---

## 十二、测试与质量保障

### 前端与共享算法测试（仓库根目录）

```
npm run test:route
npm run test:building
npm run test:unit
```

### Worker 测试（执行目录：`worker/`）

```
cd worker

npm run test:e2e
npm run test:e2e:browser
```

部署守卫与本地脚本测试（同样在 `worker/` 目录执行）：

```
cd worker

npm run check:deploy-config   # D1 配置检查（直接运行 check-d1-config.mjs）
npm run test:deploy-guard     # D1 部署配置检查测试，对应 check-d1-config.test.mjs
npm run test:deploy-wrapper   # 部署守卫及参数拦截测试，对应 deploy-guarded.test.mjs
npm run test:seed-local       # 本地 Seed 脚本测试，对应 seed-local.test.mjs
```

上述三项 `test:*` 为 Node 脚本级单元测试（构造临时夹具 / 注入式 spawn 与 fetch，无网络、无远端访问）。

`npm run deploy:dry-run`（在 `worker/` 目录）是**构建与部署预检**：只做本地打包构建、不上传、不部署，**不属于单元测试**，且不经部署守卫。

### 前端 E2E（仓库根目录，需先启动后端与 demo 前端）

```
npm run test:e2e:consistency
npm run test:e2e:journey
npm run test:e2e:retention
```

根目录 `package.json` 还提供 `test:e2e:b1`、`b2`、`b3`、`b3c`、`b305`、`b401`、`b402`、`b403` 等专项回归脚本。

### 其他验证

```
git diff --check
npm run build
```

验证重点：

- 疏散路线规划正确性。
- 建筑空间拓扑一致性。
- 人员分组和路线分配正确性。
- 前后端权威数据一致性。
- REST 与 WebSocket 状态一致性。
- 非法状态转换和重复操作处理。
- 后端不可用时不静默回退 Mock。
- 设备指令授权、执行反馈和失败恢复。
- 2D、3D 和后端人员路线数据一致性。

涉及 FDS 的后续验证还需要加入网格敏感性、边界条件、火灾场景合理性及仿真结果验证。

---

## 十三、本地开发

### 前端

```
npm install
npm run dev
```

### 前端构建

```
npm run build
npm run preview
```

### 配置运行模式

复制根目录 `.env.example` 为 `.env`：

```
VITE_DATA_SOURCE=mock
VITE_API_BASE_URL=http://localhost:8787
VITE_DEMO_SESSION_ID=default
```

| 变量 | 用途 | 取值 |
| --- | --- | --- |
| `VITE_DATA_SOURCE` | 运行模式（严格区分，不静默降级） | `mock`（默认）/ `api` / `demo` |
| `VITE_API_BASE_URL` | `api` / `demo` 模式下 Workers 后端地址 | 本地默认 `http://localhost:8787` |
| `VITE_DEMO_SESSION_ID` | `demo` 模式会话 id（对应 Durable Object 实例名） | 默认 `default` |

### 后端启动

```
cd worker

npm install

npm run migrate:local     # 应用 migrations/ 下全部迁移（0001_init.sql + 0002_demo.sql）到本地 D1

npm run dev               # 已自动注入 ALLOWED_ORIGINS=http://localhost:3000

# 若需要灌入种子数据，服务端还需注入与客户端一致的 SEED_TOKEN：
npx wrangler dev --var ALLOWED_ORIGINS:http://localhost:3000 --var SEED_TOKEN:<token>
```

后端默认地址：

```
http://localhost:8787
```

### 灌入种子数据

另开终端（仅限本机，走 `POST /api/v1/admin/seed`）：

```
# PowerShell
$env:SEED_TOKEN='<token>'; npm run seed:local

# bash
SEED_TOKEN='<token>' npm run seed:local
```

- 该脚本固定请求 `http://127.0.0.1:8787`，不会访问远端环境。
- **服务端与客户端必须使用相同的 `SEED_TOKEN`**：后端未配置该变量时种子接口直接返回 `501`（fail-closed），即使客户端带正确 token 也不会通过；本地启动方式见上一节。
- 种子数据为幂等写入（`INSERT OR REPLACE`），重复执行会覆盖固定种子记录。

---

## 十四、部署

### 前端部署

项目通过 GitHub 仓库集成部署至 Cloudflare Pages。

- 构建命令：`npm run build`
- 输出目录：`dist`
- 推送 `main` 分支后由 Pages 自动构建发布。

### 后端部署

Cloudflare Worker 独立部署。

```
cd worker

npx wrangler d1 create smart-fire-db

npm run migrate:remote

npm run deploy          # 部署守卫：先校验 D1 配置，通过后才调用 wrangler deploy
```

创建 D1 后，需要将返回的 `database_id` 配置到 `worker/wrangler.toml`。

部署前应完成环境变量、数据库绑定、CORS 来源、种子令牌和生产环境配置检查。

### 部署守卫与本地脚本

调用链：

```
npm run deploy
    ↓  worker/scripts/deploy-guarded.mjs      # npm run deploy 的实际入口
    ↓  worker/scripts/check-d1-config.mjs     # D1 配置检查子步骤
    ↓  wrangler deploy
```

- `database_id` 仍为占位符时，`check-d1-config.mjs` 会在调用 `wrangler deploy` **之前**失败退出（fail-closed）。
- 守卫拒绝会切换配置来源的参数：`--config` / `-c`、`--env` / `-e`、`--cwd`（含 `=` 与空格分隔形式），命中即终止且不启动任何子进程。
- `npm run deploy:dry-run` 只做本地构建预检（不上传、不部署），**不经过**上述守卫，也不属于单元测试。
- **直接执行 `npx wrangler deploy` 不经过该守卫**；守卫只约束 `npm run deploy` 这一受管入口，不构成完整的安全边界。
- 其他本地脚本入口（均在 `worker/` 目录执行）：`check:deploy-config`、`test:deploy-guard`、`test:deploy-wrapper`、`test:seed-local`。

### CORS 来源与种子令牌

- 生产环境默认允许的浏览器来源：`https://smart-fire-platform.pages.dev`。
- 本地开发由 `npm run dev` 自动注入 `ALLOWED_ORIGINS=http://localhost:3000`（Vite 端口见 `vite.config.js`）。
- 未命中来源时响应不下发 `Access-Control-Allow-Origin`，浏览器端即被拦截；**这是浏览器同源策略层面的 CORS 限制，不是 API 鉴权，也不是网络访问控制**——直连客户端（curl、脚本）不受其约束。
- `SEED_TOKEN` 仅用于保护 `/api/v1/admin/seed`，应通过 `wrangler secret put SEED_TOKEN` 配置，禁止写入 `wrangler.toml` 或仓库。
- 业务 REST 接口当前**未实现鉴权**（已知遗留项），部署到公网前需另行评估。

---

## 十五、当前项目进度与路线图

以下状态用于说明当前建设方向，不代表所有历史任务均已通过最终验收。

### 平台基础建设

- [x] 统一数据模型与 API Contract。
- [x] MockRepository / ApiRepository 双数据源。
- [x] Vue → Pinia → Service → Workers → D1 业务闭环。
- [x] Durable Objects 与 WebSocket 实时通信。
- [x] Demo Simulation Engine 后端状态机。
- [x] Mock / API / Demo 三种运行模式。
- [x] 整栋楼疏散规划基础能力。

### 智能疏散深化

- [x] P1.7 Golden Path 阶段性全链路验收。
- [x] P1.8.1 智能疏散现状与拓扑审计。
- [x] P1.8.2 D1-A、K-2、G1-B1、G1-B2-B 等已完成工作。
- [x] P1.8.2 Stage 2-A 已完成。
- [ ] P1.8.2 Stage 2-B 后续推进。
- [x] RG-01 人员 Zone 归属一致性最终收口（已完成并随 `fix(evacuation)` 提交）。
- [ ] RG-02 疏散路线完整性审查。
- [ ] P1.8.3 照明、2D/3D 展示等后续工作。

### 真实设备接入

- [ ] ESP32 设备接入。
- [ ] 毫米波雷达数据接入。
- [ ] Telemetry 数据上报。
- [ ] 设备身份认证。
- [ ] Command 指令下发与反馈。
- [ ] 设备与人员空间数据融合。

### FDS 火灾仿真

- [ ] FDS 环境与版本研究。
- [ ] 建筑模型转换。
- [ ] 火灾场景建模。
- [ ] 仿真结果提取。
- [ ] 火灾危险区域映射。
- [ ] 火灾与疏散算法耦合。
- [ ] 多场景联合验证。

### 平台通用化与扩展

- [ ] 登录与多角色权限。
- [ ] 多建筑管理和数据隔离。
- [ ] 建筑平面图上传。
- [ ] 通用建筑拓扑生成。
- [ ] 可视化建筑编辑器。
- [ ] 移动端与消防设备运维协同。

---

## 十六、项目目录结构

```
src/
├── api/                 # API 契约与 Mock/Api 数据仓库
├── assets/              # 静态资源与 3D 模型
├── components/          # 通用组件与 building3d 三维模块
├── mock/                # 模拟数据、设备、人员、疏散拓扑
├── router/              # Vue Router
├── services/            # 领域 Service 层
├── stores/              # Pinia 状态管理
├── styles/              # 全局主题与样式
└── views/               # 页面级视图

shared/
├── evacuation/          # 前端与 Worker 共用的疏散算法
├── person/              # 人员运行态
└── device/              # 设备运行态

worker/
├── migrations/          # D1 数据库迁移
├── scripts/             # 部署守卫、D1 配置校验、本地种子脚本
└── src/
    ├── demo/             # Demo Simulation Engine
    ├── durable/          # Durable Objects（DemoRoom 实时协调）
    ├── routes/           # REST API 路由
    ├── seed.ts           # 种子数据
    └── types.ts          # 后端类型定义

docs/
└── API_CONTRACT.md       # 数据契约、API、状态机与 WS 消息定义
```

---

## 十七、项目建设原则

1. 统一数据权威：同一业务实体不能由多个模块分别维护互相冲突的权威状态。
2. 前后端职责分离：业务状态和关键决策由后端负责，前端负责交互和可视化。
3. 算法共享：前端和 Worker 复用同一套疏散算法，避免重复实现。
4. 建筑模型统一：建筑空间、疏散拓扑、FDS 输入模型和可视化展示必须建立明确映射关系。
5. 实时与持久化分离：Durable Objects 负责实时协调，D1 负责业务和历史数据持久化。
6. 安全优先：真实设备接入必须具备身份认证、指令授权、执行反馈和异常处理。
7. 分阶段验收：每个阶段必须有明确范围、测试证据和验收标准，不以代码完成代替系统验收。
8. 保护既有架构：新增仿真、算法和业务能力时，不随意破坏已经建立的数据契约和权威数据链路。

---

## 项目相关仓库

- 主平台：`smart-fire-platform` (https://github.com/Sun12056/smart-fire-platform)
- FDS 火灾动力学仿真：`fds` (https://github.com/Sun12056/fds)
- 消防设备维修小程序：`fireFightingEipmentApplet` (https://github.com/Sun12056/fireFightingEipmentApplet)

项目目标：建设集建筑数字孪生、消防感知、实时协同、火灾动力学仿真、智能疏散和应急指挥于一体的智慧消防平台。

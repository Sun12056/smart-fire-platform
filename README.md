# 智慧消防可视化指挥平台（Smart Fire Platform）

面向高层建筑消防场景的可视化指挥调度前端平台，基于 **Vue 3 + Three.js** 构建，提供楼宇 3D 数字孪生、设备物联监测、智能告警、疏散路径规划等一体化能力。

> 本项目为大创竞赛作品，当前为纯前端 Demo（数据来自内置模拟数据源），已通过 GitHub 集成部署至 Cloudflare Pages，后端服务规划中。

## 功能模块

| 模块 | 说明 |
| --- | --- |
| 楼宇态势 | 多楼栋消防态势总览，3D 数字孪生场景，实时火情区域、人员分布、救援力量可视化 |
| 设备状态 | 4 栋 × 6 层消防设备台账，基于平面空间数据生成，含坐标 / 方向 / 所属区域 |
| 智能告警 | 实时告警流、分级统计与处置流转 |
| 智能照明 | 照明设备远程控制、亮度历史曲线、多场景照明模式 |
| 远程巡检 | 巡检任务编排、自动巡检执行与结果生成 |
| 智能疏散 | 疏散设备联动控制、疏散日志 |
| 疏散路径 | 基于图算法的疏散路径规划（Dijkstra 最短路 + k 短路备选路径），支持跨楼层路径、楼梯通行代价与路径合法性校验 |
| 后台日志 | 应急处置流程与操作日志 |

## 技术栈

- **框架**：Vue 3（Composition API + `<script setup>`）、Vite 5
- **路由 / 状态**：Vue Router 4（Hash 模式）、Pinia
- **UI**：Element Plus、Tailwind CSS
- **3D 渲染**：Three.js（建筑模型 `.glb`、火情区域、应急灯、人员 / 救援 / 疏散路径图层、相机运镜）
- **图表**：ECharts（vue-echarts）
- **动画**：GSAP

## 核心亮点

- **3D 数字孪生**：`src/components/building3d/` 模块化封装场景、建筑模型、火情区域、应急灯、人员图层、救援图层、疏散路径图层与相机导演，支持 6 层建筑逐层浏览
- **真实图算法疏散规划**：`src/mock/routeGraph.js` 基于房间连通关系建图，实现 Dijkstra 最短路径、k 短路备选方案、楼梯通行时间惩罚与疏散耗时估算
- **模拟实时数据引擎**：Pinia store 每 5 秒刷新模拟数据，还原真实平台的数据流动效果，内置演示模式控制面板

## 快速开始

```bash
# 安装依赖
npm install

# 本地开发
npm run dev

# 构建生产版本
npm run build

# 本地预览构建产物
npm run preview
```

## 架构与双数据源

```
Vue 视图 → Pinia (fireStore) → Service 层（8 个领域服务） → Repository ┬ MockRepository（src/mock，默认）
                                                                      └ ApiRepository → Workers(Hono) → D1
```

- 数据契约见 `docs/API_CONTRACT.md`（Building / Device / Telemetry / Alarm / Inspection / EvacuationPlan / PersonPresence / OperationLog 八类核心实体）
- `VITE_DATA_SOURCE=mock`（默认）：纯前端演示，行为不变；`=api`：走 Workers + D1，初始化失败自动回退 mock
- 远程模式下操作日志、告警处置、巡检结果等写路径为"本地即时生效 + 远端异步落库"

### 本地启动后端（Cloudflare Workers + D1）

```bash
cd worker
npm install
npm run migrate:local     # 本地 D1 建表
npm run dev               # 启动 API（http://localhost:8787）
# 另开终端灌入种子数据（复用前端 mock 同源数据）
curl -X POST http://localhost:8787/api/v1/admin/seed
```

前端以 api 模式启动：根目录复制 `.env.example` 为 `.env` 后设置 `VITE_DATA_SOURCE=api`，再 `npm run dev`。
E2E 冒烟脚本：`node worker/e2e-smoke.cjs`（需先以 api 模式启动前后端，依赖系统 Edge）。

## 部署

项目通过 GitHub 仓库集成部署至 **Cloudflare Pages**，推送 `main` 分支后自动构建发布（构建命令 `npm run build`，输出目录 `dist`）。

后端 API 独立部署为 Cloudflare Worker：`cd worker && npx wrangler d1 create smart-fire-db`（将返回的 database_id 填入 `wrangler.toml`）→ `npm run migrate:remote` → `npm run deploy`。

## 路线图

- [x] 统一数据模型与 API Contract（八类核心实体，REST v1）
- [x] MockRepository / ApiRepository 双数据源 + Vue→Pinia→Service→Workers→D1 闭环
- [ ] Durable Objects + WebSocket（实时人员位置、设备状态、疏散动态）
- [ ] Demo Simulation Engine（后端状态机驱动"模拟火灾→启动预案→路径确认→智能疏散→滞留人员→救援"全流程）
- [ ] ESP32 + 毫米波雷达接入 telemetry / command API
- [ ] 登录与多角色权限

## 目录结构

```
src/
├── api/             # API 契约 + Mock/Api 双数据源仓库
├── assets/          # 静态资源（样式、3D 模型）
├── components/      # 通用组件 + building3d 三维模块
├── mock/            # 模拟数据源（设备、告警、人员、疏散、图算法等）
├── router/          # 路由配置
├── services/        # Service 层（8 个领域服务）
├── stores/          # Pinia 状态管理
├── styles/          # 主题样式
└── views/           # 页面级组件

worker/              # Cloudflare Workers + Hono + D1 后端 API
├── migrations/      # D1 表结构迁移
├── src/routes/      # REST 路由（按资源分文件）
└── src/seed.ts      # 种子数据（与前端 mock 同源）
```


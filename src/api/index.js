// ================== 运行模式与数据源选择 ==================
// 三种运行模式（严格区分，不允许互相静默降级）：
//   mock : VITE_DATA_SOURCE=mock（默认）—— 纯前端本地模拟，行为与改造前一致，后端无关
//   api  : VITE_DATA_SOURCE=api         —— 真实后端 REST（Workers → D1）；失败必须显式报错，绝不静默回退 mock
//   demo : VITE_DATA_SOURCE=demo        —— 后端驱动演示：REST + WebSocket，六阶段状态机由 Demo Simulation Engine 驱动
import { mockRepository } from './mockRepository'
import { apiRepository } from './apiRepository'

const rawMode = String(import.meta.env.VITE_DATA_SOURCE || 'mock').toLowerCase()
const mode = ['api', 'demo'].includes(rawMode) ? rawMode : 'mock'

export const dataSource = {
  mode,
  get isMock() { return this.mode === 'mock' },
  get isApi() { return this.mode === 'api' },
  get isDemo() { return this.mode === 'demo' },
  /** 是否走远端后端（api 与 demo 都是，二者区别只在于是否启用状态机实时通道） */
  get isRemote() { return this.mode === 'api' || this.mode === 'demo' },
}

// 远端模式统一使用 ApiRepository；mock 模式使用 MockRepository
export const repository = dataSource.isRemote ? apiRepository : mockRepository

export * from './contract'
export { mockRepository, apiRepository }

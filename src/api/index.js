// ================== 数据源选择 ==================
// VITE_DATA_SOURCE=mock（默认） → MockRepository，行为与原 Demo 完全一致
// VITE_DATA_SOURCE=api         → ApiRepository，走 Workers → D1；初始化失败时 fireStore 自动回退 mock
import { mockRepository } from './mockRepository'
import { apiRepository } from './apiRepository'

export const dataSource = {
  mode: import.meta.env.VITE_DATA_SOURCE === 'api' ? 'api' : 'mock',
  get isApi() { return this.mode === 'api' },
  get isMock() { return this.mode === 'mock' },
}

export const repository = dataSource.isApi ? apiRepository : mockRepository

export * from './contract'
export { mockRepository, apiRepository }

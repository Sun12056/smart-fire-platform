// EvacuationPlan 服务：疏散预案（自动 k 短路 / 手动编辑）的保存与生命周期流转
import { repository } from '../api'

export const evacuationPlanService = {
  async list(params) {
    const list = await repository.evacuationPlans.list(params)
    return Array.isArray(list) ? list : []
  },
  async get(id) {
    return repository.evacuationPlans.get(id)
  },
  create(plan) {
    return repository.evacuationPlans.create(plan)
  },
  // 阶段二 Demo Simulation Engine 通过 update 驱动 CONFIRMED→EXECUTING→DONE
  update(id, patch) {
    return repository.evacuationPlans.update(id, patch)
  },
}

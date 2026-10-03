// Inspection 服务：远程一键巡检历史与结果归档
import { repository } from '../api'

export const inspectionService = {
  async list(params) {
    const list = await repository.inspections.list(params)
    return Array.isArray(list) ? list : []
  },
  // 提交巡检结果（fire-and-forget：本地 history 已即时更新，远端异步落库）
  create(result) {
    return repository.inspections.create(result)
  },
}

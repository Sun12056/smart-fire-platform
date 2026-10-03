// Building 服务：楼栋及聚合统计
import { repository } from '../api'

export const buildingService = {
  async list(params) {
    const list = await repository.buildings.list(params)
    return Array.isArray(list) ? list : []
  },
}

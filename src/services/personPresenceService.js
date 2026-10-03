// PersonPresence 服务：毫米波雷达人员感知（列表 / 聚合统计 / 热力图 / 批量上报）
import { repository } from '../api'

export const personPresenceService = {
  async list(params) {
    const list = await repository.personPresence.list(params)
    return Array.isArray(list) ? list : []
  },
  async stats() {
    const s = await repository.personPresence.stats()
    return s && typeof s === 'object' ? s : {}
  },
  async heatmap() {
    const list = await repository.personPresence.heatmap()
    return Array.isArray(list) ? list : []
  },
  // 批量 upsert（阶段二实时位置快照 / 阶段三雷达网关）
  upsertBatch(persons) {
    return repository.personPresence.upsertBatch(persons)
  },
}

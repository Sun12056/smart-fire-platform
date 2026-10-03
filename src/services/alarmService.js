// Alarm 服务：告警查询与七步处置流转（pending→processing→reviewing→resolved）
import { repository, ENUMS } from '../api'

export const alarmService = {
  async list(params) {
    const list = await repository.alarms.list(params)
    return Array.isArray(list) ? list : []
  },
  async get(id) {
    return repository.alarms.get(id)
  },
  create(alarm) {
    return repository.alarms.create(alarm)
  },
  // 状态流转：status 变化时按契约补全 progress
  update(id, patch = {}) {
    const next = { ...patch }
    if (next.status && ENUMS.alarmProgress[next.status] !== undefined && next.progress === undefined) {
      next.progress = ENUMS.alarmProgress[next.status]
    }
    return repository.alarms.update(id, next)
  },
}

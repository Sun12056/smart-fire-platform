// OperationLog 服务：统一操作日志（设备/告警/疏散/巡检/路线/照明/人员/系统）
import { repository } from '../api'

export const operationLogService = {
  async list(params) {
    const list = await repository.operationLogs.list(params)
    return Array.isArray(list) ? list : []
  },
  // fire-and-forget 写入：本地日志已即时入列，远端异步落库
  create(log) {
    return repository.operationLogs.create(log)
  },
}

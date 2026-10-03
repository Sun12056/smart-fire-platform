// Telemetry 服务：遥测时序查询与设备上报（阶段三 ESP32 + 毫米波雷达入口）
import { repository } from '../api'

export const telemetryService = {
  async list(params) {
    const list = await repository.telemetry.list(params)
    return Array.isArray(list) ? list : []
  },
  // 单条上报（fire-and-forget 场景直接调用，不 await 由调用方决定）
  report(entry) {
    return repository.telemetry.create(entry)
  },
  reportBatch(entries) {
    return repository.telemetry.createBatch(entries)
  },
}

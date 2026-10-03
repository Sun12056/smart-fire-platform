// Device 服务：设备台账查询 / 状态与参数下发（阶段三 ESP32 command 复用 update）
import { repository } from '../api'

function normalize(dev) {
  if (!dev) return dev
  return { ...dev, area: dev.zone ?? dev.area }
}

export const deviceService = {
  async list(params) {
    const list = await repository.devices.list(params)
    return (Array.isArray(list) ? list : []).map(normalize)
  },
  async update(id, patch) {
    return normalize(await repository.devices.update(id, patch))
  },
}

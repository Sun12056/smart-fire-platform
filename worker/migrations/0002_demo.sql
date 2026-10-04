-- 阶段二：Demo Simulation Engine 的历史与会话数据
-- 注意：实时状态（人员位置 / 设备运行时 / 灯光）保存在 Durable Object，
-- D1 仅存「业务数据 + 历史记录」，不作为实时消息总线。

-- 演示会话（一次六阶段处置的生命周期记录）
CREATE TABLE IF NOT EXISTS demo_sessions (
  id           TEXT PRIMARY KEY,           -- Durable Object 实例 id
  stage        TEXT NOT NULL,              -- 当前阶段（IDLE … COMPLETED）
  building_id  TEXT,
  floor_id     TEXT,
  zone         TEXT,
  started_at   TEXT,
  updated_at   TEXT,
  completed    INTEGER NOT NULL DEFAULT 0
);

-- 演示事件流水（每次阶段推进产生的事件，供复盘与后台日志展示）
CREATE TABLE IF NOT EXISTS demo_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT NOT NULL,
  seq         INTEGER NOT NULL DEFAULT 0,
  stage       TEXT NOT NULL,
  action      TEXT NOT NULL,
  detail      TEXT,
  level       TEXT NOT NULL DEFAULT 'info',
  created_at  TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
CREATE INDEX IF NOT EXISTS idx_demo_events_session ON demo_events(session_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_demo_events_stage ON demo_events(stage);

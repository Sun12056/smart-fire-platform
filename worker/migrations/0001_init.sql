-- 绿智哨兵平台 · D1 初始迁移（8 类核心实体）
-- 字段映射与 docs/API_CONTRACT.md 对齐（DB snake_case ↔ wire camelCase）

-- 1. Building 楼栋
CREATE TABLE IF NOT EXISTS buildings (
  id           TEXT PRIMARY KEY,          -- B001~B004
  name         TEXT NOT NULL,
  type         TEXT NOT NULL,
  floors       INTEGER NOT NULL DEFAULT 6,
  patrol_rate  REAL NOT NULL DEFAULT 96,
  created_at   TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
-- deviceCount/online/abnormal/offline/status/lastAlarm 为聚合派生，读取时 JOIN devices/alarms 计算

-- 2. Device 设备台账
CREATE TABLE IF NOT EXISTS devices (
  id                   TEXT PRIMARY KEY,  -- B003-EL-5F-01（楼栋前缀全局唯一）
  plan_id              TEXT,
  name                 TEXT NOT NULL,
  type                 TEXT NOT NULL,     -- evacuation_light|emergency_light|smoke_detector|radar_sensor|exit_sign
  building_id          TEXT NOT NULL REFERENCES buildings(id),
  floor_id             TEXT NOT NULL,     -- 1F~6F
  zone                 TEXT,              -- A区|B区|C区|D区|走廊|楼梯N|安全出口（zone 与 area 统一存本列）
  zone_name            TEXT,
  x                    REAL,
  y                    REAL,
  status               TEXT NOT NULL DEFAULT 'normal',   -- normal|warning|fault|emergency
  controllable         INTEGER NOT NULL DEFAULT 0,
  communication        TEXT NOT NULL DEFAULT 'online',   -- online|offline
  battery              INTEGER,
  temperature          REAL,
  last_report          TEXT,
  install_position     TEXT,
  work_hours           INTEGER,
  voltage              REAL,
  signal               INTEGER,
  direction            TEXT,              -- left|right（疏散指示灯动态换向）
  recommended_direction TEXT,
  brightness           INTEGER,
  current_mode         TEXT,              -- daily|offline|emergency
  detection_range      REAL,              -- 雷达
  detected_persons     INTEGER,           -- 雷达
  exit_id              TEXT,
  stair_id             TEXT,
  door_id              TEXT,
  emergency_flash      INTEGER NOT NULL DEFAULT 0,
  created_at           TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  updated_at           TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
CREATE INDEX IF NOT EXISTS idx_devices_location ON devices(building_id, floor_id, zone);
CREATE INDEX IF NOT EXISTS idx_devices_type ON devices(type);
CREATE INDEX IF NOT EXISTS idx_devices_status ON devices(status);

-- 3. Telemetry 遥测（时序，阶段三 ESP32 + 毫米波雷达上报入口）
CREATE TABLE IF NOT EXISTS telemetry (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id    TEXT NOT NULL,
  kind         TEXT NOT NULL,             -- battery|temperature|signal|voltage|brightness|personCount|status|direction|mode|heartbeat
  value        TEXT NOT NULL,             -- 标量 JSON 序列化
  reported_at  TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
CREATE INDEX IF NOT EXISTS idx_telemetry_device_time ON telemetry(device_id, reported_at DESC);
CREATE INDEX IF NOT EXISTS idx_telemetry_kind ON telemetry(kind);

-- 4. Alarm 告警（七步处置四态流转 pending→processing→reviewing→resolved）
CREATE TABLE IF NOT EXISTS alarms (
  id           TEXT PRIMARY KEY,
  device_id    TEXT,
  building_id  TEXT NOT NULL,
  floor_id     TEXT,
  zone         TEXT,
  type         TEXT NOT NULL,
  level        TEXT NOT NULL,             -- danger|warning|info
  status       TEXT NOT NULL DEFAULT 'pending',
  progress     INTEGER NOT NULL DEFAULT 10,
  description  TEXT,
  occurred_at  TEXT NOT NULL,
  handled_at   TEXT,
  handled_by   TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
CREATE INDEX IF NOT EXISTS idx_alarms_status ON alarms(status, level);
CREATE INDEX IF NOT EXISTS idx_alarms_building ON alarms(building_id, occurred_at DESC);

-- 5. Inspection 巡检
CREATE TABLE IF NOT EXISTS inspections (
  id           TEXT PRIMARY KEY,
  device_id    TEXT NOT NULL,
  device_name  TEXT,
  result       TEXT NOT NULL,             -- pass|warning|fail
  duration_ms  INTEGER,
  details      TEXT,                      -- JSON [{itemId,name,result,message}]
  operator     TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
CREATE INDEX IF NOT EXISTS idx_inspections_device ON inspections(device_id, created_at DESC);

-- 6. EvacuationPlan 疏散预案（NORMAL|WARNING|BLOCKED|CONFIRMED|EXECUTING|DONE）
CREATE TABLE IF NOT EXISTS evacuation_plans (
  id             TEXT PRIMARY KEY,
  name           TEXT,
  building_id    TEXT NOT NULL,
  building_name  TEXT,
  start_floor    TEXT NOT NULL,
  start_area     TEXT NOT NULL,
  exit_id        TEXT,
  exit_label     TEXT,
  exit_side      TEXT,
  type           TEXT NOT NULL DEFAULT 'auto',   -- auto|manual
  status         TEXT NOT NULL DEFAULT 'NORMAL',
  recommended    INTEGER NOT NULL DEFAULT 0,
  risk_level     TEXT,
  score          REAL,
  distance       REAL,
  estimated_time REAL,
  device_count   INTEGER,
  congestion     INTEGER,
  zone_color     TEXT,
  floors_passed  TEXT,                    -- JSON array
  path           TEXT,                    -- JSON array of nodes
  extra          TEXT,                    -- JSON {corridor,stair,manualNodes,manualEdges}
  created_at     TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
CREATE INDEX IF NOT EXISTS idx_plans_building ON evacuation_plans(building_id, start_floor, status);

-- 7. PersonPresence 人员感知（毫米波雷达）
CREATE TABLE IF NOT EXISTS person_presence (
  id                TEXT PRIMARY KEY,
  building_id       TEXT NOT NULL,
  floor_id          TEXT NOT NULL,
  zone              TEXT NOT NULL,
  x                 REAL,
  y                 REAL,
  status            TEXT NOT NULL DEFAULT 'normal',  -- normal|static|warning|evacuating|safe|stranded|located|rescued
  speed             REAL,
  direction         REAL,                -- 角度 0~360
  distance          REAL,
  movement_type     TEXT,                -- static|moving
  source_device_id  TEXT,
  detected_at       TEXT,
  name              TEXT,
  department        TEXT,
  updated_at        TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
CREATE INDEX IF NOT EXISTS idx_presence_location ON person_presence(building_id, floor_id, zone);
CREATE INDEX IF NOT EXISTS idx_presence_status ON person_presence(status);

-- 8. OperationLog 操作日志（统一三套历史日志）
CREATE TABLE IF NOT EXISTS operation_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  module      TEXT NOT NULL DEFAULT '综合',
  action      TEXT NOT NULL,
  detail      TEXT,
  operator    TEXT DEFAULT '管理员',
  level       TEXT NOT NULL DEFAULT 'info',
  created_at  TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
CREATE INDEX IF NOT EXISTS idx_logs_module ON operation_logs(module, created_at DESC);

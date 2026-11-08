-- [CANDIDATE v10] WP-TRIAL-AUTH-01 · 0003_auth
-- 6 表 / 10 索引 / 13 触发器 / 9 CHECK / 3 FK
-- 仅全新空库初始化；D1 兼容性 [NV]
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT,
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  iterations INTEGER NOT NULL CHECK (iterations >= 10000),
  role TEXT NOT NULL CHECK (role IN ('admin','teacher')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  must_change_password INTEGER NOT NULL DEFAULT 0 CHECK (must_change_password IN (0,1)),
  created_by TEXT,
  password_updated_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_login_at TEXT,
  CHECK (COALESCE(created_by, '') <> 'bootstrap' OR role = 'admin')
);
CREATE INDEX IF NOT EXISTS idx_users_role_status ON users(role, status);
CREATE INDEX IF NOT EXISTS idx_users_created_by ON users(created_by);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  last_seen_at TEXT NOT NULL,
  ip TEXT,
  user_agent TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS login_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  ip TEXT NOT NULL,
  attempted_at TEXT NOT NULL,
  success INTEGER NOT NULL CHECK (success IN (0,1)),
  reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_attempts_user ON login_attempts(username, attempted_at);
CREATE INDEX IF NOT EXISTS idx_attempts_ip ON login_attempts(ip, attempted_at);
CREATE INDEX IF NOT EXISTS idx_attempts_time ON login_attempts(attempted_at);

CREATE TABLE IF NOT EXISTS auth_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event TEXT NOT NULL,
  username TEXT,
  actor TEXT,
  ip TEXT,
  user_agent TEXT,
  detail TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_time ON auth_audit(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_event ON auth_audit(event, created_at);

CREATE TABLE IF NOT EXISTS password_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  iterations INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pwhist_user ON password_history(user_id, created_at);

CREATE TABLE IF NOT EXISTS bootstrap_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  admin_created INTEGER NOT NULL DEFAULT 0 CHECK (admin_created IN (0,1)),
  admin_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  created_at TEXT,
  closed_at TEXT,
  CHECK (
    ( admin_created = 0
      AND admin_user_id IS NULL
      AND created_at IS NULL
      AND closed_at IS NULL )
    OR
    ( admin_created = 1
      AND admin_user_id IS NOT NULL
      AND created_at IS NOT NULL
      AND closed_at IS NOT NULL
      AND closed_at = created_at )
  )
);
INSERT OR IGNORE INTO bootstrap_state (id, admin_created) VALUES (1, 0);

CREATE TRIGGER IF NOT EXISTS trg_last_admin_on_update
BEFORE UPDATE OF status, role ON users
WHEN OLD.role = 'admin' AND OLD.status = 'active'
  AND (NEW.role <> 'admin' OR NEW.status <> 'active')
  AND (SELECT COUNT(*) FROM users WHERE role='admin' AND status='active') <= 1
BEGIN
  SELECT RAISE(ABORT, 'LAST_ADMIN_PROTECTED');
END;

CREATE TRIGGER IF NOT EXISTS trg_last_admin_on_delete
BEFORE DELETE ON users
WHEN OLD.role = 'admin' AND OLD.status = 'active'
  AND (SELECT COUNT(*) FROM users WHERE role='admin' AND status='active') <= 1
BEGIN
  SELECT RAISE(ABORT, 'LAST_ADMIN_PROTECTED');
END;

CREATE TRIGGER IF NOT EXISTS trg_revoke_sessions_on_disable
AFTER UPDATE OF status ON users
WHEN NEW.status = 'disabled' AND OLD.status = 'active'
BEGIN
  UPDATE sessions SET revoked_at = NEW.updated_at
   WHERE user_id = NEW.id AND revoked_at IS NULL;
END;

CREATE TRIGGER IF NOT EXISTS trg_revoke_sessions_on_password_change
AFTER UPDATE OF password_hash ON users
WHEN OLD.password_hash <> NEW.password_hash
BEGIN
  UPDATE sessions SET revoked_at = NEW.updated_at
   WHERE user_id = NEW.id AND revoked_at IS NULL;
END;

CREATE TRIGGER IF NOT EXISTS trg_revoke_sessions_on_role_change
AFTER UPDATE OF role ON users
WHEN OLD.role <> NEW.role
BEGIN
  UPDATE sessions SET revoked_at = NEW.updated_at
   WHERE user_id = NEW.id AND revoked_at IS NULL;
END;

CREATE TRIGGER IF NOT EXISTS trg_bootstrap_single_shot
BEFORE INSERT ON users
WHEN NEW.created_by = 'bootstrap'
  AND (
    NEW.role <> 'admin'
    OR COALESCE((SELECT admin_created FROM bootstrap_state WHERE id = 1), -1) <> 0
    OR (SELECT closed_at FROM bootstrap_state WHERE id = 1) IS NOT NULL
  )
BEGIN
  SELECT RAISE(ABORT, 'BOOTSTRAP_STATE_INVALID');
END;

CREATE TRIGGER IF NOT EXISTS trg_bootstrap_finalize
AFTER INSERT ON users
WHEN NEW.created_by = 'bootstrap' AND NEW.role = 'admin'
BEGIN
  UPDATE bootstrap_state
     SET admin_created = 1,
         admin_user_id = NEW.id,
         created_at = NEW.created_at,
         closed_at = NEW.created_at
   WHERE id = 1 AND admin_created = 0 AND closed_at IS NULL;

  SELECT RAISE(ABORT, 'BOOTSTRAP_FINALIZE_FAILED')
  WHERE NOT EXISTS (
    SELECT 1 FROM bootstrap_state
     WHERE id = 1 AND admin_created = 1
       AND admin_user_id = NEW.id
       AND created_at IS NOT NULL
       AND closed_at IS NOT NULL
       AND closed_at = created_at
  );
END;

CREATE TRIGGER IF NOT EXISTS trg_bootstrap_state_immutable
BEFORE UPDATE ON bootstrap_state
WHEN OLD.admin_created = 1
  AND (
    NEW.admin_created <> 1
    OR NEW.admin_user_id IS NOT OLD.admin_user_id
    OR NEW.created_at IS NOT OLD.created_at
    OR NEW.closed_at IS NOT OLD.closed_at
  )
BEGIN
  SELECT RAISE(ABORT, 'BOOTSTRAP_STATE_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS trg_bootstrap_user_identity_immutable
BEFORE UPDATE OF created_by ON users
WHEN (
    OLD.created_by = 'bootstrap'
    AND COALESCE(NEW.created_by, '') <> 'bootstrap'
  )
  OR (
    COALESCE(OLD.created_by, '') <> 'bootstrap'
    AND NEW.created_by = 'bootstrap'
  )
BEGIN
  SELECT RAISE(ABORT, 'BOOTSTRAP_IDENTITY_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS trg_bootstrap_state_no_delete
BEFORE DELETE ON bootstrap_state
BEGIN
  SELECT RAISE(ABORT, 'BOOTSTRAP_STATE_NOT_DELETABLE');
END;

CREATE TRIGGER IF NOT EXISTS trg_bootstrap_state_no_replace
BEFORE INSERT ON bootstrap_state
WHEN EXISTS (
  SELECT 1 FROM bootstrap_state bs
   WHERE bs.id = NEW.id
     AND (
          bs.admin_created  IS NOT NEW.admin_created
       OR bs.admin_user_id IS NOT NEW.admin_user_id
       OR bs.created_at    IS NOT NEW.created_at
       OR bs.closed_at     IS NOT NEW.closed_at
     )
)
BEGIN
  SELECT RAISE(ABORT, 'BOOTSTRAP_STATE_EXISTS');
END;

CREATE TRIGGER IF NOT EXISTS trg_users_no_replace_last_admin
BEFORE INSERT ON users
WHEN EXISTS (
  SELECT 1 FROM users u
   WHERE (u.id = NEW.id OR u.username = NEW.username)
     AND u.role = 'admin'
     AND u.status = 'active'
)
AND (SELECT COUNT(*) FROM users WHERE role='admin' AND status='active') <= 1
BEGIN
  SELECT RAISE(ABORT, 'LAST_ADMIN_REPLACE_PROTECTED');
END;

-- T13: UPDATE conflict guard (v10; also covers UPDATE OR REPLACE)
-- Blocks any UPDATE whose NEW id/username collides with a different existing row.
-- Rationale: with recursive_triggers=OFF, UPDATE OR REPLACE deletes the conflicting
-- row without firing BEFORE DELETE (T2), allowing removal of the last active admin.
CREATE TRIGGER IF NOT EXISTS trg_users_no_update_conflict
BEFORE UPDATE OF id, username ON users
WHEN EXISTS (
  SELECT 1 FROM users u
   WHERE u.id <> OLD.id
     AND (u.id = NEW.id OR u.username = NEW.username)
)
BEGIN
  SELECT RAISE(ABORT, 'USER_CONFLICT_ON_UPDATE');
END;

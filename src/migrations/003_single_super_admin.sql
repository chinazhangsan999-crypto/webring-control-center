DO $$
BEGIN
  IF (SELECT COUNT(*) FROM admins) > 1 THEN
    RAISE EXCEPTION '单超级管理员迁移中止：admins 表已存在多个账号';
  END IF;
END $$;

ALTER TABLE admins
  ADD COLUMN IF NOT EXISTS singleton_key BOOLEAN NOT NULL DEFAULT TRUE CHECK (singleton_key = TRUE),
  ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS ux_admins_singleton ON admins(singleton_key);

ALTER TABLE admin_sessions
  ADD COLUMN IF NOT EXISTS ip INET,
  ADD COLUMN IF NOT EXISTS user_agent TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_admin_sessions_admin_expiry
  ON admin_sessions(admin_id, expires_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS ux_jobs_active_publish_site
  ON jobs(type, site_id)
  WHERE type = 'publish.deploy' AND status IN ('queued', 'running');

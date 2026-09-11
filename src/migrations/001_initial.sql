CREATE TABLE IF NOT EXISTS schema_migrations (
  name TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS admins (
  id BIGSERIAL PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS admin_sessions (
  id BIGSERIAL PRIMARY KEY,
  admin_id BIGINT NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  csrf_token TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_admin_sessions_expiry ON admin_sessions(expires_at);

CREATE TABLE IF NOT EXISTS sites (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  public_url TEXT NOT NULL,
  admin_url TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'online', 'stale', 'offline')),
  agent_version TEXT NOT NULL DEFAULT '',
  last_seen_at TIMESTAMPTZ,
  last_ip INET,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS site_credentials (
  site_id BIGINT PRIMARY KEY REFERENCES sites(id) ON DELETE CASCADE,
  secret_hash TEXT NOT NULL,
  secret_hint TEXT NOT NULL,
  rotated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS site_revisions (
  site_id BIGINT PRIMARY KEY REFERENCES sites(id) ON DELETE CASCADE,
  nodes_revision BIGINT NOT NULL DEFAULT 1,
  ads_revision BIGINT NOT NULL DEFAULT 1,
  publish_revision BIGINT NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS site_groups (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  slug TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS site_group_members (
  group_id BIGINT NOT NULL REFERENCES site_groups(id) ON DELETE CASCADE,
  site_id BIGINT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  PRIMARY KEY (group_id, site_id)
);

CREATE TABLE IF NOT EXISTS sso_tickets (
  id BIGSERIAL PRIMARY KEY,
  ticket_hash TEXT NOT NULL UNIQUE,
  site_id BIGINT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  admin_id BIGINT NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  redeemed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sso_tickets_expiry ON sso_tickets(expires_at);

CREATE TABLE IF NOT EXISTS nodes (
  id BIGSERIAL PRIMARY KEY,
  speed_name TEXT NOT NULL,
  partner_name TEXT NOT NULL,
  url TEXT NOT NULL UNIQUE,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  scope_mode TEXT NOT NULL DEFAULT 'global' CHECK (scope_mode IN ('global', 'selected')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS node_site_targets (
  node_id BIGINT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  site_id BIGINT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  PRIMARY KEY (node_id, site_id)
);

CREATE TABLE IF NOT EXISTS node_group_targets (
  node_id BIGINT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  group_id BIGINT NOT NULL REFERENCES site_groups(id) ON DELETE CASCADE,
  PRIMARY KEY (node_id, group_id)
);

CREATE TABLE IF NOT EXISTS ads (
  id BIGSERIAL PRIMARY KEY,
  namespace TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  ad_type TEXT NOT NULL CHECK (ad_type IN ('normal', 'code')),
  ad_position TEXT NOT NULL CHECK (ad_position IN ('banner', 'icon', 'top_float', 'bottom_float', 'icon_float')),
  platform TEXT NOT NULL DEFAULT 'all' CHECK (platform IN ('all', 'pc', 'ios', 'non_ios', 'android', 'harmony')),
  ad_code TEXT NOT NULL DEFAULT '',
  image_url TEXT NOT NULL DEFAULT '',
  target_url TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  priority INTEGER NOT NULL DEFAULT 0,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  scope_mode TEXT NOT NULL DEFAULT 'global' CHECK (scope_mode IN ('global', 'selected')),
  integrity_sha256 TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ad_site_targets (
  ad_id BIGINT NOT NULL REFERENCES ads(id) ON DELETE CASCADE,
  site_id BIGINT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  PRIMARY KEY (ad_id, site_id)
);

CREATE TABLE IF NOT EXISTS ad_group_targets (
  ad_id BIGINT NOT NULL REFERENCES ads(id) ON DELETE CASCADE,
  group_id BIGINT NOT NULL REFERENCES site_groups(id) ON DELETE CASCADE,
  PRIMARY KEY (ad_id, group_id)
);

CREATE TABLE IF NOT EXISTS ad_slot_policies (
  site_id BIGINT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  slot TEXT NOT NULL CHECK (slot IN ('banner', 'icon', 'top_float', 'bottom_float', 'icon_float')),
  policy TEXT NOT NULL DEFAULT 'central_first' CHECK (policy IN ('central_only', 'central_first', 'mixed', 'local_only')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (site_id, slot)
);

CREATE TABLE IF NOT EXISTS publish_pages (
  site_id BIGINT PRIMARY KEY REFERENCES sites(id) ON DELETE CASCADE,
  permanent_url TEXT NOT NULL DEFAULT '',
  github_pages_url TEXT NOT NULL DEFAULT '',
  github_repo TEXT NOT NULL DEFAULT '',
  cloudflare_project TEXT NOT NULL DEFAULT '',
  contact_email TEXT NOT NULL DEFAULT '',
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS jobs (
  id BIGSERIAL PRIMARY KEY,
  type TEXT NOT NULL,
  site_id BIGINT REFERENCES sites(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  result JSONB NOT NULL DEFAULT '{}'::jsonb,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  last_error TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_jobs_claim ON jobs(status, available_at, id);

CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGSERIAL PRIMARY KEY,
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL DEFAULT '',
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  ip INET,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_audit_logs_time ON audit_logs(created_at DESC);

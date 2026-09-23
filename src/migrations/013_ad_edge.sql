ALTER TABLE ads
  ADD COLUMN IF NOT EXISTS render_mode TEXT NOT NULL DEFAULT 'direct'
  CHECK (render_mode IN ('direct', 'sandbox'));

ALTER TABLE ads
  ADD COLUMN IF NOT EXISTS sandbox_options JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS ad_edge_profiles (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  hostname TEXT NOT NULL UNIQUE,
  account_id TEXT NOT NULL,
  worker_name TEXT NOT NULL UNIQUE,
  zone_id TEXT NOT NULL DEFAULT '',
  encrypted_api_token JSONB NOT NULL DEFAULT '{}'::jsonb,
  token_hint TEXT NOT NULL DEFAULT '',
  encrypted_backend_secret JSONB NOT NULL DEFAULT '{}'::jsonb,
  secret_fingerprint TEXT NOT NULL DEFAULT '',
  worker_version TEXT NOT NULL DEFAULT '',
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  health_status TEXT NOT NULL DEFAULT 'unknown',
  last_health_at TIMESTAMPTZ,
  last_deployed_at TIMESTAMPTZ,
  last_error TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ad_edge_single_default
  ON ad_edge_profiles(is_default) WHERE is_default=TRUE;

CREATE TABLE IF NOT EXISTS ad_edge_assignments (
  id BIGSERIAL PRIMARY KEY,
  profile_id BIGINT NOT NULL REFERENCES ad_edge_profiles(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL CHECK (target_type IN ('all', 'group', 'site')),
  target_id BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((target_type='all' AND target_id IS NULL) OR (target_type<>'all' AND target_id IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ad_edge_assignment_unique
  ON ad_edge_assignments(profile_id,target_type,COALESCE(target_id,0));

CREATE TABLE IF NOT EXISTS ad_edge_site_status (
  site_id BIGINT PRIMARY KEY REFERENCES sites(id) ON DELETE CASCADE,
  resolved_profile_id BIGINT REFERENCES ad_edge_profiles(id) ON DELETE SET NULL,
  desired_revision BIGINT NOT NULL DEFAULT 0,
  applied_revision BIGINT NOT NULL DEFAULT 0,
  apply_status TEXT NOT NULL DEFAULT 'pending',
  last_applied_at TIMESTAMPTZ,
  last_error TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

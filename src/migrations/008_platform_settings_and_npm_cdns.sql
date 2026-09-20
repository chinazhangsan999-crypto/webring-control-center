CREATE TABLE IF NOT EXISTS platform_settings (
  singleton_key BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton_key = TRUE),
  settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS platform_secrets (
  name TEXT PRIMARY KEY CHECK (name IN ('github_token','cloudflare_token','telegram_token','bark_url')),
  encrypted_value JSONB NOT NULL,
  hint TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE publish_pages
  ADD COLUMN IF NOT EXISTS npm_cdn_mode TEXT NOT NULL DEFAULT 'inherit' CHECK (npm_cdn_mode IN ('inherit','custom')),
  ADD COLUMN IF NOT EXISTS npm_cdn_lines JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS npm_primary_cdn TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS npm_cdn_checks (
  site_id BIGINT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  package_version TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('npmmirror','jsdelivr','unpkg','esm')),
  page_url TEXT NOT NULL,
  stable_url TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('available','syncing','failed','incompatible','disabled','unknown')),
  http_status INTEGER,
  content_type TEXT NOT NULL DEFAULT '',
  manifest_sha256 TEXT NOT NULL DEFAULT '',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT '',
  checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (site_id, package_version, provider)
);
CREATE INDEX IF NOT EXISTS idx_npm_cdn_checks_site_checked ON npm_cdn_checks(site_id, checked_at DESC);

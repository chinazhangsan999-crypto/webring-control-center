CREATE TABLE IF NOT EXISTS site_publish_platforms (
  site_id BIGINT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('cloudflare','github','npm','notion')),
  account_mode TEXT NOT NULL DEFAULT 'disabled' CHECK (account_mode IN ('disabled','global','site')),
  settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  config_version BIGINT NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (site_id, platform)
);

CREATE TABLE IF NOT EXISTS site_publish_secrets (
  site_id BIGINT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('cloudflare','github','notion')),
  secret_name TEXT NOT NULL CHECK (secret_name IN ('cloudflare_token','github_token','notion_token')),
  encrypted_value JSONB NOT NULL,
  hint TEXT NOT NULL DEFAULT '',
  credential_version BIGINT NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (site_id, platform, secret_name)
);

INSERT INTO site_publish_platforms(site_id, platform, account_mode)
SELECT p.site_id, platform,
  CASE
    WHEN platform='github' AND p.github_repo<>'' AND p.github_pages_url<>'' THEN 'global'
    WHEN platform='cloudflare' AND p.cloudflare_project<>'' AND p.permanent_url<>'' THEN 'global'
    WHEN platform='npm' AND p.npm_enabled THEN 'global'
    WHEN platform='notion' AND p.notion_enabled THEN 'global'
    ELSE 'disabled'
  END
FROM publish_pages p
CROSS JOIN (VALUES ('cloudflare'),('github'),('npm'),('notion')) AS platforms(platform)
ON CONFLICT(site_id, platform) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_site_publish_platforms_mode
  ON site_publish_platforms(platform, account_mode);

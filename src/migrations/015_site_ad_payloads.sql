CREATE TABLE IF NOT EXISTS site_ad_payloads (
  id BIGSERIAL PRIMARY KEY,
  site_id BIGINT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  local_ad_id BIGINT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  ad_code TEXT NOT NULL,
  integrity_sha256 TEXT NOT NULL,
  render_mode TEXT NOT NULL CHECK (render_mode IN ('direct','sandbox')),
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(site_id, local_ad_id)
);

CREATE INDEX IF NOT EXISTS idx_site_ad_payloads_render
  ON site_ad_payloads(site_id, local_ad_id, enabled);

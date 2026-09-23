ALTER TABLE site_ad_payloads
  ADD COLUMN IF NOT EXISTS ad_position TEXT NOT NULL DEFAULT 'top_float'
  CHECK (ad_position IN ('top_float','bottom_float','icon_float'));

ALTER TABLE site_ad_payloads
  ADD COLUMN IF NOT EXISTS priority INTEGER NOT NULL DEFAULT 0;

ALTER TABLE site_ad_payloads
  ADD COLUMN IF NOT EXISTS sandbox_options JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_site_ad_payloads_site_position
  ON site_ad_payloads(site_id, ad_position, priority DESC, local_ad_id);

ALTER TABLE site_ad_payloads
  ADD COLUMN IF NOT EXISTS ad_type TEXT NOT NULL DEFAULT 'code'
  CHECK (ad_type IN ('normal','code'));

ALTER TABLE site_ad_payloads
  ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT '';

ALTER TABLE site_ad_payloads
  ADD COLUMN IF NOT EXISTS platform TEXT NOT NULL DEFAULT 'all'
  CHECK (platform IN ('all','pc','ios','non_ios','android','harmony'));

ALTER TABLE site_ad_payloads
  ADD COLUMN IF NOT EXISTS image_url TEXT NOT NULL DEFAULT '';

ALTER TABLE site_ad_payloads
  ADD COLUMN IF NOT EXISTS target_url TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_site_ad_payloads_site_type_position
  ON site_ad_payloads(site_id, ad_type, ad_position, priority DESC, local_ad_id);

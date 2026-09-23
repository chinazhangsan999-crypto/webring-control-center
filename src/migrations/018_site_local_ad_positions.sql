ALTER TABLE site_ad_payloads
  DROP CONSTRAINT IF EXISTS site_ad_payloads_ad_position_check;

ALTER TABLE site_ad_payloads
  ADD CONSTRAINT site_ad_payloads_ad_position_check
  CHECK (ad_position IN ('banner','icon','top_float','bottom_float','icon_float'));

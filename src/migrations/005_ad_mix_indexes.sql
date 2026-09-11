CREATE INDEX IF NOT EXISTS idx_ads_delivery_order
  ON ads(enabled, ad_position, priority DESC, id ASC);

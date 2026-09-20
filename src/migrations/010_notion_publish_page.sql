ALTER TABLE platform_secrets
  DROP CONSTRAINT IF EXISTS platform_secrets_name_check;

ALTER TABLE platform_secrets
  ADD CONSTRAINT platform_secrets_name_check
  CHECK (name IN ('github_token','cloudflare_token','notion_token','telegram_token','bark_url'));

ALTER TABLE publish_pages
  ADD COLUMN IF NOT EXISTS notion_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS notion_sync_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS notion_page_id TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS notion_public_url TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS notion_sync_block_id TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS notion_last_synced_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS notion_last_error TEXT NOT NULL DEFAULT '';

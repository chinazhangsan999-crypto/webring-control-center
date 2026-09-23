ALTER TABLE publish_pages
  ADD COLUMN IF NOT EXISTS publish_link_weights JSONB NOT NULL DEFAULT '{}'::jsonb;

UPDATE site_revisions
SET publish_revision = publish_revision + 1,
    updated_at = NOW();

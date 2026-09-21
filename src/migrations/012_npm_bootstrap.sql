ALTER TABLE publish_pages
  ADD COLUMN IF NOT EXISTS npm_bootstrap_status TEXT NOT NULL DEFAULT 'not_started',
  ADD COLUMN IF NOT EXISTS npm_bootstrap_version TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS npm_bootstrap_published_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS npm_oidc_verified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS npm_bootstrap_last_error TEXT NOT NULL DEFAULT '';

DO $$
BEGIN
  ALTER TABLE publish_pages ADD CONSTRAINT publish_pages_npm_bootstrap_status_check
    CHECK (npm_bootstrap_status IN ('not_started','published','oidc_verified'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

WITH completed AS (
  SELECT DISTINCT ON (j.site_id) j.site_id,j.finished_at
  FROM jobs j
  WHERE j.type='publish.deploy'
    AND j.status='succeeded'
    AND j.result->'platforms'->'npm'->>'status'='succeeded'
  ORDER BY j.site_id,j.id DESC
)
UPDATE publish_pages p
SET npm_bootstrap_status='oidc_verified',
    npm_oidc_verified_at=COALESCE(p.npm_oidc_verified_at, completed.finished_at),
    npm_bootstrap_last_error=''
FROM completed
WHERE p.npm_enabled=TRUE
  AND p.npm_bootstrap_status='not_started'
  AND completed.site_id=p.site_id;

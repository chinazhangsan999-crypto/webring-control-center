ALTER TABLE publish_pages
  DROP CONSTRAINT IF EXISTS publish_pages_npm_bootstrap_status_check;

UPDATE publish_pages
SET npm_bootstrap_status='oidc_pending'
WHERE npm_bootstrap_status='published';

ALTER TABLE publish_pages
  ADD CONSTRAINT publish_pages_npm_bootstrap_status_check
  CHECK (npm_bootstrap_status IN ('not_started','published','oidc_pending','oidc_verifying','oidc_verified'));

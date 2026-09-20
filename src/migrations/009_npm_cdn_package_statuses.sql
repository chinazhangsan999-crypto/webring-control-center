ALTER TABLE npm_cdn_checks
  DROP CONSTRAINT IF EXISTS npm_cdn_checks_status_check;

ALTER TABLE npm_cdn_checks
  ADD CONSTRAINT npm_cdn_checks_status_check
  CHECK (status IN (
    'available',
    'syncing',
    'failed',
    'incompatible',
    'disabled',
    'unknown',
    'package_available',
    'package_mirror'
  ));

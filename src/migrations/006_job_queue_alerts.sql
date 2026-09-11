ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS priority INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS progress_current INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS progress_total INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS heartbeat_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS error_code TEXT NOT NULL DEFAULT '';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'jobs_progress_valid') THEN
    ALTER TABLE jobs ADD CONSTRAINT jobs_progress_valid CHECK (
      progress_current >= 0 AND progress_total >= 1 AND progress_current <= progress_total
    );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_jobs_claim_priority
  ON jobs(status, priority DESC, available_at, id);

CREATE INDEX IF NOT EXISTS idx_jobs_type_created
  ON jobs(type, created_at DESC);

ALTER TABLE backup_logs
  ADD COLUMN independent_storage_uri text,
  ADD COLUMN restore_duration_ms bigint,
  ADD COLUMN failure_code varchar,
  ADD COLUMN retained boolean NOT NULL DEFAULT true,
  ADD COLUMN pinned boolean NOT NULL DEFAULT false;

CREATE INDEX backup_logs_verified_retained_idx
  ON backup_logs(verified_at DESC)
  WHERE status = 'VERIFIED' AND retained;
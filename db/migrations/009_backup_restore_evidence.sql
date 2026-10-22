ALTER TABLE backup_logs
  ADD COLUMN restore_duration_ms bigint,
  ADD COLUMN cleanup_verified boolean NOT NULL DEFAULT false;

ALTER TABLE backup_logs
  ADD CONSTRAINT backup_logs_restore_duration_nonnegative
  CHECK (restore_duration_ms IS NULL OR restore_duration_ms >= 0);

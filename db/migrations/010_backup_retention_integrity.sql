ALTER TABLE backup_logs
  ADD COLUMN retained boolean NOT NULL DEFAULT false;

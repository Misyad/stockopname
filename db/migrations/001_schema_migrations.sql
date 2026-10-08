CREATE TABLE schema_migrations (
  version bigint PRIMARY KEY CHECK (version > 0),
  name text NOT NULL UNIQUE,
  checksum char(64) NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
  applied_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE import_batches
  ADD COLUMN confirmation_key varchar,
  ADD COLUMN confirmation_hash varchar,
  ADD COLUMN confirmed_by uuid REFERENCES users(id),
  ADD CONSTRAINT import_batches_confirmation_identity_check CHECK (
    (confirmation_key IS NULL AND confirmation_hash IS NULL AND confirmed_by IS NULL)
    OR (confirmation_key IS NOT NULL AND confirmation_hash IS NOT NULL AND confirmed_by IS NOT NULL)
  );

ALTER TABLE import_batches
  ADD CONSTRAINT import_batches_confirmation_key_key UNIQUE (confirmation_key);

CREATE TABLE regions (
  id uuid PRIMARY KEY,
  code varchar UNIQUE NOT NULL,
  name varchar NOT NULL,
  status varchar CHECK (status IN ('ACTIVE', 'INACTIVE')),
  created_at timestamptz,
  updated_at timestamptz
);

INSERT INTO regions (id, code, name, status, created_at, updated_at)
VALUES ('00000000-0000-0000-0000-000000000001', 'DEFAULT', 'Default Region', 'ACTIVE', now(), now());

ALTER TABLE users
  ADD COLUMN region_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001'
  REFERENCES regions(id);

ALTER TABLE warehouses
  ADD COLUMN region_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001'
  REFERENCES regions(id);

ALTER TABLE stock_transactions
  ADD COLUMN transaction_date date NOT NULL DEFAULT CURRENT_DATE,
  ADD COLUMN request_hash varchar NOT NULL DEFAULT '';

CREATE INDEX users_region_idx ON users(region_id);
CREATE INDEX warehouses_region_idx ON warehouses(region_id);
CREATE INDEX stock_transactions_warehouse_created_idx
  ON stock_transactions(warehouse_id, created_at);

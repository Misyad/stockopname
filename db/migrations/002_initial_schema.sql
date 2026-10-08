CREATE TABLE users (
  id uuid PRIMARY KEY,
  name varchar NOT NULL,
  email varchar UNIQUE NOT NULL,
  password_hash varchar NOT NULL,
  role varchar CHECK (role IN ('ADMIN', 'SUPERVISOR', 'PETUGAS')),
  status varchar CHECK (status IN ('ACTIVE', 'INACTIVE')),
  created_at timestamptz,
  updated_at timestamptz
);

CREATE TABLE auth_sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  reference varchar UNIQUE NOT NULL,
  secret_hash varchar UNIQUE NOT NULL,
  csrf_secret_hash varchar NOT NULL,
  expires_at timestamptz NOT NULL,
  last_seen_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL
);

CREATE TABLE categories (
  id uuid PRIMARY KEY,
  code varchar UNIQUE NOT NULL,
  name varchar NOT NULL,
  status varchar CHECK (status IN ('ACTIVE', 'INACTIVE', 'REVIEW')),
  created_at timestamptz,
  updated_at timestamptz
);

CREATE TABLE units (
  id uuid PRIMARY KEY,
  code varchar UNIQUE NOT NULL,
  name varchar NOT NULL,
  symbol varchar NOT NULL,
  base_unit_id uuid REFERENCES units(id),
  conversion_to_base numeric NOT NULL CHECK (conversion_to_base > 0),
  status varchar CHECK (status IN ('ACTIVE', 'INACTIVE')),
  created_at timestamptz,
  updated_at timestamptz
);

CREATE TABLE unit_aliases (
  id uuid PRIMARY KEY,
  alias varchar UNIQUE NOT NULL,
  unit_id uuid NOT NULL REFERENCES units(id),
  status varchar CHECK (status IN ('ACTIVE', 'INACTIVE')),
  created_at timestamptz,
  updated_at timestamptz
);

CREATE TABLE products (
  id uuid PRIMARY KEY,
  code varchar UNIQUE NOT NULL,
  barcode varchar UNIQUE,
  name varchar NOT NULL,
  category_id uuid NOT NULL REFERENCES categories(id),
  base_unit_id uuid NOT NULL REFERENCES units(id),
  purchase_unit_id uuid REFERENCES units(id),
  conversion_factor numeric NOT NULL CHECK (conversion_factor > 0),
  minimum_stock numeric NOT NULL DEFAULT 0 CHECK (minimum_stock >= 0),
  maximum_stock numeric NOT NULL DEFAULT 0 CHECK (maximum_stock >= 0),
  photo_url text,
  status varchar CHECK (status IN ('ACTIVE', 'INACTIVE', 'REVIEW')),
  created_at timestamptz,
  updated_at timestamptz
);

CREATE TABLE warehouses (
  id uuid PRIMARY KEY,
  code varchar UNIQUE NOT NULL,
  name varchar NOT NULL,
  location text,
  status varchar CHECK (status IN ('ACTIVE', 'INACTIVE')),
  created_at timestamptz,
  updated_at timestamptz
);

CREATE TABLE suppliers (
  id uuid PRIMARY KEY,
  code varchar UNIQUE NOT NULL,
  name varchar NOT NULL,
  phone varchar,
  address text,
  status varchar CHECK (status IN ('ACTIVE', 'INACTIVE')),
  created_at timestamptz,
  updated_at timestamptz
);

CREATE TABLE stock_batches (
  id uuid PRIMARY KEY,
  product_id uuid NOT NULL REFERENCES products(id),
  warehouse_id uuid NOT NULL REFERENCES warehouses(id),
  batch_number varchar,
  production_date date,
  expiry_date date,
  quantity numeric NOT NULL CHECK (quantity >= 0),
  unit varchar NOT NULL,
  purchase_price numeric NOT NULL DEFAULT 0 CHECK (purchase_price >= 0),
  status varchar CHECK (status IN ('ACTIVE', 'DEPLETED', 'INACTIVE')),
  created_at timestamptz,
  updated_at timestamptz
);

CREATE UNIQUE INDEX stock_batches_named_unique
  ON stock_batches(product_id, warehouse_id, batch_number)
  WHERE batch_number IS NOT NULL;
CREATE UNIQUE INDEX stock_batches_unbatched_unique
  ON stock_batches(product_id, warehouse_id)
  WHERE batch_number IS NULL;

CREATE TABLE stock_balances (
  id uuid PRIMARY KEY,
  product_id uuid NOT NULL REFERENCES products(id),
  warehouse_id uuid NOT NULL REFERENCES warehouses(id),
  quantity numeric NOT NULL CHECK (quantity >= 0),
  version bigint NOT NULL DEFAULT 0,
  updated_at timestamptz,
  UNIQUE (product_id, warehouse_id)
);

CREATE TABLE stock_transactions (
  id uuid PRIMARY KEY,
  idempotency_key varchar UNIQUE NOT NULL,
  transaction_number varchar NOT NULL,
  transaction_type varchar CHECK (transaction_type IN ('IN', 'OUT', 'OPENING', 'ADJUSTMENT', 'REVERSAL')),
  reference_id varchar NOT NULL,
  product_id uuid NOT NULL REFERENCES products(id),
  warehouse_id uuid NOT NULL REFERENCES warehouses(id),
  batch_id uuid REFERENCES stock_batches(id),
  supplier_id uuid REFERENCES suppliers(id),
  quantity numeric NOT NULL CHECK (quantity <> 0),
  unit varchar NOT NULL,
  balance_before numeric NOT NULL,
  balance_after numeric NOT NULL CHECK (balance_after >= 0),
  reason text,
  user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL
);

CREATE TABLE stock_opnames (
  id uuid PRIMARY KEY,
  opname_number varchar UNIQUE NOT NULL,
  warehouse_id uuid NOT NULL REFERENCES warehouses(id),
  opname_date date NOT NULL,
  status varchar CHECK (status IN ('DRAFT', 'COUNTING', 'SUBMITTED', 'APPROVED', 'REJECTED')),
  snapshot_at timestamptz NOT NULL,
  snapshot_version bigint NOT NULL,
  created_by uuid NOT NULL REFERENCES users(id),
  submitted_at timestamptz,
  approved_by uuid REFERENCES users(id),
  approved_at timestamptz,
  rejection_reason text,
  notes text,
  created_at timestamptz,
  updated_at timestamptz
);

CREATE TABLE stock_opname_items (
  id uuid PRIMARY KEY,
  opname_id uuid NOT NULL REFERENCES stock_opnames(id),
  product_id uuid NOT NULL REFERENCES products(id),
  batch_id uuid REFERENCES stock_batches(id),
  system_quantity numeric NOT NULL CHECK (system_quantity >= 0),
  physical_quantity numeric CHECK (physical_quantity >= 0),
  difference numeric,
  difference_value numeric,
  unit varchar NOT NULL,
  unit_price numeric NOT NULL DEFAULT 0,
  reason text,
  notes text
);

CREATE TABLE import_batches (
  id uuid PRIMARY KEY,
  import_type varchar CHECK (import_type IN ('PRODUCTS', 'STOCKIN', 'STAGING_OCR')),
  file_name varchar NOT NULL,
  file_hash varchar NOT NULL,
  preview_version bigint NOT NULL DEFAULT 1,
  status varchar CHECK (status IN ('PREVIEW', 'READY', 'IMPORTED', 'REVIEW', 'REJECTED')),
  row_count integer NOT NULL DEFAULT 0 CHECK (row_count >= 0),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL,
  confirmed_at timestamptz,
  UNIQUE (file_hash, import_type)
);

CREATE TABLE staging_ocr_lines (
  id uuid PRIMARY KEY,
  import_batch_id uuid NOT NULL REFERENCES import_batches(id),
  file_hash varchar NOT NULL,
  source_pdf varchar,
  page integer,
  category varchar,
  description_raw text,
  quantity numeric,
  unit_raw varchar,
  unit_price numeric,
  line_total numeric,
  review_status varchar CHECK (review_status IN ('REVIEW', 'READY', 'REJECTED')),
  notes text,
  created_by uuid REFERENCES users(id),
  created_at timestamptz
);

CREATE TABLE ready_import_rows (
  id uuid PRIMARY KEY,
  import_batch_id uuid NOT NULL REFERENCES import_batches(id),
  row_number integer NOT NULL,
  file_hash varchar NOT NULL,
  date date,
  reference varchar,
  supplier varchar,
  warehouse varchar,
  code varchar,
  batch varchar,
  production_date date,
  expiry date,
  quantity numeric,
  unit varchar,
  price numeric,
  notes text,
  status varchar CHECK (status IN ('PREVIEW', 'READY', 'IMPORTED', 'REVIEW', 'REJECTED')),
  error_code varchar,
  error_message text,
  created_at timestamptz,
  UNIQUE (file_hash, row_number)
);

CREATE TABLE audit_logs (
  id uuid PRIMARY KEY,
  timestamp timestamptz NOT NULL,
  user_id uuid REFERENCES users(id),
  action varchar NOT NULL,
  module varchar NOT NULL,
  reference varchar,
  details jsonb NOT NULL DEFAULT '{}'
);

CREATE TABLE backup_logs (
  id uuid PRIMARY KEY,
  backup_type varchar NOT NULL,
  file_name varchar NOT NULL,
  storage_uri text NOT NULL,
  size_bytes bigint,
  checksum varchar,
  status varchar CHECK (status IN ('STARTED', 'COMPLETED', 'FAILED', 'VERIFIED')),
  created_by uuid REFERENCES users(id),
  created_at timestamptz,
  verified_at timestamptz
);

CREATE INDEX auth_sessions_user_expiry_idx
  ON auth_sessions(user_id, expires_at);
CREATE INDEX stock_batches_product_warehouse_expiry_idx
  ON stock_batches(product_id, warehouse_id, expiry_date);
CREATE INDEX stock_transactions_product_warehouse_created_idx
  ON stock_transactions(product_id, warehouse_id, created_at);
CREATE INDEX stock_transactions_reference_idx
  ON stock_transactions(reference_id);
CREATE INDEX stock_transactions_created_idx
  ON stock_transactions(created_at);
CREATE INDEX stock_opnames_warehouse_status_idx
  ON stock_opnames(warehouse_id, status);
CREATE INDEX stock_opname_items_opname_idx
  ON stock_opname_items(opname_id);
CREATE INDEX staging_ocr_lines_batch_review_idx
  ON staging_ocr_lines(import_batch_id, review_status);
CREATE INDEX ready_import_rows_batch_status_idx
  ON ready_import_rows(import_batch_id, status);
CREATE INDEX audit_logs_timestamp_idx
  ON audit_logs(timestamp);
CREATE INDEX audit_logs_module_action_idx
  ON audit_logs(module, action);

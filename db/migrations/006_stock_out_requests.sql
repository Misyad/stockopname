CREATE TABLE stock_out_requests (
  id uuid PRIMARY KEY,
  idempotency_key varchar UNIQUE NOT NULL,
  request_hash varchar NOT NULL,
  transaction_number varchar UNIQUE NOT NULL,
  transaction_date date NOT NULL,
  reference_id varchar NOT NULL,
  product_id uuid NOT NULL REFERENCES products(id),
  warehouse_id uuid NOT NULL REFERENCES warehouses(id),
  quantity numeric NOT NULL CHECK (quantity > 0),
  unit varchar NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL
);

ALTER TABLE stock_transactions
  ADD COLUMN stock_out_request_id uuid REFERENCES stock_out_requests(id),
  ADD COLUMN allocation_index integer,
  ADD COLUMN unit_price numeric;

ALTER TABLE stock_transactions
  ADD CONSTRAINT stock_transactions_out_allocation_check CHECK (
    (
      stock_out_request_id IS NULL
      AND allocation_index IS NULL
      AND unit_price IS NULL
    ) OR (
      stock_out_request_id IS NOT NULL
      AND allocation_index > 0
      AND unit_price IS NOT NULL
      AND unit_price >= 0
      AND transaction_type = 'OUT'
      AND batch_id IS NOT NULL
      AND quantity < 0
    )
  );

CREATE UNIQUE INDEX stock_transactions_out_allocation_unique
  ON stock_transactions(stock_out_request_id, allocation_index)
  WHERE stock_out_request_id IS NOT NULL;

CREATE INDEX stock_batches_fefo_active_idx
  ON stock_batches(product_id, warehouse_id, expiry_date, production_date, created_at, id)
  WHERE status = 'ACTIVE' AND quantity > 0;

CREATE FUNCTION reject_stock_out_request_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'stock_out_requests is immutable' USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER stock_out_requests_immutable_rows
BEFORE UPDATE OR DELETE ON stock_out_requests
FOR EACH ROW
EXECUTE FUNCTION reject_stock_out_request_mutation();

CREATE TRIGGER stock_out_requests_immutable_truncate
BEFORE TRUNCATE ON stock_out_requests
FOR EACH STATEMENT
EXECUTE FUNCTION reject_stock_out_request_mutation();

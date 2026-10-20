CREATE INDEX stock_transactions_warehouse_date_sequence_idx
  ON stock_transactions(warehouse_id, transaction_date DESC, ledger_sequence DESC);

CREATE INDEX stock_transactions_product_warehouse_date_sequence_idx
  ON stock_transactions(product_id, warehouse_id, transaction_date, ledger_sequence);

CREATE INDEX stock_transactions_supplier_date_sequence_idx
  ON stock_transactions(supplier_id, transaction_date DESC, ledger_sequence DESC)
  WHERE supplier_id IS NOT NULL;

CREATE INDEX stock_transactions_date_sequence_idx
  ON stock_transactions(transaction_date DESC, ledger_sequence DESC);

CREATE INDEX stock_transactions_product_date_sequence_idx
  ON stock_transactions(product_id, transaction_date, ledger_sequence);

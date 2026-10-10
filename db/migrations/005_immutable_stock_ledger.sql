CREATE FUNCTION reject_stock_transaction_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'stock_transactions is immutable' USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER stock_transactions_immutable_rows
BEFORE UPDATE OR DELETE ON stock_transactions
FOR EACH ROW
EXECUTE FUNCTION reject_stock_transaction_mutation();

CREATE TRIGGER stock_transactions_immutable_truncate
BEFORE TRUNCATE ON stock_transactions
FOR EACH STATEMENT
EXECUTE FUNCTION reject_stock_transaction_mutation();

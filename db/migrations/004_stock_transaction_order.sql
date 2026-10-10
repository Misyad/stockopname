CREATE SEQUENCE stock_transactions_ledger_sequence_seq;

ALTER TABLE stock_transactions
  ADD COLUMN ledger_sequence bigint;

CREATE TEMP TABLE stock_ledger_complete_paths AS
WITH RECURSIVE
ledger_counts AS (
  SELECT product_id, warehouse_id, count(*)::int AS row_count
  FROM stock_transactions
  GROUP BY product_id, warehouse_id
),
ledger_paths AS (
  SELECT
    entry.id,
    entry.product_id,
    entry.warehouse_id,
    entry.balance_after,
    ARRAY[entry.id] AS path,
    1 AS depth
  FROM stock_transactions entry
  WHERE entry.balance_before = 0
    AND entry.balance_after = entry.balance_before + entry.quantity

  UNION ALL

  SELECT
    successor.id,
    successor.product_id,
    successor.warehouse_id,
    successor.balance_after,
    path.path || successor.id,
    path.depth + 1
  FROM ledger_paths path
  JOIN ledger_counts counts
    ON counts.product_id = path.product_id
   AND counts.warehouse_id = path.warehouse_id
  JOIN stock_transactions successor
    ON successor.product_id = path.product_id
   AND successor.warehouse_id = path.warehouse_id
   AND successor.balance_before = path.balance_after
   AND successor.balance_after = successor.balance_before + successor.quantity
   AND successor.id <> ALL(path.path)
  WHERE path.depth < counts.row_count
)
SELECT path.product_id, path.warehouse_id, path.path
FROM ledger_paths path
JOIN ledger_counts counts
  ON counts.product_id = path.product_id
 AND counts.warehouse_id = path.warehouse_id
 AND counts.row_count = path.depth;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM (
      SELECT product_id, warehouse_id
      FROM stock_transactions
      GROUP BY product_id, warehouse_id
    ) ledger
    LEFT JOIN (
      SELECT product_id, warehouse_id, count(*) AS path_count
      FROM stock_ledger_complete_paths
      GROUP BY product_id, warehouse_id
    ) paths USING (product_id, warehouse_id)
    WHERE coalesce(paths.path_count, 0) <> 1
  ) THEN
    RAISE EXCEPTION 'Cannot establish stock ledger order from balance chain';
  END IF;
END
$$;

WITH path_rows AS (
  SELECT
    complete.product_id,
    complete.warehouse_id,
    row.id,
    row.position
  FROM stock_ledger_complete_paths complete
  CROSS JOIN LATERAL unnest(complete.path) WITH ORDINALITY AS row(id, position)
),
ordered AS (
  SELECT id, row_number() OVER (
    ORDER BY product_id, warehouse_id, position
  ) AS ledger_sequence
  FROM path_rows
)
UPDATE stock_transactions transaction
SET ledger_sequence = ordered.ledger_sequence
FROM ordered
WHERE transaction.id = ordered.id;

SELECT setval(
  'stock_transactions_ledger_sequence_seq',
  coalesce(max(ledger_sequence), 1),
  max(ledger_sequence) IS NOT NULL
)
FROM stock_transactions;

ALTER SEQUENCE stock_transactions_ledger_sequence_seq
  OWNED BY stock_transactions.ledger_sequence;

ALTER TABLE stock_transactions
  ALTER COLUMN ledger_sequence SET DEFAULT nextval('stock_transactions_ledger_sequence_seq'),
  ALTER COLUMN ledger_sequence SET NOT NULL;

CREATE UNIQUE INDEX stock_transactions_ledger_sequence_unique
  ON stock_transactions(ledger_sequence);

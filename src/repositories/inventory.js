export async function lockIdempotency(client, key) {
  await client.query(
    'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
    [`idempotency:${key}`],
  );
}

export async function findTransactionByIdempotency(client, key) {
  const result = await client.query(
    "SELECT stock_transactions.*, to_char(transaction_date, 'YYYY-MM-DD') AS transaction_date_text FROM stock_transactions WHERE idempotency_key = $1",
    [key],
  );
  return result.rows[0] || null;
}

export async function findStockOutByIdempotency(client, key) {
  const request = (await client.query(`
    SELECT stock_out_requests.*,
      to_char(transaction_date, 'YYYY-MM-DD') AS transaction_date_text
    FROM stock_out_requests
    WHERE idempotency_key = $1
  `, [key])).rows[0];
  if (!request) return null;
  const allocations = (await client.query(`
    SELECT id AS transaction_id, batch_id, trim_scale(-quantity)::text AS quantity,
      trim_scale(balance_before)::text AS balance_before,
      trim_scale(balance_after)::text AS balance_after
    FROM stock_transactions
    WHERE stock_out_request_id = $1
    ORDER BY allocation_index
  `, [request.id])).rows;
  return {
    ...request,
    transaction_type: 'OUT',
    balance_before: allocations[0]?.balance_before,
    balance_after: allocations.at(-1)?.balance_after,
    allocations,
  };
}

export async function lockStock(client, productId, warehouseId) {
  await client.query(
    'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
    [`stock:${productId}:${warehouseId}`],
  );
}

export async function lockWarehouseStock(client, warehouseId) {
  await client.query(
    'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
    [`warehouse-stock:${warehouseId}`],
  );
}

export async function hasStockLedger(client, productId, warehouseId) {
  const result = await client.query(
    'SELECT 1 FROM stock_transactions WHERE product_id = $1 AND warehouse_id = $2 LIMIT 1',
    [productId, warehouseId],
  );
  return result.rowCount > 0;
}

export async function insertStockTransaction(client, transaction) {
  const result = await client.query(`
    INSERT INTO stock_transactions (
      id, idempotency_key, transaction_number, transaction_type, transaction_date,
      request_hash, reference_id, product_id, warehouse_id, batch_id, supplier_id,
      quantity, unit, balance_before, balance_after, reason, user_id, created_at,
      stock_out_request_id, allocation_index, unit_price
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
      $12, $13, $14, $15, $16, $17, now(), $18, $19, $20
    )
    RETURNING *, to_char(transaction_date, 'YYYY-MM-DD') AS transaction_date_text
  `, [
    transaction.id, transaction.idempotencyKey, transaction.transactionNumber,
    transaction.transactionType, transaction.transactionDate, transaction.requestHash,
    transaction.referenceId, transaction.productId, transaction.warehouseId,
    transaction.batchId, transaction.supplierId ?? null, transaction.quantity,
    transaction.unit, transaction.balanceBefore, transaction.balanceAfter,
    transaction.reason ?? null, transaction.userId, transaction.stockOutRequestId ?? null,
    transaction.allocationIndex ?? null, transaction.unitPrice ?? null,
  ]);
  return result.rows[0];
}

export async function insertStockOutRequest(client, request) {
  const result = await client.query(`
    INSERT INTO stock_out_requests (
      id, idempotency_key, request_hash, transaction_number, transaction_date,
      reference_id, product_id, warehouse_id, quantity, unit, user_id, created_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now())
    RETURNING *, to_char(transaction_date, 'YYYY-MM-DD') AS transaction_date_text
  `, [
    request.id, request.idempotencyKey, request.requestHash, request.transactionNumber,
    request.transactionDate, request.referenceId, request.productId, request.warehouseId,
    request.quantity, request.unit, request.userId,
  ]);
  return result.rows[0];
}

export async function insertStockBatch(client, batch) {
  await client.query(`
    INSERT INTO stock_batches (
      id, product_id, warehouse_id, batch_number, production_date, expiry_date,
      quantity, unit, purchase_price, status, created_at, updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'ACTIVE', now(), now())
  `, [
    batch.id, batch.productId, batch.warehouseId, batch.batchNumber,
    batch.productionDate, batch.expiryDate, batch.quantity, batch.unit, batch.purchasePrice,
  ]);
}

export async function insertStockBalance(client, balance) {
  await client.query(`
    INSERT INTO stock_balances (id, product_id, warehouse_id, quantity, version, updated_at)
    VALUES ($1, $2, $3, $4, 1, now())
  `, [balance.id, balance.productId, balance.warehouseId, balance.quantity]);
}

export async function findStockBatchForUpdate(client, productId, warehouseId, batchNumber) {
  const result = await client.query(`
    SELECT stock_batches.*,
      to_char(production_date, 'YYYY-MM-DD') AS production_date_text,
      to_char(expiry_date, 'YYYY-MM-DD') AS expiry_date_text
    FROM stock_batches
    WHERE product_id = $1 AND warehouse_id = $2
      AND batch_number IS NOT DISTINCT FROM $3
    FOR UPDATE
  `, [productId, warehouseId, batchNumber]);
  return result.rows[0] || null;
}

export async function findStockBalanceForUpdate(client, productId, warehouseId) {
  const result = await client.query(`
    SELECT * FROM stock_balances
    WHERE product_id = $1 AND warehouse_id = $2
    FOR UPDATE
  `, [productId, warehouseId]);
  return result.rows[0] || null;
}

export async function findFefoBatchesForUpdate(client, productId, warehouseId, transactionDate) {
  const result = await client.query(`
    SELECT * FROM stock_batches
    WHERE product_id = $1 AND warehouse_id = $2
      AND status = 'ACTIVE' AND quantity > 0
      AND (expiry_date IS NULL OR expiry_date >= $3::date)
    ORDER BY expiry_date ASC NULLS LAST, production_date ASC NULLS LAST, created_at ASC, id ASC
    FOR UPDATE
  `, [productId, warehouseId, transactionDate]);
  return result.rows;
}

export async function planFefoAllocations(client, batchIds, requestedQuantity, balanceBefore) {
  if (!batchIds.length) return [];
  const result = await client.query(`
    WITH ordered AS (
      SELECT batches.*, input.ordinality,
        coalesce(sum(batches.quantity) OVER (
          ORDER BY input.ordinality ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
        ), 0) AS prior_quantity
      FROM unnest($1::uuid[]) WITH ORDINALITY AS input(id, ordinality)
      JOIN stock_batches batches ON batches.id = input.id
    ), planned AS (
      SELECT *, least(quantity, greatest($2::numeric - prior_quantity, 0)) AS allocation
      FROM ordered
    )
    SELECT id AS batch_id, trim_scale(allocation)::text AS quantity,
      trim_scale(purchase_price)::text AS unit_price,
      trim_scale($3::numeric - prior_quantity)::text AS balance_before,
      trim_scale($3::numeric - prior_quantity - allocation)::text AS balance_after,
      trim_scale(sum(allocation) OVER ())::text AS allocated_total
    FROM planned
    WHERE allocation > 0
    ORDER BY ordinality
  `, [batchIds, requestedQuantity, balanceBefore]);
  return result.rows;
}

export async function decrementStockBatch(client, id, quantity) {
  const result = await client.query(`
    UPDATE stock_batches
    SET quantity = quantity - $2::numeric,
        status = CASE WHEN quantity - $2::numeric = 0 THEN 'DEPLETED' ELSE 'ACTIVE' END,
        updated_at = now()
    WHERE id = $1 AND status = 'ACTIVE' AND quantity >= $2::numeric
    RETURNING *
  `, [id, quantity]);
  return result.rows[0] || null;
}

export async function decrementStockBalance(client, id, quantity) {
  const result = await client.query(`
    UPDATE stock_balances
    SET quantity = quantity - $2::numeric, version = version + 1, updated_at = now()
    WHERE id = $1 AND quantity >= $2::numeric
    RETURNING *
  `, [id, quantity]);
  return result.rows[0] || null;
}

export async function incrementStockBatch(client, id, quantity, purchasePrice) {
  const result = await client.query(`
    UPDATE stock_batches
    SET purchase_price = (quantity * purchase_price + $2::numeric * $3::numeric)
          / (quantity + $2::numeric),
        quantity = quantity + $2::numeric,
        status = 'ACTIVE',
        updated_at = now()
    WHERE id = $1
    RETURNING *
  `, [id, quantity, purchasePrice]);
  return result.rows[0];
}

export async function incrementStockBalance(client, id, quantity) {
  const result = await client.query(`
    UPDATE stock_balances
    SET quantity = quantity + $2::numeric, version = version + 1, updated_at = now()
    WHERE id = $1
    RETURNING *
  `, [id, quantity]);
  return result.rows[0];
}

export async function insertInventoryAudit(client, audit) {
  await client.query(`
    INSERT INTO audit_logs (id, timestamp, user_id, action, module, reference, details)
    VALUES ($1, now(), $2, $3, 'INVENTORY', $4, $5::jsonb)
  `, [audit.id, audit.userId, audit.action, audit.reference, JSON.stringify(audit.details)]);
}

export async function readInventoryReconciliation(client, productId, warehouseId) {
  const result = await client.query(`
    WITH ordered_ledger AS (
      SELECT quantity, balance_before, balance_after,
             lag(balance_after) OVER (ORDER BY ledger_sequence) AS previous_balance
      FROM stock_transactions
      WHERE product_id = $1 AND warehouse_id = $2
    ), ledger AS (
      SELECT count(*)::int AS row_count,
             coalesce(sum(quantity), 0) AS quantity,
             coalesce(bool_and(
               balance_after = balance_before + quantity
               AND CASE
                 WHEN previous_balance IS NULL THEN balance_before = 0
                 ELSE balance_before = previous_balance
               END
             ), true) AS chain_valid
      FROM ordered_ledger
    ), batches AS (
      SELECT count(*)::int AS row_count, coalesce(sum(quantity), 0) AS quantity
      FROM stock_batches
      WHERE product_id = $1 AND warehouse_id = $2
    ), balances AS (
      SELECT count(*)::int AS row_count, coalesce(sum(quantity), 0) AS quantity
      FROM stock_balances
      WHERE product_id = $1 AND warehouse_id = $2
    )
    SELECT ledger.row_count AS ledger_count,
           batches.row_count AS batch_count,
           balances.row_count AS balance_count,
           trim_scale(ledger.quantity)::text AS ledger_quantity,
           trim_scale(batches.quantity)::text AS batch_quantity,
           trim_scale(balances.quantity)::text AS balance_quantity,
           ledger.chain_valid AS ledger_chain_valid,
           (ledger.chain_valid
             AND ledger.row_count >= 1
             AND batches.row_count >= 1
             AND balances.row_count = 1
             AND ledger.quantity = batches.quantity
             AND ledger.quantity = balances.quantity) AS reconciled
    FROM ledger, batches, balances
  `, [productId, warehouseId]);
  const row = result.rows[0];
  return {
    ledgerCount: row.ledger_count,
    batchCount: row.batch_count,
    balanceCount: row.balance_count,
    ledgerQuantity: row.ledger_quantity,
    batchQuantity: row.batch_quantity,
    balanceQuantity: row.balance_quantity,
    ledgerChainValid: row.ledger_chain_valid,
    reconciled: row.reconciled,
  };
}

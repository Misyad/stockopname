export async function lockIdempotency(client, key) {
  await client.query(
    'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
    [`idempotency:${key}`],
  );
}

export async function findTransactionByIdempotency(client, key) {
  const result = await client.query(
    'SELECT * FROM stock_transactions WHERE idempotency_key = $1',
    [key],
  );
  return result.rows[0] || null;
}

export async function lockStock(client, productId, warehouseId) {
  await client.query(
    'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
    [`stock:${productId}:${warehouseId}`],
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
      quantity, unit, balance_before, balance_after, reason, user_id, created_at
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
      $12, $13, $14, $15, $16, $17, now()
    )
    RETURNING *
  `, [
    transaction.id, transaction.idempotencyKey, transaction.transactionNumber,
    transaction.transactionType, transaction.transactionDate, transaction.requestHash,
    transaction.referenceId, transaction.productId, transaction.warehouseId,
    transaction.batchId, transaction.supplierId ?? null, transaction.quantity,
    transaction.unit, transaction.balanceBefore, transaction.balanceAfter,
    transaction.reason ?? null, transaction.userId,
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

import { randomUUID } from 'node:crypto';
import {
  findTransactionByIdempotency,
  insertInventoryAudit,
  insertStockBalance,
  insertStockBatch,
  insertStockTransaction,
  lockIdempotency,
  lockStock,
  readInventoryReconciliation,
} from '../repositories/inventory.js';

function fault(status, errorCode, message, details = {}) {
  return Object.assign(new Error(message), { status, errorCode, details });
}

export async function inventoryReconciliation(client, productId, warehouseId) {
  return readInventoryReconciliation(client, productId, warehouseId);
}

export async function runInventoryMutation(pool, idempotencyKey, prepare) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await lockIdempotency(client, idempotencyKey);
    const mutation = await prepare(client);
    const prior = await findTransactionByIdempotency(client, idempotencyKey);
    if (prior) {
      if (prior.user_id !== mutation.transaction.userId
          || prior.request_hash !== mutation.requestHash) {
        throw fault(409, 'IDEMPOTENCY_CONFLICT', 'Idempotency key was already used with a different payload.');
      }
      await client.query('COMMIT');
      return prior;
    }

    await lockStock(client, mutation.productId, mutation.warehouseId);
    const before = await inventoryReconciliation(client, mutation.productId, mutation.warehouseId);
    if (mutation.requireEmptyLedger && before.ledgerCount > 0) {
      throw fault(409, 'OPENING_ALREADY_EXISTS', 'Stock ledger already exists for product and warehouse.');
    }
    if ((before.ledgerCount > 0 || before.batchCount > 0 || before.balanceCount > 0)
        && !before.reconciled) {
      throw fault(
        409,
        'INVENTORY_RECONCILIATION_FAILED',
        'Inventory state failed reconciliation before mutation.',
        before,
      );
    }

    const batchId = mutation.batch.id ?? randomUUID();
    const balanceId = mutation.balance.id ?? randomUUID();
    const transactionId = mutation.transaction.id ?? randomUUID();
    await insertStockBatch(client, { ...mutation.batch, id: batchId });
    await insertStockBalance(client, { ...mutation.balance, id: balanceId });
    const transaction = await insertStockTransaction(client, {
      ...mutation.transaction,
      id: transactionId,
      idempotencyKey,
      requestHash: mutation.requestHash,
      productId: mutation.productId,
      warehouseId: mutation.warehouseId,
      batchId,
    });
    await insertInventoryAudit(client, {
      id: randomUUID(),
      userId: mutation.transaction.userId,
      action: mutation.auditAction,
      reference: transactionId,
      details: mutation.auditDetails,
    });

    const reconciliation = await inventoryReconciliation(
      client,
      mutation.productId,
      mutation.warehouseId,
    );
    if (!reconciliation.reconciled) {
      throw fault(
        409,
        'INVENTORY_RECONCILIATION_FAILED',
        'Inventory mutation failed reconciliation.',
        reconciliation,
      );
    }

    await client.query('COMMIT');
    return transaction;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

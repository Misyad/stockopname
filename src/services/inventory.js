import { randomUUID } from 'node:crypto';
import {
  decrementStockBalance,
  decrementStockBatch,
  findFefoBatchesForUpdate,
  findStockBalanceForUpdate,
  findStockBatchForUpdate,
  findStockOutByIdempotency,
  findTransactionByIdempotency,
  incrementStockBalance,
  incrementStockBatch,
  insertInventoryAudit,
  insertStockBalance,
  insertStockBatch,
  insertStockOutRequest,
  insertStockTransaction,
  lockIdempotency,
  lockStock,
  planFefoAllocations,
  readInventoryReconciliation,
} from '../repositories/inventory.js';

function fault(status, errorCode, message, details = {}) {
  return Object.assign(new Error(message), { status, errorCode, details });
}

export async function inventoryReconciliation(client, productId, warehouseId) {
  return readInventoryReconciliation(client, productId, warehouseId);
}

function assertReconciled(state, message) {
  if ((state.ledgerCount > 0 || state.batchCount > 0 || state.balanceCount > 0)
      && !state.reconciled) {
    throw fault(409, 'INVENTORY_RECONCILIATION_FAILED', message, state);
  }
}

async function runTransaction(pool, idempotencyKey, mutate) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await lockIdempotency(client, idempotencyKey);
    const result = await mutate(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function runStockOutMutation(pool, idempotencyKey, prepare) {
  return runTransaction(pool, idempotencyKey, async (client) => {
    const mutation = await prepare(client);
    const [prior, otherType] = await Promise.all([
      findStockOutByIdempotency(client, idempotencyKey),
      findTransactionByIdempotency(client, idempotencyKey),
    ]);
    if (prior || otherType) {
      if (!prior || prior.user_id !== mutation.userId || prior.request_hash !== mutation.requestHash) {
        throw fault(409, 'IDEMPOTENCY_CONFLICT', 'Idempotency key was already used with a different payload.');
      }
      return prior;
    }
    mutation.validateCurrentState?.();
    await lockStock(client, mutation.productId, mutation.warehouseId);
    const before = await inventoryReconciliation(client, mutation.productId, mutation.warehouseId);
    assertReconciled(before, 'Inventory state failed reconciliation before mutation.');

    const [balance, batches] = await Promise.all([
      findStockBalanceForUpdate(client, mutation.productId, mutation.warehouseId),
      findFefoBatchesForUpdate(
        client, mutation.productId, mutation.warehouseId, mutation.transactionDate,
      ),
    ]);
    const allocations = await planFefoAllocations(
      client, batches.map(({ id }) => id), mutation.quantity, before.balanceQuantity,
    );
    if (!balance || allocations.at(-1)?.allocated_total !== mutation.quantity) {
      throw fault(409, 'INSUFFICIENT_STOCK', 'Eligible stock is insufficient.');
    }

    const requestId = randomUUID();
    const transactionNumber = `OUT-${requestId}`;
    const request = await insertStockOutRequest(client, {
      ...mutation,
      id: requestId,
      idempotencyKey,
      transactionNumber,
    });
    if (!await decrementStockBalance(client, balance.id, mutation.quantity)) {
      throw fault(409, 'INSUFFICIENT_STOCK', 'Eligible stock is insufficient.');
    }
    const ledgerRows = [];
    for (const [index, allocation] of allocations.entries()) {
      if (!await decrementStockBatch(client, allocation.batch_id, allocation.quantity)) {
        throw fault(409, 'INSUFFICIENT_STOCK', 'Eligible stock is insufficient.');
      }
      const transactionId = randomUUID();
      ledgerRows.push(await insertStockTransaction(client, {
        id: transactionId,
        idempotencyKey: `${requestId}:${index + 1}`,
        requestHash: mutation.requestHash,
        transactionNumber: `${transactionNumber}-${index + 1}`,
        transactionType: 'OUT',
        transactionDate: mutation.transactionDate,
        referenceId: mutation.referenceId,
        productId: mutation.productId,
        warehouseId: mutation.warehouseId,
        batchId: allocation.batch_id,
        quantity: `-${allocation.quantity}`,
        unit: mutation.unit,
        balanceBefore: allocation.balance_before,
        balanceAfter: allocation.balance_after,
        reason: mutation.reason,
        userId: mutation.userId,
        stockOutRequestId: requestId,
        allocationIndex: index + 1,
        unitPrice: allocation.unit_price,
      }));
    }
    await insertInventoryAudit(client, {
      id: randomUUID(),
      userId: mutation.userId,
      action: 'STOCK_OUT',
      reference: requestId,
      details: {
        productId: mutation.productId,
        warehouseId: mutation.warehouseId,
        quantity: mutation.quantity,
        allocations: allocations.map((allocation) => ({
          batchId: allocation.batch_id,
          quantity: allocation.quantity,
          unitPrice: allocation.unit_price,
        })),
      },
    });
    const after = await inventoryReconciliation(client, mutation.productId, mutation.warehouseId);
    assertReconciled(after, 'Inventory mutation failed reconciliation.');
    return {
      ...request,
      transaction_type: 'OUT',
      balance_before: allocations[0].balance_before,
      balance_after: allocations.at(-1).balance_after,
      allocations: ledgerRows.map((row, index) => ({
        transaction_id: row.id,
        batch_id: row.batch_id,
        quantity: allocations[index].quantity,
      })),
    };
  });
}

export async function runInventoryMutation(pool, idempotencyKey, prepare) {
  return runTransaction(pool, idempotencyKey, async (client) => {
    const mutation = await prepare(client);
    const [prior, otherType] = await Promise.all([
      findTransactionByIdempotency(client, idempotencyKey),
      findStockOutByIdempotency(client, idempotencyKey),
    ]);
    if (prior || otherType) {
      if (!prior || prior.user_id !== mutation.transaction.userId
          || prior.request_hash !== mutation.requestHash) {
        throw fault(409, 'IDEMPOTENCY_CONFLICT', 'Idempotency key was already used with a different payload.');
      }
      return prior;
    }
    mutation.validateCurrentState?.();

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

    let batchId = mutation.batch.id ?? randomUUID();
    const balanceId = mutation.balance.id ?? randomUUID();
    const transactionId = mutation.transaction.id ?? randomUUID();
    let balanceBefore = mutation.transaction.balanceBefore;
    let balanceAfter = mutation.transaction.balanceAfter;
    if (mutation.mode === 'INCREMENT') {
      const [batch, balance, quantities] = await Promise.all([
        findStockBatchForUpdate(
          client,
          mutation.productId,
          mutation.warehouseId,
          mutation.batch.batchNumber,
        ),
        findStockBalanceForUpdate(client, mutation.productId, mutation.warehouseId),
        client.query(
          'SELECT trim_scale($1::numeric)::text AS before, trim_scale($1::numeric + $2::numeric)::text AS after',
          [before.balanceQuantity, mutation.batch.quantity],
        ),
      ]);
      if (batch) {
        if (batch.production_date_text !== mutation.batch.productionDate
            || batch.expiry_date_text !== mutation.batch.expiryDate
            || batch.unit !== mutation.batch.unit) {
          throw fault(
            409,
            'BATCH_METADATA_CONFLICT',
            'Existing batch metadata does not match the receipt.',
          );
        }
        batchId = batch.id;
        await incrementStockBatch(
          client,
          batch.id,
          mutation.batch.quantity,
          mutation.batch.purchasePrice,
        );
      } else {
        await insertStockBatch(client, { ...mutation.batch, id: batchId });
      }
      if (balance) await incrementStockBalance(client, balance.id, mutation.balance.quantity);
      else await insertStockBalance(client, { ...mutation.balance, id: balanceId });
      balanceBefore = quantities.rows[0].before;
      balanceAfter = quantities.rows[0].after;
    } else {
      await insertStockBatch(client, { ...mutation.batch, id: batchId });
      await insertStockBalance(client, { ...mutation.balance, id: balanceId });
    }
    const transaction = await insertStockTransaction(client, {
      ...mutation.transaction,
      id: transactionId,
      idempotencyKey,
      requestHash: mutation.requestHash,
      productId: mutation.productId,
      warehouseId: mutation.warehouseId,
      batchId,
      balanceBefore,
      balanceAfter,
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

    return transaction;
  });
}

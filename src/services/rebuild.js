import { randomUUID } from 'node:crypto';
import { authorize, CAPABILITIES } from '../http/middleware/rbac.js';

function fault(errorCode, message, details = {}) {
  return Object.assign(new Error(message), { status: 409, errorCode, details });
}

async function actorWithCapability(client, sessionActor) {
  const row = (await client.query(
    "SELECT id, role, region_id FROM users WHERE id = $1 AND status = 'ACTIVE' FOR SHARE",
    [sessionActor?.userId],
  )).rows[0];
  const actor = row ? { userId: row.id, role: row.role, regionId: row.region_id } : null;
  authorize(actor, CAPABILITIES.REBUILD);
  return actor;
}

async function lockRegion(client, regionId) {
  const warehouses = (await client.query(
    'SELECT id FROM warehouses WHERE region_id = $1 ORDER BY id',
    [regionId],
  )).rows;
  for (const warehouse of warehouses) {
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [`warehouse-stock:${warehouse.id}`],
    );
  }
}

async function validateLedger(client, regionId) {
  const issues = (await client.query(`
    WITH ordered AS (
      SELECT transactions.product_id, transactions.warehouse_id, transactions.quantity,
        transactions.balance_before, transactions.balance_after,
        lag(transactions.balance_after) OVER (
          PARTITION BY transactions.product_id, transactions.warehouse_id
          ORDER BY transactions.ledger_sequence
        ) AS previous
      FROM stock_transactions transactions
      JOIN warehouses ON warehouses.id = transactions.warehouse_id
      WHERE warehouses.region_id = $1
    ), ledger AS (
      SELECT product_id, warehouse_id, sum(quantity) AS quantity,
        bool_and(balance_after = balance_before + quantity AND
          CASE WHEN previous IS NULL THEN balance_before = 0 ELSE balance_before = previous END
        ) AS valid
      FROM ordered GROUP BY product_id, warehouse_id
    ), batches AS (
      SELECT batches.product_id, batches.warehouse_id, sum(batches.quantity) AS quantity
      FROM stock_batches batches
      JOIN warehouses ON warehouses.id = batches.warehouse_id
      WHERE warehouses.region_id = $1
      GROUP BY batches.product_id, batches.warehouse_id
    )
    SELECT coalesce(ledger.product_id, batches.product_id) AS "productId",
      coalesce(ledger.warehouse_id, batches.warehouse_id) AS "warehouseId",
      trim_scale(coalesce(ledger.quantity, 0))::text AS "ledgerQuantity",
      trim_scale(coalesce(batches.quantity, 0))::text AS "batchQuantity"
    FROM ledger FULL JOIN batches USING (product_id, warehouse_id)
    WHERE NOT coalesce(ledger.valid, false)
      OR coalesce(ledger.quantity, 0) < 0
      OR coalesce(ledger.quantity, 0) <> coalesce(batches.quantity, 0)
    ORDER BY 1, 2 LIMIT 100
  `, [regionId])).rows;
  if (issues.length) {
    throw fault(
      'LEDGER_INVALID',
      'Ledger cannot produce a reconciled non-negative balance cache.',
      { issues },
    );
  }
}

async function mismatchCount(client, regionId) {
  const row = (await client.query(`
    WITH ledger AS (
      SELECT transactions.product_id, transactions.warehouse_id, sum(transactions.quantity) AS quantity
      FROM stock_transactions transactions
      JOIN warehouses ON warehouses.id = transactions.warehouse_id
      WHERE warehouses.region_id = $1
      GROUP BY transactions.product_id, transactions.warehouse_id
    )
    SELECT count(*)::int AS count
    FROM ledger FULL JOIN stock_balances balances USING (product_id, warehouse_id)
    JOIN warehouses ON warehouses.id = coalesce(ledger.warehouse_id, balances.warehouse_id)
    WHERE warehouses.region_id = $1
      AND (ledger.product_id IS NULL OR balances.product_id IS NULL
        OR ledger.quantity <> balances.quantity)
  `, [regionId])).rows[0];
  return Number(row.count);
}

async function replaceBalanceCache(client, regionId) {
  await client.query(`
    WITH ledger AS (
      SELECT transactions.product_id, transactions.warehouse_id, sum(transactions.quantity) AS quantity
      FROM stock_transactions transactions
      JOIN warehouses ON warehouses.id = transactions.warehouse_id
      WHERE warehouses.region_id = $1
      GROUP BY transactions.product_id, transactions.warehouse_id
    )
    INSERT INTO stock_balances (id, product_id, warehouse_id, quantity, version, updated_at)
    SELECT gen_random_uuid(), product_id, warehouse_id, quantity, 1, now() FROM ledger
    ON CONFLICT (product_id, warehouse_id) DO UPDATE
      SET quantity = EXCLUDED.quantity,
        version = stock_balances.version + 1,
        updated_at = now()
      WHERE stock_balances.quantity <> EXCLUDED.quantity
  `, [regionId]);
  await client.query(`
    DELETE FROM stock_balances balances
    USING warehouses
    WHERE warehouses.id = balances.warehouse_id AND warehouses.region_id = $1
      AND NOT EXISTS (
        SELECT 1 FROM stock_transactions transactions
        WHERE transactions.product_id = balances.product_id
          AND transactions.warehouse_id = balances.warehouse_id
      )
  `, [regionId]);
}

export async function rebuildBalances(pool, sessionActor) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '30min'");
    const actor = await actorWithCapability(client, sessionActor);
    const backup = (await client.query(`
      SELECT id FROM backup_logs
      WHERE status = 'VERIFIED' AND retained
        AND coalesce(verified_at, created_at) >= now() - interval '24 hours'
      ORDER BY coalesce(verified_at, created_at) DESC LIMIT 1
    `)).rows[0];
    if (!backup) {
      throw fault(
        'PRE_REBUILD_BACKUP_REQUIRED',
        'Verified backup not older than 24 hours is required.',
      );
    }
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      ['stock-maintenance'],
    );
    await lockRegion(client, actor.regionId);
    await validateLedger(client, actor.regionId);
    const rebuiltCount = await mismatchCount(client, actor.regionId);
    await replaceBalanceCache(client, actor.regionId);
    if (await mismatchCount(client, actor.regionId)) {
      throw new Error('Balance rebuild reconciliation failed.');
    }
    await client.query(`
      INSERT INTO audit_logs (id, timestamp, user_id, action, module, reference, details)
      VALUES ($1, now(), $2, 'BALANCE_REBUILT', 'MAINTENANCE', $3, $4::jsonb)
    `, [randomUUID(), actor.userId, actor.regionId, JSON.stringify({
      rebuiltCount, backupId: backup.id,
    })]);
    await client.query('COMMIT');
    return { status: 'REBUILT', rebuiltCount, backupId: backup.id };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

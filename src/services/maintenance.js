import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { authorize, CAPABILITIES } from '../http/middleware/rbac.js';

const migrationsDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../../db/migrations');

async function actorWithCapability(pool, sessionActor, capability) {
  const row = (await pool.query(
    "SELECT id, role, region_id FROM users WHERE id = $1 AND status = 'ACTIVE'",
    [sessionActor?.userId],
  )).rows[0];
  const actor = row ? { userId: row.id, role: row.role, regionId: row.region_id } : null;
  authorize(actor, capability);
  return actor;
}

function check(issues) {
  return { status: issues.length ? 'FAIL' : 'PASS', issueCount: issues.length, issues };
}

async function schemaCheck(pool) {
  const names = (await readdir(migrationsDirectory)).filter((name) => /^\d+_.*\.sql$/.test(name));
  const expected = await Promise.all(names.map(async (name) => {
    const version = Number.parseInt(name, 10);
    const sql = await readFile(resolve(migrationsDirectory, name), 'utf8');
    return { version, name, checksum: createHash('sha256').update(sql).digest('hex') };
  }));
  const applied = (await pool.query(
    'SELECT version::int, name, checksum FROM schema_migrations ORDER BY version',
  )).rows;
  const byVersion = new Map(applied.map((row) => [row.version, row]));
  const issues = expected.flatMap((migration) => {
    const row = byVersion.get(migration.version);
    if (!row) return [{ version: migration.version, issue: 'MISSING' }];
    if (row.name !== migration.name || row.checksum !== migration.checksum) {
      return [{ version: migration.version, issue: 'CHECKSUM_MISMATCH' }];
    }
    return [];
  });
  for (const row of applied) {
    if (!expected.some((migration) => migration.version === row.version)) {
      issues.push({ version: row.version, issue: 'UNKNOWN' });
    }
  }
  return check(issues);
}

async function referenceCheck(pool, regionId) {
  const rows = (await pool.query(`
    SELECT source, reference
    FROM (
      SELECT 'stock_transactions.user' AS source, transactions.transaction_number AS reference
      FROM stock_transactions transactions
      JOIN warehouses ON warehouses.id = transactions.warehouse_id
      LEFT JOIN users ON users.id = transactions.user_id
      WHERE warehouses.region_id = $1
        AND (users.id IS NULL OR users.region_id <> warehouses.region_id)
      UNION ALL
      SELECT 'stock_opnames.creator', opnames.opname_number
      FROM stock_opnames opnames
      JOIN warehouses ON warehouses.id = opnames.warehouse_id
      LEFT JOIN users ON users.id = opnames.created_by
      WHERE warehouses.region_id = $1
        AND (users.id IS NULL OR users.region_id <> warehouses.region_id)
      UNION ALL
      SELECT 'stock_opname_items.product', opnames.opname_number
      FROM stock_opname_items items
      JOIN stock_opnames opnames ON opnames.id = items.opname_id
      JOIN warehouses ON warehouses.id = opnames.warehouse_id
      LEFT JOIN products ON products.id = items.product_id
      WHERE warehouses.region_id = $1 AND products.id IS NULL
    ) issues
    ORDER BY source, reference
    LIMIT 100
  `, [regionId])).rows;
  return check(rows);
}

async function negativeCheck(pool, regionId) {
  const rows = (await pool.query(`
    SELECT source, reference, quantity
    FROM (
      SELECT 'stock_balance' AS source, balances.id::text AS reference,
        trim_scale(balances.quantity)::text AS quantity
      FROM stock_balances balances
      JOIN warehouses ON warehouses.id = balances.warehouse_id
      WHERE warehouses.region_id = $1 AND balances.quantity < 0
      UNION ALL
      SELECT 'stock_batch', batches.id::text, trim_scale(batches.quantity)::text
      FROM stock_batches batches
      JOIN warehouses ON warehouses.id = batches.warehouse_id
      WHERE warehouses.region_id = $1 AND batches.quantity < 0
      UNION ALL
      SELECT 'ledger_balance', transactions.transaction_number,
        trim_scale(least(transactions.balance_before, transactions.balance_after))::text
      FROM stock_transactions transactions
      JOIN warehouses ON warehouses.id = transactions.warehouse_id
      WHERE warehouses.region_id = $1
        AND (transactions.balance_before < 0 OR transactions.balance_after < 0)
    ) issues
    ORDER BY source, reference
    LIMIT 100
  `, [regionId])).rows;
  return check(rows);
}

async function ledgerBalanceCheck(pool, regionId) {
  const rows = (await pool.query(`
    WITH keys AS (
      SELECT transactions.product_id, transactions.warehouse_id
      FROM stock_transactions transactions
      JOIN warehouses ON warehouses.id = transactions.warehouse_id
      WHERE warehouses.region_id = $1
      UNION
      SELECT balances.product_id, balances.warehouse_id
      FROM stock_balances balances
      JOIN warehouses ON warehouses.id = balances.warehouse_id
      WHERE warehouses.region_id = $1
    ), ordered AS (
      SELECT transactions.product_id, transactions.warehouse_id, transactions.quantity,
        transactions.balance_before, transactions.balance_after,
        lag(transactions.balance_after) OVER (
          PARTITION BY transactions.product_id, transactions.warehouse_id
          ORDER BY transactions.ledger_sequence
        ) AS previous_balance
      FROM stock_transactions transactions
      JOIN warehouses ON warehouses.id = transactions.warehouse_id
      WHERE warehouses.region_id = $1
    ), ledger AS (
      SELECT product_id, warehouse_id, count(*)::int AS row_count, sum(quantity) AS quantity,
        bool_and(balance_after = balance_before + quantity AND
          CASE WHEN previous_balance IS NULL THEN balance_before = 0
            ELSE balance_before = previous_balance END) AS chain_valid
      FROM ordered GROUP BY product_id, warehouse_id
    ), balances AS (
      SELECT balances.product_id, balances.warehouse_id, count(*)::int AS row_count,
        sum(balances.quantity) AS quantity
      FROM stock_balances balances
      JOIN warehouses ON warehouses.id = balances.warehouse_id
      WHERE warehouses.region_id = $1
      GROUP BY balances.product_id, balances.warehouse_id
    )
    SELECT keys.product_id AS "productId", keys.warehouse_id AS "warehouseId",
      trim_scale(coalesce(ledger.quantity, 0))::text AS "ledgerQuantity",
      trim_scale(coalesce(balances.quantity, 0))::text AS "balanceQuantity",
      coalesce(ledger.chain_valid, false) AS "chainValid"
    FROM keys
    LEFT JOIN ledger USING (product_id, warehouse_id)
    LEFT JOIN balances USING (product_id, warehouse_id)
    WHERE coalesce(ledger.row_count, 0) = 0 OR coalesce(balances.row_count, 0) <> 1
      OR ledger.quantity <> balances.quantity OR NOT coalesce(ledger.chain_valid, false)
    ORDER BY keys.product_id, keys.warehouse_id
    LIMIT 100
  `, [regionId])).rows;
  return check(rows);
}

async function batchBalanceCheck(pool, regionId) {
  const rows = (await pool.query(`
    WITH keys AS (
      SELECT balances.product_id, balances.warehouse_id
      FROM stock_balances balances JOIN warehouses ON warehouses.id = balances.warehouse_id
      WHERE warehouses.region_id = $1
      UNION
      SELECT batches.product_id, batches.warehouse_id
      FROM stock_batches batches JOIN warehouses ON warehouses.id = batches.warehouse_id
      WHERE warehouses.region_id = $1
    ), batches AS (
      SELECT batches.product_id, batches.warehouse_id, sum(batches.quantity) AS quantity
      FROM stock_batches batches JOIN warehouses ON warehouses.id = batches.warehouse_id
      WHERE warehouses.region_id = $1 GROUP BY batches.product_id, batches.warehouse_id
    ), balances AS (
      SELECT balances.product_id, balances.warehouse_id, sum(balances.quantity) AS quantity
      FROM stock_balances balances JOIN warehouses ON warehouses.id = balances.warehouse_id
      WHERE warehouses.region_id = $1 GROUP BY balances.product_id, balances.warehouse_id
    )
    SELECT keys.product_id AS "productId", keys.warehouse_id AS "warehouseId",
      trim_scale(coalesce(batches.quantity, 0))::text AS "batchQuantity",
      trim_scale(coalesce(balances.quantity, 0))::text AS "balanceQuantity"
    FROM keys LEFT JOIN batches USING (product_id, warehouse_id)
    LEFT JOIN balances USING (product_id, warehouse_id)
    WHERE coalesce(batches.quantity, 0) <> coalesce(balances.quantity, 0)
    ORDER BY keys.product_id, keys.warehouse_id LIMIT 100
  `, [regionId])).rows;
  return check(rows);
}

async function opnameStateCheck(pool, regionId) {
  const rows = (await pool.query(`
    SELECT opnames.opname_number AS "opnameNumber", opnames.status,
      CASE
        WHEN count(items.id) = 0 THEN 'NO_ITEMS'
        WHEN opnames.status IN ('SUBMITTED', 'APPROVED')
          AND count(items.id) FILTER (WHERE items.physical_quantity IS NULL) > 0 THEN 'COUNTS_INCOMPLETE'
        WHEN opnames.status IN ('SUBMITTED', 'APPROVED')
          AND count(items.id) FILTER (WHERE items.difference <> 0 AND items.reason IS NULL) > 0 THEN 'REASON_MISSING'
        WHEN opnames.status IN ('SUBMITTED', 'APPROVED') AND opnames.submitted_at IS NULL THEN 'SUBMISSION_TIMESTAMP_MISSING'
        WHEN opnames.status = 'APPROVED'
          AND (opnames.approved_at IS NULL OR opnames.approved_by IS NULL) THEN 'APPROVAL_MISSING'
      END AS issue
    FROM stock_opnames opnames
    JOIN warehouses ON warehouses.id = opnames.warehouse_id
    LEFT JOIN stock_opname_items items ON items.opname_id = opnames.id
    WHERE warehouses.region_id = $1
    GROUP BY opnames.id, opnames.opname_number, opnames.status,
      opnames.submitted_at, opnames.approved_at, opnames.approved_by
    HAVING count(items.id) = 0
      OR (opnames.status IN ('SUBMITTED', 'APPROVED')
        AND count(items.id) FILTER (WHERE items.physical_quantity IS NULL) > 0)
      OR (opnames.status IN ('SUBMITTED', 'APPROVED')
        AND count(items.id) FILTER (WHERE items.difference <> 0 AND items.reason IS NULL) > 0)
      OR (opnames.status IN ('SUBMITTED', 'APPROVED') AND opnames.submitted_at IS NULL)
      OR (opnames.status = 'APPROVED' AND (opnames.approved_at IS NULL OR opnames.approved_by IS NULL))
    ORDER BY opnames.opname_number LIMIT 100
  `, [regionId])).rows;
  return check(rows);
}

async function auditCheck(pool, regionId) {
  const rows = (await pool.query(`
    SELECT transactions.transaction_number AS "transactionNumber",
      transactions.transaction_type AS "transactionType"
    FROM stock_transactions transactions
    JOIN warehouses ON warehouses.id = transactions.warehouse_id
    WHERE warehouses.region_id = $1 AND NOT EXISTS (
      SELECT 1 FROM audit_logs audit
      WHERE (transactions.transaction_type = 'OPENING' AND audit.action = 'OPENING_STOCK'
          AND audit.reference = transactions.id::text)
        OR (transactions.transaction_type = 'IN' AND audit.action = 'STOCK_IN'
          AND audit.reference = transactions.id::text)
        OR (transactions.transaction_type = 'OUT' AND audit.action = 'STOCK_OUT'
          AND audit.reference = transactions.stock_out_request_id::text)
        OR (transactions.transaction_type = 'ADJUSTMENT' AND audit.action = 'OPNAME_APPROVED'
          AND audit.reference = transactions.reference_id)
    )
    ORDER BY transactions.ledger_sequence LIMIT 100
  `, [regionId])).rows;
  return check(rows);
}

async function backupRpoCheck(pool) {
  const row = (await pool.query(`
    SELECT extract(epoch FROM (now() - coalesce(verified_at, created_at))) / 3600 AS age_hours
    FROM backup_logs WHERE status = 'VERIFIED' AND retained
    ORDER BY coalesce(verified_at, created_at) DESC LIMIT 1
  `)).rows[0];
  if (!row) return check([{ issue: 'NO_VERIFIED_BACKUP' }]);
  const ageHours = Number(row.age_hours);
  return ageHours <= 24
    ? { status: 'PASS', issueCount: 0, issues: [], ageHours }
    : { status: 'FAIL', issueCount: 1, issues: [{ issue: 'RPO_EXCEEDED' }], ageHours };
}

export async function shallowHealth(pool) {
  await pool.query('SELECT 1');
  return { app: 'UP', database: 'UP' };
}

export async function detailedHealth(pool, sessionActor) {
  const actor = await actorWithCapability(pool, sessionActor, CAPABILITIES.HEALTH_READ);
  const [schema, references, negatives, ledgerBalance, batchBalance, opnameStates,
    auditCompleteness, backupRpo] = await Promise.all([
    schemaCheck(pool), referenceCheck(pool, actor.regionId), negativeCheck(pool, actor.regionId),
    ledgerBalanceCheck(pool, actor.regionId), batchBalanceCheck(pool, actor.regionId),
    opnameStateCheck(pool, actor.regionId), auditCheck(pool, actor.regionId), backupRpoCheck(pool),
  ]);
  const checks = {
    schema, references, negatives, ledgerBalance, batchBalance,
    opnameStates, auditCompleteness, backupRpo,
  };
  const status = Object.values(checks).every((item) => item.status === 'PASS') ? 'PASS' : 'FAIL';
  if (status === 'FAIL') {
    await pool.query(`
      INSERT INTO audit_logs (id, timestamp, user_id, action, module, reference, details)
      VALUES ($1, now(), $2, 'HEALTH_CHECK_FAILED', 'MAINTENANCE', $3, $4::jsonb)
    `, [randomUUID(), actor.userId, actor.regionId, JSON.stringify({
      failedChecks: Object.entries(checks).filter(([, item]) => item.status === 'FAIL').map(([name]) => name),
    })]);
  }
  return { status, checkedAt: new Date().toISOString(), checks };
}

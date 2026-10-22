import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { authorize, CAPABILITIES } from '../http/middleware/rbac.js';
import { lockInventoryMaintenanceExclusive } from '../repositories/inventory.js';

const migrationsDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../../db/migrations');
let expectedMigrations;

function fault(status, errorCode, message) {
  return Object.assign(new Error(message), { status, errorCode });
}

async function actorFor(pool, sessionActor) {
  const row = (await pool.query(
    "SELECT id, role, region_id FROM users WHERE id = $1 AND status = 'ACTIVE'",
    [sessionActor?.userId],
  )).rows[0];
  if (!row) throw fault(401, 'UNAUTHENTICATED', 'Authentication required.');
  const actor = { userId: row.id, role: row.role, regionId: row.region_id };
  authorize(actor, CAPABILITIES.HEALTH_READ);
  return actor;
}

export async function migrationManifest() {
  if (!expectedMigrations) expectedMigrations = (async () => {
    const names = (await readdir(migrationsDirectory)).filter((name) => /^\d+_.*\.sql$/.test(name)).sort();
    return Promise.all(names.map(async (name) => {
      const sql = await readFile(resolve(migrationsDirectory, name), 'utf8');
      return {
        version: Number.parseInt(name, 10),
        name,
        checksum: createHash('sha256').update(sql).digest('hex'),
      };
    }));
  })();
  return expectedMigrations;
}

async function schemaCheck(pool) {
  try {
    const [expected, applied] = await Promise.all([
      migrationManifest(),
      pool.query('SELECT version, name, checksum FROM schema_migrations ORDER BY version'),
    ]);
    const actual = new Map(applied.rows.map((row) => [Number(row.version), row]));
    let issueCount = Math.abs(actual.size - expected.length);
    for (const migration of expected) {
      const row = actual.get(migration.version);
      if (!row || row.name !== migration.name || row.checksum !== migration.checksum) issueCount += 1;
    }
    return { status: issueCount === 0 ? 'PASS' : 'FAIL', issueCount };
  } catch {
    return { status: 'FAIL', issueCount: 1 };
  }
}

async function countCheck(pool, sql, regionId) {
  const issueCount = (await pool.query(sql, [regionId])).rows[0].issue_count;
  return { status: issueCount === 0 ? 'PASS' : 'FAIL', issueCount };
}

const referenceSql = `
  SELECT count(*)::int AS issue_count FROM (
    SELECT 'balance:' || balances.id AS issue
    FROM stock_balances balances
    JOIN warehouses ON warehouses.id = balances.warehouse_id
    LEFT JOIN products ON products.id = balances.product_id
    WHERE warehouses.region_id = $1 AND products.id IS NULL
    UNION ALL
    SELECT 'batch:' || batches.id
    FROM stock_batches batches
    JOIN warehouses ON warehouses.id = batches.warehouse_id
    LEFT JOIN products ON products.id = batches.product_id
    WHERE warehouses.region_id = $1 AND products.id IS NULL
    UNION ALL
    SELECT 'transaction:' || transactions.id
    FROM stock_transactions transactions
    JOIN warehouses ON warehouses.id = transactions.warehouse_id
    LEFT JOIN products ON products.id = transactions.product_id
    LEFT JOIN users ON users.id = transactions.user_id
    WHERE warehouses.region_id = $1 AND (products.id IS NULL OR users.id IS NULL)
    UNION ALL
    SELECT 'opname-item:' || items.id
    FROM stock_opname_items items
    JOIN stock_opnames opnames ON opnames.id = items.opname_id
    JOIN warehouses ON warehouses.id = opnames.warehouse_id
    LEFT JOIN products ON products.id = items.product_id
    LEFT JOIN stock_batches batches ON batches.id = items.batch_id
    WHERE warehouses.region_id = $1 AND (
      products.id IS NULL OR (items.batch_id IS NOT NULL AND (
        batches.id IS NULL OR batches.product_id <> items.product_id
        OR batches.warehouse_id <> opnames.warehouse_id
      ))
    )
  ) issues
`;

const negativeSql = `
  SELECT count(*)::int AS issue_count FROM (
    SELECT balances.id FROM stock_balances balances
    JOIN warehouses ON warehouses.id = balances.warehouse_id
    WHERE warehouses.region_id = $1 AND balances.quantity < 0
    UNION ALL
    SELECT batches.id FROM stock_batches batches
    JOIN warehouses ON warehouses.id = batches.warehouse_id
    WHERE warehouses.region_id = $1 AND batches.quantity < 0
    UNION ALL
    SELECT transactions.id FROM stock_transactions transactions
    JOIN warehouses ON warehouses.id = transactions.warehouse_id
    WHERE warehouses.region_id = $1 AND transactions.balance_after < 0
  ) issues
`;

const reconciliationSql = `
  WITH regional_warehouses AS (
    SELECT id FROM warehouses WHERE region_id = $1
  ), ordered_ledger AS (
    SELECT transactions.product_id, transactions.warehouse_id, transactions.quantity,
      transactions.balance_before, transactions.balance_after,
      lag(transactions.balance_after) OVER (
        PARTITION BY transactions.product_id, transactions.warehouse_id
        ORDER BY transactions.ledger_sequence
      ) AS previous_balance
    FROM stock_transactions transactions
    JOIN regional_warehouses ON regional_warehouses.id = transactions.warehouse_id
  ), ledger AS (
    SELECT product_id, warehouse_id, count(*)::int AS row_count, sum(quantity) AS quantity,
      bool_and(balance_after = balance_before + quantity AND balance_after >= 0 AND CASE
        WHEN previous_balance IS NULL THEN balance_before = 0
        ELSE balance_before = previous_balance
      END) AS chain_valid
    FROM ordered_ledger GROUP BY product_id, warehouse_id
  ), balances AS (
    SELECT balances.product_id, balances.warehouse_id, count(*)::int AS row_count,
      sum(balances.quantity) AS quantity
    FROM stock_balances balances
    JOIN regional_warehouses ON regional_warehouses.id = balances.warehouse_id
    GROUP BY balances.product_id, balances.warehouse_id
  ), batches AS (
    SELECT batches.product_id, batches.warehouse_id, count(*)::int AS row_count,
      sum(batches.quantity) AS quantity
    FROM stock_batches batches
    JOIN regional_warehouses ON regional_warehouses.id = batches.warehouse_id
    GROUP BY batches.product_id, batches.warehouse_id
  ), keys AS (
    SELECT product_id, warehouse_id FROM ledger
    UNION SELECT product_id, warehouse_id FROM balances
    UNION SELECT product_id, warehouse_id FROM batches
  )
  SELECT count(*)::int AS issue_count
  FROM keys
  LEFT JOIN ledger USING (product_id, warehouse_id)
  LEFT JOIN balances USING (product_id, warehouse_id)
  LEFT JOIN batches USING (product_id, warehouse_id)
  WHERE ledger.row_count IS NULL OR balances.row_count IS DISTINCT FROM 1
    OR batches.row_count IS NULL OR NOT coalesce(ledger.chain_valid, false)
    OR ledger.quantity IS DISTINCT FROM balances.quantity
    OR ledger.quantity IS DISTINCT FROM batches.quantity
`;

const opnameSql = `
  SELECT count(*)::int AS issue_count
  FROM stock_opnames opnames
  JOIN warehouses ON warehouses.id = opnames.warehouse_id
  WHERE warehouses.region_id = $1 AND NOT CASE opnames.status
    WHEN 'DRAFT' THEN opnames.submitted_at IS NULL AND opnames.approved_at IS NULL AND opnames.approved_by IS NULL
    WHEN 'COUNTING' THEN opnames.submitted_at IS NULL AND opnames.approved_at IS NULL AND opnames.approved_by IS NULL
    WHEN 'SUBMITTED' THEN opnames.submitted_at IS NOT NULL AND opnames.approved_at IS NULL AND opnames.approved_by IS NULL
    WHEN 'APPROVED' THEN opnames.submitted_at IS NOT NULL AND opnames.approved_at IS NOT NULL AND opnames.approved_by IS NOT NULL
    WHEN 'REJECTED' THEN opnames.submitted_at IS NOT NULL AND opnames.approved_at IS NULL AND opnames.approved_by IS NULL
      AND nullif(btrim(opnames.rejection_reason), '') IS NOT NULL
    ELSE false END
`;

const auditSql = `
  SELECT count(*)::int AS issue_count
  FROM stock_transactions transactions
  JOIN warehouses ON warehouses.id = transactions.warehouse_id
  WHERE warehouses.region_id = $1 AND NOT EXISTS (
    SELECT 1 FROM audit_logs audits
    WHERE audits.user_id = transactions.user_id AND (
      (transactions.transaction_type = 'OPENING' AND audits.action = 'OPENING_STOCK' AND audits.reference = transactions.id::text)
      OR (transactions.transaction_type = 'IN' AND audits.action = 'STOCK_IN' AND audits.reference = transactions.id::text)
      OR (transactions.transaction_type = 'OUT' AND audits.action = 'STOCK_OUT'
        AND audits.reference = coalesce(transactions.stock_out_request_id::text, transactions.id::text))
      OR (transactions.transaction_type = 'ADJUSTMENT' AND audits.action = 'OPNAME_APPROVED'
        AND audits.reference IN (transactions.reference_id, transactions.id::text))
      OR (transactions.transaction_type = 'REVERSAL' AND audits.action = 'REVERSAL'
        AND audits.reference IN (transactions.reference_id, transactions.id::text))
    )
  )
`;

async function verifiedBackupCheck(pool) {
  const row = (await pool.query(`
    SELECT verified_at, extract(epoch FROM (now() - verified_at)) / 3600 AS age_hours
    FROM backup_logs WHERE status = 'VERIFIED' AND retained AND verified_at IS NOT NULL
    ORDER BY verified_at DESC LIMIT 1
  `)).rows[0];
  const ageHours = row ? Number(row.age_hours) : null;
  return {
    status: ageHours !== null && ageHours <= 24 ? 'PASS' : 'FAIL',
    rpoHours: 24,
    ageHours: ageHours === null ? null : Math.round(ageHours * 100) / 100,
  };
}

export async function readiness(pool) {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

export async function rebuildBalances(pool, sessionActor) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const row = (await client.query(
      "SELECT id, role, region_id FROM users WHERE id = $1 AND status = 'ACTIVE' FOR SHARE",
      [sessionActor?.userId],
    )).rows[0];
    if (!row) throw fault(401, 'UNAUTHENTICATED', 'Authentication required.');
    const actor = { userId: row.id, role: row.role, regionId: row.region_id };
    authorize(actor, CAPABILITIES.REBUILD);
    const backup = (await client.query(`
      SELECT id FROM backup_logs
      WHERE status = 'VERIFIED' AND retained AND verified_at >= now() - interval '24 hours'
      ORDER BY verified_at DESC, id DESC LIMIT 1 FOR SHARE
    `)).rows[0];
    if (!backup) {
      throw fault(409, 'VERIFIED_BACKUP_REQUIRED', 'Recent verified backup is required.');
    }

    await lockInventoryMaintenanceExclusive(client);
    await client.query(`
      CREATE TEMP TABLE rebuild_balance_candidates ON COMMIT DROP AS
      WITH ordered AS (
        SELECT transactions.product_id, transactions.warehouse_id,
          transactions.quantity, transactions.balance_before, transactions.balance_after,
          row_number() OVER ledger_order AS position,
          lag(transactions.balance_after) OVER ledger_order AS previous_balance
        FROM stock_transactions transactions
        JOIN warehouses ON warehouses.id = transactions.warehouse_id
        WHERE warehouses.region_id = $1
        WINDOW ledger_order AS (
          PARTITION BY transactions.product_id, transactions.warehouse_id
          ORDER BY transactions.ledger_sequence
        )
      )
      SELECT product_id, warehouse_id, sum(quantity) AS quantity,
        bool_and(
          balance_after = balance_before + quantity
          AND balance_after >= 0
          AND CASE WHEN position = 1 THEN balance_before = 0
            ELSE balance_before = previous_balance END
        ) AS chain_valid
      FROM ordered GROUP BY product_id, warehouse_id
    `, [actor.regionId]);
    const unsafe = (await client.query(`
      SELECT count(*)::int AS issue_count FROM rebuild_balance_candidates
      WHERE NOT chain_valid OR quantity < 0
    `)).rows[0].issue_count;
    if (unsafe > 0) {
      throw fault(409, 'REBUILD_UNSAFE_LEDGER', 'Ledger cannot produce a safe balance cache.');
    }
    const batchIssues = (await client.query(`
      WITH batch_totals AS (
        SELECT batches.product_id, batches.warehouse_id, sum(batches.quantity) AS quantity
        FROM stock_batches batches
        JOIN warehouses ON warehouses.id = batches.warehouse_id
        WHERE warehouses.region_id = $1
        GROUP BY batches.product_id, batches.warehouse_id
      ), keys AS (
        SELECT product_id, warehouse_id FROM rebuild_balance_candidates
        UNION SELECT product_id, warehouse_id FROM batch_totals
      )
      SELECT count(*)::int AS issue_count FROM keys
      LEFT JOIN rebuild_balance_candidates candidates USING (product_id, warehouse_id)
      LEFT JOIN batch_totals USING (product_id, warehouse_id)
      WHERE candidates.quantity IS DISTINCT FROM batch_totals.quantity
    `, [actor.regionId])).rows[0].issue_count;
    if (batchIssues > 0) {
      throw fault(409, 'REBUILD_RECONCILIATION_FAILED', 'Ledger and batch stock do not reconcile.');
    }

    const updated = await client.query(`
      UPDATE stock_balances balances
      SET quantity = candidates.quantity, version = balances.version + 1, updated_at = now()
      FROM rebuild_balance_candidates candidates
      WHERE balances.product_id = candidates.product_id
        AND balances.warehouse_id = candidates.warehouse_id
        AND balances.quantity IS DISTINCT FROM candidates.quantity
    `);
    const inserted = await client.query(`
      INSERT INTO stock_balances (id, product_id, warehouse_id, quantity, version, updated_at)
      SELECT gen_random_uuid(), candidates.product_id, candidates.warehouse_id,
        candidates.quantity, 1, now()
      FROM rebuild_balance_candidates candidates
      WHERE NOT EXISTS (
        SELECT 1 FROM stock_balances balances
        WHERE balances.product_id = candidates.product_id
          AND balances.warehouse_id = candidates.warehouse_id
      )
    `);
    const deleted = await client.query(`
      DELETE FROM stock_balances balances
      USING warehouses
      WHERE warehouses.id = balances.warehouse_id AND warehouses.region_id = $1
        AND NOT EXISTS (
          SELECT 1 FROM rebuild_balance_candidates candidates
          WHERE candidates.product_id = balances.product_id
            AND candidates.warehouse_id = balances.warehouse_id
        )
    `, [actor.regionId]);
    const postIssues = (await client.query(`
      WITH regional_balances AS (
        SELECT balances.product_id, balances.warehouse_id, balances.quantity
        FROM stock_balances balances
        JOIN warehouses ON warehouses.id = balances.warehouse_id
        WHERE warehouses.region_id = $1
      ), keys AS (
        SELECT product_id, warehouse_id FROM rebuild_balance_candidates
        UNION SELECT product_id, warehouse_id FROM regional_balances
      )
      SELECT count(*)::int AS issue_count FROM keys
      LEFT JOIN rebuild_balance_candidates candidates USING (product_id, warehouse_id)
      LEFT JOIN regional_balances balances USING (product_id, warehouse_id)
      WHERE candidates.quantity IS DISTINCT FROM balances.quantity
    `, [actor.regionId])).rows[0].issue_count;
    if (postIssues > 0) {
      throw fault(409, 'REBUILD_RECONCILIATION_FAILED', 'Rebuilt balance cache did not reconcile.');
    }
    const repairedBalances = updated.rowCount + inserted.rowCount + deleted.rowCount;
    await client.query(`
      INSERT INTO audit_logs (id, timestamp, user_id, action, module, reference, details)
      VALUES ($1, now(), $2, 'BALANCE_REBUILT', 'MAINTENANCE', $3, $4::jsonb)
    `, [randomUUID(), actor.userId, backup.id, JSON.stringify({
      backupId: backup.id, regionId: actor.regionId, repairedBalances,
    })]);
    await client.query('COMMIT');
    return {
      status: 'PASS', backupId: backup.id, regionId: actor.regionId, repairedBalances,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function detailedHealth(pool, sessionActor) {
  const actor = await actorFor(pool, sessionActor);
  const schema = await schemaCheck(pool);
  if (schema.status === 'FAIL') {
    return {
      status: 'FAIL',
      checks: {
        schema,
        references: { status: 'NOT_VERIFIED' },
        negativeStock: { status: 'NOT_VERIFIED' },
        reconciliation: { status: 'NOT_VERIFIED' },
        opnameStates: { status: 'NOT_VERIFIED' },
        auditCompleteness: { status: 'NOT_VERIFIED' },
        verifiedBackup: { status: 'NOT_VERIFIED', rpoHours: 24 },
      },
    };
  }
  const [references, negativeStock, reconciliation, opnameStates, auditCompleteness, verifiedBackup] = await Promise.all([
    countCheck(pool, referenceSql, actor.regionId),
    countCheck(pool, negativeSql, actor.regionId),
    countCheck(pool, reconciliationSql, actor.regionId),
    countCheck(pool, opnameSql, actor.regionId),
    countCheck(pool, auditSql, actor.regionId),
    verifiedBackupCheck(pool),
  ]);
  const checks = { schema, references, negativeStock, reconciliation, opnameStates, auditCompleteness, verifiedBackup };
  return {
    status: Object.values(checks).every((check) => check.status === 'PASS') ? 'PASS' : 'FAIL',
    checks,
  };
}

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { api, appCommand, ids, login, publicApi, setup, sql, teardown } from './report-fixture.js';

let sessions;

function repairCanonicalFixture() {
  sql(`
    ALTER TABLE stock_transactions DISABLE TRIGGER stock_transactions_immutable_rows;
    UPDATE stock_transactions SET balance_before = 19, balance_after = 17
      WHERE transaction_number = 'RPT-ADJUST';
    ALTER TABLE stock_transactions ENABLE TRIGGER stock_transactions_immutable_rows;
    UPDATE stock_balances SET quantity = 17 WHERE product_id = '${ids.safe}' AND warehouse_id = '${ids.warehouseA}';
    UPDATE stock_batches SET quantity = 17 WHERE id = '${ids.safeBatch}';
    DELETE FROM stock_balances WHERE product_id = '${ids.out}' AND warehouse_id = '${ids.warehouseA}';
    UPDATE stock_opnames SET submitted_at = now() WHERE id = '${ids.opnameA}';
    INSERT INTO audit_logs (id, timestamp, user_id, action, module, reference, details)
    SELECT gen_random_uuid(), now(), user_id,
      CASE transaction_type WHEN 'OPENING' THEN 'OPENING_STOCK' WHEN 'IN' THEN 'STOCK_IN'
        WHEN 'OUT' THEN 'STOCK_OUT' ELSE 'OPNAME_APPROVED' END,
      'INVENTORY', id::text, '{}'::jsonb
    FROM stock_transactions WHERE warehouse_id = '${ids.warehouseA}';
    INSERT INTO backup_logs (id, backup_type, file_name, storage_uri, size_bytes, checksum, status, created_by, created_at, verified_at)
    VALUES (gen_random_uuid(), 'DAILY', 'health.dump', 'backup://health.dump', 1, repeat('a', 64),
      'VERIFIED', '${ids.admin}', now(), now());
    INSERT INTO users (id, name, email, password_hash, role, status, region_id)
    SELECT '68000000-0000-4000-8000-000000000013', 'Reports Supervisor',
      'reports-supervisor@example.test', password_hash, 'SUPERVISOR', 'ACTIVE', region_id
    FROM users WHERE id = '${ids.admin}';
  `);
}

before(async () => {
  sessions = await setup('stock_health');
  repairCanonicalFixture();
  sessions.supervisor = await login('reports-supervisor@example.test');
});
after(teardown);

async function health(cookie = sessions.admin) {
  return api('/maintenance/health-check', { headers: cookie ? { cookie } : {} });
}

test('public readiness checks DB without exposing detail', async () => {
  const result = await publicApi('/health');
  assert.equal(result.response.status, 200);
  assert.deepEqual(result.body, { success: true });
  assert.doesNotMatch(JSON.stringify(result.body), /postgres|migration|warehouse|backup/i);
});

test('health CLI runs detailed checks from production image', () => {
  const output = appCommand(['node', 'scripts/health-check.js'], { HEALTH_CHECK_USER_ID: ids.admin });
  assert.equal(JSON.parse(output).status, 'PASS');
});

test('detailed health requires HEALTH_READ and passes canonical regional state', async () => {
  assert.equal((await health(null)).response.status, 401);
  assert.equal((await health(sessions.petugas)).response.status, 403);
  for (const cookie of [sessions.supervisor, sessions.admin]) {
    const result = await health(cookie);
    assert.equal(result.response.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.data.status, 'PASS');
    for (const check of Object.values(result.body.data.checks)) assert.equal(check.status, 'PASS');
  }
});

test('detailed health is region-scoped and detects exact cache and batch mismatch', async () => {
  sql(`UPDATE stock_balances SET quantity = 98 WHERE product_id = '${ids.safe}' AND warehouse_id = '${ids.warehouseB}'`);
  let result = await health();
  assert.equal(result.body.data.status, 'PASS', JSON.stringify(result.body));

  sql(`UPDATE stock_balances SET quantity = 16 WHERE product_id = '${ids.safe}' AND warehouse_id = '${ids.warehouseA}'`);
  result = await health();
  assert.equal(result.body.data.status, 'FAIL');
  assert.deepEqual(result.body.data.checks.reconciliation, { status: 'FAIL', issueCount: 1 });
  sql(`UPDATE stock_balances SET quantity = 17 WHERE product_id = '${ids.safe}' AND warehouse_id = '${ids.warehouseA}'`);

  sql(`UPDATE stock_batches SET quantity = 16 WHERE id = '${ids.safeBatch}'`);
  result = await health();
  assert.deepEqual(result.body.data.checks.reconciliation, { status: 'FAIL', issueCount: 1 });
  sql(`UPDATE stock_batches SET quantity = 17 WHERE id = '${ids.safeBatch}'`);
});

test('detailed health detects migration, ledger chain, workflow, audit, negative, and stale backup faults', async () => {
  const checksum = sql("SELECT checksum FROM schema_migrations ORDER BY version LIMIT 1");
  sql("UPDATE schema_migrations SET checksum = repeat('0', 64) WHERE version = (SELECT min(version) FROM schema_migrations)");
  assert.equal((await health()).body.data.checks.schema.status, 'FAIL');
  sql(`UPDATE schema_migrations SET checksum = '${checksum}' WHERE version = (SELECT min(version) FROM schema_migrations)`);

  sql(`ALTER TABLE stock_transactions DISABLE TRIGGER stock_transactions_immutable_rows;
    UPDATE stock_transactions SET balance_before = 18 WHERE transaction_number = 'RPT-ADJUST';
    ALTER TABLE stock_transactions ENABLE TRIGGER stock_transactions_immutable_rows;`);
  assert.deepEqual((await health()).body.data.checks.reconciliation, { status: 'FAIL', issueCount: 1 });
  sql(`ALTER TABLE stock_transactions DISABLE TRIGGER stock_transactions_immutable_rows;
    UPDATE stock_transactions SET balance_before = 19 WHERE transaction_number = 'RPT-ADJUST';
    ALTER TABLE stock_transactions ENABLE TRIGGER stock_transactions_immutable_rows;`);

  sql(`UPDATE stock_opnames SET submitted_at = NULL WHERE id = '${ids.opnameA}'`);
  assert.deepEqual((await health()).body.data.checks.opnameStates, { status: 'FAIL', issueCount: 1 });
  sql(`UPDATE stock_opnames SET submitted_at = now() WHERE id = '${ids.opnameA}'`);

  const auditId = sql(`SELECT id FROM audit_logs WHERE reference = (SELECT id::text FROM stock_transactions WHERE transaction_number = 'RPT-IN')`);
  sql(`DELETE FROM audit_logs WHERE id = '${auditId}'`);
  assert.deepEqual((await health()).body.data.checks.auditCompleteness, { status: 'FAIL', issueCount: 1 });
  sql(`INSERT INTO audit_logs (id, timestamp, user_id, action, module, reference, details)
    SELECT '${auditId}', now(), user_id, 'STOCK_IN', 'INVENTORY', id::text, '{}'::jsonb
    FROM stock_transactions WHERE transaction_number = 'RPT-IN'`);

  sql('ALTER TABLE stock_balances DROP CONSTRAINT stock_balances_quantity_check');
  sql(`UPDATE stock_balances SET quantity = -1 WHERE product_id = '${ids.safe}' AND warehouse_id = '${ids.warehouseA}'`);
  assert.deepEqual((await health()).body.data.checks.negativeStock, { status: 'FAIL', issueCount: 1 });
  sql(`UPDATE stock_balances SET quantity = 17 WHERE product_id = '${ids.safe}' AND warehouse_id = '${ids.warehouseA}';
    ALTER TABLE stock_balances ADD CONSTRAINT stock_balances_quantity_check CHECK (quantity >= 0)`);

  sql("UPDATE backup_logs SET verified_at = now() - interval '25 hours' WHERE status = 'VERIFIED'");
  const backup = (await health()).body.data.checks.verifiedBackup;
  assert.equal(backup.status, 'FAIL');
  assert.equal(backup.rpoHours, 24);
});

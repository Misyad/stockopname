import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import {
  api, appOrigin, ids, setup, sql, teardown,
} from './report-fixture.js';

let sessions;
let csrf;
let backupId;

function repairFixture() {
  backupId = '68000000-0000-4000-8000-000000000090';
  sql(`
    ALTER TABLE stock_transactions DISABLE TRIGGER stock_transactions_immutable_rows;
    UPDATE stock_transactions SET balance_before = 19, balance_after = 17
      WHERE transaction_number = 'RPT-ADJUST';
    ALTER TABLE stock_transactions ENABLE TRIGGER stock_transactions_immutable_rows;
    UPDATE stock_balances SET quantity = 17
      WHERE product_id = '${ids.safe}' AND warehouse_id = '${ids.warehouseA}';
    UPDATE stock_batches SET quantity = 17 WHERE id = '${ids.safeBatch}';
    DELETE FROM stock_balances
      WHERE product_id = '${ids.out}' AND warehouse_id = '${ids.warehouseA}';
    INSERT INTO backup_logs (
      id, backup_type, file_name, storage_uri, independent_storage_uri,
      size_bytes, checksum, status, created_by, created_at, verified_at, retained
    ) VALUES (
      '${backupId}', 'DAILY', 'rebuild.dump', '/backup/rebuild.dump', 'remote:rebuild.dump',
      1, repeat('a', 64), 'VERIFIED', '${ids.admin}', now(), now(), true
    );
  `);
}

async function csrfFor(cookie) {
  const result = await api('/auth/csrf', { headers: { cookie } });
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  return result.body.data.csrfToken;
}

function mutation(path, body) {
  return api(path, {
    method: 'POST',
    headers: {
      cookie: sessions.admin,
      origin: appOrigin(),
      'content-type': 'application/json',
      'x-csrf-token': csrf,
    },
    body: JSON.stringify(body),
  });
}

function rebuild(cookie = sessions.admin, token = csrf, body = {}, overrides = {}) {
  return api('/maintenance/rebuild-balances', {
    method: 'POST',
    headers: {
      cookie,
      origin: appOrigin(),
      'content-type': 'application/json',
      'x-csrf-token': token,
      ...overrides,
    },
    body: JSON.stringify(body),
  });
}

function stockIn(suffix) {
  return mutation('/transactions/in', {
    idempotencyKey: `rebuild-race-${suffix}`,
    date: '2026-10-22',
    reference: `REBUILD-RACE-${suffix}`,
    warehouse: 'RPT-WH-A',
    code: 'RPT-SAFE',
    supplier: 'RPT-SUP',
    batch: `REBUILD-RACE-${suffix}`,
    quantity: 1,
    unit: 'RPT-KG',
    price: 2,
    notes: 'maintenance lock test',
  });
}

async function waitForSleep() {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const count = Number(sql(`
      SELECT count(*) FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event = 'PgSleep'
    `));
    if (count > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail('timed out waiting for paused transaction');
}

async function assertPending(promise, message) {
  const state = await Promise.race([
    promise.then(() => 'settled', () => 'settled'),
    new Promise((resolve) => setTimeout(() => resolve('pending'), 200)),
  ]);
  assert.equal(state, 'pending', message);
}

function installPauseTrigger(table, name, condition) {
  sql(`
    CREATE OR REPLACE FUNCTION ${name}() RETURNS trigger AS $function$
    BEGIN
      IF ${condition} THEN PERFORM pg_sleep(1.5); END IF;
      RETURN NEW;
    END
    $function$ LANGUAGE plpgsql;
    CREATE TRIGGER ${name} BEFORE INSERT ON ${table}
      FOR EACH ROW EXECUTE FUNCTION ${name}();
  `);
}

function removePauseTrigger(table, name) {
  sql(`
    DROP TRIGGER IF EXISTS ${name} ON ${table};
    DROP FUNCTION IF EXISTS ${name}();
  `);
}

before(async () => {
  sessions = await setup('stock_rebuild');
  repairFixture();
  csrf = await csrfFor(sessions.admin);
});
after(teardown);

test('rebuild route enforces auth, role, origin, CSRF, media type, and empty body', async () => {
  const petugasCsrf = await csrfFor(sessions.petugas);
  const cases = [
    [await rebuild('', ''), 401, 'UNAUTHENTICATED'],
    [await rebuild(sessions.petugas, petugasCsrf), 403, 'FORBIDDEN'],
    [await rebuild(sessions.admin, csrf, {}, { origin: 'https://evil.example' }), 403, 'ORIGIN_INVALID'],
    [await rebuild(sessions.admin, 'wrong'), 403, 'CSRF_INVALID'],
    [await rebuild(sessions.admin, csrf, {}, { 'content-type': 'text/plain' }), 415, 'UNSUPPORTED_MEDIA_TYPE'],
    [await rebuild(sessions.admin, csrf, { force: true }), 400, 'VALIDATION_ERROR'],
  ];
  for (const [result, status, code] of cases) {
    assert.equal(result.response.status, status, JSON.stringify(result.body));
    assert.equal(result.body.errorCode, code);
  }
  assert.equal(sql("SELECT count(*) FROM audit_logs WHERE action = 'BALANCE_REBUILT'"), '0');
});

test('rebuild requires a recent retained verified backup', async () => {
  const invalidStates = [
    "verified_at = now() - interval '25 hours'",
    "verified_at = now(), retained = false",
    "verified_at = now(), retained = true, status = 'FAILED'",
  ];
  for (const state of invalidStates) {
    sql(`UPDATE backup_logs SET ${state} WHERE id = '${backupId}'`);
    const result = await rebuild();
    assert.equal(result.response.status, 409, JSON.stringify(result.body));
    assert.equal(result.body.errorCode, 'VERIFIED_BACKUP_REQUIRED');
    assert.equal(sql("SELECT count(*) FROM audit_logs WHERE action = 'BALANCE_REBUILT'"), '0');
  }
  sql(`UPDATE backup_logs SET verified_at = now(), retained = true, status = 'VERIFIED'
    WHERE id = '${backupId}'`);
});

test('verified backup permits regional balance rebuild from immutable ledger', async () => {
  sql(`UPDATE stock_balances SET quantity = 16
    WHERE product_id = '${ids.safe}' AND warehouse_id = '${ids.warehouseA}'`);
  const ledgerBefore = sql('SELECT count(*) FROM stock_transactions');

  const result = await rebuild();

  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.data.status, 'PASS');
  assert.equal(result.body.data.backupId, backupId);
  assert.equal(result.body.data.regionId, ids.regionA);
  assert.equal(result.body.data.repairedBalances, 1);
  assert.equal(sql(`SELECT quantity FROM stock_balances
    WHERE product_id = '${ids.safe}' AND warehouse_id = '${ids.warehouseA}'`), '17');
  assert.equal(sql(`SELECT quantity FROM stock_balances
    WHERE product_id = '${ids.safe}' AND warehouse_id = '${ids.warehouseB}'`), '99');
  assert.equal(sql('SELECT count(*) FROM stock_transactions'), ledgerBefore);
  assert.equal(sql(`SELECT count(*) FROM audit_logs
    WHERE action = 'BALANCE_REBUILT' AND user_id = '${ids.admin}'
      AND reference = '${backupId}'
      AND details->>'backupId' = '${backupId}'
      AND details->>'regionId' = '${ids.regionA}'
      AND details->>'repairedBalances' = '1'`), '1');
});

test('unsafe ledger leaves original balance cache and audit untouched', async () => {
  sql(`
    ALTER TABLE stock_transactions DISABLE TRIGGER stock_transactions_immutable_rows;
    UPDATE stock_transactions SET balance_before = 18 WHERE transaction_number = 'RPT-ADJUST';
    ALTER TABLE stock_transactions ENABLE TRIGGER stock_transactions_immutable_rows;
    UPDATE stock_balances SET quantity = 15
      WHERE product_id = '${ids.safe}' AND warehouse_id = '${ids.warehouseA}';
  `);
  const before = sql(`SELECT string_agg(product_id::text || ':' || warehouse_id::text || ':' || quantity::text, ',' ORDER BY product_id, warehouse_id) FROM stock_balances`);
  const audits = sql("SELECT count(*) FROM audit_logs WHERE action = 'BALANCE_REBUILT'");

  const result = await rebuild();

  assert.equal(result.response.status, 409, JSON.stringify(result.body));
  assert.equal(result.body.errorCode, 'REBUILD_UNSAFE_LEDGER');
  assert.equal(sql(`SELECT string_agg(product_id::text || ':' || warehouse_id::text || ':' || quantity::text, ',' ORDER BY product_id, warehouse_id) FROM stock_balances`), before);
  assert.equal(sql("SELECT count(*) FROM audit_logs WHERE action = 'BALANCE_REBUILT'"), audits);
  sql(`
    ALTER TABLE stock_transactions DISABLE TRIGGER stock_transactions_immutable_rows;
    UPDATE stock_transactions SET balance_before = 19 WHERE transaction_number = 'RPT-ADJUST';
    ALTER TABLE stock_transactions ENABLE TRIGGER stock_transactions_immutable_rows;
    UPDATE stock_balances SET quantity = 17
      WHERE product_id = '${ids.safe}' AND warehouse_id = '${ids.warehouseA}';
  `);
});

test('audit failure rolls back rebuilt balances and emits no success audit', async () => {
  const auditsBefore = sql("SELECT count(*) FROM audit_logs WHERE action = 'BALANCE_REBUILT'");
  sql(`
    UPDATE stock_balances SET quantity = 16
      WHERE product_id = '${ids.safe}' AND warehouse_id = '${ids.warehouseA}';
    CREATE OR REPLACE FUNCTION reject_balance_rebuild_audit() RETURNS trigger AS $function$
    BEGIN
      IF NEW.action = 'BALANCE_REBUILT' THEN RAISE EXCEPTION 'audit unavailable'; END IF;
      RETURN NEW;
    END
    $function$ LANGUAGE plpgsql;
    CREATE TRIGGER reject_balance_rebuild_audit BEFORE INSERT ON audit_logs
      FOR EACH ROW EXECUTE FUNCTION reject_balance_rebuild_audit();
  `);
  try {
    const result = await rebuild();
    assert.equal(result.response.status, 500, JSON.stringify(result.body));
    assert.equal(result.body.errorCode, 'INTERNAL_ERROR');
    assert.equal(sql(`SELECT quantity FROM stock_balances
      WHERE product_id = '${ids.safe}' AND warehouse_id = '${ids.warehouseA}'`), '16');
    assert.equal(sql("SELECT count(*) FROM audit_logs WHERE action = 'BALANCE_REBUILT'"), auditsBefore);
  } finally {
    sql(`
      DROP TRIGGER IF EXISTS reject_balance_rebuild_audit ON audit_logs;
      DROP FUNCTION IF EXISTS reject_balance_rebuild_audit();
      UPDATE stock_balances SET quantity = 17
        WHERE product_id = '${ids.safe}' AND warehouse_id = '${ids.warehouseA}';
    `);
  }
});

test('rebuild waits while a production stock writer holds the shared maintenance lock', async () => {
  const trigger = 'pause_rebuild_writer';
  installPauseTrigger(
    'stock_transactions', trigger, "NEW.reference_id = 'REBUILD-RACE-writer'",
  );
  let writer;
  let maintenance;
  try {
    writer = stockIn('writer');
    await waitForSleep();
    maintenance = rebuild();
    await assertPending(maintenance, 'rebuild must wait for active stock writer');
    const [writerResult, rebuildResult] = await Promise.all([writer, maintenance]);
    assert.equal(writerResult.response.status, 201, JSON.stringify(writerResult.body));
    assert.equal(rebuildResult.response.status, 200, JSON.stringify(rebuildResult.body));
  } finally {
    await Promise.allSettled([writer, maintenance].filter(Boolean));
    removePauseTrigger('stock_transactions', trigger);
  }
});

test('production stock writer waits while rebuild holds the exclusive maintenance lock', async () => {
  const trigger = 'pause_active_rebuild';
  installPauseTrigger('audit_logs', trigger, "NEW.action = 'BALANCE_REBUILT'");
  let maintenance;
  let writer;
  try {
    maintenance = rebuild();
    await waitForSleep();
    writer = stockIn('maintenance');
    await assertPending(writer, 'stock writer must wait for active rebuild');
    const [rebuildResult, writerResult] = await Promise.all([maintenance, writer]);
    assert.equal(rebuildResult.response.status, 200, JSON.stringify(rebuildResult.body));
    assert.equal(writerResult.response.status, 201, JSON.stringify(writerResult.body));
  } finally {
    await Promise.allSettled([maintenance, writer].filter(Boolean));
    removePauseTrigger('audit_logs', trigger);
  }
});

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { integrationApp, passwordHash } from '../helpers/integration-app.js';

const app = integrationApp('stock_health');
const password = 'correct horse battery staple';
const ids = {
  regionA: '73000000-0000-0000-0000-000000000001',
  regionB: '73000000-0000-0000-0000-000000000002',
  admin: '73000000-0000-0000-0000-000000000010',
  supervisor: '73000000-0000-0000-0000-000000000011',
  petugas: '73000000-0000-0000-0000-000000000012',
  category: '73000000-0000-0000-0000-000000000020',
  unit: '73000000-0000-0000-0000-000000000030',
  warehouseA: '73000000-0000-0000-0000-000000000040',
  warehouseB: '73000000-0000-0000-0000-000000000041',
  productA: '73000000-0000-0000-0000-000000000050',
  productB: '73000000-0000-0000-0000-000000000051',
};
let adminCookie;
let supervisorCookie;
let petugasCookie;

before(async () => {
  await app.start();
  app.sql(`
    INSERT INTO regions (id, code, name, status) VALUES
      ('${ids.regionA}', 'HEALTH-A', 'Health Region A', 'ACTIVE'),
      ('${ids.regionB}', 'HEALTH-B', 'Health Region B', 'ACTIVE');
    INSERT INTO users (id, name, email, password_hash, role, status, region_id) VALUES
      ('${ids.admin}', 'Health Admin', 'health-admin@example.test', '${passwordHash(password)}', 'ADMIN', 'ACTIVE', '${ids.regionA}'),
      ('${ids.supervisor}', 'Health Supervisor', 'health-supervisor@example.test', '${passwordHash(password)}', 'SUPERVISOR', 'ACTIVE', '${ids.regionA}'),
      ('${ids.petugas}', 'Health Petugas', 'health-petugas@example.test', '${passwordHash(password)}', 'PETUGAS', 'ACTIVE', '${ids.regionA}');
    INSERT INTO categories (id, code, name, status)
      VALUES ('${ids.category}', 'HEALTH-CAT', 'Health Category', 'ACTIVE');
    INSERT INTO units (id, code, name, symbol, conversion_to_base, status)
      VALUES ('${ids.unit}', 'HEALTH-KG', 'Kilogram', 'kg', 1, 'ACTIVE');
    INSERT INTO warehouses (id, code, name, status, region_id) VALUES
      ('${ids.warehouseA}', 'HEALTH-WH-A', 'Health Warehouse A', 'ACTIVE', '${ids.regionA}'),
      ('${ids.warehouseB}', 'HEALTH-WH-B', 'Health Warehouse B', 'ACTIVE', '${ids.regionB}');
    INSERT INTO products (
      id, code, name, category_id, base_unit_id, conversion_factor,
      minimum_stock, maximum_stock, status
    ) VALUES
      ('${ids.productA}', 'HEALTH-P-A', 'Health Product A', '${ids.category}', '${ids.unit}', 1, 0, 100, 'ACTIVE'),
      ('${ids.productB}', 'SECRET-B', 'Secret Product B', '${ids.category}', '${ids.unit}', 1, 0, 100, 'ACTIVE');
    INSERT INTO stock_balances (id, product_id, warehouse_id, quantity, version) VALUES
      (gen_random_uuid(), '${ids.productA}', '${ids.warehouseA}', 9, 1),
      (gen_random_uuid(), '${ids.productB}', '${ids.warehouseB}', 88, 1);
    INSERT INTO stock_batches (
      id, product_id, warehouse_id, batch_number, quantity, unit, purchase_price, status
    ) VALUES
      (gen_random_uuid(), '${ids.productA}', '${ids.warehouseA}', 'HEALTH-BATCH', 8, 'HEALTH-KG', 1, 'ACTIVE'),
      (gen_random_uuid(), '${ids.productB}', '${ids.warehouseB}', 'SECRET-B', 77, 'HEALTH-KG', 1, 'ACTIVE');
    INSERT INTO stock_transactions (
      id, idempotency_key, transaction_number, transaction_type, transaction_date,
      request_hash, reference_id, product_id, warehouse_id, quantity, unit,
      balance_before, balance_after, user_id, created_at
    ) VALUES
      (gen_random_uuid(), 'health-a', 'HEALTH-A', 'OPENING', CURRENT_DATE, '', 'HEALTH-A', '${ids.productA}', '${ids.warehouseA}', 10, 'HEALTH-KG', 0, 10, '${ids.admin}', now()),
      (gen_random_uuid(), 'health-b', 'SECRET-B', 'OPENING', CURRENT_DATE, '', 'SECRET-B', '${ids.productB}', '${ids.warehouseB}', 99, 'HEALTH-KG', 0, 99, '${ids.admin}', now());
    INSERT INTO stock_opnames (
      id, opname_number, warehouse_id, opname_date, status, snapshot_at,
      snapshot_version, created_by, submitted_at, created_at, updated_at
    ) VALUES
      ('73000000-0000-0000-0000-000000000060', 'HEALTH-OP-A', '${ids.warehouseA}', CURRENT_DATE, 'SUBMITTED', now(), 1, '${ids.admin}', now(), now(), now());
    INSERT INTO stock_opname_items (
      id, opname_id, product_id, system_quantity, unit, unit_price
    ) VALUES
      (gen_random_uuid(), '73000000-0000-0000-0000-000000000060', '${ids.productA}', 9, 'HEALTH-KG', 1);
    INSERT INTO backup_logs (
      id, backup_type, file_name, storage_uri, size_bytes, checksum,
      status, created_by, created_at, verified_at, retained
    ) VALUES
      (gen_random_uuid(), 'DAILY', 'fixture.dump', 'file:///fixture.dump', 100, repeat('a', 64), 'VERIFIED', '${ids.admin}', now(), now(), true);
  `);
  adminCookie = await app.login('health-admin@example.test', password);
  supervisorCookie = await app.login('health-supervisor@example.test', password);
  petugasCookie = await app.login('health-petugas@example.test', password);
});

after(() => app.stop());

test('OPS-007 public health proves database connectivity without internal details', async () => {
  const result = await app.api('/../health');
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  assert.deepEqual(result.body, { success: true, data: { app: 'UP', database: 'UP' } });
  assert.equal(JSON.stringify(result.body).includes('DATABASE_URL'), false);
});

test('detailed health CLI uses persisted actor authorization', () => {
  const output = app.execApp(`
    process.env.HEALTH_ACTOR_ID = '${ids.admin}';
    process.argv[1] = './scripts/health-check.js';
    await import('./scripts/health-check.js');
  `);
  const evidence = JSON.parse(output);
  assert.equal(evidence.status, 'FAIL');
  assert.equal(evidence.checks.schema.status, 'PASS');
  assert.equal(JSON.stringify(evidence).includes('SECRET-B'), false);
});

test('OPS-007 detailed health detects exact scoped inconsistencies', async () => {
  const result = await app.api('/maintenance/health-check', { headers: { cookie: adminCookie } });
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.data.status, 'FAIL');
  assert.equal(result.body.data.checks.schema.status, 'PASS');
  assert.equal(result.body.data.checks.negatives.status, 'PASS');
  assert.equal(result.body.data.checks.backupRpo.status, 'PASS');
  assert.deepEqual(result.body.data.checks.ledgerBalance.issues, [{
    productId: ids.productA, warehouseId: ids.warehouseA,
    ledgerQuantity: '10', balanceQuantity: '9', chainValid: true,
  }]);
  assert.deepEqual(result.body.data.checks.batchBalance.issues, [{
    productId: ids.productA, warehouseId: ids.warehouseA,
    batchQuantity: '8', balanceQuantity: '9',
  }]);
  assert.equal(result.body.data.checks.opnameStates.issues[0].opnameNumber, 'HEALTH-OP-A');
  assert.equal(JSON.stringify(result.body).includes('SECRET-B'), false);
  assert.equal(JSON.stringify(result.body).includes(ids.productB), false);
});

test('audit completeness requires exact Stock Out request reference', async () => {
  app.sql(`
    INSERT INTO stock_out_requests (
      id, idempotency_key, request_hash, transaction_number, transaction_date,
      reference_id, product_id, warehouse_id, quantity, unit, user_id, created_at
    ) VALUES (
      '73000000-0000-0000-0000-000000000070', 'health-out-request', 'health-out-hash',
      'HEALTH-OUT', CURRENT_DATE, 'HEALTH-ISSUE', '${ids.productA}', '${ids.warehouseA}',
      1, 'HEALTH-KG', '${ids.admin}', now()
    );
    INSERT INTO stock_transactions (
      id, idempotency_key, transaction_number, transaction_type, transaction_date,
      request_hash, reference_id, product_id, warehouse_id, quantity, unit,
      balance_before, balance_after, user_id, stock_out_request_id, allocation_index,
      batch_id, unit_price, created_at
    ) VALUES (
      gen_random_uuid(), 'health-out-ledger', 'HEALTH-OUT-1', 'OUT', CURRENT_DATE,
      'health-out-hash', 'HEALTH-ISSUE', '${ids.productA}', '${ids.warehouseA}',
      -1, 'HEALTH-KG', 10, 9, '${ids.admin}',
      '73000000-0000-0000-0000-000000000070', 1,
      (SELECT id FROM stock_batches WHERE batch_number = 'HEALTH-BATCH'), 1, now()
    );
    INSERT INTO audit_logs (id, timestamp, user_id, action, module, reference, details)
    VALUES (
      gen_random_uuid(), now(), '${ids.admin}', 'STOCK_OUT', 'INVENTORY',
      '73000000-0000-0000-0000-000000000071',
      '{"productId":"${ids.productA}","warehouseId":"${ids.warehouseA}"}'::jsonb
    );
  `);
  const result = await app.api('/maintenance/health-check', { headers: { cookie: adminCookie } });
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  assert.ok(result.body.data.checks.auditCompleteness.issues.some(
    (issue) => issue.transactionNumber === 'HEALTH-OUT-1',
  ));
});

test('detailed health allows supervisor and denies petugas or anonymous', async () => {
  assert.equal((await app.api('/maintenance/health-check', { headers: { cookie: supervisorCookie } })).response.status, 200);
  const forbidden = await app.api('/maintenance/health-check', { headers: { cookie: petugasCookie } });
  assert.equal(forbidden.response.status, 403);
  assert.equal(forbidden.body.errorCode, 'FORBIDDEN');
  const anonymous = await app.api('/maintenance/health-check');
  assert.equal(anonymous.response.status, 401);
  assert.equal(anonymous.body.errorCode, 'UNAUTHENTICATED');
});

test('OPS-005 backup RPO uses only retained verified backups and enforces 24 hours', async () => {
  app.sql("UPDATE backup_logs SET verified_at = now() - interval '23 hours 59 minutes', retained = false");
  const unavailable = await app.api('/maintenance/health-check', { headers: { cookie: adminCookie } });
  assert.equal(unavailable.body.data.checks.backupRpo.status, 'FAIL');
  assert.equal(unavailable.body.data.checks.backupRpo.issues[0].issue, 'NO_VERIFIED_BACKUP');
  app.sql('UPDATE backup_logs SET retained = true');
  const within = await app.api('/maintenance/health-check', { headers: { cookie: adminCookie } });
  assert.equal(within.body.data.checks.backupRpo.status, 'PASS');
  app.sql("UPDATE backup_logs SET verified_at = now() - interval '24 hours 1 minute'");
  const exceeded = await app.api('/maintenance/health-check', { headers: { cookie: adminCookie } });
  assert.equal(exceeded.body.data.checks.backupRpo.status, 'FAIL');
  assert.equal(exceeded.body.data.checks.backupRpo.issues[0].issue, 'RPO_EXCEEDED');
});

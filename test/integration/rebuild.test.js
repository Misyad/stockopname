import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { integrationApp, passwordHash } from '../helpers/integration-app.js';

const app = integrationApp('stock_rebuild');
const password = 'correct horse battery staple';
const ids = {
  regionA: '75000000-0000-0000-0000-000000000001',
  regionB: '75000000-0000-0000-0000-000000000002',
  admin: '75000000-0000-0000-0000-000000000010',
  supervisor: '75000000-0000-0000-0000-000000000011',
  category: '75000000-0000-0000-0000-000000000020',
  unit: '75000000-0000-0000-0000-000000000030',
  warehouseA: '75000000-0000-0000-0000-000000000040',
  warehouseB: '75000000-0000-0000-0000-000000000041',
  productA: '75000000-0000-0000-0000-000000000050',
  productB: '75000000-0000-0000-0000-000000000051',
  productUnsafe: '75000000-0000-0000-0000-000000000052',
};
let admin;
let supervisor;

async function session(email) {
  const cookie = await app.login(email, password);
  const csrf = await app.api('/auth/csrf', { headers: { cookie } });
  return { cookie, csrf: csrf.body.data.csrfToken };
}

function rebuild(value, csrf = value.csrf, origin = app.env.APP_ORIGIN) {
  return app.api('/maintenance/rebuild-balances', {
    method: 'POST',
    headers: {
      cookie: value.cookie, origin, 'x-csrf-token': csrf, 'content-type': 'application/json',
    },
    body: '{}',
  });
}

before(async () => {
  await app.start();
  app.sql(`
    INSERT INTO regions (id, code, name, status) VALUES
      ('${ids.regionA}', 'REBUILD-A', 'Rebuild A', 'ACTIVE'),
      ('${ids.regionB}', 'REBUILD-B', 'Rebuild B', 'ACTIVE');
    INSERT INTO users (id, name, email, password_hash, role, status, region_id) VALUES
      ('${ids.admin}', 'Rebuild Admin', 'rebuild-admin@example.test', '${passwordHash(password)}', 'ADMIN', 'ACTIVE', '${ids.regionA}'),
      ('${ids.supervisor}', 'Rebuild Supervisor', 'rebuild-supervisor@example.test', '${passwordHash(password)}', 'SUPERVISOR', 'ACTIVE', '${ids.regionA}');
    INSERT INTO categories (id, code, name, status)
      VALUES ('${ids.category}', 'REBUILD-CAT', 'Rebuild Category', 'ACTIVE');
    INSERT INTO units (id, code, name, symbol, conversion_to_base, status)
      VALUES ('${ids.unit}', 'REBUILD-KG', 'Kilogram', 'kg', 1, 'ACTIVE');
    INSERT INTO warehouses (id, code, name, status, region_id) VALUES
      ('${ids.warehouseA}', 'REBUILD-WH-A', 'Rebuild Warehouse A', 'ACTIVE', '${ids.regionA}'),
      ('${ids.warehouseB}', 'REBUILD-WH-B', 'Rebuild Warehouse B', 'ACTIVE', '${ids.regionB}');
    INSERT INTO products (id, code, name, category_id, base_unit_id, conversion_factor, status) VALUES
      ('${ids.productA}', 'REBUILD-P-A', 'Rebuild Product A', '${ids.category}', '${ids.unit}', 1, 'ACTIVE'),
      ('${ids.productB}', 'REBUILD-P-B', 'Rebuild Product B', '${ids.category}', '${ids.unit}', 1, 'ACTIVE'),
      ('${ids.productUnsafe}', 'REBUILD-P-X', 'Rebuild Product Unsafe', '${ids.category}', '${ids.unit}', 1, 'ACTIVE');
    INSERT INTO stock_batches (id, product_id, warehouse_id, batch_number, quantity, unit, purchase_price, status) VALUES
      (gen_random_uuid(), '${ids.productA}', '${ids.warehouseA}', 'RB-A', 10, 'REBUILD-KG', 1, 'ACTIVE'),
      (gen_random_uuid(), '${ids.productB}', '${ids.warehouseB}', 'RB-B', 30, 'REBUILD-KG', 1, 'ACTIVE');
    INSERT INTO stock_balances (id, product_id, warehouse_id, quantity, version) VALUES
      (gen_random_uuid(), '${ids.productA}', '${ids.warehouseA}', 9, 1),
      (gen_random_uuid(), '${ids.productB}', '${ids.warehouseB}', 29, 1);
    INSERT INTO stock_transactions (
      id, idempotency_key, transaction_number, transaction_type, transaction_date,
      request_hash, reference_id, product_id, warehouse_id, quantity, unit,
      balance_before, balance_after, user_id, created_at
    ) VALUES
      (gen_random_uuid(), 'rebuild-a', 'REBUILD-A', 'OPENING', CURRENT_DATE, '', 'REBUILD-A', '${ids.productA}', '${ids.warehouseA}', 10, 'REBUILD-KG', 0, 10, '${ids.admin}', now()),
      (gen_random_uuid(), 'rebuild-b', 'REBUILD-B', 'OPENING', CURRENT_DATE, '', 'REBUILD-B', '${ids.productB}', '${ids.warehouseB}', 30, 'REBUILD-KG', 0, 30, '${ids.admin}', now());
  `);
  admin = await session('rebuild-admin@example.test');
  supervisor = await session('rebuild-supervisor@example.test');
});

after(() => app.stop());

test('rebuild refuses mutation without latest VERIFIED backup at most 24 hours old', async () => {
  const result = await rebuild(admin);
  assert.equal(result.response.status, 409, JSON.stringify(result.body));
  assert.equal(result.body.errorCode, 'PRE_REBUILD_BACKUP_REQUIRED');
  assert.equal(app.sql(`SELECT quantity FROM stock_balances WHERE product_id = '${ids.productA}'`), '9');
  app.sql(`
    INSERT INTO backup_logs (
      id, backup_type, file_name, storage_uri, size_bytes, checksum,
      status, created_by, created_at, verified_at
    ) VALUES (
      gen_random_uuid(), 'DAILY', 'healthy.dump', 'file:///healthy.dump', 1,
      repeat('a', 64), 'VERIFIED', '${ids.admin}', now(), now()
    );
  `);
});

test('rebuild repairs only actor region from immutable ledger and writes audit', async () => {
  const result = await rebuild(admin);
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.data.status, 'REBUILT');
  assert.equal(result.body.data.rebuiltCount, 1);
  assert.equal(app.sql(`SELECT quantity FROM stock_balances WHERE product_id = '${ids.productA}'`), '10');
  assert.equal(app.sql(`SELECT quantity FROM stock_balances WHERE product_id = '${ids.productB}'`), '29');
  assert.equal(app.sql(`SELECT count(*) FROM audit_logs WHERE action = 'BALANCE_REBUILT' AND user_id = '${ids.admin}'`), '1');
});

test('rebuild exclusive maintenance lock waits for active stock writer', () => {
  assert.equal(app.execApp(`
    import assert from 'node:assert/strict';
    import { pool } from './src/db/pool.js';
    import { rebuildBalances } from './src/services/rebuild.js';
    const writer = await pool.connect();
    await writer.query('BEGIN');
    await writer.query("SELECT pg_advisory_xact_lock_shared(hashtextextended('stock-maintenance', 0))");
    let settled = false;
    const work = rebuildBalances(pool, { userId: '${ids.admin}' }).finally(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(settled, false);
    await writer.query('COMMIT');
    writer.release();
    await work;
    await pool.end();
    console.log('LOCKED');
  `), 'LOCKED');
});

test('stock writer waits for exclusive maintenance lock instead of overlapping rebuild', () => {
  assert.equal(app.execApp(`
    import assert from 'node:assert/strict';
    import { pool } from './src/db/pool.js';
    import { createStockIn } from './src/services/transactions.js';
    const maintenance = await pool.connect();
    await maintenance.query('BEGIN');
    await maintenance.query("SELECT pg_advisory_xact_lock(hashtextextended('stock-maintenance', 0))");
    let settled = false;
    const work = createStockIn(pool, { userId: '${ids.admin}' }, {
      idempotencyKey: 'writer-after-exclusive-lock',
      date: '2026-10-22', reference: 'WRITER-AFTER-REBUILD',
      warehouse: 'REBUILD-WH-A', code: 'REBUILD-P-A',
      batch: 'RB-WRITER', quantity: '1', unit: 'REBUILD-KG', price: '1',
    }).finally(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(settled, false);
    await maintenance.query('COMMIT');
    maintenance.release();
    const result = await work;
    assert.equal(result.quantity, '1');
    await pool.end();
    console.log('WRITER_WAITED');
  `), 'WRITER_WAITED');
  assert.equal(app.sql(`SELECT quantity FROM stock_balances WHERE product_id = '${ids.productA}'`), '11');
});

test('unsafe ledger leaves original balance cache intact', async () => {
  const auditCountBefore = app.sql("SELECT count(*) FROM audit_logs WHERE action = 'BALANCE_REBUILT'");
  app.sql(`
    INSERT INTO stock_batches (id, product_id, warehouse_id, batch_number, quantity, unit, purchase_price, status)
      VALUES (gen_random_uuid(), '${ids.productUnsafe}', '${ids.warehouseA}', 'RB-X', 4, 'REBUILD-KG', 1, 'ACTIVE');
    INSERT INTO stock_balances (id, product_id, warehouse_id, quantity, version)
      VALUES (gen_random_uuid(), '${ids.productUnsafe}', '${ids.warehouseA}', 4, 1);
    INSERT INTO stock_transactions (
      id, idempotency_key, transaction_number, transaction_type, transaction_date,
      request_hash, reference_id, product_id, warehouse_id, quantity, unit,
      balance_before, balance_after, user_id, created_at
    ) VALUES (
      gen_random_uuid(), 'rebuild-invalid', 'REBUILD-INVALID', 'OPENING', CURRENT_DATE,
      '', 'REBUILD-INVALID', '${ids.productUnsafe}', '${ids.warehouseA}', 5,
      'REBUILD-KG', 0, 4, '${ids.admin}', now()
    );
  `);
  const result = await rebuild(admin);
  assert.equal(result.response.status, 409, JSON.stringify(result.body));
  assert.equal(result.body.errorCode, 'LEDGER_INVALID');
  assert.equal(app.sql(`SELECT quantity FROM stock_balances WHERE product_id = '${ids.productUnsafe}'`), '4');
  assert.equal(app.sql("SELECT count(*) FROM audit_logs WHERE action = 'BALANCE_REBUILT'"), auditCountBefore);
});

test('rebuild endpoint enforces ADMIN role, session, Origin, and CSRF', async () => {
  assert.equal((await app.api('/maintenance/rebuild-balances', { method: 'POST' })).response.status, 401);
  assert.equal((await rebuild(admin, admin.csrf, 'https://invalid.example')).response.status, 403);
  assert.equal((await rebuild(admin, 'wrong')).response.status, 403);
  const forbidden = await rebuild(supervisor);
  assert.equal(forbidden.response.status, 403);
  assert.equal(forbidden.body.errorCode, 'FORBIDDEN');
});

test('rebuild applies Origin, CSRF, RBAC, then representation validation', async () => {
  const before = app.sql("SELECT count(*) FROM audit_logs WHERE action = 'BALANCE_REBUILT'");
  const request = (origin, csrf, contentType = 'application/json', body = '{}') => app.api(
    '/maintenance/rebuild-balances',
    {
      method: 'POST',
      headers: {
        cookie: supervisor.cookie,
        origin,
        'x-csrf-token': csrf,
        'content-type': contentType,
      },
      body,
    },
  );
  const cases = [
    [await request('https://invalid.example', supervisor.csrf), 'ORIGIN_INVALID'],
    [await request(app.env.APP_ORIGIN, 'wrong'), 'CSRF_INVALID'],
    [await request(app.env.APP_ORIGIN, supervisor.csrf, 'text/plain'), 'FORBIDDEN'],
    [await request(app.env.APP_ORIGIN, supervisor.csrf, 'application/json', '{'), 'FORBIDDEN'],
    [await request(app.env.APP_ORIGIN, supervisor.csrf), 'FORBIDDEN'],
  ];
  for (const [result, errorCode] of cases) {
    assert.equal(result.response.status, 403, JSON.stringify(result.body));
    assert.equal(result.body.errorCode, errorCode);
  }
  assert.equal(app.sql("SELECT count(*) FROM audit_logs WHERE action = 'BALANCE_REBUILT'"), before);
});

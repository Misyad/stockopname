import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { integrationApp, passwordHash } from '../helpers/integration-app.js';

const app = integrationApp('stock_dashboard');
const password = 'correct horse battery staple';
const ids = {
  regionA: '71000000-0000-0000-0000-000000000001',
  regionB: '71000000-0000-0000-0000-000000000002',
  admin: '71000000-0000-0000-0000-000000000010',
  petugas: '71000000-0000-0000-0000-000000000011',
  category: '71000000-0000-0000-0000-000000000020',
  unit: '71000000-0000-0000-0000-000000000030',
  warehouseA: '71000000-0000-0000-0000-000000000040',
  warehouseB: '71000000-0000-0000-0000-000000000041',
  safe: '71000000-0000-0000-0000-000000000050',
  low: '71000000-0000-0000-0000-000000000051',
  out: '71000000-0000-0000-0000-000000000052',
  secret: '71000000-0000-0000-0000-000000000053',
};
let adminCookie;
let petugasCookie;

before(async () => {
  await app.start();
  app.sql(`
    INSERT INTO regions (id, code, name, status) VALUES
      ('${ids.regionA}', 'DASH-A', 'Dashboard Region A', 'ACTIVE'),
      ('${ids.regionB}', 'DASH-B', 'Dashboard Region B', 'ACTIVE');
    INSERT INTO users (id, name, email, password_hash, role, status, region_id) VALUES
      ('${ids.admin}', 'Dashboard Admin', 'dashboard-admin@example.test', '${passwordHash(password)}', 'ADMIN', 'ACTIVE', '${ids.regionA}'),
      ('${ids.petugas}', 'Dashboard Petugas', 'dashboard-petugas@example.test', '${passwordHash(password)}', 'PETUGAS', 'ACTIVE', '${ids.regionA}');
    INSERT INTO categories (id, code, name, status)
      VALUES ('${ids.category}', 'DASH-CAT', 'Dashboard Category', 'ACTIVE');
    INSERT INTO units (id, code, name, symbol, conversion_to_base, status)
      VALUES ('${ids.unit}', 'DASH-KG', 'Kilogram', 'kg', 1, 'ACTIVE');
    INSERT INTO warehouses (id, code, name, status, region_id) VALUES
      ('${ids.warehouseA}', 'DASH-WH-A', 'Dashboard Warehouse A', 'ACTIVE', '${ids.regionA}'),
      ('${ids.warehouseB}', 'DASH-WH-B', 'Dashboard Warehouse B', 'ACTIVE', '${ids.regionB}');
    INSERT INTO products (
      id, code, name, category_id, base_unit_id, conversion_factor,
      minimum_stock, maximum_stock, status
    ) VALUES
      ('${ids.safe}', 'DASH-SAFE', 'Safe Product', '${ids.category}', '${ids.unit}', 1, 5, 100, 'ACTIVE'),
      ('${ids.low}', 'DASH-LOW', 'Low Product', '${ids.category}', '${ids.unit}', 1, 5, 100, 'ACTIVE'),
      ('${ids.out}', 'DASH-OUT', 'Out Product', '${ids.category}', '${ids.unit}', 1, 5, 100, 'ACTIVE'),
      ('${ids.secret}', 'SECRET-B', 'Secret Product', '${ids.category}', '${ids.unit}', 1, 5, 100, 'ACTIVE');
    INSERT INTO stock_balances (id, product_id, warehouse_id, quantity, version) VALUES
      (gen_random_uuid(), '${ids.safe}', '${ids.warehouseA}', 10, 1),
      (gen_random_uuid(), '${ids.low}', '${ids.warehouseA}', 3, 1),
      (gen_random_uuid(), '${ids.out}', '${ids.warehouseA}', 0, 1),
      (gen_random_uuid(), '${ids.secret}', '${ids.warehouseB}', 999, 1);
    INSERT INTO stock_batches (
      id, product_id, warehouse_id, batch_number, expiry_date, quantity, unit, purchase_price, status
    ) VALUES
      (gen_random_uuid(), '${ids.safe}', '${ids.warehouseA}', 'DASH-EXPIRED', CURRENT_DATE - 1, 2, 'DASH-KG', 1, 'ACTIVE'),
      (gen_random_uuid(), '${ids.safe}', '${ids.warehouseA}', 'DASH-7D', CURRENT_DATE + 7, 3, 'DASH-KG', 1, 'ACTIVE'),
      (gen_random_uuid(), '${ids.safe}', '${ids.warehouseA}', 'DASH-30D', CURRENT_DATE + 30, 5, 'DASH-KG', 1, 'ACTIVE'),
      (gen_random_uuid(), '${ids.secret}', '${ids.warehouseB}', 'SECRET-EXPIRY', CURRENT_DATE + 1, 999, 'DASH-KG', 1, 'ACTIVE');
    INSERT INTO stock_transactions (
      id, idempotency_key, transaction_number, transaction_type, transaction_date,
      request_hash, reference_id, product_id, warehouse_id, quantity, unit,
      balance_before, balance_after, reason, user_id, created_at
    ) VALUES
      (gen_random_uuid(), 'dashboard-opening', 'OPEN-DASH', 'OPENING', CURRENT_DATE - 2, '', 'OPEN-DASH', '${ids.safe}', '${ids.warehouseA}', 10, 'DASH-KG', 0, 10, NULL, '${ids.admin}', now() - interval '2 days'),
      (gen_random_uuid(), 'dashboard-adjustment', 'ADJ-DASH', 'ADJUSTMENT', CURRENT_DATE - 1, '', 'ADJ-DASH', '${ids.low}', '${ids.warehouseA}', -2, 'DASH-KG', 5, 3, 'Count difference', '${ids.admin}', now() - interval '1 day'),
      (gen_random_uuid(), 'dashboard-secret', 'SECRET-B', 'OPENING', CURRENT_DATE, '', 'SECRET-B', '${ids.secret}', '${ids.warehouseB}', 999, 'DASH-KG', 0, 999, NULL, '${ids.admin}', now());
    INSERT INTO stock_opnames (
      id, opname_number, warehouse_id, opname_date, status, snapshot_at,
      snapshot_version, created_by, created_at, updated_at
    ) VALUES
      (gen_random_uuid(), 'OP-DASH-PENDING', '${ids.warehouseA}', CURRENT_DATE, 'SUBMITTED', now(), 1, '${ids.admin}', now(), now()),
      (gen_random_uuid(), 'OP-DASH-DONE', '${ids.warehouseA}', CURRENT_DATE, 'APPROVED', now(), 1, '${ids.admin}', now(), now()),
      (gen_random_uuid(), 'SECRET-B', '${ids.warehouseB}', CURRENT_DATE, 'SUBMITTED', now(), 1, '${ids.admin}', now(), now());
  `);
  adminCookie = await app.login('dashboard-admin@example.test', password);
  petugasCookie = await app.login('dashboard-petugas@example.test', password);
});

after(() => app.stop());

async function dashboard(cookie) {
  return app.api('/dashboard', { headers: { cookie } });
}

test('DASH-001 dashboard aggregate matches regional fixture and remains bounded', async () => {
  const result = await dashboard(adminCookie);
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  assert.deepEqual({ ...result.body.data, recent_transactions: undefined }, {
    total_products: 3,
    total_stock: '13',
    safe: 1,
    low: 1,
    out: 1,
    expired: 1,
    expiring_7d: 1,
    expiring_30d: 1,
    pending_opnames: 1,
    recent_transactions: undefined,
    total_adjustment: '2',
  });
  assert.deepEqual(
    result.body.data.recent_transactions.map(({ transactionType, reference }) => ({ transactionType, reference })),
    [
      { transactionType: 'ADJUSTMENT', reference: 'ADJ-DASH' },
      { transactionType: 'OPENING', reference: 'OPEN-DASH' },
    ],
  );
  assert.equal(JSON.stringify(result.body).includes('SECRET-B'), false);
  assert.ok(result.body.data.recent_transactions.length <= 10);
});

test('DASH-002 every authenticated role can read dashboard; unauthenticated cannot', async () => {
  assert.equal((await dashboard(petugasCookie)).response.status, 200);
  const missing = await dashboard('');
  assert.equal(missing.response.status, 401);
  assert.equal(missing.body.errorCode, 'UNAUTHENTICATED');
});

test('DASH-003 dashboard route accepts GET only and has no mutation control', async () => {
  const result = await app.api('/dashboard', { method: 'POST', headers: { cookie: adminCookie } });
  assert.equal(result.response.status, 404);
});

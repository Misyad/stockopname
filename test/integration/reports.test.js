import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { integrationApp, passwordHash } from '../helpers/integration-app.js';

const app = integrationApp('stock_reports');
const password = 'correct horse battery staple';
const ids = {
  regionA: '72000000-0000-0000-0000-000000000001',
  regionB: '72000000-0000-0000-0000-000000000002',
  admin: '72000000-0000-0000-0000-000000000010',
  category: '72000000-0000-0000-0000-000000000020',
  unit: '72000000-0000-0000-0000-000000000030',
  supplier: '72000000-0000-0000-0000-000000000035',
  warehouseA: '72000000-0000-0000-0000-000000000040',
  warehouseB: '72000000-0000-0000-0000-000000000041',
  productA: '72000000-0000-0000-0000-000000000050',
  productB: '72000000-0000-0000-0000-000000000051',
  batchA: '72000000-0000-0000-0000-000000000060',
  opnameA: '72000000-0000-0000-0000-000000000070',
};
let cookie;

before(async () => {
  await app.start();
  app.sql(`
    INSERT INTO regions (id, code, name, status) VALUES
      ('${ids.regionA}', 'REPORT-A', 'Report Region A', 'ACTIVE'),
      ('${ids.regionB}', 'REPORT-B', 'Report Region B', 'ACTIVE');
    INSERT INTO users (id, name, email, password_hash, role, status, region_id)
      VALUES ('${ids.admin}', 'Report Admin', 'report-admin@example.test', '${passwordHash(password)}', 'ADMIN', 'ACTIVE', '${ids.regionA}');
    INSERT INTO categories (id, code, name, status)
      VALUES ('${ids.category}', 'REPORT-CAT', 'Report Category', 'ACTIVE');
    INSERT INTO units (id, code, name, symbol, conversion_to_base, status)
      VALUES ('${ids.unit}', 'REPORT-KG', 'Kilogram', 'kg', 1, 'ACTIVE');
    INSERT INTO suppliers (id, code, name, status)
      VALUES ('${ids.supplier}', 'REPORT-SUP', 'Report Supplier', 'ACTIVE');
    INSERT INTO warehouses (id, code, name, status, region_id) VALUES
      ('${ids.warehouseA}', 'REPORT-WH-A', 'Report Warehouse A', 'ACTIVE', '${ids.regionA}'),
      ('${ids.warehouseB}', 'REPORT-WH-B', 'Report Warehouse B', 'ACTIVE', '${ids.regionB}');
    INSERT INTO products (
      id, code, name, category_id, base_unit_id, conversion_factor,
      minimum_stock, maximum_stock, status
    ) VALUES
      ('${ids.productA}', 'REPORT-P-A', '=Formula Product', '${ids.category}', '${ids.unit}', 1, 5, 100, 'ACTIVE'),
      ('${ids.productB}', 'SECRET-B', 'Secret Product', '${ids.category}', '${ids.unit}', 1, 5, 100, 'ACTIVE');
    INSERT INTO stock_balances (id, product_id, warehouse_id, quantity, version) VALUES
      (gen_random_uuid(), '${ids.productA}', '${ids.warehouseA}', 7, 3),
      (gen_random_uuid(), '${ids.productB}', '${ids.warehouseB}', 99, 1);
    INSERT INTO stock_batches (
      id, product_id, warehouse_id, batch_number, expiry_date, quantity, unit, purchase_price, status
    ) VALUES
      ('${ids.batchA}', '${ids.productA}', '${ids.warehouseA}', 'REPORT-BATCH', CURRENT_DATE + 7, 7, 'REPORT-KG', 4, 'ACTIVE'),
      (gen_random_uuid(), '${ids.productB}', '${ids.warehouseB}', 'SECRET-B', CURRENT_DATE + 7, 99, 'REPORT-KG', 1, 'ACTIVE');
    INSERT INTO stock_transactions (
      id, idempotency_key, transaction_number, transaction_type, transaction_date,
      request_hash, reference_id, product_id, warehouse_id, batch_id, supplier_id,
      quantity, unit, balance_before, balance_after, reason, user_id, created_at
    ) VALUES
      (gen_random_uuid(), 'report-in', 'IN-REPORT', 'IN', '2026-10-20', '', 'IN-REF', '${ids.productA}', '${ids.warehouseA}', '${ids.batchA}', '${ids.supplier}', 10, 'REPORT-KG', 0, 10, NULL, '${ids.admin}', '2026-10-20T01:00:00Z'),
      (gen_random_uuid(), 'report-out', 'OUT-REPORT', 'OUT', '2026-10-21', '', 'OUT-REF', '${ids.productA}', '${ids.warehouseA}', '${ids.batchA}', NULL, -2, 'REPORT-KG', 10, 8, NULL, '${ids.admin}', '2026-10-21T01:00:00Z'),
      (gen_random_uuid(), 'report-adjustment', 'ADJ-REPORT', 'ADJUSTMENT', '2026-10-22', '', '+Formula Ref', '${ids.productA}', '${ids.warehouseA}', '${ids.batchA}', NULL, -1, 'REPORT-KG', 8, 7, 'Count', '${ids.admin}', '2026-10-22T01:00:00Z'),
      (gen_random_uuid(), 'report-secret', 'SECRET-B', 'IN', '2026-10-22', '', 'SECRET-B', '${ids.productB}', '${ids.warehouseB}', NULL, NULL, 99, 'REPORT-KG', 0, 99, NULL, '${ids.admin}', '2026-10-22T02:00:00Z');
    INSERT INTO stock_opnames (
      id, opname_number, warehouse_id, opname_date, status, snapshot_at,
      snapshot_version, created_by, submitted_at, approved_by, approved_at, created_at, updated_at
    ) VALUES
      ('${ids.opnameA}', 'OP-REPORT', '${ids.warehouseA}', '2026-10-22', 'APPROVED', '2026-10-22T00:00:00Z', 2, '${ids.admin}', '2026-10-22T01:00:00Z', '${ids.admin}', '2026-10-22T02:00:00Z', now(), now()),
      (gen_random_uuid(), 'SECRET-B', '${ids.warehouseB}', '2026-10-22', 'APPROVED', now(), 1, '${ids.admin}', now(), '${ids.admin}', now(), now(), now());
    INSERT INTO stock_opname_items (
      id, opname_id, product_id, batch_id, system_quantity, physical_quantity,
      difference, difference_value, unit, unit_price, reason
    ) VALUES
      (gen_random_uuid(), '${ids.opnameA}', '${ids.productA}', '${ids.batchA}', 8, 7, -1, -4, 'REPORT-KG', 4, 'Count'),
      (gen_random_uuid(), (SELECT id FROM stock_opnames WHERE opname_number = 'SECRET-B'), '${ids.productB}', NULL, 99, 99, 0, 0, 'REPORT-KG', 1, NULL);
  `);
  cookie = await app.login('report-admin@example.test', password);
});

after(() => app.stop());

async function report(type, query = '') {
  return app.api(`/reports/${type}${query}`, { headers: { cookie } });
}

test('REPORT-001 all approved report types are paginated and region scoped', async () => {
  for (const type of ['STOCK', 'STOCK_CARD', 'IN', 'OUT', 'ADJUSTMENT', 'OPNAME', 'OPNAME_DIFFERENCE', 'BATCH_EXPIRY']) {
    const product = type === 'STOCK_CARD' ? `&product_id=${ids.productA}` : '';
    const result = await report(type, `?page=1&limit=50${product}`);
    assert.equal(result.response.status, 200, `${type}: ${JSON.stringify(result.body)}`);
    assert.equal(result.body.data.page, 1);
    assert.equal(result.body.data.limit, 50);
    assert.equal(Array.isArray(result.body.data.items), true);
    assert.equal(JSON.stringify(result.body).includes('SECRET-B'), false, type);
  }
});

test('REPORT-002 filters select exact ledger subsets', async () => {
  const incoming = await report('IN', `?from=2026-10-20&to=2026-10-20&product_id=${ids.productA}&category_id=${ids.category}&warehouse_id=${ids.warehouseA}&supplier_id=${ids.supplier}`);
  assert.equal(incoming.response.status, 200, JSON.stringify(incoming.body));
  assert.equal(incoming.body.data.total, 1);
  assert.equal(incoming.body.data.items[0].reference, 'IN-REF');

  const noMatch = await report('OUT', '?from=2026-10-20&to=2026-10-20');
  assert.equal(noMatch.body.data.total, 0);

  const opname = await report('OPNAME', '?status=APPROVED&from=2026-10-22&to=2026-10-22');
  assert.equal(opname.body.data.total, 1);
});

test('OPNAME summary pagination returns one row per opname when product has multiple batches', async () => {
  app.sql(`
    WITH batch AS (
      INSERT INTO stock_batches (
        id, product_id, warehouse_id, batch_number, quantity, unit, purchase_price, status
      ) VALUES (
        gen_random_uuid(), '${ids.productA}', '${ids.warehouseA}', 'REPORT-BATCH-2',
        0, 'REPORT-KG', 4, 'DEPLETED'
      ) RETURNING id
    )
    INSERT INTO stock_opname_items (
      id, opname_id, product_id, batch_id, system_quantity, physical_quantity,
      difference, difference_value, unit, unit_price, reason
    ) SELECT gen_random_uuid(), '${ids.opnameA}', '${ids.productA}', id,
      0, 0, 0, 0, 'REPORT-KG', 4, NULL FROM batch;
  `);
  const result = await report('OPNAME', `?product_id=${ids.productA}&page=1&limit=50`);
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.data.total, 1);
  assert.equal(result.body.data.items.length, 1);
});

test('REPORT-003 report validation and explicit cross-region warehouse fail safely', async () => {
  assert.equal((await report('UNKNOWN')).response.status, 400);
  assert.equal((await report('IN', '?limit=501')).response.status, 400);
  assert.equal((await report('IN', '?from=2026-02-30')).response.status, 400);
  const forbidden = await report('STOCK', `?warehouse_id=${ids.warehouseB}`);
  assert.equal(forbidden.response.status, 403);
  assert.equal(forbidden.body.errorCode, 'REGION_FORBIDDEN');
});

test('REPORT-004 CSV export streams UTF-8 and neutralizes spreadsheet formulas', async () => {
  const result = await report('ADJUSTMENT', '?format=CSV');
  assert.equal(result.response.status, 200, String(result.body));
  assert.match(result.response.headers.get('content-type'), /^text\/csv; charset=utf-8/i);
  assert.equal(result.response.headers.get('content-length'), null);
  assert.match(result.body, /'\+Formula Ref/);
  assert.match(result.body, /'=Formula Product/);
  assert.equal(result.body.includes('SECRET-B'), false);
});

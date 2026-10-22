import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { api, ids, setup, sql, teardown } from './report-fixture.js';

let sessions;
before(async () => {
  sessions = await setup('stock_reports');
  sql(`
    UPDATE suppliers SET name = ' =FORMULA SUPPLIER' WHERE id = '${ids.supplier}';
    INSERT INTO stock_opname_items (
      id, opname_id, product_id, batch_id, system_quantity, physical_quantity,
      difference, difference_value, unit, unit_price
    ) VALUES (
      '68000000-0000-4000-8000-000000000081', '${ids.opnameA}', '${ids.low}',
      '${ids.lowBatch}', 5, 5, 0, 0, 'RPT-KG', 3
    );
  `);
});
after(teardown);

async function report(path, cookie = sessions.admin) {
  return api(path, { headers: { cookie } });
}

test('all report types are authenticated, paginated, and region-scoped', async () => {
  assert.equal((await api('/reports/STOCK')).response.status, 401);
  const expected = {
    STOCK: 3,
    STOCK_CARD: 4,
    IN: 1,
    OUT: 1,
    ADJUSTMENT: 1,
    OPNAME: 1,
    OPNAME_DIFFERENCE: 1,
    BATCH_EXPIRY: 2,
  };
  for (const [type, total] of Object.entries(expected)) {
    const result = await report(`/reports/${type}?page=1&limit=500`, sessions.petugas);
    assert.equal(result.response.status, 200, `${type}: ${JSON.stringify(result.body)}`);
    assert.equal(result.body.data.total, total, type);
    assert.equal(result.body.data.page, 1, type);
    assert.equal(result.body.data.limit, 500, type);
    assert.ok(result.body.data.items.every((item) => item.warehouseId === ids.warehouseA), type);
  }
});

test('report filters and pagination return exact subsets', async () => {
  const cases = [
    ['/reports/STOCK?product_id=' + ids.low, 1, 'RPT-LOW'],
    ['/reports/STOCK?category_id=' + ids.category + '&warehouse_id=' + ids.warehouseA, 3, 'RPT-SAFE'],
    ['/reports/STOCK_CARD?from=2026-10-03&to=2026-10-04&product_id=' + ids.safe, 2, 'RPT-OUT'],
    ['/reports/IN?supplier_id=' + ids.supplier, 1, 'RPT-IN'],
    ['/reports/OPNAME?status=SUBMITTED&warehouse_id=' + ids.warehouseA, 1, 'RPT-OP-A'],
    ['/reports/OPNAME?category_id=' + ids.category, 1, 'RPT-OP-A'],
    ['/reports/BATCH_EXPIRY?status=EXPIRED', 1, 'RPT-LOW'],
  ];
  for (const [path, total, marker] of cases) {
    const result = await report(path);
    assert.equal(result.response.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.data.total, total, path);
    assert.match(JSON.stringify(result.body.data.items), new RegExp(marker), path);
  }
  const first = await report('/reports/STOCK_CARD?page=1&limit=2');
  assert.equal(first.body.data.items.length, 2);
  assert.equal(first.body.data.hasNext, true);
  const second = await report('/reports/STOCK_CARD?page=2&limit=2');
  assert.equal(second.body.data.items.length, 2);
  assert.equal(second.body.data.hasNext, false);
  for (const path of ['/reports/STOCK?limit=501', '/reports/UNKNOWN', '/reports/IN?from=2026-11-01&to=2026-10-01']) {
    assert.equal((await report(path)).response.status, 400, path);
  }
});

test('cross-region warehouse report filter is denied before JSON and CSV output', async () => {
  const result = await report(`/reports/STOCK?warehouse_id=${ids.warehouseB}`);
  assert.equal(result.response.status, 403);
  assert.equal(result.body.errorCode, 'REGION_FORBIDDEN');
  const exported = await report(`/reports/STOCK/export?format=CSV&warehouse_id=${ids.warehouseB}`);
  assert.equal(exported.response.status, 403);
  assert.equal(exported.body.errorCode, 'REGION_FORBIDDEN');
});

test('CSV export streams with active filters and escapes formula-leading cells', async () => {
  const result = await report(`/reports/IN/export?format=CSV&supplier_id=${ids.supplier}`);
  assert.equal(result.response.status, 200, String(result.body));
  assert.match(result.response.headers.get('content-type'), /^text\/csv/);
  assert.match(result.response.headers.get('content-disposition'), /^attachment; filename="in-/);
  assert.equal(result.response.headers.has('content-length'), false);
  assert.match(result.body, /RPT-IN/);
  assert.doesNotMatch(result.body, /\n[=+\-@]/);
  assert.match(result.body, /' =FORMULA SUPPLIER/);
  assert.match(result.body, /'=SUM\(1,1\)/);
  assert.doesNotMatch(result.body, /RPT-FOREIGN/);
});

test('CSV supports every report type and rejects unsupported format', async () => {
  for (const type of ['STOCK', 'STOCK_CARD', 'IN', 'OUT', 'ADJUSTMENT', 'OPNAME', 'OPNAME_DIFFERENCE', 'BATCH_EXPIRY']) {
    const result = await report(`/reports/${type}/export?format=CSV`);
    assert.equal(result.response.status, 200, `${type}: ${String(result.body).slice(0, 100)}`);
    assert.match(result.response.headers.get('content-type'), /^text\/csv/, type);
  }
  const rejected = await report('/reports/STOCK/export?format=XLSX');
  assert.equal(rejected.response.status, 400);
  assert.equal(rejected.body.errorCode, 'REPORT_FORMAT_UNSUPPORTED');
});

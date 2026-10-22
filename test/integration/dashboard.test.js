import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { api, setup, sql, teardown } from './report-fixture.js';

let sessions;
before(async () => { sessions = await setup('stock_dashboard'); });
after(teardown);

test('dashboard requires authentication and allows every authenticated role', async () => {
  const denied = await api('/dashboard');
  assert.equal(denied.response.status, 401);
  const allowed = await api('/dashboard', { headers: { cookie: sessions.petugas } });
  assert.equal(allowed.response.status, 200, JSON.stringify(allowed.body));
});

test('dashboard aggregate is exact, region-scoped, bounded, and read-only', async () => {
  const beforeState = sql(`SELECT json_build_object(
    'transactions', (SELECT count(*) FROM stock_transactions),
    'balances', (SELECT count(*) FROM stock_balances),
    'batches', (SELECT count(*) FROM stock_batches),
    'opnames', (SELECT count(*) FROM stock_opnames)
  )`);
  const result = await api('/dashboard', { headers: { cookie: sessions.admin } });
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  const { recent_transactions: recent, ...metrics } = result.body.data;
  assert.deepEqual(metrics, {
    total_products: 3,
    total_stock: '25',
    safe: 1,
    low: 1,
    out: 1,
    expired: 1,
    expiring_7d: 1,
    expiring_30d: 1,
    pending_opnames: 1,
    total_adjustment: '-2',
  });
  assert.deepEqual(recent.map(({ transactionNumber, quantity }) => ({ transactionNumber, quantity })), [
    { transactionNumber: 'RPT-ADJUST', quantity: '-2' },
    { transactionNumber: 'RPT-OUT', quantity: '-1' },
    { transactionNumber: 'RPT-IN', quantity: '5' },
    { transactionNumber: 'RPT-OPEN', quantity: '20' },
  ]);
  assert.ok(recent.length <= 10);
  assert.equal(sql(`SELECT json_build_object(
    'transactions', (SELECT count(*) FROM stock_transactions),
    'balances', (SELECT count(*) FROM stock_balances),
    'batches', (SELECT count(*) FROM stock_batches),
    'opnames', (SELECT count(*) FROM stock_opnames)
  )`), beforeState);
});

test('dashboard rejects non-GET requests without mutation', async () => {
  const before = sql('SELECT count(*) FROM stock_transactions');
  const result = await api('/dashboard', {
    method: 'POST', headers: { cookie: sessions.admin, 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(result.response.status, 404);
  assert.equal(sql('SELECT count(*) FROM stock_transactions'), before);
});

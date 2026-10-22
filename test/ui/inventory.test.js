import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createServer as createTcpServer } from 'node:net';
import { after, before, test } from 'node:test';

async function reservePort() {
  const server = createTcpServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitFor(url, child) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`server exited: ${child.exitCode}`);
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('server did not become ready');
}

let child;
let origin;

before(async () => {
  const port = await reservePort();
  origin = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['src/server.js'], {
    cwd: new URL('../..', import.meta.url),
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      APP_ORIGIN: origin,
      DATABASE_URL: 'postgresql://unused:***@127.0.0.1:1/unused',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitFor(`${origin}/live`, child);
});

after(() => child?.kill('SIGTERM'));

test('inventory and movement screen graph is protected and assets are allowlisted', async () => {
  for (const path of [
    '/stock', '/transactions', '/stock-card/product-id',
    '/transactions/opening', '/transactions/in', '/transactions/out',
  ]) {
    const response = await fetch(`${origin}${path}`, { redirect: 'manual' });
    assert.equal(response.status, 302, path);
    assert.equal(response.headers.get('location'), '/login', path);
  }
  for (const [path, contentType] of [
    ['/inventory.js', /^text\/javascript/],
    ['/transaction.js', /^text\/javascript/],
    ['/styles.css', /^text\/css/],
  ]) {
    const response = await fetch(`${origin}${path}`);
    assert.equal(response.status, 200, path);
    assert.match(response.headers.get('content-type'), contentType, path);
  }
});

test('transaction payload keeps one idempotency key for identical retry data', async () => {
  const { prepareSubmission } = await import('../../src/public/transaction.js');
  const entries = [
    ['date', '2026-10-21'], ['reference', 'INV-001'], ['warehouse', 'WH-1'],
    ['code', 'BRG-1'], ['quantity', '2.5'], ['unit', 'kg'],
    ['supplier', ''], ['batch', ''], ['notes', 'Datang utuh'],
  ];
  const first = prepareSubmission(entries, null, () => 'key-1');
  const retry = prepareSubmission(entries, first, () => 'key-2');
  assert.equal(first.idempotencyKey, 'key-1');
  assert.equal(retry.idempotencyKey, 'key-1');
  assert.deepEqual(first.payload, {
    idempotencyKey: 'key-1', date: '2026-10-21', reference: 'INV-001',
    warehouse: 'WH-1', code: 'BRG-1', quantity: '2.5', unit: 'kg', notes: 'Datang utuh',
  });
});

test('transaction route config matches approved runtime contracts', async () => {
  const { transactionConfig } = await import('../../src/public/transaction.js');
  const opening = transactionConfig('/transactions/opening');
  const incoming = transactionConfig('/transactions/in');
  const outgoing = transactionConfig('/transactions/out');
  assert.deepEqual(
    [opening.endpoint, incoming.endpoint, outgoing.endpoint],
    ['/api/transactions/opening', '/api/transactions/in', '/api/transactions/out'],
  );
  assert.equal(opening.adminOnly, true);
  assert.equal(incoming.fields.some(({ name }) => name === 'supplier'), true);
  assert.equal(outgoing.fields.some(({ name }) => name === 'supplier'), false);
  assert.equal(outgoing.fields.some(({ name }) => name === 'notes'), true);
});

test('transaction client uses cookie auth, CSRF, confirmation, and safe retry state', async () => {
  const source = await (await fetch(`${origin}/transaction.js`)).text();
  assert.match(source, /\/api\/auth\/me/);
  assert.match(source, /\/api\/auth\/csrf/);
  assert.match(source, /x-csrf-token/);
  assert.match(source, /showModal/);
  assert.match(source, /Hasil belum diketahui/);
  assert.match(source, /role\s*!==\s*['"]ADMIN['"]/);
  assert.match(source, /textContent/);
  assert.doesNotMatch(source, /innerHTML|localStorage|sessionStorage|document\.cookie/);
});

test('inventory route config matches report response contracts', async () => {
  const { inventoryConfig } = await import('../../src/public/inventory.js');
  const stock = inventoryConfig('/stock');
  const transactions = inventoryConfig('/transactions');
  const card = inventoryConfig('/stock-card/11111111-1111-4111-8111-111111111111');
  assert.equal(stock.endpoint, '/api/stock');
  assert.equal(stock.columns.some(({ key }) => key === 'quantity'), true);
  assert.equal(transactions.endpoint, '/api/transactions');
  assert.equal(transactions.columns.some(({ key }) => key === 'transactionNumber'), true);
  assert.equal(card.endpoint, '/api/stock-card/11111111-1111-4111-8111-111111111111');
  assert.equal(card.columns.some(({ key }) => key === 'runningBalance'), true);
});

test('inventory client handles report items, pagination, stale loads, and safe rendering', async () => {
  const source = await (await fetch(`${origin}/inventory.js`)).text();
  assert.match(source, /\/api\/auth\/me/);
  assert.match(source, /data\.items/);
  assert.match(source, /data\.hasNext/);
  assert.match(source, /const requestId = \+\+loadRequestId/);
  assert.match(source, /if \(requestId !== loadRequestId\) return/);
  assert.match(source, /textContent/);
  assert.doesNotMatch(source, /innerHTML|localStorage|sessionStorage|document\.cookie/);
});

test('inventory and transaction HTML expose semantic states and responsive controls', async () => {
  const [inventory, transaction, styles] = await Promise.all([
    readFile(new URL('../../src/public/inventory.html', import.meta.url), 'utf8'),
    readFile(new URL('../../src/public/transaction.html', import.meta.url), 'utf8'),
    readFile(new URL('../../src/public/styles.css', import.meta.url), 'utf8'),
  ]);
  for (const html of [inventory, transaction]) {
    assert.match(html, /<html[^>]+lang="id"/i);
    assert.match(html, /<nav[^>]+aria-label="Navigasi utama"/i);
    assert.match(html, /<h1[^>]+id="page-title"[^>]+tabindex="-1"/i);
  }
  assert.match(transaction, /<dialog[^>]+aria-labelledby="confirm-title"[^>]+aria-describedby="confirm-description"/i);
  assert.match(transaction, /<form[^>]+id="transaction-form"[^>]+hidden/i);
  assert.match(transaction, /id="receipt-title"[^>]+tabindex="-1"/i);
  assert.match(await readFile(new URL('../../src/public/transaction.js', import.meta.url), 'utf8'), /csrfToken\s*=.*\n\s*form\.hidden\s*=\s*false/s);
  assert.match(styles, /textarea[^\n]*min-height:\s*44px/);
  assert.match(styles, /\.form-grid\s*\{[^}]*display:\s*grid/s);
  assert.match(styles, /@media\s*\(max-width:\s*767px\)/);
});

test('existing shells link to stock and transaction workflows', async () => {
  for (const file of ['index.html', 'import.html']) {
    const html = await readFile(new URL(`../../src/public/${file}`, import.meta.url), 'utf8');
    assert.match(html, /href="\/stock"/);
    assert.match(html, /href="\/transactions"/);
    assert.match(html, /href="\/transactions\/in"/);
    assert.match(html, /href="\/transactions\/out"/);
  }
});

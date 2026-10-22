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

test('dashboard screen is protected and asset is allowlisted', async () => {
  const page = await fetch(`${origin}/dashboard`, { redirect: 'manual' });
  assert.equal(page.status, 302);
  assert.equal(page.headers.get('location'), '/login');
  const asset = await fetch(`${origin}/dashboard.js`);
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get('content-type'), /^text\/javascript/);
});

test('dashboard HTML provides aggregate cards, recent transactions, and states', async () => {
  const html = await readFile(new URL('../../src/public/dashboard.html', import.meta.url), 'utf8');
  assert.match(html, /<html[^>]+lang="id"/i);
  assert.match(html, /<nav[^>]+aria-label="Navigasi utama"/i);
  assert.match(html, /<h1[^>]+id="page-title"[^>]+tabindex="-1"/i);
  for (const id of ['metrics', 'recent-transactions', 'screen-status', 'error-state']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /aria-live="polite"/);
  assert.doesNotMatch(html, /<form|<button[^>]+(?:simpan|ubah|hapus)/i);
});

test('dashboard client is cookie-authenticated, GET-only, and safely rendered', async () => {
  const source = await readFile(new URL('../../src/public/dashboard.js', import.meta.url), 'utf8');
  assert.match(source, /\/api\/auth\/me/);
  assert.match(source, /\/api\/dashboard/);
  assert.match(source, /recent_transactions/);
  assert.match(source, /textContent/);
  assert.doesNotMatch(source, /method\s*:\s*['"](?:POST|PUT|PATCH|DELETE)|innerHTML|localStorage|sessionStorage|document\.cookie/);
});

test('reports screen is protected and asset is allowlisted', async () => {
  const page = await fetch(`${origin}/reports`, { redirect: 'manual' });
  assert.equal(page.status, 302);
  assert.equal(page.headers.get('location'), '/login');
  const asset = await fetch(`${origin}/reports.js`);
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get('content-type'), /^text\/javascript/);
});

test('reports HTML provides approved filters, table, pagination, and CSV export', async () => {
  const html = await readFile(new URL('../../src/public/reports.html', import.meta.url), 'utf8');
  for (const id of [
    'report-type', 'from', 'to', 'product-id', 'category-id', 'warehouse-id',
    'supplier-id', 'status-filter', 'results', 'table-head', 'table-body',
    'previous-page', 'next-page', 'export-link', 'screen-status', 'error-state',
  ]) assert.match(html, new RegExp(`id="${id}"`), id);
  for (const type of [
    'STOCK', 'STOCK_CARD', 'IN', 'OUT', 'ADJUSTMENT', 'OPNAME',
    'OPNAME_DIFFERENCE', 'BATCH_EXPIRY',
  ]) assert.match(html, new RegExp(`value="${type}"`), type);
  assert.match(html, /aria-live="polite"/);
});

test('reports client uses filtered paginated GET and safe CSV link', async () => {
  const source = await readFile(new URL('../../src/public/reports.js', import.meta.url), 'utf8');
  assert.match(source, /\/api\/reports\//);
  assert.match(source, /URLSearchParams/);
  assert.match(source, /params\.set\(['"]page['"]/);
  assert.match(source, /params\.set\(['"]limit['"]/);
  assert.match(source, /\/export/);
  assert.match(source, /textContent/);
  assert.doesNotMatch(source, /method\s*:\s*['"](?:POST|PUT|PATCH|DELETE)|innerHTML|localStorage|sessionStorage|document\.cookie/);
});

test('existing shells link to dashboard and reports', async () => {
  for (const file of ['index.html', 'inventory.html', 'transaction.html', 'opname.html', 'import.html']) {
    const html = await readFile(new URL(`../../src/public/${file}`, import.meta.url), 'utf8');
    assert.match(html, /href="\/dashboard"/, file);
    assert.match(html, /href="\/reports"/, file);
  }
});

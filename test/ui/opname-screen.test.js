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

test('opname list and detail screens are protected and asset is allowlisted', async () => {
  for (const path of ['/opnames', '/opnames/11111111-1111-4111-8111-111111111111']) {
    const response = await fetch(`${origin}${path}`, { redirect: 'manual' });
    assert.equal(response.status, 302, path);
    assert.equal(response.headers.get('location'), '/login', path);
  }
  const asset = await fetch(`${origin}/opname.js`);
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get('content-type'), /^text\/javascript/);
});

test('opname HTML provides accessible create, list, count, and review states', async () => {
  const html = await readFile(new URL('../../src/public/opname.html', import.meta.url), 'utf8');
  assert.match(html, /<html[^>]+lang="id"/i);
  assert.match(html, /<nav[^>]+aria-label="Navigasi utama"/i);
  assert.match(html, /<h1[^>]+id="page-title"[^>]+tabindex="-1"/i);
  for (const id of [
    'create-form', 'list-view', 'detail-view', 'count-form', 'review-actions', 'screen-status',
  ]) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, /role="alert"/);
  assert.match(html, /aria-live="polite"/);
});

test('opname client uses cookie auth, CSRF, safe rendering, and complete state actions', async () => {
  const source = await readFile(new URL('../../src/public/opname.js', import.meta.url), 'utf8');
  assert.match(source, /\/api\/auth\/me/);
  assert.match(source, /\/api\/auth\/csrf/);
  assert.match(source, /x-csrf-token/);
  for (const name of ['start', 'counts', 'submit']) {
    assert.match(source, new RegExp(`action\\('${name}'`));
  }
  assert.match(source, /approvalFailureMessage/);
  assert.match(source, /confirmAction\(\s*'approve'/);
  assert.match(source, /confirmAction\('reject'/);
  assert.match(source, /window\.confirm/);
  assert.match(source, /textContent/);
  assert.doesNotMatch(source, /innerHTML|localStorage|sessionStorage|document\.cookie/);
});

test('existing shells link to stock opname workflow', async () => {
  for (const file of ['index.html', 'inventory.html', 'transaction.html', 'import.html']) {
    const html = await readFile(new URL(`../../src/public/${file}`, import.meta.url), 'utf8');
    assert.match(html, /href="\/opnames"/, file);
  }
});

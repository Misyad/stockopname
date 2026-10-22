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
      const response = await fetch(url);
      if (response.ok) return;
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
      DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:1/unused',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitFor(`${origin}/live`, child);
});

after(() => child?.kill('SIGTERM'));

test('login screen is served without storing credentials client-side', async () => {
  const [page, script] = await Promise.all([
    fetch(`${origin}/login`),
    fetch(`${origin}/login.js`),
  ]);
  assert.equal(page.status, 200);
  assert.equal(script.status, 200);
  const [html, source] = await Promise.all([page.text(), script.text()]);
  assert.match(html, /<form[^>]+id="login-form"/);
  assert.match(html, /type="email"/);
  assert.match(html, /type="password"/);
  assert.match(source, /\/api\/auth\/login/);
  assert.match(source, /location\.replace/);
  assert.doesNotMatch(source, /localStorage|sessionStorage|document\.cookie/);
});

test('master screen requires a server-side authenticated session', async () => {
  const response = await fetch(`${origin}/masters/categories`, { redirect: 'manual' });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), '/login');
});

test('master screen and assets are served with semantic controls', async () => {
  const html = await readFile(new URL('../../src/public/index.html', import.meta.url), 'utf8');
  const [script, styles] = await Promise.all([
    fetch(`${origin}/app.js`),
    fetch(`${origin}/styles.css`),
  ]);
  assert.equal(script.status, 200);
  assert.match(script.headers.get('content-type'), /^text\/javascript/);
  assert.equal(styles.status, 200);
  assert.match(styles.headers.get('content-type'), /^text\/css/);

  assert.match(html, /<html[^>]+lang="id"/i);
  assert.match(html, /<meta[^>]+name="viewport"/i);
  assert.match(html, /<nav[^>]+aria-label="Navigasi utama"/i);
  assert.match(html, /<h1[^>]+id="page-title"[^>]+tabindex="-1"/i);
  assert.match(html, /<label[^>]+for="search"/i);
  assert.match(html, /<label[^>]+for="status-filter"/i);
  assert.match(html, /id="screen-status"[^>]+role="status"[^>]+aria-live="polite"/i);
  assert.match(html, /<dialog[^>]+aria-labelledby="form-title"[^>]+aria-describedby="form-description"/i);
  assert.match(html, /href="\/opnames"/i);
  assert.match(html, /href="\/dashboard"/i);
  assert.match(html, /href="\/reports"/i);
});

test('master client handles role, async states, safe rendering, and no credential persistence', async () => {
  const source = await (await fetch(`${origin}/app.js`)).text();
  assert.match(source, /\/api\/auth\/me/);
  assert.match(source, /\/api\/auth\/csrf/);
  assert.match(source, /role\s*===\s*['"]ADMIN['"]/);
  assert.doesNotMatch(source, /location\.assign\(['"]\/forbidden['"]\)/);
  assert.match(source, /Akses ditolak/);
  assert.match(source, /Loading|Memuat/i);
  assert.match(source, /empty|Belum ada/i);
  assert.match(source, /retry|Coba lagi/i);
  assert.match(source, /const requestId = \+\+loadRequestId/);
  assert.match(source, /if \(requestId !== loadRequestId\) return/);
  assert.match(source, /textContent/);
  assert.doesNotMatch(source, /\.innerHTML\s*=/);
  assert.doesNotMatch(source, /localStorage|sessionStorage/);
});

test('master layout remains usable at 360px and controls meet tap target', async () => {
  const css = await (await fetch(`${origin}/styles.css`)).text();
  assert.match(css, /@media\s*\(max-width:\s*767px\)/);
  assert.match(css, /min-height:\s*44px/);
  assert.match(css, /\.skip-link\s*\{[^}]*min-height:\s*44px/);
  assert.doesNotMatch(css, /\.sidebar\s*\{[^}]*display:\s*none/);
  assert.match(css, /\.sidebar nav\s*\{[^}]*overflow-x:\s*auto/);
  assert.match(css, /overflow-x:\s*auto/);
  assert.match(css, /:focus-visible/);
  const mobile = css.match(/@media\s*\(max-width:\s*767px\)\s*\{([\s\S]*?)\n\}/)?.[1] || '';
  assert.match(mobile, /\.pagination\s*\{[^}]*flex-wrap:\s*wrap/);
});

test('master client exposes complete approved create/update/deactivate workflow', async () => {
  const [usersPage, source] = await Promise.all([
    fetch(`${origin}/users`),
    fetch(`${origin}/app.js`).then((response) => response.text()),
  ]);
  assert.equal(usersPage.status, 200);
  assert.match(source, /category_id/);
  assert.match(source, /base_unit_id/);
  assert.match(source, /conversion_factor/);
  assert.match(source, /conversion_to_base/);
  assert.match(source, /password/);
  assert.match(source, /\/status/);
  assert.match(source, /method:\s*['"]PATCH['"]/);
  assert.match(source, /status:\s*['"]INACTIVE['"]/);
  assert.match(source, /Ubah/);
  assert.match(source, /Nonaktifkan/);
});

test('form build failure is surfaced without opening the modal', async () => {
  const { openBuiltForm } = await import('../../src/public/app.js');
  const output = { hidden: true, textContent: '' };
  let opened = false;
  await openBuiltForm(
    async () => { throw new Error('Reference tidak tersedia.'); },
    { open() { opened = true; } },
    {},
    output,
  );
  assert.equal(opened, false);
  assert.equal(output.hidden, false);
  assert.equal(output.textContent, 'Reference tidak tersedia.');
});

test('modal controller supports Escape, focus return, and duplicate-submit lock', async () => {
  const { createModalController } = await import('../../src/public/app.js');
  const events = {};
  let focused = 0;
  const dialog = {
    open: false,
    addEventListener(type, handler) { events[type] = handler; },
    showModal() { this.open = true; },
    close() { this.open = false; events.close?.(); },
  };
  const safe = { focus() { focused += 1; } };
  const trigger = { focus() { focused += 10; } };
  const controller = createModalController(dialog, safe);
  controller.open(trigger);
  assert.equal(dialog.open, true);
  assert.equal(focused, 1);
  events.keydown({ key: 'Escape', preventDefault() {} });
  assert.equal(dialog.open, false);
  assert.equal(focused, 11);
  assert.equal(controller.startCommit(), true);
  assert.equal(controller.startCommit(), false);
  controller.open(trigger);
  assert.equal(controller.close(), false);
  assert.equal(dialog.open, true);
  controller.finishCommit();
  assert.equal(controller.close(), true);
  assert.equal(dialog.open, false);
  assert.equal(controller.startCommit(), true);
});

test('edit payload preserves intentional clearing of optional fields', async () => {
  const { formPayload } = await import('../../src/public/app.js');
  const fields = [
    ['name', 'Nama', { required: true }],
    ['location', 'Lokasi'],
    ['minimum_stock', 'Stok minimum', { type: 'number' }],
  ];
  const entries = [['name', 'Gudang Utama'], ['location', ''], ['minimum_stock', '']];
  assert.deepEqual(formPayload(entries, fields, true), {
    name: 'Gudang Utama', location: null, minimum_stock: null,
  });
  assert.deepEqual(formPayload(entries, fields, false), { name: 'Gudang Utama' });
});

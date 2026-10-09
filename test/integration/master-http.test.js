import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes, scryptSync } from 'node:crypto';
import { createServer as createTcpServer } from 'node:net';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../..', import.meta.url));
const composeFile = `${projectRoot}/compose.yaml`;
const password = 'correct horse battery staple';
const ids = {
  admin: '41000000-0000-0000-0000-000000000001',
  petugas: '41000000-0000-0000-0000-000000000002',
};

function compose(args) {
  return execFileSync('docker', ['compose', '-f', composeFile, ...args], {
    cwd: projectRoot,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function sql(statement) {
  return compose([
    'exec', '-T', 'database', 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-At',
    '-U', env.POSTGRES_USER, '-d', env.POSTGRES_DB, '-c', statement,
  ]).trim();
}

function passwordHash(value) {
  const salt = randomBytes(16);
  const key = scryptSync(value, salt, 64, {
    N: 131_072, r: 8, p: 1, maxmem: 256 * 1024 * 1024,
  });
  return `scrypt$131072$8$1$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

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

async function request(path, options = {}) {
  const response = await fetch(`http://127.0.0.1:${env.APP_PORT}/api${path}`, options);
  return { response, body: await response.json() };
}

function cookieHeader(cookie) {
  return { cookie: cookie.split(';', 1)[0] };
}

async function login(email) {
  const result = await request('/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: env.APP_ORIGIN },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  return result.response.headers.get('set-cookie');
}

async function csrf(cookie) {
  const result = await request('/auth/csrf', { headers: cookieHeader(cookie) });
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  return result.body.data.csrfToken;
}

function mutationHeaders(cookie, token, origin = env.APP_ORIGIN) {
  return {
    ...cookieHeader(cookie),
    'content-type': 'application/json',
    origin,
    'x-csrf-token': token,
  };
}

function cleanup() {
  if (!env) return;
  spawnSync('docker', ['compose', '-f', composeFile, 'down', '-v', '--remove-orphans'], {
    cwd: projectRoot,
    env,
    encoding: 'utf8',
  });
}

let env;
let adminCookie;
let petugasCookie;
let adminCsrf;
let petugasCsrf;

before(async () => {
  const port = await reservePort();
  env = {
    ...process.env,
    APP_PORT: String(port),
    APP_ORIGIN: `http://127.0.0.1:${port}`,
    COMPOSE_PROJECT_NAME: `stock_opname_master_http_${process.pid}`,
    POSTGRES_DB: 'stock_opname_master_http_test',
    POSTGRES_USER: 'stock_opname_master_http_test',
    POSTGRES_PASSWORD: randomBytes(24).toString('base64url'),
  };
  compose(['up', '-d', '--build', '--wait', '--wait-timeout', '180']);
  compose(['exec', '-T', 'app', 'node', 'src/db/migrate.js']);
  sql(`
    INSERT INTO users (id, name, email, password_hash, role, status, created_at, updated_at)
    VALUES
      ('${ids.admin}', 'Admin', 'route-admin@example.test', '${passwordHash(password)}', 'ADMIN', 'ACTIVE', now(), now()),
      ('${ids.petugas}', 'Petugas', 'route-petugas@example.test', '${passwordHash(password)}', 'PETUGAS', 'ACTIVE', now(), now())
  `);
  adminCookie = await login('route-admin@example.test');
  petugasCookie = await login('route-petugas@example.test');
  adminCsrf = await csrf(adminCookie);
  petugasCsrf = await csrf(petugasCookie);
});

after(cleanup);

test('authenticated master shell uses browser security headers', async () => {
  const response = await fetch(`http://127.0.0.1:${env.APP_PORT}/masters/categories`, {
    headers: cookieHeader(adminCookie),
    redirect: 'manual',
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/html/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
});

test('master list requires authentication and returns paginated filtered data', async () => {
  const anonymous = await request('/categories');
  assert.equal(anonymous.response.status, 401);
  assert.equal(anonymous.body.errorCode, 'UNAUTHENTICATED');

  sql(`
    INSERT INTO categories (id, code, name, status, created_at, updated_at)
    VALUES
      ('42000000-0000-0000-0000-000000000001', 'ROUTE-A', 'Route Alpha', 'ACTIVE', now(), now()),
      ('42000000-0000-0000-0000-000000000002', 'ROUTE-B', 'Route Beta', 'INACTIVE', now(), now())
  `);
  const listed = await request('/categories?page=1&limit=1&q=Route&status=ACTIVE', {
    headers: cookieHeader(petugasCookie),
  });
  assert.equal(listed.response.status, 200, JSON.stringify(listed.body));
  assert.equal(listed.body.success, true);
  assert.equal(listed.body.message, 'OK');
  assert.equal(listed.body.data.page, 1);
  assert.equal(listed.body.data.limit, 1);
  assert.equal(listed.body.data.total, 1);
  assert.equal(listed.body.data.rows.length, 1);
  assert.equal(listed.body.data.rows[0].code, 'ROUTE-A');

  const literalWildcard = await request(`/categories?q=${encodeURIComponent('%')}`, {
    headers: cookieHeader(petugasCookie),
  });
  assert.equal(literalWildcard.response.status, 200, JSON.stringify(literalWildcard.body));
  assert.equal(literalWildcard.body.data.total, 0);

  const longQuery = await request(`/categories?q=${'x'.repeat(101)}`, {
    headers: cookieHeader(petugasCookie),
  });
  assert.equal(longQuery.response.status, 400, JSON.stringify(longQuery.body));
  assert.equal(longQuery.body.errorCode, 'VALIDATION_ERROR');
});

test('prototype route names remain outside the master route allowlist', async () => {
  for (const path of ['/constructor', '/toString', '/__proto__']) {
    const result = await request(path, { headers: cookieHeader(adminCookie) });
    assert.equal(result.response.status, 404, `${path}: ${JSON.stringify(result.body)}`);
    assert.equal(result.body.errorCode, 'NOT_FOUND');
  }
});

test('master mutation rejects invalid browser security and wrong role without DB changes', async () => {
  const beforeCount = sql("SELECT count(*) FROM categories WHERE code LIKE 'HTTP-%'");
  const body = JSON.stringify({ code: 'HTTP-DENIED', name: 'Denied' });
  const cases = [
    { headers: { ...cookieHeader(adminCookie), 'content-type': 'application/json', origin: env.APP_ORIGIN }, code: 'CSRF_INVALID' },
    { headers: mutationHeaders(adminCookie, 'wrong-token'), code: 'CSRF_INVALID' },
    { headers: mutationHeaders(adminCookie, petugasCsrf), code: 'CSRF_INVALID' },
    { headers: mutationHeaders(adminCookie, adminCsrf, 'https://foreign.example'), code: 'ORIGIN_INVALID' },
  ];
  for (const entry of cases) {
    const result = await request('/categories', { method: 'POST', headers: entry.headers, body });
    assert.equal(result.response.status, 403, JSON.stringify(result.body));
    assert.equal(result.body.errorCode, entry.code);
  }

  const forbidden = await request('/categories', {
    method: 'POST',
    headers: mutationHeaders(petugasCookie, petugasCsrf),
    body,
  });
  assert.equal(forbidden.response.status, 403, JSON.stringify(forbidden.body));
  assert.equal(forbidden.body.errorCode, 'FORBIDDEN');
  assert.equal(sql("SELECT count(*) FROM categories WHERE code LIKE 'HTTP-%'"), beforeCount);
});

test('ADMIN creates and updates master; duplicate returns stable safe envelope', async () => {
  const created = await request('/categories', {
    method: 'POST',
    headers: mutationHeaders(adminCookie, adminCsrf),
    body: JSON.stringify({ code: 'HTTP-CAT', name: 'HTTP Category' }),
  });
  assert.equal(created.response.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.success, true);
  assert.equal(created.body.data.code, 'HTTP-CAT');
  assert.equal(created.body.data.status, 'ACTIVE');

  const updated = await request(`/categories/${created.body.data.id}`, {
    method: 'PATCH',
    headers: mutationHeaders(adminCookie, adminCsrf),
    body: JSON.stringify({ name: 'Updated Category', status: 'INACTIVE' }),
  });
  assert.equal(updated.response.status, 200, JSON.stringify(updated.body));
  assert.equal(updated.body.data.name, 'Updated Category');
  assert.equal(updated.body.data.status, 'INACTIVE');

  const duplicate = await request('/categories', {
    method: 'POST',
    headers: mutationHeaders(adminCookie, adminCsrf),
    body: JSON.stringify({ code: 'HTTP-CAT', name: 'Duplicate' }),
  });
  assert.equal(duplicate.response.status, 409, JSON.stringify(duplicate.body));
  assert.deepEqual(duplicate.body, {
    success: false,
    errorCode: 'DUPLICATE_CODE',
    message: 'category code already exists.',
    details: {},
  });
  assert.doesNotMatch(JSON.stringify(duplicate.body), /postgres|constraint|\/root\/|stack/i);
});

test('all approved master routes resolve and users remain ADMIN-only', async () => {
  const create = async (path, payload) => {
    const result = await request(path, {
      method: 'POST',
      headers: mutationHeaders(adminCookie, adminCsrf),
      body: JSON.stringify(payload),
    });
    assert.equal(result.response.status, 201, `${path}: ${JSON.stringify(result.body)}`);
    return result.body.data;
  };

  const category = await create('/categories', { code: 'ALL-CAT', name: 'All Category' });
  const baseUnit = await create('/units', {
    code: 'ALL-KG', name: 'Kilogram', symbol: 'kg', conversion_to_base: '1',
  });
  const purchaseUnit = await create('/units', {
    code: 'ALL-SAK', name: 'Sack', symbol: 'sak', conversion_to_base: '25',
  });
  const alias = await create('/unit-aliases', { unit_id: baseUnit.id, alias: 'kilogram-route' });
  const warehouse = await create('/warehouses', { code: 'ALL-WH', name: 'All Warehouse', location: 'Route' });
  const supplier = await create('/suppliers', { code: 'ALL-SUP', name: 'All Supplier', phone: '0800' });
  const product = await create('/products', {
    code: 'ALL-PROD',
    name: 'All Product',
    category_id: category.id,
    base_unit_id: baseUnit.id,
    purchase_unit_id: purchaseUnit.id,
    barcode: 'ALL-BARCODE',
    conversion_factor: '25',
    minimum_stock: '1',
    maximum_stock: '10',
  });
  const user = await create('/users', {
    name: 'Route User',
    email: 'all-user@example.test',
    password: 'strong route password',
    role: 'SUPERVISOR',
  });

  for (const path of ['/categories', '/units', '/unit-aliases', '/warehouses', '/suppliers', '/products']) {
    const result = await request(`${path}?page=1&limit=100`, { headers: cookieHeader(petugasCookie) });
    assert.equal(result.response.status, 200, `${path}: ${JSON.stringify(result.body)}`);
  }

  const deniedUsers = await request('/users', { headers: cookieHeader(petugasCookie) });
  assert.equal(deniedUsers.response.status, 403, JSON.stringify(deniedUsers.body));
  assert.equal(deniedUsers.body.errorCode, 'FORBIDDEN');
  const users = await request('/users?q=all-user', { headers: cookieHeader(adminCookie) });
  assert.equal(users.response.status, 200, JSON.stringify(users.body));
  assert.equal(users.body.data.rows.length, 1);
  assert.equal(users.body.data.rows[0].email, 'all-user@example.test');
  assert.equal(Object.hasOwn(users.body.data.rows[0], 'password_hash'), false);
  assert.equal(Object.hasOwn(users.body.data.rows[0], 'password'), false);

  for (const [path, id] of [
    ['/unit-aliases', alias.id],
    ['/warehouses', warehouse.id],
    ['/suppliers', supplier.id],
    ['/products', product.id],
  ]) {
    const updated = await request(`${path}/${id}`, {
      method: 'PATCH',
      headers: mutationHeaders(adminCookie, adminCsrf),
      body: JSON.stringify({ status: 'INACTIVE' }),
    });
    assert.equal(updated.response.status, 200, `${path}: ${JSON.stringify(updated.body)}`);
    assert.equal(updated.body.data.status, 'INACTIVE');
  }

  const userStatus = await request(`/users/${user.id}/status`, {
    method: 'PATCH',
    headers: mutationHeaders(adminCookie, adminCsrf),
    body: JSON.stringify({ status: 'INACTIVE' }),
  });
  assert.equal(userStatus.response.status, 200, JSON.stringify(userStatus.body));
  assert.equal(userStatus.body.data.status, 'INACTIVE');
  assert.equal(Object.hasOwn(userStatus.body.data, 'password_hash'), false);

  const deniedDeactivate = await request(`/categories/${category.id}`, {
    method: 'PATCH',
    headers: mutationHeaders(petugasCookie, petugasCsrf),
    body: JSON.stringify({ status: 'INACTIVE' }),
  });
  assert.equal(deniedDeactivate.response.status, 403, JSON.stringify(deniedDeactivate.body));
  assert.equal(deniedDeactivate.body.errorCode, 'FORBIDDEN');
  assert.equal(sql(`SELECT status FROM categories WHERE id = '${category.id}'`), 'ACTIVE');
  assert.equal(sql("SELECT count(*) FROM audit_logs WHERE action = 'DEACTIVATE_PRODUCT'"), '1');
  assert.equal(sql("SELECT count(*) FROM audit_logs WHERE action = 'DEACTIVATE_USER'"), '1');
});

test('user status endpoint rejects reactivation', async () => {
  const created = await request('/users', {
    method: 'POST',
    headers: mutationHeaders(adminCookie, adminCsrf),
    body: JSON.stringify({
      name: 'Status Guard',
      email: 'status-guard@example.test',
      password: 'strong status password',
      role: 'PETUGAS',
    }),
  });
  assert.equal(created.response.status, 201, JSON.stringify(created.body));

  const response = await request(`/users/${created.body.data.id}/status`, {
    method: 'PATCH',
    headers: mutationHeaders(adminCookie, adminCsrf),
    body: JSON.stringify({ status: 'ACTIVE' }),
  });
  assert.equal(response.response.status, 400, JSON.stringify(response.body));
  assert.equal(response.body.errorCode, 'VALIDATION_ERROR');
  assert.equal(sql(`SELECT status FROM users WHERE id = '${created.body.data.id}'`), 'ACTIVE');

  const nullBody = await request(`/users/${created.body.data.id}/status`, {
    method: 'PATCH',
    headers: mutationHeaders(adminCookie, adminCsrf),
    body: 'null',
  });
  assert.equal(nullBody.response.status, 400, JSON.stringify(nullBody.body));
  assert.equal(nullBody.body.errorCode, 'VALIDATION_ERROR');
  assert.equal(sql(`SELECT status FROM users WHERE id = '${created.body.data.id}'`), 'ACTIVE');
});

test('empty master PATCH is rejected without audit mutation', async () => {
  const id = '42000000-0000-0000-0000-000000000001';
  const before = sql(`SELECT count(*) FROM audit_logs WHERE reference = '${id}'`);
  const response = await request(`/categories/${id}`, {
    method: 'PATCH',
    headers: mutationHeaders(adminCookie, adminCsrf),
    body: '{}',
  });
  assert.equal(response.response.status, 400, JSON.stringify(response.body));
  assert.equal(response.body.errorCode, 'VALIDATION_ERROR');
  assert.equal(sql(`SELECT count(*) FROM audit_logs WHERE reference = '${id}'`), before);
});

test('physical delete and HEAD cannot mutate master data', async () => {
  const before = sql("SELECT count(*) FROM categories WHERE code = 'HTTP-CAT'");
  for (const method of ['DELETE', 'HEAD']) {
    const response = await fetch(`http://127.0.0.1:${env.APP_PORT}/api/categories/42000000-0000-0000-0000-000000000001`, {
      method,
      headers: mutationHeaders(adminCookie, adminCsrf),
    });
    assert.equal(response.status, 404, method);
  }
  assert.equal(sql("SELECT count(*) FROM categories WHERE code = 'HTTP-CAT'"), before);
});

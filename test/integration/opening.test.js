import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes, scryptSync } from 'node:crypto';
import { createServer as createTcpServer } from 'node:net';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const composeFile = `${root}/compose.yaml`;
const ids = {
  regionA: '51000000-0000-0000-0000-000000000001',
  regionB: '51000000-0000-0000-0000-000000000002',
  admin: '51000000-0000-0000-0000-000000000010',
  supervisor: '51000000-0000-0000-0000-000000000011',
  petugas: '51000000-0000-0000-0000-000000000012',
  category: '51000000-0000-0000-0000-000000000020',
  kg: '51000000-0000-0000-0000-000000000030',
  box: '51000000-0000-0000-0000-000000000031',
  warehouseA: '51000000-0000-0000-0000-000000000040',
  warehouseB: '51000000-0000-0000-0000-000000000041',
  productA: '51000000-0000-0000-0000-000000000050',
  productExisting: '51000000-0000-0000-0000-000000000051',
  productRollback: '51000000-0000-0000-0000-000000000052',
  productConcurrent: '51000000-0000-0000-0000-000000000053',
  productHttp: '51000000-0000-0000-0000-000000000054',
};
const password = 'correct horse battery staple';
let env;

function compose(args, options = {}) {
  return execFileSync('docker', ['compose', '-f', composeFile, ...args], {
    cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options,
  });
}

function sql(statement) {
  return compose([
    'exec', '-T', 'database', 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-At',
    '-U', env.POSTGRES_USER, '-d', env.POSTGRES_DB, '-c', statement,
  ]).trim();
}

function runInApp(body) {
  const source = `
    import assert from 'node:assert/strict';
    import { pool } from './src/db/pool.js';
    import { createOpeningStock } from './src/services/transactions.js';
    const ids = ${JSON.stringify(ids)};
    const admin = { userId: ids.admin, role: 'ADMIN', regionId: ids.regionA };
    try { ${body} } finally { await pool.end(); }
  `;
  return compose(['exec', '-T', 'app', 'node', '--input-type=module', '-'], {
    input: source, stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function passwordHash(value) {
  const salt = randomBytes(16);
  const key = scryptSync(value, salt, 64, {
    N: 131_072, r: 8, p: 1, maxmem: 256 * 1024 * 1024,
  });
  return `scrypt$131072$8$1$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

async function request(path, options = {}) {
  const response = await fetch(`http://127.0.0.1:${env.APP_PORT}/api${path}`, options);
  return { response, body: await response.json() };
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

function cookieHeader(cookie) {
  return { cookie: cookie.split(';', 1)[0] };
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

before(async () => {
  const appPort = String(await reservePort());
  env = {
    ...process.env,
    APP_PORT: appPort,
    APP_ORIGIN: `http://127.0.0.1:${appPort}`,
    COMPOSE_PROJECT_NAME: `stock_opname_opening_${process.pid}`,
    POSTGRES_DB: 'stock_opname_opening_test',
    POSTGRES_USER: 'stock_opname_opening_test',
    POSTGRES_PASSWORD: randomBytes(24).toString('base64url'),
  };
  compose(['up', '-d', '--build', '--wait', '--wait-timeout', '180']);
  compose(['exec', '-T', 'app', 'node', 'src/db/migrate.js']);
  sql(`
    INSERT INTO regions (id, code, name, status, created_at, updated_at) VALUES
      ('${ids.regionA}', 'A', 'Region A', 'ACTIVE', now(), now()),
      ('${ids.regionB}', 'B', 'Region B', 'ACTIVE', now(), now());
    INSERT INTO users (id, name, email, password_hash, role, status, region_id, created_at, updated_at) VALUES
      ('${ids.admin}', 'Admin', 'opening-admin@example.test', '${passwordHash(password)}', 'ADMIN', 'ACTIVE', '${ids.regionA}', now(), now()),
      ('${ids.supervisor}', 'Supervisor', 'opening-supervisor@example.test', '${passwordHash(password)}', 'SUPERVISOR', 'ACTIVE', '${ids.regionA}', now(), now()),
      ('${ids.petugas}', 'Petugas', 'opening-petugas@example.test', '${passwordHash(password)}', 'PETUGAS', 'ACTIVE', '${ids.regionA}', now(), now());
    INSERT INTO categories (id, code, name, status, created_at, updated_at)
      VALUES ('${ids.category}', 'OPEN', 'Opening', 'ACTIVE', now(), now());
    INSERT INTO units (id, code, name, symbol, base_unit_id, conversion_to_base, status, created_at, updated_at) VALUES
      ('${ids.kg}', 'KG', 'Kilogram', 'kg', NULL, 1, 'ACTIVE', now(), now()),
      ('${ids.box}', 'BOX', 'Box', 'box', '${ids.kg}', 10, 'ACTIVE', now(), now());
    INSERT INTO warehouses (id, code, name, status, region_id, created_at, updated_at) VALUES
      ('${ids.warehouseA}', 'WH-A', 'Warehouse A', 'ACTIVE', '${ids.regionA}', now(), now()),
      ('${ids.warehouseB}', 'WH-B', 'Warehouse B', 'ACTIVE', '${ids.regionB}', now(), now());
    INSERT INTO products (
      id, code, name, category_id, base_unit_id, purchase_unit_id, conversion_factor,
      minimum_stock, maximum_stock, status, created_at, updated_at
    ) VALUES
      ('${ids.productA}', 'OPEN-A', 'Opening A', '${ids.category}', '${ids.kg}', '${ids.box}', 10, 0, 100, 'ACTIVE', now(), now()),
      ('${ids.productExisting}', 'OPEN-E', 'Existing', '${ids.category}', '${ids.kg}', '${ids.box}', 10, 0, 100, 'ACTIVE', now(), now()),
      ('${ids.productRollback}', 'OPEN-R', 'Rollback', '${ids.category}', '${ids.kg}', '${ids.box}', 10, 0, 100, 'ACTIVE', now(), now()),
      ('${ids.productConcurrent}', 'OPEN-C', 'Concurrent', '${ids.category}', '${ids.kg}', '${ids.box}', 10, 0, 100, 'ACTIVE', now(), now()),
      ('${ids.productHttp}', 'OPEN-H', 'HTTP', '${ids.category}', '${ids.kg}', '${ids.box}', 10, 0, 100, 'ACTIVE', now(), now());
  `);
});

after(() => {
  if (!env) return;
  spawnSync('docker', ['compose', '-f', composeFile, 'down', '-v', '--remove-orphans'], {
    cwd: root, env, encoding: 'utf8',
  });
});

const opening = (overrides = {}) => ({
  idempotencyKey: 'opening-a-001', date: '2026-10-09', reference: 'COUNT-001',
  warehouse: 'WH-A', code: 'OPEN-A', batch: 'B-OPEN', production_date: '2026-10-01',
  expiry: '2027-10-01', quantity: 2, unit: 'BOX', price: 50000, notes: 'Initial count',
  ...overrides,
});

test('opening HTTP route enforces authentication, Origin, CSRF, role, region, and content type', async () => {
  const [adminCookie, supervisorCookie] = await Promise.all([
    login('opening-admin@example.test'),
    login('opening-supervisor@example.test'),
  ]);
  const [adminToken, supervisorToken] = await Promise.all([
    csrf(adminCookie),
    csrf(supervisorCookie),
  ]);
  const body = JSON.stringify(opening({
    idempotencyKey: 'opening-http', code: 'OPEN-H', reference: 'HTTP-001',
  }));
  const cases = [
    { headers: { 'content-type': 'application/json', origin: env.APP_ORIGIN }, status: 401, code: 'UNAUTHENTICATED' },
    { headers: { ...cookieHeader(adminCookie), 'content-type': 'application/json', 'x-csrf-token': adminToken }, status: 403, code: 'ORIGIN_INVALID' },
    { headers: { ...cookieHeader(adminCookie), 'content-type': 'application/json', origin: env.APP_ORIGIN }, status: 403, code: 'CSRF_INVALID' },
    { headers: mutationHeaders(adminCookie, 'wrong'), status: 403, code: 'CSRF_INVALID' },
    { headers: mutationHeaders(adminCookie, supervisorToken), status: 403, code: 'CSRF_INVALID' },
    { headers: mutationHeaders(supervisorCookie, supervisorToken), status: 403, code: 'FORBIDDEN' },
    { headers: { ...mutationHeaders(adminCookie, adminToken), 'content-type': 'text/plain' }, status: 415, code: 'UNSUPPORTED_MEDIA_TYPE' },
  ];
  for (const entry of cases) {
    const result = await request('/transactions/opening', { method: 'POST', headers: entry.headers, body });
    assert.equal(result.response.status, entry.status, JSON.stringify(result.body));
    assert.equal(result.body.errorCode, entry.code);
  }
  assert.equal(sql(`SELECT count(*) FROM stock_transactions WHERE product_id = '${ids.productHttp}'`), '0');

  const crossRegion = await request('/transactions/opening', {
    method: 'POST', headers: mutationHeaders(adminCookie, adminToken),
    body: JSON.stringify(opening({ idempotencyKey: 'opening-http-region', code: 'OPEN-H', warehouse: 'WH-B' })),
  });
  assert.equal(crossRegion.response.status, 403, JSON.stringify(crossRegion.body));
  assert.equal(crossRegion.body.errorCode, 'REGION_FORBIDDEN');

  const unknown = await request('/transactions/opening', {
    method: 'POST', headers: mutationHeaders(adminCookie, adminToken),
    body: JSON.stringify({ ...opening({ idempotencyKey: 'opening-http-invalid', code: 'OPEN-H' }), injected: true }),
  });
  assert.equal(unknown.response.status, 400, JSON.stringify(unknown.body));
  assert.equal(unknown.body.errorCode, 'VALIDATION_ERROR');

  const created = await request('/transactions/opening', {
    method: 'POST', headers: mutationHeaders(adminCookie, adminToken), body,
  });
  assert.equal(created.response.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.success, true);
  assert.equal(created.body.data.transactionType, 'OPENING');
  assert.equal(created.body.data.quantity, '20');
  assert.equal(sql(`SELECT count(*) FROM stock_transactions WHERE product_id = '${ids.productHttp}'`), '1');
});

test('OPEN-001/010 opening commits ledger, batch, balance, audit using base quantity', () => {
  assert.equal(runInApp(`
    const result = await createOpeningStock(pool, admin, ${JSON.stringify(opening())});
    assert.equal(result.transactionType, 'OPENING');
    assert.equal(result.quantity, '20');
    assert.equal(result.unit, 'KG');
    const state = await pool.query(\`
      SELECT
        (SELECT count(*)::int FROM stock_transactions WHERE product_id = $1) AS ledgers,
        (SELECT quantity::text FROM stock_batches WHERE product_id = $1) AS batch_quantity,
        (SELECT quantity::text FROM stock_balances WHERE product_id = $1) AS balance_quantity,
        (SELECT count(*)::int FROM audit_logs WHERE action = 'OPENING_STOCK' AND reference = $2) AS audits
    \`, [ids.productA, result.id]);
    assert.deepEqual(state.rows[0], { ledgers: 1, batch_quantity: '20', balance_quantity: '20', audits: 1 });
    console.log('PASS');
  `), 'PASS');
});

test('OPEN-006/007 retry is stable; changed payload conflicts without mutation', () => {
  assert.equal(runInApp(`
    const same = await createOpeningStock(pool, admin, ${JSON.stringify(opening({
      reference: ' COUNT-001 ', warehouse: ' wh-a ', code: ' open-a ', unit: ' box ',
      quantity: '02.0', price: '50000.0', notes: ' Initial count ',
    }))});
    assert.equal(same.quantity, '20');
    await assert.rejects(
      createOpeningStock(pool, admin, ${JSON.stringify(opening({ quantity: 3 }))}),
      (error) => error.status === 409 && error.errorCode === 'IDEMPOTENCY_CONFLICT',
    );
    const count = await pool.query('SELECT count(*)::int AS count FROM stock_transactions WHERE product_id = $1', [ids.productA]);
    assert.equal(count.rows[0].count, 1);
    console.log('PASS');
  `), 'PASS');
});

test('OPEN-002/003 roles and cross-region warehouse fail before mutation', () => {
  assert.equal(runInApp(`
    for (const actor of [
      { userId: ids.supervisor, role: 'SUPERVISOR', regionId: ids.regionA },
      { userId: ids.petugas, role: 'PETUGAS', regionId: ids.regionA },
    ]) await assert.rejects(
      createOpeningStock(pool, actor, ${JSON.stringify(opening({ idempotencyKey: 'denied-role', code: 'OPEN-R' }))}),
      (error) => error.status === 403 && error.errorCode === 'FORBIDDEN',
    );
    await assert.rejects(
      createOpeningStock(pool, admin, ${JSON.stringify(opening({ idempotencyKey: 'denied-region', warehouse: 'WH-B', code: 'OPEN-R' }))}),
      (error) => error.status === 403 && error.errorCode === 'REGION_FORBIDDEN',
    );
    const count = await pool.query('SELECT count(*)::int AS count FROM stock_transactions WHERE product_id = $1', [ids.productRollback]);
    assert.equal(count.rows[0].count, 0);
    console.log('PASS');
  `), 'PASS');
});

test('opening rejects non-decimal numeric literals before database mutation', () => {
  assert.equal(runInApp(`
    for (const [field, value, errorCode] of [
      ['quantity', '0x10', 'INVALID_QUANTITY'],
      ['quantity', '1e2', 'INVALID_QUANTITY'],
      ['quantity', Infinity, 'INVALID_QUANTITY'],
      ['price', '0x10', 'VALIDATION_ERROR'],
      ['price', '1e2', 'VALIDATION_ERROR'],
      ['price', Infinity, 'VALIDATION_ERROR'],
      ['price', '   ', 'VALIDATION_ERROR'],
    ]) await assert.rejects(
      createOpeningStock(pool, admin, {
        ...${JSON.stringify(opening({ idempotencyKey: 'invalid-numeric', code: 'OPEN-R' }))},
        [field]: value,
      }),
      (error) => error.status === 400 && error.errorCode === errorCode,
    );
    const count = await pool.query('SELECT count(*)::int AS count FROM stock_transactions WHERE product_id = $1', [ids.productRollback]);
    assert.equal(count.rows[0].count, 0);
    console.log('PASS');
  `), 'PASS');
});

test('OPEN-004/005 invalid quantity and existing ledger leave opening absent', () => {
  sql(`
    INSERT INTO stock_transactions (
      id, idempotency_key, transaction_number, transaction_type, reference_id, product_id,
      warehouse_id, quantity, unit, balance_before, balance_after, user_id, created_at
    ) VALUES (
      gen_random_uuid(), 'prior-in', 'IN-PRIOR', 'IN', 'INV-PRIOR', '${ids.productExisting}',
      '${ids.warehouseA}', 1, 'KG', 0, 1, '${ids.admin}', now()
    )
  `);
  assert.equal(runInApp(`
    for (const quantity of [0, -1, 'NaN']) await assert.rejects(
      createOpeningStock(pool, admin, ${JSON.stringify(opening({ idempotencyKey: 'invalid', code: 'OPEN-R' }))}.constructor === Object
        ? { ...${JSON.stringify(opening({ idempotencyKey: 'invalid', code: 'OPEN-R' }))}, quantity }
        : null),
      (error) => error.status === 400 && error.errorCode === 'INVALID_QUANTITY',
    );
    await assert.rejects(
      createOpeningStock(pool, admin, ${JSON.stringify(opening({ idempotencyKey: 'opening-existing', code: 'OPEN-E' }))}),
      (error) => error.status === 409 && error.errorCode === 'OPENING_ALREADY_EXISTS',
    );
    console.log('PASS');
  `), 'PASS');
});

test('OPEN-008 audit failure rolls back ledger, batch, and balance', () => {
  sql(`
    CREATE FUNCTION reject_opening_audit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.action = 'OPENING_STOCK' THEN RAISE EXCEPTION 'forced audit failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER reject_opening_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION reject_opening_audit();
  `);
  try {
    assert.equal(runInApp(`
      await assert.rejects(createOpeningStock(pool, admin, ${JSON.stringify(opening({ idempotencyKey: 'opening-rollback', code: 'OPEN-R' }))}));
      const state = await pool.query(\`
        SELECT
          (SELECT count(*)::int FROM stock_transactions WHERE product_id = $1) AS ledgers,
          (SELECT count(*)::int FROM stock_batches WHERE product_id = $1) AS batches,
          (SELECT count(*)::int FROM stock_balances WHERE product_id = $1) AS balances
      \`, [ids.productRollback]);
      assert.deepEqual(state.rows[0], { ledgers: 0, batches: 0, balances: 0 });
      console.log('PASS');
    `), 'PASS');
  } finally {
    sql('DROP TRIGGER reject_opening_audit ON audit_logs; DROP FUNCTION reject_opening_audit()');
  }
});

test('OPEN-009 concurrent openings create exactly one ledger row', () => {
  assert.equal(runInApp(`
    const base = ${JSON.stringify(opening({ code: 'OPEN-C', idempotencyKey: 'concurrent-a' }))};
    const settled = await Promise.allSettled([
      createOpeningStock(pool, admin, base),
      createOpeningStock(pool, admin, { ...base, idempotencyKey: 'concurrent-b' }),
    ]);
    assert.equal(settled.filter((item) => item.status === 'fulfilled').length, 1);
    const rejected = settled.find((item) => item.status === 'rejected');
    assert.equal(rejected.reason.errorCode, 'OPENING_ALREADY_EXISTS');
    const count = await pool.query('SELECT count(*)::int AS count FROM stock_transactions WHERE product_id = $1', [ids.productConcurrent]);
    assert.equal(count.rows[0].count, 1);
    console.log('PASS');
  `), 'PASS');
});

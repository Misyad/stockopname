import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes, scryptSync } from 'node:crypto';
import { createServer as createTcpServer } from 'node:net';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const composeFile = `${root}/compose.yaml`;
const password = 'correct horse battery staple';
const ids = {
  regionA: '53000000-0000-0000-0000-000000000001',
  regionB: '53000000-0000-0000-0000-000000000002',
  admin: '53000000-0000-0000-0000-000000000010',
  supervisor: '53000000-0000-0000-0000-000000000011',
  petugas: '53000000-0000-0000-0000-000000000012',
  category: '53000000-0000-0000-0000-000000000020',
  kg: '53000000-0000-0000-0000-000000000030',
  box: '53000000-0000-0000-0000-000000000031',
  warehouseA: '53000000-0000-0000-0000-000000000040',
  warehouseB: '53000000-0000-0000-0000-000000000041',
  productCore: '53000000-0000-0000-0000-000000000060',
  productExpiry: '53000000-0000-0000-0000-000000000061',
  productInsufficient: '53000000-0000-0000-0000-000000000062',
  productConcurrent: '53000000-0000-0000-0000-000000000063',
  productRollback: '53000000-0000-0000-0000-000000000064',
  productRegion: '53000000-0000-0000-0000-000000000065',
  productHttp: '53000000-0000-0000-0000-000000000066',
  productRetry: '53000000-0000-0000-0000-000000000067',
  productOrphan: '53000000-0000-0000-0000-000000000068',
  productReconcile: '53000000-0000-0000-0000-000000000069',
};
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

function runInApp(body, timezone = null, pgOptions = null) {
  const source = `
    import assert from 'node:assert/strict';
    import { pool } from './src/db/pool.js';
    const transactions = await import('./src/services/transactions.js');
    const ids = ${JSON.stringify(ids)};
    const actors = {
      admin: { userId: ids.admin, role: 'ADMIN', regionId: ids.regionA },
      supervisor: { userId: ids.supervisor, role: 'SUPERVISOR', regionId: ids.regionA },
      petugas: { userId: ids.petugas, role: 'PETUGAS', regionId: ids.regionA },
    };
    try { ${body} } finally { await pool.end(); }
  `;
  const environment = [
    ...(timezone ? ['-e', `TZ=${timezone}`] : []),
    ...(pgOptions ? ['-e', `PGOPTIONS=${pgOptions}`] : []),
  ];
  return compose(['exec', '-T', ...environment, 'app', 'node', '--input-type=module', '-'], {
    input: source, stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

before(async () => {
  const appPort = String(await reservePort());
  env = {
    ...process.env,
    APP_PORT: appPort,
    APP_ORIGIN: `http://127.0.0.1:${appPort}`,
    COMPOSE_PROJECT_NAME: `stock_opname_stock_out_${process.pid}`,
    POSTGRES_DB: 'stock_opname_stock_out_test',
    POSTGRES_USER: 'stock_opname_stock_out_test',
    POSTGRES_PASSWORD: randomBytes(24).toString('base64url'),
  };
  compose(['up', '-d', '--build', '--wait', '--wait-timeout', '180']);
  compose(['exec', '-T', 'app', 'node', 'src/db/migrate.js']);
  sql(`
    INSERT INTO regions (id, code, name, status) VALUES
      ('${ids.regionA}', 'OUT-A', 'Stock Out A', 'ACTIVE'),
      ('${ids.regionB}', 'OUT-B', 'Stock Out B', 'ACTIVE');
    INSERT INTO users (id, name, email, password_hash, role, status, region_id) VALUES
      ('${ids.admin}', 'Admin', 'out-admin@example.test', '${passwordHash(password)}', 'ADMIN', 'ACTIVE', '${ids.regionA}'),
      ('${ids.supervisor}', 'Supervisor', 'out-supervisor@example.test', '${passwordHash(password)}', 'SUPERVISOR', 'ACTIVE', '${ids.regionA}'),
      ('${ids.petugas}', 'Petugas', 'out-petugas@example.test', '${passwordHash(password)}', 'PETUGAS', 'ACTIVE', '${ids.regionA}');
    INSERT INTO categories (id, code, name, status)
      VALUES ('${ids.category}', 'OUT-CAT', 'Stock Out', 'ACTIVE');
    INSERT INTO units (id, code, name, symbol, base_unit_id, conversion_to_base, status) VALUES
      ('${ids.kg}', 'OUT-KG', 'Out Kilogram', 'kg', NULL, 1, 'ACTIVE'),
      ('${ids.box}', 'OUT-BOX', 'Out Box', 'box', '${ids.kg}', 10, 'ACTIVE');
    INSERT INTO unit_aliases (id, alias, unit_id, status)
      VALUES ('53000000-0000-0000-0000-000000000032', 'out-boxes', '${ids.box}', 'ACTIVE');
    INSERT INTO warehouses (id, code, name, status, region_id) VALUES
      ('${ids.warehouseA}', 'OUT-WH-A', 'Stock Out Warehouse A', 'ACTIVE', '${ids.regionA}'),
      ('${ids.warehouseB}', 'OUT-WH-B', 'Stock Out Warehouse B', 'ACTIVE', '${ids.regionB}');
    INSERT INTO products (
      id, code, name, category_id, base_unit_id, purchase_unit_id, conversion_factor,
      minimum_stock, maximum_stock, status
    ) VALUES
      ('${ids.productCore}', 'OUT-CORE', 'Out Core', '${ids.category}', '${ids.kg}', '${ids.box}', 10, 0, 1000, 'ACTIVE'),
      ('${ids.productExpiry}', 'OUT-EXP', 'Out Expiry', '${ids.category}', '${ids.kg}', '${ids.box}', 10, 0, 1000, 'ACTIVE'),
      ('${ids.productInsufficient}', 'OUT-LOW', 'Out Low', '${ids.category}', '${ids.kg}', '${ids.box}', 10, 0, 1000, 'ACTIVE'),
      ('${ids.productConcurrent}', 'OUT-CON', 'Out Concurrent', '${ids.category}', '${ids.kg}', '${ids.box}', 10, 0, 1000, 'ACTIVE'),
      ('${ids.productRollback}', 'OUT-ROLL', 'Out Rollback', '${ids.category}', '${ids.kg}', '${ids.box}', 10, 0, 1000, 'ACTIVE'),
      ('${ids.productRegion}', 'OUT-REG', 'Out Region', '${ids.category}', '${ids.kg}', '${ids.box}', 10, 0, 1000, 'ACTIVE'),
      ('${ids.productHttp}', 'OUT-HTTP', 'Out HTTP', '${ids.category}', '${ids.kg}', '${ids.box}', 10, 0, 1000, 'ACTIVE'),
      ('${ids.productRetry}', 'OUT-RETRY', 'Out Retry', '${ids.category}', '${ids.kg}', '${ids.box}', 10, 0, 1000, 'ACTIVE'),
      ('${ids.productOrphan}', 'OUT-ORPHAN', 'Out Orphan', '${ids.category}', '${ids.kg}', '${ids.box}', 10, 0, 1000, 'ACTIVE'),
      ('${ids.productReconcile}', 'OUT-RECON', 'Out Reconcile', '${ids.category}', '${ids.kg}', '${ids.box}', 10, 0, 1000, 'ACTIVE');
  `);
});

after(() => {
  if (!env) return;
  spawnSync('docker', ['compose', '-f', composeFile, 'down', '-v', '--remove-orphans'], {
    cwd: root, env, encoding: 'utf8',
  });
});

const opening = (overrides = {}) => ({
  idempotencyKey: 'out-open-1', date: '2026-10-01', reference: 'OPEN',
  warehouse: 'OUT-WH-A', code: 'OUT-CORE', batch: 'EARLY',
  production_date: '2026-01-01', expiry: '2026-10-20', quantity: 5,
  unit: 'OUT-KG', price: 10, ...overrides,
});
const stockIn = (overrides = {}) => ({
  idempotencyKey: 'out-in-1', date: '2026-10-02', reference: 'IN',
  warehouse: 'OUT-WH-A', code: 'OUT-CORE', batch: 'LATE',
  production_date: '2026-01-02', expiry: '2026-11-20', quantity: 7,
  unit: 'OUT-KG', price: 20, ...overrides,
});
const stockOut = (overrides = {}) => ({
  idempotencyKey: 'out-issue-1', date: '2026-10-11', reference: 'ISSUE',
  warehouse: 'OUT-WH-A', code: 'OUT-CORE', quantity: 8,
  unit: 'OUT-KG', notes: 'Distribution', ...overrides,
});

test('OUT-001/002/004/005 FEFO allocates multiple batches and writes signed immutable ledger', () => {
  assert.equal(runInApp(`
    assert.equal(typeof transactions.createStockOut, 'function');
    await transactions.createOpeningStock(pool, actors.admin, ${JSON.stringify(opening())});
    await transactions.createStockIn(pool, actors.admin, ${JSON.stringify(stockIn())});
    const result = await transactions.createStockOut(pool, actors.admin, ${JSON.stringify(stockOut())});
    assert.equal(result.transactionType, 'OUT');
    assert.equal(result.quantity, '8');
    assert.equal(result.balanceBefore, '12');
    assert.equal(result.balanceAfter, '4');
    assert.equal(result.date, '2026-10-11');
    assert.deepEqual(result.allocations.map(({ quantity }) => quantity), ['5', '3']);
    const state = await pool.query(\`
      SELECT
        (SELECT string_agg(batch_number || ':' || trim_scale(quantity)::text || ':' || status || ':' || trim_scale(purchase_price)::text, ',' ORDER BY batch_number)
           FROM stock_batches WHERE product_id = $1) AS batches,
        (SELECT string_agg(trim_scale(quantity)::text || ':' || trim_scale(balance_before)::text || ':' || trim_scale(balance_after)::text || ':' || trim_scale(unit_price)::text, ',' ORDER BY allocation_index)
           FROM stock_transactions WHERE stock_out_request_id = $2) AS ledgers,
        (SELECT trim_scale(quantity)::text FROM stock_balances WHERE product_id = $1) AS balance
    \`, [ids.productCore, result.id]);
    assert.deepEqual(state.rows[0], {
      batches: 'EARLY:0:DEPLETED:10,LATE:4:ACTIVE:20',
      ledgers: '-5:12:7:10,-3:7:4:20',
      balance: '4',
    });
    console.log('PASS');
  `), 'PASS');
});

test('OUT-002/003 FEFO excludes expired, includes boundary, and puts NULL expiry last', () => {
  assert.equal(runInApp(`
    const base = ${JSON.stringify(opening())};
    await transactions.createOpeningStock(pool, actors.admin, {
      ...base, idempotencyKey: 'expiry-open', code: 'OUT-EXP', batch: 'EXPIRED',
      expiry: '2026-10-10', quantity: 4,
    });
    const receipts = [
      ['BOUNDARY', '2026-10-11', 3, 11],
      ['FUTURE', '2026-12-01', 2, 12],
      ['NO-EXPIRY', null, 5, 13],
    ];
    for (const [batch, expiry, quantity, price] of receipts) {
      await transactions.createStockIn(pool, actors.admin, {
        ...${JSON.stringify(stockIn())}, idempotencyKey: \`expiry-in-\${batch}\`, code: 'OUT-EXP',
        batch, expiry, quantity, price,
      });
    }
    const result = await transactions.createStockOut(pool, actors.admin, {
      ...${JSON.stringify(stockOut())}, idempotencyKey: 'expiry-out', code: 'OUT-EXP', quantity: 6,
    });
    const batches = await pool.query(\`
      SELECT batch_number FROM stock_transactions transactions
      JOIN stock_batches batches ON batches.id = transactions.batch_id
      WHERE transactions.stock_out_request_id = $1 ORDER BY transactions.allocation_index
    \`, [result.id]);
    assert.deepEqual(batches.rows.map(({ batch_number }) => batch_number), ['BOUNDARY', 'FUTURE', 'NO-EXPIRY']);
    assert.deepEqual(result.allocations.map(({ quantity }) => quantity), ['3', '2', '1']);
    console.log('PASS');
  `), 'PASS');
});

test('OUT-001/007 converts purchase unit and insufficient request is all-or-nothing', () => {
  assert.equal(runInApp(`
    await transactions.createOpeningStock(pool, actors.admin, {
      ...${JSON.stringify(opening())}, idempotencyKey: 'low-open', code: 'OUT-LOW',
      batch: 'ELIGIBLE', quantity: 15,
    });
    const converted = await transactions.createStockOut(pool, actors.admin, {
      ...${JSON.stringify(stockOut())}, idempotencyKey: 'low-convert', code: 'OUT-LOW',
      quantity: 1, unit: 'out-boxes',
    });
    assert.equal(converted.quantity, '10');
    assert.equal(converted.balanceAfter, '5');
    const before = await pool.query(\`
      SELECT (SELECT count(*)::int FROM stock_out_requests WHERE product_id = $1) AS requests,
        (SELECT count(*)::int FROM stock_transactions WHERE product_id = $1) AS ledgers,
        (SELECT trim_scale(quantity)::text FROM stock_balances WHERE product_id = $1) AS balance
    \`, [ids.productInsufficient]);
    await assert.rejects(
      transactions.createStockOut(pool, actors.admin, {
        ...${JSON.stringify(stockOut())}, idempotencyKey: 'low-reject', code: 'OUT-LOW', quantity: 6,
      }),
      (error) => error.status === 409 && error.errorCode === 'INSUFFICIENT_STOCK',
    );
    const after = await pool.query(\`
      SELECT (SELECT count(*)::int FROM stock_out_requests WHERE product_id = $1) AS requests,
        (SELECT count(*)::int FROM stock_transactions WHERE product_id = $1) AS ledgers,
        (SELECT trim_scale(quantity)::text FROM stock_balances WHERE product_id = $1) AS balance
    \`, [ids.productInsufficient]);
    assert.deepEqual(after.rows[0], before.rows[0]);
    console.log('PASS');
  `), 'PASS');
});

test('OUT-008/009 canonical retry returns prior aggregate and conflicts on payload or actor', () => {
  assert.equal(runInApp(`
    await transactions.createOpeningStock(pool, actors.admin, {
      ...${JSON.stringify(opening())}, idempotencyKey: 'retry-open', code: 'OUT-RETRY',
      batch: 'RETRY', quantity: 10,
    });
    const first = await transactions.createStockOut(pool, actors.admin, {
      ...${JSON.stringify(stockOut())}, idempotencyKey: 'retry-out', code: 'OUT-RETRY',
      quantity: 0.2, unit: 'OUT-BOX',
    });
    const retry = await transactions.createStockOut(pool, actors.admin, {
      ...${JSON.stringify(stockOut())}, idempotencyKey: 'retry-out', code: 'OUT-RETRY',
      quantity: 2, unit: 'OUT-KG',
    });
    assert.equal(retry.id, first.id);
    assert.deepEqual(retry.allocations, first.allocations);
    await assert.rejects(
      transactions.createStockOut(pool, actors.admin, {
        ...${JSON.stringify(stockOut())}, idempotencyKey: 'retry-out', code: 'OUT-RETRY', quantity: 3,
      }),
      (error) => error.status === 409 && error.errorCode === 'IDEMPOTENCY_CONFLICT',
    );
    await assert.rejects(
      transactions.createStockOut(pool, actors.supervisor, {
        ...${JSON.stringify(stockOut())}, idempotencyKey: 'retry-out', code: 'OUT-RETRY', quantity: 2,
      }),
      (error) => error.status === 409 && error.errorCode === 'IDEMPOTENCY_CONFLICT',
    );
    await assert.rejects(
      transactions.createStockIn(pool, actors.admin, {
        ...${JSON.stringify(stockIn())}, idempotencyKey: 'retry-out', code: 'OUT-RETRY',
      }),
      (error) => error.status === 409 && error.errorCode === 'IDEMPOTENCY_CONFLICT',
    );
    await assert.rejects(
      transactions.createStockOut(pool, actors.admin, {
        ...${JSON.stringify(stockOut())}, idempotencyKey: 'retry-open', code: 'OUT-RETRY', quantity: 1,
      }),
      (error) => error.status === 409 && error.errorCode === 'IDEMPOTENCY_CONFLICT',
    );
    const state = await pool.query(\`
      SELECT (SELECT count(*)::int FROM stock_out_requests WHERE product_id = $1) AS requests,
        (SELECT count(*)::int FROM stock_transactions WHERE stock_out_request_id = $2) AS allocations,
        (SELECT trim_scale(quantity)::text FROM stock_balances WHERE product_id = $1) AS balance
    \`, [ids.productRetry, first.id]);
    assert.deepEqual(state.rows[0], { requests: 1, allocations: 1, balance: '8' });
    console.log('PASS');
  `), 'PASS');
});

test('OUT-008 concurrent duplicate key creates one request and one allocation set', () => {
  assert.equal(runInApp(`
    const payload = {
      ...${JSON.stringify(stockOut())}, idempotencyKey: 'retry-concurrent',
      code: 'OUT-RETRY', quantity: 1,
    };
    const [first, second] = await Promise.all([
      transactions.createStockOut(pool, actors.admin, payload),
      transactions.createStockOut(pool, actors.admin, payload),
    ]);
    assert.equal(first.id, second.id);
    assert.deepEqual(first.allocations, second.allocations);
    const state = await pool.query(\`
      SELECT count(DISTINCT requests.id)::int AS requests,
        count(transactions.id)::int AS allocations
      FROM stock_out_requests requests
      LEFT JOIN stock_transactions transactions ON transactions.stock_out_request_id = requests.id
      WHERE requests.idempotency_key = 'retry-concurrent'
    \`);
    assert.deepEqual(state.rows[0], { requests: 1, allocations: 1 });
    console.log('PASS');
  `), 'PASS');
});

test('OUT-008 identical retry survives lifecycle drift; new key fails inactive state', () => {
  assert.equal(runInApp(`
    const payload = {
      ...${JSON.stringify(stockOut())}, idempotencyKey: 'retry-lifecycle',
      code: 'OUT-RETRY', quantity: 0.1, unit: 'out-boxes',
    };
    const first = await transactions.createStockOut(pool, actors.admin, payload);
    const targets = [
      ['products', 'id', ids.productRetry, 'INVALID_PRODUCT'],
      ['categories', 'id', ids.category, 'INVALID_PRODUCT'],
      ['units', 'id', ids.kg, 'INVALID_PRODUCT'],
      ['units', 'id', ids.box, 'INVALID_PRODUCT'],
      ['warehouses', 'id', ids.warehouseA, 'INVALID_WAREHOUSE'],
      ['unit_aliases', 'alias', 'out-boxes', 'INVALID_UNIT'],
    ];
    for (const [index, [table, field, value, code]] of targets.entries()) {
      await pool.query(\`UPDATE \${table} SET status = 'INACTIVE' WHERE \${field} = $1\`, [value]);
      try {
        const retry = await transactions.createStockOut(pool, actors.admin, payload);
        assert.equal(retry.id, first.id);
        await assert.rejects(
          transactions.createStockOut(pool, actors.admin, {
            ...payload, idempotencyKey: \`retry-lifecycle-new-\${index}\`,
          }),
          (error) => error.errorCode === code,
        );
      } finally {
        await pool.query(\`UPDATE \${table} SET status = 'ACTIVE' WHERE \${field} = $1\`, [value]);
      }
    }
    console.log('PASS');
  `), 'PASS');
});

test('OUT-008 calendar response is stable under Jakarta TZ and SQL,DMY DateStyle', () => {
  assert.equal(runInApp(`
    const retry = await transactions.createStockOut(pool, actors.admin, {
      ...${JSON.stringify(stockOut())}, idempotencyKey: 'retry-lifecycle',
      code: 'OUT-RETRY', quantity: 0.1, unit: 'out-boxes',
    });
    assert.equal(retry.date, '2026-10-11');
    console.log('PASS');
  `, 'Asia/Jakarta', '-c DateStyle=SQL,DMY'), 'PASS');
});

test('OUT-009/010 rejects unknown fields, invalid quantity, and cross-region before mutation', () => {
  assert.equal(runInApp(`
    const cases = [
      [{ ...${JSON.stringify(stockOut())}, idempotencyKey: 'bad-field', code: 'OUT-REG', batch: 'CLIENT' }, 'VALIDATION_ERROR'],
      [{ ...${JSON.stringify(stockOut())}, idempotencyKey: 'bad-quantity', code: 'OUT-REG', quantity: 0 }, 'INVALID_QUANTITY'],
      [{ ...${JSON.stringify(stockOut())}, idempotencyKey: 'bad-region', code: 'OUT-REG', warehouse: 'OUT-WH-B' }, 'REGION_FORBIDDEN'],
    ];
    for (const [payload, code] of cases) {
      await assert.rejects(
        transactions.createStockOut(pool, actors.petugas, payload),
        (error) => error.errorCode === code,
      );
    }
    const count = await pool.query('SELECT count(*)::int AS count FROM stock_out_requests WHERE product_id = $1', [ids.productRegion]);
    assert.equal(count.rows[0].count, 0);
    console.log('PASS');
  `), 'PASS');
});

test('OUT-006/010 HTTP route enforces guards and permits all roles only in own region', async () => {
  assert.equal(runInApp(`
    await transactions.createOpeningStock(pool, actors.admin, {
      ...${JSON.stringify(opening())}, idempotencyKey: 'http-open', code: 'OUT-HTTP',
      batch: 'HTTP', quantity: 10,
    });
    console.log('PASS');
  `), 'PASS');
  const cookies = await Promise.all([
    login('out-admin@example.test'),
    login('out-supervisor@example.test'),
    login('out-petugas@example.test'),
  ]);
  const tokens = await Promise.all(cookies.map(csrf));
  const base = stockOut({ code: 'OUT-HTTP', quantity: 1 });
  const guarded = [
    { headers: { 'content-type': 'application/json', origin: env.APP_ORIGIN }, status: 401, code: 'UNAUTHENTICATED' },
    { headers: { ...cookieHeader(cookies[0]), 'content-type': 'application/json', 'x-csrf-token': tokens[0] }, status: 403, code: 'ORIGIN_INVALID' },
    { headers: { ...cookieHeader(cookies[0]), 'content-type': 'application/json', origin: env.APP_ORIGIN }, status: 403, code: 'CSRF_INVALID' },
    { headers: mutationHeaders(cookies[0], 'wrong'), status: 403, code: 'CSRF_INVALID' },
    { headers: { ...mutationHeaders(cookies[0], tokens[0]), 'content-type': 'text/plain' }, status: 415, code: 'UNSUPPORTED_MEDIA_TYPE' },
  ];
  for (const entry of guarded) {
    const result = await request('/transactions/out', {
      method: 'POST', headers: entry.headers, body: JSON.stringify(base),
    });
    assert.equal(result.response.status, entry.status, JSON.stringify(result.body));
    assert.equal(result.body.errorCode, entry.code);
  }
  for (const [index, cookie] of cookies.entries()) {
    const crossRegion = await request('/transactions/out', {
      method: 'POST', headers: mutationHeaders(cookie, tokens[index]),
      body: JSON.stringify({
        ...base, idempotencyKey: `out-http-region-${index}`, warehouse: 'OUT-WH-B',
      }),
    });
    assert.equal(crossRegion.response.status, 403, JSON.stringify(crossRegion.body));
    assert.equal(crossRegion.body.errorCode, 'REGION_FORBIDDEN');
    const created = await request('/transactions/out', {
      method: 'POST', headers: mutationHeaders(cookie, tokens[index]),
      body: JSON.stringify({ ...base, idempotencyKey: `out-http-own-${index}` }),
    });
    assert.equal(created.response.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.data.transactionType, 'OUT');
  }
  assert.equal(sql(`SELECT count(*) FROM stock_out_requests WHERE product_id = '${ids.productHttp}'`), '3');
});

test('OUT-011 concurrent requests cannot oversell', () => {
  assert.equal(runInApp(`
    await transactions.createOpeningStock(pool, actors.admin, {
      ...${JSON.stringify(opening())}, idempotencyKey: 'race-open', code: 'OUT-CON',
      batch: 'RACE', quantity: 10,
    });
    const base = {
      ...${JSON.stringify(stockOut())}, code: 'OUT-CON', quantity: 7,
    };
    const settled = await Promise.allSettled([
      transactions.createStockOut(pool, actors.admin, { ...base, idempotencyKey: 'race-a' }),
      transactions.createStockOut(pool, actors.petugas, { ...base, idempotencyKey: 'race-b' }),
    ]);
    assert.equal(settled.filter(({ status }) => status === 'fulfilled').length, 1);
    const rejected = settled.find(({ status }) => status === 'rejected');
    assert.equal(rejected.reason.errorCode, 'INSUFFICIENT_STOCK');
    const state = await pool.query(\`
      SELECT (SELECT count(*)::int FROM stock_out_requests WHERE product_id = $1) AS requests,
        (SELECT count(*)::int FROM stock_transactions WHERE stock_out_request_id IN
          (SELECT id FROM stock_out_requests WHERE product_id = $1)) AS allocations,
        (SELECT trim_scale(quantity)::text FROM stock_balances WHERE product_id = $1) AS balance,
        (SELECT trim_scale(quantity)::text FROM stock_batches WHERE product_id = $1) AS batch
    \`, [ids.productConcurrent]);
    assert.deepEqual(state.rows[0], { requests: 1, allocations: 1, balance: '3', batch: '3' });
    console.log('PASS');
  `), 'PASS');
});

test('OUT-012 audit failure rolls back request, ledger, batch, and balance', () => {
  assert.equal(runInApp(`
    await transactions.createOpeningStock(pool, actors.admin, {
      ...${JSON.stringify(opening())}, idempotencyKey: 'rollback-open', code: 'OUT-ROLL',
      batch: 'ROLLBACK', quantity: 10,
    });
    await pool.query(\`
      CREATE FUNCTION reject_stock_out_audit() RETURNS trigger LANGUAGE plpgsql AS $function$
      BEGIN IF NEW.action = 'STOCK_OUT' THEN RAISE EXCEPTION 'forced stock-out audit failure'; END IF; RETURN NEW; END
      $function$;
      CREATE TRIGGER reject_stock_out_audit BEFORE INSERT ON audit_logs
        FOR EACH ROW EXECUTE FUNCTION reject_stock_out_audit()
    \`);
    try {
      await assert.rejects(transactions.createStockOut(pool, actors.admin, {
        ...${JSON.stringify(stockOut())}, idempotencyKey: 'rollback-out', code: 'OUT-ROLL', quantity: 4,
      }));
    } finally {
      await pool.query('DROP TRIGGER reject_stock_out_audit ON audit_logs; DROP FUNCTION reject_stock_out_audit()');
    }
    const state = await pool.query(\`
      SELECT (SELECT count(*)::int FROM stock_out_requests WHERE product_id = $1) AS requests,
        (SELECT count(*)::int FROM stock_transactions WHERE product_id = $1 AND transaction_type = 'OUT') AS outs,
        (SELECT trim_scale(quantity)::text FROM stock_balances WHERE product_id = $1) AS balance,
        (SELECT trim_scale(quantity)::text FROM stock_batches WHERE product_id = $1) AS batch
    \`, [ids.productRollback]);
    assert.deepEqual(state.rows[0], { requests: 0, outs: 0, balance: '10', batch: '10' });
    console.log('PASS');
  `), 'PASS');
});

test('OUT-014 orphan pre-state fails closed before mutation', () => {
  sql(`
    INSERT INTO stock_balances (id, product_id, warehouse_id, quantity, version)
    VALUES (gen_random_uuid(), '${ids.productOrphan}', '${ids.warehouseA}', 7, 1)
  `);
  assert.equal(runInApp(`
    await assert.rejects(
      transactions.createStockOut(pool, actors.admin, {
        ...${JSON.stringify(stockOut())}, idempotencyKey: 'orphan-out',
        code: 'OUT-ORPHAN', quantity: 1,
      }),
      (error) => error.status === 409 && error.errorCode === 'INVENTORY_RECONCILIATION_FAILED',
    );
    const state = await pool.query(\`
      SELECT (SELECT count(*)::int FROM stock_out_requests WHERE product_id = $1) AS requests,
        (SELECT count(*)::int FROM stock_transactions WHERE product_id = $1) AS ledgers,
        (SELECT count(*)::int FROM stock_batches WHERE product_id = $1) AS batches,
        (SELECT trim_scale(quantity)::text FROM stock_balances WHERE product_id = $1) AS balance
    \`, [ids.productOrphan]);
    assert.deepEqual(state.rows[0], { requests: 0, ledgers: 0, batches: 0, balance: '7' });
    console.log('PASS');
  `), 'PASS');
});

test('OUT-014 forced post-reconciliation corruption rolls back all Stock Out state', () => {
  assert.equal(runInApp(`
    await transactions.createOpeningStock(pool, actors.admin, {
      ...${JSON.stringify(opening())}, idempotencyKey: 'recon-open', code: 'OUT-RECON',
      batch: 'RECON', quantity: 10,
    });
    await pool.query(\`
      CREATE FUNCTION corrupt_stock_out_balance() RETURNS trigger LANGUAGE plpgsql AS $function$
      BEGIN
        IF NEW.product_id = '${ids.productReconcile}' AND NEW.quantity < OLD.quantity
          THEN NEW.quantity = NEW.quantity + 1;
        END IF;
        RETURN NEW;
      END
      $function$;
      CREATE TRIGGER corrupt_stock_out_balance BEFORE UPDATE ON stock_balances
        FOR EACH ROW EXECUTE FUNCTION corrupt_stock_out_balance()
    \`);
    try {
      await assert.rejects(
        transactions.createStockOut(pool, actors.admin, {
          ...${JSON.stringify(stockOut())}, idempotencyKey: 'recon-out',
          code: 'OUT-RECON', quantity: 4,
        }),
        (error) => error.status === 409 && error.errorCode === 'INVENTORY_RECONCILIATION_FAILED',
      );
    } finally {
      await pool.query('DROP TRIGGER corrupt_stock_out_balance ON stock_balances; DROP FUNCTION corrupt_stock_out_balance()');
    }
    const state = await pool.query(\`
      SELECT (SELECT count(*)::int FROM stock_out_requests WHERE product_id = $1) AS requests,
        (SELECT count(*)::int FROM stock_transactions WHERE product_id = $1 AND transaction_type = 'OUT') AS outs,
        (SELECT count(*)::int FROM audit_logs WHERE action = 'STOCK_OUT' AND details->>'productId' = $1::text) AS audits,
        (SELECT trim_scale(quantity)::text FROM stock_balances WHERE product_id = $1) AS balance,
        (SELECT trim_scale(quantity)::text FROM stock_batches WHERE product_id = $1) AS batch
    \`, [ids.productReconcile]);
    assert.deepEqual(state.rows[0], { requests: 0, outs: 0, audits: 0, balance: '10', batch: '10' });
    console.log('PASS');
  `), 'PASS');
});

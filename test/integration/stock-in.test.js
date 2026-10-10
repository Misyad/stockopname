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
  regionA: '52000000-0000-0000-0000-000000000001',
  regionB: '52000000-0000-0000-0000-000000000002',
  admin: '52000000-0000-0000-0000-000000000010',
  supervisor: '52000000-0000-0000-0000-000000000011',
  petugas: '52000000-0000-0000-0000-000000000012',
  category: '52000000-0000-0000-0000-000000000020',
  kg: '52000000-0000-0000-0000-000000000030',
  box: '52000000-0000-0000-0000-000000000031',
  warehouseA: '52000000-0000-0000-0000-000000000040',
  warehouseB: '52000000-0000-0000-0000-000000000041',
  supplier: '52000000-0000-0000-0000-000000000050',
  supplierInactive: '52000000-0000-0000-0000-000000000051',
  productNew: '52000000-0000-0000-0000-000000000060',
  productExisting: '52000000-0000-0000-0000-000000000061',
  productConcurrent: '52000000-0000-0000-0000-000000000062',
  productRollback: '52000000-0000-0000-0000-000000000063',
  productRegion: '52000000-0000-0000-0000-000000000064',
  productHttp: '52000000-0000-0000-0000-000000000065',
  productOrphan: '52000000-0000-0000-0000-000000000066',
  productReconcile: '52000000-0000-0000-0000-000000000067',
  productDuplicate: '52000000-0000-0000-0000-000000000068',
  productUnbatched: '52000000-0000-0000-0000-000000000069',
  productTimezone: '52000000-0000-0000-0000-000000000070',
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
    COMPOSE_PROJECT_NAME: `stock_opname_stock_in_${process.pid}`,
    POSTGRES_DB: 'stock_opname_stock_in_test',
    POSTGRES_USER: 'stock_opname_stock_in_test',
    POSTGRES_PASSWORD: randomBytes(24).toString('base64url'),
  };
  compose(['up', '-d', '--build', '--wait', '--wait-timeout', '180']);
  compose(['exec', '-T', 'app', 'node', 'src/db/migrate.js']);
  sql(`
    INSERT INTO regions (id, code, name, status) VALUES
      ('${ids.regionA}', 'IN-A', 'Stock In A', 'ACTIVE'),
      ('${ids.regionB}', 'IN-B', 'Stock In B', 'ACTIVE');
    INSERT INTO users (id, name, email, password_hash, role, status, region_id) VALUES
      ('${ids.admin}', 'Admin', 'in-admin@example.test', '${passwordHash(password)}', 'ADMIN', 'ACTIVE', '${ids.regionA}'),
      ('${ids.supervisor}', 'Supervisor', 'in-supervisor@example.test', '${passwordHash(password)}', 'SUPERVISOR', 'ACTIVE', '${ids.regionA}'),
      ('${ids.petugas}', 'Petugas', 'in-petugas@example.test', '${passwordHash(password)}', 'PETUGAS', 'ACTIVE', '${ids.regionA}');
    INSERT INTO categories (id, code, name, status)
      VALUES ('${ids.category}', 'IN-CAT', 'Stock In', 'ACTIVE');
    INSERT INTO units (id, code, name, symbol, base_unit_id, conversion_to_base, status) VALUES
      ('${ids.kg}', 'IN-KG', 'In Kilogram', 'kg', NULL, 1, 'ACTIVE'),
      ('${ids.box}', 'IN-BOX', 'In Box', 'box', '${ids.kg}', 10, 'ACTIVE');
    INSERT INTO unit_aliases (id, alias, unit_id, status)
      VALUES ('52000000-0000-0000-0000-000000000032', 'in-boxes', '${ids.box}', 'ACTIVE');
    INSERT INTO warehouses (id, code, name, status, region_id) VALUES
      ('${ids.warehouseA}', 'IN-WH-A', 'Stock In Warehouse A', 'ACTIVE', '${ids.regionA}'),
      ('${ids.warehouseB}', 'IN-WH-B', 'Stock In Warehouse B', 'ACTIVE', '${ids.regionB}');
    INSERT INTO suppliers (id, code, name, status) VALUES
      ('${ids.supplier}', 'IN-SUP', 'Stock In Supplier', 'ACTIVE'),
      ('${ids.supplierInactive}', 'IN-SUP-OFF', 'Inactive Supplier', 'INACTIVE');
    INSERT INTO products (
      id, code, name, category_id, base_unit_id, purchase_unit_id, conversion_factor,
      minimum_stock, maximum_stock, status
    ) VALUES
      ('${ids.productNew}', 'IN-NEW', 'In New', '${ids.category}', '${ids.kg}', '${ids.box}', 10, 0, 1000, 'ACTIVE'),
      ('${ids.productExisting}', 'IN-EXIST', 'In Existing', '${ids.category}', '${ids.kg}', '${ids.box}', 10, 0, 1000, 'ACTIVE'),
      ('${ids.productConcurrent}', 'IN-CON', 'In Concurrent', '${ids.category}', '${ids.kg}', '${ids.box}', 10, 0, 1000, 'ACTIVE'),
      ('${ids.productRollback}', 'IN-ROLL', 'In Rollback', '${ids.category}', '${ids.kg}', '${ids.box}', 10, 0, 1000, 'ACTIVE'),
      ('${ids.productRegion}', 'IN-REG', 'In Region', '${ids.category}', '${ids.kg}', '${ids.box}', 10, 0, 1000, 'ACTIVE'),
      ('${ids.productHttp}', 'IN-HTTP', 'In HTTP', '${ids.category}', '${ids.kg}', '${ids.box}', 10, 0, 1000, 'ACTIVE'),
      ('${ids.productOrphan}', 'IN-ORPHAN', 'In Orphan', '${ids.category}', '${ids.kg}', '${ids.box}', 10, 0, 1000, 'ACTIVE'),
      ('${ids.productReconcile}', 'IN-RECON', 'In Reconcile', '${ids.category}', '${ids.kg}', '${ids.box}', 10, 0, 1000, 'ACTIVE'),
      ('${ids.productDuplicate}', 'IN-DUP', 'In Duplicate', '${ids.category}', '${ids.kg}', '${ids.box}', 10, 0, 1000, 'ACTIVE'),
      ('${ids.productUnbatched}', 'IN-UNBATCHED', 'In Unbatched', '${ids.category}', '${ids.kg}', '${ids.box}', 10, 0, 1000, 'ACTIVE'),
      ('${ids.productTimezone}', 'IN-TZ', 'In Timezone', '${ids.category}', '${ids.kg}', '${ids.box}', 10, 0, 1000, 'ACTIVE');
  `);
});

after(() => {
  if (!env) return;
  spawnSync('docker', ['compose', '-f', composeFile, 'down', '-v', '--remove-orphans'], {
    cwd: root, env, encoding: 'utf8',
  });
});

const stockIn = (overrides = {}) => ({
  idempotencyKey: 'stock-in-new-001', date: '2026-10-10', reference: 'RECEIPT-001',
  warehouse: 'IN-WH-A', code: 'IN-NEW', supplier: 'IN-SUP', batch: 'IN-BATCH-1',
  production_date: '2026-10-01', expiry: '2027-10-01', quantity: 2,
  unit: 'in-boxes', price: 100, notes: 'Receipt', ...overrides,
});

test('IN-006/007 HTTP route enforces guards and permits all roles only in own region', async () => {
  const cookies = await Promise.all([
    login('in-admin@example.test'),
    login('in-supervisor@example.test'),
    login('in-petugas@example.test'),
  ]);
  const tokens = await Promise.all(cookies.map(csrf));
  const base = stockIn({ code: 'IN-HTTP', batch: 'HTTP-BATCH', unit: 'IN-KG', quantity: 1 });
  const guarded = [
    { headers: { 'content-type': 'application/json', origin: env.APP_ORIGIN }, status: 401, code: 'UNAUTHENTICATED' },
    { headers: { ...cookieHeader(cookies[0]), 'content-type': 'application/json', 'x-csrf-token': tokens[0] }, status: 403, code: 'ORIGIN_INVALID' },
    { headers: { ...cookieHeader(cookies[0]), 'content-type': 'application/json', origin: env.APP_ORIGIN }, status: 403, code: 'CSRF_INVALID' },
    { headers: mutationHeaders(cookies[0], 'wrong'), status: 403, code: 'CSRF_INVALID' },
    { headers: { ...mutationHeaders(cookies[0], tokens[0]), 'content-type': 'text/plain' }, status: 415, code: 'UNSUPPORTED_MEDIA_TYPE' },
  ];
  for (const entry of guarded) {
    const result = await request('/transactions/in', {
      method: 'POST', headers: entry.headers, body: JSON.stringify(base),
    });
    assert.equal(result.response.status, entry.status, JSON.stringify(result.body));
    assert.equal(result.body.errorCode, entry.code);
  }
  for (const [index, cookie] of cookies.entries()) {
    const crossRegion = await request('/transactions/in', {
      method: 'POST', headers: mutationHeaders(cookie, tokens[index]),
      body: JSON.stringify({
        ...base, idempotencyKey: `stock-in-http-region-${index}`, warehouse: 'IN-WH-B',
      }),
    });
    assert.equal(crossRegion.response.status, 403, JSON.stringify(crossRegion.body));
    assert.equal(crossRegion.body.errorCode, 'REGION_FORBIDDEN');
    const created = await request('/transactions/in', {
      method: 'POST', headers: mutationHeaders(cookie, tokens[index]),
      body: JSON.stringify({
        ...base, idempotencyKey: `stock-in-http-own-${index}`, reference: `HTTP-${index}`,
      }),
    });
    assert.equal(created.response.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.data.transactionType, 'IN');
  }
  assert.equal(sql(`SELECT count(*) FROM stock_transactions WHERE product_id = '${ids.productHttp}'`), '3');
});

test('IN-001/002/005 receipt commits base quantity, supplier, batch, balance, ledger, and audit', () => {
  assert.equal(runInApp(`
    assert.equal(typeof transactions.createStockIn, 'function');
    const result = await transactions.createStockIn(pool, actors.admin, ${JSON.stringify(stockIn())});
    assert.equal(result.transactionType, 'IN');
    assert.equal(result.quantity, '20');
    assert.equal(result.unit, 'IN-KG');
    assert.equal(result.balanceBefore, '0');
    assert.equal(result.balanceAfter, '20');
    const state = await pool.query(\`
      SELECT
        (SELECT count(*)::int FROM stock_transactions WHERE product_id = $1) AS ledgers,
        (SELECT supplier_id::text FROM stock_transactions WHERE product_id = $1) AS supplier_id,
        (SELECT quantity::text FROM stock_batches WHERE product_id = $1) AS batch_quantity,
        (SELECT quantity::text FROM stock_balances WHERE product_id = $1) AS balance_quantity,
        (SELECT count(*)::int FROM audit_logs WHERE action = 'STOCK_IN' AND reference = $2) AS audits,
        (SELECT details->>'purchasePrice' FROM audit_logs
          WHERE action = 'STOCK_IN' AND reference = $2) AS purchase_price
    \`, [ids.productNew, result.id]);
    assert.deepEqual(state.rows[0], {
      ledgers: 1, supplier_id: ids.supplier, batch_quantity: '20',
      balance_quantity: '20', audits: 1, purchase_price: '100',
    });
    console.log('PASS');
  `), 'PASS');
});

test('IN-003/004 existing batch increments with weighted-average price and valid ledger chain', () => {
  assert.equal(runInApp(`
    const first = await transactions.createStockIn(pool, actors.supervisor, ${JSON.stringify(stockIn({
      idempotencyKey: 'stock-in-existing-1', reference: 'RECEIPT-EX-1', code: 'IN-EXIST',
      batch: 'EXIST-BATCH', quantity: 10, unit: 'IN-KG', price: 50,
    }))});
    const second = await transactions.createStockIn(pool, actors.petugas, ${JSON.stringify(stockIn({
      idempotencyKey: 'stock-in-existing-2', reference: 'RECEIPT-EX-2', code: 'IN-EXIST',
      batch: 'EXIST-BATCH', quantity: 5, unit: 'IN-KG', price: 100,
    }))});
    assert.equal(first.balanceAfter, '10');
    assert.equal(second.balanceBefore, '10');
    assert.equal(second.balanceAfter, '15');
    const state = await pool.query(\`
      SELECT
        (SELECT count(*)::int FROM stock_batches WHERE product_id = $1) AS batches,
        (SELECT quantity::text FROM stock_batches WHERE product_id = $1) AS batch_quantity,
        (SELECT round(purchase_price, 4)::text FROM stock_batches WHERE product_id = $1) AS price,
        (SELECT quantity::text FROM stock_balances WHERE product_id = $1) AS balance_quantity,
        (SELECT count(*)::int FROM stock_transactions WHERE product_id = $1) AS ledgers
    \`, [ids.productExisting]);
    assert.deepEqual(state.rows[0], {
      batches: 1, batch_quantity: '15', price: '66.6667', balance_quantity: '15', ledgers: 2,
    });
    console.log('PASS');
  `), 'PASS');
});

test('IN-003 existing batch date metadata is timezone-independent', () => {
  assert.equal(runInApp(`
    const base = ${JSON.stringify(stockIn({
      code: 'IN-TZ', batch: 'TZ-BATCH', unit: 'IN-KG', quantity: 1,
    }))};
    await transactions.createStockIn(pool, actors.admin, {
      ...base, idempotencyKey: 'stock-in-tz-1', reference: 'TZ-1',
    });
    const result = await transactions.createStockIn(pool, actors.admin, {
      ...base, idempotencyKey: 'stock-in-tz-2', reference: 'TZ-2',
    });
    assert.equal(result.balanceAfter, '2');
    assert.equal(result.date, '2026-10-10');
    console.log('PASS');
  `, 'Asia/Jakarta', '-c DateStyle=SQL,DMY'), 'PASS');
});

test('IN-003 repeated unbatched receipt reuses the NULL batch identity', () => {
  assert.equal(runInApp(`
    const base = ${JSON.stringify(stockIn({
      code: 'IN-UNBATCHED', batch: undefined, production_date: undefined,
      expiry: undefined, unit: 'IN-KG', quantity: 2, price: 40,
    }))};
    await transactions.createStockIn(pool, actors.admin, {
      ...base, idempotencyKey: 'stock-in-unbatched-1', reference: 'UNBATCHED-1',
    });
    await transactions.createStockIn(pool, actors.supervisor, {
      ...base, idempotencyKey: 'stock-in-unbatched-2', reference: 'UNBATCHED-2',
    });
    const state = await pool.query(\`
      SELECT
        (SELECT count(*)::int FROM stock_batches WHERE product_id = $1) AS batches,
        (SELECT quantity::text FROM stock_batches WHERE product_id = $1) AS batch_quantity,
        (SELECT quantity::text FROM stock_balances WHERE product_id = $1) AS balance_quantity,
        (SELECT count(*)::int FROM stock_transactions WHERE product_id = $1) AS ledgers
    \`, [ids.productUnbatched]);
    assert.deepEqual(state.rows[0], {
      batches: 1, batch_quantity: '4', balance_quantity: '4', ledgers: 2,
    });
    console.log('PASS');
  `), 'PASS');
});

test('IN-008 identical retry is stable; changed payload and actor conflict', () => {
  assert.equal(runInApp(`
    const payload = ${JSON.stringify(stockIn({
      idempotencyKey: 'stock-in-retry-master-001',
      reference: 'RECEIPT-RETRY',
      batch: 'IN-BATCH-RETRY',
    }))};
    const first = await transactions.createStockIn(pool, actors.admin, payload);
    const retry = await transactions.createStockIn(pool, actors.admin, payload);
    assert.equal(retry.id, first.id);
    for (const [table, id] of [
      ['products', ids.productNew],
      ['warehouses', ids.warehouseA],
      ['units', ids.box],
      ['suppliers', ids.supplier],
    ]) {
      await pool.query(\`UPDATE \${table} SET status = 'INACTIVE' WHERE id = $1\`, [id]);
      let retryAfterMasterChange;
      try {
        retryAfterMasterChange = await transactions.createStockIn(pool, actors.admin, payload);
      } finally {
        await pool.query(\`UPDATE \${table} SET status = 'ACTIVE' WHERE id = $1\`, [id]);
      }
      assert.equal(retryAfterMasterChange.id, first.id);
    }
    await assert.rejects(
      transactions.createStockIn(pool, actors.admin, { ...payload, quantity: 3 }),
      (error) => error.status === 409 && error.errorCode === 'IDEMPOTENCY_CONFLICT',
    );
    await assert.rejects(
      transactions.createStockIn(pool, actors.supervisor, payload),
      (error) => error.status === 409 && error.errorCode === 'IDEMPOTENCY_CONFLICT',
    );
    const state = await pool.query(
      'SELECT count(*)::int AS count FROM stock_transactions WHERE idempotency_key = $1',
      [payload.idempotencyKey],
    );
    assert.equal(state.rows[0].count, 1);
    console.log('PASS');
  `), 'PASS');
});

test('IN-006 all roles are limited to own region using current DB actor', () => {
  assert.equal(runInApp(`
    for (const [index, actor] of Object.values(actors).entries()) {
      await assert.rejects(
        transactions.createStockIn(pool, { ...actor, role: 'ADMIN', regionId: ids.regionB }, ${JSON.stringify(stockIn({
          warehouse: 'IN-WH-B', code: 'IN-REG', batch: 'REGION-BATCH',
        }))}.constructor === Object ? {
          ...${JSON.stringify(stockIn({ warehouse: 'IN-WH-B', code: 'IN-REG', batch: 'REGION-BATCH' }))},
          idempotencyKey: 'stock-in-region-' + index,
        } : null),
        (error) => error.status === 403 && error.errorCode === 'REGION_FORBIDDEN',
      );
    }
    const count = await pool.query(
      'SELECT count(*)::int AS count FROM stock_transactions WHERE product_id = $1',
      [ids.productRegion],
    );
    assert.equal(count.rows[0].count, 0);
    console.log('PASS');
  `), 'PASS');
});

test('IN-009 concurrent receipts do not lose updates and preserve chain', () => {
  assert.equal(runInApp(`
    const base = ${JSON.stringify(stockIn({
      code: 'IN-CON', batch: 'CON-BATCH', quantity: 4, unit: 'IN-KG', price: 25,
    }))};
    const [first, second] = await Promise.all([
      transactions.createStockIn(pool, actors.admin, {
        ...base, idempotencyKey: 'stock-in-concurrent-1', reference: 'CON-1',
      }),
      transactions.createStockIn(pool, actors.petugas, {
        ...base, idempotencyKey: 'stock-in-concurrent-2', reference: 'CON-2',
      }),
    ]);
    assert.deepEqual([first.balanceAfter, second.balanceAfter].sort(), ['4', '8']);
    const state = await pool.query(\`
      SELECT
        (SELECT quantity::text FROM stock_batches WHERE product_id = $1) AS batch_quantity,
        (SELECT quantity::text FROM stock_balances WHERE product_id = $1) AS balance_quantity,
        (SELECT count(*)::int FROM stock_transactions WHERE product_id = $1) AS ledgers,
        (SELECT bool_and(balance_after = balance_before + quantity) FROM stock_transactions WHERE product_id = $1) AS valid
    \`, [ids.productConcurrent]);
    assert.deepEqual(state.rows[0], {
      batch_quantity: '8', balance_quantity: '8', ledgers: 2, valid: true,
    });
    console.log('PASS');
  `), 'PASS');
});

test('IN-010 audit failure rolls back ledger, batch, and balance', () => {
  sql(`
    CREATE FUNCTION reject_stock_in_audit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.action = 'STOCK_IN' THEN RAISE EXCEPTION 'forced stock-in audit failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER reject_stock_in_audit BEFORE INSERT ON audit_logs
      FOR EACH ROW EXECUTE FUNCTION reject_stock_in_audit();
  `);
  try {
    assert.equal(runInApp(`
      await assert.rejects(
        transactions.createStockIn(pool, actors.admin, ${JSON.stringify(stockIn({
          idempotencyKey: 'stock-in-rollback', reference: 'ROLLBACK', code: 'IN-ROLL', batch: 'ROLL-BATCH',
        }))}),
      );
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
    sql('DROP TRIGGER reject_stock_in_audit ON audit_logs; DROP FUNCTION reject_stock_in_audit()');
  }
});

test('IN-010 forced post-reconciliation failure rolls back all Stock In state', () => {
  sql(`
    CREATE FUNCTION corrupt_stock_in_batch() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.product_id = '${ids.productReconcile}' THEN NEW.quantity = NEW.quantity + 1; END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER corrupt_stock_in_batch BEFORE INSERT ON stock_batches
      FOR EACH ROW EXECUTE FUNCTION corrupt_stock_in_batch();
  `);
  try {
    assert.equal(runInApp(`
      await assert.rejects(
        transactions.createStockIn(pool, actors.admin, ${JSON.stringify(stockIn({
          idempotencyKey: 'stock-in-reconcile', reference: 'RECONCILE',
          code: 'IN-RECON', batch: 'RECON-BATCH', unit: 'IN-KG',
        }))}),
        (error) => error.status === 409 && error.errorCode === 'INVENTORY_RECONCILIATION_FAILED',
      );
      const state = await pool.query(\`
        SELECT
          (SELECT count(*)::int FROM stock_transactions WHERE product_id = $1) AS ledgers,
          (SELECT count(*)::int FROM stock_batches WHERE product_id = $1) AS batches,
          (SELECT count(*)::int FROM stock_balances WHERE product_id = $1) AS balances,
          (SELECT count(*)::int FROM audit_logs
             WHERE action = 'STOCK_IN' AND details->>'productId' = $1::text) AS audits
      \`, [ids.productReconcile]);
      assert.deepEqual(state.rows[0], { ledgers: 0, batches: 0, balances: 0, audits: 0 });
      console.log('PASS');
    `), 'PASS');
  } finally {
    sql('DROP TRIGGER corrupt_stock_in_batch ON stock_batches; DROP FUNCTION corrupt_stock_in_batch()');
  }
});

test('IN-011 invalid input and references create no inventory state', () => {
  assert.equal(runInApp(`
    const cases = [
      [{ ...${JSON.stringify(stockIn({ code: 'IN-DUP' }))}, injected: true }, 400, 'VALIDATION_ERROR'],
      [{ ...${JSON.stringify(stockIn({ code: 'IN-DUP' }))}, date: '2026-02-30' }, 400, 'VALIDATION_ERROR'],
      [{ ...${JSON.stringify(stockIn({ code: 'IN-DUP' }))}, quantity: 0 }, 400, 'INVALID_QUANTITY'],
      [{ ...${JSON.stringify(stockIn({ code: 'MISSING' }))} }, 422, 'INVALID_PRODUCT'],
      [{ ...${JSON.stringify(stockIn({ code: 'IN-DUP', warehouse: 'MISSING' }))} }, 422, 'INVALID_WAREHOUSE'],
      [{ ...${JSON.stringify(stockIn({ code: 'IN-DUP', unit: 'MISSING' }))} }, 422, 'INVALID_UNIT'],
      [{ ...${JSON.stringify(stockIn({ code: 'IN-DUP', supplier: 'MISSING' }))} }, 422, 'INVALID_SUPPLIER'],
      [{ ...${JSON.stringify(stockIn({ code: 'IN-DUP', supplier: 'IN-SUP-OFF' }))} }, 422, 'INVALID_SUPPLIER'],
    ];
    for (const [index, [payload, status, errorCode]] of cases.entries()) {
      await assert.rejects(
        transactions.createStockIn(pool, actors.admin, {
          ...payload, idempotencyKey: 'stock-in-invalid-' + index,
        }),
        (error) => error.status === status && error.errorCode === errorCode,
      );
    }
    const state = await pool.query(\`
      SELECT
        (SELECT count(*)::int FROM stock_transactions WHERE product_id = $1) AS ledgers,
        (SELECT count(*)::int FROM stock_batches WHERE product_id = $1) AS batches,
        (SELECT count(*)::int FROM stock_balances WHERE product_id = $1) AS balances
    \`, [ids.productDuplicate]);
    assert.deepEqual(state.rows[0], { ledgers: 0, batches: 0, balances: 0 });
    console.log('PASS');
  `), 'PASS');
});

test('IN-012 orphan inventory state fails closed before mutation', () => {
  sql(`
    INSERT INTO stock_balances (id, product_id, warehouse_id, quantity, version)
    VALUES (gen_random_uuid(), '${ids.productOrphan}', '${ids.warehouseA}', 7, 1)
  `);
  assert.equal(runInApp(`
    await assert.rejects(
      transactions.createStockIn(pool, actors.admin, ${JSON.stringify(stockIn({
        idempotencyKey: 'stock-in-orphan', reference: 'ORPHAN',
        code: 'IN-ORPHAN', batch: 'ORPHAN-BATCH', unit: 'IN-KG',
      }))}),
      (error) => error.status === 409 && error.errorCode === 'INVENTORY_RECONCILIATION_FAILED',
    );
    const state = await pool.query(\`
      SELECT
        (SELECT count(*)::int FROM stock_transactions WHERE product_id = $1) AS ledgers,
        (SELECT count(*)::int FROM stock_batches WHERE product_id = $1) AS batches,
        (SELECT count(*)::int FROM stock_balances WHERE product_id = $1) AS balances,
        (SELECT quantity::text FROM stock_balances WHERE product_id = $1) AS quantity
    \`, [ids.productOrphan]);
    assert.deepEqual(state.rows[0], { ledgers: 0, batches: 0, balances: 1, quantity: '7' });
    console.log('PASS');
  `), 'PASS');
});

test('IN-008 concurrent duplicate key creates one economic mutation', () => {
  assert.equal(runInApp(`
    const payload = ${JSON.stringify(stockIn({
      idempotencyKey: 'stock-in-duplicate', reference: 'DUPLICATE',
      code: 'IN-DUP', batch: 'DUP-BATCH', unit: 'IN-KG', quantity: 3,
    }))};
    const [first, second] = await Promise.all([
      transactions.createStockIn(pool, actors.admin, payload),
      transactions.createStockIn(pool, actors.admin, payload),
    ]);
    assert.equal(first.id, second.id);
    const state = await pool.query(\`
      SELECT
        (SELECT count(*)::int FROM stock_transactions WHERE product_id = $1) AS ledgers,
        (SELECT quantity::text FROM stock_batches WHERE product_id = $1) AS batch_quantity,
        (SELECT quantity::text FROM stock_balances WHERE product_id = $1) AS balance_quantity
    \`, [ids.productDuplicate]);
    assert.deepEqual(state.rows[0], { ledgers: 1, batch_quantity: '3', balance_quantity: '3' });
    console.log('PASS');
  `), 'PASS');
});

test('IN-013 existing batch metadata conflict is rejected without mutation', () => {
  assert.equal(runInApp(`
    const base = ${JSON.stringify(stockIn({
      idempotencyKey: 'stock-in-meta-1', reference: 'META-1', code: 'IN-ROLL', batch: 'META-BATCH',
    }))};
    await transactions.createStockIn(pool, actors.admin, base);
    await assert.rejects(
      transactions.createStockIn(pool, actors.admin, {
        ...base, idempotencyKey: 'stock-in-meta-2', reference: 'META-2', expiry: '2028-10-01',
      }),
      (error) => error.status === 409 && error.errorCode === 'BATCH_METADATA_CONFLICT',
    );
    const state = await pool.query(\`
      SELECT
        (SELECT quantity::text FROM stock_batches WHERE product_id = $1) AS batch_quantity,
        (SELECT quantity::text FROM stock_balances WHERE product_id = $1) AS balance_quantity,
        (SELECT count(*)::int FROM stock_transactions WHERE product_id = $1) AS ledgers
    \`, [ids.productRollback]);
    assert.deepEqual(state.rows[0], { batch_quantity: '20', balance_quantity: '20', ledgers: 1 });
    console.log('PASS');
  `), 'PASS');
});

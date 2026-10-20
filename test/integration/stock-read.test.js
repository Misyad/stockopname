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
  regionA: '54000000-0000-0000-0000-000000000001',
  regionB: '54000000-0000-0000-0000-000000000002',
  admin: '54000000-0000-0000-0000-000000000010',
  supervisor: '54000000-0000-0000-0000-000000000011',
  petugas: '54000000-0000-0000-0000-000000000012',
  category: '54000000-0000-0000-0000-000000000020',
  unit: '54000000-0000-0000-0000-000000000030',
  warehouseA: '54000000-0000-0000-0000-000000000040',
  warehouseB: '54000000-0000-0000-0000-000000000041',
  supplier: '54000000-0000-0000-0000-000000000050',
  productA: '54000000-0000-0000-0000-000000000060',
  productB: '54000000-0000-0000-0000-000000000061',
};
let env;
let cookies;

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

async function request(path, cookie = null) {
  const response = await fetch(`http://127.0.0.1:${env.APP_PORT}/api${path}`, {
    headers: cookie ? { cookie: cookie.split(';', 1)[0] } : {},
  });
  return { response, body: await response.json() };
}

async function login(email) {
  const response = await fetch(`http://127.0.0.1:${env.APP_PORT}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: env.APP_ORIGIN },
    body: JSON.stringify({ email, password }),
  });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return response.headers.get('set-cookie');
}

before(async () => {
  const appPort = String(await reservePort());
  env = {
    ...process.env,
    APP_PORT: appPort,
    APP_ORIGIN: `http://127.0.0.1:${appPort}`,
    COMPOSE_PROJECT_NAME: `stock_opname_stock_read_${process.pid}`,
    POSTGRES_DB: 'stock_opname_stock_read_test',
    POSTGRES_USER: 'stock_opname_stock_read_test',
    POSTGRES_PASSWORD: randomBytes(24).toString('base64url'),
  };
  compose(['up', '-d', '--build', '--wait', '--wait-timeout', '180']);
  compose(['exec', '-T', 'app', 'node', 'src/db/migrate.js']);
  sql(`
    INSERT INTO regions (id, code, name, status) VALUES
      ('${ids.regionA}', 'READ-A', 'Read Region A', 'ACTIVE'),
      ('${ids.regionB}', 'READ-B', 'Read Region B', 'ACTIVE');
    INSERT INTO users (id, name, email, password_hash, role, status, region_id) VALUES
      ('${ids.admin}', 'Read Admin', 'read-admin@example.test', '${passwordHash(password)}', 'ADMIN', 'ACTIVE', '${ids.regionA}'),
      ('${ids.supervisor}', 'Read Supervisor', 'read-supervisor@example.test', '${passwordHash(password)}', 'SUPERVISOR', 'ACTIVE', '${ids.regionA}'),
      ('${ids.petugas}', 'Read Petugas', 'read-petugas@example.test', '${passwordHash(password)}', 'PETUGAS', 'ACTIVE', '${ids.regionA}');
    INSERT INTO categories (id, code, name, status)
      VALUES ('${ids.category}', 'READ-CAT', 'Read Category', 'ACTIVE');
    INSERT INTO units (id, code, name, symbol, conversion_to_base, status)
      VALUES ('${ids.unit}', 'READ-KG', 'Read Kilogram', 'kg', 1, 'ACTIVE');
    INSERT INTO warehouses (id, code, name, status, region_id) VALUES
      ('${ids.warehouseA}', 'READ-WH-A', 'Read Warehouse A', 'ACTIVE', '${ids.regionA}'),
      ('${ids.warehouseB}', 'READ-WH-B', 'Read Warehouse B', 'ACTIVE', '${ids.regionB}');
    INSERT INTO suppliers (id, code, name, status)
      VALUES ('${ids.supplier}', 'READ-SUP', 'Read Supplier', 'ACTIVE');
    INSERT INTO products (
      id, code, name, category_id, base_unit_id, conversion_factor,
      minimum_stock, maximum_stock, status
    ) VALUES
      ('${ids.productA}', 'READ-A', 'Read Alpha', '${ids.category}', '${ids.unit}', 1, 20, 200, 'ACTIVE'),
      ('${ids.productB}', 'READ-B', 'Read Beta', '${ids.category}', '${ids.unit}', 1, 5, 100, 'ACTIVE');
    INSERT INTO stock_balances (id, product_id, warehouse_id, quantity, version, updated_at) VALUES
      ('54000000-0000-0000-0000-000000000070', '${ids.productA}', '${ids.warehouseA}', 120, 3, now()),
      ('54000000-0000-0000-0000-000000000071', '${ids.productB}', '${ids.warehouseA}', 0, 2, now()),
      ('54000000-0000-0000-0000-000000000072', '${ids.productA}', '${ids.warehouseB}', 999, 1, now());
    INSERT INTO stock_transactions (
      id, idempotency_key, transaction_number, transaction_type, transaction_date,
      request_hash, reference_id, product_id, warehouse_id, supplier_id,
      quantity, unit, balance_before, balance_after, reason, user_id, created_at
    ) VALUES
      ('54000000-0000-0000-0000-000000000101', 'read-open-a', 'OPEN-READ-A', 'OPENING', '2026-10-01', '', 'OPEN-A', '${ids.productA}', '${ids.warehouseA}', NULL, 100, 'READ-KG', 0, 100, NULL, '${ids.admin}', '2026-10-01T01:00:00Z'),
      ('54000000-0000-0000-0000-000000000102', 'read-in-a', 'IN-READ-A', 'IN', '2026-10-02', '', 'IN-A', '${ids.productA}', '${ids.warehouseA}', '${ids.supplier}', 50, 'READ-KG', 100, 150, 'Receipt', '${ids.supervisor}', '2026-10-02T01:00:00Z'),
      ('54000000-0000-0000-0000-000000000103', 'read-out-a', 'OUT-READ-A', 'OUT', '2026-10-03', '', 'OUT-A', '${ids.productA}', '${ids.warehouseA}', NULL, -30, 'READ-KG', 150, 120, 'Use', '${ids.petugas}', '2026-10-03T01:00:00Z'),
      ('54000000-0000-0000-0000-000000000104', 'read-open-b', 'OPEN-READ-B', 'OPENING', '2026-10-01', '', 'OPEN-B', '${ids.productB}', '${ids.warehouseA}', NULL, 10, 'READ-KG', 0, 10, NULL, '${ids.admin}', '2026-10-01T02:00:00Z'),
      ('54000000-0000-0000-0000-000000000105', 'read-out-b', 'OUT-READ-B', 'OUT', '2026-10-02', '', 'OUT-B', '${ids.productB}', '${ids.warehouseA}', NULL, -10, 'READ-KG', 10, 0, NULL, '${ids.petugas}', '2026-10-02T02:00:00Z'),
      ('54000000-0000-0000-0000-000000000106', 'read-region-b', 'OPEN-REGION-B', 'OPENING', '2026-10-01', '', 'SECRET-B', '${ids.productA}', '${ids.warehouseB}', NULL, 999, 'READ-KG', 0, 999, NULL, '${ids.admin}', '2026-10-01T03:00:00Z');
  `);
  cookies = await Promise.all([
    login('read-admin@example.test'),
    login('read-supervisor@example.test'),
    login('read-petugas@example.test'),
  ]);
});

after(() => {
  if (!env) return;
  spawnSync('docker', ['compose', '-f', composeFile, 'down', '-v', '--remove-orphans'], {
    cwd: root, env, encoding: 'utf8',
  });
});

test('READ-001 stock list authenticates, filters, paginates, and permits every stock-read role', async () => {
  const anonymous = await request('/stock');
  assert.equal(anonymous.response.status, 401);
  assert.equal(anonymous.body.errorCode, 'UNAUTHENTICATED');
  for (const cookie of cookies) {
    const listed = await request(`/stock?warehouse_id=${ids.warehouseA}&category_id=${ids.category}&status=ACTIVE&q=Read&page=1&limit=1`, cookie);
    assert.equal(listed.response.status, 200, JSON.stringify(listed.body));
    assert.deepEqual(
      { page: listed.body.data.page, limit: listed.body.data.limit, total: listed.body.data.total, hasNext: listed.body.data.hasNext },
      { page: 1, limit: 1, total: 2, hasNext: true },
    );
    assert.equal(listed.body.data.items.length, 1);
    assert.equal(listed.body.data.items[0].warehouseId, ids.warehouseA);
    assert.notEqual(listed.body.data.items[0].quantity, '999');
  }
  const second = await request(`/stock?warehouse_id=${ids.warehouseA}&page=2&limit=1`, cookies[0]);
  assert.equal(second.body.data.items.length, 1);
  assert.equal(second.body.data.hasNext, false);
});

test('READ-002 transaction list filters dates/references and uses deterministic bounded pagination', async () => {
  const filtered = await request(`/transactions?from=2026-10-02&to=2026-10-03&type=IN&product_id=${ids.productA}&warehouse_id=${ids.warehouseA}&supplier_id=${ids.supplier}&q=IN-A&page=1&limit=10`, cookies[1]);
  assert.equal(filtered.response.status, 200, JSON.stringify(filtered.body));
  assert.equal(filtered.body.data.total, 1);
  assert.deepEqual(
    filtered.body.data.items.map(({ transactionType, reference, quantity }) => ({ transactionType, reference, quantity })),
    [{ transactionType: 'IN', reference: 'IN-A', quantity: '50' }],
  );
  const first = await request('/transactions?page=1&limit=2', cookies[2]);
  const second = await request('/transactions?page=2&limit=2', cookies[2]);
  assert.equal(first.body.data.total, 5);
  assert.equal(first.body.data.items.length, 2);
  assert.equal(second.body.data.items.length, 2);
  assert.equal(new Set([...first.body.data.items, ...second.body.data.items].map(({ id }) => id)).size, 4);
  assert.equal(JSON.stringify(first.body).includes('SECRET-B'), false);
});

test('READ-003 stock card is ledger-derived with stable chronological running balance', async () => {
  const card = await request(`/stock-card/${ids.productA}?warehouse_id=${ids.warehouseA}&from=2026-10-02&to=2026-10-03&page=1&limit=10`, cookies[0]);
  assert.equal(card.response.status, 200, JSON.stringify(card.body));
  assert.equal(card.body.data.total, 2);
  assert.deepEqual(
    card.body.data.items.map(({ transactionType, quantity, runningBalance }) => ({ transactionType, quantity, runningBalance })),
    [
      { transactionType: 'IN', quantity: '50', runningBalance: '150' },
      { transactionType: 'OUT', quantity: '-30', runningBalance: '120' },
    ],
  );
});

test('READ-003A stock card recomputes chronological balances for backdated ledger rows', async () => {
  sql(`
    INSERT INTO stock_transactions (
      id, idempotency_key, transaction_number, transaction_type, transaction_date,
      request_hash, reference_id, product_id, warehouse_id, quantity, unit,
      balance_before, balance_after, reason, user_id, created_at
    ) VALUES (
      '54000000-0000-0000-0000-000000000107', 'read-backdated-a',
      'IN-READ-BACKDATED', 'IN', '2026-10-02', '', 'IN-BACKDATED',
      '${ids.productA}', '${ids.warehouseA}', 5, 'READ-KG', 120, 125,
      'Backdated receipt', '${ids.admin}', '2026-10-04T01:00:00Z'
    );
    UPDATE stock_balances SET quantity = 125, version = version + 1
    WHERE product_id = '${ids.productA}' AND warehouse_id = '${ids.warehouseA}';
  `);
  const card = await request(`/stock-card/${ids.productA}?warehouse_id=${ids.warehouseA}&page=1&limit=10`, cookies[0]);
  assert.equal(card.response.status, 200, JSON.stringify(card.body));
  assert.deepEqual(
    card.body.data.items.map(({ reference, balanceBefore, runningBalance }) => ({ reference, balanceBefore, runningBalance })),
    [
      { reference: 'OPEN-A', balanceBefore: '0', runningBalance: '100' },
      { reference: 'IN-A', balanceBefore: '100', runningBalance: '150' },
      { reference: 'IN-BACKDATED', balanceBefore: '150', runningBalance: '155' },
      { reference: 'OUT-A', balanceBefore: '155', runningBalance: '125' },
    ],
  );
});

test('READ-003B stock card without warehouse returns one regional running balance', async () => {
  sql(`
    INSERT INTO warehouses (id, code, name, status, region_id)
    VALUES ('54000000-0000-0000-0000-000000000042', 'READ-WH-C', 'Read Warehouse C', 'ACTIVE', '${ids.regionA}');
    INSERT INTO stock_transactions (
      id, idempotency_key, transaction_number, transaction_type, transaction_date,
      request_hash, reference_id, product_id, warehouse_id, quantity, unit,
      balance_before, balance_after, reason, user_id, created_at
    ) VALUES (
      '54000000-0000-0000-0000-000000000108', 'read-open-c',
      'OPEN-READ-C', 'OPENING', '2026-10-01', '', 'OPEN-C',
      '${ids.productA}', '54000000-0000-0000-0000-000000000042', 7, 'READ-KG', 0, 7,
      NULL, '${ids.admin}', '2026-10-01T04:00:00Z'
    );
  `);
  const card = await request(`/stock-card/${ids.productA}?page=1&limit=10`, cookies[1]);
  assert.equal(card.response.status, 200, JSON.stringify(card.body));
  assert.equal(card.body.data.items.at(-1).runningBalance, '132');
  for (let index = 1; index < card.body.data.items.length; index += 1) {
    assert.equal(
      card.body.data.items[index].balanceBefore,
      card.body.data.items[index - 1].runningBalance,
    );
  }
  assert.equal(JSON.stringify(card.body).includes('SECRET-B'), false);
});

test('RBAC-013 read endpoints reject explicit cross-region warehouse for every role', async () => {
  for (const cookie of cookies) {
    for (const path of [
      `/stock?warehouse_id=${ids.warehouseB}`,
      `/transactions?warehouse_id=${ids.warehouseB}`,
      `/stock-card/${ids.productA}?warehouse_id=${ids.warehouseB}`,
    ]) {
      const result = await request(path, cookie);
      assert.equal(result.response.status, 403, `${path}: ${JSON.stringify(result.body)}`);
      assert.equal(result.body.errorCode, 'REGION_FORBIDDEN');
    }
  }
});

test('READ-004 validates bounded pagination and dates with safe errors', async () => {
  for (const path of [
    '/stock?limit=501',
    '/transactions?limit=501',
    `/stock-card/${ids.productA}?limit=501`,
    '/stock?page=1e21',
    '/transactions?page=9007199254740991&limit=500',
  ]) {
    const result = await request(path, cookies[0]);
    assert.equal(result.response.status, 400, `${path}: ${JSON.stringify(result.body)}`);
    assert.equal(result.body.errorCode, 'VALIDATION_ERROR');
  }
  const invalidDate = await request('/transactions?from=2026-02-30', cookies[0]);
  assert.equal(invalidDate.response.status, 400, JSON.stringify(invalidDate.body));
  assert.doesNotMatch(JSON.stringify(invalidDate.body), /postgres|select |\/root\/|stack/i);
});

test('READ-005 endpoint transaction ordering has index-backed query plans', () => {
  const transactionPlan = sql(`
    SET enable_seqscan = off;
    SET enable_sort = off;
    EXPLAIN (COSTS OFF)
    SELECT transactions.id FROM stock_transactions transactions
    JOIN warehouses ON warehouses.id = transactions.warehouse_id
    WHERE warehouses.region_id = '${ids.regionA}'
    ORDER BY transactions.transaction_date DESC, transactions.ledger_sequence DESC
    LIMIT 50
  `);
  assert.doesNotMatch(transactionPlan, /Sort/i);
  assert.match(transactionPlan, /stock_transactions_date_sequence_idx/i);

  const cardPlan = sql(`
    SET enable_seqscan = off;
    SET enable_sort = off;
    EXPLAIN (COSTS OFF)
    SELECT transactions.id FROM stock_transactions transactions
    JOIN warehouses ON warehouses.id = transactions.warehouse_id
    WHERE warehouses.region_id = '${ids.regionA}'
      AND transactions.product_id = '${ids.productA}'
    ORDER BY transactions.transaction_date, transactions.ledger_sequence
    LIMIT 50
  `);
  assert.doesNotMatch(cardPlan, /Sort/i);
  assert.match(cardPlan, /stock_transactions_product_date_sequence_idx/i);
});

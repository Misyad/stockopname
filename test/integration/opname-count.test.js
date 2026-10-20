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
  regionA: '61000000-0000-0000-0000-000000000001',
  regionB: '61000000-0000-0000-0000-000000000002',
  admin: '61000000-0000-0000-0000-000000000010',
  supervisor: '61000000-0000-0000-0000-000000000011',
  petugas: '61000000-0000-0000-0000-000000000012',
  petugas2: '61000000-0000-0000-0000-000000000013',
  category: '61000000-0000-0000-0000-000000000020',
  unit: '61000000-0000-0000-0000-000000000030',
  warehouseA: '61000000-0000-0000-0000-000000000040',
  warehouseB: '61000000-0000-0000-0000-000000000041',
  productA: '61000000-0000-0000-0000-000000000050',
  productB: '61000000-0000-0000-0000-000000000051',
  batchA: '61000000-0000-0000-0000-000000000060',
  batchB: '61000000-0000-0000-0000-000000000061',
};
let env;
let sessions;

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

async function api(path, options = {}) {
  const response = await fetch(`http://127.0.0.1:${env.APP_PORT}/api${path}`, options);
  return { response, body: await response.json() };
}

async function login(email) {
  const result = await api('/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: env.APP_ORIGIN },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  const cookie = result.response.headers.get('set-cookie');
  const csrfResult = await api('/auth/csrf', { headers: { cookie: cookie.split(';', 1)[0] } });
  assert.equal(csrfResult.response.status, 200, JSON.stringify(csrfResult.body));
  return { cookie: cookie.split(';', 1)[0], csrf: csrfResult.body.data.csrfToken };
}

function mutation(session, body) {
  return {
    method: 'POST',
    headers: {
      cookie: session.cookie,
      'content-type': 'application/json',
      origin: env.APP_ORIGIN,
      'x-csrf-token': session.csrf,
    },
    body: JSON.stringify(body),
  };
}

function authenticated(session) {
  return { headers: { cookie: session.cookie } };
}

async function createOpname(session, notes) {
  const result = await api('/opnames', mutation(session, {
    warehouse: 'OP-WH-A', date: '2026-10-20', notes,
  }));
  assert.equal(result.response.status, 201, JSON.stringify(result.body));
  return result.body.data;
}

before(async () => {
  const appPort = String(await reservePort());
  env = {
    ...process.env,
    APP_PORT: appPort,
    APP_ORIGIN: `http://127.0.0.1:${appPort}`,
    COMPOSE_PROJECT_NAME: `stock_opname_count_${process.pid}`,
    POSTGRES_DB: 'stock_opname_count_test',
    POSTGRES_USER: 'stock_opname_count_test',
    POSTGRES_PASSWORD: randomBytes(24).toString('base64url'),
  };
  compose(['up', '-d', '--build', '--wait', '--wait-timeout', '180']);
  compose(['exec', '-T', 'app', 'node', 'src/db/migrate.js']);
  sql(`
    INSERT INTO regions (id, code, name, status) VALUES
      ('${ids.regionA}', 'OP-A', 'Opname Region A', 'ACTIVE'),
      ('${ids.regionB}', 'OP-B', 'Opname Region B', 'ACTIVE');
    INSERT INTO users (id, name, email, password_hash, role, status, region_id) VALUES
      ('${ids.admin}', 'Opname Admin', 'opname-admin@example.test', '${passwordHash(password)}', 'ADMIN', 'ACTIVE', '${ids.regionA}'),
      ('${ids.supervisor}', 'Opname Supervisor', 'opname-supervisor@example.test', '${passwordHash(password)}', 'SUPERVISOR', 'ACTIVE', '${ids.regionA}'),
      ('${ids.petugas}', 'Opname Petugas', 'opname-petugas@example.test', '${passwordHash(password)}', 'PETUGAS', 'ACTIVE', '${ids.regionA}'),
      ('${ids.petugas2}', 'Opname Petugas 2', 'opname-petugas2@example.test', '${passwordHash(password)}', 'PETUGAS', 'ACTIVE', '${ids.regionA}');
    INSERT INTO categories (id, code, name, status)
      VALUES ('${ids.category}', 'OP-CAT', 'Opname Category', 'ACTIVE');
    INSERT INTO units (id, code, name, symbol, conversion_to_base, status)
      VALUES ('${ids.unit}', 'OP-KG', 'Kilogram', 'kg', 1, 'ACTIVE');
    INSERT INTO warehouses (id, code, name, status, region_id) VALUES
      ('${ids.warehouseA}', 'OP-WH-A', 'Opname Warehouse A', 'ACTIVE', '${ids.regionA}'),
      ('${ids.warehouseB}', 'OP-WH-B', 'Opname Warehouse B', 'ACTIVE', '${ids.regionB}');
    INSERT INTO products (
      id, code, name, category_id, base_unit_id, conversion_factor,
      minimum_stock, maximum_stock, status
    ) VALUES
      ('${ids.productA}', 'OP-P-A', 'Opname Alpha', '${ids.category}', '${ids.unit}', 1, 0, 100, 'ACTIVE'),
      ('${ids.productB}', 'OP-P-B', 'Opname Beta', '${ids.category}', '${ids.unit}', 1, 0, 100, 'ACTIVE');
    INSERT INTO stock_batches (
      id, product_id, warehouse_id, batch_number, quantity, unit, purchase_price, status
    ) VALUES
      ('${ids.batchA}', '${ids.productA}', '${ids.warehouseA}', 'B-A', 10, 'OP-KG', 5, 'ACTIVE'),
      ('${ids.batchB}', '${ids.productB}', '${ids.warehouseA}', NULL, 0, 'OP-KG', 2, 'DEPLETED');
    INSERT INTO stock_balances (id, product_id, warehouse_id, quantity, version) VALUES
      (gen_random_uuid(), '${ids.productA}', '${ids.warehouseA}', 10, 1),
      (gen_random_uuid(), '${ids.productB}', '${ids.warehouseA}', 0, 1);
    INSERT INTO stock_transactions (
      id, idempotency_key, transaction_number, transaction_type, transaction_date,
      request_hash, reference_id, product_id, warehouse_id, batch_id, quantity, unit,
      balance_before, balance_after, user_id, created_at
    ) VALUES
      (gen_random_uuid(), 'opname-fixture-a', 'OP-OPEN-A', 'OPENING', '2026-10-20', '',
       'OP-FIX-A', '${ids.productA}', '${ids.warehouseA}', '${ids.batchA}', 10, 'OP-KG', 0, 10,
       '${ids.admin}', now());
  `);
  const [admin, supervisor, petugas, petugas2] = await Promise.all([
    login('opname-admin@example.test'),
    login('opname-supervisor@example.test'),
    login('opname-petugas@example.test'),
    login('opname-petugas2@example.test'),
  ]);
  sessions = { admin, supervisor, petugas, petugas2 };
});

after(() => {
  if (!env) return;
  spawnSync('docker', ['compose', '-f', composeFile, 'down', '-v', '--remove-orphans'], {
    cwd: root, env, encoding: 'utf8',
  });
});

test('OP-001 create returns DRAFT and persists one locked-consistent item snapshot with audit', async () => {
  const created = await api('/opnames', mutation(sessions.petugas, {
    warehouse: 'OP-WH-A', date: '2026-10-20', notes: 'Shift count',
  }));
  assert.equal(created.response.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.data.status, 'DRAFT');
  assert.equal(created.body.data.warehouseId, ids.warehouseA);
  assert.equal(Object.hasOwn(created.body.data, 'systemQuantity'), false);

  const state = JSON.parse(sql(`
    SELECT json_build_object(
      'status', opname.status,
      'creator', opname.created_by,
      'snapshotVersion', opname.snapshot_version,
      'items', (SELECT count(*)::int FROM stock_opname_items WHERE opname_id = opname.id),
      'quantity', (SELECT system_quantity::text FROM stock_opname_items WHERE opname_id = opname.id),
      'batch', (SELECT batch_id FROM stock_opname_items WHERE opname_id = opname.id),
      'audits', (SELECT count(*)::int FROM audit_logs WHERE action = 'OPNAME_CREATED' AND reference = opname.id::text)
    )
    FROM stock_opnames opname
    WHERE opname.id = '${created.body.data.id}'
  `));
  assert.deepEqual(state, {
    status: 'DRAFT', creator: ids.petugas, snapshotVersion: 1,
    items: 1, quantity: '10', batch: ids.batchA, audits: 1,
  });
});

test('OP-002 through OP-007 and RBAC-011 enforce blind owner counting state machine', async () => {
  const opname = await createOpname(sessions.petugas, 'Blind count');

  const anonymous = await api(`/opnames/${opname.id}`);
  assert.equal(anonymous.response.status, 401);

  const blind = await api(`/opnames/${opname.id}`, authenticated(sessions.petugas));
  assert.equal(blind.response.status, 200, JSON.stringify(blind.body));
  assert.equal(blind.body.data.items.length, 1);
  const item = blind.body.data.items[0];
  for (const protectedField of [
    'systemQuantity', 'system_quantity', 'difference', 'differenceValue', 'difference_value',
  ]) assert.equal(Object.hasOwn(item, protectedField), false, protectedField);

  const visible = await api(`/opnames/${opname.id}`, authenticated(sessions.supervisor));
  assert.equal(visible.response.status, 200, JSON.stringify(visible.body));
  assert.equal(visible.body.data.items[0].systemQuantity, '10');

  const nonOwnerStart = await api(`/opnames/${opname.id}/start`, mutation(sessions.petugas2, {}));
  assert.equal(nonOwnerStart.response.status, 403, JSON.stringify(nonOwnerStart.body));
  const started = await api(`/opnames/${opname.id}/start`, mutation(sessions.supervisor, {}));
  assert.equal(started.response.status, 200, JSON.stringify(started.body));
  assert.equal(started.body.data.status, 'COUNTING');

  const nonOwnerSubmit = await api(`/opnames/${opname.id}/submit`, mutation(sessions.petugas2, {}));
  assert.equal(nonOwnerSubmit.response.status, 403, JSON.stringify(nonOwnerSubmit.body));

  const incomplete = await api(`/opnames/${opname.id}/submit`, mutation(sessions.petugas, {}));
  assert.equal(incomplete.response.status, 409, JSON.stringify(incomplete.body));
  assert.equal(incomplete.body.errorCode, 'COUNTS_INCOMPLETE');

  const nonOwnerCount = await api(`/opnames/${opname.id}/counts`, mutation(sessions.petugas2, {
    items: [{ itemId: item.id, physicalQuantity: 0 }],
  }));
  assert.equal(nonOwnerCount.response.status, 403, JSON.stringify(nonOwnerCount.body));

  const zero = await api(`/opnames/${opname.id}/counts`, mutation(sessions.supervisor, {
    items: [{ itemId: item.id, physicalQuantity: 0 }],
  }));
  assert.equal(zero.response.status, 200, JSON.stringify(zero.body));
  const afterZero = await api(`/opnames/${opname.id}`, authenticated(sessions.petugas));
  assert.equal(afterZero.body.data.items[0].physicalQuantity, '0');

  const reasonMissing = await api(`/opnames/${opname.id}/submit`, mutation(sessions.petugas, {}));
  assert.equal(reasonMissing.response.status, 409, JSON.stringify(reasonMissing.body));
  assert.equal(reasonMissing.body.errorCode, 'REASON_REQUIRED');

  const reasonSaved = await api(`/opnames/${opname.id}/counts`, mutation(sessions.petugas, {
    items: [{ itemId: item.id, physicalQuantity: 0, reason: 'Rusak saat penyimpanan' }],
  }));
  assert.equal(reasonSaved.response.status, 200, JSON.stringify(reasonSaved.body));
  const submitted = await api(`/opnames/${opname.id}/submit`, mutation(sessions.supervisor, {}));
  assert.equal(submitted.response.status, 200, JSON.stringify(submitted.body));
  assert.equal(submitted.body.data.status, 'SUBMITTED');

  const persisted = JSON.parse(sql(`
    SELECT json_build_object(
      'status', opname.status,
      'submitted', opname.submitted_at IS NOT NULL,
      'physical', item.physical_quantity::text,
      'difference', item.difference::text,
      'reason', item.reason
    )
    FROM stock_opnames opname
    JOIN stock_opname_items item ON item.opname_id = opname.id
    WHERE opname.id = '${opname.id}'
  `));
  assert.deepEqual(persisted, {
    status: 'SUBMITTED', submitted: true, physical: '0', difference: '-10',
    reason: 'Rusak saat penyimpanan',
  });
});

test('warehouse scope rejects crafted cross-region create for every allowed role', async () => {
  for (const session of [sessions.admin, sessions.supervisor, sessions.petugas]) {
    const result = await api('/opnames', mutation(session, {
      warehouse: 'OP-WH-B', date: '2026-10-20', notes: 'Wrong region',
    }));
    assert.equal(result.response.status, 403, JSON.stringify(result.body));
    assert.equal(result.body.errorCode, 'REGION_FORBIDDEN');
  }
  assert.equal(sql(`SELECT count(*) FROM stock_opnames WHERE warehouse_id = '${ids.warehouseB}'`), '0');
});

test('warehouse scope rejects cross-region detail and every Phase 6.1 mutation for all roles', async () => {
  const opnameId = '61000000-0000-0000-0000-000000000070';
  sql(`
    INSERT INTO stock_opnames (
      id, opname_number, warehouse_id, opname_date, status, snapshot_at,
      snapshot_version, created_by, created_at, updated_at
    ) VALUES (
      '${opnameId}', 'OP-REGION-B', '${ids.warehouseB}', '2026-10-20', 'DRAFT', now(),
      0, '${ids.admin}', now(), now()
    )
  `);
  for (const session of [sessions.admin, sessions.supervisor, sessions.petugas]) {
    const requests = [
      await api(`/opnames/${opnameId}`, authenticated(session)),
      await api(`/opnames/${opnameId}/start`, mutation(session, {})),
      await api(`/opnames/${opnameId}/counts`, mutation(session, {
        items: [{ itemId: ids.batchA, physicalQuantity: 0 }],
      })),
      await api(`/opnames/${opnameId}/submit`, mutation(session, {})),
    ];
    for (const result of requests) {
      assert.equal(result.response.status, 403, JSON.stringify(result.body));
      assert.equal(result.body.errorCode, 'REGION_FORBIDDEN');
    }
  }
  assert.equal(sql(`SELECT status FROM stock_opnames WHERE id = '${opnameId}'`), 'DRAFT');
});

test('Phase 6.1 start does not activate REJECTED recount from Phase 6.2', async () => {
  const opname = await createOpname(sessions.petugas, 'Phase boundary');
  sql(`UPDATE stock_opnames SET status = 'REJECTED' WHERE id = '${opname.id}'`);
  const result = await api(`/opnames/${opname.id}/start`, mutation(sessions.petugas, {}));
  assert.equal(result.response.status, 409, JSON.stringify(result.body));
  assert.equal(result.body.errorCode, 'INVALID_STATUS');
  assert.equal(sql(`SELECT status FROM stock_opnames WHERE id = '${opname.id}'`), 'REJECTED');
});

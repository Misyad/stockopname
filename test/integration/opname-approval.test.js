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
  regionA: '62000000-0000-0000-0000-000000000001',
  regionB: '62000000-0000-0000-0000-000000000002',
  admin: '62000000-0000-0000-0000-000000000010',
  supervisor: '62000000-0000-0000-0000-000000000011',
  petugas: '62000000-0000-0000-0000-000000000012',
  category: '62000000-0000-0000-0000-000000000020',
  unit: '62000000-0000-0000-0000-000000000030',
  warehouseA: '62000000-0000-0000-0000-000000000040',
  warehouseB: '62000000-0000-0000-0000-000000000041',
  product: '62000000-0000-0000-0000-000000000050',
  batch: '62000000-0000-0000-0000-000000000060',
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
  const cookie = result.response.headers.get('set-cookie').split(';', 1)[0];
  const csrf = await api('/auth/csrf', { headers: { cookie } });
  return { cookie, csrf: csrf.body.data.csrfToken };
}

function mutation(session, body = {}) {
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

async function complete(creator, counter, label, physical) {
  const created = await api('/opnames', mutation(creator, {
    warehouse: 'AP-WH-A', date: '2026-10-21', notes: label,
  }));
  assert.equal(created.response.status, 201, JSON.stringify(created.body));
  const id = created.body.data.id;
  const started = await api(`/opnames/${id}/start`, mutation(counter));
  assert.equal(started.response.status, 200, JSON.stringify(started.body));
  const detail = await api(`/opnames/${id}`, { headers: { cookie: counter.cookie } });
  const item = detail.body.data.items[0];
  const systemQuantity = item.systemQuantity ?? sql(`
    SELECT system_quantity FROM stock_opname_items WHERE id = '${item.id}'
  `);
  const quantity = physical ?? Math.max(0, Number(systemQuantity) - 1);
  const counted = await api(`/opnames/${id}/counts`, mutation(counter, {
    items: [{ itemId: item.id, physicalQuantity: quantity, reason: 'Selisih hitung' }],
  }));
  assert.equal(counted.response.status, 200, JSON.stringify(counted.body));
  const submitted = await api(`/opnames/${id}/submit`, mutation(counter));
  assert.equal(submitted.response.status, 200, JSON.stringify(submitted.body));
  return { id, item, physical: quantity };
}

before(async () => {
  const appPort = String(await reservePort());
  env = {
    ...process.env,
    APP_PORT: appPort,
    APP_ORIGIN: `http://127.0.0.1:${appPort}`,
    COMPOSE_PROJECT_NAME: `stock_opname_approval_${process.pid}`,
    POSTGRES_DB: 'stock_opname_approval_test',
    POSTGRES_USER: 'stock_opname_approval_test',
    POSTGRES_PASSWORD: randomBytes(24).toString('base64url'),
  };
  compose(['up', '-d', '--build', '--wait', '--wait-timeout', '180']);
  compose(['exec', '-T', 'app', 'node', 'src/db/migrate.js']);
  sql(`
    INSERT INTO regions (id, code, name, status) VALUES
      ('${ids.regionA}', 'AP-A', 'Approval Region A', 'ACTIVE'),
      ('${ids.regionB}', 'AP-B', 'Approval Region B', 'ACTIVE');
    INSERT INTO users (id, name, email, password_hash, role, status, region_id) VALUES
      ('${ids.admin}', 'Approval Admin', 'approval-admin@example.test', '${passwordHash(password)}', 'ADMIN', 'ACTIVE', '${ids.regionA}'),
      ('${ids.supervisor}', 'Approval Supervisor', 'approval-supervisor@example.test', '${passwordHash(password)}', 'SUPERVISOR', 'ACTIVE', '${ids.regionA}'),
      ('${ids.petugas}', 'Approval Petugas', 'approval-petugas@example.test', '${passwordHash(password)}', 'PETUGAS', 'ACTIVE', '${ids.regionA}');
    INSERT INTO categories (id, code, name, status)
      VALUES ('${ids.category}', 'AP-CAT', 'Approval Category', 'ACTIVE');
    INSERT INTO units (id, code, name, symbol, conversion_to_base, status)
      VALUES ('${ids.unit}', 'AP-KG', 'Kilogram', 'kg', 1, 'ACTIVE');
    INSERT INTO warehouses (id, code, name, status, region_id) VALUES
      ('${ids.warehouseA}', 'AP-WH-A', 'Approval Warehouse A', 'ACTIVE', '${ids.regionA}'),
      ('${ids.warehouseB}', 'AP-WH-B', 'Approval Warehouse B', 'ACTIVE', '${ids.regionB}');
    INSERT INTO products (id, code, name, category_id, base_unit_id, conversion_factor, minimum_stock, maximum_stock, status)
      VALUES ('${ids.product}', 'AP-P', 'Approval Product', '${ids.category}', '${ids.unit}', 1, 0, 100, 'ACTIVE');
    INSERT INTO stock_batches (id, product_id, warehouse_id, batch_number, quantity, unit, purchase_price, status)
      VALUES ('${ids.batch}', '${ids.product}', '${ids.warehouseA}', 'AP-BATCH', 120, 'AP-KG', 5, 'ACTIVE');
    INSERT INTO stock_balances (id, product_id, warehouse_id, quantity, version)
      VALUES (gen_random_uuid(), '${ids.product}', '${ids.warehouseA}', 120, 1);
    INSERT INTO stock_transactions (
      id, idempotency_key, transaction_number, transaction_type, transaction_date,
      request_hash, reference_id, product_id, warehouse_id, batch_id, quantity, unit,
      balance_before, balance_after, user_id, created_at
    ) VALUES (
      gen_random_uuid(), 'approval-opening', 'AP-OPEN', 'OPENING', '2026-10-21', '',
      'AP-FIX', '${ids.product}', '${ids.warehouseA}', '${ids.batch}', 120, 'AP-KG', 0, 120,
      '${ids.admin}', now()
    );
  `);
  const [admin, supervisor, petugas] = await Promise.all([
    login('approval-admin@example.test'),
    login('approval-supervisor@example.test'),
    login('approval-petugas@example.test'),
  ]);
  sessions = { admin, supervisor, petugas };
});

after(() => {
  if (!env) return;
  spawnSync('docker', ['compose', '-f', composeFile, 'down', '-v', '--remove-orphans'], {
    cwd: root, env, encoding: 'utf8',
  });
});

test('OP-008 PETUGAS cannot approve or reject', async () => {
  const opname = await complete(sessions.petugas, sessions.petugas, 'Petugas denial');
  for (const [path, body] of [['approve', {}], ['reject', { reason: 'Ulangi' }]]) {
    const result = await api(`/opnames/${opname.id}/${path}`, mutation(sessions.petugas, body));
    assert.equal(result.response.status, 403, JSON.stringify(result.body));
  }
  assert.equal(sql(`SELECT status FROM stock_opnames WHERE id = '${opname.id}'`), 'SUBMITTED');
});

test('OP-009 and OP-017 approval writes one atomic adjustment and allows supervisor self-approval', async () => {
  for (const [creator, label, physical] of [
    [sessions.petugas, 'Canonical', 118],
    [sessions.supervisor, 'Self approval', 117],
  ]) {
    const opname = await complete(creator, sessions.supervisor, label, physical);
    const before = Number(sql(`SELECT quantity FROM stock_balances WHERE product_id = '${ids.product}'`));
    const approved = await api(`/opnames/${opname.id}/approve`, mutation(sessions.supervisor));
    assert.equal(approved.response.status, 200, JSON.stringify(approved.body));
    assert.equal(approved.body.data.status, 'APPROVED');
    const state = JSON.parse(sql(`
      SELECT json_build_object(
        'status', (SELECT status FROM stock_opnames WHERE id = '${opname.id}'),
        'approver', (SELECT approved_by FROM stock_opnames WHERE id = '${opname.id}'),
        'adjustments', (SELECT count(*)::int FROM stock_transactions WHERE reference_id = '${opname.id}' AND transaction_type = 'ADJUSTMENT'),
        'adjustment', (SELECT quantity::text FROM stock_transactions WHERE reference_id = '${opname.id}' AND transaction_type = 'ADJUSTMENT'),
        'quantity', (SELECT quantity::text FROM stock_balances WHERE product_id = '${ids.product}'),
        'batch', (SELECT quantity::text FROM stock_batches WHERE id = '${ids.batch}'),
        'audits', (SELECT count(*)::int FROM audit_logs WHERE action = 'OPNAME_APPROVED' AND reference = '${opname.id}')
      )
    `));
    assert.deepEqual(state, {
      status: 'APPROVED', approver: ids.supervisor, adjustments: 1,
      adjustment: String(opname.physical - Number(opname.item.systemQuantity)),
      quantity: String(opname.physical), batch: String(opname.physical), audits: 1,
    });
    assert.equal(before + Number(opname.physical) - Number(opname.item.systemQuantity), opname.physical);
  }
});

test('OP-010 blocks post-snapshot movement and direct snapshot-state drift', async () => {
  const moved = await complete(sessions.petugas, sessions.supervisor, 'Movement guard');
  sql(`
    UPDATE stock_batches SET quantity = quantity + 1 WHERE id = '${ids.batch}';
    UPDATE stock_balances SET quantity = quantity + 1 WHERE product_id = '${ids.product}';
    INSERT INTO stock_transactions (
      id, idempotency_key, transaction_number, transaction_type, transaction_date,
      request_hash, reference_id, product_id, warehouse_id, batch_id, quantity, unit,
      balance_before, balance_after, user_id, created_at
    ) SELECT gen_random_uuid(), 'approval-movement', 'AP-MOVE', 'IN', '2026-10-21', '',
      'AP-MOVE', '${ids.product}', '${ids.warehouseA}', '${ids.batch}', 1, 'AP-KG',
      quantity - 1, quantity, '${ids.admin}', now()
    FROM stock_balances WHERE product_id = '${ids.product}';
  `);
  const movement = await api(`/opnames/${moved.id}/approve`, mutation(sessions.supervisor));
  assert.equal(movement.response.status, 409, JSON.stringify(movement.body));
  assert.equal(movement.body.errorCode, 'STOCK_MOVED_DURING_OPNAME');

  const changed = await complete(sessions.petugas, sessions.supervisor, 'State guard');
  sql(`UPDATE stock_batches SET quantity = quantity + 1 WHERE id = '${ids.batch}'`);
  try {
    const result = await api(`/opnames/${changed.id}/approve`, mutation(sessions.supervisor));
    assert.equal(result.response.status, 409, JSON.stringify(result.body));
    assert.equal(result.body.errorCode, 'STOCK_CHANGED_AFTER_OPNAME');
  } finally {
    sql(`UPDATE stock_batches SET quantity = quantity - 1 WHERE id = '${ids.batch}'`);
  }
  assert.equal(sql(`SELECT count(*) FROM stock_transactions WHERE reference_id IN ('${moved.id}', '${changed.id}')`), '0');
});

test('OP-011 concurrent double approval commits adjustment once', async () => {
  const opname = await complete(sessions.petugas, sessions.supervisor, 'Concurrent approval');
  const results = await Promise.all([
    api(`/opnames/${opname.id}/approve`, mutation(sessions.admin)),
    api(`/opnames/${opname.id}/approve`, mutation(sessions.supervisor)),
  ]);
  assert.deepEqual(results.map(({ response }) => response.status).sort(), [200, 409]);
  assert.equal(sql(`SELECT count(*) FROM stock_transactions WHERE reference_id = '${opname.id}'`), '1');
});

test('approval audit failure rolls back adjustment, balance, batch, and status', async () => {
  const opname = await complete(sessions.petugas, sessions.supervisor, 'Audit rollback');
  const before = sql(`
    SELECT json_build_object(
      'balance', (SELECT quantity::text FROM stock_balances WHERE product_id = '${ids.product}'),
      'batch', (SELECT quantity::text FROM stock_batches WHERE id = '${ids.batch}')
    )
  `);
  sql(`
    CREATE FUNCTION reject_opname_approval_audit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.action = 'OPNAME_APPROVED' THEN RAISE EXCEPTION 'forced approval audit failure'; END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER reject_opname_approval_audit BEFORE INSERT ON audit_logs
      FOR EACH ROW EXECUTE FUNCTION reject_opname_approval_audit();
  `);
  try {
    const result = await api(`/opnames/${opname.id}/approve`, mutation(sessions.supervisor));
    assert.equal(result.response.status, 500, JSON.stringify(result.body));
    assert.equal(sql(`SELECT status FROM stock_opnames WHERE id = '${opname.id}'`), 'SUBMITTED');
    assert.equal(sql(`SELECT count(*) FROM stock_transactions WHERE reference_id = '${opname.id}'`), '0');
    assert.equal(sql(`
      SELECT json_build_object(
        'balance', (SELECT quantity::text FROM stock_balances WHERE product_id = '${ids.product}'),
        'batch', (SELECT quantity::text FROM stock_batches WHERE id = '${ids.batch}')
      )
    `), before);
  } finally {
    sql(`
      DROP TRIGGER reject_opname_approval_audit ON audit_logs;
      DROP FUNCTION reject_opname_approval_audit();
    `);
  }
});

test('OP-012 and OP-013 reject requires reason; recount clears stale count fields', async () => {
  const opname = await complete(sessions.petugas, sessions.supervisor, 'Reject recount');
  const missing = await api(`/opnames/${opname.id}/reject`, mutation(sessions.supervisor));
  assert.equal(missing.response.status, 400, JSON.stringify(missing.body));
  assert.equal(missing.body.errorCode, 'REASON_REQUIRED');
  const rejected = await api(`/opnames/${opname.id}/reject`, mutation(sessions.supervisor, { reason: 'Hitung ulang' }));
  assert.equal(rejected.response.status, 200, JSON.stringify(rejected.body));
  const recount = await api(`/opnames/${opname.id}/start`, mutation(sessions.petugas));
  assert.equal(recount.response.status, 200, JSON.stringify(recount.body));
  assert.equal(sql(`
    SELECT count(*) FROM stock_opname_items
    WHERE opname_id = '${opname.id}' AND (physical_quantity IS NOT NULL OR difference IS NOT NULL
      OR difference_value IS NOT NULL OR reason IS NOT NULL OR notes IS NOT NULL)
  `), '0');
  assert.equal(sql(`SELECT rejection_reason IS NULL FROM stock_opnames WHERE id = '${opname.id}'`), 't');
});

test('OP-014 and OP-015 negative projection and wrong transitions fail atomically', async () => {
  const opname = await complete(sessions.petugas, sessions.supervisor, 'Negative guard');
  sql(`
    INSERT INTO stock_opname_items (
      id, opname_id, product_id, system_quantity, physical_quantity, difference,
      difference_value, unit, unit_price, reason
    ) VALUES (
      gen_random_uuid(), '${opname.id}', '${ids.product}', 1000, 0, -1000,
      -5000, 'AP-KG', 5, 'Corrupt fixture'
    )
  `);
  const negative = await api(`/opnames/${opname.id}/approve`, mutation(sessions.supervisor));
  assert.equal(negative.response.status, 409, JSON.stringify(negative.body));
  assert.equal(negative.body.errorCode, 'NEGATIVE_STOCK');
  assert.equal(sql(`SELECT count(*) FROM stock_transactions WHERE reference_id = '${opname.id}'`), '0');

  const created = await api('/opnames', mutation(sessions.petugas, {
    warehouse: 'AP-WH-A', date: '2026-10-21', notes: 'Wrong state',
  }));
  for (const path of ['approve', 'reject']) {
    const result = await api(`/opnames/${created.body.data.id}/${path}`, mutation(
      sessions.supervisor, path === 'reject' ? { reason: 'No' } : {},
    ));
    assert.equal(result.response.status, 409, JSON.stringify(result.body));
    assert.equal(result.body.errorCode, 'INVALID_STATUS');
  }
});

test('OP-016 and RBAC-013 supervisor may count any local opname; all roles denied cross-region', async () => {
  const local = await complete(sessions.petugas, sessions.supervisor, 'Supervisor count');
  assert.equal(sql(`SELECT status FROM stock_opnames WHERE id = '${local.id}'`), 'SUBMITTED');
  const foreignId = '62000000-0000-0000-0000-000000000070';
  sql(`
    INSERT INTO stock_opnames (
      id, opname_number, warehouse_id, opname_date, status, snapshot_at,
      snapshot_version, created_by, created_at, updated_at
    ) VALUES (
      '${foreignId}', 'AP-FOREIGN', '${ids.warehouseB}', '2026-10-21', 'SUBMITTED', now(),
      0, '${ids.admin}', now(), now()
    )
  `);
  for (const session of Object.values(sessions)) {
    for (const [path, body] of [['approve', {}], ['reject', { reason: 'No' }]]) {
      const result = await api(`/opnames/${foreignId}/${path}`, mutation(session, body));
      assert.equal(result.response.status, 403, JSON.stringify(result.body));
      assert.equal(result.body.errorCode, 'REGION_FORBIDDEN');
    }
  }
  assert.equal(sql(`SELECT status FROM stock_opnames WHERE id = '${foreignId}'`), 'SUBMITTED');
});

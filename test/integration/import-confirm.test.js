import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomBytes, scryptSync } from 'node:crypto';
import { createServer as createTcpServer } from 'node:net';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const composeFile = `${root}/compose.yaml`;
const password = 'correct horse battery staple';
const ids = {
  region: '72000000-0000-0000-0000-000000000001',
  otherRegion: '72000000-0000-0000-0000-000000000002',
  admin: '72000000-0000-0000-0000-000000000010',
  category: '72000000-0000-0000-0000-000000000020',
  unit: '72000000-0000-0000-0000-000000000030',
  warehouse: '72000000-0000-0000-0000-000000000040',
  supplier: '72000000-0000-0000-0000-000000000045',
  product: '72000000-0000-0000-0000-000000000050',
};
let env;
let session;

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

function mutation(path, body) {
  return api(path, {
    method: 'POST',
    headers: {
      cookie: session.cookie,
      'content-type': 'application/json',
      origin: env.APP_ORIGIN,
      'x-csrf-token': session.csrf,
    },
    body: JSON.stringify(body),
  });
}

function hash(content) {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

async function preview(content) {
  const result = await mutation('/imports/preview', {
    type: 'STOCKIN',
    fileName: 'STOCK_IN_IMPORT_CONFIRM_READY.csv',
    fileHash: hash(content),
    content,
  });
  assert.equal(result.response.status, 201, JSON.stringify(result.body));
  return result.body.data;
}

before(async () => {
  const appPort = String(await reservePort());
  env = {
    ...process.env,
    APP_PORT: appPort,
    APP_ORIGIN: `http://127.0.0.1:${appPort}`,
    COMPOSE_PROJECT_NAME: `stock_import_confirm_${process.pid}`,
    POSTGRES_DB: 'stock_import_confirm_test',
    POSTGRES_USER: 'stock_import_confirm_test',
    POSTGRES_PASSWORD: randomBytes(24).toString('base64url'),
  };
  compose(['up', '-d', '--build', '--wait', '--wait-timeout', '180']);
  compose(['exec', '-T', 'app', 'node', 'src/db/migrate.js']);
  sql(`
    INSERT INTO regions (id, code, name, status) VALUES
      ('${ids.region}', 'CONFIRM-R', 'Confirm Region', 'ACTIVE'),
      ('${ids.otherRegion}', 'CONFIRM-OTHER', 'Other Region', 'ACTIVE');
    INSERT INTO users (id, name, email, password_hash, role, status, region_id)
      VALUES ('${ids.admin}', 'Confirm Admin', 'confirm-admin@example.test', '${passwordHash(password)}', 'ADMIN', 'ACTIVE', '${ids.region}');
    INSERT INTO categories (id, code, name, status)
      VALUES ('${ids.category}', 'FOOD', 'Food', 'ACTIVE');
    INSERT INTO units (id, code, name, symbol, conversion_to_base, status)
      VALUES ('${ids.unit}', 'KG', 'Kilogram', 'kg', 1, 'ACTIVE');
    INSERT INTO warehouses (id, code, name, status, region_id)
      VALUES ('${ids.warehouse}', 'CONFIRM-WH', 'Confirm Warehouse', 'ACTIVE', '${ids.region}');
    INSERT INTO suppliers (id, code, name, status)
      VALUES ('${ids.supplier}', 'CONFIRM-SUP', 'Confirm Supplier', 'ACTIVE');
    INSERT INTO products (
      id, code, name, category_id, base_unit_id, conversion_factor, status
    ) VALUES ('${ids.product}', 'RICE', 'Rice', '${ids.category}', '${ids.unit}', 1, 'ACTIVE');
  `);
  const login = await api('/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: env.APP_ORIGIN },
    body: JSON.stringify({ email: 'confirm-admin@example.test', password }),
  });
  assert.equal(login.response.status, 200, JSON.stringify(login.body));
  const cookie = login.response.headers.get('set-cookie').split(';', 1)[0];
  const csrf = await api('/auth/csrf', { headers: { cookie } });
  session = { cookie, csrf: csrf.body.data.csrfToken };
});

after(() => {
  if (!env) return;
  spawnSync('docker', ['compose', '-f', composeFile, 'down', '-v', '--remove-orphans'], {
    cwd: root, env, encoding: 'utf8',
  });
});

test('READY STOCKIN confirmation atomically imports ledger, batch, balance, status, and audit', async () => {
  const content = [
    'date,reference,supplier,warehouse,code,batch,production_date,expiry,quantity,unit,price,notes',
    '2026-10-21,INV-CONFIRM,CONFIRM-SUP,CONFIRM-WH,RICE,B-1,2026-10-01,2027-10-01,10,KG,12000,confirmed import',
  ].join('\n');
  const batch = await preview(content);

  const result = await mutation(`/imports/${batch.batchId}/confirm`, {
    previewVersion: batch.previewVersion,
    idempotencyKey: 'import-confirm-1',
  });

  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  assert.deepEqual(result.body.data, {
    batchId: batch.batchId,
    status: 'IMPORTED',
    importedCount: 1,
  });
  const retry = await mutation(`/imports/${batch.batchId}/confirm`, {
    previewVersion: batch.previewVersion,
    idempotencyKey: 'import-confirm-1',
  });
  assert.equal(retry.response.status, 200, JSON.stringify(retry.body));
  assert.deepEqual(retry.body.data, result.body.data);
  const wrongKey = await mutation(`/imports/${batch.batchId}/confirm`, {
    previewVersion: batch.previewVersion,
    idempotencyKey: 'import-confirm-1-different',
  });
  assert.equal(wrongKey.response.status, 409, JSON.stringify(wrongKey.body));
  assert.equal(wrongKey.body.errorCode, 'IDEMPOTENCY_CONFLICT');
  assert.deepEqual(JSON.parse(sql(`
    SELECT json_build_object(
      'batch_status', (SELECT status FROM import_batches WHERE id = '${batch.batchId}'),
      'row_status', (SELECT status FROM ready_import_rows WHERE import_batch_id = '${batch.batchId}'),
      'ledger_type', (SELECT transaction_type FROM stock_transactions WHERE reference_id = 'INV-CONFIRM'),
      'balance', (SELECT trim_scale(quantity)::text FROM stock_balances WHERE product_id = '${ids.product}' AND warehouse_id = '${ids.warehouse}'),
      'batch_quantity', (SELECT trim_scale(quantity)::text FROM stock_batches WHERE product_id = '${ids.product}' AND warehouse_id = '${ids.warehouse}' AND batch_number = 'B-1'),
      'audits', (SELECT count(*)::int FROM audit_logs WHERE action = 'IMPORT_CONFIRM' AND reference = '${batch.batchId}')
    )
  `)), {
    batch_status: 'IMPORTED', row_status: 'IMPORTED', ledger_type: 'IN',
    balance: '10', batch_quantity: '10', audits: 1,
  });

  const changed = await preview([
    'date,reference,supplier,warehouse,code,batch,production_date,expiry,quantity,unit,price,notes',
    '2026-10-21,INV-CHANGED,CONFIRM-SUP,CONFIRM-WH,RICE,B-CHANGED,2026-10-01,2027-10-01,1,KG,12000,changed payload',
  ].join('\n'));
  const conflict = await mutation(`/imports/${changed.batchId}/confirm`, {
    previewVersion: changed.previewVersion,
    idempotencyKey: 'import-confirm-1',
  });
  assert.equal(conflict.response.status, 409, JSON.stringify(conflict.body));
  assert.equal(conflict.body.errorCode, 'IDEMPOTENCY_CONFLICT');
  assert.equal(sql("SELECT count(*) FROM stock_transactions WHERE reference_id = 'INV-CHANGED'"), '0');
});

test('REVIEW and stale preview confirmations are rejected without stock mutation', async () => {
  const header = 'date,reference,supplier,warehouse,code,batch,production_date,expiry,quantity,unit,price,notes';
  const review = await preview([
    header,
    '2026-10-21,INV-REVIEW,CONFIRM-SUP,UNKNOWN,RICE,B-R,2026-10-01,2027-10-01,1,KG,1,review',
  ].join('\n'));
  assert.equal(review.status, 'REVIEW');
  const blocked = await mutation(`/imports/${review.batchId}/confirm`, {
    previewVersion: review.previewVersion,
    idempotencyKey: 'import-confirm-review',
  });
  assert.equal(blocked.response.status, 409, JSON.stringify(blocked.body));
  assert.equal(blocked.body.errorCode, 'IMPORT_REVIEW_REQUIRED');

  const ready = await preview([
    header,
    '2026-10-21,INV-STALE,CONFIRM-SUP,CONFIRM-WH,RICE,B-S,2026-10-01,2027-10-01,1,KG,1,stale',
  ].join('\n'));
  const stale = await mutation(`/imports/${ready.batchId}/confirm`, {
    previewVersion: String(Number(ready.previewVersion) + 1),
    idempotencyKey: 'import-confirm-stale',
  });
  assert.equal(stale.response.status, 409, JSON.stringify(stale.body));
  assert.equal(stale.body.errorCode, 'IMPORT_PREVIEW_STALE');
  assert.equal(sql("SELECT count(*) FROM stock_transactions WHERE reference_id IN ('INV-REVIEW', 'INV-STALE')"), '0');

  const crossRegion = await preview([
    header,
    '2026-10-21,INV-CROSS-REGION,CONFIRM-SUP,CONFIRM-WH,RICE,B-XR,2026-10-01,2027-10-01,1,KG,1,cross region',
  ].join('\n'));
  sql(`UPDATE warehouses SET region_id = '${ids.otherRegion}' WHERE id = '${ids.warehouse}'`);
  const denied = await mutation(`/imports/${crossRegion.batchId}/confirm`, {
    previewVersion: crossRegion.previewVersion,
    idempotencyKey: 'import-confirm-cross-region',
  });
  assert.equal(denied.response.status, 403, JSON.stringify(denied.body));
  assert.equal(denied.body.errorCode, 'REGION_FORBIDDEN');
  assert.equal(sql("SELECT count(*) FROM stock_transactions WHERE reference_id = 'INV-CROSS-REGION'"), '0');
  sql(`UPDATE warehouses SET region_id = '${ids.region}' WHERE id = '${ids.warehouse}'`);
});

test('server revalidation and multi-row failure roll back every import mutation', async () => {
  const content = [
    'date,reference,supplier,warehouse,code,batch,production_date,expiry,quantity,unit,price,notes',
    '2026-10-21,INV-ROLL-1,CONFIRM-SUP,CONFIRM-WH,RICE,B-ROLL-1,2026-10-01,2027-10-01,2,KG,10,first',
    '2026-10-21,INV-ROLL-2,CONFIRM-SUP,CONFIRM-WH,RICE,B-ROLL-2,2026-10-01,2027-10-01,3,KG,10,second',
  ].join('\n');
  const batch = await preview(content);
  sql(`UPDATE ready_import_rows SET code = 'MISSING' WHERE import_batch_id = '${batch.batchId}' AND row_number = 3`);

  const result = await mutation(`/imports/${batch.batchId}/confirm`, {
    previewVersion: batch.previewVersion,
    idempotencyKey: 'import-confirm-rollback',
  });
  assert.equal(result.response.status, 422, JSON.stringify(result.body));
  assert.equal(result.body.errorCode, 'INVALID_PRODUCT');
  assert.deepEqual(JSON.parse(sql(`
    SELECT json_build_object(
      'ledger', (SELECT count(*)::int FROM stock_transactions WHERE reference_id LIKE 'INV-ROLL-%'),
      'batches', (SELECT count(*)::int FROM stock_batches WHERE batch_number LIKE 'B-ROLL-%'),
      'status', (SELECT status FROM import_batches WHERE id = '${batch.batchId}')
    )
  `)), { ledger: 0, batches: 0, status: 'READY' });
});

test('concurrent confirmation produces one effective commit', async () => {
  const batch = await preview([
    'date,reference,supplier,warehouse,code,batch,production_date,expiry,quantity,unit,price,notes',
    '2026-10-21,INV-CONCURRENT,CONFIRM-SUP,CONFIRM-WH,RICE,B-CONCURRENT,2026-10-01,2027-10-01,4,KG,10,concurrent',
  ].join('\n'));
  const body = {
    previewVersion: batch.previewVersion,
    idempotencyKey: 'import-confirm-concurrent',
  };

  const results = await Promise.all([
    mutation(`/imports/${batch.batchId}/confirm`, body),
    mutation(`/imports/${batch.batchId}/confirm`, body),
  ]);
  for (const result of results) {
    assert.equal(result.response.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.data.status, 'IMPORTED');
  }
  assert.deepEqual(JSON.parse(sql(`
    SELECT json_build_object(
      'ledger', (SELECT count(*)::int FROM stock_transactions WHERE reference_id = 'INV-CONCURRENT'),
      'audits', (SELECT count(*)::int FROM audit_logs WHERE action = 'IMPORT_CONFIRM' AND reference = '${batch.batchId}'),
      'quantity', (SELECT trim_scale(quantity)::text FROM stock_batches WHERE batch_number = 'B-CONCURRENT')
    )
  `)), { ledger: 1, audits: 1, quantity: '4' });
});

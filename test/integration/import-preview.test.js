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
  regionA: '71000000-0000-0000-0000-000000000001',
  regionB: '71000000-0000-0000-0000-000000000002',
  admin: '71000000-0000-0000-0000-000000000010',
  supervisor: '71000000-0000-0000-0000-000000000011',
  petugas: '71000000-0000-0000-0000-000000000012',
  category: '71000000-0000-0000-0000-000000000020',
  unit: '71000000-0000-0000-0000-000000000030',
  warehouseA: '71000000-0000-0000-0000-000000000040',
  warehouseB: '71000000-0000-0000-0000-000000000041',
  supplier: '71000000-0000-0000-0000-000000000045',
  product: '71000000-0000-0000-0000-000000000050',
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

function hash(content) {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function preview(session, type, fileName, content, fileHash = hash(content)) {
  return api('/imports/preview', {
    method: 'POST',
    headers: {
      cookie: session?.cookie || '',
      'content-type': 'application/json',
      origin: env.APP_ORIGIN,
      'x-csrf-token': session?.csrf || '',
    },
    body: JSON.stringify({ type, fileName, fileHash, content }),
  });
}

before(async () => {
  const appPort = String(await reservePort());
  env = {
    ...process.env,
    APP_PORT: appPort,
    APP_ORIGIN: `http://127.0.0.1:${appPort}`,
    COMPOSE_PROJECT_NAME: `stock_import_preview_${process.pid}`,
    POSTGRES_DB: 'stock_import_preview_test',
    POSTGRES_USER: 'stock_import_preview_test',
    POSTGRES_PASSWORD: randomBytes(24).toString('base64url'),
  };
  compose(['up', '-d', '--build', '--wait', '--wait-timeout', '180']);
  compose(['exec', '-T', 'app', 'node', 'src/db/migrate.js']);
  sql(`
    INSERT INTO regions (id, code, name, status) VALUES
      ('${ids.regionA}', 'IMP-A', 'Import Region A', 'ACTIVE'),
      ('${ids.regionB}', 'IMP-B', 'Import Region B', 'ACTIVE');
    INSERT INTO users (id, name, email, password_hash, role, status, region_id) VALUES
      ('${ids.admin}', 'Import Admin', 'import-admin@example.test', '${passwordHash(password)}', 'ADMIN', 'ACTIVE', '${ids.regionA}'),
      ('${ids.supervisor}', 'Import Supervisor', 'import-supervisor@example.test', '${passwordHash(password)}', 'SUPERVISOR', 'ACTIVE', '${ids.regionA}'),
      ('${ids.petugas}', 'Import Petugas', 'import-petugas@example.test', '${passwordHash(password)}', 'PETUGAS', 'ACTIVE', '${ids.regionA}');
    INSERT INTO categories (id, code, name, status)
      VALUES ('${ids.category}', 'FOOD', 'Food', 'ACTIVE');
    INSERT INTO units (id, code, name, symbol, conversion_to_base, status)
      VALUES ('${ids.unit}', 'KG', 'Kilogram', 'kg', 1, 'ACTIVE');
    INSERT INTO unit_aliases (id, alias, unit_id, status)
      VALUES (gen_random_uuid(), 'kilo', '${ids.unit}', 'ACTIVE');
    INSERT INTO warehouses (id, code, name, status, region_id) VALUES
      ('${ids.warehouseA}', 'IMP-WH-A', 'Import Warehouse A', 'ACTIVE', '${ids.regionA}'),
      ('${ids.warehouseB}', 'IMP-WH-B', 'Import Warehouse B', 'ACTIVE', '${ids.regionB}');
    INSERT INTO suppliers (id, code, name, status)
      VALUES ('${ids.supplier}', 'SUP-A', 'Supplier A', 'ACTIVE');
    INSERT INTO products (
      id, code, name, category_id, base_unit_id, conversion_factor, status
    ) VALUES ('${ids.product}', 'RICE', 'Rice', '${ids.category}', '${ids.unit}', 1, 'ACTIVE');
  `);
  const [admin, supervisor, petugas] = await Promise.all([
    login('import-admin@example.test'),
    login('import-supervisor@example.test'),
    login('import-petugas@example.test'),
  ]);
  sessions = { admin, supervisor, petugas };
});

after(() => {
  if (!env) return;
  spawnSync('docker', ['compose', '-f', composeFile, 'down', '-v', '--remove-orphans'], {
    cwd: root, env, encoding: 'utf8',
  });
});

test('import screen requires session and serves preview assets', async () => {
  const origin = `http://127.0.0.1:${env.APP_PORT}`;
  const anonymous = await fetch(`${origin}/imports`, { redirect: 'manual' });
  assert.equal(anonymous.status, 302);
  assert.equal(anonymous.headers.get('location'), '/login');

  const [page, script] = await Promise.all([
    fetch(`${origin}/imports`, { headers: { cookie: sessions.admin.cookie } }),
    fetch(`${origin}/import.js`),
  ]);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /^text\/html/);
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.match(await page.text(), /<form[^>]+id="import-form"/);
  assert.equal(script.status, 200);
  assert.match(script.headers.get('content-type'), /^text\/javascript/);
});

test('valid READY preview stages normalized row, hash, and audit without ledger mutation', async () => {
  const content = [
    'date,reference,supplier,warehouse,code,batch,production_date,expiry,quantity,unit,price,notes',
    '2026-10-21,INV-1,SUP-A,IMP-WH-A,RICE,B-1,2026-10-01,2027-10-01,10,KG,12000,"safe, quoted note"',
  ].join('\n');
  const result = await preview(
    sessions.admin, 'STOCKIN', 'STOCK_IN_IMPORT_20261021_READY.csv', content,
  );

  assert.equal(result.response.status, 201, JSON.stringify(result.body));
  assert.equal(result.body.data.status, 'READY');
  assert.equal(result.body.data.fileHash, hash(content));
  assert.equal(result.body.data.rowCount, 1);
  assert.equal(result.body.data.reviewCount, 0);
  assert.deepEqual(result.body.data.headers, content.split('\n')[0].split(','));
  assert.equal(result.body.data.rows[0].notes, 'safe, quoted note');
  assert.deepEqual(JSON.parse(sql(`
    SELECT json_build_object(
      'batches', (SELECT count(*)::int FROM import_batches),
      'ready', (SELECT count(*)::int FROM ready_import_rows WHERE status = 'READY'),
      'ocr', (SELECT count(*)::int FROM staging_ocr_lines),
      'ledger', (SELECT count(*)::int FROM stock_transactions),
      'audits', (SELECT count(*)::int FROM audit_logs WHERE action = 'IMPORT_PREVIEW')
    )
  `)), { batches: 1, ready: 1, ocr: 0, ledger: 0, audits: 1 });
});

test('OCR staging stays isolated and unresolved references remain REVIEW', async () => {
  const content = [
    'source_pdf,page,category,description_raw,quantity,unit_raw,unit_price,line_total,review_status,notes',
    'invoice.pdf,1,UNKNOWN,Raw rice,2,MYSTERY,100,200,READY,OCR uncertain',
  ].join('\n');
  const result = await preview(
    sessions.admin, 'STAGING_OCR', 'STOCK_IN_REVIEW_invoice.csv', content,
  );

  assert.equal(result.response.status, 201, JSON.stringify(result.body));
  assert.equal(result.body.data.status, 'REVIEW');
  assert.equal(result.body.data.reviewCount, 1);
  assert.deepEqual(result.body.data.rows[0].errors.map(({ code }) => code).sort(), [
    'CATEGORY_NOT_FOUND', 'UNIT_NOT_FOUND',
  ]);
  assert.deepEqual(JSON.parse(sql(`
    SELECT json_build_object(
      'ocr', (SELECT count(*)::int FROM staging_ocr_lines WHERE import_batch_id = '${result.body.data.batchId}'),
      'ready', (SELECT count(*)::int FROM ready_import_rows WHERE import_batch_id = '${result.body.data.batchId}'),
      'ledger', (SELECT count(*)::int FROM stock_transactions)
    )
  `)), { ocr: 1, ready: 0, ledger: 0 });
});

test('cross-region warehouse is REVIEW for ADMIN and cannot become import-ready', async () => {
  const content = [
    'date,reference,supplier,warehouse,code,batch,production_date,expiry,quantity,unit,price,notes',
    '2026-10-21,INV-X,SUP-A,IMP-WH-B,RICE,,,,1,KG,1,wrong region',
  ].join('\n');
  const result = await preview(
    sessions.admin, 'STOCKIN', 'STOCK_IN_IMPORT_REGION_READY.csv', content,
  );

  assert.equal(result.response.status, 201, JSON.stringify(result.body));
  assert.equal(result.body.data.status, 'REVIEW');
  assert.equal(result.body.data.rows[0].status, 'REVIEW');
  assert.ok(result.body.data.rows[0].errors.some(({ code }) => code === 'INVALID_WAREHOUSE'));
  assert.equal(sql(`SELECT count(*) FROM stock_transactions`), '0');
});

test('malformed, wrong header, hash mismatch, and oversized CSV fail before persistence', async () => {
  const originalCount = sql('SELECT count(*) FROM import_batches');
  const malformed = 'date,reference\n"2026-10-21,INV-1';
  const badCsv = await preview(sessions.admin, 'STOCKIN', 'STOCK_IN_IMPORT_BAD_READY.csv', malformed);
  assert.equal(badCsv.response.status, 400, JSON.stringify(badCsv.body));
  assert.equal(badCsv.body.errorCode, 'IMPORT_CSV_MALFORMED');

  const nulCsv = 'code,name,category,unit,minimum_stock,maximum_stock,barcode\nNUL,NUL\0,FOOD,KG,0,1,';
  const badNul = await preview(sessions.admin, 'PRODUCTS', 'nul.csv', nulCsv);
  assert.equal(badNul.response.status, 400, JSON.stringify(badNul.body));
  assert.equal(badNul.body.errorCode, 'IMPORT_CSV_MALFORMED');

  const wrongHeader = 'reference,date\nINV-1,2026-10-21';
  const badHeader = await preview(sessions.admin, 'STOCKIN', 'STOCK_IN_IMPORT_HEADER_READY.csv', wrongHeader);
  assert.equal(badHeader.response.status, 422, JSON.stringify(badHeader.body));
  assert.equal(badHeader.body.errorCode, 'IMPORT_HEADER_INVALID');

  const valid = 'code,name,category,unit,minimum_stock,maximum_stock,barcode\nA,A,FOOD,KG,0,1,';
  const badHash = await preview(sessions.admin, 'PRODUCTS', 'products.csv', valid, '0'.repeat(64));
  assert.equal(badHash.response.status, 409, JSON.stringify(badHash.body));
  assert.equal(badHash.body.errorCode, 'IMPORT_HASH_MISMATCH');

  const header = 'code,name,category,unit,minimum_stock,maximum_stock,barcode\n';
  const oversized = `${header}${'A'.repeat(1024 * 1024)}`;
  const tooLarge = await preview(sessions.admin, 'PRODUCTS', 'large.csv', oversized);
  assert.equal(tooLarge.response.status, 413, JSON.stringify(tooLarge.body));
  assert.equal(tooLarge.body.errorCode, 'IMPORT_FILE_TOO_LARGE');

  const wideField = await preview(
    sessions.admin, 'PRODUCTS', 'wide.csv', `${header}WIDE,${'A'.repeat(4097)},FOOD,KG,0,1,`,
  );
  assert.equal(wideField.response.status, 413, JSON.stringify(wideField.body));
  assert.equal(wideField.body.errorCode, 'IMPORT_FIELD_TOO_LARGE');

  const tooManyRows = await preview(
    sessions.admin, 'PRODUCTS', 'rows.csv', `${header}${',,,,,,\n'.repeat(100_001)}`,
  );
  assert.equal(tooManyRows.response.status, 413, JSON.stringify(tooManyRows.body));
  assert.equal(tooManyRows.body.errorCode, 'IMPORT_TOO_MANY_ROWS');
  assert.equal(sql('SELECT count(*) FROM import_batches'), originalCount);
});

test('invalid typed values remain REVIEW instead of failing PostgreSQL casts', async () => {
  const product = 'code,name,category,unit,minimum_stock,maximum_stock,barcode\nTYPED,Typed,FOOD,KG,0x10,maximum,';
  const productResult = await preview(sessions.admin, 'PRODUCTS', 'typed-products.csv', product);
  assert.equal(productResult.response.status, 201, JSON.stringify(productResult.body));
  assert.equal(productResult.body.data.status, 'REVIEW');
  assert.equal(productResult.body.data.rows[0].errors[0].code, 'INVALID_QUANTITY');

  const stockIn = [
    'date,reference,supplier,warehouse,code,batch,production_date,expiry,quantity,unit,price,notes',
    '2026-99-99,INV-TYPED,SUP-A,IMP-WH-A,RICE,B-2,bad-date,,many,KG,free,invalid values',
  ].join('\n');
  const stockResult = await preview(
    sessions.admin, 'STOCKIN', 'STOCK_IN_IMPORT_TYPED_READY.csv', stockIn,
  );
  assert.equal(stockResult.response.status, 201, JSON.stringify(stockResult.body));
  assert.equal(stockResult.body.data.status, 'REVIEW');
  assert.ok(stockResult.body.data.rows[0].errors.length >= 3);

  const ocr = [
    'source_pdf,page,category,description_raw,quantity,unit_raw,unit_price,line_total,review_status,notes',
    'typed.pdf,no-page,FOOD,Raw rice,many,KG,free,total,READY,invalid values',
    'typed2.pdf,,FOOD,Raw rice,1,KG,1,1,READY,empty page',
  ].join('\n');
  const ocrResult = await preview(
    sessions.admin, 'STAGING_OCR', 'STOCK_IN_REVIEW_typed.csv', ocr,
  );
  assert.equal(ocrResult.response.status, 201, JSON.stringify(ocrResult.body));
  assert.equal(ocrResult.body.data.status, 'REVIEW');
  assert.ok(ocrResult.body.data.rows[0].errors.length >= 4);
  assert.equal(sql('SELECT count(*) FROM stock_transactions'), '0');
});

test('audit failure rolls back import batch and staging rows atomically', async () => {
  const before = sql('SELECT count(*) FROM import_batches');
  sql(`
    CREATE FUNCTION reject_import_preview_audit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.action = 'IMPORT_PREVIEW' THEN RAISE EXCEPTION 'forced audit failure'; END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER reject_import_preview_audit
      BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION reject_import_preview_audit();
  `);
  let result;
  try {
    const content = 'code,name,category,unit,minimum_stock,maximum_stock,barcode\nROLLBACK,Rollback,FOOD,KG,0,1,';
    result = await preview(sessions.admin, 'PRODUCTS', 'rollback.csv', content);
  } finally {
    sql(`
      DROP TRIGGER reject_import_preview_audit ON audit_logs;
      DROP FUNCTION reject_import_preview_audit();
    `);
  }
  assert.equal(result.response.status, 500, JSON.stringify(result.body));
  assert.equal(result.body.errorCode, 'INTERNAL_ERROR');
  assert.equal(sql('SELECT count(*) FROM import_batches'), before);
  assert.equal(sql("SELECT count(*) FROM ready_import_rows WHERE code = 'ROLLBACK'"), '0');
});

test('preview requires authenticated ADMIN, allowed Origin, and valid CSRF', async () => {
  const content = 'code,name,category,unit,minimum_stock,maximum_stock,barcode\nA,A,FOOD,KG,0,1,';
  const anonymous = await preview(null, 'PRODUCTS', 'anonymous.csv', content);
  assert.equal(anonymous.response.status, 401, JSON.stringify(anonymous.body));
  for (const session of [sessions.supervisor, sessions.petugas]) {
    const denied = await preview(session, 'PRODUCTS', `denied-${session.cookie.length}.csv`, content);
    assert.equal(denied.response.status, 403, JSON.stringify(denied.body));
    assert.equal(denied.body.errorCode, 'FORBIDDEN');
  }
  const noCsrf = await api('/imports/preview', {
    method: 'POST',
    headers: {
      cookie: sessions.admin.cookie, 'content-type': 'application/json', origin: env.APP_ORIGIN,
    },
    body: JSON.stringify({ type: 'PRODUCTS', fileName: 'no-csrf.csv', fileHash: hash(content), content }),
  });
  assert.equal(noCsrf.response.status, 403, JSON.stringify(noCsrf.body));
  assert.equal(noCsrf.body.errorCode, 'CSRF_INVALID');
});

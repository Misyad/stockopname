import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer as createTcpServer } from 'node:net';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../..', import.meta.url));
const composeFile = `${projectRoot}/compose.yaml`;
const actorId = '30000000-0000-0000-0000-000000000001';
let env;

function compose(args, options = {}) {
  return execFileSync('docker', ['compose', '-f', composeFile, ...args], {
    cwd: projectRoot,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
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

function runInApp(body) {
  const source = `
    import assert from 'node:assert/strict';
    import { pool } from './src/db/pool.js';
    import * as masters from './src/services/master.js';
    const admin = { userId: '${actorId}', role: 'ADMIN' };
    try { ${body} } finally { await pool.end(); }
  `;
  return compose(['exec', '-T', 'app', 'node', '--input-type=module', '-'], {
    input: source,
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

before(async () => {
  env = {
    ...process.env,
    APP_PORT: String(await reservePort()),
    APP_ORIGIN: '',
    COMPOSE_PROJECT_NAME: `stock_opname_master_${process.pid}`,
    POSTGRES_DB: 'stock_opname_master_test',
    POSTGRES_USER: 'stock_opname_master_test',
    POSTGRES_PASSWORD: randomBytes(24).toString('base64url'),
  };
  compose(['up', '-d', '--build', '--wait', '--wait-timeout', '180']);
  compose(['exec', '-T', 'app', 'node', 'src/db/migrate.js']);
  compose([
    'exec', '-T', 'database', 'psql', '-X', '-v', 'ON_ERROR_STOP=1',
    '-U', env.POSTGRES_USER, '-d', env.POSTGRES_DB,
    '-c', `INSERT INTO users (id, name, email, password_hash, role, status, created_at, updated_at)
           VALUES ('${actorId}', 'Admin', 'master-admin@example.test', 'not-used',
                   'ADMIN', 'ACTIVE', now(), now())`,
  ]);
});

after(() => {
  if (!env) return;
  spawnSync('docker', ['compose', '-f', composeFile, 'down', '-v', '--remove-orphans'], {
    cwd: projectRoot,
    env,
    encoding: 'utf8',
  });
});

test('ADMIN creates, updates, and deactivates category with atomic audit', () => {
  assert.equal(runInApp(`
    const created = await masters.createMaster(pool, admin, 'category', {
      code: ' food ', name: ' Food ', status: 'ACTIVE',
    });
    assert.equal(created.code, 'FOOD');
    const updated = await masters.updateMaster(pool, admin, 'category', created.id, {
      name: 'Fresh Food',
    });
    assert.equal(updated.name, 'Fresh Food');
    const inactive = await masters.deactivateMaster(pool, admin, 'category', created.id);
    assert.equal(inactive.status, 'INACTIVE');
    const state = await pool.query(
      'SELECT (SELECT count(*) FROM categories WHERE id = $1::uuid)::int AS rows, '
      + '(SELECT count(*) FROM audit_logs WHERE reference = $1::text)::int AS audits',
      [created.id],
    );
    assert.deepEqual(state.rows[0], { rows: 1, audits: 3 });
    console.log('PASS');
  `), 'PASS');
});

test('non-ADMIN master mutation is denied before database mutation', () => {
  assert.equal(runInApp(`
    await assert.rejects(
      masters.createMaster(pool, { userId: '${actorId}', role: 'SUPERVISOR' }, 'category', {
        code: 'DENIED', name: 'Denied', status: 'ACTIVE',
      }),
      (error) => error.status === 403 && error.errorCode === 'FORBIDDEN',
    );
    const result = await pool.query("SELECT count(*)::int AS count FROM categories WHERE code = 'DENIED'");
    assert.equal(result.rows[0].count, 0);
    console.log('PASS');
  `), 'PASS');
});

test('duplicate code is actionable and failed write leaves no audit', () => {
  assert.equal(runInApp(`
    await masters.createMaster(pool, admin, 'warehouse', {
      code: 'WH-01', name: 'Main', location: 'North', status: 'ACTIVE',
    });
    await assert.rejects(
      masters.createMaster(pool, admin, 'warehouse', {
        code: ' wh-01 ', name: 'Duplicate', status: 'ACTIVE',
      }),
      (error) => error.errorCode === 'DUPLICATE_CODE',
    );
    const state = await pool.query(
      "SELECT (SELECT count(*) FROM warehouses WHERE code = 'WH-01')::int AS rows, "
      + "(SELECT count(*) FROM audit_logs WHERE action = 'CREATE_WAREHOUSE')::int AS audits",
    );
    assert.deepEqual(state.rows[0], { rows: 1, audits: 1 });
    console.log('PASS');
  `), 'PASS');
});

test('all approved master kinds validate references and user secrets', () => {
  assert.equal(runInApp(`
    const category = await masters.createMaster(pool, admin, 'category', {
      code: 'DRY', name: 'Dry Goods', status: 'ACTIVE',
    });
    const unit = await masters.createMaster(pool, admin, 'unit', {
      code: 'BOX', name: 'Box', symbol: 'box', conversion_to_base: 1, status: 'ACTIVE',
    });
    const alias = await masters.createMaster(pool, admin, 'unitAlias', {
      alias: 'boxes', unit_id: unit.id, status: 'ACTIVE',
    });
    const warehouse = await masters.createMaster(pool, admin, 'warehouse', {
      code: 'WH-02', name: 'Secondary', status: 'ACTIVE',
    });
    const supplier = await masters.createMaster(pool, admin, 'supplier', {
      code: 'SUP-01', name: 'Supplier', phone: null, address: null, status: 'ACTIVE',
    });
    const product = await masters.createMaster(pool, admin, 'product', {
      code: 'P-01', barcode: '8990001', name: 'Rice', category_id: category.id,
      base_unit_id: unit.id, purchase_unit_id: unit.id, conversion_factor: 1,
      minimum_stock: 0, maximum_stock: 100, photo_url: null, status: 'ACTIVE',
    });
    const user = await masters.createMaster(pool, admin, 'user', {
      name: 'Operator', email: ' Operator@Example.Test ', password: 'strong test password',
      role: 'PETUGAS', status: 'ACTIVE',
    });
    assert.equal(alias.alias, 'boxes');
    assert.equal(warehouse.code, 'WH-02');
    assert.equal(supplier.code, 'SUP-01');
    assert.equal(product.code, 'P-01');
    assert.equal(user.email, 'operator@example.test');
    assert.equal(Object.hasOwn(user, 'password_hash'), false);
    const stored = await pool.query('SELECT password_hash FROM users WHERE id = $1', [user.id]);
    assert.doesNotMatch(stored.rows[0].password_hash, /strong test password/);
    assert.match(stored.rows[0].password_hash, /^scrypt\\$131072\\$8\\$1\\$/);
    console.log('PASS');
  `), 'PASS');
});

test('invalid and inactive references never become transaction-valid', () => {
  assert.equal(runInApp(`
    await assert.rejects(
      masters.createMaster(pool, admin, 'product', {
        code: 'BROKEN', name: 'Broken', category_id: '40000000-0000-0000-0000-000000000001',
        base_unit_id: '40000000-0000-0000-0000-000000000002', conversion_factor: 1,
        minimum_stock: 0, maximum_stock: 0, status: 'ACTIVE',
      }),
      (error) => error.errorCode === 'CATEGORY_NOT_FOUND',
    );
    const unit = await masters.createMaster(pool, admin, 'unit', {
      code: 'OLD', name: 'Old', symbol: 'old', conversion_to_base: 1, status: 'ACTIVE',
    });
    await masters.deactivateMaster(pool, admin, 'unit', unit.id);
    await assert.rejects(
      masters.createMaster(pool, admin, 'unitAlias', {
        alias: 'old-unit', unit_id: unit.id, status: 'ACTIVE',
      }),
      (error) => error.errorCode === 'UNIT_NOT_FOUND',
    );
    console.log('PASS');
  `), 'PASS');
});

test('alias resolves canonical unit; REVIEW product is blocked from transaction', () => {
  assert.equal(runInApp(`
    const category = await masters.createMaster(pool, admin, 'category', {
      code: 'REVIEW-CAT', name: 'Review Category', status: 'ACTIVE',
    });
    const unit = await masters.createMaster(pool, admin, 'unit', {
      code: 'CANON', name: 'Canonical', symbol: 'c', conversion_to_base: 1, status: 'ACTIVE',
    });
    await masters.createMaster(pool, admin, 'unitAlias', {
      alias: 'canon-alias', unit_id: unit.id, status: 'ACTIVE',
    });
    const resolved = await masters.resolveTransactionMaster(pool, 'unit', ' CANON-ALIAS ');
    assert.equal(resolved.id, unit.id);
    const review = await masters.createMaster(pool, admin, 'product', {
      code: 'REVIEW-P', name: 'Needs Review', category_id: category.id,
      base_unit_id: unit.id, conversion_factor: 1, minimum_stock: 0,
      maximum_stock: 0, status: 'REVIEW',
    });
    await assert.rejects(
      masters.resolveTransactionMaster(pool, 'product', review.id),
      (error) => error.errorCode === 'INVALID_PRODUCT',
    );
    await assert.rejects(
      masters.resolveTransactionMaster(pool, 'unit', 'unknown-alias'),
      (error) => error.errorCode === 'UNIT_NOT_FOUND',
    );
    console.log('PASS');
  `), 'PASS');
});

test('product resolver rejects inactive category/unit parents', () => {
  assert.equal(runInApp(`
    const category = await masters.createMaster(pool, admin, 'category', {
      code: 'PARENT-CAT', name: 'Parent Category', status: 'ACTIVE',
    });
    const unit = await masters.createMaster(pool, admin, 'unit', {
      code: 'PARENT-UNIT', name: 'Parent Unit', symbol: 'pu',
      conversion_to_base: 1, status: 'ACTIVE',
    });
    const product = await masters.createMaster(pool, admin, 'product', {
      code: 'PARENT-PRODUCT', name: 'Parent Product', category_id: category.id,
      base_unit_id: unit.id, conversion_factor: 1, minimum_stock: 0,
      maximum_stock: 0, status: 'ACTIVE',
    });
    await masters.deactivateMaster(pool, admin, 'category', category.id);
    await assert.rejects(
      masters.resolveTransactionMaster(pool, 'product', product.id),
      (error) => error.errorCode === 'INVALID_PRODUCT',
    );
    console.log('PASS');
  `), 'PASS');
});

test('master id accepts schema UUIDs and rejects malformed values', () => {
  assert.equal(runInApp(`
    const seededId = '00000000-0000-0000-0000-000000000099';
    await pool.query(\`
      INSERT INTO categories (id, code, name, status, created_at, updated_at)
      VALUES ($1, 'SEEDED-ID', 'Seeded ID', 'ACTIVE', now(), now())
    \`, [seededId]);
    const updated = await masters.updateMaster(pool, admin, 'category', seededId, { name: 'Updated Seed' });
    assert.equal(updated.name, 'Updated Seed');
    await assert.rejects(
      masters.updateMaster(pool, admin, 'category', 'not-a-uuid', { name: 'Nope' }),
      (error) => error.status === 400 && error.errorCode === 'VALIDATION_ERROR',
    );
    console.log('PASS');
  `), 'PASS');
});

test('audit failure rolls back master mutation atomically', () => {
  assert.equal(runInApp(`
    await assert.rejects(
      masters.createMaster(
        pool,
        { userId: 'ffffffff-ffff-ffff-ffff-ffffffffffff', role: 'ADMIN' },
        'category',
        { code: 'ROLLBACK', name: 'Must Roll Back', status: 'ACTIVE' },
      ),
      (error) => error.code === '23503',
    );
    const result = await pool.query("SELECT count(*)::int AS count FROM categories WHERE code = 'ROLLBACK'");
    assert.equal(result.rows[0].count, 0);
    console.log('PASS');
  `), 'PASS');
});

test('service exposes no physical-delete operation and rejects unknown fields', () => {
  assert.equal(runInApp(`
    assert.equal(masters.deleteMaster, undefined);
    await assert.rejects(
      masters.createMaster(pool, admin, 'category', {
        code: 'INJECT', name: 'Inject', status: 'ACTIVE', deleted_at: new Date(),
      }),
      (error) => error.errorCode === 'VALIDATION_ERROR',
    );
    console.log('PASS');
  `), 'PASS');
});

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes, scryptSync } from 'node:crypto';
import { createServer as createTcpServer } from 'node:net';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const composeFile = `${root}/compose.yaml`;
const password = 'correct horse battery staple';
export const ids = Object.freeze({
  regionA: '68000000-0000-4000-8000-000000000001',
  regionB: '68000000-0000-4000-8000-000000000002',
  admin: '68000000-0000-4000-8000-000000000010',
  petugas: '68000000-0000-4000-8000-000000000011',
  foreignAdmin: '68000000-0000-4000-8000-000000000012',
  category: '68000000-0000-4000-8000-000000000020',
  unit: '68000000-0000-4000-8000-000000000030',
  supplier: '68000000-0000-4000-8000-000000000035',
  warehouseA: '68000000-0000-4000-8000-000000000040',
  warehouseB: '68000000-0000-4000-8000-000000000041',
  safe: '68000000-0000-4000-8000-000000000050',
  low: '68000000-0000-4000-8000-000000000051',
  out: '68000000-0000-4000-8000-000000000052',
  safeBatch: '68000000-0000-4000-8000-000000000060',
  lowBatch: '68000000-0000-4000-8000-000000000061',
  foreignBatch: '68000000-0000-4000-8000-000000000062',
  opnameA: '68000000-0000-4000-8000-000000000070',
  opnameB: '68000000-0000-4000-8000-000000000071',
  opnameItem: '68000000-0000-4000-8000-000000000080',
});

let env;

function compose(args, options = {}) {
  return execFileSync('docker', ['compose', '-f', composeFile, ...args], {
    cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options,
  });
}


export function sql(statement) {
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

export async function api(path, options = {}) {
  const response = await fetch(`http://127.0.0.1:${env.APP_PORT}/api${path}`, options);
  const contentType = response.headers.get('content-type') || '';
  const body = contentType.startsWith('application/json') ? await response.json() : await response.text();
  return { response, body };
}


export async function login(email = 'reports-admin@example.test') {
  const result = await api('/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: env.APP_ORIGIN },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  return result.response.headers.get('set-cookie').split(';', 1)[0];
}

export async function setup(name) {
  const appPort = String(await reservePort());
  const postgresPassword = randomBytes(24).toString('base64url');
  const databaseUrl = `postgresql://${name}_test:${postgresPassword}@database:5432/${name}_test`;
  env = {
    ...process.env,
    APP_PORT: appPort,
    APP_ORIGIN: `http://127.0.0.1:${appPort}`,
    COMPOSE_PROJECT_NAME: `${name}_${process.pid}`,
    POSTGRES_DB: `${name}_test`,
    POSTGRES_USER: `${name}_test`,
    POSTGRES_PASSWORD: postgresPassword,
    DATABASE_URL: databaseUrl,
    DATABASE_ADMIN_URL: databaseUrl,
  };
  compose(['up', '-d', '--build', '--wait', '--wait-timeout', '180']);
  compose(['exec', '-T', 'app', 'node', 'src/db/migrate.js']);
  sql(`
    INSERT INTO regions (id, code, name, status) VALUES
      ('${ids.regionA}', 'RPT-A', 'Reports A', 'ACTIVE'),
      ('${ids.regionB}', 'RPT-B', 'Reports B', 'ACTIVE');
    INSERT INTO users (id, name, email, password_hash, role, status, region_id) VALUES
      ('${ids.admin}', 'Reports Admin', 'reports-admin@example.test', '${passwordHash(password)}', 'ADMIN', 'ACTIVE', '${ids.regionA}'),
      ('${ids.petugas}', 'Reports Petugas', 'reports-petugas@example.test', '${passwordHash(password)}', 'PETUGAS', 'ACTIVE', '${ids.regionA}'),
      ('${ids.foreignAdmin}', 'Foreign Admin', 'reports-foreign@example.test', '${passwordHash(password)}', 'ADMIN', 'ACTIVE', '${ids.regionB}');
    INSERT INTO categories (id, code, name, status)
      VALUES ('${ids.category}', 'RPT-CAT', 'Reports Category', 'ACTIVE');
    INSERT INTO units (id, code, name, symbol, conversion_to_base, status)
      VALUES ('${ids.unit}', 'RPT-KG', 'Kilogram', 'kg', 1, 'ACTIVE');
    INSERT INTO suppliers (id, code, name, status)
      VALUES ('${ids.supplier}', 'RPT-SUP', '=FORMULA SUPPLIER', 'ACTIVE');
    INSERT INTO warehouses (id, code, name, status, region_id) VALUES
      ('${ids.warehouseA}', 'RPT-WH-A', 'Reports Warehouse A', 'ACTIVE', '${ids.regionA}'),
      ('${ids.warehouseB}', 'RPT-WH-B', 'Reports Warehouse B', 'ACTIVE', '${ids.regionB}');
    INSERT INTO products (id, code, name, category_id, base_unit_id, conversion_factor, minimum_stock, maximum_stock, status) VALUES
      ('${ids.safe}', 'RPT-SAFE', 'Safe Product', '${ids.category}', '${ids.unit}', 1, 10, 100, 'ACTIVE'),
      ('${ids.low}', 'RPT-LOW', 'Low Product', '${ids.category}', '${ids.unit}', 1, 10, 100, 'ACTIVE'),
      ('${ids.out}', 'RPT-OUT', 'Out Product', '${ids.category}', '${ids.unit}', 1, 10, 100, 'ACTIVE');
    INSERT INTO stock_balances (id, product_id, warehouse_id, quantity, version) VALUES
      (gen_random_uuid(), '${ids.safe}', '${ids.warehouseA}', 20, 1),
      (gen_random_uuid(), '${ids.low}', '${ids.warehouseA}', 5, 1),
      (gen_random_uuid(), '${ids.out}', '${ids.warehouseA}', 0, 1),
      (gen_random_uuid(), '${ids.safe}', '${ids.warehouseB}', 99, 1);
    INSERT INTO stock_batches (id, product_id, warehouse_id, batch_number, expiry_date, quantity, unit, purchase_price, status) VALUES
      ('${ids.safeBatch}', '${ids.safe}', '${ids.warehouseA}', 'SAFE-7D', current_date + 5, 20, 'RPT-KG', 2, 'ACTIVE'),
      ('${ids.lowBatch}', '${ids.low}', '${ids.warehouseA}', 'LOW-EXPIRED', current_date - 1, 5, 'RPT-KG', 3, 'ACTIVE'),
      ('${ids.foreignBatch}', '${ids.safe}', '${ids.warehouseB}', 'FOREIGN', current_date + 2, 99, 'RPT-KG', 9, 'ACTIVE');
    INSERT INTO stock_transactions (
      id, idempotency_key, transaction_number, transaction_type, transaction_date,
      request_hash, reference_id, product_id, warehouse_id, batch_id, supplier_id,
      quantity, unit, balance_before, balance_after, reason, user_id, created_at
    ) VALUES
      (gen_random_uuid(), 'rpt-open', 'RPT-OPEN', 'OPENING', '2026-10-01', '', 'OPEN', '${ids.safe}', '${ids.warehouseA}', '${ids.safeBatch}', NULL, 20, 'RPT-KG', 0, 20, NULL, '${ids.admin}', now() - interval '4 hours'),
      (gen_random_uuid(), 'rpt-in', 'RPT-IN', 'IN', '2026-10-02', '', 'IN-REF', '${ids.low}', '${ids.warehouseA}', '${ids.lowBatch}', '${ids.supplier}', 5, 'RPT-KG', 0, 5, '=SUM(1,1)', '${ids.admin}', now() - interval '3 hours'),
      (gen_random_uuid(), 'rpt-out', 'RPT-OUT', 'OUT', '2026-10-03', '', 'OUT-REF', '${ids.safe}', '${ids.warehouseA}', '${ids.safeBatch}', NULL, -1, 'RPT-KG', 20, 19, 'Usage', '${ids.petugas}', now() - interval '2 hours'),
      (gen_random_uuid(), 'rpt-adjust', 'RPT-ADJUST', 'ADJUSTMENT', '2026-10-04', '', 'ADJ-REF', '${ids.safe}', '${ids.warehouseA}', '${ids.safeBatch}', NULL, -2, 'RPT-KG', 20, 18, 'Count', '${ids.admin}', now() - interval '1 hour'),
      (gen_random_uuid(), 'rpt-foreign', 'RPT-FOREIGN', 'IN', '2026-10-05', '', 'FOREIGN', '${ids.safe}', '${ids.warehouseB}', '${ids.foreignBatch}', NULL, 99, 'RPT-KG', 0, 99, NULL, '${ids.foreignAdmin}', now());
    INSERT INTO stock_opnames (
      id, opname_number, warehouse_id, opname_date, status, snapshot_at, snapshot_version, created_by, created_at, updated_at
    ) VALUES
      ('${ids.opnameA}', 'RPT-OP-A', '${ids.warehouseA}', '2026-10-06', 'SUBMITTED', now(), 1, '${ids.petugas}', now(), now()),
      ('${ids.opnameB}', 'RPT-OP-B', '${ids.warehouseB}', '2026-10-06', 'SUBMITTED', now(), 1, '${ids.foreignAdmin}', now(), now());
    INSERT INTO stock_opname_items (
      id, opname_id, product_id, batch_id, system_quantity, physical_quantity, difference,
      difference_value, unit, unit_price, reason
    ) VALUES ('${ids.opnameItem}', '${ids.opnameA}', '${ids.safe}', '${ids.safeBatch}', 20, 18, -2, -4, 'RPT-KG', 2, '+formula reason');
  `);
  return { admin: await login(), petugas: await login('reports-petugas@example.test') };
}

export function teardown() {
  if (!env) return;
  spawnSync('docker', ['compose', '-f', composeFile, 'down', '-v', '--remove-orphans'], {
    cwd: root, env, encoding: 'utf8',
  });
  env = undefined;
}

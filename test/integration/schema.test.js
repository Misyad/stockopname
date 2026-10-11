import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { createServer as createTcpServer } from 'node:net';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../..', import.meta.url));
const composeFile = `${projectRoot}/compose.yaml`;
const ids = {
  user: '00000000-0000-0000-0000-000000000001',
  category: '00000000-0000-0000-0000-000000000010',
  unit: '00000000-0000-0000-0000-000000000020',
  product: '00000000-0000-0000-0000-000000000030',
  warehouse: '00000000-0000-0000-0000-000000000040',
};

function compose(args, env) {
  return execFileSync('docker', ['compose', '-f', composeFile, ...args], {
    cwd: projectRoot,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function sql(statement, env) {
  return compose([
    'exec', '-T', 'database', 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-At',
    '-U', env.POSTGRES_USER, '-d', env.POSTGRES_DB, '-c', statement,
  ], env).trim();
}

function sqlResult(statement) {
  return spawnSync('docker', [
    'compose', '-f', composeFile, 'exec', '-T', 'database',
    'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-At',
    '-U', env.POSTGRES_USER, '-d', env.POSTGRES_DB, '-c', statement,
  ], { cwd: projectRoot, env, encoding: 'utf8' });
}

function assertSqlRejected(statement, expectedError) {
  const result = sqlResult(`BEGIN; ${statement}; ROLLBACK;`);
  assert.notEqual(result.status, 0, `SQL unexpectedly accepted:\n${statement}`);
  if (expectedError) assert.match(result.stderr, expectedError);
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

async function fixture() {
  const env = {
    ...process.env,
    APP_PORT: String(await reservePort()),
    COMPOSE_PROJECT_NAME: `stock_opname_schema_${process.pid}`,
    POSTGRES_DB: 'stock_opname_schema_test',
    POSTGRES_USER: 'stock_opname_schema_test',
    POSTGRES_PASSWORD: randomBytes(24).toString('base64url'),
  };
  compose(['up', '-d', '--build', '--wait', '--wait-timeout', '180'], env);
  compose(['exec', '-T', 'app', 'node', 'src/db/migrate.js'], env);
  return env;
}

function cleanup(env) {
  if (!env) return;
  spawnSync('docker', ['compose', '-f', composeFile, 'down', '-v', '--remove-orphans'], {
    cwd: projectRoot,
    env,
    encoding: 'utf8',
  });
}

const typeNames = {
  b: 'bigint', d: 'date', i: 'integer', j: 'jsonb', n: 'numeric',
  t: 'text', u: 'uuid', v: 'character varying', z: 'timestamp with time zone',
};
const schemaContract = {
  audit_logs: 'id:u! timestamp:z! user_id:u action:v! module:v! reference:v details:j!={}',
  auth_sessions: 'id:u! user_id:u! reference:v! secret_hash:v! csrf_secret_hash:v! expires_at:z! last_seen_at:z revoked_at:z created_at:z!',
  backup_logs: 'id:u! backup_type:v! file_name:v! storage_uri:t! size_bytes:b checksum:v status:v created_by:u created_at:z verified_at:z',
  categories: 'id:u! code:v! name:v! status:v created_at:z updated_at:z',
  import_batches: 'id:u! import_type:v file_name:v! file_hash:v! preview_version:b!=1 status:v row_count:i!=0 created_by:u! created_at:z! confirmed_at:z',
  products: 'id:u! code:v! barcode:v name:v! category_id:u! base_unit_id:u! purchase_unit_id:u conversion_factor:n! minimum_stock:n!=0 maximum_stock:n!=0 photo_url:t status:v created_at:z updated_at:z',
  ready_import_rows: 'id:u! import_batch_id:u! row_number:i! file_hash:v! date:d reference:v supplier:v warehouse:v code:v batch:v production_date:d expiry:d quantity:n unit:v price:n notes:t status:v error_code:v error_message:t created_at:z',
  regions: 'id:u! code:v! name:v! status:v created_at:z updated_at:z',
  staging_ocr_lines: 'id:u! import_batch_id:u! file_hash:v! source_pdf:v page:i category:v description_raw:t quantity:n unit_raw:v unit_price:n line_total:n review_status:v notes:t created_by:u created_at:z',
  stock_balances: 'id:u! product_id:u! warehouse_id:u! quantity:n! version:b!=0 updated_at:z',
  stock_batches: 'id:u! product_id:u! warehouse_id:u! batch_number:v production_date:d expiry_date:d quantity:n! unit:v! purchase_price:n!=0 status:v created_at:z updated_at:z',
  stock_opname_items: 'id:u! opname_id:u! product_id:u! batch_id:u system_quantity:n! physical_quantity:n difference:n difference_value:n unit:v! unit_price:n!=0 reason:t notes:t',
  stock_opnames: 'id:u! opname_number:v! warehouse_id:u! opname_date:d! status:v snapshot_at:z! snapshot_version:b! created_by:u! submitted_at:z approved_by:u approved_at:z rejection_reason:t notes:t created_at:z updated_at:z',
  stock_out_requests: 'id:u! idempotency_key:v! request_hash:v! transaction_number:v! transaction_date:d! reference_id:v! product_id:u! warehouse_id:u! quantity:n! unit:v! user_id:u! created_at:z!',
  stock_transactions: "id:u! idempotency_key:v! transaction_number:v! transaction_type:v reference_id:v! product_id:u! warehouse_id:u! batch_id:u supplier_id:u quantity:n! unit:v! balance_before:n! balance_after:n! reason:t user_id:u! created_at:z! transaction_date:d!=CURRENT_DATE request_hash:v!= ledger_sequence:b!=nextval('stock_transactions_ledger_sequence_seq'::regclass) stock_out_request_id:u allocation_index:i unit_price:n",
  suppliers: 'id:u! code:v! name:v! phone:v address:t status:v created_at:z updated_at:z',
  unit_aliases: 'id:u! alias:v! unit_id:u! status:v created_at:z updated_at:z',
  units: 'id:u! code:v! name:v! symbol:v! base_unit_id:u conversion_to_base:n! status:v created_at:z updated_at:z',
  users: 'id:u! name:v! email:v! password_hash:v! role:v status:v created_at:z updated_at:z region_id:u!=00000000-0000-0000-0000-000000000001',
  warehouses: 'id:u! code:v! name:v! location:t status:v created_at:z updated_at:z region_id:u!=00000000-0000-0000-0000-000000000001',
};
const expectedDefinitions = new Map();
const expectedColumns = new Map(Object.entries(schemaContract).map(([table, contract]) => {
  const columns = contract.split(' ').map((entry) => {
    const [, column, type, required, defaultValue] = entry.match(/^(\w+):([bdijntuvz])(!)?(?:=(.*))?$/);
    expectedDefinitions.set(`${table}.${column}`, {
      type: typeNames[type], nullable: required ? 'NO' : 'YES', defaultValue: defaultValue ?? '',
    });
    return column;
  });
  return [table, columns.join(',')];
}));

const expectedForeignKeys = [
  'audit_logs.user_id->users.id', 'auth_sessions.user_id->users.id',
  'backup_logs.created_by->users.id', 'import_batches.created_by->users.id',
  'products.base_unit_id->units.id', 'products.category_id->categories.id',
  'products.purchase_unit_id->units.id', 'ready_import_rows.import_batch_id->import_batches.id',
  'staging_ocr_lines.created_by->users.id', 'staging_ocr_lines.import_batch_id->import_batches.id',
  'stock_balances.product_id->products.id', 'stock_balances.warehouse_id->warehouses.id',
  'stock_batches.product_id->products.id', 'stock_batches.warehouse_id->warehouses.id',
  'stock_out_requests.product_id->products.id', 'stock_out_requests.user_id->users.id',
  'stock_out_requests.warehouse_id->warehouses.id',
  'stock_opname_items.batch_id->stock_batches.id', 'stock_opname_items.opname_id->stock_opnames.id',
  'stock_opname_items.product_id->products.id', 'stock_opnames.approved_by->users.id',
  'stock_opnames.created_by->users.id', 'stock_opnames.warehouse_id->warehouses.id',
  'stock_transactions.batch_id->stock_batches.id', 'stock_transactions.product_id->products.id',
  'stock_transactions.supplier_id->suppliers.id', 'stock_transactions.user_id->users.id',
  'stock_transactions.stock_out_request_id->stock_out_requests.id',
  'stock_transactions.warehouse_id->warehouses.id', 'unit_aliases.unit_id->units.id',
  'units.base_unit_id->units.id', 'users.region_id->regions.id',
  'warehouses.region_id->regions.id',
].sort();

const expectedChecks = [
  'backup_logs_status_check', 'categories_status_check', 'regions_status_check',
  'import_batches_import_type_check', 'import_batches_row_count_check', 'import_batches_status_check',
  'products_conversion_factor_check', 'products_maximum_stock_check',
  'products_minimum_stock_check', 'products_status_check',
  'ready_import_rows_status_check', 'staging_ocr_lines_review_status_check',
  'stock_balances_quantity_check', 'stock_batches_purchase_price_check',
  'stock_batches_quantity_check', 'stock_batches_status_check',
  'stock_opname_items_physical_quantity_check', 'stock_opname_items_system_quantity_check',
  'stock_opnames_status_check', 'stock_out_requests_quantity_check',
  'stock_transactions_balance_after_check', 'stock_transactions_out_allocation_check',
  'stock_transactions_quantity_check', 'stock_transactions_transaction_type_check',
  'suppliers_status_check', 'unit_aliases_status_check', 'units_conversion_to_base_check',
  'units_status_check', 'users_role_check', 'users_status_check', 'warehouses_status_check',
].sort();

const expectedUniques = [
  'auth_sessions_reference_key', 'auth_sessions_secret_hash_key', 'categories_code_key',
  'import_batches_file_hash_import_type_key', 'products_barcode_key', 'products_code_key',
  'ready_import_rows_file_hash_row_number_key', 'regions_code_key',
  'stock_balances_product_id_warehouse_id_key',
  'stock_opnames_opname_number_key', 'stock_out_requests_idempotency_key_key',
  'stock_out_requests_transaction_number_key', 'stock_transactions_idempotency_key_key',
  'suppliers_code_key', 'unit_aliases_alias_key', 'units_code_key', 'users_email_key',
  'warehouses_code_key',
].sort();

const requiredIndexPaths = [
  'audit_logs(module,action)', 'audit_logs(timestamp)',
  'auth_sessions(user_id,expires_at)', 'import_batches(file_hash,import_type)',
  'ready_import_rows(import_batch_id,status)', 'staging_ocr_lines(import_batch_id,review_status)',
  'stock_balances(product_id,warehouse_id)', 'stock_batches(product_id,warehouse_id,expiry_date)',
  'stock_opname_items(opname_id)', 'stock_opnames(warehouse_id,status)',
  'stock_transactions(created_at)', 'stock_transactions(product_id,warehouse_id,created_at)',
  'stock_transactions(ledger_sequence)', 'stock_transactions(reference_id)',
  'stock_transactions(warehouse_id,created_at)',
  'users(region_id)', 'warehouses(region_id)',
].sort();

let env;

before(async () => {
  env = await fixture();
  sql(`
    INSERT INTO users (id, name, email, password_hash, role, status)
      VALUES ('${ids.user}', 'Admin', 'admin@example.test', 'hash', 'ADMIN', 'ACTIVE');
    INSERT INTO categories (id, code, name, status)
      VALUES ('${ids.category}', 'CAT', 'Category', 'ACTIVE');
    INSERT INTO units (id, code, name, symbol, conversion_to_base, status)
      VALUES ('${ids.unit}', 'KG', 'Kilogram', 'kg', 1, 'ACTIVE');
    INSERT INTO products (id, code, name, category_id, base_unit_id, conversion_factor, status)
      VALUES ('${ids.product}', 'P001', 'Product', '${ids.category}', '${ids.unit}', 1, 'ACTIVE');
    INSERT INTO warehouses (id, code, name, status)
      VALUES ('${ids.warehouse}', 'W001', 'Warehouse', 'ACTIVE');
  `, env);
});

after(() => cleanup(env));

test('DB-001 migration creates every required table and column', () => {
  const rows = sql(`
    SELECT table_name || ':' || string_agg(column_name, ',' ORDER BY ordinal_position)
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name <> 'schema_migrations'
    GROUP BY table_name
    ORDER BY table_name
  `, env);
  const actual = new Map(rows.split('\n').filter(Boolean).map((row) => row.split(':')));
  assert.deepEqual(actual, expectedColumns);

  const definitions = sql(`
    SELECT table_name || '.' || column_name || '|' || data_type || '|' || is_nullable || '|' || COALESCE(column_default, '')
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name <> 'schema_migrations'
    ORDER BY table_name, ordinal_position
  `, env).split('\n').filter(Boolean);
  assert.equal(definitions.length, expectedDefinitions.size);
  for (const definition of definitions) {
    const [key, type, nullable, rawDefault] = definition.split('|');
    const defaultValue = rawDefault.replace(/::[a-z ]+$/, '').replace(/^'(.*)'$/, '$1');
    assert.deepEqual(
      { type, nullable, defaultValue }, expectedDefinitions.get(key),
      `definition mismatch for ${key}`,
    );
  }
});

test('DB-003 database rejects negative stock balance insert and update', () => {
  assertSqlRejected(`INSERT INTO stock_balances (id, product_id, warehouse_id, quantity) VALUES ('00000000-0000-0000-0000-000000000101', '${ids.product}', '${ids.warehouse}', -1)`, /stock_balances_quantity_check/);
  assertSqlRejected(`INSERT INTO stock_balances (id, product_id, warehouse_id, quantity) VALUES ('00000000-0000-0000-0000-000000000101', '${ids.product}', '${ids.warehouse}', 0); UPDATE stock_balances SET quantity = -1 WHERE id = '00000000-0000-0000-0000-000000000101'`, /stock_balances_quantity_check/);
});

test('DB-004 database rejects negative stock batch insert and update', () => {
  assertSqlRejected(`INSERT INTO stock_batches (id, product_id, warehouse_id, quantity, unit) VALUES ('00000000-0000-0000-0000-000000000111', '${ids.product}', '${ids.warehouse}', -1, 'KG')`, /stock_batches_quantity_check/);
  assertSqlRejected(`INSERT INTO stock_batches (id, product_id, warehouse_id, quantity, unit) VALUES ('00000000-0000-0000-0000-000000000111', '${ids.product}', '${ids.warehouse}', 0, 'KG'); UPDATE stock_batches SET quantity = -1 WHERE id = '00000000-0000-0000-0000-000000000111'`, /stock_batches_quantity_check/);
});

test('DB-005 database rejects duplicate transaction idempotency key', () => {
  const values = `(gen_random_uuid(), 'same-key', 'TX', 'IN', 'REF', '${ids.product}', '${ids.warehouse}', 1, 'KG', 0, 1, '${ids.user}', now())`;
  assertSqlRejected(`INSERT INTO stock_transactions (id, idempotency_key, transaction_number, transaction_type, reference_id, product_id, warehouse_id, quantity, unit, balance_before, balance_after, user_id, created_at) VALUES ${values}, ${values}`, /stock_transactions_idempotency_key_key/);
});

test('DB-006 database rejects duplicate product and warehouse balance', () => {
  assertSqlRejected(`INSERT INTO stock_balances (id, product_id, warehouse_id, quantity) VALUES (gen_random_uuid(), '${ids.product}', '${ids.warehouse}', 0), (gen_random_uuid(), '${ids.product}', '${ids.warehouse}', 1)`, /stock_balances_product_id_warehouse_id_key/);
});

test('DB-013 stock ledger is immutable after insert', () => {
  sql(`
    INSERT INTO stock_transactions (
      id, idempotency_key, transaction_number, transaction_type, reference_id,
      product_id, warehouse_id, quantity, unit, balance_before, balance_after,
      user_id, created_at
    ) VALUES (
      gen_random_uuid(), 'immutable-key', 'IMMUTABLE-1', 'IN', 'IMMUTABLE',
      '${ids.product}', '${ids.warehouse}', 1, 'KG', 0, 1, '${ids.user}', now()
    )
  `, env);
  assertSqlRejected(
    "UPDATE stock_transactions SET reference_id = 'CHANGED' WHERE idempotency_key = 'immutable-key'",
    /stock_transactions is immutable/,
  );
  assertSqlRejected(
    "DELETE FROM stock_transactions WHERE idempotency_key = 'immutable-key'",
    /stock_transactions is immutable/,
  );
  assertSqlRejected(
    'TRUNCATE stock_transactions',
    /stock_transactions is immutable/,
  );
});

test('DB-014 stock out request header is immutable', () => {
  sql(`
    INSERT INTO stock_out_requests (
      id, idempotency_key, request_hash, transaction_number, transaction_date,
      reference_id, product_id, warehouse_id, quantity, unit, user_id, created_at
    ) VALUES (
      gen_random_uuid(), 'immutable-out', 'hash', 'OUT-IMMUTABLE', CURRENT_DATE,
      'ISSUE', '${ids.product}', '${ids.warehouse}', 1, 'KG', '${ids.user}', now()
    )
  `, env);
  assertSqlRejected(
    "UPDATE stock_out_requests SET reference_id = 'CHANGED' WHERE idempotency_key = 'immutable-out'",
    /stock_out_requests is immutable/,
  );
  assertSqlRejected(
    "DELETE FROM stock_out_requests WHERE idempotency_key = 'immutable-out'",
    /stock_out_requests is immutable/,
  );
  assertSqlRejected('TRUNCATE stock_out_requests CASCADE', /stock_out_requests is immutable/);
});

test('DB-007 database rejects duplicate named batch', () => {
  assertSqlRejected(`INSERT INTO stock_batches (id, product_id, warehouse_id, batch_number, quantity, unit) VALUES (gen_random_uuid(), '${ids.product}', '${ids.warehouse}', 'B1', 0, 'KG'), (gen_random_uuid(), '${ids.product}', '${ids.warehouse}', 'B1', 1, 'KG')`, /stock_batches_named_unique/);
});

test('DB-008 database rejects second NULL batch per product and warehouse', () => {
  assertSqlRejected(`INSERT INTO stock_batches (id, product_id, warehouse_id, batch_number, quantity, unit) VALUES (gen_random_uuid(), '${ids.product}', '${ids.warehouse}', NULL, 0, 'KG'), (gen_random_uuid(), '${ids.product}', '${ids.warehouse}', NULL, 1, 'KG')`, /stock_batches_unbatched_unique/);
});

test('DB-009 database rejects invalid role and opname status', () => {
  assertSqlRejected("INSERT INTO users (id, name, email, password_hash, role, status) VALUES (gen_random_uuid(), 'Invalid', 'invalid@example.test', 'hash', 'OWNER', 'ACTIVE')", /users_role_check/);
  assertSqlRejected(`INSERT INTO stock_opnames (id, opname_number, warehouse_id, opname_date, status, snapshot_at, snapshot_version, created_by) VALUES (gen_random_uuid(), 'OP-INVALID', '${ids.warehouse}', CURRENT_DATE, 'CLOSED', now(), 0, '${ids.user}')`, /stock_opnames_status_check/);
});

test('DB-010 database rejects hard delete of referenced master', () => {
  assertSqlRejected(`DELETE FROM categories WHERE id = '${ids.category}'`, /products_category_id_fkey/);
});

test('DB-001 schema has every foreign key, check, unique, and primary-key constraint', () => {
  const foreignKeys = sql(`
    SELECT tc.table_name || '.' || kcu.column_name || '->' || ccu.table_name || '.' || ccu.column_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name AND tc.constraint_schema = kcu.constraint_schema
    JOIN information_schema.constraint_column_usage ccu
      ON tc.constraint_name = ccu.constraint_name AND tc.constraint_schema = ccu.constraint_schema
    WHERE tc.constraint_schema = 'public' AND tc.constraint_type = 'FOREIGN KEY'
    ORDER BY 1
  `, env).split('\n').filter(Boolean);
  const checks = sql(`
    SELECT conname FROM pg_constraint
    WHERE contype = 'c' AND connamespace = 'public'::regnamespace
      AND conrelid <> 'schema_migrations'::regclass
    ORDER BY conname
  `, env).split('\n').filter(Boolean);
  const uniques = sql(`
    SELECT conname FROM pg_constraint
    WHERE contype = 'u' AND connamespace = 'public'::regnamespace
      AND conrelid <> 'schema_migrations'::regclass
    ORDER BY conname
  `, env).split('\n').filter(Boolean);
  const primaryKeyCount = Number(sql(`
    SELECT count(*) FROM pg_constraint
    WHERE contype = 'p' AND connamespace = 'public'::regnamespace
  `, env));

  assert.deepEqual(foreignKeys, expectedForeignKeys);
  assert.deepEqual(checks, expectedChecks);
  assert.deepEqual(uniques, expectedUniques);
  assert.equal(primaryKeyCount, expectedColumns.size + 1);
});

test('DB-001 schema has every required index path', () => {
  const indexPaths = sql(`
    SELECT table_name || '(' || string_agg(column_name, ',' ORDER BY position) || ')'
    FROM (
      SELECT index_def.indexrelid AS index_oid, table_class.relname AS table_name,
             attribute.attname AS column_name, key.position
      FROM pg_index index_def
      JOIN pg_class table_class ON table_class.oid = index_def.indrelid
      JOIN pg_namespace namespace ON namespace.oid = table_class.relnamespace
      CROSS JOIN LATERAL unnest(index_def.indkey) WITH ORDINALITY AS key(attribute_number, position)
      JOIN pg_attribute attribute
        ON attribute.attrelid = table_class.oid AND attribute.attnum = key.attribute_number
      WHERE namespace.nspname = 'public'
        AND index_def.indisvalid
        AND index_def.indpred IS NULL
    ) indexed_columns
    GROUP BY index_oid, table_name
    ORDER BY table_name, index_oid
  `, env).split('\n').filter(Boolean);

  for (const requiredPath of requiredIndexPaths) {
    assert.ok(indexPaths.includes(requiredPath), `missing required index path: ${requiredPath}`);
  }

  const stockOutIndexes = sql(`
    SELECT indexname || '|' || indexdef
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname IN ('stock_batches_fefo_active_idx', 'stock_transactions_out_allocation_unique')
    ORDER BY indexname
  `, env);
  assert.match(stockOutIndexes, /stock_batches_fefo_active_idx\|.*\(product_id, warehouse_id, expiry_date, production_date, created_at, id\).*WHERE .*ACTIVE.*quantity.*0/);
  assert.match(stockOutIndexes, /stock_transactions_out_allocation_unique\|.*UNIQUE.*\(stock_out_request_id, allocation_index\).*WHERE .*stock_out_request_id IS NOT NULL/);
});

test('DB-011 auth sessions store only secret hashes', () => {
  const columns = sql(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'auth_sessions'
    ORDER BY ordinal_position
  `, env).split('\n').filter(Boolean);

  assert.ok(columns.includes('secret_hash'));
  assert.ok(columns.includes('csrf_secret_hash'));
  assert.ok(!columns.includes('secret'));
  assert.ok(!columns.includes('csrf_secret'));
});

test('DB-012 forward migrations contain no automatic drop, truncate, or reset', () => {
  const migrationsDirectory = `${projectRoot}/db/migrations`;
  for (const fileName of readdirSync(migrationsDirectory).filter((name) => name.endsWith('.sql'))) {
    const sqlText = readFileSync(`${migrationsDirectory}/${fileName}`, 'utf8')
      .replace(/--.*$/gm, '')
      .replace(/\bBEFORE\s+TRUNCATE\s+ON\b/gi, '');
    assert.doesNotMatch(sqlText, /\b(?:DROP|TRUNCATE|RESET)\b/i, fileName);
  }
});

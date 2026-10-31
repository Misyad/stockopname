import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createServer as createTcpServer } from 'node:net';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../..', import.meta.url));
const composeFile = `${projectRoot}/compose.yaml`;

function output(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: projectRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
}

function compose(args, env, options = {}) {
  return output('docker', ['compose', '-f', composeFile, ...args], { env, ...options });
}

function sql(statement, env) {
  return compose([
    'exec', '-T', 'database', 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-At',
    '-U', env.POSTGRES_USER, '-d', env.POSTGRES_DB, '-c', statement,
  ], env).trim();
}

function applyMigration(fileName, env) {
  return compose([
    'exec', '-T', 'database', 'psql', '-X', '-v', 'ON_ERROR_STOP=1',
    '-U', env.POSTGRES_USER, '-d', env.POSTGRES_DB,
  ], env, {
    input: `BEGIN;\n${readFileSync(`${projectRoot}/db/migrations/${fileName}`, 'utf8')}\nCOMMIT;`,
    stdio: ['pipe', 'pipe', 'pipe'],
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

async function fixture() {
  const env = {
    ...process.env,
    APP_PORT: String(await reservePort()),
    COMPOSE_PROJECT_NAME: `stock_opname_migrate_${process.pid}`,
    POSTGRES_DB: 'stock_opname_migrate_test',
    POSTGRES_USER: 'stock_opname_migrate_test',
    POSTGRES_PASSWORD: randomBytes(24).toString('base64url'),
  };
  compose(['up', '-d', '--build', '--wait', '--wait-timeout', '180'], env);
  return env;
}

async function waitForAdvisoryLock(env) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (sql("SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND granted", env) === '1') return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('advisory lock was not acquired');
}

function cleanup(env) {
  if (!env) return;
  spawnSync('docker', ['compose', '-f', composeFile, 'down', '-v', '--remove-orphans'], {
    cwd: projectRoot,
    env,
    encoding: 'utf8',
  });
}

test('DB-002 clean database migrates once and rerun changes nothing', { timeout: 240_000 }, async () => {
  assert.ok(existsSync(composeFile), 'compose.yaml must exist');
  let env;
  try {
    env = await fixture();

    const firstRun = compose(['exec', '-T', 'app', 'node', 'src/db/migrate.js'], env);
    assert.match(firstRun, /Applied 10 migrations/);

    const firstState = sql(
      "SELECT version || '|' || name || '|' || checksum || '|' || applied_at FROM schema_migrations ORDER BY version",
      env,
    );
    assert.match(
      firstState,
      /^1\|001_schema_migrations\.sql\|[0-9a-f]{64}\|.+\n2\|002_initial_schema\.sql\|[0-9a-f]{64}\|.+\n3\|003_regions_and_transaction_idempotency\.sql\|[0-9a-f]{64}\|.+\n4\|004_stock_transaction_order\.sql\|[0-9a-f]{64}\|.+\n5\|005_immutable_stock_ledger\.sql\|[0-9a-f]{64}\|.+\n6\|006_stock_out_requests\.sql\|[0-9a-f]{64}\|.+\n7\|007_inventory_read_indexes\.sql\|[0-9a-f]{64}\|.+\n8\|008_import_confirmation_idempotency\.sql\|[0-9a-f]{64}\|.+\n9\|009_backup_restore_evidence\.sql\|[0-9a-f]{64}\|.+\n10\|010_backup_retention_integrity\.sql\|[0-9a-f]{64}\|.+$/,
    );

    const secondRun = compose(['exec', '-T', 'app', 'node', 'src/db/migrate.js'], env);
    assert.match(secondRun, /Applied 0 migrations/);
    assert.equal(sql(
      "SELECT version || '|' || name || '|' || checksum || '|' || applied_at FROM schema_migrations ORDER BY version",
      env,
    ), firstState);
  } finally {
    cleanup(env);
  }
});

test('changed applied migration checksum is rejected', { timeout: 240_000 }, async () => {
  let env;
  try {
    env = await fixture();
    compose(['exec', '-T', 'app', 'node', 'src/db/migrate.js'], env);
    sql("UPDATE schema_migrations SET checksum = repeat('0', 64) WHERE version = 1", env);

    const result = spawnSync(
      'docker',
      ['compose', '-f', composeFile, 'exec', '-T', 'app', 'node', 'src/db/migrate.js'],
      { cwd: projectRoot, env, encoding: 'utf8' },
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Migration checksum mismatch: 001_schema_migrations\.sql/);
  } finally {
    cleanup(env);
  }
});

test('ledger order migration rejects invalid history and follows the balance chain', { timeout: 240_000 }, async () => {
  let env;
  try {
    env = await fixture();
    for (const fileName of [
      '001_schema_migrations.sql',
      '002_initial_schema.sql',
      '003_regions_and_transaction_idempotency.sql',
    ]) applyMigration(fileName, env);
    sql(`
      INSERT INTO users (id, name, email, password_hash, role, status)
        VALUES ('00000000-0000-0000-0000-000000000001', 'Admin', 'migration@example.test', 'hash', 'ADMIN', 'ACTIVE');
      INSERT INTO categories (id, code, name, status)
        VALUES ('00000000-0000-0000-0000-000000000010', 'MIG', 'Migration', 'ACTIVE');
      INSERT INTO units (id, code, name, symbol, conversion_to_base, status)
        VALUES ('00000000-0000-0000-0000-000000000020', 'KG', 'Kilogram', 'kg', 1, 'ACTIVE');
      INSERT INTO products (id, code, name, category_id, base_unit_id, conversion_factor, status)
        VALUES ('00000000-0000-0000-0000-000000000030', 'MIG-P', 'Migration Product', '00000000-0000-0000-0000-000000000010', '00000000-0000-0000-0000-000000000020', 1, 'ACTIVE');
      INSERT INTO warehouses (id, code, name, status)
        VALUES ('00000000-0000-0000-0000-000000000040', 'MIG-W', 'Migration Warehouse', 'ACTIVE');
      INSERT INTO stock_transactions (
        id, idempotency_key, transaction_number, transaction_type, reference_id,
        product_id, warehouse_id, quantity, unit, balance_before, balance_after, user_id, created_at
      ) VALUES (
        gen_random_uuid(), 'invalid-chain', 'INVALID', 'IN', 'INVALID',
        '00000000-0000-0000-0000-000000000030', '00000000-0000-0000-0000-000000000040',
        1, 'KG', 5, 6, '00000000-0000-0000-0000-000000000001', now()
      )
    `, env);
    const invalid = spawnSync(
      'docker',
      ['compose', '-f', composeFile, 'exec', '-T', 'database', 'psql', '-X', '-v', 'ON_ERROR_STOP=1',
       '-U', env.POSTGRES_USER, '-d', env.POSTGRES_DB],
      {
        cwd: projectRoot,
        env,
        encoding: 'utf8',
        input: `BEGIN;\n${readFileSync(`${projectRoot}/db/migrations/004_stock_transaction_order.sql`, 'utf8')}\nCOMMIT;`,
      },
    );
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /Cannot establish stock ledger order/);
    assert.equal(sql("SELECT to_regclass('stock_transactions_ledger_sequence_seq') IS NULL", env), 't');

    sql(`
      DELETE FROM stock_transactions;
      INSERT INTO stock_transactions (
        id, idempotency_key, transaction_number, transaction_type, reference_id,
        product_id, warehouse_id, quantity, unit, balance_before, balance_after, user_id, created_at
      ) VALUES
        ('00000000-0000-0000-0000-000000000103', 'chain-3', 'CHAIN-3', 'IN', 'CHAIN',
         '00000000-0000-0000-0000-000000000030', '00000000-0000-0000-0000-000000000040',
         5, 'KG', 10, 15, '00000000-0000-0000-0000-000000000001', '2026-01-01'),
        ('00000000-0000-0000-0000-000000000102', 'chain-2', 'CHAIN-2', 'IN', 'CHAIN',
         '00000000-0000-0000-0000-000000000030', '00000000-0000-0000-0000-000000000040',
         5, 'KG', 5, 10, '00000000-0000-0000-0000-000000000001', '2026-01-02'),
        ('00000000-0000-0000-0000-000000000101', 'chain-1', 'CHAIN-1', 'OPENING', 'CHAIN',
         '00000000-0000-0000-0000-000000000030', '00000000-0000-0000-0000-000000000040',
         5, 'KG', 0, 5, '00000000-0000-0000-0000-000000000001', '2026-01-03')
    `, env);
    applyMigration('004_stock_transaction_order.sql', env);
    assert.equal(
      sql("SELECT string_agg(transaction_number, ',' ORDER BY ledger_sequence) FROM stock_transactions", env),
      'CHAIN-1,CHAIN-2,CHAIN-3',
    );
  } finally {
    cleanup(env);
  }
});

test('migration runner waits for the database advisory lock', { timeout: 240_000 }, async () => {
  let env;
  let holder;
  try {
    env = await fixture();
    const composeArgs = ['compose', '-f', composeFile];
    holder = spawn('docker', [
      ...composeArgs, 'exec', '-T', 'database', 'psql', '-X', '-v', 'ON_ERROR_STOP=1',
      '-U', env.POSTGRES_USER, '-d', env.POSTGRES_DB,
      '-c', 'SELECT pg_advisory_lock(7309472201); SELECT pg_sleep(2);',
    ], { cwd: projectRoot, env, stdio: ['ignore', 'ignore', 'pipe'] });

    await waitForAdvisoryLock(env);
    assert.equal(holder.exitCode, null, 'lock holder must still be active');

    const startedAt = Date.now();
    const result = spawnSync(
      'docker',
      [...composeArgs, 'exec', '-T', 'app', 'node', 'src/db/migrate.js'],
      { cwd: projectRoot, env, encoding: 'utf8' },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.ok(Date.now() - startedAt >= 1_300, 'runner must wait for advisory lock release');
  } finally {
    holder?.kill();
    cleanup(env);
  }
});

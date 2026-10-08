import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
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

function compose(args, env) {
  return output('docker', ['compose', '-f', composeFile, ...args], { env });
}

function sql(statement, env) {
  return compose([
    'exec', '-T', 'database', 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-At',
    '-U', env.POSTGRES_USER, '-d', env.POSTGRES_DB, '-c', statement,
  ], env).trim();
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
    assert.match(firstRun, /Applied 2 migrations/);

    const firstState = sql(
      "SELECT version || '|' || name || '|' || checksum || '|' || applied_at FROM schema_migrations ORDER BY version",
      env,
    );
    assert.match(
      firstState,
      /^1\|001_schema_migrations\.sql\|[0-9a-f]{64}\|.+\n2\|002_initial_schema\.sql\|[0-9a-f]{64}\|.+$/,
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

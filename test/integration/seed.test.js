import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createServer as createTcpServer } from 'node:net';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../..', import.meta.url));
const composeFile = `${projectRoot}/compose.yaml`;
const seedFile = `${projectRoot}/db/seeds/001_reference.sql`;

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

function seed(env) {
  return compose([
    'exec', '-T', 'database', 'psql', '-X', '-v', 'ON_ERROR_STOP=1',
    '-U', env.POSTGRES_USER, '-d', env.POSTGRES_DB,
  ], env, { input: readFileSync(seedFile), stdio: ['pipe', 'pipe', 'pipe'] });
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
    COMPOSE_PROJECT_NAME: `stock_opname_seed_${process.pid}`,
    POSTGRES_DB: 'stock_opname_seed_test',
    POSTGRES_USER: 'stock_opname_seed_test',
    POSTGRES_PASSWORD: 'seed-test-only-password',
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

function referenceState(env) {
  return sql(`
    SELECT jsonb_build_object(
      'units', (SELECT jsonb_agg(to_jsonb(u) ORDER BY code) FROM units u),
      'aliases', (SELECT jsonb_agg(to_jsonb(a) ORDER BY alias) FROM unit_aliases a),
      'categories', (SELECT jsonb_agg(to_jsonb(c) ORDER BY code) FROM categories c),
      'users', (SELECT jsonb_agg(to_jsonb(u) ORDER BY email) FROM users u)
    )::text
  `, env);
}

const expectedUnits = [
  'DUS|DUS|DUS|1|ACTIVE',
  'GRAM|GRAM|GRAM|1|ACTIVE',
  'KILOGRAM|KILOGRAM|KILOGRAM|1|ACTIVE',
  'PACK|PACK|PACK|1|ACTIVE',
  'PCS|PCS|PCS|1|ACTIVE',
].join('\n');

const expectedAliases = [
  'bii|PCS', 'biji|PCS', 'bji|PCS', 'bks|PACK', 'bungkus|PACK',
  'dos|DUS', 'dus|DUS', 'g|GRAM', 'gram|GRAM', 'kg|KILOGRAM',
  'kilogram|KILOGRAM', 'pack|PACK', 'pak|PACK', 'pcs|PCS',
].join('\n');

test('reference seed is idempotent and contains only approved units and aliases', { timeout: 240_000 }, async () => {
  assert.ok(existsSync(seedFile), 'reference seed must exist');
  let env;
  try {
    env = await fixture();
    sql(`
      INSERT INTO categories (id, code, name, status)
      VALUES ('00000000-0000-0000-0000-000000000001', 'EXISTING', 'Existing', 'ACTIVE')
    `, env);

    seed(env);
    assert.equal(sql(`
      SELECT code || '|' || name || '|' || symbol || '|' || conversion_to_base || '|' || status
      FROM units ORDER BY code
    `, env), expectedUnits);
    assert.equal(sql(`
      SELECT a.alias || '|' || u.code
      FROM unit_aliases a JOIN units u ON u.id = a.unit_id ORDER BY a.alias
    `, env), expectedAliases);
    assert.equal(sql('SELECT count(*) FROM categories', env), '1');
    assert.equal(sql('SELECT count(*) FROM users', env), '0');

    const firstState = referenceState(env);
    seed(env);
    assert.equal(referenceState(env), firstState);
  } finally {
    cleanup(env);
  }
});

const seedSql = existsSync(seedFile) ? readFileSync(seedFile, 'utf8') : '';
test('reference seed has no plaintext admin credential or destructive statement', () => {
  assert.doesNotMatch(seedSql, /\b(?:password|password_hash|INSERT\s+INTO\s+users|DROP|TRUNCATE|DELETE)\b/i);
});

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
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

async function fetchHealth(url) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      return await fetch(url);
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  assert.fail('App health endpoint did not become reachable.');
}

test('Compose starts healthy non-root app and internal PostgreSQL', { timeout: 240_000 }, async () => {
  assert.ok(existsSync(composeFile), 'compose.yaml must exist');

  const port = await reservePort();
  const env = {
    ...process.env,
    APP_PORT: String(port),
    COMPOSE_PROJECT_NAME: `stock_opname_it_${process.pid}`,
    POSTGRES_DB: 'stock_opname_test',
    POSTGRES_USER: 'stock_opname_test',
    POSTGRES_PASSWORD: randomBytes(24).toString('base64url'),
  };

  const config = JSON.parse(compose(['config', '--format', 'json'], env));
  assert.deepEqual(Object.keys(config.services).sort(), ['app', 'database']);
  assert.ok(!config.services.database.ports?.length, 'PostgreSQL must not publish a host port');
  assert.ok(config.volumes?.postgres_data, 'PostgreSQL must use named persistent volume');

  try {
    compose(['up', '-d', '--build', '--wait', '--wait-timeout', '180'], env);

    const response = await fetchHealth(`http://127.0.0.1:${port}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { success: true });

    const appId = compose(['ps', '-q', 'app'], env).trim();
    const databaseId = compose(['ps', '-q', 'database'], env).trim();
    assert.ok(appId && databaseId, 'Both containers must exist');

    for (const id of [appId, databaseId]) {
      assert.equal(output('docker', ['inspect', '--format', '{{.State.Health.Status}}', id]).trim(), 'healthy');
    }

    assert.notEqual(compose(['exec', '-T', 'app', 'id', '-u'], env).trim(), '0', 'App must run non-root');
    assert.match(
      compose(['exec', '-T', 'database', 'pg_isready', '-U', env.POSTGRES_USER, '-d', env.POSTGRES_DB], env),
      /accepting connections/,
    );

    const databasePorts = JSON.parse(output('docker', ['inspect', '--format', '{{json .NetworkSettings.Ports}}', databaseId]));
    assert.ok(Object.values(databasePorts).every((bindings) => bindings === null), 'PostgreSQL host bindings must be empty');

    const mounts = JSON.parse(output('docker', ['inspect', '--format', '{{json .Mounts}}', databaseId]));
    assert.ok(mounts.some((mount) => mount.Type === 'volume' && mount.Destination === '/var/lib/postgresql/data'));
  } finally {
    spawnSync('docker', ['compose', '-f', composeFile, 'down', '-v', '--remove-orphans'], {
      cwd: projectRoot,
      env,
      encoding: 'utf8',
    });
  }
});

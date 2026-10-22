import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer as createTcpServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  const backupRoot = mkdtempSync(join(tmpdir(), 'stock-opname-docker-'));
  const env = {
    ...process.env,
    APP_PORT: String(port),
    COMPOSE_PROJECT_NAME: `stock_opname_it_${process.pid}`,
    POSTGRES_DB: 'stock_opname_test',
    POSTGRES_USER: 'stock_opname_test',
    POSTGRES_PASSWORD: randomBytes(24).toString('base64url'),
    BACKUP_LOCAL_HOST_DIR: `${backupRoot}/local`,
    BACKUP_COPY_HOST_DIR: `${backupRoot}/copy`,
    SECRETS_HOST_DIR: backupRoot,
    GOOGLE_APPLICATION_CREDENTIALS: '/run/secrets/google-drive.json',
  };

  const config = JSON.parse(compose(['config', '--format', 'json'], env));
  assert.deepEqual(Object.keys(config.services).sort(), ['app', 'backup-init', 'database']);
  assert.ok(!config.services.database.ports?.length, 'PostgreSQL must not publish a host port');
  assert.ok(config.volumes?.postgres_data, 'PostgreSQL must use named persistent volume');
  assert.equal(config.services.app.environment.GOOGLE_APPLICATION_CREDENTIALS, '/run/secrets/google-drive.json');
  assert.ok(config.services.app.volumes.some(
    (mount) => mount.target === '/run/secrets' && mount.read_only,
  ), 'Google credential directory must be mounted read-only');

  try {
    compose(['up', '-d', '--build', '--wait', '--wait-timeout', '180'], env);

    const response = await fetchHealth(`http://127.0.0.1:${port}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      success: true,
      data: { app: 'UP', database: 'UP' },
    });

    const appId = compose(['ps', '-q', 'app'], env).trim();
    const databaseId = compose(['ps', '-q', 'database'], env).trim();
    assert.ok(appId && databaseId, 'Both containers must exist');

    for (const id of [appId, databaseId]) {
      assert.equal(output('docker', ['inspect', '--format', '{{.State.Health.Status}}', id]).trim(), 'healthy');
    }

    assert.notEqual(compose(['exec', '-T', 'app', 'id', '-u'], env).trim(), '0', 'App must run non-root');
    compose(['exec', '-T', 'app', 'sh', '-c', [
      'touch /var/backups/stock-opname/write-check',
      'touch /var/backups/stock-opname-copy/write-check',
    ].join(' && ')], env);
    assert.match(
      compose(['exec', '-T', 'database', 'pg_isready', '-U', env.POSTGRES_USER, '-d', env.POSTGRES_DB], env),
      /accepting connections/,
    );

    const databasePorts = JSON.parse(output('docker', ['inspect', '--format', '{{json .NetworkSettings.Ports}}', databaseId]));
    assert.ok(Object.values(databasePorts).every((bindings) => bindings === null), 'PostgreSQL host bindings must be empty');

    const mounts = JSON.parse(output('docker', ['inspect', '--format', '{{json .Mounts}}', databaseId]));
    assert.ok(mounts.some((mount) => mount.Type === 'volume' && mount.Destination === '/var/lib/postgresql/data'));
  } finally {
    spawnSync('docker', [
      'compose', '-f', composeFile, 'run', '--rm', '--no-deps', '--entrypoint', 'sh',
      'backup-init', '-c', 'chmod 0777 /backup /backup-copy',
    ], { cwd: projectRoot, env, encoding: 'utf8' });
    spawnSync('docker', ['compose', '-f', composeFile, 'down', '-v', '--remove-orphans'], {
      cwd: projectRoot,
      env,
      encoding: 'utf8',
    });
    rmSync(backupRoot, { recursive: true, force: true });
  }
});

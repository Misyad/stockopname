import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes, scryptSync } from 'node:crypto';
import { createServer as createTcpServer } from 'node:net';
import { fileURLToPath } from 'node:url';

export const projectRoot = fileURLToPath(new URL('../..', import.meta.url));
const composeFile = `${projectRoot}/compose.yaml`;
export const password = 'correct horse battery staple';
export const userId = '20000000-0000-0000-0000-000000000001';

function compose(args, env) {
  return execFileSync('docker', ['compose', '-f', composeFile, ...args], {
    cwd: projectRoot,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function passwordHash(value) {
  const salt = randomBytes(16);
  const key = scryptSync(value, salt, 64, {
    N: 131_072,
    r: 8,
    p: 1,
    maxmem: 256 * 1024 * 1024,
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

export async function createFixture(name) {
  const port = await reservePort();
  const origin = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env,
    APP_PORT: String(port),
    APP_ORIGIN: origin,
    COMPOSE_PROJECT_NAME: `stock_opname_${name}_${process.pid}`,
    POSTGRES_DB: `stock_opname_${name}_test`,
    POSTGRES_USER: `stock_opname_${name}_test`,
    POSTGRES_PASSWORD: randomBytes(24).toString('base64url'),
  };

  compose(['up', '-d', '--build', '--wait', '--wait-timeout', '180'], env);
  compose(['exec', '-T', 'app', 'node', 'src/db/migrate.js'], env);
  const fixture = {
    env,
    origin,
    sql(statement) {
      return compose([
        'exec', '-T', 'database', 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-At',
        '-U', env.POSTGRES_USER, '-d', env.POSTGRES_DB, '-c', statement,
      ], env).trim();
    },
    async request(path, options = {}) {
      const response = await fetch(`${origin}/api${path}`, options);
      return { response, body: await response.json() };
    },
    async login(email = 'admin@example.test', credential = password, requestOrigin = origin) {
      const result = await fixture.request('/auth/login', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(requestOrigin ? { origin: requestOrigin } : {}),
        },
        body: JSON.stringify({ email, password: credential }),
      });
      return { ...result, cookie: result.response.headers.get('set-cookie') };
    },
    async restartApp() {
      compose(['restart', 'app'], env);
      for (let attempt = 0; attempt < 60; attempt += 1) {
        try {
          const response = await fetch(`${origin}/health`);
          if (response.ok) return;
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      throw new Error('app did not become healthy after restart');
    },
    cleanup() {
      spawnSync('docker', ['compose', '-f', composeFile, 'down', '-v', '--remove-orphans'], {
        cwd: projectRoot,
        env,
        encoding: 'utf8',
      });
    },
  };

  fixture.sql(`
    INSERT INTO users (id, name, email, password_hash, role, status, created_at, updated_at)
    VALUES ('${userId}', 'Admin', 'admin@example.test', '${passwordHash(password)}',
            'ADMIN', 'ACTIVE', now(), now() - interval '1 day')
  `);
  return fixture;
}

export function cookieHeader(cookie) {
  assert.ok(cookie, 'session cookie missing');
  return cookie.split(';', 1)[0];
}

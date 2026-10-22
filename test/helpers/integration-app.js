import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes, scryptSync } from 'node:crypto';
import { createServer as createTcpServer } from 'node:net';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const composeFile = `${root}/compose.yaml`;

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

export function passwordHash(value) {
  const salt = randomBytes(16);
  const key = scryptSync(value, salt, 64, {
    N: 131_072, r: 8, p: 1, maxmem: 256 * 1024 * 1024,
  });
  return `scrypt$131072$8$1$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export function integrationApp(name) {
  let env;
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
  function execApp(script) {
    return compose(['exec', '-T', 'app', 'node', '--input-type=module', '-e', script]).trim();
  }
  async function api(path, options = {}) {
    const response = await fetch(`http://127.0.0.1:${env.APP_PORT}/api${path}`, options);
    const contentType = response.headers.get('content-type') || '';
    const body = contentType.includes('application/json') ? await response.json() : await response.text();
    return { response, body };
  }
  async function login(email, password) {
    const result = await api('/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: env.APP_ORIGIN },
      body: JSON.stringify({ email, password }),
    });
    assert.equal(result.response.status, 200, JSON.stringify(result.body));
    return result.response.headers.get('set-cookie').split(';', 1)[0];
  }
  return {
    get env() { return env; },
    sql,
    execApp,
    api,
    login,
    async start() {
      const port = String(await reservePort());
      env = {
        ...process.env,
        APP_PORT: port,
        APP_ORIGIN: `http://127.0.0.1:${port}`,
        COMPOSE_PROJECT_NAME: `${name}_${process.pid}`,
        POSTGRES_DB: `${name}_test`,
        POSTGRES_USER: `${name}_test`,
        POSTGRES_PASSWORD: randomBytes(24).toString('base64url'),
      };
      compose(['up', '-d', '--build', '--wait', '--wait-timeout', '180']);
      compose(['exec', '-T', 'app', 'node', 'src/db/migrate.js']);
    },
    stop() {
      if (env) compose(['down', '--volumes', '--remove-orphans'], { stdio: 'ignore' });
    },
  };
}

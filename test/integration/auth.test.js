import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomBytes, scryptSync } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { verifyPassword } from '../../src/services/auth.js';
import { createServer as createTcpServer } from 'node:net';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../..', import.meta.url));
const composeFile = `${projectRoot}/compose.yaml`;
const ids = {
  active: '10000000-0000-0000-0000-000000000001',
  inactive: '10000000-0000-0000-0000-000000000002',
};
const password = 'correct horse battery staple';
const newPassword = 'replacement horse battery staple';

function compose(args, env) {
  return execFileSync('docker', ['compose', '-f', composeFile, ...args], {
    cwd: projectRoot,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function sql(statement) {
  return compose([
    'exec', '-T', 'database', 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-At',
    '-U', env.POSTGRES_USER, '-d', env.POSTGRES_DB, '-c', statement,
  ], env).trim();
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

async function request(path, options = {}) {
  const response = await fetch(`http://127.0.0.1:${env.APP_PORT}/api${path}`, options);
  const body = await response.json();
  return { response, body };
}

async function login(email = 'admin@example.test', credential = password) {
  const result = await request('/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: env.APP_ORIGIN },
    body: JSON.stringify({ email, password: credential }),
  });
  return { ...result, cookie: result.response.headers.get('set-cookie') };
}

function sessionSecret(cookie) {
  assert.ok(cookie, 'session cookie missing');
  const match = cookie.match(/^session=([^;]+)/);
  assert.ok(match, `unexpected cookie: ${cookie}`);
  return match[1];
}

function cookieHeader(cookie) {
  return { cookie: cookie.split(';', 1)[0] };
}

function assertUnauthenticated(result) {
  assert.equal(result.response.status, 401);
  assert.equal(result.body.success, false);
  assert.equal(result.body.errorCode, 'UNAUTHENTICATED');
}

function cleanup() {
  if (!env) return;
  spawnSync('docker', ['compose', '-f', composeFile, 'down', '-v', '--remove-orphans'], {
    cwd: projectRoot,
    env,
    encoding: 'utf8',
  });
}

let env;
let firstLogin;

before(async () => {
  const port = await reservePort();
  env = {
    ...process.env,
    APP_PORT: String(port),
    APP_ORIGIN: `http://127.0.0.1:${port}`,
    COMPOSE_PROJECT_NAME: `stock_opname_auth_${process.pid}`,
    POSTGRES_DB: 'stock_opname_auth_test',
    POSTGRES_USER: 'stock_opname_auth_test',
    POSTGRES_PASSWORD: randomBytes(24).toString('base64url'),
  };
  compose(['up', '-d', '--build', '--wait', '--wait-timeout', '180'], env);
  compose(['exec', '-T', 'app', 'node', 'src/db/migrate.js'], env);
  sql(`
    INSERT INTO users (id, name, email, password_hash, role, status, created_at, updated_at)
    VALUES
      ('${ids.active}', 'Admin', 'admin@example.test', '${passwordHash(password)}', 'ADMIN', 'ACTIVE', now(), now() - interval '1 day'),
      ('${ids.inactive}', 'Inactive', 'inactive@example.test', '${passwordHash(password)}', 'PETUGAS', 'INACTIVE', now(), now() - interval '1 day');
  `);
});

after(cleanup);

test('AUTH-011 uses approved native scrypt parameters and rejects malformed hashes', async () => {
  const file = `${projectRoot}/src/services/auth.js`;
  assert.ok(existsSync(file), 'src/services/auth.js must exist');
  const source = readFileSync(file, 'utf8');
  assert.match(source, /scrypt/);
  assert.match(source, /N:\s*131_?072/);
  assert.match(source, /r:\s*8/);
  assert.match(source, /p:\s*1/);
  assert.match(source, /maxmem:\s*256\s*\*\s*1024\s*\*\s*1024/);
  assert.match(source, /timingSafeEqual/);
  assert.equal(await verifyPassword(password, 'not-a-hash'), false);
  assert.equal(await verifyPassword(password, `scrypt$131072$8$1$${Buffer.alloc(15).toString('base64url')}$${Buffer.alloc(64).toString('base64url')}`), false);
});

test('AUTH-001, AUTH-008, AUTH-009, AUTH-012 valid login creates hashed session and secure cookie', async () => {
  firstLogin = await login();
  assert.equal(firstLogin.response.status, 200);
  assert.deepEqual(firstLogin.body, {
    success: true,
    data: {
      userId: ids.active,
      email: 'admin@example.test',
      role: 'ADMIN',
      token: firstLogin.body.data?.token,
      license: 'SELF_HOSTED',
    },
    message: 'OK',
  });
  assert.match(firstLogin.body.data.token, /^[0-9a-f-]{36}$/);
  assert.match(firstLogin.cookie, /^session=[^;]+;/);
  assert.match(firstLogin.cookie, /; HttpOnly(?:;|$)/i);
  assert.match(firstLogin.cookie, /; Secure(?:;|$)/i);
  assert.match(firstLogin.cookie, /; SameSite=Lax(?:;|$)/i);
  assert.match(firstLogin.cookie, /; Path=\/(?:;|$)/i);
  assert.match(firstLogin.cookie, /; Max-Age=43200(?:;|$)/i);
  assert.doesNotMatch(firstLogin.cookie, /; Domain=/i);

  const secret = decodeURIComponent(sessionSecret(firstLogin.cookie));
  assert.notEqual(firstLogin.body.data.token, secret);
  const stored = JSON.parse(sql(`
    SELECT json_build_object(
      'reference', reference,
      'secret_hash', secret_hash,
      'expires_in', round(extract(epoch FROM (expires_at - created_at))),
      'idle_age', round(extract(epoch FROM (created_at - last_seen_at)))
    ) FROM auth_sessions WHERE reference = '${firstLogin.body.data.token}'
  `));
  assert.equal(stored.reference, firstLogin.body.data.token);
  assert.equal(stored.secret_hash, createHash('sha256').update(secret).digest('hex'));
  assert.equal(stored.expires_in, 43_200);
  assert.equal(stored.idle_age, 0);
  assert.equal(sql(`SELECT count(*) FROM auth_sessions WHERE secret_hash = '${secret}'`), '0');
  assert.equal(sql(`
    SELECT action || '|' || module || '|' || reference || '|' || details::text
    FROM audit_logs WHERE user_id = '${ids.active}' AND action = 'LOGIN'
    ORDER BY timestamp DESC LIMIT 1
  `), `LOGIN|AUTH|${firstLogin.body.data.token}|{}`);

  const bearer = await request('/auth/me', {
    headers: { authorization: `Bearer ${firstLogin.body.data.token}` },
  });
  assertUnauthenticated(bearer);
});

test('AUTH-002 wrong and unknown credentials return same generic error', async () => {
  const wrong = await login('admin@example.test', 'wrong password value');
  const unknown = await login('unknown@example.test', 'wrong password value');
  assert.equal(wrong.response.status, 401);
  assert.equal(unknown.response.status, 401);
  assert.deepEqual(unknown.body, wrong.body);
  assert.equal(wrong.body.errorCode, 'INVALID_CREDENTIALS');
  assert.equal(wrong.cookie, null);
  assert.equal(unknown.cookie, null);
});

test('login rejects malformed, unknown, and oversized input without session', async () => {
  const beforeCount = sql('SELECT count(*) FROM auth_sessions');
  const cases = [
    { body: '{}', contentType: 'text/plain', status: 415, errorCode: 'UNSUPPORTED_MEDIA_TYPE' },
    { body: '{', contentType: 'application/json', status: 400, errorCode: 'INVALID_REQUEST' },
    {
      body: JSON.stringify({ email: 'admin@example.test', password, unexpected: true }),
      contentType: 'application/json',
      status: 400,
      errorCode: 'VALIDATION_ERROR',
    },
    {
      body: JSON.stringify({ email: 'x'.repeat(17_000), password }),
      contentType: 'application/json',
      status: 413,
      errorCode: 'INVALID_REQUEST',
    },
  ];
  for (const entry of cases) {
    const result = await request('/auth/login', {
      method: 'POST',
      headers: { 'content-type': entry.contentType, origin: env.APP_ORIGIN },
      body: entry.body,
    });
    assert.equal(result.response.status, entry.status);
    assert.equal(result.body.errorCode, entry.errorCode);
  }
  assert.equal(sql('SELECT count(*) FROM auth_sessions'), beforeCount);
});

test('AUTH-003 inactive user is denied without creating session', async () => {
  const beforeCount = sql(`SELECT count(*) FROM auth_sessions WHERE user_id = '${ids.inactive}'`);
  const result = await login('inactive@example.test');
  assert.equal(result.response.status, 403);
  assert.equal(result.body.errorCode, 'USER_INACTIVE');
  assert.equal(result.cookie, null);
  assert.equal(sql(`SELECT count(*) FROM auth_sessions WHERE user_id = '${ids.inactive}'`), beforeCount);
});

test('AUTH-004, AUTH-005 missing, expired, idle, and revoked sessions return 401', async () => {
  assertUnauthenticated(await request('/auth/me'));

  for (const mutation of [
    "expires_at = now() - interval '1 second'",
    "last_seen_at = now() - interval '31 minutes'",
    'revoked_at = now()',
  ]) {
    const current = await login();
    assert.equal(current.response.status, 200);
    sql(`UPDATE auth_sessions SET ${mutation} WHERE reference = '${current.body.data.token}'`);
    assertUnauthenticated(await request('/auth/me', { headers: cookieHeader(current.cookie) }));
  }
});

test('authenticated profile uses current server-side role', async () => {
  const current = await login();
  const result = await request('/auth/me', { headers: cookieHeader(current.cookie) });
  assert.equal(result.response.status, 200);
  assert.deepEqual(result.body.data, {
    userId: ids.active,
    email: 'admin@example.test',
    role: 'ADMIN',
  });
});

test('AUTH-006 logout revokes server session, clears cookie, and blocks reuse', async () => {
  const current = await login();
  const csrf = await request('/auth/csrf', { headers: cookieHeader(current.cookie) });
  assert.equal(csrf.response.status, 200);
  const result = await request('/auth/logout', {
    method: 'POST',
    headers: {
      ...cookieHeader(current.cookie),
      origin: env.APP_ORIGIN,
      'x-csrf-token': csrf.body.data.csrfToken,
    },
  });
  assert.equal(result.response.status, 200);
  const cleared = result.response.headers.get('set-cookie');
  assert.match(cleared, /^session=;/);
  assert.match(cleared, /; Max-Age=0(?:;|$)/i);
  assert.equal(sql(`SELECT revoked_at IS NOT NULL FROM auth_sessions WHERE reference = '${current.body.data.token}'`), 't');
  assertUnauthenticated(await request('/auth/me', { headers: cookieHeader(current.cookie) }));
});

test('AUTH-007 password and status changes revoke all prior sessions', async () => {
  const beforeCount = Number(sql(`SELECT count(*) FROM auth_sessions WHERE user_id = '${ids.active}' AND revoked_at IS NULL`));
  const first = await login();
  const second = await login();
  assert.equal((await request('/auth/me', { headers: cookieHeader(first.cookie) })).response.status, 200);
  assert.equal((await request('/auth/me', { headers: cookieHeader(second.cookie) })).response.status, 200);
  assert.equal(Number(sql(`SELECT count(*) FROM auth_sessions WHERE user_id = '${ids.active}' AND revoked_at IS NULL`)), beforeCount + 2);

  sql(`UPDATE users SET password_hash = '${passwordHash(newPassword)}', updated_at = now() WHERE id = '${ids.active}'`);
  assertUnauthenticated(await request('/auth/me', { headers: cookieHeader(second.cookie) }));
  assertUnauthenticated(await request('/auth/me', { headers: cookieHeader(first.cookie) }));
  assert.equal(sql(`SELECT count(*) FROM auth_sessions WHERE user_id = '${ids.active}' AND revoked_at IS NULL`), '0');
  assert.equal((await login()).response.status, 401);

  const replacement = await login('admin@example.test', newPassword);
  assert.equal(replacement.response.status, 200);
  sql(`UPDATE users SET status = 'INACTIVE', updated_at = now() WHERE id = '${ids.active}'`);
  assertUnauthenticated(await request('/auth/me', { headers: cookieHeader(replacement.cookie) }));
  assert.equal(sql(`SELECT count(*) FROM auth_sessions WHERE user_id = '${ids.active}' AND revoked_at IS NULL`), '0');
});

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, test } from 'node:test';
import { cookieHeader, createFixture, userId } from './fixture.js';

let fixture;
let cookie;
let csrfToken;

before(async () => {
  fixture = await createFixture('csrf');
  const login = await fixture.login();
  assert.equal(login.response.status, 200);
  cookie = cookieHeader(login.cookie);
  const csrf = await fixture.request('/auth/csrf', { headers: { cookie } });
  assert.equal(csrf.response.status, 200);
  csrfToken = csrf.body.data.csrfToken;
});

after(() => fixture?.cleanup());

function activeSessions() {
  return fixture.sql(`SELECT count(*) FROM auth_sessions WHERE user_id = '${userId}' AND revoked_at IS NULL`);
}

async function logout(headers) {
  return fixture.request('/auth/logout', { method: 'POST', headers });
}

test('GET csrf is authenticated, session-bound, and side-effect free', async () => {
  const before = activeSessions();
  const missing = await fixture.request('/auth/csrf');
  assert.equal(missing.response.status, 401);
  assert.match(csrfToken, /^[A-Za-z0-9_-]{43}$/);
  const storedHash = fixture.sql(`SELECT csrf_secret_hash FROM auth_sessions WHERE user_id = '${userId}' AND revoked_at IS NULL ORDER BY created_at LIMIT 1`);
  assert.equal(storedHash, createHash('sha256').update(csrfToken).digest('hex'));
  assert.equal(activeSessions(), before);
});

test('SEC-001 mutation missing CSRF returns 403 without mutation', async () => {
  const before = activeSessions();
  const result = await logout({ cookie, origin: fixture.origin });
  assert.equal(result.response.status, 403);
  assert.equal(result.body.errorCode, 'CSRF_INVALID');
  assert.equal(activeSessions(), before);
});

test('SEC-002 wrong and session-foreign CSRF return 403 without mutation', async () => {
  const other = await fixture.login();
  const otherCookie = cookieHeader(other.cookie);
  const otherCsrf = await fixture.request('/auth/csrf', { headers: { cookie: otherCookie } });
  const before = activeSessions();

  for (const token of ['wrong-token', otherCsrf.body.data.csrfToken]) {
    const result = await logout({ cookie, origin: fixture.origin, 'x-csrf-token': token });
    assert.equal(result.response.status, 403);
    assert.equal(result.body.errorCode, 'CSRF_INVALID');
  }
  assert.equal(activeSessions(), before);
});

test('SEC-003 missing and foreign Origin return 403 without mutation', async () => {
  const before = activeSessions();
  for (const origin of [undefined, 'https://evil.example']) {
    const headers = { cookie, 'x-csrf-token': csrfToken };
    if (origin) headers.origin = origin;
    const result = await logout(headers);
    assert.equal(result.response.status, 403);
    assert.equal(result.body.errorCode, 'ORIGIN_INVALID');
  }
  assert.equal(activeSessions(), before);
});

test('SEC-004 valid cookie, Origin, and CSRF reaches mutation', async () => {
  const result = await logout({ cookie, origin: fixture.origin, 'x-csrf-token': csrfToken });
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  assert.equal(activeSessions(), '1');
});

test('SEC-005 GET endpoints do not accept mutation semantics', async () => {
  const current = await fixture.login();
  const currentCookie = cookieHeader(current.cookie);
  const before = activeSessions();
  const result = await fixture.request('/auth/logout', { headers: { cookie: currentCookie } });
  assert.equal(result.response.status, 404);
  assert.equal(activeSessions(), before);
});

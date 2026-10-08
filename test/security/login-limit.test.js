import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createFixture, password } from './fixture.js';

let fixture;

before(async () => {
  fixture = await createFixture('login_limit');
});

after(() => fixture?.cleanup());

async function failures(count, emailFactory = () => 'admin@example.test') {
  const results = [];
  for (let index = 0; index < count; index += 1) {
    results.push(await fixture.login(emailFactory(index), 'wrong password value'));
  }
  return results;
}

test('AUTH-010 normalized email allows five failures then returns bounded 429', async () => {
  const variants = [' ADMIN@example.test ', 'admin@example.test', 'Admin@Example.Test', 'admin@example.test', ' admin@example.test '];
  const attempts = [];
  for (const email of variants) attempts.push(await fixture.login(email, 'wrong password value'));
  assert.deepEqual(attempts.map(({ response }) => response.status), [401, 401, 401, 401, 401]);

  const blocked = await fixture.login('ADMIN@EXAMPLE.TEST', 'wrong password value');
  assert.equal(blocked.response.status, 429);
  assert.equal(blocked.body.errorCode, 'RATE_LIMITED');
  assert.ok(Number.isInteger(blocked.body.details.retryAfterSeconds));
  assert.ok(blocked.body.details.retryAfterSeconds >= 1 && blocked.body.details.retryAfterSeconds <= 900);
  assert.equal(blocked.response.headers.get('retry-after'), String(blocked.body.details.retryAfterSeconds));

  const audit = fixture.sql("SELECT action || ':' || module FROM audit_logs WHERE action = 'LOGIN_RATE_LIMITED'");
  assert.equal(audit, 'LOGIN_RATE_LIMITED:AUTH');
  const serializedAudit = fixture.sql("SELECT details::text FROM audit_logs WHERE action = 'LOGIN_RATE_LIMITED'");
  assert.doesNotMatch(serializedAudit, /wrong password value|correct horse battery staple/i);
});

test('successful login resets normalized-email failures', async () => {
  await fixture.restartApp();
  assert.deepEqual((await failures(4)).map(({ response }) => response.status), [401, 401, 401, 401]);
  assert.equal((await fixture.login(' ADMIN@EXAMPLE.TEST ', password)).response.status, 200);
  assert.deepEqual((await failures(5)).map(({ response }) => response.status), [401, 401, 401, 401, 401]);
  assert.equal((await fixture.login('admin@example.test', 'wrong password value')).response.status, 429);
});

test('IP bucket allows thirty failures across distinct emails then returns 429', async () => {
  await fixture.restartApp();
  const attempts = await failures(30, (index) => `unknown-${index}@example.test`);
  assert.ok(attempts.every(({ response }) => response.status === 401));
  const blocked = await fixture.login('another-unknown@example.test', 'wrong password value');
  assert.equal(blocked.response.status, 429);
  assert.equal(blocked.body.errorCode, 'RATE_LIMITED');
});

test('limiter store remains bounded', async () => {
  const { createLoginLimiter } = await import('../../src/http/middleware/rate-limit.js');
  let now = 0;
  const limiter = createLoginLimiter({ maxEntries: 4, now: () => now });
  for (let index = 0; index < 10; index += 1) {
    const lease = limiter.acquire(`ip-${index}`, `user-${index}@example.test`);
    if (lease.allowed) limiter.failure(lease);
  }
  assert.ok(limiter.size <= 4);
  now = 900_001;
  const fresh = limiter.acquire('fresh-ip', 'fresh@example.test');
  assert.equal(fresh.allowed, true);
  assert.ok(limiter.size <= 4);
});

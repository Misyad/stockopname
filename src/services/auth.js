import { randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { createSession } from '../repositories/sessions.js';

const deriveKey = promisify(scrypt);
const SCRYPT_OPTIONS = {
  N: 131_072,
  r: 8,
  p: 1,
  maxmem: 256 * 1024 * 1024,
};
const FAKE_SALT = Buffer.alloc(16).toString('base64url');
const FAKE_KEY = Buffer.alloc(64).toString('base64url');
const FAKE_HASH = `scrypt$131072$8$1$${FAKE_SALT}$${FAKE_KEY}`;

export async function verifyPassword(password, encodedHash) {
  const [algorithm, n, r, p, saltText, expectedText] = (encodedHash || FAKE_HASH).split('$');
  if (algorithm !== 'scrypt' || Number(n) !== SCRYPT_OPTIONS.N
      || Number(r) !== SCRYPT_OPTIONS.r || Number(p) !== SCRYPT_OPTIONS.p) {
    return false;
  }
  try {
    const salt = Buffer.from(saltText, 'base64url');
    const expected = Buffer.from(expectedText, 'base64url');
    if (salt.length < 16 || expected.length !== 64) return false;
    const actual = await deriveKey(password, salt, 64, SCRYPT_OPTIONS);
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export async function login(pool, rawEmail, password) {
  const email = typeof rawEmail === 'string' ? rawEmail.trim().toLowerCase() : '';
  const credential = typeof password === 'string' ? password : '';
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(`
      SELECT id, email, password_hash, role, status
      FROM users WHERE lower(email) = $1
      FOR UPDATE
    `, [email]);
    const user = result.rows[0];
    const valid = await verifyPassword(credential, user?.password_hash || FAKE_HASH);
    if (!valid) {
      await client.query('ROLLBACK');
      return { error: 'INVALID_CREDENTIALS' };
    }
    if (user.status !== 'ACTIVE') {
      await client.query('ROLLBACK');
      return { error: 'USER_INACTIVE' };
    }
    const session = await createSession(client, user.id);
    await client.query(`
      INSERT INTO audit_logs (id, timestamp, user_id, action, module, reference)
      VALUES ($1, now(), $2, 'LOGIN', 'AUTH', $3)
    `, [randomUUID(), user.id, session.reference]);
    await client.query('COMMIT');
    return {
      session,
      data: {
        userId: user.id,
        email: user.email,
        role: user.role,
        token: session.reference,
        license: 'SELF_HOSTED',
      },
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

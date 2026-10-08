import { createHash, timingSafeEqual } from 'node:crypto';

function digest(value, encoding = 'hex') {
  return createHash('sha256').update(value).digest(encoding);
}

export function csrfTokenForSession(secret) {
  return digest(`csrf:${secret}`, 'base64url');
}

export function validOrigin(request, allowedOrigin) {
  return Boolean(allowedOrigin) && request.headers.origin === allowedOrigin;
}

export async function validCsrf(pool, secret, candidate) {
  if (!secret || typeof candidate !== 'string') return false;
  const expected = csrfTokenForSession(secret);
  const actualBuffer = Buffer.from(candidate);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length
      || !timingSafeEqual(actualBuffer, expectedBuffer)) return false;

  const result = await pool.query(`
    SELECT 1 FROM auth_sessions
    WHERE secret_hash = $1 AND csrf_secret_hash = $2 AND revoked_at IS NULL
  `, [digest(secret), digest(expected)]);
  return result.rowCount === 1;
}

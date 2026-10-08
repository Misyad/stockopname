import { createHash, randomBytes, randomUUID } from 'node:crypto';

const ABSOLUTE_SECONDS = 12 * 60 * 60;

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

export async function createSession(client, userId) {
  const id = randomUUID();
  const reference = randomUUID();
  const secret = randomBytes(32).toString('base64url');
  const csrfSecret = randomBytes(32).toString('base64url');
  await client.query(`
    INSERT INTO auth_sessions (
      id, user_id, reference, secret_hash, csrf_secret_hash,
      expires_at, last_seen_at, created_at
    ) VALUES ($1, $2, $3, $4, $5, now() + interval '12 hours', now(), now())
  `, [id, userId, reference, digest(secret), digest(csrfSecret)]);
  return { reference, secret, maxAge: ABSOLUTE_SECONDS };
}

export async function resolveSession(pool, secret) {
  if (!secret) return null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(`
      SELECT sessions.id, sessions.user_id, sessions.created_at,
             users.email, users.role, users.status,
             now() >= sessions.expires_at AS absolute_expired,
             COALESCE(sessions.last_seen_at, sessions.created_at)
               <= now() - interval '30 minutes' AS idle_expired,
             users.updated_at > sessions.created_at AS user_changed
      FROM auth_sessions sessions
      JOIN users ON users.id = sessions.user_id
      WHERE sessions.secret_hash = $1 AND sessions.revoked_at IS NULL
      FOR UPDATE OF sessions
    `, [digest(secret)]);
    const session = result.rows[0];
    if (!session) {
      await client.query('COMMIT');
      return null;
    }
    if (session.status !== 'ACTIVE' || session.user_changed) {
      await client.query(
        'UPDATE auth_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL',
        [session.user_id],
      );
      await client.query('COMMIT');
      return null;
    }
    if (session.absolute_expired || session.idle_expired) {
      await client.query('UPDATE auth_sessions SET revoked_at = now() WHERE id = $1', [session.id]);
      await client.query('COMMIT');
      return null;
    }
    await client.query('UPDATE auth_sessions SET last_seen_at = now() WHERE id = $1', [session.id]);
    await client.query('COMMIT');
    return { userId: session.user_id, email: session.email, role: session.role };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function revokeSession(pool, secret) {
  if (!secret) return false;
  const result = await pool.query(`
    UPDATE auth_sessions
    SET revoked_at = now()
    WHERE secret_hash = $1 AND revoked_at IS NULL
    RETURNING id
  `, [digest(secret)]);
  return result.rowCount === 1;
}

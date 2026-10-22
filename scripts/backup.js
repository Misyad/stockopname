import { fileURLToPath } from 'node:url';
import { pool } from '../src/db/pool.js';
import { createBackup } from '../src/services/backup.js';

export async function main() {
  const userId = process.env.BACKUP_USER_ID;
  if (!userId) throw Object.assign(new Error('BACKUP_USER_ID is required.'), { errorCode: 'BACKUP_USER_REQUIRED' });
  const actor = (await pool.query(
    "SELECT id AS \"userId\", role FROM users WHERE id = $1 AND status = 'ACTIVE'",
    [userId],
  )).rows[0];
  if (!actor) throw Object.assign(new Error('Active backup user not found.'), { errorCode: 'BACKUP_USER_INVALID' });
  return createBackup(pool, actor);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(await main()));
  } catch (error) {
    console.log(JSON.stringify({ status: 'FAIL', errorCode: error.errorCode || 'BACKUP_FAILED' }));
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
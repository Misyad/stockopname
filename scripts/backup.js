import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { pool } from '../src/db/pool.js';
import { createBackup } from '../src/services/backup.js';

export async function runBackup() {
  const actorId = process.env.BACKUP_ACTOR_ID;
  if (!actorId) throw new Error('BACKUP_ACTOR_ID is required.');
  return createBackup(pool, { userId: actorId });
}

if (resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(await runBackup()));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

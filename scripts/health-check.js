import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { pool } from '../src/db/pool.js';
import { detailedHealth } from '../src/services/maintenance.js';

export async function runHealthCheck() {
  const actorId = process.env.HEALTH_ACTOR_ID;
  if (!actorId) throw new Error('HEALTH_ACTOR_ID is required.');
  return detailedHealth(pool, { userId: actorId });
}

if (resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(await runHealthCheck()));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

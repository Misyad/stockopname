import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { pool } from '../src/db/pool.js';
import { verifyRestore } from '../src/services/backup.js';

export async function runRestoreDrill(path) {
  if (!path) throw new Error('Backup path is required.');
  const startedAt = Date.now();
  const evidence = await verifyRestore(path);
  return {
    status: 'VERIFIED',
    restoreDurationMs: Date.now() - startedAt,
    cleanupVerified: evidence.cleanupVerified,
  };
}

if (resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(await runRestoreDrill(process.argv[2])));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

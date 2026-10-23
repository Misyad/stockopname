import { fileURLToPath } from 'node:url';
import { basename, resolve } from 'node:path';
import { pool } from '../src/db/pool.js';
import { verifyRestore } from '../src/services/backup.js';

export async function runRestoreDrill(path) {
  if (!path) throw new Error('Backup path is required.');
  const backups = (await pool.query(`
    SELECT checksum, size_bytes FROM backup_logs
    WHERE file_name = $1 AND status = 'VERIFIED' AND retained
    ORDER BY verified_at DESC
  `, [basename(path)])).rows;
  if (!backups.length) throw new Error('Retained verified backup metadata not found.');
  if (backups.length !== 1) throw new Error('Ambiguous retained backup metadata.');
  const [backup] = backups;
  if (!backup.checksum || backup.size_bytes === null) {
    throw new Error('Retained verified backup metadata is incomplete.');
  }
  const startedAt = Date.now();
  const evidence = await verifyRestore(path, backup.checksum, backup.size_bytes);
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

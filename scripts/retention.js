import { fileURLToPath } from 'node:url';
import { pool } from '../src/db/pool.js';
import { applyRetention } from '../src/services/backup.js';

export async function main() {
  return applyRetention(pool);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(await main()));
  } catch (error) {
    console.log(JSON.stringify({ status: 'FAIL', errorCode: error.errorCode || 'RETENTION_FAILED' }));
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
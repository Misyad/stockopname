import { fileURLToPath } from 'node:url';
import { pool } from '../src/db/pool.js';
import { verifyBackupArchive } from '../src/services/backup.js';

export async function main() {
  if (process.argv[2] !== '--verify' || !process.argv[3]) {
    throw Object.assign(new Error('Usage: restore.js --verify <archive>'), { errorCode: 'RESTORE_ARGUMENT_INVALID' });
  }
  return verifyBackupArchive(process.argv[3]);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify({ status: 'PASS', ...await main() }));
  } catch (error) {
    console.log(JSON.stringify({ status: 'FAIL', errorCode: error.failureCode || error.errorCode || 'RESTORE_FAILED' }));
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
import { pool } from '../src/db/pool.js';
import { detailedHealth } from '../src/services/maintenance.js';

const userId = process.env.HEALTH_CHECK_USER_ID;

try {
  if (!userId) throw Object.assign(new Error('HEALTH_CHECK_USER_ID is required.'), { errorCode: 'CONFIG_INVALID' });
  const result = await detailedHealth(pool, { userId });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status !== 'PASS') process.exitCode = 1;
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    status: 'FAIL',
    errorCode: error.errorCode || 'HEALTH_CHECK_FAILED',
  })}\n`);
  process.exitCode = 1;
} finally {
  await pool.end();
}

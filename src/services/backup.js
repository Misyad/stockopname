import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  copyFile, mkdir, open, readdir, realpath, rename, rm, stat,
} from 'node:fs/promises';
import {
  isAbsolute, join, relative, resolve,
} from 'node:path';
import pg from 'pg';
import { authorize, CAPABILITIES } from '../http/middleware/rbac.js';

const { Client } = pg;
const safeBackupName = /^(daily|weekly|monthly)-[0-9a-fTWZ.-]+\.dump$/;

function backupDirectory() {
  return resolve(process.env.BACKUP_LOCAL_DIR || '/var/backups/stock-opname');
}

function fault(status, errorCode, message) {
  return Object.assign(new Error(message), { status, errorCode, details: {} });
}

async function actorWithCapability(pool, sessionActor, capability) {
  const row = (await pool.query(
    "SELECT id, role, region_id FROM users WHERE id = $1 AND status = 'ACTIVE'",
    [sessionActor?.userId],
  )).rows[0];
  const actor = row ? { userId: row.id, role: row.role, regionId: row.region_id } : null;
  authorize(actor, capability);
  return actor;
}

function databaseOptions(database = null) {
  const url = new URL(process.env.DATABASE_URL);
  return {
    database: database || decodeURIComponent(url.pathname.slice(1)),
    env: {
      ...process.env,
      PGHOST: url.hostname,
      PGPORT: url.port || '5432',
      PGUSER: decodeURIComponent(url.username),
      PGPASSWORD: decodeURIComponent(url.password),
      PGDATABASE: database || decodeURIComponent(url.pathname.slice(1)),
    },
    config: {
      host: url.hostname,
      port: Number(url.port || 5432),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      database: database || decodeURIComponent(url.pathname.slice(1)),
    },
  };
}

function command(program, args, env) {
  return new Promise((resolveCommand, reject) => {
    const child = spawn(program, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout = `${stdout}${chunk}`.slice(-1_048_576); });
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-4096); });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolveCommand(stdout);
      else reject(new Error(`${program} failed (${code}): ${stderr.trim()}`));
    });
  });
}

async function checksum(path) {
  const handle = await open(path, 'r');
  const hash = createHash('sha256');
  try {
    for await (const chunk of handle.createReadStream()) hash.update(chunk);
  } finally {
    await handle.close();
  }
  return hash.digest('hex');
}

async function durableCopy(source, target) {
  const partial = `${target}.partial`;
  await copyFile(source, partial);
  const handle = await open(partial, 'r');
  await handle.sync();
  await handle.close();
  await rename(partial, target);
  if (await checksum(source) !== await checksum(target)) throw new Error('Backup copy checksum mismatch.');
}

function slots(now, id) {
  const date = now.toISOString().slice(0, 10);
  const first = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
  const week = String(Math.ceil((((now - first) / 86_400_000) + first.getUTCDay() + 1) / 7)).padStart(2, '0');
  return [
    `daily-${date}T${now.toISOString().slice(11, 19).replaceAll(':', '-')}-${id}.dump`,
    `weekly-${now.getUTCFullYear()}-W${week}.dump`,
    `monthly-${date.slice(0, 7)}.dump`,
  ];
}

const retentionLimits = Object.freeze({ daily: 7, weekly: 4, monthly: 12 });

function retentionExcess(names, protectedNames = new Set()) {
  return Object.entries(retentionLimits).flatMap(([prefix, limit]) => names
    .filter((name) => name.startsWith(`${prefix}-`) && safeBackupName.test(name))
    .sort().reverse().slice(limit)
    .filter((name) => !protectedNames.has(name)));
}

async function localRetention(directory, protectedNames = new Set()) {
  const names = await readdir(directory);
  for (const name of retentionExcess(names, protectedNames)) await rm(join(directory, name));
}

async function copyRemote(path, names) {
  const copyDirectory = process.env.BACKUP_COPY_DIR;
  if (copyDirectory) {
    await mkdir(copyDirectory, { recursive: true });
    for (const name of names) await durableCopy(path, join(copyDirectory, name));
    await localRetention(copyDirectory, new Set(names));
    return `file://${resolve(copyDirectory)}/${names[0]}`;
  }
  const folder = process.env.GOOGLE_DRIVE_FOLDER_ID;
  const credential = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!folder || !credential) throw new Error('Google Drive backup credentials are not configured.');
  const env = {
    ...process.env,
    RCLONE_CONFIG_STOCK_TYPE: 'drive',
    RCLONE_CONFIG_STOCK_ROOT_FOLDER_ID: folder,
    RCLONE_CONFIG_STOCK_SERVICE_ACCOUNT_FILE: credential,
  };
  for (const name of names) await command('rclone', ['copyto', path, `stock:${name}`], env);
  const remoteNames = (await command('rclone', ['lsf', 'stock:'], env))
    .split('\n').map((name) => name.trim()).filter(Boolean);
  for (const name of retentionExcess(remoteNames, new Set(names))) {
    await command('rclone', ['deletefile', `stock:${name}`], env);
  }
  return `gdrive://${folder}/${names[0]}`;
}

async function verifyDatabase(config) {
  const client = new Client(config);
  await client.connect();
  try {
    const row = (await client.query(`
      WITH ordered AS (
        SELECT product_id, warehouse_id, quantity, balance_before, balance_after,
          lag(balance_after) OVER (PARTITION BY product_id, warehouse_id ORDER BY ledger_sequence) AS previous
        FROM stock_transactions
      ), ledger AS (
        SELECT product_id, warehouse_id, sum(quantity) AS quantity,
          bool_and(balance_after = balance_before + quantity AND
            CASE WHEN previous IS NULL THEN balance_before = 0 ELSE balance_before = previous END) AS valid
        FROM ordered GROUP BY product_id, warehouse_id
      ), batches AS (
        SELECT product_id, warehouse_id, sum(quantity) AS quantity
        FROM stock_batches GROUP BY product_id, warehouse_id
      ), keys AS (
        SELECT product_id, warehouse_id FROM ledger
        UNION SELECT product_id, warehouse_id FROM stock_balances
        UNION SELECT product_id, warehouse_id FROM batches
      )
      SELECT
        (SELECT count(*) FROM stock_balances WHERE quantity < 0) AS negative_balances,
        (SELECT count(*) FROM stock_batches WHERE quantity < 0) AS negative_batches,
        (SELECT count(*) FROM keys
          LEFT JOIN ledger USING (product_id, warehouse_id)
          LEFT JOIN stock_balances USING (product_id, warehouse_id)
          WHERE ledger.product_id IS NULL OR stock_balances.product_id IS NULL
            OR NOT ledger.valid OR ledger.quantity IS DISTINCT FROM stock_balances.quantity
        ) AS ledger_mismatches,
        (SELECT count(*) FROM keys
          LEFT JOIN batches USING (product_id, warehouse_id)
          LEFT JOIN stock_balances USING (product_id, warehouse_id)
          WHERE coalesce(batches.quantity, 0) <> coalesce(stock_balances.quantity, 0)
        ) AS batch_mismatches,
        (SELECT count(*) FROM schema_migrations) AS migrations
    `)).rows[0];
    if (Object.entries(row).some(([key, value]) => key !== 'migrations' && Number(value) !== 0)
        || Number(row.migrations) === 0) throw new Error('Restored database failed reconciliation.');
    return row;
  } finally {
    await client.end();
  }
}

async function restorePath(path) {
  if (typeof path !== 'string' || !path.trim()) throw new Error('Invalid backup path.');
  const root = backupDirectory();
  const candidate = resolve(path);
  const child = relative(root, candidate);
  if (!child || child === '..' || child.startsWith('../') || isAbsolute(child)) {
    throw new Error('Invalid backup path.');
  }
  let realRoot;
  let realCandidate;
  try {
    [realRoot, realCandidate] = await Promise.all([realpath(root), realpath(candidate)]);
  } catch {
    throw new Error('Invalid backup path.');
  }
  const realChild = relative(realRoot, realCandidate);
  if (!realChild || realChild === '..' || realChild.startsWith('../') || isAbsolute(realChild)) {
    throw new Error('Invalid backup path.');
  }
  return realCandidate;
}

export async function verifyRestore(path) {
  const file = await restorePath(path);
  await command('pg_restore', ['--list', file], process.env);
  const source = databaseOptions();
  const isolated = `restore_verify_${randomUUID().replaceAll('-', '')}`;
  const admin = new Client({ ...source.config, database: 'postgres' });
  let verification;
  let cleanupVerified = false;
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${isolated}`);
    const target = databaseOptions(isolated);
    await command('pg_restore', ['--no-owner', '--no-privileges', '--dbname', isolated, file], target.env);
    verification = await verifyDatabase(target.config);
  } finally {
    await admin.query(
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1',
      [isolated],
    ).catch(() => {});
    await admin.query(`DROP DATABASE IF EXISTS ${isolated}`);
    cleanupVerified = !(await admin.query(
      'SELECT 1 FROM pg_database WHERE datname = $1', [isolated],
    )).rowCount;
    await admin.end();
  }
  return { ...verification, cleanupVerified };
}

export async function createBackup(pool, sessionActor) {
  const actor = await actorWithCapability(pool, sessionActor, CAPABILITIES.BACKUP);
  const lockClient = await pool.connect();
  let acquired;
  try {
    acquired = (await lockClient.query(
      'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired',
      ['stock-backup'],
    )).rows[0].acquired;
  } catch (error) {
    lockClient.release(error);
    throw error;
  }
  if (!acquired) {
    lockClient.release();
    throw fault(409, 'BACKUP_IN_PROGRESS', 'Another backup is already in progress.');
  }
  try {
    const id = randomUUID();
    const directory = backupDirectory();
    const names = slots(new Date(), id);
    const finalPath = join(directory, names[0]);
    const partial = `${finalPath}.partial`;
    await mkdir(directory, { recursive: true });
    await lockClient.query(`
      INSERT INTO backup_logs (id, backup_type, file_name, storage_uri, status, created_by, created_at)
      VALUES ($1, 'DAILY', $2, $3, 'STARTED', $4, now())
    `, [id, names[0], `file://${finalPath}`, actor.userId]);
    try {
      const database = databaseOptions();
      await command('pg_dump', [
        '--format=custom', '--no-owner', '--no-privileges', '--file', partial, database.database,
      ], database.env);
      const partialHandle = await open(partial, 'r');
      await partialHandle.sync();
      await partialHandle.close();
      await command('pg_restore', ['--list', partial], process.env);
      await rename(partial, finalPath);
      const digest = await checksum(finalPath);
      const size = (await stat(finalPath)).size;
      if (!size) throw new Error('Backup file is empty.');
      const restoreStartedAt = Date.now();
      const restore = await verifyRestore(finalPath);
      const restoreDurationMs = Date.now() - restoreStartedAt;
      if (!restore.cleanupVerified) throw new Error('Isolated restore cleanup was not verified.');
      for (const alias of names.slice(1)) await durableCopy(finalPath, join(directory, alias));
      const remoteUri = await copyRemote(finalPath, names);
      await localRetention(directory, new Set(names));
      await lockClient.query(`
        UPDATE backup_logs SET storage_uri = $2, size_bytes = $3, checksum = $4,
          restore_duration_ms = $5, cleanup_verified = $6,
          status = 'VERIFIED', verified_at = now() WHERE id = $1
      `, [
        id, `${`file://${finalPath}`}|${remoteUri}`, size, digest,
        restoreDurationMs, restore.cleanupVerified,
      ]);
      await lockClient.query(`
        INSERT INTO audit_logs (id, timestamp, user_id, action, module, reference, details)
        VALUES ($1, now(), $2, 'BACKUP_VERIFIED', 'MAINTENANCE', $3, $4::jsonb)
      `, [randomUUID(), actor.userId, id, JSON.stringify({
        fileName: names[0], size, checksum: digest,
        restoreDurationMs, cleanupVerified: restore.cleanupVerified,
      })]);
      return {
        id, fileName: names[0], sizeBytes: size, checksum: digest, status: 'VERIFIED',
        restoreDurationMs, cleanupVerified: restore.cleanupVerified,
      };
    } catch (error) {
      await rm(partial, { force: true }).catch(() => {});
      await lockClient.query(
        "UPDATE backup_logs SET status = 'FAILED' WHERE id = $1", [id],
      ).catch(() => {});
      await lockClient.query(`
        INSERT INTO audit_logs (id, timestamp, user_id, action, module, reference, details)
        VALUES ($1, now(), $2, 'BACKUP_FAILED', 'MAINTENANCE', $3, $4::jsonb)
      `, [randomUUID(), actor.userId, id, JSON.stringify({ errorCode: 'BACKUP_FAILED' })])
        .catch(() => {});
      throw fault(500, 'BACKUP_FAILED', 'Backup or isolated restore verification failed.');
    }
  } finally {
    let unlockError;
    try {
      const unlocked = (await lockClient.query(
        'SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS unlocked', ['stock-backup'],
      )).rows[0].unlocked;
      if (!unlocked) unlockError = new Error('Backup advisory lock release failed.');
    } catch (error) {
      unlockError = error;
    }
    lockClient.release(unlockError);
  }
}

export async function listBackups(pool, sessionActor) {
  await actorWithCapability(pool, sessionActor, CAPABILITIES.BACKUP);
  const rows = (await pool.query(`
    SELECT id, backup_type, file_name, storage_uri, size_bytes, checksum, status,
      restore_duration_ms, cleanup_verified, created_by, created_at, verified_at
    FROM backup_logs ORDER BY created_at DESC LIMIT 100
  `)).rows;
  return rows.map((row) => ({
    id: row.id, backupType: row.backup_type, fileName: row.file_name,
    sizeBytes: row.size_bytes === null ? null : Number(row.size_bytes),
    checksum: row.checksum, status: row.status,
    restoreDurationMs: row.restore_duration_ms === null ? null : Number(row.restore_duration_ms),
    cleanupVerified: row.cleanup_verified, createdBy: row.created_by,
    createdAt: row.created_at, verifiedAt: row.verified_at,
  }));
}

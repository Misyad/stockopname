import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, realpath, rename, rm, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import pg from 'pg';
import { authorize, CAPABILITIES } from '../http/middleware/rbac.js';
import { migrationManifest } from './maintenance.js';

const { Client } = pg;
const backupLockKey = '7309472202';

function fault(status, errorCode, message) {
  return Object.assign(new Error(message), { status, errorCode });
}

function safeConfig() {
  const localDir = process.env.BACKUP_LOCAL_DIR;
  const remote = process.env.BACKUP_REMOTE?.replace(/\/+$/, '');
  const databaseUrl = process.env.DATABASE_URL;
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  if (!localDir || !remote || !databaseUrl || !adminUrl) {
    throw fault(503, 'BACKUP_NOT_CONFIGURED', 'Backup runtime is not configured.');
  }
  return { localDir, remote, databaseUrl, adminUrl };
}

function pgEnvironment(connectionString, databaseName) {
  const url = new URL(connectionString);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.username) {
    throw fault(503, 'BACKUP_NOT_CONFIGURED', 'Backup database configuration is invalid.');
  }
  return {
    ...process.env,
    PGHOST: url.hostname,
    PGPORT: url.port || '5432',
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: databaseName || decodeURIComponent(url.pathname.slice(1)),
  };
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: options.env || process.env,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4096); });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve();
      else reject(Object.assign(new Error(`${command} exited ${code}`), { command, stderr }));
    });
  });
}

async function fileHash(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function streamHash(command, args) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stdout.on('data', (chunk) => hash.update(chunk));
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4096); });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve(hash.digest('hex'));
      else reject(Object.assign(new Error(`${command} exited ${code}`), { command, stderr }));
    });
  });
}

function databaseUrl(base, databaseName) {
  const url = new URL(base);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

async function verifyRestoredDatabase(connectionString) {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    const expected = await migrationManifest();
    const applied = await client.query('SELECT version, name, checksum FROM schema_migrations ORDER BY version');
    assertRecovery(
      applied.rows.length === expected.length
      && expected.every((item, index) => Number(applied.rows[index].version) === item.version
        && applied.rows[index].name === item.name && applied.rows[index].checksum === item.checksum),
      'RESTORE_SCHEMA_MISMATCH',
    );
    const result = await client.query(`
      WITH ordered_ledger AS (
        SELECT product_id, warehouse_id, quantity, balance_before, balance_after,
          lag(balance_after) OVER (
            PARTITION BY product_id, warehouse_id ORDER BY ledger_sequence
          ) AS previous_balance
        FROM stock_transactions
      ), ledger AS (
        SELECT product_id, warehouse_id, count(*)::int AS row_count, sum(quantity) AS quantity,
          bool_and(balance_after = balance_before + quantity AND balance_after >= 0 AND CASE
            WHEN previous_balance IS NULL THEN balance_before = 0
            ELSE balance_before = previous_balance END) AS valid
        FROM ordered_ledger GROUP BY product_id, warehouse_id
      ), balances AS (
        SELECT product_id, warehouse_id, count(*)::int AS row_count, sum(quantity) AS quantity
        FROM stock_balances GROUP BY product_id, warehouse_id
      ), batches AS (
        SELECT product_id, warehouse_id, count(*)::int AS row_count, sum(quantity) AS quantity
        FROM stock_batches GROUP BY product_id, warehouse_id
      ), keys AS (
        SELECT product_id, warehouse_id FROM ledger
        UNION SELECT product_id, warehouse_id FROM balances
        UNION SELECT product_id, warehouse_id FROM batches
      )
      SELECT count(*)::int AS issues FROM keys
      LEFT JOIN ledger USING (product_id, warehouse_id)
      LEFT JOIN balances USING (product_id, warehouse_id)
      LEFT JOIN batches USING (product_id, warehouse_id)
      WHERE ledger.row_count IS NULL OR balances.row_count IS DISTINCT FROM 1
        OR batches.row_count IS NULL OR NOT coalesce(ledger.valid, false)
        OR ledger.quantity IS DISTINCT FROM balances.quantity
        OR ledger.quantity IS DISTINCT FROM batches.quantity
    `);
    assertRecovery(result.rows[0].issues === 0, 'RESTORE_RECONCILIATION_FAILED');
  } finally {
    await client.end();
  }
}

function assertRecovery(condition, code) {
  if (!condition) throw Object.assign(new Error(code), { failureCode: code });
}

async function isolatedRestore(config, archive) {
  const name = `stock_restore_${randomUUID().replaceAll('-', '')}`;
  const admin = new Client({ connectionString: config.adminUrl });
  const started = Date.now();
  let created = false;
  let recoveryError;
  await admin.connect();
  try {
    await run('pg_restore', ['--list', archive]);
    await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
    created = true;
    await run('pg_restore', ['--no-owner', '--no-privileges', '--dbname', name, archive], {
      env: pgEnvironment(config.adminUrl, name),
    });
    await verifyRestoredDatabase(databaseUrl(config.adminUrl, name));
  } catch (error) {
    recoveryError = error;
  } finally {
    if (created) {
      try {
        await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
        const remaining = await admin.query('SELECT count(*)::int AS count FROM pg_database WHERE datname = $1', [name]);
        assertRecovery(remaining.rows[0].count === 0, 'RESTORE_CLEANUP_FAILED');
      } catch (error) {
        recoveryError ||= Object.assign(error, { failureCode: 'RESTORE_CLEANUP_FAILED' });
      }
    }
    await admin.end();
  }
  if (recoveryError) throw recoveryError;
  return Date.now() - started;
}

export async function verifyBackupArchive(archive) {
  const config = safeConfig();
  const root = await realpath(resolve(config.localDir)).catch(() => null);
  const candidate = await realpath(resolve(archive)).catch(() => null);
  if (!root || !candidate || !candidate.startsWith(`${root}${sep}`)) {
    throw fault(400, 'RESTORE_PATH_INVALID', 'Restore archive must be inside backup directory.');
  }
  const archiveStat = await stat(candidate).catch(() => null);
  if (!archiveStat?.isFile() || archiveStat.size === 0) {
    throw fault(400, 'RESTORE_ARCHIVE_INVALID', 'Restore archive is unavailable.');
  }
  return { restoreDurationMs: await isolatedRestore(config, candidate) };
}

function publicBackup(row) {
  return {
    id: row.id,
    backupType: row.backup_type,
    fileName: row.file_name,
    sizeBytes: Number(row.size_bytes),
    checksum: row.checksum,
    status: row.status,
    createdAt: row.created_at,
    verifiedAt: row.verified_at,
    restoreDurationMs: row.restore_duration_ms === null ? null : Number(row.restore_duration_ms),
  };
}

function periodKeys(value) {
  const date = new Date(value);
  const day = date.toISOString().slice(0, 10);
  const month = day.slice(0, 7);
  const thursday = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  thursday.setUTCDate(thursday.getUTCDate() + 4 - (thursday.getUTCDay() || 7));
  const year = thursday.getUTCFullYear();
  const week = Math.ceil((((thursday - Date.UTC(year, 0, 1)) / 86_400_000) + 1) / 7);
  return { day, week: `${year}-W${String(week).padStart(2, '0')}`, month };
}

function selectSlots(rows, key, limit) {
  const selected = [];
  const periods = new Set();
  for (const row of rows) {
    const period = periodKeys(row.verified_at)[key];
    if (periods.has(period)) continue;
    periods.add(period);
    selected.push(row);
    if (selected.length === limit) break;
  }
  return selected;
}

export async function applyRetention(pool) {
  const config = safeConfig();
  const lock = await pool.connect();
  let locked = false;
  try {
    locked = (await lock.query(
      'SELECT pg_try_advisory_lock($1::bigint) AS acquired', [backupLockKey],
    )).rows[0].acquired;
    if (!locked) throw fault(409, 'BACKUP_BUSY', 'Backup or retention is in progress.');
    const rows = (await lock.query(`
      SELECT id, file_name, verified_at FROM backup_logs
      WHERE retained AND status = 'VERIFIED' AND NOT pinned AND verified_at IS NOT NULL
      ORDER BY verified_at DESC, id DESC
    `)).rows;
    const daily = selectSlots(rows, 'day', 7);
    const weekly = selectSlots(rows, 'week', 4);
    const monthly = selectSlots(rows, 'month', 12);
    const keep = new Set([...daily, ...weekly, ...monthly].map((row) => row.id));
    const discard = rows.filter((row) => !keep.has(row.id));
    for (const row of discard) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(row.file_name)) {
        throw fault(500, 'RETENTION_FILE_INVALID', 'Backup metadata contains invalid file name.');
      }
      await run('rclone', ['deletefile', `${config.remote}/${row.file_name}`]);
      await rm(join(config.localDir, row.file_name), { force: true });
      await lock.query('UPDATE backup_logs SET retained = false WHERE id = $1', [row.id]);
    }
    return {
      daily: daily.length,
      weekly: weekly.length,
      monthly: monthly.length,
      retained: keep.size,
      pruned: discard.length,
    };
  } finally {
    if (locked) await lock.query('SELECT pg_advisory_unlock($1::bigint)', [backupLockKey]).catch(() => {});
    lock.release();
  }
}

export async function listBackups(pool, actor) {
  authorize(actor, CAPABILITIES.BACKUP);
  const result = await pool.query(`
    SELECT id, backup_type, file_name, size_bytes, checksum, status, created_at,
      verified_at, restore_duration_ms
    FROM backup_logs WHERE retained ORDER BY created_at DESC, id DESC LIMIT 100
  `);
  return { items: result.rows.map(publicBackup) };
}

export async function createBackup(pool, actor) {
  authorize(actor, CAPABILITIES.BACKUP);
  const config = safeConfig();
  const lock = await pool.connect();
  const id = randomUUID();
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, '');
  const fileName = `stock-opname-${stamp}-${randomUUID().replaceAll('-', '')}.dump`;
  const partial = join(config.localDir, `${fileName}.partial`);
  const final = join(config.localDir, fileName);
  const remotePartial = `${config.remote}/${fileName}.partial`;
  const remoteFinal = `${config.remote}/${fileName}`;
  let inserted = false;
  try {
    const acquired = await lock.query('SELECT pg_try_advisory_lock($1::bigint) AS acquired', [backupLockKey]);
    if (!acquired.rows[0].acquired) throw fault(409, 'BACKUP_BUSY', 'Another backup is in progress.');
    await mkdir(config.localDir, { recursive: true, mode: 0o700 });
    await lock.query(`
      INSERT INTO backup_logs (
        id, backup_type, file_name, storage_uri, independent_storage_uri,
        status, created_by, created_at
      ) VALUES ($1, 'DAILY', $2, $3, $4, 'STARTED', $5, now())
    `, [id, fileName, final, remoteFinal, actor.userId]);
    inserted = true;
    await run('pg_dump', ['--format=custom', '--no-owner', '--no-privileges', '--file', partial], {
      env: pgEnvironment(config.databaseUrl),
    });
    const handle = await open(partial, 'r');
    await handle.sync();
    await handle.close();
    await rename(partial, final);
    const checksum = await fileHash(final);
    const sizeBytes = (await stat(final)).size;
    const { restoreDurationMs } = await verifyBackupArchive(final);
    await run('rclone', ['copyto', final, remotePartial]);
    await run('rclone', ['moveto', remotePartial, remoteFinal]);
    assertRecovery(await streamHash('rclone', ['cat', remoteFinal]) === checksum, 'REMOTE_CHECKSUM_MISMATCH');
    const result = await lock.query(`
      UPDATE backup_logs SET size_bytes = $2, checksum = $3, status = 'VERIFIED',
        restore_duration_ms = $4, verified_at = now()
      WHERE id = $1 RETURNING *
    `, [id, sizeBytes, checksum, restoreDurationMs]);
    await lock.query(`
      INSERT INTO audit_logs (id, timestamp, user_id, action, module, reference, details)
      VALUES ($1, now(), $2, 'BACKUP_VERIFIED', 'MAINTENANCE', $3, $4::jsonb)
    `, [randomUUID(), actor.userId, id, JSON.stringify({ sizeBytes, restoreDurationMs })]);
    return publicBackup(result.rows[0]);
  } catch (error) {
    await rm(partial, { force: true }).catch(() => {});
    await run('rclone', ['deletefile', remotePartial]).catch(() => {});
    if (inserted) {
      const failureCode = error.failureCode || error.errorCode || 'BACKUP_EXECUTION_FAILED';
      try {
        await lock.query('BEGIN');
        await lock.query(
          "UPDATE backup_logs SET status = 'FAILED', failure_code = $2 WHERE id = $1",
          [id, failureCode],
        );
        await lock.query(`
          INSERT INTO audit_logs (id, timestamp, user_id, action, module, reference, details)
          VALUES ($1, now(), $2, 'BACKUP_FAILED', 'MAINTENANCE', $3, $4::jsonb)
        `, [randomUUID(), actor.userId, id, JSON.stringify({ failureCode })]);
        await lock.query('COMMIT');
      } catch (metadataError) {
        await lock.query('ROLLBACK').catch(() => {});
        throw Object.assign(metadataError, { errorCode: 'BACKUP_FAILURE_AUDIT_FAILED' });
      }
    }
    if (error.status) throw error;
    throw fault(500, 'BACKUP_FAILED', 'Backup verification failed.');
  } finally {
    const unlocked = await lock.query('SELECT pg_advisory_unlock($1::bigint) AS unlocked', [backupLockKey]).catch(() => null);
    lock.release(unlocked?.rows[0]?.unlocked === false ? new Error('backup_lock_leaked') : undefined);
  }
}
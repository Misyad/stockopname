import assert from 'node:assert/strict';
import {
  chmod, mkdir, readFile, readdir, rm, stat, writeFile,
} from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { integrationApp, passwordHash } from '../helpers/integration-app.js';

const app = integrationApp('stock_backup');
const password = 'correct horse battery staple';
const backupRoot = `/tmp/stock-backup-${process.pid}`;
const ids = {
  region: '74000000-0000-0000-0000-000000000001',
  otherRegion: '74000000-0000-0000-0000-000000000002',
  admin: '74000000-0000-0000-0000-000000000010',
  otherAdmin: '74000000-0000-0000-0000-000000000012',
  supervisor: '74000000-0000-0000-0000-000000000011',
  category: '74000000-0000-0000-0000-000000000020',
  unit: '74000000-0000-0000-0000-000000000021',
  warehouse: '74000000-0000-0000-0000-000000000022',
  product: '74000000-0000-0000-0000-000000000023',
  batch: '74000000-0000-0000-0000-000000000024',
};
let admin;
let otherAdmin;
let supervisor;

async function session(email) {
  const cookie = await app.login(email, password);
  const csrf = await app.api('/auth/csrf', { headers: { cookie } });
  assert.equal(csrf.response.status, 200, JSON.stringify(csrf.body));
  return { cookie, csrf: csrf.body.data.csrfToken };
}

function mutationHeaders(value, csrf = value.csrf) {
  return {
    cookie: value.cookie,
    origin: app.env.APP_ORIGIN,
    'x-csrf-token': csrf,
    'content-type': 'application/json',
  };
}

function createBackup(value = admin, csrf = value.csrf) {
  return app.api('/maintenance/backup', {
    method: 'POST', headers: mutationHeaders(value, csrf), body: '{}',
  });
}

async function seedRetention(directory) {
  for (let index = 1; index <= 9; index += 1) {
    await writeFile(`${directory}/daily-2025-01-${String(index).padStart(2, '0')}T00-00-00.dump`, 'old');
  }
  for (let index = 1; index <= 6; index += 1) {
    await writeFile(`${directory}/weekly-2025-W${String(index).padStart(2, '0')}.dump`, 'old');
  }
  for (let index = 1; index <= 14; index += 1) {
    await writeFile(`${directory}/monthly-2024-${String(index).padStart(2, '0')}.dump`, 'old');
  }
}

before(async () => {
  process.env.BACKUP_LOCAL_HOST_DIR = `${backupRoot}/local`;
  process.env.BACKUP_COPY_HOST_DIR = `${backupRoot}/copy`;
  process.env.BACKUP_COPY_DIR = '/var/backups/stock-opname-copy';
  await Promise.all([
    mkdir(process.env.BACKUP_LOCAL_HOST_DIR, { recursive: true }),
    mkdir(process.env.BACKUP_COPY_HOST_DIR, { recursive: true }),
  ]);
  await Promise.all([
    chmod(process.env.BACKUP_LOCAL_HOST_DIR, 0o777),
    chmod(process.env.BACKUP_COPY_HOST_DIR, 0o777),
    seedRetention(process.env.BACKUP_LOCAL_HOST_DIR),
    seedRetention(process.env.BACKUP_COPY_HOST_DIR),
  ]);
  await app.start();
  app.sql(`
    INSERT INTO regions (id, code, name, status) VALUES
      ('${ids.region}', 'BACKUP-R', 'Backup Region', 'ACTIVE'),
      ('${ids.otherRegion}', 'BACKUP-R2', 'Other Backup Region', 'ACTIVE');
    INSERT INTO users (id, name, email, password_hash, role, status, region_id) VALUES
      ('${ids.admin}', 'Backup Admin', 'backup-admin@example.test', '${passwordHash(password)}', 'ADMIN', 'ACTIVE', '${ids.region}'),
      ('${ids.otherAdmin}', 'Other Backup Admin', 'other-backup-admin@example.test', '${passwordHash(password)}', 'ADMIN', 'ACTIVE', '${ids.otherRegion}'),
      ('${ids.supervisor}', 'Backup Supervisor', 'backup-supervisor@example.test', '${passwordHash(password)}', 'SUPERVISOR', 'ACTIVE', '${ids.region}');
  `);
  admin = await session('backup-admin@example.test');
  otherAdmin = await session('other-backup-admin@example.test');
  supervisor = await session('backup-supervisor@example.test');
});

after(async () => {
  app.stop();
  await rm(backupRoot, { recursive: true, force: true });
});

test('OPS-001/003/006/009 backup is verified and metadata is global across ADMIN regions', async () => {
  const created = await createBackup();
  assert.equal(created.response.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.data.status, 'VERIFIED');
  assert.match(created.body.data.checksum, /^[a-f0-9]{64}$/);
  assert.ok(created.body.data.sizeBytes > 0);
  assert.ok(created.body.data.restoreDurationMs >= 0);
  assert.ok(created.body.data.restoreDurationMs <= 14_400_000);
  assert.equal(created.body.data.cleanupVerified, true);

  const listed = await app.api('/maintenance/backups', { headers: { cookie: admin.cookie } });
  assert.equal(listed.response.status, 200, JSON.stringify(listed.body));
  assert.equal(listed.body.data[0].id, created.body.data.id);
  assert.equal(listed.body.data[0].status, 'VERIFIED');
  assert.equal(listed.body.data[0].retained, true);
  assert.equal(listed.body.data[0].restoreDurationMs, created.body.data.restoreDurationMs);
  assert.equal(listed.body.data[0].cleanupVerified, true);
  assert.equal(Object.hasOwn(listed.body.data[0], 'storageUri'), false);
  const crossRegion = await app.api('/maintenance/backups', {
    headers: { cookie: otherAdmin.cookie },
  });
  assert.equal(crossRegion.response.status, 200, JSON.stringify(crossRegion.body));
  assert.equal(crossRegion.body.data[0].id, created.body.data.id);
  assert.equal(Object.hasOwn(crossRegion.body.data[0], 'storageUri'), false);
  const crossRegionCreated = await createBackup(otherAdmin);
  assert.equal(crossRegionCreated.response.status, 201, JSON.stringify(crossRegionCreated.body));
  assert.equal(crossRegionCreated.body.data.status, 'VERIFIED');
  assert.equal(Object.hasOwn(crossRegionCreated.body.data, 'storageUri'), false);
  assert.equal((await stat(`${backupRoot}/local/${created.body.data.fileName}`)).size, created.body.data.sizeBytes);
  assert.equal((await stat(`${backupRoot}/copy/${created.body.data.fileName}`)).size, created.body.data.sizeBytes);
  assert.match(app.sql(`SELECT storage_uri FROM backup_logs WHERE id = '${created.body.data.id}'`), /^file:\/\/.*\|file:\/\//);
});

test('OPS-003 restore rejects balance and batch keys missing immutable ledger', async () => {
  app.sql(`
    INSERT INTO categories (id, code, name, status)
      VALUES ('${ids.category}', 'BACKUP-CAT', 'Backup Category', 'ACTIVE');
    INSERT INTO units (id, code, name, symbol, conversion_to_base, status)
      VALUES ('${ids.unit}', 'BACKUP-KG', 'Kilogram', 'kg', 1, 'ACTIVE');
    INSERT INTO warehouses (id, code, name, status, region_id)
      VALUES ('${ids.warehouse}', 'BACKUP-WH', 'Backup Warehouse', 'ACTIVE', '${ids.region}');
    INSERT INTO products (
      id, code, name, category_id, base_unit_id, conversion_factor,
      minimum_stock, maximum_stock, status
    ) VALUES (
      '${ids.product}', 'BACKUP-P', 'Backup Product', '${ids.category}', '${ids.unit}',
      1, 0, 100, 'ACTIVE'
    );
    INSERT INTO stock_batches (
      id, product_id, warehouse_id, batch_number, quantity, unit, purchase_price, status
    ) VALUES (
      '${ids.batch}', '${ids.product}', '${ids.warehouse}', NULL, 5, 'BACKUP-KG', 1, 'ACTIVE'
    );
    INSERT INTO stock_balances (id, product_id, warehouse_id, quantity, version)
      VALUES (gen_random_uuid(), '${ids.product}', '${ids.warehouse}', 5, 1);
  `);
  let result;
  try {
    result = await createBackup();
  } finally {
    app.sql(`
      DELETE FROM stock_balances WHERE product_id = '${ids.product}';
      DELETE FROM stock_batches WHERE product_id = '${ids.product}';
      DELETE FROM products WHERE id = '${ids.product}';
      DELETE FROM warehouses WHERE id = '${ids.warehouse}';
      DELETE FROM units WHERE id = '${ids.unit}';
      DELETE FROM categories WHERE id = '${ids.category}';
    `);
  }
  assert.equal(result.response.status, 500, JSON.stringify(result.body));
  assert.equal(result.body.errorCode, 'BACKUP_FAILED');
});

test('OPS-010 concurrent backup fails closed before touching shared artifacts', () => {
  const output = app.execApp(`
    import { pool } from './src/db/pool.js';
    import { createBackup } from './src/services/backup.js';
    const lock = await pool.connect();
    await lock.query("SELECT pg_advisory_lock(hashtextextended('stock-backup', 0))");
    try {
      const before = Number((await pool.query('SELECT count(*) FROM backup_logs')).rows[0].count);
      const result = await createBackup(pool, { userId: '${ids.admin}' })
        .then(() => ({ status: 'FALSE_SUCCESS' }))
        .catch((error) => ({ status: error.status, errorCode: error.errorCode }));
      const after = Number((await pool.query('SELECT count(*) FROM backup_logs')).rows[0].count);
      console.log(JSON.stringify({ ...result, unchanged: before === after }));
    } finally {
      await lock.query("SELECT pg_advisory_unlock(hashtextextended('stock-backup', 0))");
      lock.release();
      await pool.end();
    }
  `);
  assert.deepEqual(JSON.parse(output), {
    status: 409, errorCode: 'BACKUP_IN_PROGRESS', unchanged: true,
  });
});

test('OPS-002 corrupt archive fails before false restore success', async () => {
  await writeFile(`${process.env.BACKUP_LOCAL_HOST_DIR}/corrupt.dump`, 'not-a-pg-dump');
  const output = app.execApp(`
    import { verifyRestore } from './src/services/backup.js';
    try {
      await verifyRestore('/var/backups/stock-opname/corrupt.dump');
      console.log('FALSE_SUCCESS');
    } catch { console.log('CORRUPT_REJECTED'); }
  `);
  assert.equal(output, 'CORRUPT_REJECTED');
});

test('OPS-002 truncated valid archive fails before false restore success', async () => {
  const created = await createBackup();
  assert.equal(created.response.status, 201, JSON.stringify(created.body));
  const valid = await readFile(`${process.env.BACKUP_LOCAL_HOST_DIR}/${created.body.data.fileName}`);
  assert.ok(valid.length > 2);
  await writeFile(
    `${process.env.BACKUP_LOCAL_HOST_DIR}/truncated.dump`,
    valid.subarray(0, Math.floor(valid.length / 2)),
  );
  const output = app.execApp(`
    import { verifyRestore } from './src/services/backup.js';
    try {
      await verifyRestore('/var/backups/stock-opname/truncated.dump');
      console.log('FALSE_SUCCESS');
    } catch { console.log('TRUNCATED_REJECTED'); }
  `);
  assert.equal(output, 'TRUNCATED_REJECTED');
});

test('restore verifier rejects paths outside configured backup root', () => {
  const output = app.execApp(`
    import { verifyRestore } from './src/services/backup.js';
    try {
      await verifyRestore('/tmp/outside.dump');
      console.log('FALSE_SUCCESS');
    } catch (error) { console.log(error.message); }
  `);
  assert.equal(output, 'Invalid backup path.');
});

test('backup and restore CLIs expose verified automation without active-database restore', () => {
  const backup = app.execApp(`
    process.env.BACKUP_ACTOR_ID = '${ids.admin}';
    process.argv[1] = './scripts/backup.js';
    await import('./scripts/backup.js');
  `);
  assert.match(backup, /"status":"VERIFIED"/);
  const fileName = JSON.parse(backup).fileName;
  const restore = app.execApp(`
    process.argv[1] = './scripts/restore.js';
    process.argv[2] = '/var/backups/stock-opname/${fileName}';
    await import('./scripts/restore.js');
  `);
  const evidence = JSON.parse(restore);
  assert.equal(evidence.status, 'VERIFIED');
  assert.equal(evidence.cleanupVerified, true);
});

test('restore drill rejects an archive whose size or checksum differs from retained metadata', async () => {
  const created = await createBackup();
  assert.equal(created.response.status, 201, JSON.stringify(created.body));
  app.sql(`UPDATE backup_logs SET size_bytes = size_bytes + 1 WHERE id = '${created.body.data.id}'`);
  const run = () => app.execApp(`
    import { pool } from './src/db/pool.js';
    import { runRestoreDrill } from './scripts/restore.js';
    try {
      await runRestoreDrill('/var/backups/stock-opname/${created.body.data.fileName}');
      console.log('FALSE_SUCCESS');
    } catch (error) { console.log(error.message); }
    await pool.end();
  `);
  assert.equal(run(), 'Backup size mismatch.');
  app.sql(`
    UPDATE backup_logs SET size_bytes = ${created.body.data.sizeBytes}, checksum = repeat('0', 64)
    WHERE id = '${created.body.data.id}'
  `);
  assert.equal(run(), 'Backup checksum mismatch.');
});

test('OPS-004 retention marks metadata unretained before deleting an artifact', async () => {
  const blocked = 'daily-2024-01-01T00-00-00-acde.dump';
  const copyPath = `${process.env.BACKUP_COPY_HOST_DIR}/${blocked}`;
  await mkdir(`${copyPath}/child`, { recursive: true });
  app.sql(`
    INSERT INTO backup_logs (
      id, backup_type, file_name, storage_uri, size_bytes, checksum, status,
      created_by, created_at, verified_at, cleanup_verified, retained
    ) VALUES (
      gen_random_uuid(), 'DAILY', '${blocked}', 'file://${copyPath}', 1,
      repeat('a', 64), 'VERIFIED', '${ids.admin}', '2024-01-01', '2024-01-01', true, true
    )
  `);
  const failed = await createBackup();
  assert.equal(failed.response.status, 500, JSON.stringify(failed.body));
  assert.equal(app.sql(`SELECT retained FROM backup_logs WHERE file_name = '${blocked}'`), 'f');
  const listed = await app.api('/maintenance/backups', { headers: { cookie: admin.cookie } });
  const historical = listed.body.data.find((row) => row.fileName === blocked);
  assert.equal(historical?.status, 'VERIFIED');
  assert.equal(historical?.retained, false);
  assert.equal((await stat(copyPath)).isDirectory(), true);
  await rm(copyPath, { recursive: true, force: true });
});

test('OPS-004 retention keeps at most 7 daily, 4 weekly, and 12 monthly slots', async () => {
  const recovered = await createBackup();
  assert.equal(recovered.response.status, 201, JSON.stringify(recovered.body));
  for (const directory of [process.env.BACKUP_LOCAL_HOST_DIR, process.env.BACKUP_COPY_HOST_DIR]) {
    const names = await readdir(directory);
    assert.ok(names.filter((name) => name.startsWith('daily-')).length <= 7);
    assert.ok(names.filter((name) => name.startsWith('weekly-')).length <= 4);
    assert.ok(names.filter((name) => name.startsWith('monthly-')).length <= 12);
  }
});

test('OPS-004 Google Drive copy applies 7/4/12 retention', () => {
  const fakeRclone = `#!/bin/sh
printf '%s|%s|%s\\n' "$1" "$2" "$3" >> "$FAKE_RCLONE_TRACE"
case "$1" in
  copyto) exit 0 ;;
  lsf)
    printf '%s\\n' \\
      daily-2025-01-01T00-00-00.dump daily-2025-01-02T00-00-00.dump \\
      daily-2025-01-03T00-00-00.dump daily-2025-01-04T00-00-00.dump \\
      daily-2025-01-05T00-00-00.dump daily-2025-01-06T00-00-00.dump \\
      daily-2025-01-07T00-00-00.dump daily-2025-01-08T00-00-00.dump \\
      daily-2025-01-09T00-00-00.dump \\
      weekly-2025-W01.dump weekly-2025-W02.dump weekly-2025-W03.dump \\
      weekly-2025-W04.dump weekly-2025-W05.dump weekly-2025-W06.dump \\
      monthly-2024-01.dump monthly-2024-02.dump monthly-2024-03.dump \\
      monthly-2024-04.dump monthly-2024-05.dump monthly-2024-06.dump \\
      monthly-2024-07.dump monthly-2024-08.dump monthly-2024-09.dump \\
      monthly-2024-10.dump monthly-2024-11.dump monthly-2024-12.dump \\
      monthly-2024-13.dump monthly-2024-14.dump ;;
  deletefile) printf '%s\\n' "$2" >> "$FAKE_RCLONE_LOG" ;;
  *) exit 1 ;;
esac
`;
  const output = app.execApp(`
    import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
    import { pool } from './src/db/pool.js';
    import { createBackup } from './src/services/backup.js';
    const bin = \`${'${process.env.BACKUP_LOCAL_DIR}'}/fake-rclone-retention\`;
    const log = '/tmp/fake-rclone-retention.log';
    const trace = '/tmp/fake-rclone-retention.trace';
    await rm(bin, { recursive: true, force: true });
    await rm(log, { force: true });
    await rm(trace, { force: true });
    await mkdir(bin, { recursive: true });
    await writeFile(\`${'${bin}'}/rclone\`, ${JSON.stringify(fakeRclone)});
    await chmod(\`${'${bin}'}/rclone\`, 0o755);
    process.env.PATH = \`${'${bin}'}:${'${process.env.PATH}'}\`;
    process.env.FAKE_RCLONE_LOG = log;
    process.env.FAKE_RCLONE_TRACE = trace;

    delete process.env.BACKUP_COPY_DIR;
    process.env.GOOGLE_DRIVE_FOLDER_ID = 'fake-folder';
    process.env.GOOGLE_APPLICATION_CREDENTIALS = '/tmp/fake-credential.json';
    const result = await createBackup(pool, { userId: '${ids.admin}' });
    const deleted = (await readFile(log, 'utf8').catch(() => ''))
      .trim().split('\\n').filter(Boolean);
    console.log(JSON.stringify({ status: result.status, deleted }));
    await rm(bin, { recursive: true, force: true });
    await rm(log, { force: true });
    await pool.end();
  `);
  const evidence = JSON.parse(output);
  assert.equal(evidence.status, 'VERIFIED');
  assert.equal(evidence.deleted.filter((name) => name.includes('daily-')).length, 2);
  assert.equal(evidence.deleted.filter((name) => name.includes('weekly-')).length, 2);
  assert.equal(evidence.deleted.filter((name) => name.includes('monthly-')).length, 2);
});

test('OPS-008 independent-copy failure records FAILED audit without false success', async () => {
  await chmod(process.env.BACKUP_COPY_HOST_DIR, 0o555);
  try {
    const failed = await createBackup();
    assert.equal(failed.response.status, 500, JSON.stringify(failed.body));
    assert.equal(failed.body.errorCode, 'BACKUP_FAILED');
  } finally {
    await chmod(process.env.BACKUP_COPY_HOST_DIR, 0o777);
  }
  assert.equal(app.sql("SELECT status FROM backup_logs ORDER BY created_at DESC LIMIT 1"), 'FAILED');
  const details = JSON.parse(app.sql("SELECT details::text FROM audit_logs WHERE action = 'BACKUP_FAILED' ORDER BY timestamp DESC LIMIT 1"));
  assert.deepEqual(details, { errorCode: 'BACKUP_FAILED' });
});

test('backup endpoints enforce session, ADMIN role, Origin, CSRF, and JSON', async () => {
  const anonymous = await app.api('/maintenance/backups');
  assert.equal(anonymous.response.status, 401);
  const forbiddenRead = await app.api('/maintenance/backups', { headers: { cookie: supervisor.cookie } });
  assert.equal(forbiddenRead.response.status, 403);

  const noOrigin = await app.api('/maintenance/backup', {
    method: 'POST',
    headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrf, 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(noOrigin.response.status, 403);
  assert.equal(noOrigin.body.errorCode, 'ORIGIN_INVALID');

  const badCsrf = await createBackup(admin, 'wrong');
  assert.equal(badCsrf.response.status, 403);
  assert.equal(badCsrf.body.errorCode, 'CSRF_INVALID');
  const forbiddenWrite = await createBackup(supervisor);
  assert.equal(forbiddenWrite.response.status, 403);

  const media = await app.api('/maintenance/backup', {
    method: 'POST', headers: { ...mutationHeaders(admin), 'content-type': 'text/plain' }, body: '{}',
  });
  assert.equal(media.response.status, 415);
});

test('OPS-003 restore rejects immutable ledger keys missing balance and batch caches', async () => {
  app.sql(`
    INSERT INTO categories (id, code, name, status)
      VALUES ('${ids.category}', 'BACKUP-CAT-2', 'Backup Category 2', 'ACTIVE');
    INSERT INTO units (id, code, name, symbol, conversion_to_base, status)
      VALUES ('${ids.unit}', 'BACKUP-KG-2', 'Kilogram 2', 'kg2', 1, 'ACTIVE');
    INSERT INTO warehouses (id, code, name, status, region_id)
      VALUES ('${ids.warehouse}', 'BACKUP-WH-2', 'Backup Warehouse 2', 'ACTIVE', '${ids.region}');
    INSERT INTO products (
      id, code, name, category_id, base_unit_id, conversion_factor,
      minimum_stock, maximum_stock, status
    ) VALUES (
      '${ids.product}', 'BACKUP-P-2', 'Backup Product 2', '${ids.category}', '${ids.unit}',
      1, 0, 100, 'ACTIVE'
    );
    INSERT INTO stock_transactions (
      id, idempotency_key, transaction_number, transaction_type, transaction_date,
      request_hash, reference_id, product_id, warehouse_id, quantity, unit,
      balance_before, balance_after, user_id, created_at
    ) VALUES (
      gen_random_uuid(), 'backup-ledger-only', 'BACKUP-LEDGER-ONLY', 'OPENING', CURRENT_DATE,
      '', 'BACKUP-LEDGER-ONLY', '${ids.product}', '${ids.warehouse}', 5, 'BACKUP-KG-2',
      0, 5, '${ids.admin}', now()
    );
  `);
  const result = await createBackup();
  assert.equal(result.response.status, 500, JSON.stringify(result.body));
  assert.equal(result.body.errorCode, 'BACKUP_FAILED');
});

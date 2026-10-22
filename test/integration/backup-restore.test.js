import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { api, appCommand, appCommandResult, appOrigin, appProcess, ids, setup, sql, teardown } from './report-fixture.js';

let sessions;
let csrf;
let verifiedFileName;

function repairFixture() {
  sql(`
    ALTER TABLE stock_transactions DISABLE TRIGGER stock_transactions_immutable_rows;
    UPDATE stock_transactions SET balance_before = 19, balance_after = 17
      WHERE transaction_number = 'RPT-ADJUST';
    ALTER TABLE stock_transactions ENABLE TRIGGER stock_transactions_immutable_rows;
    UPDATE stock_balances SET quantity = 17
      WHERE product_id = '${ids.safe}' AND warehouse_id = '${ids.warehouseA}';
    UPDATE stock_batches SET quantity = 17 WHERE id = '${ids.safeBatch}';
    DELETE FROM stock_balances
      WHERE product_id = '${ids.out}' AND warehouse_id = '${ids.warehouseA}';
    UPDATE stock_opnames SET submitted_at = now();
    INSERT INTO audit_logs (id, timestamp, user_id, action, module, reference, details)
    SELECT gen_random_uuid(), now(), user_id,
      CASE transaction_type WHEN 'OPENING' THEN 'OPENING_STOCK' WHEN 'IN' THEN 'STOCK_IN'
        WHEN 'OUT' THEN 'STOCK_OUT' ELSE 'OPNAME_APPROVED' END,
      'INVENTORY', id::text, '{}'::jsonb
    FROM stock_transactions;
  `);
}

async function csrfFor(cookie) {
  const result = await api('/auth/csrf', { headers: { cookie } });
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  return result.body.data.csrfToken;
}

function backup(cookie = sessions.admin, token = csrf, overrides = {}) {
  return api('/maintenance/backup', {
    method: 'POST',
    headers: {
      cookie,
      origin: appOrigin(),
      'content-type': 'application/json',
      'x-csrf-token': token,
      ...overrides,
    },
    body: '{}',
  });
}

before(async () => {
  sessions = await setup('stock_backup_restore');
  repairFixture();
  csrf = await csrfFor(sessions.admin);
});
after(teardown);

test('production image contains PostgreSQL and rclone recovery clients', () => {
  const output = appCommand(['sh', '-c', 'pg_dump --version && pg_restore --version && rclone version']);
  assert.match(output, /pg_dump \(PostgreSQL\) 17\./);
  assert.match(output, /pg_restore \(PostgreSQL\) 17\./);
  assert.match(output, /rclone v/);
});

test('backup mutation rejects anonymous, wrong role, bad origin, bad CSRF, and bad media type', async () => {
  const petugasCsrf = await csrfFor(sessions.petugas);
  const cases = [
    [await backup('', ''), 401, 'UNAUTHENTICATED'],
    [await backup(sessions.petugas, petugasCsrf), 403, 'FORBIDDEN'],
    [await backup(sessions.admin, csrf, { origin: 'https://evil.example' }), 403, 'ORIGIN_INVALID'],
    [await backup(sessions.admin, 'wrong'), 403, 'CSRF_INVALID'],
    [await backup(sessions.admin, csrf, { 'content-type': 'text/plain' }), 415, 'UNSUPPORTED_MEDIA_TYPE'],
  ];
  for (const [result, status, code] of cases) {
    assert.equal(result.response.status, status, JSON.stringify(result.body));
    assert.equal(result.body.errorCode, code);
  }
  assert.equal(sql('SELECT count(*) FROM backup_logs'), '0');
});

test('backup listing requires ADMIN', async () => {
  assert.equal((await api('/maintenance/backups')).response.status, 401);
  assert.equal((await api('/maintenance/backups', { headers: { cookie: sessions.petugas } })).response.status, 403);
  const result = await api('/maintenance/backups', { headers: { cookie: sessions.admin } });
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  assert.deepEqual(result.body.data.items, []);
});

test('OPS-001/003/005 creates, copies, and verifies an isolated recovery point', async () => {
  const result = await backup();
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  const item = result.body.data;
  verifiedFileName = item.fileName;
  assert.equal(item.status, 'VERIFIED');
  assert.match(item.fileName, /^stock-opname-\d{8}T\d{6}-[0-9a-f]{32}\.dump$/);
  assert.match(item.checksum, /^[0-9a-f]{64}$/);
  assert.ok(item.sizeBytes > 0);
  assert.ok(item.restoreDurationMs >= 0);
  assert.doesNotMatch(JSON.stringify(item), /postgresql:|password|\/var\/backups|backup:/i);

  const hashes = appCommand(['sh', '-c', `sha256sum "/var/backups/stock-opname/${item.fileName}" && rclone cat "backup:/var/backups/stock-opname/remote/${item.fileName}" | sha256sum`])
    .trim().split('\n').map((line) => line.split(/\s+/, 1)[0]);
  assert.deepEqual(hashes, [item.checksum, item.checksum]);
  assert.equal(sql("SELECT status || ':' || (verified_at IS NOT NULL)::text FROM backup_logs ORDER BY created_at DESC LIMIT 1"), 'VERIFIED:true');
  assert.equal(sql("SELECT count(*) FROM pg_database WHERE datname LIKE 'stock_restore_%'"), '0');
});

test('restore CLI verifies valid archive and rejects a truncated archive', () => {
  const validPath = `/var/backups/stock-opname/${verifiedFileName}`;
  const valid = JSON.parse(appCommand(['node', 'scripts/restore.js', '--verify', validPath]));
  assert.equal(valid.status, 'PASS');
  assert.ok(valid.restoreDurationMs >= 0);

  const corruptPath = '/var/backups/stock-opname/corrupt.dump';
  appCommand(['sh', '-c', `head -c 128 "${validPath}" > "${corruptPath}"`]);
  const corrupt = appCommandResult(['node', 'scripts/restore.js', '--verify', corruptPath]);
  assert.notEqual(corrupt.status, 0);
  assert.equal(JSON.parse(corrupt.stdout).status, 'FAIL');

  appCommand(['ln', '-s', '/etc/passwd', '/var/backups/stock-opname/escape.dump']);
  const escaped = appCommandResult(['node', 'scripts/restore.js', '--verify', '/var/backups/stock-opname/escape.dump']);
  assert.notEqual(escaped.status, 0);
  assert.equal(JSON.parse(escaped.stdout).errorCode, 'RESTORE_PATH_INVALID');
  assert.equal(sql("SELECT count(*) FROM pg_database WHERE datname LIKE 'stock_restore_%'"), '0');
});

test('backup CLI creates a verified recovery point', () => {
  const output = appCommand(['node', 'scripts/backup.js'], { BACKUP_USER_ID: ids.admin });
  assert.equal(JSON.parse(output).status, 'VERIFIED');
});

test('OPS-004 retention keeps 7 daily, 4 weekly, 12 monthly, pinned, and active artifacts', () => {
  const days = Array.from({ length: 30 }, (_, index) => {
    const day = String(index + 1).padStart(2, '0');
    return [`daily-${day}.dump`, `2026-06-${day}T12:00:00Z`];
  });
  const months = Array.from({ length: 11 }, (_, index) => {
    const date = new Date(Date.UTC(2025, 6 + index + 1, 0, 12));
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');
    return [`monthly-${date.getUTCFullYear()}-${month}.dump`, `${date.getUTCFullYear()}-${month}-${day}T12:00:00Z`];
  });
  const rows = [
    ...days,
    ...months,
    ['same-day-older.dump', '2026-06-30T11:00:00Z'],
    ['pinned.dump', '2024-01-01T12:00:00Z', 'VERIFIED', true],
    ['active.dump', '2023-01-01T12:00:00Z', 'STARTED', false],
  ];
  const values = rows.map(([fileName, createdAt, status = 'VERIFIED', pinned = false]) =>
    `(gen_random_uuid(), 'DAILY', '${fileName}', '/var/backups/stock-opname/${fileName}', 'backup:/var/backups/stock-opname/remote/${fileName}', 1, repeat('a', 64), '${status}', '${ids.admin}', '${createdAt}', ${status === 'VERIFIED' ? `'${createdAt}'` : 'NULL'}, true, ${pinned})`).join(',');
  sql(`INSERT INTO backup_logs (
    id, backup_type, file_name, storage_uri, independent_storage_uri, size_bytes,
    checksum, status, created_by, created_at, verified_at, retained, pinned
  ) VALUES ${values}`);
  const names = rows.map(([fileName]) => fileName).join(' ');
  appCommand(['sh', '-c', `for name in ${names}; do printf x > "/var/backups/stock-opname/$name"; rclone copyto "/var/backups/stock-opname/$name" "backup:/var/backups/stock-opname/remote/$name"; done`]);

  const result = JSON.parse(appCommand(['node', 'scripts/retention.js']));
  assert.equal(result.daily, 7);
  assert.equal(result.weekly, 4);
  assert.equal(result.monthly, 12);
  assert.equal(result.retained, 18);
  assert.equal(sql("SELECT count(*) FROM backup_logs WHERE retained AND status = 'VERIFIED'"), '19');
  assert.equal(sql("SELECT retained::text FROM backup_logs WHERE file_name = 'same-day-older.dump'"), 'false');
  assert.equal(sql("SELECT retained::text FROM backup_logs WHERE file_name = 'pinned.dump'"), 'true');
  assert.equal(sql("SELECT retained::text FROM backup_logs WHERE file_name = 'active.dump'"), 'true');
  appCommand(['sh', '-c', 'test ! -e /var/backups/stock-opname/same-day-older.dump && test -e /var/backups/stock-opname/pinned.dump && rclone lsf backup:/var/backups/stock-opname/remote/pinned.dump >/dev/null']);
});

test('concurrent backup returns BACKUP_BUSY before metadata or artifact creation', async () => {
  const before = Number(sql('SELECT count(*) FROM backup_logs'));
  const holder = appProcess(['node', '--input-type=module', '-e', `
    import { pool } from './src/db/pool.js';
    const client = await pool.connect();
    const result = await client.query('SELECT pg_advisory_lock(7309472202), pg_backend_pid() AS pid');
    console.log('LOCKED:' + result.rows[0].pid);
    setTimeout(async () => {
      client.release(); await pool.end();
    }, 30000);
  `]);
  const backendPid = await new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error('lock holder timeout')), 5000);
    holder.stdout.on('data', (chunk) => {
      output += chunk;
      const match = output.match(/LOCKED:(\d+)/);
      if (match) { clearTimeout(timeout); resolve(Number(match[1])); }
    });
    holder.once('error', reject);
  });
  try {
    const result = await backup();
    assert.equal(result.response.status, 409, JSON.stringify(result.body));
    assert.equal(result.body.errorCode, 'BACKUP_BUSY');
    assert.equal(Number(sql('SELECT count(*) FROM backup_logs')), before);
  } finally {
    assert.equal(sql(`SELECT pg_terminate_backend(${backendPid})`), 't');
    holder.kill('SIGTERM');
  }
});

test('OPS-008 remote-copy failure records FAILED and safe audit without false success', () => {
  const result = appCommandResult(['node', 'scripts/backup.js'], {
    BACKUP_USER_ID: ids.admin,
    BACKUP_REMOTE: 'unconfigured:recovery',
  });
  assert.notEqual(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout), { status: 'FAIL', errorCode: 'BACKUP_FAILED' });
  assert.equal(sql("SELECT status || ':' || failure_code FROM backup_logs ORDER BY created_at DESC LIMIT 1"), 'FAILED:BACKUP_EXECUTION_FAILED');
  const audit = sql("SELECT details::text FROM audit_logs WHERE action = 'BACKUP_FAILED' ORDER BY timestamp DESC LIMIT 1");
  assert.match(audit, /BACKUP_EXECUTION_FAILED/);
  assert.doesNotMatch(audit, /postgresql:|password|unconfigured:|\/var\/backups/i);
  const failedFile = sql("SELECT file_name FROM backup_logs WHERE status = 'FAILED' ORDER BY created_at DESC LIMIT 1");
  appCommand(['test', '-s', `/var/backups/stock-opname/${failedFile}`]);
});
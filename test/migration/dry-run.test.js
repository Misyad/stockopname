import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmod, mkdir, mkdtemp, readFile, stat, symlink, writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseMigrationCsv } from '../../src/services/migration.js';

const root = fileURLToPath(new URL('../..', import.meta.url));
const script = join(root, 'scripts/migrate-sheets.js');
const sheets = [
  'USERS', 'PRODUCTS', 'CATEGORIES', 'UNITS', 'SATUAN_ALIAS',
  'WAREHOUSES', 'SUPPLIERS', 'STOCK_BATCHES', 'STOCK_BALANCES',
  'STOCK_TRANSACTIONS', 'STOCK_OPNAMES', 'STOCK_OPNAME_ITEMS',
  'AUDIT_LOGS', 'BACKUP_LOGS',
];

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function dataRows(value) {
  const normalized = value.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  const lines = normalized.endsWith('\n') ? normalized.slice(0, -1).split('\n') : normalized.split('\n');
  return Math.max(0, lines.length - 1);
}

function jsonAtBytes(value, limit) {
  const json = JSON.stringify(value);
  assert.ok(Buffer.byteLength(json) <= limit);
  return `${json}${' '.repeat(limit - Buffer.byteLength(json))}`;
}

function categoryCsvAtBytes(limit) {
  const lines = ['ID,CODE,NAME\n'];
  let bytes = Buffer.byteLength(lines[0]);
  let index = 0;
  while (bytes < limit) {
    const prefix = `c-${index},C-${index},`;
    const prefixBytes = Buffer.byteLength(prefix);
    const remaining = limit - bytes;
    if (remaining < prefixBytes + 2) {
      const removed = lines.pop();
      bytes -= Buffer.byteLength(removed);
      index -= 1;
      continue;
    }
    const nameBytes = Math.min(4096, remaining - prefixBytes - 1);
    const line = `${prefix}${'x'.repeat(nameBytes)}\n`;
    lines.push(line);
    bytes += Buffer.byteLength(line);
    index += 1;
  }
  return lines.join('');
}

async function fixture(options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'stock-migration-'));
  const source = join(directory, 'source');
  const output = join(directory, 'evidence');
  await mkdir(source);
  const files = options.files || {
    CATEGORIES: 'ID,CODE,NAME\nc-1, bahan-kering ,Bahan   Kering\n',
    PRODUCTS: '\uFEFFID,CODE,NAME,CATEGORY_ID\np-1, rice , Beras  Premium ,c-1\n',
  };
  for (const [sheet, content] of Object.entries(files)) {
    await writeFile(join(source, `${sheet}.csv`), content, {
      flag: 'wx', mode: options.sourceMode ?? 0o444,
    });
  }
  const manifest = {
    version: 1,
    sourceRevision: 'revision-2026-10-22T08:00:00Z',
    exportedAt: '2026-10-22T08:00:00.000Z',
    sheets: sheets.map((sheet) => files[sheet]
      ? {
        sheet, status: 'PRESENT', spreadsheetId: 'sheet-fixture',
        exportFile: `${sheet}.csv`, bytes: Buffer.byteLength(files[sheet]),
        rowCount: dataRows(files[sheet]), sha256: sha256(files[sheet]),
        exportedAt: '2026-10-22T08:00:00.000Z',
      }
      : { sheet, status: 'SOURCE_ABSENT' }),
  };
  options.changeManifest?.(manifest);
  await writeFile(join(source, 'source-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o444 });
  const mapping = {
    version: 1,
    requiredSheets: ['CATEGORIES', 'PRODUCTS'],
    sheets: {
      CATEGORIES: {
        key: ['id'], unique: ['code'],
        fields: {
          id: { source: 'ID', normalize: 'trim', required: true },
          code: { source: 'CODE', normalize: 'code', required: true },
          name: { source: 'NAME', normalize: 'name', required: true },
        },
      },
      PRODUCTS: {
        key: ['id'], unique: ['code'],
        fields: {
          id: { source: 'ID', normalize: 'trim', required: true },
          code: { source: 'CODE', normalize: 'code', required: true },
          name: { source: 'NAME', normalize: 'name', required: true },
          category_id: { source: 'CATEGORY_ID', normalize: 'trim', required: true },
        },
        references: [{ field: 'category_id', sheet: 'CATEGORIES', target: 'id', errorCode: 'CATEGORY_NOT_FOUND' }],
      },
    },
  };
  options.changeMapping?.(mapping);
  const mappingPath = join(directory, 'mapping.json');
  await writeFile(mappingPath, `${JSON.stringify(mapping, null, 2)}\n`);
  return { source, output, mappingPath, files, manifest, mapping };
}

function run({ source, output, mappingPath }) {
  return spawnSync(process.execPath, [
    script, 'dry-run', '--source', source, '--output', output, '--mapping', mappingPath,
  ], { cwd: root, encoding: 'utf8' });
}

test('dry run verifies immutable export and writes complete zero-mutation evidence', async () => {
  const data = await fixture();
  const before = await Promise.all(Object.keys(data.files).map(async (sheet) => ({
    sheet,
    content: await readFile(join(data.source, `${sheet}.csv`), 'utf8'),
    mode: (await stat(join(data.source, `${sheet}.csv`))).mode,
  })));

  const result = run(data);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /MIGRATION_DRY_RUN=PASS/);

  const inventory = JSON.parse(await readFile(join(data.output, 'inventory.json'), 'utf8'));
  assert.equal(inventory.sourceRevision, 'revision-2026-10-22T08:00:00Z');
  assert.equal(inventory.sheets.length, 14);
  assert.equal(inventory.sheets.find(({ sheet }) => sheet === 'PRODUCTS').rowCount, 1);
  assert.equal(inventory.sheets.find(({ sheet }) => sheet === 'PRODUCTS').headerHash,
    sha256('\uFEFFID,CODE,NAME,CATEGORY_ID\n'));
  assert.equal(inventory.sheets.find(({ sheet }) => sheet === 'USERS').status, 'SOURCE_ABSENT');

  const reconciliation = JSON.parse(await readFile(join(data.output, 'reconciliation-preview.json'), 'utf8'));
  assert.deepEqual(reconciliation, {
    status: 'PASS', acceptedRows: 2, reviewRows: 0, rejectedRows: 0,
    conflictRows: 0, skippedRows: 0, sourceRows: { CATEGORIES: 1, PRODUCTS: 1 },
  });
  assert.equal(await readFile(join(data.output, 'validation-errors.csv'), 'utf8'),
    'sheet,row_number,source_key,error_code,field,raw_value,normalized_value,message\n');
  assert.match(await readFile(join(data.output, 'id-map-preview.csv'), 'utf8'), /PRODUCTS,p-1,RICE,,/);
  assert.match(await readFile(join(data.output, 'migration-report.md'), 'utf8'), /Status: PASS/);

  const after = await Promise.all(Object.keys(data.files).map(async (sheet) => ({
    sheet,
    content: await readFile(join(data.source, `${sheet}.csv`), 'utf8'),
    mode: (await stat(join(data.source, `${sheet}.csv`))).mode,
  })));
  assert.deepEqual(after, before);
});

test('changed export checksum fails closed before evidence creation', async () => {
  const data = await fixture();
  await writeFile(join(data.source, 'PRODUCTS.csv'), data.files.PRODUCTS.replace('Premium', 'Premiun'));
  const result = run(data);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Checksum mismatch: PRODUCTS\.csv/);
  await assert.rejects(readFile(join(data.output, 'inventory.json')), { code: 'ENOENT' });
});

test('writable source export fails closed', async () => {
  const data = await fixture({ sourceMode: 0o644 });
  const result = run(data);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Source export is not read-only: (CATEGORIES|PRODUCTS)\.csv/);
});

test('writable source manifest fails closed', async () => {
  const data = await fixture();
  await chmod(join(data.source, 'source-manifest.json'), 0o644);
  const result = run(data);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Source manifest is not read-only/);
  await assert.rejects(readFile(join(data.output, 'inventory.json')), { code: 'ENOENT' });
});

test('required source sheet explicitly absent fails closed', async () => {
  const data = await fixture({
    changeManifest: (manifest) => {
      manifest.sheets.find(({ sheet }) => sheet === 'PRODUCTS').status = 'SOURCE_ABSENT';
      delete manifest.sheets.find(({ sheet }) => sheet === 'PRODUCTS').exportFile;
      delete manifest.sheets.find(({ sheet }) => sheet === 'PRODUCTS').sha256;
    },
  });
  const result = run(data);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Required sheet absent: PRODUCTS/);
});

test('SOURCE_ABSENT fails closed when its export file exists', async () => {
  const data = await fixture();
  await writeFile(join(data.source, 'USERS.csv'), 'ID,EMAIL\n', { mode: 0o444 });
  const result = run(data);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Source manifest marks existing export absent: USERS/);
  await assert.rejects(readFile(join(data.output, 'inventory.json')), { code: 'ENOENT' });
});

test('manifest row count mismatch fails closed before evidence', async () => {
  const data = await fixture({
    changeManifest: (manifest) => {
      manifest.sheets.find(({ sheet }) => sheet === 'PRODUCTS').rowCount += 1;
    },
  });
  const result = run(data);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Manifest row count mismatch: PRODUCTS\.csv/);
  await assert.rejects(readFile(join(data.output, 'inventory.json')), { code: 'ENOENT' });
});

test('manifest byte count mismatch fails closed before evidence', async () => {
  const data = await fixture({
    changeManifest: (manifest) => {
      manifest.sheets.find(({ sheet }) => sheet === 'PRODUCTS').bytes += 1;
    },
  });
  const result = run(data);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Manifest byte count mismatch: PRODUCTS\.csv/);
  await assert.rejects(readFile(join(data.output, 'inventory.json')), { code: 'ENOENT' });
});

test('normalization collision produces conflict evidence and FAIL', async () => {
  const data = await fixture({
    files: {
      CATEGORIES: 'ID,CODE,NAME\nc-1,FOOD,Food\nc-2, food ,Other\n',
      PRODUCTS: 'ID,CODE,NAME,CATEGORY_ID\np-1,RICE,Rice,c-1\n',
    },
  });
  const result = run(data);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /MIGRATION_DRY_RUN=FAIL/);
  assert.match(await readFile(join(data.output, 'validation-errors.csv'), 'utf8'), /NORMALIZED_CODE_COLLISION/);
  const reconciliation = JSON.parse(await readFile(join(data.output, 'reconciliation-preview.json'), 'utf8'));
  assert.equal(reconciliation.status, 'FAIL');
  assert.ok(reconciliation.conflictRows > 0);
});

test('critical orphan preserves original row number after blank rows', async () => {
  const data = await fixture({
    files: {
      CATEGORIES: 'ID,CODE,NAME\nc-1,FOOD,Food\n',
      PRODUCTS: 'ID,CODE,NAME,CATEGORY_ID\n,,,\np-1,RICE,Rice,missing\n',
    },
  });
  const result = run(data);
  assert.notEqual(result.status, 0);
  const errors = await readFile(join(data.output, 'validation-errors.csv'), 'utf8');
  assert.match(errors, /PRODUCTS,3,p-1,CATEGORY_NOT_FOUND/);
  const reconciliation = JSON.parse(await readFile(join(data.output, 'reconciliation-preview.json'), 'utf8'));
  assert.equal(reconciliation.rejectedRows, 1);
});

test('same stable key with different payload produces conflict evidence', async () => {
  const data = await fixture({
    files: {
      CATEGORIES: 'ID,CODE,NAME\nc-1,FOOD,Food\n',
      PRODUCTS: 'ID,CODE,NAME,CATEGORY_ID\np-1,RICE,Rice,c-1\np-1,SALT,Salt,c-1\n',
    },
  });
  const result = run(data);
  assert.notEqual(result.status, 0);
  assert.match(await readFile(join(data.output, 'validation-errors.csv'), 'utf8'), /STABLE_KEY_PAYLOAD_CONFLICT/);
  const reconciliation = JSON.parse(await readFile(join(data.output, 'reconciliation-preview.json'), 'utf8'));
  assert.equal(reconciliation.conflictRows, 2);
});

test('same parsed values with different raw CSV representation conflict', async () => {
  const data = await fixture({
    files: {
      CATEGORIES: 'ID,CODE,NAME\nc-1,FOOD,Food\n',
      PRODUCTS: 'ID,CODE,NAME,CATEGORY_ID\np-1,RICE,Rice,c-1\n"p-1",RICE,Rice,c-1\n',
    },
  });
  const result = run(data);
  assert.notEqual(result.status, 0);
  assert.match(await readFile(join(data.output, 'validation-errors.csv'), 'utf8'),
    /STABLE_KEY_PAYLOAD_CONFLICT/);
});

test('exact duplicate stable key and payload is skipped idempotently', async () => {
  const data = await fixture({
    files: {
      CATEGORIES: 'ID,CODE,NAME\nc-1,FOOD,Food\n',
      PRODUCTS: 'ID,CODE,NAME,CATEGORY_ID\np-1,RICE,Rice,c-1\np-1,RICE,Rice,c-1\n',
    },
  });
  const result = run(data);
  assert.equal(result.status, 0, result.stderr);
  const map = await readFile(join(data.output, 'id-map-preview.csv'), 'utf8');
  assert.equal(map.match(/^PRODUCTS,/gm)?.length, 1);
  const reconciliation = JSON.parse(await readFile(join(data.output, 'reconciliation-preview.json'), 'utf8'));
  assert.equal(reconciliation.sourceRows.PRODUCTS, 2);
  assert.equal(reconciliation.acceptedRows, 2);
  assert.equal(reconciliation.skippedRows, 1);
});

test('invalid exact duplicate remains rejected and is not counted as skipped', async () => {
  const data = await fixture({
    files: {
      CATEGORIES: 'ID,CODE,NAME\nc-1,,Food\nc-1,,Food\n',
      PRODUCTS: 'ID,CODE,NAME,CATEGORY_ID\np-1,RICE,Rice,c-1\n',
    },
  });
  const result = run(data);
  assert.notEqual(result.status, 0);
  const reconciliation = JSON.parse(await readFile(join(data.output, 'reconciliation-preview.json'), 'utf8'));
  assert.equal(reconciliation.acceptedRows, 0);
  assert.equal(reconciliation.rejectedRows, 3);
  assert.equal(reconciliation.skippedRows, 0);
  const sourceRows = Object.values(reconciliation.sourceRows).reduce((sum, count) => sum + count, 0);
  assert.equal(sourceRows, reconciliation.acceptedRows + reconciliation.reviewRows
    + reconciliation.rejectedRows + reconciliation.conflictRows + reconciliation.skippedRows);
  assert.ok(reconciliation.acceptedRows >= 0);
});

test('invalid normalization produces rejected evidence and FAIL', async () => {
  const data = await fixture({
    files: {
      CATEGORIES: 'ID,CODE,NAME\nc-1,FOOD,not-a-number\n',
      PRODUCTS: 'ID,CODE,NAME,CATEGORY_ID\np-1,RICE,Rice,c-1\n',
    },
    changeMapping: (mapping) => {
      mapping.sheets.CATEGORIES.fields.name.normalize = 'decimal-id';
    },
  });
  const result = run(data);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /MIGRATION_DRY_RUN=FAIL/);
  assert.match(await readFile(join(data.output, 'validation-errors.csv'), 'utf8'), /NORMALIZATION_ERROR/);
});

test('Indonesian decimal normalization validates grouping before conversion', async () => {
  const valid = await fixture({
    files: {
      CATEGORIES: 'ID,CODE,NAME\n"1.234,50",FOOD,Food\n',
      PRODUCTS: 'ID,CODE,NAME,CATEGORY_ID\np-1,RICE,Rice,1234.50\n',
    },
    changeMapping: (mapping) => {
      mapping.sheets.CATEGORIES.fields.id.normalize = 'decimal-id';
    },
  });
  const validResult = run(valid);
  assert.equal(validResult.status, 0, validResult.stderr);
  assert.match(await readFile(join(valid.output, 'id-map-preview.csv'), 'utf8'),
    /CATEGORIES,1234\.50,FOOD/);

  const grouped = await fixture({
    files: {
      CATEGORIES: 'ID,CODE,NAME\n1.234,FOOD,Food\n',
      PRODUCTS: 'ID,CODE,NAME,CATEGORY_ID\np-1,RICE,Rice,1234\n',
    },
    changeMapping: (mapping) => {
      mapping.sheets.CATEGORIES.fields.id.normalize = 'decimal-id';
    },
  });
  const groupedResult = run(grouped);
  assert.equal(groupedResult.status, 0, groupedResult.stderr);
  assert.match(await readFile(join(grouped.output, 'id-map-preview.csv'), 'utf8'),
    /CATEGORIES,1234,FOOD/);

  const malformed = await fixture({
    files: {
      CATEGORIES: 'ID,CODE,NAME\n"1.2,3",FOOD,Food\n',
      PRODUCTS: 'ID,CODE,NAME,CATEGORY_ID\np-1,RICE,Rice,12.3\n',
    },
    changeMapping: (mapping) => {
      mapping.sheets.CATEGORIES.fields.id.normalize = 'decimal-id';
    },
  });
  const malformedResult = run(malformed);
  assert.notEqual(malformedResult.status, 0);
  assert.match(await readFile(join(malformed.output, 'validation-errors.csv'), 'utf8'),
    /NORMALIZATION_ERROR/);
});

test('ISO date normalization accepts a real calendar date', async () => {
  const data = await fixture({
    files: {
      CATEGORIES: 'ID,CODE,NAME\nc-1,FOOD,2024-02-29\n',
      PRODUCTS: 'ID,CODE,NAME,CATEGORY_ID\np-1,RICE,Rice,c-1\n',
    },
    changeMapping: (mapping) => {
      mapping.sheets.CATEGORIES.fields.name.normalize = 'date';
    },
  });
  const result = run(data);
  assert.equal(result.status, 0, result.stderr);
});

test('ISO date normalization rejects an impossible calendar date', async () => {
  const data = await fixture({
    files: {
      CATEGORIES: 'ID,CODE,NAME\nc-1,FOOD,2024-02-30\n',
      PRODUCTS: 'ID,CODE,NAME,CATEGORY_ID\np-1,RICE,Rice,c-1\n',
    },
    changeMapping: (mapping) => {
      mapping.sheets.CATEGORIES.fields.name.normalize = 'date';
    },
  });
  const result = run(data);
  assert.notEqual(result.status, 0);
  assert.match(await readFile(join(data.output, 'validation-errors.csv'), 'utf8'), /NORMALIZATION_ERROR/);
});

test('evidence CSV escapes formula-leading source values with optional whitespace', async () => {
  const data = await fixture({
    files: {
      CATEGORIES: 'ID,CODE,NAME\n=1+1,FOOD,  =2+2\n',
      PRODUCTS: 'ID,CODE,NAME,CATEGORY_ID\np-1,RICE,Rice,=1+1\n',
    },
    changeMapping: (mapping) => {
      mapping.sheets.CATEGORIES.fields.name.normalize = 'decimal-id';
    },
  });
  const result = run(data);
  assert.notEqual(result.status, 0);
  assert.match(await readFile(join(data.output, 'id-map-preview.csv'), 'utf8'), /CATEGORIES,'=1\+1,FOOD/);
  assert.match(await readFile(join(data.output, 'validation-errors.csv'), 'utf8'), /,"'  =2\+2",/);
});

test('reference to a target row rejected by validation remains an orphan', async () => {
  const data = await fixture({
    files: {
      CATEGORIES: 'ID,CODE,NAME\nc-1,,Food\n',
      PRODUCTS: 'ID,CODE,NAME,CATEGORY_ID\np-1,RICE,Rice,c-1\n',
    },
  });
  const result = run(data);
  assert.notEqual(result.status, 0);
  const errors = await readFile(join(data.output, 'validation-errors.csv'), 'utf8');
  assert.match(errors, /CATEGORIES,2,c-1,REQUIRED_FIELD/);
  assert.match(errors, /PRODUCTS,2,p-1,CATEGORY_NOT_FOUND/);
});

test('reference error preserves raw and normalized values separately', async () => {
  const data = await fixture({
    files: {
      CATEGORIES: 'ID,CODE,NAME\nc-1,FOOD,Food\n',
      PRODUCTS: 'ID,CODE,NAME,CATEGORY_ID\np-1,RICE,Rice,"  missing  "\n',
    },
  });
  const result = run(data);
  assert.notEqual(result.status, 0);
  const errors = await readFile(join(data.output, 'validation-errors.csv'), 'utf8');
  assert.match(errors, /CATEGORY_NOT_FOUND,category_id,"  missing  ",missing,/);
});

test('exact duplicates failing reference validation are rejected, not skipped', async () => {
  const data = await fixture({
    files: {
      CATEGORIES: 'ID,CODE,NAME\nc-1,FOOD,Food\n',
      PRODUCTS: 'ID,CODE,NAME,CATEGORY_ID\np-1,RICE,Rice,missing\np-1,RICE,Rice,missing\n',
    },
  });
  const result = run(data);
  assert.notEqual(result.status, 0);
  const errors = await readFile(join(data.output, 'validation-errors.csv'), 'utf8');
  assert.match(errors, /PRODUCTS,2,p-1,CATEGORY_NOT_FOUND/);
  assert.match(errors, /PRODUCTS,3,p-1,CATEGORY_NOT_FOUND/);
  const reconciliation = JSON.parse(await readFile(join(data.output, 'reconciliation-preview.json'), 'utf8'));
  assert.equal(reconciliation.rejectedRows, 2);
  assert.equal(reconciliation.skippedRows, 0);
});

test('reference failure propagates through downstream references', async () => {
  const data = await fixture({
    files: {
      CATEGORIES: 'ID,CODE,NAME\nc-1,,Food\n',
      PRODUCTS: 'ID,CODE,NAME,CATEGORY_ID\np-1,RICE,Rice,c-1\n',
      WAREHOUSES: 'ID,PRODUCT_ID\nw-1,p-1\n',
    },
    changeMapping: (mapping) => {
      mapping.requiredSheets.push('WAREHOUSES');
      mapping.sheets = {
        WAREHOUSES: {
          key: ['id'],
          fields: {
            id: { source: 'ID', normalize: 'trim', required: true },
            product_id: { source: 'PRODUCT_ID', normalize: 'trim', required: true },
          },
          references: [{
            field: 'product_id', sheet: 'PRODUCTS', target: 'id', errorCode: 'PRODUCT_NOT_FOUND',
          }],
        },
        ...mapping.sheets,
      };
    },
  });
  const result = run(data);
  assert.notEqual(result.status, 0);
  const errors = await readFile(join(data.output, 'validation-errors.csv'), 'utf8');
  assert.match(errors, /PRODUCTS,2,p-1,CATEGORY_NOT_FOUND/);
  assert.match(errors, /WAREHOUSES,2,w-1,PRODUCT_NOT_FOUND/);
});

test('evidence output rejects a symlink alias inside source directory', async () => {
  const data = await fixture();
  const alias = join(data.source, '..', 'source-alias');
  await symlink(data.source, alias, 'dir');
  const result = run({ ...data, output: join(alias, 'evidence') });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Evidence output must be outside source directory/);
  await assert.rejects(readFile(join(data.source, 'evidence', 'inventory.json')), { code: 'ENOENT' });
});

test('evidence output rejects an ancestor of source before writing', async () => {
  const data = await fixture();
  const result = run({ ...data, output: join(data.source, '..') });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Evidence output must be outside source directory/);
});

test('trailing blank data row remains in manifest count but not non-empty count', async () => {
  const data = await fixture({
    files: {
      CATEGORIES: 'ID,CODE,NAME\nc-1,FOOD,Food\n\n',
      PRODUCTS: 'ID,CODE,NAME,CATEGORY_ID\np-1,RICE,Rice,c-1\n',
    },
  });
  const result = run(data);
  assert.equal(result.status, 0, result.stderr);
  const inventory = JSON.parse(await readFile(join(data.output, 'inventory.json'), 'utf8'));
  const categories = inventory.sheets.find(({ sheet }) => sheet === 'CATEGORIES');
  assert.equal(categories.rowCount, 2);
  assert.equal(categories.nonEmptyRowCount, 1);
});

test('present manifest entry requires its own export timestamp', async () => {
  const data = await fixture({
    changeManifest: (manifest) => {
      delete manifest.sheets.find(({ sheet }) => sheet === 'PRODUCTS').exportedAt;
    },
  });
  const result = run(data);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Invalid source manifest entry: PRODUCTS/);
  await assert.rejects(readFile(join(data.output, 'inventory.json')), { code: 'ENOENT' });
});

test('manifest timestamps require explicit ISO-8601 date-time syntax', async () => {
  for (const mutate of [
    (manifest) => { manifest.exportedAt = 'October 22 2026'; },
    (manifest) => { manifest.exportedAt = '2026-02-30T08:00:00Z'; },
    (manifest) => { manifest.sheets.find(({ sheet }) => sheet === 'PRODUCTS').exportedAt = '2026-10-22'; },
  ]) {
    const data = await fixture({ changeManifest: mutate });
    const result = run(data);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Invalid source manifest/);
    await assert.rejects(readFile(join(data.output, 'inventory.json')), { code: 'ENOENT' });
  }
});

test('mapping stable key must reference a required mapped field', async () => {
  for (const mutate of [
    (mapping) => { mapping.sheets.PRODUCTS.key = ['missing']; },
    (mapping) => { mapping.sheets.PRODUCTS.fields.id.required = false; },
  ]) {
    const data = await fixture({ changeMapping: mutate });
    const result = run(data);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Invalid mapping: PRODUCTS/);
    await assert.rejects(readFile(join(data.output, 'inventory.json')), { code: 'ENOENT' });
  }
});

test('mapping rejects credential fields before evidence can expose raw secrets', async () => {
  const data = await fixture({
    changeMapping: (mapping) => {
      mapping.sheets.PRODUCTS.fields.password = {
        source: 'CODE', normalize: 'trim', required: false,
      };
    },
  });
  const result = run(data);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Sensitive field mapping is forbidden: PRODUCTS\.password/);
  await assert.rejects(readFile(join(data.output, 'validation-errors.csv')), { code: 'ENOENT' });
});

test('source rejects duplicate normalized headers before mapping rows', async () => {
  const data = await fixture({
    files: {
      CATEGORIES: 'ID,CODE, CODE ,NAME\nc-1,WRONG,FOOD,Food\n',
      PRODUCTS: 'ID,CODE,NAME,CATEGORY_ID\np-1,RICE,Rice,c-1\n',
    },
  });
  const result = run(data);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /CSV header is duplicated/);
  await assert.rejects(readFile(join(data.output, 'id-map-preview.csv')), { code: 'ENOENT' });
});

test('source rejects unmapped credential columns before hashing rows', async () => {
  for (const header of [
    'PASSWORD', 'PASSPHRASE', 'CREDENTIALS', 'API_KEY', 'PRIVATE_KEY',
    'AWS_ACCESS_KEY_ID', 'SSH_KEY', 'DATABASE_URL',
  ]) {
    const data = await fixture({
      files: {
        CATEGORIES: `ID,CODE,NAME,${header}\nc-1,FOOD,Food,plaintext-secret\n`,
        PRODUCTS: 'ID,CODE,NAME,CATEGORY_ID\np-1,RICE,Rice,c-1\n',
      },
    });
    const result = run(data);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(`Sensitive source header is forbidden: CATEGORIES\\.${header}`));
    await assert.rejects(readFile(join(data.output, 'id-map-preview.csv')), { code: 'ENOENT' });
  }
});

test('mapping rejects malformed unique and reference fields before parsing', async () => {
  for (const mutate of [
    (mapping) => { mapping.sheets.PRODUCTS.unique = ['missing']; },
    (mapping) => { mapping.sheets.PRODUCTS.references[0].field = 'missing'; },
    (mapping) => { mapping.sheets.PRODUCTS.references[0].sheet = 'SUPPLIERS'; },
    (mapping) => { mapping.sheets.PRODUCTS.references[0].target = 'missing'; },
    (mapping) => { mapping.sheets.PRODUCTS.references[0].target = 'name'; },
    (mapping) => {
      mapping.sheets.PRODUCTS.referneces = mapping.sheets.PRODUCTS.references;
      delete mapping.sheets.PRODUCTS.references;
    },
    (mapping) => { mapping.sheets.PRODUCTS.fields.name.requird = true; },
    (mapping) => { mapping.sheets.CATEGORIES.key = ['id', 'code']; },
    (mapping) => { mapping.sheets.PRODUCTS.fields.name.normalize = 'unknown'; },
  ]) {
    const data = await fixture({ changeMapping: mutate });
    const result = run(data);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Invalid (?:field mapping: PRODUCTS\.name|mapping: PRODUCTS)/);
    await assert.rejects(readFile(join(data.output, 'inventory.json')), { code: 'ENOENT' });
  }
});

test('present source sheet requires an explicit mapping', async () => {
  const data = await fixture({
    files: {
      CATEGORIES: 'ID,CODE,NAME\nc-1,FOOD,Food\n',
      PRODUCTS: 'ID,CODE,NAME,CATEGORY_ID\np-1,RICE,Rice,c-1\n',
      SUPPLIERS: 'ID,CODE,NAME\ns-1,SUP,Supplier\n',
    },
  });
  const result = run(data);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Missing mapping for present sheet: SUPPLIERS/);
  await assert.rejects(readFile(join(data.output, 'inventory.json')), { code: 'ENOENT' });
});

test('composite stable keys cannot collide through delimiter values', async () => {
  const data = await fixture({
    files: {
      CATEGORIES: 'ID,CODE,NAME\na|b,c,First\na,b|c,Second\n',
      PRODUCTS: 'ID,CODE,NAME,CATEGORY_ID\np-1,RICE,Rice,a|b\n',
    },
    changeMapping: (mapping) => {
      mapping.sheets.CATEGORIES.key = ['id', 'code'];
      mapping.sheets.CATEGORIES.unique.push('id');
    },
  });
  const result = run(data);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(await readFile(join(data.output, 'validation-errors.csv'), 'utf8'),
    /STABLE_KEY_PAYLOAD_CONFLICT/);
});

test('manifest boundary accepts 1 MiB and rejects one byte over before evidence', async () => {
  const max = 1024 * 1024;
  const exact = await fixture();
  await writeFile(join(exact.source, 'source-manifest.json'), jsonAtBytes(exact.manifest, max), { mode: 0o444 });
  assert.equal(run(exact).status, 0);

  const over = await fixture();
  await writeFile(join(over.source, 'source-manifest.json'), `${jsonAtBytes(over.manifest, max)} `, { mode: 0o444 });
  const result = run(over);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Invalid source manifest file/);
  await assert.rejects(readFile(join(over.output, 'inventory.json')), { code: 'ENOENT' });
});

test('mapping boundary accepts 1 MiB and rejects one byte over before evidence', async () => {
  const max = 1024 * 1024;
  const exact = await fixture();
  await writeFile(exact.mappingPath, jsonAtBytes(exact.mapping, max));
  assert.equal(run(exact).status, 0);

  const over = await fixture();
  await writeFile(over.mappingPath, `${jsonAtBytes(over.mapping, max)} `);
  const result = run(over);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Invalid migration mapping file/);
  await assert.rejects(readFile(join(over.output, 'inventory.json')), { code: 'ENOENT' });
});

test('CLI rejects unknown and target database options before file access', () => {
  for (const option of ['--unknown', '--target-db-url']) {
    const result = spawnSync(process.execPath, [script, 'dry-run', option, 'postgres://forbidden'], {
      cwd: root, encoding: 'utf8',
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Usage: node scripts\/migrate-sheets\.js dry-run/);
    assert.doesNotMatch(result.stderr, /ENOENT|ECONN/);
  }
});

test('file boundary accepts 10 MiB and rejects one byte over before evidence', async () => {
  const max = 10 * 1024 * 1024;
  const exactContent = categoryCsvAtBytes(max);
  assert.equal(Buffer.byteLength(exactContent), max);
  const files = (content) => ({
    CATEGORIES: content,
    PRODUCTS: 'ID,CODE,NAME,CATEGORY_ID\np-1,RICE,Rice,c-0\n',
  });
  const exact = await fixture({ files: files(exactContent) });
  assert.equal(run(exact).status, 0);

  const over = await fixture({ files: files(`${exactContent}x`) });
  const result = run(over);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Invalid export file: CATEGORIES/);
  await assert.rejects(readFile(join(over.output, 'inventory.json')), { code: 'ENOENT' });
});

test('field boundary accepts 4 KiB and rejects one byte over before evidence', async () => {
  const files = (size) => ({
    CATEGORIES: `ID,CODE,NAME\nc-1,FOOD,${'x'.repeat(size)}\n`,
    PRODUCTS: 'ID,CODE,NAME,CATEGORY_ID\np-1,RICE,Rice,c-1\n',
  });
  const exact = await fixture({ files: files(4096) });
  assert.equal(run(exact).status, 0);

  const over = await fixture({ files: files(4097) });
  const result = run(over);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /CSV field exceeds 4 KiB/);
  await assert.rejects(readFile(join(over.output, 'inventory.json')), { code: 'ENOENT' });
});

test('parser rejects one data row over 100,000 with or without final newline', () => {
  const exact = `ID\n${'x\n'.repeat(100_000)}`;
  assert.equal(parseMigrationCsv(exact).length, 100_001);
  assert.throws(() => parseMigrationCsv(`${exact}x\n`), /CSV exceeds 100,000 data rows/);

  const exactEof = `ID\n${'x\n'.repeat(99_999)}x`;
  assert.equal(parseMigrationCsv(exactEof).length, 100_001);
  assert.throws(() => parseMigrationCsv(`${exactEof}\nx`), /CSV exceeds 100,000 data rows/);
});

test('raw row boundary accepts 65,536 characters and rejects one over', () => {
  const header = `${Array.from({ length: 16 }, (_, index) => `H${index}`).join(',')}\n`;
  const exactRow = `${Array(16).fill('x'.repeat(4095)).join(',')}\n`;
  assert.equal(exactRow.length, 65_536);
  assert.equal(parseMigrationCsv(`${header}${exactRow}`).length, 2);

  const overRow = `${'x'.repeat(4096)},${Array(15).fill('x'.repeat(4095)).join(',')}\n`;
  assert.equal(overRow.length, 65_537);
  assert.throws(() => parseMigrationCsv(`${header}${overRow}`), /CSV row is too large/);

  const crlfOverRow = exactRow.replace(/\n$/, '\r\n');
  assert.equal(crlfOverRow.length, 65_537);
  assert.throws(() => parseMigrationCsv(`${header}${crlfOverRow}`), /CSV row is too large/);
});

test('parser rejects a pathological row independently of field size', () => {
  const row = `H1${',H'.repeat(32_768)}\n`;
  assert.throws(() => parseMigrationCsv(row), /CSV row is too large/);

  const quotedField = `"${'""'.repeat(4096)}"`;
  const escapedQuoteRow = `${Array(8).fill(quotedField).join(',')}\n`;
  assert.throws(() => parseMigrationCsv(escapedQuoteRow), /CSV row is too large/);
});

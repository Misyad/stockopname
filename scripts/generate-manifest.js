#!/usr/bin/env node
// Phase 10.2 source scaffold generator. Read current dir for <SHEET>.csv,
// emit source-manifest.json. Does NOT write CSVs, never touches source data.
import { createHash } from 'node:crypto';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

const SHEETS = [
  'USERS', 'PRODUCTS', 'CATEGORIES', 'UNITS', 'SATUAN_ALIAS',
  'WAREHOUSES', 'SUPPLIERS', 'STOCK_BATCHES', 'STOCK_BALANCES',
  'STOCK_TRANSACTIONS', 'STOCK_OPNAMES', 'STOCK_OPNAME_ITEMS',
  'AUDIT_LOGS', 'BACKUP_LOGS',
];

function dataRows(content) {
  const normalized = content.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  const lines = normalized.endsWith('\n') ? normalized.slice(0, -1).split('\n') : normalized.split('\n');
  return Math.max(0, lines.length - 1);
}

const [spreadsheetId = process.env.SPREADSHEET_ID || 'PENDING-SPREADSHEET-ID',
       exportedAt = process.env.EXPORTED_AT || new Date().toISOString()] = process.argv.slice(2);

if (!/^[a-zA-Z0-9._-]{6,64}$/.test(spreadsheetId)) {
  console.error('spreadsheetId must be a real Google Sheets ID (argument or SPREADSHEET_ID env).');
  process.exit(1);
}

const entries = [];
for (const sheet of SHEETS) {
  const file = `${sheet}.csv`;
  try {
    const bytes = await readFile(join(process.cwd(), file));
    const info = await stat(join(process.cwd(), file));
    if (info.mode & 0o222) {
      console.error(`${file} is writable; chmod 0444 first for immutable export.`);
      process.exit(1);
    }
    const text = bytes.toString('utf8');
    entries.push({
      sheet,
      status: 'PRESENT',
      spreadsheetId,
      exportFile: file,
      bytes: bytes.length,
      rowCount: dataRows(text),
      sha256: createHash('sha256').update(bytes).digest('hex'),
      exportedAt,
    });
  } catch (error) {
    if (error.code === 'ENOENT') {
      entries.push({ sheet, status: 'SOURCE_ABSENT' });
    } else {
      throw error;
    }
  }
}

const manifest = {
  version: 1,
  sourceRevision: `manual-${Date.now()}`,
  exportedAt,
  sheets: entries,
};

await writeFile(
  join(process.cwd(), 'source-manifest.json'),
  `${JSON.stringify(manifest, null, 2)}\n`,
  { mode: 0o444 },
);
console.log(`source-manifest.json written: ${entries.filter((e) => e.status === 'PRESENT').length} present, ${entries.filter((e) => e.status === 'SOURCE_ABSENT').length} absent.`);
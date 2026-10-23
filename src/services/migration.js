import { createHash } from 'node:crypto';
import {
  lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile,
} from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

const INVENTORY = Object.freeze([
  'USERS', 'PRODUCTS', 'CATEGORIES', 'UNITS', 'SATUAN_ALIAS',
  'WAREHOUSES', 'SUPPLIERS', 'STOCK_BATCHES', 'STOCK_BALANCES',
  'STOCK_TRANSACTIONS', 'STOCK_OPNAMES', 'STOCK_OPNAME_ITEMS',
  'AUDIT_LOGS', 'BACKUP_LOGS',
]);
const ERROR_HEADER = [
  'sheet', 'row_number', 'source_key', 'error_code', 'field',
  'raw_value', 'normalized_value', 'message',
];
const MAX_CONFIG_BYTES = 1024 * 1024;
const MAX_CSV_BYTES = 10 * 1024 * 1024;
const MAX_FIELD_BYTES = 4 * 1024;
const MAX_ROW_CHARACTERS = 65_536;
const MAX_ROWS = 100_000;
const RAW_ROW = Symbol('rawRow');
const NORMALIZATION_RULES = new Set([
  'trim', 'code', 'name', 'lowercase', 'email', 'date', 'decimal-id', 'boolean',
]);
const SENSITIVE_FIELD = /(?:^|[_\s-])(?:password|passwd|pwd|passphrase|secrets?|tokens?|sessions?|cookies?|csrf|authorization|credentials?|(?:api|private|access|ssh)[_\s-]?key|database[_\s-]?url)(?:$|[_\s-])/i;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function isIsoDateTime(value) {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/.exec(value);
  if (!match || Number.isNaN(Date.parse(value))) return false;
  const [, year, month, day] = match.map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

function fail(message) {
  throw new Error(message);
}

function hasOnlyKeys(value, allowed) {
  return Object.keys(value).every((key) => allowed.includes(key));
}

async function jsonFile(path, label, readOnly = false) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_CONFIG_BYTES) {
    fail(`Invalid ${label} file.`);
  }
  if (readOnly && info.mode & 0o222) fail('Source manifest is not read-only.');
  let value;
  try {
    value = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    fail(`Invalid ${label} JSON.`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`Invalid ${label}.`);
  return value;
}

export function parseMigrationCsv(content) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let closed = false;
  let rowCharacters = 0;
  let rowStart = 0;
  const append = (value) => {
    field += value;
    if (Buffer.byteLength(field, 'utf8') > MAX_FIELD_BYTES) fail('CSV field exceeds 4 KiB.');
  };
  for (let index = 0; index < content.length; index += 1) {
    const character = content[index];
    rowCharacters += 1;
    if (rowCharacters > MAX_ROW_CHARACTERS) fail('CSV row is too large.');
    if (quoted) {
      if (character === '"' && content[index + 1] === '"') {
        append('"');
        index += 1;
        rowCharacters += 1;
        if (rowCharacters > MAX_ROW_CHARACTERS) fail('CSV row is too large.');
      } else if (character === '"') {
        quoted = false;
        closed = true;
      } else {
        append(character);
      }
    } else if (closed && ![',', '\n', '\r'].includes(character)) {
      fail('Malformed CSV quoting.');
    } else if (character === '"') {
      if (field) fail('Malformed CSV quoting.');
      quoted = true;
    } else if (character === ',') {
      row.push(field);
      field = '';
      closed = false;
    } else if (character === '\n' || character === '\r') {
      if (character === '\r' && content[index + 1] === '\n') {
        index += 1;
        rowCharacters += 1;
        if (rowCharacters > MAX_ROW_CHARACTERS) fail('CSV row is too large.');
      }
      row.push(field);
      Object.defineProperty(row, RAW_ROW, { value: content.slice(rowStart, index + 1) });
      rows.push(row);
      if (rows.length > MAX_ROWS + 1) fail('CSV exceeds 100,000 data rows.');
      row = [];
      field = '';
      closed = false;
      rowCharacters = 0;
      rowStart = index + 1;
    } else {
      append(character);
    }
  }
  if (quoted) fail('Unclosed CSV quote.');
  if (field || row.length) {
    const finalRow = [...row, field];
    Object.defineProperty(finalRow, RAW_ROW, { value: content.slice(rowStart) });
    rows.push(finalRow);
    if (rows.length > MAX_ROWS + 1) fail('CSV exceeds 100,000 data rows.');
  }
  if (!rows.length) fail('CSV header is missing.');
  const width = rows[0].length;
  if (!width || rows[0].some((value) => !value.trim())) fail('CSV header is invalid.');
  if (new Set(rows[0].map((value) => value.trim())).size !== width) fail('CSV header is duplicated.');
  if (rows.some((value) => value.length !== width && value.some((fieldValue) => fieldValue !== ''))) {
    fail('CSV row width mismatch.');
  }
  return rows;
}

function normalize(value, rule = 'trim') {
  const trimmed = String(value ?? '').trim();
  if (rule === 'trim') return trimmed;
  if (rule === 'code') return trimmed.toUpperCase();
  if (rule === 'name') return trimmed.replace(/\s+/g, ' ');
  if (rule === 'lowercase' || rule === 'email') return trimmed.toLowerCase();
  if (rule === 'date') {
    if (!trimmed) return '';
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
    if (!match) fail(`Invalid date value: ${trimmed}`);
    const [, year, month, day] = match.map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
      fail(`Invalid date value: ${trimmed}`);
    }
    return trimmed;
  }
  if (rule === 'decimal-id') {
    const indonesian = /^-?(?:0|[1-9]\d*|[1-9]\d{0,2}(?:\.\d{3})+)(?:,\d+)?$/;
    const grouped = /^-?[1-9]\d{0,2}(?:\.\d{3})+$/;
    const canonical = /^-?(?:\d+(?:\.\d*)?|\.\d+)$/;
    if (trimmed.includes(',') && !indonesian.test(trimmed)) fail(`Invalid decimal value: ${trimmed}`);
    const normalized = trimmed.includes(',')
      ? trimmed.replaceAll('.', '').replace(',', '.')
      : grouped.test(trimmed) ? trimmed.replaceAll('.', '') : trimmed;
    if (normalized && !canonical.test(normalized)) {
      fail(`Invalid decimal value: ${trimmed}`);
    }
    return normalized;
  }
  if (rule === 'boolean') {
    const booleans = new Map([
      ['true', 'true'], ['1', 'true'], ['yes', 'true'], ['ya', 'true'],
      ['false', 'false'], ['0', 'false'], ['no', 'false'], ['tidak', 'false'],
    ]);
    if (trimmed && !booleans.has(trimmed.toLowerCase())) fail(`Invalid boolean value: ${trimmed}`);
    return trimmed ? booleans.get(trimmed.toLowerCase()) : '';
  }
  fail(`Unknown normalization rule: ${rule}`);
}

function csvCell(value) {
  const raw = String(value ?? '');
  const text = /^\s*[=+\-@]/.test(raw) ? `'${raw}` : raw;
  return /[",\r\n]/.test(text) || /^\s|\s$/.test(raw)
    ? `"${text.replaceAll('"', '""')}"` : text;
}

function csv(rows) {
  return `${rows.map((row) => row.map(csvCell).join(',')).join('\n')}\n`;
}

function validateManifest(manifest) {
  if (manifest.version !== 1 || typeof manifest.sourceRevision !== 'string'
      || !manifest.sourceRevision.trim() || typeof manifest.exportedAt !== 'string'
      || !isIsoDateTime(manifest.exportedAt) || !Array.isArray(manifest.sheets)) {
    fail('Invalid source manifest.');
  }
  const bySheet = new Map();
  for (const entry of manifest.sheets) {
    if (!entry || !INVENTORY.includes(entry.sheet) || bySheet.has(entry.sheet)
        || !['PRESENT', 'SOURCE_ABSENT'].includes(entry.status)) fail('Invalid source manifest inventory.');
    bySheet.set(entry.sheet, entry);
  }
  if (bySheet.size !== INVENTORY.length) fail('Source manifest inventory is incomplete.');
  return bySheet;
}

function validateMapping(mapping) {
  if (mapping.version !== 1 || !Array.isArray(mapping.requiredSheets)
      || !mapping.sheets || typeof mapping.sheets !== 'object' || Array.isArray(mapping.sheets)
      || !hasOnlyKeys(mapping, ['version', 'requiredSheets', 'sheets'])) {
    fail('Invalid migration mapping.');
  }
  for (const sheet of mapping.requiredSheets) {
    if (!INVENTORY.includes(sheet) || !mapping.sheets[sheet]) fail('Invalid required sheet mapping.');
  }
  for (const [sheet, config] of Object.entries(mapping.sheets)) {
    if (!INVENTORY.includes(sheet) || !config || !Array.isArray(config.key)
        || !config.key.length || !config.fields || typeof config.fields !== 'object'
        || Array.isArray(config.fields) || (config.unique !== undefined && !Array.isArray(config.unique))
        || (config.references !== undefined && !Array.isArray(config.references))
        || !hasOnlyKeys(config, ['key', 'fields', 'unique', 'references'])) {
      fail(`Invalid mapping: ${sheet}`);
    }
    for (const [field, spec] of Object.entries(config.fields)) {
      if (!field || !spec || typeof spec.source !== 'string' || !spec.source
          || typeof spec !== 'object' || Array.isArray(spec)
          || (spec.normalize !== undefined && !NORMALIZATION_RULES.has(spec.normalize))
          || (spec.required !== undefined && typeof spec.required !== 'boolean')
          || !hasOnlyKeys(spec, ['source', 'normalize', 'required'])) {
        fail(`Invalid field mapping: ${sheet}.${field}`);
      }
      if (SENSITIVE_FIELD.test(field) || SENSITIVE_FIELD.test(spec.source)) {
        fail(`Sensitive field mapping is forbidden: ${sheet}.${field}`);
      }
    }
    if (config.key.some((field) => typeof field !== 'string'
        || !Object.hasOwn(config.fields, field) || config.fields[field].required !== true)
        || (config.unique || []).some((field) => typeof field !== 'string'
          || !Object.hasOwn(config.fields, field))) fail(`Invalid mapping: ${sheet}`);
  }
  for (const [sheet, config] of Object.entries(mapping.sheets)) {
    for (const reference of config.references || []) {
      const target = reference && mapping.sheets[reference.sheet];
      const targetIdentity = target && ((target.key.length === 1 && target.key[0] === reference.target)
        || (target.unique || []).includes(reference.target));
      if (!reference || typeof reference.field !== 'string'
          || !Object.hasOwn(config.fields, reference.field) || !target
          || typeof reference.target !== 'string' || !Object.hasOwn(target.fields, reference.target)
          || !targetIdentity
          || (reference.errorCode !== undefined && typeof reference.errorCode !== 'string')
          || !hasOnlyKeys(reference, ['field', 'sheet', 'target', 'errorCode'])) {
        fail(`Invalid mapping: ${sheet}`);
      }
    }
  }
}

async function loadSource(source, mapping, manifest, bySheet) {
  const inventory = [];
  const datasets = new Map();
  for (const sheet of INVENTORY) {
    const entry = bySheet.get(sheet);
    if (entry.status === 'SOURCE_ABSENT') {
      if (mapping.requiredSheets.includes(sheet)) fail(`Required sheet absent: ${sheet}`);
      let existing;
      try {
        existing = await lstat(join(source, `${sheet}.csv`));
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      if (existing) fail(`Source manifest marks existing export absent: ${sheet}`);
      inventory.push({ sheet, status: 'SOURCE_ABSENT' });
      continue;
    }
    if (!mapping.sheets[sheet]) fail(`Missing mapping for present sheet: ${sheet}`);
    if (entry.exportFile !== `${sheet}.csv` || typeof entry.spreadsheetId !== 'string'
        || !entry.spreadsheetId.trim() || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0
        || !Number.isSafeInteger(entry.rowCount) || entry.rowCount < 0
        || !/^[a-f0-9]{64}$/.test(entry.sha256 || '')
        || !isIsoDateTime(entry.exportedAt)) {
      fail(`Invalid source manifest entry: ${sheet}`);
    }
    const path = resolve(source, entry.exportFile);
    if (dirname(path) !== source || basename(path) !== entry.exportFile) fail(`Invalid export path: ${sheet}`);
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_CSV_BYTES) fail(`Invalid export file: ${sheet}`);
    if (info.mode & 0o222) fail(`Source export is not read-only: ${entry.exportFile}`);
    const bytes = await readFile(path);
    if (bytes.length !== entry.bytes) fail(`Manifest byte count mismatch: ${entry.exportFile}`);
    if (sha256(bytes) !== entry.sha256) fail(`Checksum mismatch: ${entry.exportFile}`);
    let rawContent;
    try {
      rawContent = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      fail(`Export is not UTF-8: ${entry.exportFile}`);
    }
    const content = rawContent.replace(/^\uFEFF/, '');
    const rows = parseMigrationCsv(content);
    const rawHeader = rawContent.slice(0, rows[0][RAW_ROW].length + (rawContent.startsWith('\uFEFF') ? 1 : 0));
    const header = rows[0].map((value) => value.trim());
    const sensitiveHeader = header.find((value) => SENSITIVE_FIELD.test(value));
    if (sensitiveHeader) fail(`Sensitive source header is forbidden: ${sheet}.${sensitiveHeader}`);
    const dataRows = rows.slice(1);
    if (dataRows.length !== entry.rowCount) fail(`Manifest row count mismatch: ${entry.exportFile}`);
    const records = dataRows
      .map((raw, index) => ({ raw, rowNumber: index + 2 }))
      .filter(({ raw }) => raw.some((value) => value !== ''));
    datasets.set(sheet, { header, records });
    inventory.push({
      sheet, status: 'PRESENT', spreadsheetId: entry.spreadsheetId,
      exportFile: entry.exportFile, fileSize: bytes.length, sha256: entry.sha256,
      headerHash: sha256(rawHeader), rowCount: dataRows.length,
      nonEmptyRowCount: records.length, exportedAt: entry.exportedAt,
    });
  }
  return { inventory, datasets };
}

function transform(mapping, datasets) {
  const errors = [];
  const transformed = new Map();
  const maps = [];
  const sourceRows = {};
  const skippedRows = new Set();
  for (const [sheet, config] of Object.entries(mapping.sheets)) {
    const source = datasets.get(sheet);
    if (!source) continue;
    sourceRows[sheet] = source.records.length;
    const positions = new Map(source.header.map((name, index) => [name, index]));
    for (const spec of Object.values(config.fields)) {
      if (!positions.has(spec.source)) fail(`Missing mapped header: ${sheet}.${spec.source}`);
    }
    const candidates = source.records.map(({ raw, rowNumber }) => {
      const row = {};
      const errorStart = errors.length;
      for (const [field, spec] of Object.entries(config.fields)) {
        const rawValue = raw[positions.get(spec.source)];
        try {
          row[field] = normalize(rawValue, spec.normalize);
        } catch (error) {
          errors.push([sheet, rowNumber, '', 'NORMALIZATION_ERROR', field, rawValue, '', error.message]);
          row[field] = '';
        }
        if (spec.required && !row[field]) {
          errors.push([sheet, rowNumber, '', 'REQUIRED_FIELD', field, rawValue, row[field], `${field} is required.`]);
        }
      }
      const keyValues = config.key.map((field) => row[field]);
      const key = keyValues.length === 1 ? keyValues[0] : JSON.stringify(keyValues);
      for (let index = errorStart; index < errors.length; index += 1) errors[index][2] = key;
      return {
        row, raw, rowNumber, key, hash: sha256(raw[RAW_ROW]), valid: errors.length === errorStart,
      };
    });
    const stableKeys = new Map();
    const rows = [];
    for (const item of candidates) {
      const first = stableKeys.get(item.key);
      if (first?.hash === item.hash && first.valid && item.valid) {
        skippedRows.add(`${sheet}:${item.rowNumber}`);
        rows.push(item);
        continue;
      }
      rows.push(item);
      maps.push([sheet, item.row.id || item.key, item.row.code || '', '', item.hash]);
      if (first && first.hash !== item.hash) {
        for (const candidate of [first, item]) {
          errors.push([sheet, candidate.rowNumber, candidate.key, 'STABLE_KEY_PAYLOAD_CONFLICT',
            config.key.join('|'), candidate.key, candidate.key, 'Stable key has different payloads.']);
        }
      } else if (!first) stableKeys.set(item.key, item);
    }
    transformed.set(sheet, rows);
    for (const field of config.unique || []) {
      const seen = new Map();
      for (const item of rows) {
        if (skippedRows.has(`${sheet}:${item.rowNumber}`)) continue;
        if (!item.row[field]) continue;
        const first = seen.get(item.row[field]);
        if (first) {
          const code = field === 'code' ? 'NORMALIZED_CODE_COLLISION' : 'NORMALIZED_UNIQUE_COLLISION';
          const message = `${field} collides after normalization.`;
          for (const candidate of [first, item]) {
            errors.push([sheet, candidate.rowNumber, candidate.key, code, field,
              candidate.raw[positionsFor(source).get(config.fields[field].source)], candidate.row[field], message]);
          }
        } else seen.set(item.row[field], item);
      }
    }
  }
  const invalidRows = new Set(errors.map((error) => `${error[0]}:${error[1]}`));
  const referenceErrors = new Set();
  let changed;
  do {
    changed = false;
    for (const [sheet, config] of Object.entries(mapping.sheets)) {
      const source = datasets.get(sheet);
      const positions = source && positionsFor(source);
      for (const reference of config.references || []) {
        const targets = new Set((transformed.get(reference.sheet) || [])
          .filter(({ rowNumber }) => !invalidRows.has(`${reference.sheet}:${rowNumber}`))
          .map(({ row }) => row[reference.target]));
        for (const item of transformed.get(sheet) || []) {
          if (!item.row[reference.field] || targets.has(item.row[reference.field])) continue;
          const finding = `${sheet}:${item.rowNumber}:${reference.field}:${reference.sheet}`;
          if (!referenceErrors.has(finding)) {
            const rawValue = item.raw[positions.get(config.fields[reference.field].source)];
            errors.push([sheet, item.rowNumber, item.key, reference.errorCode || 'REFERENCE_NOT_FOUND',
              reference.field, rawValue, item.row[reference.field], 'Referenced row was not found.']);
            referenceErrors.add(finding);
          }
          const rowIdentity = `${sheet}:${item.rowNumber}`;
          if (!invalidRows.has(rowIdentity)) {
            invalidRows.add(rowIdentity);
            changed = true;
          }
        }
      }
    }
  } while (changed);
  for (const rowIdentity of invalidRows) skippedRows.delete(rowIdentity);
  return { errors, maps, transformed, sourceRows, skippedRows };
}

function positionsFor(source) {
  return new Map(source.header.map((name, index) => [name, index]));
}

async function writeEvidence(output, manifest, inventory, result) {
  await mkdir(dirname(output), { recursive: true });
  const temporary = await mkdtemp(join(dirname(output), '.migration-evidence-'));
  const invalidRows = new Set(result.errors.map((error) => `${error[0]}:${error[1]}`));
  const conflictRows = new Set(result.errors
    .filter((error) => error[3].includes('COLLISION') || error[3].includes('CONFLICT'))
    .map((error) => `${error[0]}:${error[1]}`));
  const total = Object.values(result.sourceRows).reduce((sum, value) => sum + value, 0);
  const skippedRows = result.skippedRows.size;
  const reconciliation = {
    status: result.errors.length ? 'FAIL' : 'PASS',
    acceptedRows: total - invalidRows.size - skippedRows,
    reviewRows: 0,
    rejectedRows: invalidRows.size - conflictRows.size,
    conflictRows: conflictRows.size,
    skippedRows,
    sourceRows: result.sourceRows,
  };
  const inventoryDocument = {
    sourceRevision: manifest.sourceRevision,
    exportedAt: manifest.exportedAt || null,
    sheets: inventory,
  };
  try {
    await Promise.all([
      writeFile(join(temporary, 'inventory.json'), `${JSON.stringify(inventoryDocument, null, 2)}\n`),
      writeFile(join(temporary, 'id-map-preview.csv'), csv([
        ['entity', 'source_id', 'source_code', 'target_id', 'source_hash'], ...result.maps,
      ])),
      writeFile(join(temporary, 'validation-errors.csv'), csv([ERROR_HEADER, ...result.errors])),
      writeFile(join(temporary, 'reconciliation-preview.json'), `${JSON.stringify(reconciliation, null, 2)}\n`),
      writeFile(join(temporary, 'migration-report.md'), [
        '# Migration Dry Run', '', `Source revision: \`${manifest.sourceRevision}\``,
        `Status: ${reconciliation.status}`, '', `Accepted rows: ${reconciliation.acceptedRows}`,
        `Rejected rows: ${reconciliation.rejectedRows}`, `Conflict rows: ${reconciliation.conflictRows}`, '',
        'No source or target mutation was performed.', '',
      ].join('\n')),
    ]);
    await rename(temporary, output);
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
  return reconciliation;
}

async function canonicalPath(path) {
  const missing = [];
  let cursor = path;
  while (true) {
    try {
      return resolve(await realpath(cursor), ...missing.reverse());
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = dirname(cursor);
      if (parent === cursor) throw error;
      missing.push(basename(cursor));
      cursor = parent;
    }
  }
}

export async function migrationDryRun({ sourceDirectory, outputDirectory, mappingPath }) {
  const source = await realpath(resolve(sourceDirectory));
  const output = await canonicalPath(resolve(outputDirectory));
  if (source === output || output.startsWith(`${source}/`) || source.startsWith(`${output}/`)) {
    fail('Evidence output must be outside source directory.');
  }
  const [manifest, mapping] = await Promise.all([
    jsonFile(join(source, 'source-manifest.json'), 'source manifest', true),
    jsonFile(resolve(mappingPath), 'migration mapping'),
  ]);
  const bySheet = validateManifest(manifest);
  validateMapping(mapping);
  const { inventory, datasets } = await loadSource(source, mapping, manifest, bySheet);
  const result = transform(mapping, datasets);
  const reconciliation = await writeEvidence(output, manifest, inventory, result);
  return { ...reconciliation, outputDirectory: output };
}

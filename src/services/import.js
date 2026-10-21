import { createHash, randomUUID } from 'node:crypto';
import { authorize, CAPABILITIES } from '../http/middleware/rbac.js';
import {
  currentImportActor, insertImportAudit, insertImportBatch, insertOcrStagingRows,
  insertReadyImportRows, loadImportReferences,
} from '../repositories/imports.js';

const MAX_BYTES = 1024 * 1024;
const MAX_ROWS = 100_000;
const MAX_FIELD_BYTES = 4 * 1024;
const MAX_ROW_CHARACTERS = 65_536;

function assertFieldSize(field) {
  if (Buffer.byteLength(field, 'utf8') > MAX_FIELD_BYTES) {
    throw fault(413, 'IMPORT_FIELD_TOO_LARGE', 'CSV field exceeds 4 KiB.');
  }
}
const HEADERS = Object.freeze({
  PRODUCTS: ['code', 'name', 'category', 'unit', 'minimum_stock', 'maximum_stock', 'barcode'],
  STOCKIN: [
    'date', 'reference', 'supplier', 'warehouse', 'code', 'batch',
    'production_date', 'expiry', 'quantity', 'unit', 'price', 'notes',
  ],
  STAGING_OCR: [
    'source_pdf', 'page', 'category', 'description_raw', 'quantity',
    'unit_raw', 'unit_price', 'line_total', 'review_status', 'notes',
  ],
});

function fault(status, errorCode, message, details = {}) {
  return Object.assign(new Error(message), { status, errorCode, details });
}

function parseCsv(content) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let closedQuote = false;
  let rowSize = 0;
  for (let index = 0; index < content.length; index += 1) {
    const character = content[index];
    rowSize += 1;
    if (rowSize > MAX_ROW_CHARACTERS) {
      throw fault(413, 'IMPORT_ROW_TOO_LARGE', 'CSV row is too large.');
    }
    if (quoted) {
      if (character === '"' && content[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
        closedQuote = true;
      } else {
        field += character;
      }
      continue;
    }
    if (closedQuote && character !== ',' && character !== '\n' && character !== '\r') {
      throw fault(400, 'IMPORT_CSV_MALFORMED', 'Malformed CSV quoting.');
    }
    if (character === '"') {
      if (field) throw fault(400, 'IMPORT_CSV_MALFORMED', 'Malformed CSV quoting.');
      quoted = true;
    } else if (character === ',') {
      assertFieldSize(field);
      row.push(field);
      field = '';
      closedQuote = false;
    } else if (character === '\n' || character === '\r') {
      if (character === '\r' && content[index + 1] === '\n') index += 1;
      assertFieldSize(field);
      row.push(field);
      rows.push(row);
      if (rows.length > MAX_ROWS + 1) {
        throw fault(413, 'IMPORT_TOO_MANY_ROWS', 'CSV exceeds 100,000 data rows.');
      }
      row = [];
      field = '';
      closedQuote = false;
      rowSize = 0;
    } else {
      field += character;
    }
  }
  if (quoted) throw fault(400, 'IMPORT_CSV_MALFORMED', 'Unclosed CSV quote.');
  if (field || row.length) {
    assertFieldSize(field);
    row.push(field);
    rows.push(row);
    if (rows.length > MAX_ROWS + 1) {
      throw fault(413, 'IMPORT_TOO_MANY_ROWS', 'CSV exceeds 100,000 data rows.');
    }
  }
  while (rows.length && rows.at(-1).every((value) => value === '')) rows.pop();
  if (!rows.length) throw fault(422, 'IMPORT_HEADER_INVALID', 'CSV header is missing.');
  return rows;
}

function canonical(value) {
  return String(value ?? '').trim().toLowerCase();
}

function reference(rows, value, fields = ['code', 'name']) {
  const wanted = canonical(value);
  return wanted ? rows.find((row) => fields.some((field) => canonical(row[field]) === wanted)) : null;
}

function issue(code, message) {
  return { code, message };
}

function validDate(value, optional = false) {
  if (!value) return optional;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

function validNumber(value, minimum, optional = false) {
  if (value === '') return optional;
  return /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?$/i.test(value)
    && Number.isFinite(Number(value))
    && Number(value) >= minimum;
}

function dateOrNull(value) {
  return validDate(value, true) && value ? value : null;
}

function numberOrNull(value) {
  return validNumber(value, -Number.MAX_VALUE) ? value : null;
}

function validateProduct(row, refs) {
  const errors = [];
  if (!row.code || !row.name) errors.push(issue('INVALID_PRODUCT', 'Product code and name are required.'));
  if (!reference(refs.categories, row.category)) errors.push(issue('CATEGORY_NOT_FOUND', 'Category was not found.'));
  if (!resolveUnit(refs, row.unit)) errors.push(issue('UNIT_NOT_FOUND', 'Unit was not found.'));
  if (!validNumber(row.minimum_stock, 0) || !validNumber(row.maximum_stock, 0)) {
    errors.push(issue('INVALID_QUANTITY', 'Stock limits must be non-negative numbers.'));
  }
  if (reference(refs.products, row.code)) errors.push(issue('IMPORT_DUPLICATE', 'Product already exists.'));
  return errors;
}

function resolveUnit(refs, value) {
  return reference(refs.units, value, ['code', 'name', 'symbol'])
    || reference(refs.aliases, value, ['alias']);
}

function validateStockIn(row, refs, regionId) {
  const errors = [];
  if (!validDate(row.date)) errors.push(issue('INVALID_DATE', 'Transaction date is invalid.'));
  if (!row.reference) errors.push(issue('INVALID_REFERENCE', 'Reference is required.'));
  if (row.supplier && !reference(refs.suppliers, row.supplier)) {
    errors.push(issue('INVALID_SUPPLIER', 'Supplier was not found.'));
  }
  const warehouse = reference(refs.warehouses, row.warehouse);
  if (!warehouse || warehouse.region_id !== regionId) {
    errors.push(issue('INVALID_WAREHOUSE', 'Warehouse is outside the user region or was not found.'));
  }
  if (!reference(refs.products, row.code)) errors.push(issue('INVALID_PRODUCT', 'Product was not found.'));
  if (!resolveUnit(refs, row.unit)) errors.push(issue('UNIT_NOT_FOUND', 'Unit was not found.'));
  if (!validDate(row.production_date, true) || !validDate(row.expiry, true)) {
    errors.push(issue('INVALID_DATE', 'Production or expiry date is invalid.'));
  }
  if (!validNumber(row.quantity, Number.EPSILON)) errors.push(issue('INVALID_QUANTITY', 'Quantity must be positive.'));
  if (!validNumber(row.price, 0)) errors.push(issue('INVALID_PRICE', 'Price must be non-negative.'));
  return errors;
}

function validateOcr(row, refs) {
  const errors = [];
  if (!reference(refs.categories, row.category)) errors.push(issue('CATEGORY_NOT_FOUND', 'Category was not found.'));
  if (!resolveUnit(refs, row.unit_raw)) errors.push(issue('UNIT_NOT_FOUND', 'Unit was not found.'));
  if (!validNumber(row.page, 1) || !Number.isInteger(Number(row.page))) errors.push(issue('INVALID_PAGE', 'Page must be a positive integer.'));
  for (const field of ['quantity', 'unit_price', 'line_total']) {
    if (!validNumber(row[field], 0, true)) errors.push(issue('INVALID_NUMBER', `${field} must be non-negative.`));
  }
  if (!['READY', 'REVIEW', 'REJECTED'].includes(row.review_status.toUpperCase())) {
    errors.push(issue('INVALID_REVIEW_STATUS', 'OCR review status is invalid.'));
  }
  return errors;
}

function readyStorage(type, row, rowNumber, status, errors) {
  const common = {
    row_number: rowNumber, status,
    error_code: errors[0]?.code || null,
    error_message: errors.map((error) => error.message).join(' ') || null,
  };
  if (type === 'STOCKIN') return {
    ...common,
    ...row,
    date: dateOrNull(row.date),
    production_date: dateOrNull(row.production_date),
    expiry: dateOrNull(row.expiry),
    quantity: numberOrNull(row.quantity),
    price: numberOrNull(row.price),
  };
  return {
    ...common,
    code: row.code,
    reference: row.name,
    supplier: row.category,
    unit: row.unit,
    quantity: numberOrNull(row.minimum_stock),
    price: numberOrNull(row.maximum_stock),
    batch: row.barcode || null,
  };
}

function ocrStorage(row, status) {
  return {
    ...row,
    page: validNumber(row.page, 1) && Number.isInteger(Number(row.page)) ? row.page : null,
    quantity: numberOrNull(row.quantity),
    unit_price: numberOrNull(row.unit_price),
    line_total: numberOrNull(row.line_total),
    review_status: status === 'REJECTED' ? 'REJECTED' : status,
  };
}

function validateInput(input) {
  const allowed = ['type', 'fileName', 'fileHash', 'content'];
  if (!input || Object.keys(input).some((key) => !allowed.includes(key))) {
    throw fault(400, 'VALIDATION_ERROR', 'Invalid import preview request.');
  }
  if (!Object.hasOwn(HEADERS, input.type) || typeof input.fileName !== 'string'
      || typeof input.fileHash !== 'string' || typeof input.content !== 'string') {
    throw fault(400, 'VALIDATION_ERROR', 'Import type, file name, hash, and content are required.');
  }
  if (!/^[a-f0-9]{64}$/i.test(input.fileHash)) throw fault(400, 'VALIDATION_ERROR', 'Invalid SHA-256 hash.');
  if (input.content.includes('\0')) throw fault(400, 'IMPORT_CSV_MALFORMED', 'CSV contains a NUL character.');
  const bytes = Buffer.byteLength(input.content, 'utf8');
  if (bytes > MAX_BYTES) throw fault(413, 'IMPORT_FILE_TOO_LARGE', 'CSV exceeds 1 MiB.');
  if (input.type === 'STOCKIN' && !/^STOCK_IN_IMPORT_.+_READY\.csv$/i.test(input.fileName)) {
    throw fault(422, 'IMPORT_FILENAME_INVALID', 'READY stock-in filename is invalid.');
  }
  if (input.type === 'STAGING_OCR' && !/^STOCK_IN_REVIEW_.+\.csv$/i.test(input.fileName)) {
    throw fault(422, 'IMPORT_FILENAME_INVALID', 'OCR staging filename is invalid.');
  }
}

export async function previewImport(pool, sessionActor, input) {
  validateInput(input);
  const computedHash = createHash('sha256').update(input.content, 'utf8').digest('hex');
  if (computedHash !== input.fileHash.toLowerCase()) {
    throw fault(409, 'IMPORT_HASH_MISMATCH', 'CSV content does not match fileHash.');
  }
  const parsed = parseCsv(input.content);
  const headers = parsed.shift().map((header, index) => canonical(index ? header : header.replace(/^\ufeff/, '')));
  const expected = HEADERS[input.type];
  if (headers.length !== expected.length || headers.some((header, index) => header !== expected[index])) {
    throw fault(422, 'IMPORT_HEADER_INVALID', 'CSV header does not match import type.', { expected, actual: headers });
  }
  if (parsed.some((columns) => columns.length !== headers.length)) {
    throw fault(400, 'IMPORT_CSV_MALFORMED', 'CSV row column count does not match header.');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const actor = await currentImportActor(client, sessionActor?.userId);
    authorize(actor, CAPABILITIES.IMPORT_CONFIRM);
    const refs = await loadImportReferences(client);
    const rows = parsed.map((columns, index) => {
      const row = Object.fromEntries(headers.map((header, column) => [header, columns[column].trim()]));
      let errors;
      if (input.type === 'PRODUCTS') errors = validateProduct(row, refs);
      else if (input.type === 'STOCKIN') errors = validateStockIn(row, refs, actor.regionId);
      else errors = validateOcr(row, refs);
      const requested = input.type === 'STAGING_OCR' ? row.review_status.toUpperCase() : 'READY';
      const status = requested === 'REJECTED' ? 'REJECTED' : (errors.length || requested === 'REVIEW' ? 'REVIEW' : 'READY');
      return { rowNumber: index + 2, ...row, status, errors };
    });
    const reviewCount = rows.filter((row) => row.status === 'REVIEW').length;
    const rejectedCount = rows.filter((row) => row.status === 'REJECTED').length;
    const status = reviewCount ? 'REVIEW' : (rejectedCount ? 'REJECTED' : 'READY');
    const batchId = randomUUID();
    const batch = await insertImportBatch(client, {
      id: batchId, type: input.type, fileName: input.fileName, fileHash: computedHash,
      status, rowCount: rows.length, createdBy: actor.userId,
    });
    if (input.type === 'STAGING_OCR') {
      await insertOcrStagingRows(
        client, batchId, computedHash, actor.userId,
        rows.map((row) => ocrStorage(row, row.status)),
      );
    } else {
      await insertReadyImportRows(
        client, batchId, computedHash,
        rows.map((row) => readyStorage(input.type, row, row.rowNumber, row.status, row.errors)),
      );
    }
    await insertImportAudit(client, {
      userId: actor.userId,
      batchId,
      details: { type: input.type, fileHash: computedHash, rowCount: rows.length, reviewCount, rejectedCount },
    });
    await client.query('COMMIT');
    return {
      batchId,
      previewVersion: String(batch.preview_version),
      type: input.type,
      fileName: input.fileName,
      fileHash: computedHash,
      status,
      rowCount: rows.length,
      readyCount: rows.length - reviewCount - rejectedCount,
      reviewCount,
      rejectedCount,
      headers,
      rows,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.code === '23505' && error.constraint === 'import_batches_file_hash_import_type_key') {
      throw fault(409, 'IMPORT_DUPLICATE', 'This file was already previewed for the import type.');
    }
    throw error;
  } finally {
    client.release();
  }
}

import { once } from 'node:events';
import { authorize, CAPABILITIES } from '../http/middleware/rbac.js';
import { listStock, listTransactions } from './report.js';

export const REPORT_TYPES = Object.freeze([
  'STOCK', 'STOCK_CARD', 'IN', 'OUT', 'ADJUSTMENT',
  'OPNAME', 'OPNAME_DIFFERENCE', 'BATCH_EXPIRY',
]);
const reportTypes = new Set(REPORT_TYPES);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const opnameStatuses = new Set(['DRAFT', 'COUNTING', 'SUBMITTED', 'APPROVED', 'REJECTED']);
const expiryStatuses = new Set([
  'EXPIRED', 'EXPIRING_7D', 'EXPIRING_30D', 'OVER_30D', 'NO_EXPIRY',
  'ACTIVE', 'DEPLETED', 'INACTIVE',
]);

function fault(status, errorCode, message) {
  return Object.assign(new Error(message), { status, errorCode });
}

function typeOf(value) {
  const type = String(value || '').trim().toUpperCase();
  if (!reportTypes.has(type)) throw fault(400, 'REPORT_TYPE_UNSUPPORTED', 'Unsupported report type.');
  return type;
}

function uuid(value, field) {
  if (value === undefined || value === null || value === '') return null;
  const normalized = String(value).trim();
  if (!uuidPattern.test(normalized)) throw fault(400, 'VALIDATION_ERROR', `Invalid ${field}.`);
  return normalized;
}

function date(value, field) {
  if (value === undefined || value === null || value === '') return null;
  const normalized = String(value).trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(normalized);
  const instant = match
    ? new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))) : null;
  if (!instant || instant.toISOString().slice(0, 10) !== normalized) {
    throw fault(400, 'VALIDATION_ERROR', `Invalid ${field}.`);
  }
  return normalized;
}

function options(raw) {
  const page = Number(raw.page ?? 1);
  const limit = Number(raw.limit ?? 50);
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(limit)
      || limit < 1 || limit > 500 || !Number.isSafeInteger((page - 1) * limit)) {
    throw fault(400, 'VALIDATION_ERROR', 'Invalid pagination.');
  }
  const exactDate = date(raw.date, 'date');
  const from = date(raw.from ?? exactDate, 'from');
  const to = date(raw.to ?? exactDate, 'to');
  if (from && to && from > to) throw fault(400, 'VALIDATION_ERROR', 'from must not exceed to.');
  const status = raw.status ? String(raw.status).trim().toUpperCase() : null;
  if (status && status.length > 30) throw fault(400, 'VALIDATION_ERROR', 'Invalid status.');
  return {
    page, limit, from, to, status,
    product_id: uuid(raw.product_id ?? raw.product, 'product_id'),
    category_id: uuid(raw.category_id ?? raw.category, 'category_id'),
    warehouse_id: uuid(raw.warehouse_id ?? raw.warehouse, 'warehouse_id'),
    supplier_id: uuid(raw.supplier_id ?? raw.supplier, 'supplier_id'),
  };
}

async function actorFor(pool, sessionActor) {
  const row = (await pool.query(
    "SELECT id, role, region_id FROM users WHERE id = $1 AND status = 'ACTIVE'",
    [sessionActor?.userId],
  )).rows[0];
  const actor = row ? { userId: row.id, role: row.role, regionId: row.region_id } : null;
  authorize(actor, CAPABILITIES.REPORT_READ);
  return actor;
}

async function assertWarehouse(pool, actor, warehouseId) {
  if (!warehouseId) return;
  const row = (await pool.query('SELECT region_id FROM warehouses WHERE id = $1', [warehouseId])).rows[0];
  if (!row) throw fault(422, 'INVALID_WAREHOUSE', 'Warehouse does not exist.');
  if (row.region_id !== actor.regionId) {
    throw fault(403, 'REGION_FORBIDDEN', 'Warehouse is outside the user region.');
  }
}

function builder(regionId, regionClause) {
  const values = [regionId];
  const clauses = [regionClause];
  return {
    values,
    clauses,
    add(clause, value) {
      if (!clause.includes('?')) return clauses.push(clause);
      values.push(value);
      clauses.push(clause.replaceAll('?', `$${values.length}`));
    },
  };
}

function page(items, total, value) {
  return {
    items, page: value.page, limit: value.limit, total,
    hasNext: value.page * value.limit < total,
  };
}

async function queryOpnames(pool, actor, value, differences) {
  if (value.status && !opnameStatuses.has(value.status)) {
    throw fault(400, 'VALIDATION_ERROR', 'Invalid opname status.');
  }
  const b = builder(actor.regionId, 'warehouses.region_id = $1');
  if (value.from) b.add('opnames.opname_date >= ?::date', value.from);
  if (value.to) b.add('opnames.opname_date <= ?::date', value.to);
  if (value.product_id) b.add(differences
    ? 'items.product_id = ?'
    : `EXISTS (
      SELECT 1 FROM stock_opname_items filter_items
      WHERE filter_items.opname_id = opnames.id AND filter_items.product_id = ?
    )`, value.product_id);
  if (value.category_id) b.add(differences
    ? 'products.category_id = ?'
    : `EXISTS (
      SELECT 1 FROM stock_opname_items filter_items
      JOIN products filter_products ON filter_products.id = filter_items.product_id
      WHERE filter_items.opname_id = opnames.id AND filter_products.category_id = ?
    )`, value.category_id);
  if (value.warehouse_id) b.add('opnames.warehouse_id = ?', value.warehouse_id);
  if (value.status) b.add('opnames.status = ?', value.status);
  if (differences) b.add('items.difference <> 0');
  const joins = differences ? `
    FROM stock_opname_items items
    JOIN stock_opnames opnames ON opnames.id = items.opname_id
    JOIN products ON products.id = items.product_id
    JOIN categories ON categories.id = products.category_id
    JOIN warehouses ON warehouses.id = opnames.warehouse_id
    LEFT JOIN stock_batches batches ON batches.id = items.batch_id
  ` : `
    FROM stock_opnames opnames
    JOIN warehouses ON warehouses.id = opnames.warehouse_id
    JOIN users creators ON creators.id = opnames.created_by
  `;
  const where = `WHERE ${b.clauses.join(' AND ')}`;
  const listValues = [...b.values, value.limit, (value.page - 1) * value.limit];
  const select = differences ? `
    SELECT items.id, opnames.id AS opname_id, opnames.opname_number,
      to_char(opnames.opname_date, 'YYYY-MM-DD') AS date, opnames.status,
      products.id AS product_id, products.code AS product_code, products.name AS product_name,
      warehouses.id AS warehouse_id, warehouses.code AS warehouse_code,
      batches.batch_number, trim_scale(items.system_quantity)::text AS system_quantity,
      trim_scale(items.physical_quantity)::text AS physical_quantity,
      trim_scale(items.difference)::text AS difference,
      trim_scale(items.difference_value)::text AS difference_value,
      items.unit, items.reason
  ` : `
    SELECT opnames.id, opnames.opname_number,
      to_char(opnames.opname_date, 'YYYY-MM-DD') AS date, opnames.status,
      warehouses.id AS warehouse_id, warehouses.code AS warehouse_code,
      warehouses.name AS warehouse_name, creators.name AS creator_name,
      opnames.notes, opnames.rejection_reason
  `;
  const [count, rows] = await Promise.all([
    pool.query(`SELECT count(*)::int AS total ${joins} ${where}`, b.values),
    pool.query(`${select} ${joins} ${where}
      ORDER BY opnames.opname_date DESC, opnames.opname_number, ${differences ? 'items.id' : 'opnames.id'}
      LIMIT $${listValues.length - 1} OFFSET $${listValues.length}`, listValues),
  ]);
  return page(rows.rows.map((row) => ({
    id: row.id,
    opnameId: row.opname_id ?? row.id,
    opnameNumber: row.opname_number,
    date: row.date,
    status: row.status,
    productId: row.product_id,
    productCode: row.product_code,
    productName: row.product_name,
    warehouseId: row.warehouse_id,
    warehouseCode: row.warehouse_code,
    warehouseName: row.warehouse_name,
    batchNumber: row.batch_number,
    systemQuantity: row.system_quantity,
    physicalQuantity: row.physical_quantity,
    difference: row.difference,
    differenceValue: row.difference_value,
    unit: row.unit,
    reason: row.reason,
    creatorName: row.creator_name,
    notes: row.notes,
    rejectionReason: row.rejection_reason,
  })), count.rows[0].total, value);
}

async function queryExpiry(pool, actor, value) {
  if (value.status && !expiryStatuses.has(value.status)) {
    throw fault(400, 'VALIDATION_ERROR', 'Invalid expiry status.');
  }
  const b = builder(actor.regionId, 'warehouses.region_id = $1');
  if (value.from) b.add('batches.expiry_date >= ?::date', value.from);
  if (value.to) b.add('batches.expiry_date <= ?::date', value.to);
  if (value.product_id) b.add('batches.product_id = ?', value.product_id);
  if (value.category_id) b.add('products.category_id = ?', value.category_id);
  if (value.warehouse_id) b.add('batches.warehouse_id = ?', value.warehouse_id);
  if (['ACTIVE', 'DEPLETED', 'INACTIVE'].includes(value.status)) b.add('batches.status = ?', value.status);
  else if (value.status === 'EXPIRED') b.add('batches.expiry_date < current_date');
  else if (value.status === 'EXPIRING_7D') b.add('batches.expiry_date BETWEEN current_date AND current_date + 7');
  else if (value.status === 'EXPIRING_30D') b.add('batches.expiry_date BETWEEN current_date AND current_date + 30');
  else if (value.status === 'OVER_30D') b.add('batches.expiry_date > current_date + 30');
  else if (value.status === 'NO_EXPIRY') b.add('batches.expiry_date IS NULL');
  const from = `
    FROM stock_batches batches
    JOIN products ON products.id = batches.product_id
    JOIN categories ON categories.id = products.category_id
    JOIN warehouses ON warehouses.id = batches.warehouse_id
    WHERE ${b.clauses.join(' AND ')}
  `;
  const listValues = [...b.values, value.limit, (value.page - 1) * value.limit];
  const [count, rows] = await Promise.all([
    pool.query(`SELECT count(*)::int AS total ${from}`, b.values),
    pool.query(`SELECT batches.id, batches.batch_number,
      to_char(batches.production_date, 'YYYY-MM-DD') AS production_date,
      to_char(batches.expiry_date, 'YYYY-MM-DD') AS expiry_date,
      trim_scale(batches.quantity)::text AS quantity, batches.unit, batches.status,
      products.id AS product_id, products.code AS product_code, products.name AS product_name,
      warehouses.id AS warehouse_id, warehouses.code AS warehouse_code,
      CASE WHEN batches.expiry_date IS NULL THEN 'NO_EXPIRY'
        WHEN batches.expiry_date < current_date THEN 'EXPIRED'
        WHEN batches.expiry_date <= current_date + 7 THEN 'EXPIRING_7D'
        WHEN batches.expiry_date <= current_date + 30 THEN 'EXPIRING_30D'
        ELSE 'OVER_30D' END AS expiry_status
      ${from}
      ORDER BY batches.expiry_date ASC NULLS LAST, products.code, batches.id
      LIMIT $${listValues.length - 1} OFFSET $${listValues.length}`, listValues),
  ]);
  return page(rows.rows.map((row) => ({
    id: row.id,
    productId: row.product_id,
    productCode: row.product_code,
    productName: row.product_name,
    warehouseId: row.warehouse_id,
    warehouseCode: row.warehouse_code,
    batchNumber: row.batch_number,
    productionDate: row.production_date,
    expiryDate: row.expiry_date,
    quantity: row.quantity,
    unit: row.unit,
    status: row.status,
    expiryStatus: row.expiry_status,
  })), count.rows[0].total, value);
}

export async function listReport(pool, sessionActor, rawType, rawOptions = {}) {
  const reportType = typeOf(rawType);
  const value = options(rawOptions);
  const actor = await actorFor(pool, sessionActor);
  await assertWarehouse(pool, actor, value.warehouse_id);
  if (reportType === 'STOCK') {
    return listStock(pool, actor, value, CAPABILITIES.REPORT_READ);
  }
  if (['STOCK_CARD', 'IN', 'OUT', 'ADJUSTMENT'].includes(reportType)) {
    const transactionType = reportType === 'STOCK_CARD' ? null : reportType;
    return listTransactions(pool, actor, {
      ...value, type: transactionType,
    }, CAPABILITIES.REPORT_READ);
  }
  if (reportType === 'OPNAME') return queryOpnames(pool, actor, value, false);
  if (reportType === 'OPNAME_DIFFERENCE') return queryOpnames(pool, actor, value, true);
  return queryExpiry(pool, actor, value);
}

const csvColumns = Object.freeze({
  STOCK: [
    ['productCode', 'product_code'], ['productName', 'product_name'],
    ['categoryName', 'category'], ['warehouseCode', 'warehouse'],
    ['quantity', 'quantity'], ['unit', 'unit'], ['minimumStock', 'minimum_stock'],
    ['maximumStock', 'maximum_stock'], ['status', 'status'],
  ],
  STOCK_CARD: [
    ['date', 'date'], ['transactionNumber', 'transaction_number'],
    ['transactionType', 'type'], ['reference', 'reference'], ['productCode', 'product_code'],
    ['productName', 'product_name'], ['warehouseCode', 'warehouse'],
    ['quantity', 'quantity'], ['unit', 'unit'], ['balanceBefore', 'balance_before'],
    ['balanceAfter', 'balance_after'], ['supplierName', 'supplier'], ['reason', 'reason'],
  ],
  OPNAME: [
    ['date', 'date'], ['opnameNumber', 'opname_number'], ['warehouseCode', 'warehouse'],
    ['warehouseName', 'warehouse_name'], ['status', 'status'], ['creatorName', 'creator'],
    ['notes', 'notes'], ['rejectionReason', 'rejection_reason'],
  ],
  OPNAME_DIFFERENCE: [
    ['date', 'date'], ['opnameNumber', 'opname_number'], ['productCode', 'product_code'],
    ['productName', 'product_name'], ['warehouseCode', 'warehouse'],
    ['batchNumber', 'batch'], ['systemQuantity', 'system_quantity'],
    ['physicalQuantity', 'physical_quantity'], ['difference', 'difference'],
    ['differenceValue', 'difference_value'], ['unit', 'unit'], ['reason', 'reason'],
  ],
  BATCH_EXPIRY: [
    ['productCode', 'product_code'], ['productName', 'product_name'],
    ['warehouseCode', 'warehouse'], ['batchNumber', 'batch'],
    ['productionDate', 'production_date'], ['expiryDate', 'expiry_date'],
    ['expiryStatus', 'expiry_status'], ['quantity', 'quantity'], ['unit', 'unit'],
    ['status', 'status'],
  ],
});

function columns(type) {
  return csvColumns[type] ?? csvColumns.STOCK_CARD;
}

function csvCell(value) {
  let textValue = value === undefined || value === null ? '' : String(value);
  if (/^\s*[=+\-@]/.test(textValue)) textValue = `'${textValue}`;
  return `"${textValue.replaceAll('"', '""')}"`;
}

async function write(response, textValue) {
  if (!response.write(textValue)) await once(response, 'drain');
}

export async function exportReportCsv(pool, sessionActor, rawType, rawOptions, response) {
  const reportType = typeOf(rawType);
  const format = String(rawOptions.format || '').trim().toUpperCase();
  if (format !== 'CSV') throw fault(400, 'REPORT_FORMAT_UNSUPPORTED', 'Only CSV is supported.');
  const selected = columns(reportType);
  const fileDate = new Date().toISOString().slice(0, 10);
  let pageNumber = 1;
  let result = await listReport(pool, sessionActor, reportType, {
    ...rawOptions, page: pageNumber, limit: 500,
  });
  response.writeHead(200, {
    'content-type': 'text/csv; charset=utf-8',
    'content-disposition': `attachment; filename="${reportType.toLowerCase()}-${fileDate}.csv"`,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  await write(response, `${selected.map(([, heading]) => csvCell(heading)).join(',')}\r\n`);
  while (!response.destroyed) {
    for (const item of result.items) {
      await write(response, `${selected.map(([key]) => csvCell(item[key])).join(',')}\r\n`);
    }
    if (!result.hasNext) break;
    pageNumber += 1;
    result = await listReport(pool, sessionActor, reportType, {
      ...rawOptions, page: pageNumber, limit: 500,
    });
  }
  response.end();
}

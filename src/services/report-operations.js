import { authorize, CAPABILITIES } from '../http/middleware/rbac.js';
import { listStock, listTransactions, stockCard } from './report.js';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const reportTypes = new Set([
  'STOCK', 'STOCK_CARD', 'IN', 'OUT', 'ADJUSTMENT', 'OPNAME',
  'OPNAME_DIFFERENCE', 'BATCH_EXPIRY',
]);
const opnameStatuses = new Set(['DRAFT', 'COUNTING', 'SUBMITTED', 'APPROVED', 'REJECTED']);
const batchStatuses = new Set(['ACTIVE', 'DEPLETED', 'INACTIVE']);

function fault(status, errorCode, message, details = {}) {
  return Object.assign(new Error(message), { status, errorCode, details });
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
  if (!match) throw fault(400, 'VALIDATION_ERROR', `Invalid ${field}.`);
  const instant = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (instant.toISOString().slice(0, 10) !== normalized) {
    throw fault(400, 'VALIDATION_ERROR', `Invalid ${field}.`);
  }
  return normalized;
}

function pagination(options) {
  const page = Number(options.page ?? 1);
  const limit = Number(options.limit ?? 50);
  const offset = (page - 1) * limit;
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(limit)
    || limit < 1 || limit > 500 || !Number.isSafeInteger(offset)) {
    throw fault(400, 'VALIDATION_ERROR', 'Invalid pagination.');
  }
  return { page, limit, offset };
}

function list(items, total, page, limit) {
  return { items, page, limit, total, hasNext: page * limit < total };
}

async function actorWithCapability(pool, sessionActor, capability) {
  const result = await pool.query(
    "SELECT id, role, region_id FROM users WHERE id = $1 AND status = 'ACTIVE'",
    [sessionActor?.userId],
  );
  const row = result.rows[0];
  const actor = row ? { userId: row.id, role: row.role, regionId: row.region_id } : null;
  authorize(actor, capability);
  return actor;
}

async function options(pool, actor, raw) {
  const parsed = {
    ...raw,
    from: date(raw.from, 'from'),
    to: date(raw.to, 'to'),
    product_id: uuid(raw.product_id, 'product_id'),
    category_id: uuid(raw.category_id, 'category_id'),
    supplier_id: uuid(raw.supplier_id, 'supplier_id'),
    warehouse_id: uuid(raw.warehouse_id, 'warehouse_id'),
    status: raw.status ? String(raw.status).trim().toUpperCase() : null,
  };
  if (parsed.from && parsed.to && parsed.from > parsed.to) {
    throw fault(400, 'VALIDATION_ERROR', 'from must not exceed to.');
  }
  if (parsed.warehouse_id) {
    const warehouse = (await pool.query(
      'SELECT id, region_id FROM warehouses WHERE id = $1', [parsed.warehouse_id],
    )).rows[0];
    if (!warehouse) throw fault(422, 'INVALID_WAREHOUSE', 'Warehouse does not exist.');
    if (warehouse.region_id !== actor.regionId) {
      throw fault(403, 'REGION_FORBIDDEN', 'Warehouse is outside the user region.');
    }
  }
  return parsed;
}

function builder(regionId) {
  const values = [regionId];
  const clauses = ['warehouses.region_id = $1'];
  return {
    values,
    clauses,
    add(clause, value) {
      values.push(value);
      clauses.push(clause.replaceAll('?', `$${values.length}`));
    },
  };
}

export async function dashboard(pool, sessionActor) {
  const actor = await actorWithCapability(pool, sessionActor, CAPABILITIES.DASHBOARD_READ);
  const [stock, expiry, opnames, recent, adjustment] = await Promise.all([
    pool.query(`
      WITH inventory AS (
        SELECT balances.product_id, sum(balances.quantity) AS quantity,
          max(products.minimum_stock) AS minimum_stock
        FROM stock_balances balances
        JOIN products ON products.id = balances.product_id
        JOIN warehouses ON warehouses.id = balances.warehouse_id
        WHERE warehouses.region_id = $1
        GROUP BY balances.product_id
      )
      SELECT count(*)::int AS total_products,
        trim_scale(coalesce(sum(quantity), 0))::text AS total_stock,
        count(*) FILTER (WHERE quantity > minimum_stock)::int AS safe,
        count(*) FILTER (WHERE quantity > 0 AND quantity <= minimum_stock)::int AS low,
        count(*) FILTER (WHERE quantity = 0)::int AS out
      FROM inventory
    `, [actor.regionId]),
    pool.query(`
      SELECT
        count(*) FILTER (WHERE batches.expiry_date < CURRENT_DATE)::int AS expired,
        count(*) FILTER (WHERE batches.expiry_date BETWEEN CURRENT_DATE AND CURRENT_DATE + 7)::int AS expiring_7d,
        count(*) FILTER (WHERE batches.expiry_date > CURRENT_DATE + 7
          AND batches.expiry_date <= CURRENT_DATE + 30)::int AS expiring_30d
      FROM stock_batches batches
      JOIN warehouses ON warehouses.id = batches.warehouse_id
      WHERE warehouses.region_id = $1 AND batches.quantity > 0
    `, [actor.regionId]),
    pool.query(`
      SELECT count(*)::int AS pending_opnames
      FROM stock_opnames opnames
      JOIN warehouses ON warehouses.id = opnames.warehouse_id
      WHERE warehouses.region_id = $1 AND opnames.status <> 'APPROVED'
    `, [actor.regionId]),
    pool.query(`
      SELECT transactions.id, transactions.transaction_type,
        to_char(transactions.transaction_date, 'YYYY-MM-DD') AS date,
        transactions.reference_id, products.code AS product_code,
        products.name AS product_name, warehouses.code AS warehouse_code,
        trim_scale(transactions.quantity)::text AS quantity, transactions.unit
      FROM stock_transactions transactions
      JOIN products ON products.id = transactions.product_id
      JOIN warehouses ON warehouses.id = transactions.warehouse_id
      WHERE warehouses.region_id = $1
      ORDER BY transactions.transaction_date DESC, transactions.ledger_sequence DESC
      LIMIT 10
    `, [actor.regionId]),
    pool.query(`
      SELECT trim_scale(coalesce(sum(abs(transactions.quantity)), 0))::text AS total_adjustment
      FROM stock_transactions transactions
      JOIN warehouses ON warehouses.id = transactions.warehouse_id
      WHERE warehouses.region_id = $1 AND transactions.transaction_type = 'ADJUSTMENT'
    `, [actor.regionId]),
  ]);
  return {
    ...stock.rows[0],
    ...expiry.rows[0],
    ...opnames.rows[0],
    recent_transactions: recent.rows.map((row) => ({
      id: row.id, transactionType: row.transaction_type, date: row.date,
      reference: row.reference_id, productCode: row.product_code,
      productName: row.product_name, warehouseCode: row.warehouse_code,
      quantity: row.quantity, unit: row.unit,
    })),
    total_adjustment: adjustment.rows[0].total_adjustment,
  };
}

function reportType(value) {
  const normalized = String(value || '').toUpperCase();
  if (!reportTypes.has(normalized)) throw fault(400, 'VALIDATION_ERROR', 'Invalid report type.');
  return normalized;
}

async function opnameReport(pool, actor, parsed, differencesOnly) {
  const page = pagination(parsed);
  if (parsed.status && !opnameStatuses.has(parsed.status)) {
    throw fault(400, 'VALIDATION_ERROR', 'Invalid status.');
  }
  const query = builder(actor.regionId);
  if (parsed.from) query.add('opnames.opname_date >= ?::date', parsed.from);
  if (parsed.to) query.add('opnames.opname_date <= ?::date', parsed.to);
  if (parsed.warehouse_id) query.add('opnames.warehouse_id = ?', parsed.warehouse_id);
  if (parsed.status) query.add('opnames.status = ?', parsed.status);
  if (parsed.product_id) query.add('items.product_id = ?', parsed.product_id);
  if (parsed.category_id) query.add('products.category_id = ?', parsed.category_id);
  if (differencesOnly) query.clauses.push('items.difference <> 0');
  const joins = differencesOnly || parsed.product_id || parsed.category_id
    ? `JOIN stock_opname_items items ON items.opname_id = opnames.id
       JOIN products ON products.id = items.product_id
       LEFT JOIN stock_batches batches ON batches.id = items.batch_id`
    : '';
  const from = `
    FROM stock_opnames opnames
    JOIN warehouses ON warehouses.id = opnames.warehouse_id
    ${joins}
    WHERE ${query.clauses.join(' AND ')}
  `;
  const values = [...query.values, page.limit, page.offset];
  const selection = differencesOnly ? `
    items.id, opnames.opname_number, to_char(opnames.opname_date, 'YYYY-MM-DD') AS date,
    opnames.status, products.id AS product_id, products.code AS product_code,
    products.name AS product_name, warehouses.id AS warehouse_id,
    warehouses.code AS warehouse_code, batches.batch_number,
    trim_scale(items.system_quantity)::text AS system_quantity,
    trim_scale(items.physical_quantity)::text AS physical_quantity,
    trim_scale(items.difference)::text AS difference,
    trim_scale(items.difference_value)::text AS difference_value,
    items.unit, items.reason
  ` : `
    opnames.id, opnames.opname_number, to_char(opnames.opname_date, 'YYYY-MM-DD') AS date,
    opnames.status, opnames.warehouse_id, warehouses.code AS warehouse_code,
    warehouses.name AS warehouse_name, opnames.snapshot_version,
    opnames.submitted_at, opnames.approved_at
  `;
  const [count, rows] = await Promise.all([
    pool.query(`SELECT count(DISTINCT ${differencesOnly ? 'items.id' : 'opnames.id'})::int AS total ${from}`, query.values),
    pool.query(`SELECT DISTINCT ${selection} ${from}
      ORDER BY date DESC, opnames.opname_number, ${differencesOnly ? 'items.id' : 'opnames.id'}
      LIMIT $${values.length - 1} OFFSET $${values.length}`, values),
  ]);
  const items = rows.rows.map((row) => differencesOnly ? ({
    id: row.id, opnameNumber: row.opname_number, date: row.date, status: row.status,
    productId: row.product_id, productCode: row.product_code, productName: row.product_name,
    warehouseId: row.warehouse_id, warehouseCode: row.warehouse_code,
    batchNumber: row.batch_number, systemQuantity: row.system_quantity,
    physicalQuantity: row.physical_quantity, difference: row.difference,
    differenceValue: row.difference_value, unit: row.unit, reason: row.reason,
  }) : ({
    id: row.id, opnameNumber: row.opname_number, date: row.date, status: row.status,
    warehouseId: row.warehouse_id, warehouseCode: row.warehouse_code,
    warehouseName: row.warehouse_name, snapshotVersion: String(row.snapshot_version),
    submittedAt: row.submitted_at, approvedAt: row.approved_at,
  }));
  return list(items, count.rows[0].total, page.page, page.limit);
}

async function expiryReport(pool, actor, parsed) {
  const page = pagination(parsed);
  if (parsed.status && !batchStatuses.has(parsed.status)) {
    throw fault(400, 'VALIDATION_ERROR', 'Invalid status.');
  }
  const query = builder(actor.regionId);
  if (parsed.from) query.add('batches.expiry_date >= ?::date', parsed.from);
  if (parsed.to) query.add('batches.expiry_date <= ?::date', parsed.to);
  if (parsed.product_id) query.add('batches.product_id = ?', parsed.product_id);
  if (parsed.category_id) query.add('products.category_id = ?', parsed.category_id);
  if (parsed.warehouse_id) query.add('batches.warehouse_id = ?', parsed.warehouse_id);
  if (parsed.status) query.add('batches.status = ?', parsed.status);
  const from = `
    FROM stock_batches batches
    JOIN products ON products.id = batches.product_id
    JOIN warehouses ON warehouses.id = batches.warehouse_id
    WHERE ${query.clauses.join(' AND ')}
  `;
  const values = [...query.values, page.limit, page.offset];
  const [count, rows] = await Promise.all([
    pool.query(`SELECT count(*)::int AS total ${from}`, query.values),
    pool.query(`
      SELECT batches.id, products.id AS product_id, products.code AS product_code,
        products.name AS product_name, warehouses.id AS warehouse_id,
        warehouses.code AS warehouse_code, batches.batch_number,
        to_char(batches.production_date, 'YYYY-MM-DD') AS production_date,
        to_char(batches.expiry_date, 'YYYY-MM-DD') AS expiry_date,
        trim_scale(batches.quantity)::text AS quantity, batches.unit, batches.status,
        CASE WHEN batches.expiry_date < CURRENT_DATE THEN 'EXPIRED'
          WHEN batches.expiry_date <= CURRENT_DATE + 7 THEN 'EXPIRING_7D'
          WHEN batches.expiry_date <= CURRENT_DATE + 30 THEN 'EXPIRING_30D'
          WHEN batches.expiry_date IS NULL THEN 'NO_EXPIRY'
          ELSE 'VALID' END AS expiry_status
      ${from}
      ORDER BY batches.expiry_date NULLS LAST, products.code, batches.id
      LIMIT $${values.length - 1} OFFSET $${values.length}
    `, values),
  ]);
  return list(rows.rows.map((row) => ({
    id: row.id, productId: row.product_id, productCode: row.product_code,
    productName: row.product_name, warehouseId: row.warehouse_id,
    warehouseCode: row.warehouse_code, batchNumber: row.batch_number,
    productionDate: row.production_date, expiryDate: row.expiry_date,
    quantity: row.quantity, unit: row.unit, status: row.status, expiryStatus: row.expiry_status,
  })), count.rows[0].total, page.page, page.limit);
}

export async function inventoryReport(pool, sessionActor, rawType, rawOptions = {}) {
  const actor = await actorWithCapability(pool, sessionActor, CAPABILITIES.REPORT_READ);
  const type = reportType(rawType);
  const parsed = await options(pool, actor, rawOptions);
  if (type === 'STOCK') return listStock(pool, actor, parsed);
  if (type === 'STOCK_CARD') {
    if (!parsed.product_id) throw fault(400, 'VALIDATION_ERROR', 'product_id is required.');
    return stockCard(pool, actor, parsed.product_id, parsed);
  }
  if (['IN', 'OUT', 'ADJUSTMENT'].includes(type)) {
    return listTransactions(pool, actor, { ...parsed, type });
  }
  if (type === 'OPNAME') return opnameReport(pool, actor, parsed, false);
  if (type === 'OPNAME_DIFFERENCE') return opnameReport(pool, actor, parsed, true);
  return expiryReport(pool, actor, parsed);
}

const csvColumns = Object.freeze({
  STOCK: ['productCode', 'productName', 'categoryCode', 'warehouseCode', 'quantity', 'unit', 'minimumStock', 'maximumStock', 'status'],
  STOCK_CARD: ['date', 'transactionType', 'reference', 'productCode', 'productName', 'warehouseCode', 'batchId', 'quantity', 'unit', 'runningBalance', 'userName'],
  IN: ['date', 'transactionNumber', 'reference', 'productCode', 'productName', 'warehouseCode', 'supplierCode', 'batchId', 'quantity', 'unit', 'balanceAfter', 'userName'],
  OUT: ['date', 'transactionNumber', 'reference', 'productCode', 'productName', 'warehouseCode', 'batchId', 'quantity', 'unit', 'balanceAfter', 'userName'],
  ADJUSTMENT: ['date', 'transactionNumber', 'reference', 'productCode', 'productName', 'warehouseCode', 'batchId', 'quantity', 'unit', 'balanceAfter', 'reason', 'userName'],
  OPNAME: ['opnameNumber', 'date', 'status', 'warehouseCode', 'warehouseName', 'snapshotVersion', 'submittedAt', 'approvedAt'],
  OPNAME_DIFFERENCE: ['opnameNumber', 'date', 'status', 'productCode', 'productName', 'warehouseCode', 'batchNumber', 'systemQuantity', 'physicalQuantity', 'difference', 'differenceValue', 'unit', 'reason'],
  BATCH_EXPIRY: ['productCode', 'productName', 'warehouseCode', 'batchNumber', 'productionDate', 'expiryDate', 'quantity', 'unit', 'status', 'expiryStatus'],
});

function csvCell(value) {
  let textValue = value === null || value === undefined ? '' : String(value);
  if (/^[\s]*[=+\-@]/.test(textValue)) textValue = `'${textValue}`;
  return /[",\r\n]/.test(textValue) ? `"${textValue.replaceAll('"', '""')}"` : textValue;
}

export async function streamInventoryReportCsv(pool, sessionActor, rawType, rawOptions, write) {
  const type = reportType(rawType);
  const columns = csvColumns[type];
  let page = 1;
  let result = await inventoryReport(pool, sessionActor, type, {
    ...rawOptions, format: undefined, page, limit: 500,
  });
  await write(`${columns.join(',')}\r\n`);
  while (true) {
    for (const item of result.items) {
      await write(`${columns.map((column) => csvCell(item[column])).join(',')}\r\n`);
    }
    if (!result.hasNext) break;
    page += 1;
    result = await inventoryReport(pool, sessionActor, type, {
      ...rawOptions, format: undefined, page, limit: 500,
    });
  }
}

import { authorize, CAPABILITIES } from '../http/middleware/rbac.js';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const transactionTypes = new Set(['IN', 'OUT', 'OPENING', 'ADJUSTMENT', 'REVERSAL']);
const productStatuses = new Set(['ACTIVE', 'INACTIVE', 'REVIEW']);
const stockStatuses = new Set(['SAFE', 'LOW', 'OUT']);

function fault(status, errorCode, message, details = {}) {
  return Object.assign(new Error(message), { status, errorCode, details });
}

function uuid(value, field) {
  if (value === undefined || value === null || value === '') return null;
  const normalized = String(value).trim();
  if (!uuidPattern.test(normalized)) {
    throw fault(400, 'VALIDATION_ERROR', `Invalid ${field}.`);
  }
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

function text(value, field, max = 100) {
  if (value === undefined || value === null || value === '') return null;
  const normalized = String(value).trim();
  if (!normalized || normalized.length > max) {
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

function like(value) {
  return `%${value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
}

function queryBuilder(regionId) {
  const values = [regionId];
  const clauses = ['warehouses.region_id = $1'];
  return {
    values,
    clauses,
    add(clause, value) {
      if (!clause.includes('?')) {
        clauses.push(clause);
        return;
      }
      values.push(value);
      clauses.push(clause.replaceAll('?', `$${values.length}`));
    },
  };
}

async function currentActor(pool, sessionActor, capability = CAPABILITIES.STOCK_READ) {
  const result = await pool.query(
    "SELECT id, role, region_id FROM users WHERE id = $1 AND status = 'ACTIVE'",
    [sessionActor?.userId],
  );
  const row = result.rows[0];
  const actor = row ? { userId: row.id, role: row.role, regionId: row.region_id } : null;
  authorize(actor, capability);
  return actor;
}

async function warehouseFilter(pool, actor, value) {
  const id = uuid(value, 'warehouse_id');
  if (!id) return null;
  const row = (await pool.query('SELECT id, region_id FROM warehouses WHERE id = $1', [id])).rows[0];
  if (!row) throw fault(422, 'INVALID_WAREHOUSE', 'Warehouse does not exist.');
  if (row.region_id !== actor.regionId) {
    throw fault(403, 'REGION_FORBIDDEN', 'Warehouse is outside the user region.');
  }
  return id;
}

function transactionOptions(raw) {
  const options = { ...raw };
  options.from = date(options.from, 'from');
  options.to = date(options.to, 'to');
  if (options.from && options.to && options.from > options.to) {
    throw fault(400, 'VALIDATION_ERROR', 'from must not exceed to.');
  }
  options.type = text(options.type, 'type')?.toUpperCase() ?? null;
  if (options.type && !transactionTypes.has(options.type)) {
    throw fault(400, 'VALIDATION_ERROR', 'Invalid type.');
  }
  options.product_id = uuid(options.product_id, 'product_id');
  options.category_id = uuid(options.category_id, 'category_id');
  options.supplier_id = uuid(options.supplier_id, 'supplier_id');
  options.q = text(options.q, 'q');
  return options;
}

function transactionFilters(builder, options) {
  if (options.from) builder.add('transactions.transaction_date >= ?::date', options.from);
  if (options.to) builder.add('transactions.transaction_date <= ?::date', options.to);
  if (options.type) builder.add('transactions.transaction_type = ?', options.type);
  if (options.product_id) builder.add('transactions.product_id = ?', options.product_id);
  if (options.category_id) builder.add('products.category_id = ?', options.category_id);
  if (options.warehouse_id) builder.add('transactions.warehouse_id = ?', options.warehouse_id);
  if (options.supplier_id) builder.add('transactions.supplier_id = ?', options.supplier_id);
  if (options.q) builder.add(`(
    transactions.transaction_number ILIKE ? ESCAPE '\\'
    OR transactions.reference_id ILIKE ? ESCAPE '\\'
    OR products.code ILIKE ? ESCAPE '\\'
    OR products.name ILIKE ? ESCAPE '\\'
    OR warehouses.code ILIKE ? ESCAPE '\\'
    OR coalesce(suppliers.code, '') ILIKE ? ESCAPE '\\'
  )`, like(options.q));
}

function transactionItem(row) {
  return {
    id: row.id,
    transactionNumber: row.transaction_number,
    transactionType: row.transaction_type,
    date: row.transaction_date_text,
    reference: row.reference_id,
    productId: row.product_id,
    productCode: row.product_code,
    productName: row.product_name,
    warehouseId: row.warehouse_id,
    warehouseCode: row.warehouse_code,
    warehouseName: row.warehouse_name,
    supplierId: row.supplier_id,
    supplierCode: row.supplier_code,
    supplierName: row.supplier_name,
    batchId: row.batch_id,
    quantity: row.quantity_text,
    unit: row.unit,
    balanceBefore: row.balance_before_text,
    balanceAfter: row.balance_after_text,
    reason: row.reason,
    userId: row.user_id,
    userName: row.user_name,
    createdAt: row.created_at,
  };
}

function stockCardItem(row) {
  const item = transactionItem(row);
  item.balanceBefore = row.running_balance_before_text;
  item.balanceAfter = row.running_balance_text;
  item.runningBalance = row.running_balance_text;
  return item;
}

const transactionJoins = `
  FROM stock_transactions transactions
  JOIN products ON products.id = transactions.product_id
  JOIN warehouses ON warehouses.id = transactions.warehouse_id
  JOIN users ON users.id = transactions.user_id
  LEFT JOIN suppliers ON suppliers.id = transactions.supplier_id
`;
const transactionSelect = `
  SELECT transactions.*,
    to_char(transactions.transaction_date, 'YYYY-MM-DD') AS transaction_date_text,
    trim_scale(transactions.quantity)::text AS quantity_text,
    trim_scale(transactions.balance_before)::text AS balance_before_text,
    trim_scale(transactions.balance_after)::text AS balance_after_text,
    products.code AS product_code, products.name AS product_name,
    warehouses.code AS warehouse_code, warehouses.name AS warehouse_name,
    suppliers.code AS supplier_code, suppliers.name AS supplier_name, users.name AS user_name
`;

export async function listStock(
  pool, sessionActor, rawOptions = {}, capability = CAPABILITIES.STOCK_READ,
) {
  const actor = await currentActor(pool, sessionActor, capability);
  const page = pagination(rawOptions);
  const options = {
    productId: uuid(rawOptions.product_id, 'product_id'),
    categoryId: uuid(rawOptions.category_id, 'category_id'),
    warehouseId: await warehouseFilter(pool, actor, rawOptions.warehouse_id),
    status: text(rawOptions.status, 'status')?.toUpperCase() ?? null,
    q: text(rawOptions.q, 'q'),
  };
  if (options.status && !productStatuses.has(options.status) && !stockStatuses.has(options.status)) {
    throw fault(400, 'VALIDATION_ERROR', 'Invalid status.');
  }
  const builder = queryBuilder(actor.regionId);
  if (options.productId) builder.add('balances.product_id = ?', options.productId);
  if (options.warehouseId) builder.add('balances.warehouse_id = ?', options.warehouseId);
  if (options.categoryId) builder.add('products.category_id = ?', options.categoryId);
  if (productStatuses.has(options.status)) builder.add('products.status = ?', options.status);
  else if (options.status === 'SAFE') builder.add('balances.quantity > products.minimum_stock', null);
  else if (options.status === 'LOW') {
    builder.add('balances.quantity > 0 AND balances.quantity <= products.minimum_stock', null);
  } else if (options.status === 'OUT') builder.add('balances.quantity = 0', null);
  if (options.q) builder.add(`(
    products.code ILIKE ? ESCAPE '\\' OR products.name ILIKE ? ESCAPE '\\'
    OR warehouses.code ILIKE ? ESCAPE '\\' OR warehouses.name ILIKE ? ESCAPE '\\'
  )`, like(options.q));
  const from = `
    FROM stock_balances balances
    JOIN products ON products.id = balances.product_id
    JOIN categories ON categories.id = products.category_id
    JOIN units ON units.id = products.base_unit_id
    JOIN warehouses ON warehouses.id = balances.warehouse_id
    WHERE ${builder.clauses.join(' AND ')}
  `;
  const listValues = [...builder.values, page.limit, page.offset];
  const [count, rows] = await Promise.all([
    pool.query(`SELECT count(*)::int AS total ${from}`, builder.values),
    pool.query(`
      SELECT balances.id, balances.product_id, balances.warehouse_id,
        trim_scale(balances.quantity)::text AS quantity,
        balances.updated_at, products.code AS product_code, products.name AS product_name,
        products.status, trim_scale(products.minimum_stock)::text AS minimum_stock,
        trim_scale(products.maximum_stock)::text AS maximum_stock,
        categories.id AS category_id, categories.code AS category_code, categories.name AS category_name,
        units.code AS unit, warehouses.code AS warehouse_code, warehouses.name AS warehouse_name
      ${from}
      ORDER BY products.code, warehouses.code, balances.id
      LIMIT $${listValues.length - 1} OFFSET $${listValues.length}
    `, listValues),
  ]);
  const items = rows.rows.map((row) => ({
    id: row.id,
    productId: row.product_id,
    productCode: row.product_code,
    productName: row.product_name,
    categoryId: row.category_id,
    categoryCode: row.category_code,
    categoryName: row.category_name,
    warehouseId: row.warehouse_id,
    warehouseCode: row.warehouse_code,
    warehouseName: row.warehouse_name,
    quantity: row.quantity,
    unit: row.unit,
    minimumStock: row.minimum_stock,
    maximumStock: row.maximum_stock,
    status: row.status,
    updatedAt: row.updated_at,
  }));
  return list(items, count.rows[0].total, page.page, page.limit);
}

export async function listTransactions(
  pool, sessionActor, rawOptions = {}, capability = CAPABILITIES.STOCK_READ,
) {
  const actor = await currentActor(pool, sessionActor, capability);
  const page = pagination(rawOptions);
  const options = transactionOptions(rawOptions);
  options.warehouse_id = await warehouseFilter(pool, actor, rawOptions.warehouse_id);
  const builder = queryBuilder(actor.regionId);
  transactionFilters(builder, options);
  const where = `WHERE ${builder.clauses.join(' AND ')}`;
  const listValues = [...builder.values, page.limit, page.offset];
  const [count, rows] = await Promise.all([
    pool.query(`SELECT count(*)::int AS total ${transactionJoins} ${where}`, builder.values),
    pool.query(`${transactionSelect} ${transactionJoins} ${where}
      ORDER BY transactions.transaction_date DESC, transactions.ledger_sequence DESC
      LIMIT $${listValues.length - 1} OFFSET $${listValues.length}`, listValues),
  ]);
  return list(
    rows.rows.map((row) => transactionItem(row)),
    count.rows[0].total,
    page.page,
    page.limit,
  );
}

export async function stockCard(
  pool, sessionActor, productId, rawOptions = {}, capability = CAPABILITIES.STOCK_READ,
) {
  const actor = await currentActor(pool, sessionActor, capability);
  const page = pagination(rawOptions);
  const options = transactionOptions({ ...rawOptions, product_id: productId });
  options.warehouse_id = await warehouseFilter(pool, actor, rawOptions.warehouse_id);
  const countBuilder = queryBuilder(actor.regionId);
  transactionFilters(countBuilder, options);
  const countWhere = `WHERE ${countBuilder.clauses.join(' AND ')}`;

  const ledgerBuilder = queryBuilder(actor.regionId);
  transactionFilters(ledgerBuilder, { ...options, from: null, to: null });
  const visibleValues = [...ledgerBuilder.values];
  const visibleClauses = [];
  if (options.from) {
    visibleValues.push(options.from);
    visibleClauses.push(`filtered.transaction_date >= $${visibleValues.length}::date`);
  }
  if (options.to) {
    visibleValues.push(options.to);
    visibleClauses.push(`filtered.transaction_date <= $${visibleValues.length}::date`);
  }
  const visibleWhere = visibleClauses.length ? `WHERE ${visibleClauses.join(' AND ')}` : '';
  const listValues = [...visibleValues, page.limit, page.offset];
  const [count, rows] = await Promise.all([
    pool.query(`SELECT count(*)::int AS total ${transactionJoins} ${countWhere}`, countBuilder.values),
    pool.query(`
      WITH filtered AS MATERIALIZED (
        ${transactionSelect},
          coalesce(sum(transactions.quantity) OVER (
            ORDER BY transactions.transaction_date, transactions.ledger_sequence
            ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
          ), 0) AS running_balance_before,
          sum(transactions.quantity) OVER (
            ORDER BY transactions.transaction_date, transactions.ledger_sequence
            ROWS UNBOUNDED PRECEDING
          ) AS running_balance
        ${transactionJoins}
        WHERE ${ledgerBuilder.clauses.join(' AND ')}
      )
      SELECT filtered.*,
        trim_scale(filtered.running_balance_before)::text AS running_balance_before_text,
        trim_scale(filtered.running_balance)::text AS running_balance_text
      FROM filtered
      ${visibleWhere}
      ORDER BY transaction_date, ledger_sequence
      LIMIT $${listValues.length - 1} OFFSET $${listValues.length}
    `, listValues),
  ]);
  return list(
    rows.rows.map(stockCardItem),
    count.rows[0].total,
    page.page,
    page.limit,
  );
}

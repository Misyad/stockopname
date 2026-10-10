import { createHash, randomUUID } from 'node:crypto';
import { authorize, CAPABILITIES } from '../http/middleware/rbac.js';
import { runInventoryMutation } from './inventory.js';

const openingFields = new Set([
  'idempotencyKey', 'date', 'reference', 'warehouse', 'code', 'batch',
  'production_date', 'expiry', 'quantity', 'unit', 'price', 'notes',
]);
const stockInFields = new Set([...openingFields, 'supplier']);
const requiredFields = ['idempotencyKey', 'date', 'reference', 'warehouse', 'code', 'quantity', 'unit'];

function fault(status, errorCode, message, details = {}) {
  return Object.assign(new Error(message), { status, errorCode, details });
}

function text(value, field, max = 200, required = true) {
  if (value === null || value === undefined || value === '') {
    if (!required) return null;
    throw fault(400, 'VALIDATION_ERROR', `${field} is required.`);
  }
  if (typeof value !== 'string') throw fault(400, 'VALIDATION_ERROR', `${field} must be text.`);
  const normalized = value.trim();
  if ((required && !normalized) || normalized.length > max) {
    throw fault(400, 'VALIDATION_ERROR', `Invalid ${field}.`);
  }
  return normalized || null;
}

function date(value, field, required = false) {
  const normalized = text(value, field, 10, required);
  if (normalized === null) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(normalized);
  if (!match) throw fault(400, 'VALIDATION_ERROR', `Invalid ${field}.`);
  const instant = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (instant.toISOString().slice(0, 10) !== normalized) {
    throw fault(400, 'VALIDATION_ERROR', `Invalid ${field}.`);
  }
  return normalized;
}

function numeric(value, field, { positive = false } = {}) {
  const normalized = typeof value === 'number' || typeof value === 'string'
    ? String(value).trim() : '';
  const invalid = !/^\d+(?:\.\d+)?$/.test(normalized)
    || (positive && /^0+(?:\.0+)?$/.test(normalized));
  if (invalid) {
    throw fault(400, field === 'quantity' ? 'INVALID_QUANTITY' : 'VALIDATION_ERROR', `Invalid ${field}.`);
  }
  return normalized;
}

function normalize(input, type = 'OPENING') {
  if (!input || Array.isArray(input) || typeof input !== 'object') {
    throw fault(400, 'VALIDATION_ERROR', `${type === 'IN' ? 'Stock In' : 'Opening stock'} payload must be an object.`);
  }
  const allowedFields = type === 'IN' ? stockInFields : openingFields;
  const unknown = Object.keys(input).filter((field) => !allowedFields.has(field));
  if (unknown.length) throw fault(400, 'VALIDATION_ERROR', 'Unknown opening stock field.', { fields: unknown });
  const missing = requiredFields.filter((field) => input[field] === undefined || input[field] === null || input[field] === '');
  if (missing.length) throw fault(400, 'VALIDATION_ERROR', 'Required opening stock field is missing.', { fields: missing });
  const productionDate = date(input.production_date, 'production_date');
  const expiry = date(input.expiry, 'expiry');
  if (productionDate && expiry && productionDate > expiry) {
    throw fault(400, 'VALIDATION_ERROR', 'production_date must not exceed expiry.');
  }
  return {
    idempotencyKey: text(input.idempotencyKey, 'idempotencyKey'),
    date: date(input.date, 'date', true),
    reference: text(input.reference, 'reference'),
    warehouse: text(input.warehouse, 'warehouse'),
    code: text(input.code, 'code'),
    batch: text(input.batch, 'batch', 200, false),
    productionDate,
    expiry,
    quantity: numeric(input.quantity, 'quantity', { positive: true }),
    unit: text(input.unit, 'unit'),
    price: input.price === undefined || input.price === null || input.price === ''
      ? '0' : numeric(input.price, 'price'),
    notes: text(input.notes, 'notes', 2000, false),
    supplier: type === 'IN' ? text(input.supplier, 'supplier', 200, false) : null,
  };
}

async function activeReference(client, table, value, errorCode, deferStatus = false) {
  const productSelect = table === 'products'
    ? `SELECT products.*, base_units.code AS base_unit_code,
              categories.status AS category_status,
              base_units.status AS base_unit_status,
              purchase_units.status AS purchase_unit_status
       FROM products
       JOIN categories ON categories.id = products.category_id
       JOIN units base_units ON base_units.id = products.base_unit_id
       LEFT JOIN units purchase_units ON purchase_units.id = products.purchase_unit_id
       WHERE ($2::boolean OR (
         products.status = 'ACTIVE' AND categories.status = 'ACTIVE'
         AND base_units.status = 'ACTIVE'
         AND (products.purchase_unit_id IS NULL OR purchase_units.status = 'ACTIVE')
       ))
         AND (products.id::text = $1 OR upper(products.code) = upper($1) OR lower(products.name) = lower($1))
       LIMIT 1`
    : `SELECT * FROM ${table} WHERE ($2::boolean OR status = 'ACTIVE')
       AND (id::text = $1 OR upper(code) = upper($1) OR lower(name) = lower($1)) LIMIT 1`;
  const result = await client.query(productSelect, [value, deferStatus]);
  if (!result.rows[0]) throw fault(422, errorCode, `${table.slice(0, -1)} is not active or does not exist.`);
  return result.rows[0];
}

async function resolveUnit(client, value, deferStatus = false) {
  const result = await client.query(`
    SELECT units.*, NULL::varchar AS alias_status, 0 AS priority FROM units
    WHERE ($2::boolean OR units.status = 'ACTIVE')
      AND (units.id::text = $1 OR upper(units.code) = upper($1) OR lower(units.name) = lower($1))
    UNION ALL
    SELECT units.*, aliases.status AS alias_status, 1 AS priority FROM unit_aliases aliases
    JOIN units ON units.id = aliases.unit_id
    WHERE ($2::boolean OR (aliases.status = 'ACTIVE' AND units.status = 'ACTIVE'))
      AND lower(aliases.alias) = lower($1)
    ORDER BY priority
    LIMIT 1
  `, [value, deferStatus]);
  if (!result.rows[0]) throw fault(422, 'INVALID_UNIT', 'Unit is not active or does not exist.');
  return result.rows[0];
}

function response(row) {
  return {
    id: row.id,
    transactionNumber: row.transaction_number,
    transactionType: row.transaction_type,
    reference: row.reference_id,
    productId: row.product_id,
    warehouseId: row.warehouse_id,
    batchId: row.batch_id,
    quantity: row.quantity,
    unit: row.unit,
    balanceBefore: row.balance_before,
    balanceAfter: row.balance_after,
    date: row.transaction_date_text,
  };
}

export async function createOpeningStock(pool, sessionActor, rawInput) {
  const input = normalize(rawInput);
  const transaction = await runInventoryMutation(pool, input.idempotencyKey, async (client) => {
    const actorResult = await client.query(
      "SELECT id, role, region_id FROM users WHERE id = $1 AND status = 'ACTIVE' FOR SHARE",
      [sessionActor?.userId],
    );
    const actorRow = actorResult.rows[0];
    if (!actorRow) throw fault(401, 'UNAUTHENTICATED', 'Authentication required.');
    authorize({ userId: actorRow.id, role: actorRow.role }, CAPABILITIES.OPENING_STOCK);

    const product = await activeReference(client, 'products', input.code, 'INVALID_PRODUCT');
    const warehouse = await activeReference(client, 'warehouses', input.warehouse, 'INVALID_WAREHOUSE');
    if (actorRow.region_id !== warehouse.region_id) {
      throw fault(403, 'REGION_FORBIDDEN', 'Warehouse is outside the user region.');
    }
    const unit = await resolveUnit(client, input.unit);
    let factor;
    if (unit.id === product.base_unit_id) factor = '1';
    else if (unit.id === product.purchase_unit_id) factor = product.conversion_factor;
    else throw fault(422, 'INVALID_UNIT', 'Unit is not valid for this product.');

    const quantities = await client.query(
      'SELECT trim_scale($1::numeric * $2::numeric)::text AS quantity, trim_scale($3::numeric)::text AS price',
      [input.quantity, factor, input.price],
    );
    const baseQuantity = quantities.rows[0].quantity;
    const price = quantities.rows[0].price;
    const canonical = JSON.stringify({
      type: 'OPENING', date: input.date, reference: input.reference,
      warehouseId: warehouse.id, productId: product.id, batch: input.batch,
      productionDate: input.productionDate, expiry: input.expiry,
      quantity: baseQuantity, unitId: product.base_unit_id, price, notes: input.notes,
    });
    const requestHash = createHash('sha256').update(canonical).digest('hex');
    const transactionId = randomUUID();
    return {
      requestHash,
      productId: product.id,
      warehouseId: warehouse.id,
      requireEmptyLedger: true,
      batch: {
        productId: product.id,
        warehouseId: warehouse.id,
        batchNumber: input.batch,
        productionDate: input.productionDate,
        expiryDate: input.expiry,
        quantity: baseQuantity,
        unit: product.base_unit_code,
        purchasePrice: price,
      },
      balance: {
        productId: product.id,
        warehouseId: warehouse.id,
        quantity: baseQuantity,
      },
      transaction: {
        id: transactionId,
        transactionNumber: `OPEN-${transactionId}`,
        transactionType: 'OPENING',
        transactionDate: input.date,
        referenceId: input.reference,
        quantity: baseQuantity,
        unit: product.base_unit_code,
        balanceBefore: '0',
        balanceAfter: baseQuantity,
        reason: input.notes,
        userId: actorRow.id,
      },
      auditAction: 'OPENING_STOCK',
      auditDetails: {
        productId: product.id,
        warehouseId: warehouse.id,
        quantity: baseQuantity,
      },
    };
  });
  return response(transaction);
}

export async function createStockIn(pool, sessionActor, rawInput) {
  const input = normalize(rawInput, 'IN');
  const transaction = await runInventoryMutation(pool, input.idempotencyKey, async (client) => {
    const actorResult = await client.query(
      "SELECT id, role, region_id FROM users WHERE id = $1 AND status = 'ACTIVE' FOR SHARE",
      [sessionActor?.userId],
    );
    const actorRow = actorResult.rows[0];
    if (!actorRow) throw fault(401, 'UNAUTHENTICATED', 'Authentication required.');
    authorize({ userId: actorRow.id, role: actorRow.role }, CAPABILITIES.STOCK_MOVE);

    const product = await activeReference(client, 'products', input.code, 'INVALID_PRODUCT', true);
    const warehouse = await activeReference(
      client, 'warehouses', input.warehouse, 'INVALID_WAREHOUSE', true,
    );
    if (actorRow.region_id !== warehouse.region_id) {
      throw fault(403, 'REGION_FORBIDDEN', 'Warehouse is outside the user region.');
    }
    const unit = await resolveUnit(client, input.unit, true);
    const supplier = input.supplier
      ? await activeReference(client, 'suppliers', input.supplier, 'INVALID_SUPPLIER', true) : null;
    let factor;
    if (unit.id === product.base_unit_id) factor = '1';
    else if (unit.id === product.purchase_unit_id) factor = product.conversion_factor;
    else throw fault(422, 'INVALID_UNIT', 'Unit is not valid for this product.');

    const quantities = await client.query(
      'SELECT trim_scale($1::numeric * $2::numeric)::text AS quantity, trim_scale($3::numeric)::text AS price',
      [input.quantity, factor, input.price],
    );
    const baseQuantity = quantities.rows[0].quantity;
    const price = quantities.rows[0].price;
    const canonical = JSON.stringify({
      type: 'IN', date: input.date, reference: input.reference,
      warehouseId: warehouse.id, productId: product.id, supplierId: supplier?.id ?? null,
      batch: input.batch, productionDate: input.productionDate, expiry: input.expiry,
      quantity: baseQuantity, unitId: product.base_unit_id, price, notes: input.notes,
    });
    const requestHash = createHash('sha256').update(canonical).digest('hex');
    const transactionId = randomUUID();
    return {
      mode: 'INCREMENT', requestHash, productId: product.id, warehouseId: warehouse.id,
      validateCurrentState: () => {
        if (product.status !== 'ACTIVE' || product.category_status !== 'ACTIVE'
            || product.base_unit_status !== 'ACTIVE'
            || (product.purchase_unit_id && product.purchase_unit_status !== 'ACTIVE')) {
          throw fault(422, 'INVALID_PRODUCT', 'product is not active or does not exist.');
        }
        if (warehouse.status !== 'ACTIVE') {
          throw fault(422, 'INVALID_WAREHOUSE', 'warehouse is not active or does not exist.');
        }
        if (unit.status !== 'ACTIVE' || (unit.alias_status && unit.alias_status !== 'ACTIVE')) {
          throw fault(422, 'INVALID_UNIT', 'Unit is not active or does not exist.');
        }
        if (supplier && supplier.status !== 'ACTIVE') {
          throw fault(422, 'INVALID_SUPPLIER', 'supplier is not active or does not exist.');
        }
      },
      batch: {
        productId: product.id, warehouseId: warehouse.id, batchNumber: input.batch,
        productionDate: input.productionDate, expiryDate: input.expiry,
        quantity: baseQuantity, unit: product.base_unit_code, purchasePrice: price,
      },
      balance: { productId: product.id, warehouseId: warehouse.id, quantity: baseQuantity },
      transaction: {
        id: transactionId, transactionNumber: `IN-${transactionId}`, transactionType: 'IN',
        transactionDate: input.date, referenceId: input.reference, supplierId: supplier?.id ?? null,
        quantity: baseQuantity, unit: product.base_unit_code, reason: input.notes, userId: actorRow.id,
      },
      auditAction: 'STOCK_IN',
      auditDetails: {
        productId: product.id, warehouseId: warehouse.id, supplierId: supplier?.id ?? null,
        quantity: baseQuantity, purchasePrice: price,
      },
    };
  });
  return response(transaction);
}

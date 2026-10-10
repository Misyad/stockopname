import { randomBytes, randomUUID, scrypt } from 'node:crypto';
import { promisify } from 'node:util';
import { authorize, CAPABILITIES } from '../http/middleware/rbac.js';
import {
  definitionFor,
  findActiveReference,
  findMasterById,
  insertMaster,
  insertMasterAudit,
  listMasterRows,
  updateMasterRow,
} from '../repositories/masters.js';

const deriveKey = promisify(scrypt);
const SCRYPT_OPTIONS = { N: 131_072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };
const statuses = Object.freeze({
  category: new Set(['ACTIVE', 'INACTIVE', 'REVIEW']),
  product: new Set(['ACTIVE', 'INACTIVE', 'REVIEW']),
  unit: new Set(['ACTIVE', 'INACTIVE']),
  unitAlias: new Set(['ACTIVE', 'INACTIVE']),
  warehouse: new Set(['ACTIVE', 'INACTIVE']),
  supplier: new Set(['ACTIVE', 'INACTIVE']),
  user: new Set(['ACTIVE', 'INACTIVE']),
});
const createFields = Object.freeze({
  category: ['code', 'name', 'status'],
  unit: ['code', 'name', 'symbol', 'base_unit_id', 'conversion_to_base', 'status'],
  unitAlias: ['alias', 'unit_id', 'status'],
  warehouse: ['code', 'name', 'location', 'status'],
  supplier: ['code', 'name', 'phone', 'address', 'status'],
  product: [
    'code', 'barcode', 'name', 'category_id', 'base_unit_id', 'purchase_unit_id',
    'conversion_factor', 'minimum_stock', 'maximum_stock', 'photo_url', 'status',
  ],
  user: ['name', 'email', 'password', 'role', 'status'],
});
const required = Object.freeze({
  category: ['code', 'name'],
  unit: ['code', 'name', 'symbol', 'conversion_to_base'],
  unitAlias: ['alias', 'unit_id'],
  warehouse: ['code', 'name'],
  supplier: ['code', 'name'],
  product: ['code', 'name', 'category_id', 'base_unit_id', 'conversion_factor'],
  user: ['name', 'email', 'password', 'role'],
});

function fault(status, errorCode, message, details = {}) {
  return Object.assign(new Error(message), { status, errorCode, details });
}

function assertObject(value) {
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    throw fault(400, 'VALIDATION_ERROR', 'Master payload must be an object.');
  }
}

function assertUuid(value) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw fault(400, 'VALIDATION_ERROR', 'Invalid master id.');
  }
}

function validateFields(kind, input, creating) {
  definitionFor(kind);
  assertObject(input);
  const allowed = createFields[kind];
  const unknown = Object.keys(input).filter((key) => !allowed.includes(key));
  if (unknown.length) {
    throw fault(400, 'VALIDATION_ERROR', 'Unknown master field.', { fields: unknown });
  }
  if (creating) {
    const missing = required[kind].filter((key) => input[key] === undefined || input[key] === null || input[key] === '');
    if (missing.length) throw fault(400, 'VALIDATION_ERROR', 'Required master field is missing.', { fields: missing });
  }
}

function normalized(kind, input, creating) {
  validateFields(kind, input, creating);
  const values = { ...input };
  for (const field of ['name', 'symbol', 'location', 'phone', 'address', 'photo_url']) {
    if (typeof values[field] === 'string') values[field] = values[field].trim();
  }
  for (const field of ['code', 'status', 'role']) {
    if (typeof values[field] === 'string') values[field] = values[field].trim().toUpperCase();
  }
  if (typeof values.alias === 'string') values.alias = values.alias.trim().toLowerCase();
  if (typeof values.email === 'string') values.email = values.email.trim().toLowerCase();
  if (creating && values.status === undefined) values.status = 'ACTIVE';
  for (const field of ['code', 'name', 'symbol', 'alias', 'email']) {
    if (Object.hasOwn(values, field) && (typeof values[field] !== 'string' || !values[field])) {
      throw fault(400, 'VALIDATION_ERROR', `Invalid ${field}.`);
    }
  }
  if (Object.hasOwn(values, 'status') && !statuses[kind].has(values.status)) {
    throw fault(400, 'VALIDATION_ERROR', 'Invalid master status.');
  }
  if (Object.hasOwn(values, 'role') && !['ADMIN', 'SUPERVISOR', 'PETUGAS'].includes(values.role)) {
    throw fault(400, 'VALIDATION_ERROR', 'Invalid user role.');
  }
  for (const field of ['conversion_to_base', 'conversion_factor']) {
    if (Object.hasOwn(values, field) && (!Number.isFinite(Number(values[field])) || Number(values[field]) <= 0)) {
      throw fault(400, 'VALIDATION_ERROR', `Invalid ${field}.`);
    }
  }
  for (const field of ['minimum_stock', 'maximum_stock']) {
    if (Object.hasOwn(values, field) && (!Number.isFinite(Number(values[field])) || Number(values[field]) < 0)) {
      throw fault(400, 'VALIDATION_ERROR', `Invalid ${field}.`);
    }
  }
  return values;
}

async function passwordHash(password) {
  if (typeof password !== 'string' || password.length < 12) {
    throw fault(400, 'VALIDATION_ERROR', 'Password must contain at least 12 characters.');
  }
  const salt = randomBytes(16);
  const key = await deriveKey(password, salt, 64, SCRYPT_OPTIONS);
  return `scrypt$131072$8$1$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

async function validateReferences(client, kind, values) {
  const checks = [];
  if (kind === 'unitAlias' && Object.hasOwn(values, 'unit_id')) checks.push(['unit', values.unit_id, 'UNIT_NOT_FOUND']);
  if (kind === 'unit' && values.base_unit_id) checks.push(['unit', values.base_unit_id, 'UNIT_NOT_FOUND']);
  if (kind === 'product') {
    if (Object.hasOwn(values, 'category_id')) checks.push(['category', values.category_id, 'CATEGORY_NOT_FOUND']);
    if (Object.hasOwn(values, 'base_unit_id')) checks.push(['unit', values.base_unit_id, 'UNIT_NOT_FOUND']);
    if (values.purchase_unit_id) checks.push(['unit', values.purchase_unit_id, 'UNIT_NOT_FOUND']);
  }
  for (const [referenceKind, value, errorCode] of checks) {
    if (!await findActiveReference(client, referenceKind, value)) {
      throw fault(422, errorCode, `${referenceKind} reference is not active or does not exist.`);
    }
  }
}

function publicRow(kind, row) {
  if (kind !== 'user' || !row) return row;
  const { password_hash: ignored, ...safe } = row;
  return safe;
}

function duplicateError(kind, error) {
  if (error.code !== '23505') return error;
  if (error.constraint?.includes('barcode')) return fault(409, 'DUPLICATE_BARCODE', 'Barcode already exists.');
  if (error.constraint?.includes('email')) return fault(409, 'DUPLICATE_EMAIL', 'Email already exists.');
  if (error.constraint?.includes('alias')) return fault(409, 'DUPLICATE_ALIAS', 'Unit alias already exists.');
  return fault(409, 'DUPLICATE_CODE', `${kind} code already exists.`);
}

async function currentActor(client, actor) {
  if (!actor?.userId) return null;
  const result = await client.query(
    "SELECT id, role, region_id FROM users WHERE id = $1 AND status = 'ACTIVE'",
    [actor.userId],
  );
  const row = result.rows[0];
  return row ? { userId: row.id, role: row.role, regionId: row.region_id } : null;
}

function assertSameRegion(actor, row) {
  if (row.region_id !== actor.regionId) {
    throw fault(403, 'REGION_FORBIDDEN', 'Resource is outside the user region.');
  }
}

async function mutate(pool, actor, kind, action, operation) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const resolvedActor = await currentActor(client, actor);
    authorize(resolvedActor, kind === 'user' ? CAPABILITIES.USER_MUTATE : CAPABILITIES.MASTER_MUTATE);
    const row = await operation(client, resolvedActor);
    await insertMasterAudit(client, resolvedActor.userId, `${action}_${kind.replace(/([A-Z])/g, '_$1').toUpperCase()}`, row.id, {
      id: row.id,
      status: row.status,
    });
    await client.query('COMMIT');
    return publicRow(kind, row);
  } catch (error) {
    await client.query('ROLLBACK');
    throw duplicateError(kind, error);
  } finally {
    client.release();
  }
}

export async function createMaster(pool, actor, kind, input) {
  return mutate(pool, actor, kind, 'CREATE', async (client, resolvedActor) => {
    const values = normalized(kind, input, true);
    if (kind === 'warehouse' || kind === 'user') values.region_id = resolvedActor.regionId;
    await validateReferences(client, kind, values);
    if (kind === 'user') {
      values.password_hash = await passwordHash(values.password);
      delete values.password;
    }
    return insertMaster(client, kind, randomUUID(), values);
  });
}

export async function updateMaster(pool, actor, kind, id, input) {
  return mutate(pool, actor, kind, 'UPDATE', async (client, resolvedActor) => {
    assertUuid(id);
    if (kind === 'user' && Object.hasOwn(input, 'password')) {
      throw fault(400, 'VALIDATION_ERROR', 'Password update uses a dedicated operation.');
    }
    const values = normalized(kind, input, false);
    const current = await findMasterById(client, kind, id, true);
    if (!current) throw fault(404, 'MASTER_NOT_FOUND', 'Master record not found.');
    if (kind === 'warehouse' || kind === 'user') assertSameRegion(resolvedActor, current);
    await validateReferences(client, kind, values);
    return updateMasterRow(client, kind, id, values);
  });
}

export async function deactivateMaster(pool, actor, kind, id) {
  return mutate(pool, actor, kind, 'DEACTIVATE', async (client, resolvedActor) => {
    assertUuid(id);
    const current = await findMasterById(client, kind, id, true);
    if (!current) throw fault(404, 'MASTER_NOT_FOUND', 'Master record not found.');
    if (kind === 'warehouse' || kind === 'user') assertSameRegion(resolvedActor, current);
    return updateMasterRow(client, kind, id, { status: 'INACTIVE' });
  });
}

export async function listMasters(pool, actor, kind, options = {}) {
  const resolvedActor = await currentActor(pool, actor);
  authorize(resolvedActor, kind === 'user' ? CAPABILITIES.USER_MUTATE : CAPABILITIES.MASTER_READ);
  const page = Number(options.page ?? 1);
  const limit = Number(options.limit ?? 25);
  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw fault(400, 'VALIDATION_ERROR', 'Invalid pagination.');
  }
  const status = options.status ? String(options.status).trim().toUpperCase() : null;
  if (status && !statuses[kind]?.has(status)) throw fault(400, 'VALIDATION_ERROR', 'Invalid status filter.');
  const q = options.q ? String(options.q).trim() : null;
  if (q && q.length > 100) throw fault(400, 'VALIDATION_ERROR', 'Search query is too long.');
  const result = await listMasterRows(pool, kind, {
    page, limit, q, status, regionId: resolvedActor.regionId,
  });
  return { ...result, rows: result.rows.map((row) => publicRow(kind, row)), page, limit };
}

export async function resolveTransactionMaster(pool, kind, value, actor = null) {
  const errorCodes = {
    category: 'CATEGORY_NOT_FOUND',
    unit: 'UNIT_NOT_FOUND',
    product: 'INVALID_PRODUCT',
    warehouse: 'INVALID_WAREHOUSE',
    supplier: 'INVALID_SUPPLIER',
  };
  if (!errorCodes[kind] || typeof value !== 'string' || !value.trim()) {
    throw fault(422, errorCodes[kind] || 'VALIDATION_ERROR', 'Invalid master reference.');
  }
  const row = await findActiveReference(pool, kind, value);
  if (!row) throw fault(422, errorCodes[kind], `${kind} reference is not active or does not exist.`);
  if (kind === 'warehouse') {
    const resolvedActor = await currentActor(pool, actor);
    authorize(resolvedActor, CAPABILITIES.STOCK_READ);
    assertSameRegion(resolvedActor, row);
  }
  return row;
}

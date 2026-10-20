import { createHash, randomUUID } from 'node:crypto';
import {
  authorize, CAPABILITIES, projectOpnameItem,
} from '../http/middleware/rbac.js';
import { insertStockTransaction, readInventoryReconciliation } from '../repositories/inventory.js';
import {
  applyAdjustmentQuantity,
  approvalSnapshotMatches,
  approveOpnameRow,
  findOpname,
  findWarehouseForSnapshot,
  hasPostSnapshotMovement,
  insertOpname,
  insertOpnameAudit,
  insertSnapshotItems,
  listOpnameItems,
  lockOpnameInventory,
  lockWarehouseBalances,
  readApprovalItems,
  readSnapshotVersion,
  rejectOpnameRow,
  resetAndStartOpname,
  submitOpnameRow,
  updateOpnameCounts,
  validateOpnameSubmission,
} from '../repositories/opname.js';

const allowedFields = new Set(['warehouse', 'date', 'notes']);

function fault(status, errorCode, message, details = {}) {
  return Object.assign(new Error(message), { status, errorCode, details });
}

function text(value, field, max, required = true) {
  if (value === undefined || value === null || value === '') {
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

function isoDate(value) {
  const normalized = text(value, 'date', 10);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(normalized);
  const date = match
    ? new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))) : null;
  if (!date || date.toISOString().slice(0, 10) !== normalized) {
    throw fault(400, 'VALIDATION_ERROR', 'Invalid date.');
  }
  return normalized;
}

function normalize(input) {
  if (!input || Array.isArray(input) || typeof input !== 'object') {
    throw fault(400, 'VALIDATION_ERROR', 'Opname payload must be an object.');
  }
  const unknown = Object.keys(input).filter((field) => !allowedFields.has(field));
  if (unknown.length) {
    throw fault(400, 'VALIDATION_ERROR', 'Unknown opname field.', { fields: unknown });
  }
  return {
    warehouse: text(input.warehouse, 'warehouse', 200),
    date: isoDate(input.date),
    notes: text(input.notes, 'notes', 2000, false),
  };
}

function response(row, itemCount) {
  return {
    id: row.id,
    opnameNumber: row.opname_number,
    warehouseId: row.warehouse_id,
    date: row.opname_date_text,
    status: row.status,
    itemCount,
  };
}

export async function createOpname(pool, sessionActor, rawInput) {
  const input = normalize(rawInput);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const actor = (await client.query(
      "SELECT id, role, region_id FROM users WHERE id = $1 AND status = 'ACTIVE' FOR SHARE",
      [sessionActor?.userId],
    )).rows[0];
    if (!actor) throw fault(401, 'UNAUTHENTICATED', 'Authentication required.');
    authorize({ userId: actor.id, role: actor.role }, CAPABILITIES.OPNAME_CREATE);

    const warehouse = await findWarehouseForSnapshot(client, input.warehouse);
    if (!warehouse) throw fault(422, 'INVALID_WAREHOUSE', 'Warehouse is not active or does not exist.');
    if (warehouse.region_id !== actor.region_id) {
      throw fault(403, 'REGION_FORBIDDEN', 'Warehouse is outside the user region.');
    }

    await client.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [`warehouse-stock:${warehouse.id}`],
    );
    await lockWarehouseBalances(client, warehouse.id);
    const snapshot = await readSnapshotVersion(client, warehouse.id);
    const id = randomUUID();
    const row = await insertOpname(client, {
      id,
      number: `OP-${id}`,
      warehouseId: warehouse.id,
      date: input.date,
      snapshotAt: snapshot.snapshot_at,
      snapshotVersion: snapshot.snapshot_version,
      createdBy: actor.id,
      notes: input.notes,
    });
    const itemCount = await insertSnapshotItems(client, id, warehouse.id);
    await insertOpnameAudit(client, {
      userId: actor.id,
      action: 'OPNAME_CREATED',
      reference: id,
      details: {
        warehouseId: warehouse.id,
        snapshotVersion: String(snapshot.snapshot_version),
        itemCount,
      },
    });
    await client.query('COMMIT');
    return response(row, itemCount);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function itemResponse(item, actor) {
  return projectOpnameItem(actor, {
    id: item.id,
    productId: item.product_id,
    productCode: item.product_code,
    productName: item.product_name,
    batchId: item.batch_id,
    batchNumber: item.batch_number,
    systemQuantity: item.system_quantity,
    physicalQuantity: item.physical_quantity,
    difference: item.difference,
    differenceValue: item.difference_value,
    unit: item.unit,
    reason: item.reason,
    notes: item.notes,
  });
}

async function currentActor(client, sessionActor) {
  const actor = (await client.query(
    "SELECT id, role, region_id FROM users WHERE id = $1 AND status = 'ACTIVE' FOR SHARE",
    [sessionActor?.userId],
  )).rows[0];
  if (!actor) throw fault(401, 'UNAUTHENTICATED', 'Authentication required.');
  return { userId: actor.id, role: actor.role, regionId: actor.region_id };
}

function assertRegion(actor, opname) {
  if (actor.regionId !== opname.region_id) {
    throw fault(403, 'REGION_FORBIDDEN', 'Opname is outside the user region.');
  }
}

function assertState(opname, states) {
  if (!states.includes(opname.status)) {
    throw fault(409, 'INVALID_STATUS', 'Opname status does not allow this action.');
  }
}

async function runOpnameMutation(pool, sessionActor, id, capability, states, mutate) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const actor = await currentActor(client, sessionActor);
    const opname = await findOpname(client, id, true);
    if (!opname) throw fault(404, 'NOT_FOUND', 'Opname not found.');
    assertRegion(actor, opname);
    authorize(actor, capability, opname);
    assertState(opname, states);
    const result = await mutate(client, actor, opname);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function getOpname(pool, sessionActor, id) {
  const actor = await currentActor(pool, sessionActor);
  const opname = await findOpname(pool, id);
  if (!opname) throw fault(404, 'NOT_FOUND', 'Opname not found.');
  assertRegion(actor, opname);
  const items = await listOpnameItems(pool, id);
  return {
    id: opname.id,
    opnameNumber: opname.opname_number,
    warehouseId: opname.warehouse_id,
    date: opname.opname_date_text,
    status: opname.status,
    createdBy: opname.created_by,
    notes: opname.notes,
    items: items.map((item) => itemResponse(item, actor)),
  };
}

export async function startOpname(pool, sessionActor, id) {
  return runOpnameMutation(
    pool, sessionActor, id, CAPABILITIES.OPNAME_COUNT, ['DRAFT', 'REJECTED'],
    async (client, actor, opname) => {
      const row = await resetAndStartOpname(client, id);
      await insertOpnameAudit(client, {
        userId: actor.userId,
        action: 'OPNAME_COUNT_STARTED',
        reference: id,
        details: { previousStatus: opname.status },
      });
      return { id, status: row.status };
    },
  );
}

function normalizeCounts(input) {
  if (!input || Array.isArray(input) || typeof input !== 'object'
      || Object.keys(input).some((key) => key !== 'items') || !Array.isArray(input.items)
      || input.items.length === 0) {
    throw fault(400, 'VALIDATION_ERROR', 'items must be a non-empty array.');
  }
  const seen = new Set();
  return input.items.map((item) => {
    const fields = new Set(['itemId', 'physicalQuantity', 'reason', 'notes']);
    if (!item || Array.isArray(item) || typeof item !== 'object'
        || Object.keys(item).some((key) => !fields.has(key))) {
      throw fault(400, 'VALIDATION_ERROR', 'Invalid count item.');
    }
    const itemId = text(item.itemId, 'itemId', 36);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(itemId)
        || seen.has(itemId)) {
      throw fault(400, 'VALIDATION_ERROR', 'Invalid or duplicate itemId.');
    }
    seen.add(itemId);
    const physicalQuantity = typeof item.physicalQuantity === 'number'
      || typeof item.physicalQuantity === 'string' ? String(item.physicalQuantity).trim() : '';
    if (!/^\d+(?:\.\d+)?$/.test(physicalQuantity)) {
      throw fault(400, 'INVALID_QUANTITY', 'physicalQuantity must be finite and non-negative.');
    }
    return {
      item_id: itemId,
      physical_quantity: physicalQuantity,
      reason: text(item.reason, 'reason', 2000, false),
      notes: text(item.notes, 'notes', 2000, false),
    };
  });
}

export async function saveOpnameCounts(pool, sessionActor, id, rawInput) {
  const items = normalizeCounts(rawInput);
  return runOpnameMutation(
    pool, sessionActor, id, CAPABILITIES.OPNAME_COUNT, ['COUNTING'],
    async (client, actor) => {
      const updated = await updateOpnameCounts(client, id, items);
      if (updated !== items.length) {
        throw fault(400, 'VALIDATION_ERROR', 'One or more item IDs do not belong to the opname.');
      }
      await insertOpnameAudit(client, {
        userId: actor.userId,
        action: 'OPNAME_COUNTS_SAVED',
        reference: id,
        details: { itemCount: updated },
      });
      return { id, status: 'COUNTING', saved: updated };
    },
  );
}

export async function submitOpname(pool, sessionActor, id) {
  return runOpnameMutation(
    pool, sessionActor, id, CAPABILITIES.OPNAME_SUBMIT, ['COUNTING'],
    async (client, actor) => {
      const validation = await validateOpnameSubmission(client, id);
      if (validation.missing > 0) {
        throw fault(409, 'COUNTS_INCOMPLETE', 'Every opname item requires a physical count.');
      }
      if (validation.reason_missing > 0) {
        throw fault(409, 'REASON_REQUIRED', 'A reason is required for every non-zero difference.');
      }
      const row = await submitOpnameRow(client, id);
      await insertOpnameAudit(client, {
        userId: actor.userId,
        action: 'OPNAME_SUBMITTED',
        reference: id,
        details: {},
      });
      return { id, status: row.status };
    },
  );
}

function normalizeAction(input, action) {
  if (!input || Array.isArray(input) || typeof input !== 'object') {
    throw fault(400, 'VALIDATION_ERROR', `${action} payload must be an object.`);
  }
  if (action === 'approval') {
    if (Object.keys(input).length) throw fault(400, 'VALIDATION_ERROR', 'Approval payload must be empty.');
    return null;
  }
  if (Object.keys(input).some((field) => field !== 'reason')) {
    throw fault(400, 'VALIDATION_ERROR', 'Unknown rejection field.');
  }
  try {
    return text(input.reason, 'reason', 2000);
  } catch (error) {
    if (error.errorCode === 'VALIDATION_ERROR') {
      throw fault(400, 'REASON_REQUIRED', 'A rejection reason is required.');
    }
    throw error;
  }
}

export async function rejectOpname(pool, sessionActor, id, rawInput) {
  const reason = normalizeAction(rawInput, 'rejection');
  return runOpnameMutation(
    pool, sessionActor, id, CAPABILITIES.OPNAME_REJECT, ['SUBMITTED'],
    async (client, actor) => {
      const row = await rejectOpnameRow(client, id, reason);
      await insertOpnameAudit(client, {
        userId: actor.userId, action: 'OPNAME_REJECTED', reference: id, details: { reason },
      });
      return { id, status: row.status, rejectionReason: row.rejection_reason };
    },
  );
}

export async function approveOpname(pool, sessionActor, id, rawInput) {
  normalizeAction(rawInput, 'approval');
  return runOpnameMutation(
    pool, sessionActor, id, CAPABILITIES.OPNAME_APPROVE, ['SUBMITTED'],
    async (client, actor, opname) => {
      await lockOpnameInventory(client, opname.warehouse_id);
      if (await hasPostSnapshotMovement(client, opname)) {
        throw fault(409, 'STOCK_MOVED_DURING_OPNAME', 'Stock moved after the opname snapshot.');
      }
      const items = await readApprovalItems(client, id);
      if (items.some((item) => item.batch_negative || item.balance_negative)) {
        throw fault(409, 'NEGATIVE_STOCK', 'Adjustment would create negative stock.');
      }
      if (!await approvalSnapshotMatches(client, id, opname.warehouse_id)) {
        throw fault(409, 'STOCK_CHANGED_AFTER_OPNAME', 'Current stock no longer matches the opname snapshot.');
      }
      const productIds = [...new Set(items.map((item) => item.product_id))];
      for (const productId of productIds) {
        const state = await readInventoryReconciliation(client, productId, opname.warehouse_id);
        if (!state.reconciled) {
          throw fault(409, 'STOCK_CHANGED_AFTER_OPNAME', 'Current stock failed reconciliation.');
        }
      }
      let adjustments = 0;
      for (const item of items) {
        if (item.difference === '0') continue;
        const balances = await applyAdjustmentQuantity(client, {
          ...item, warehouse_id: opname.warehouse_id,
        });
        if (!balances) throw fault(409, 'NEGATIVE_STOCK', 'Adjustment would create negative stock.');
        const requestHash = createHash('sha256').update(JSON.stringify({
          opnameId: id, itemId: item.id, difference: item.difference,
        })).digest('hex');
        const transactionId = randomUUID();
        await insertStockTransaction(client, {
          id: transactionId,
          idempotencyKey: `opname:${id}:${item.id}`,
          transactionNumber: `ADJ-${transactionId}`,
          transactionType: 'ADJUSTMENT',
          transactionDate: opname.opname_date_text,
          requestHash,
          referenceId: id,
          productId: item.product_id,
          warehouseId: opname.warehouse_id,
          batchId: item.batch_id,
          quantity: item.difference,
          unit: item.unit,
          balanceBefore: balances.balance_before,
          balanceAfter: balances.balance_after,
          reason: item.reason,
          userId: actor.userId,
        });
        adjustments += 1;
      }
      for (const productId of productIds) {
        const state = await readInventoryReconciliation(client, productId, opname.warehouse_id);
        if (!state.reconciled) {
          throw fault(409, 'STOCK_CHANGED_AFTER_OPNAME', 'Adjustment failed reconciliation.');
        }
      }
      const row = await approveOpnameRow(client, id, actor.userId);
      await insertOpnameAudit(client, {
        userId: actor.userId, action: 'OPNAME_APPROVED', reference: id,
        details: { adjustments },
      });
      return { id, status: row.status, adjustments };
    },
  );
}

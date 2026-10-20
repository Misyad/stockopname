export async function findWarehouseForSnapshot(client, value) {
  const result = await client.query(`
    SELECT * FROM warehouses
    WHERE status = 'ACTIVE'
      AND (id::text = $1 OR upper(code) = upper($1) OR lower(name) = lower($1))
    LIMIT 1
    FOR SHARE
  `, [value]);
  return result.rows[0] || null;
}

export async function lockWarehouseBalances(client, warehouseId) {
  await client.query(`
    SELECT id FROM stock_balances
    WHERE warehouse_id = $1
    ORDER BY product_id, id
    FOR SHARE
  `, [warehouseId]);
  await client.query(`
    SELECT id FROM stock_batches
    WHERE warehouse_id = $1
    ORDER BY product_id, id
    FOR SHARE
  `, [warehouseId]);
}

export async function readSnapshotVersion(client, warehouseId) {
  const result = await client.query(`
    SELECT CURRENT_TIMESTAMP AS snapshot_at,
      coalesce(max(ledger_sequence), 0)::bigint AS snapshot_version
    FROM stock_transactions
    WHERE warehouse_id = $1
  `, [warehouseId]);
  return result.rows[0];
}

export async function insertOpname(client, opname) {
  const result = await client.query(`
    INSERT INTO stock_opnames (
      id, opname_number, warehouse_id, opname_date, status, snapshot_at,
      snapshot_version, created_by, notes, created_at, updated_at
    ) VALUES ($1, $2, $3, $4, 'DRAFT', $5, $6, $7, $8, now(), now())
    RETURNING *, to_char(opname_date, 'YYYY-MM-DD') AS opname_date_text
  `, [
    opname.id, opname.number, opname.warehouseId, opname.date, opname.snapshotAt,
    opname.snapshotVersion, opname.createdBy, opname.notes,
  ]);
  return result.rows[0];
}

export async function insertSnapshotItems(client, opnameId, warehouseId) {
  const result = await client.query(`
    INSERT INTO stock_opname_items (
      id, opname_id, product_id, batch_id, system_quantity, physical_quantity,
      difference, difference_value, unit, unit_price, reason, notes
    )
    SELECT gen_random_uuid(), $1, batches.product_id, batches.id, batches.quantity,
      NULL, NULL, NULL, batches.unit, batches.purchase_price, NULL, NULL
    FROM stock_batches batches
    JOIN products ON products.id = batches.product_id
    WHERE batches.warehouse_id = $2 AND batches.quantity > 0
    ORDER BY products.code, batches.expiry_date NULLS LAST, batches.id
    RETURNING id
  `, [opnameId, warehouseId]);
  return result.rowCount;
}

export async function insertOpnameAudit(client, audit) {
  await client.query(`
    INSERT INTO audit_logs (id, timestamp, user_id, action, module, reference, details)
    VALUES (gen_random_uuid(), now(), $1, $2, 'OPNAME', $3, $4::jsonb)
  `, [audit.userId, audit.action, audit.reference, JSON.stringify(audit.details)]);
}

export async function findOpname(client, id, lock = false) {
  const result = await client.query(`
    SELECT opnames.*, warehouses.region_id,
      to_char(opnames.opname_date, 'YYYY-MM-DD') AS opname_date_text
    FROM stock_opnames opnames
    JOIN warehouses ON warehouses.id = opnames.warehouse_id
    WHERE opnames.id = $1
    ${lock ? 'FOR UPDATE OF opnames' : ''}
  `, [id]);
  return result.rows[0] || null;
}

export async function listOpnameItems(client, opnameId) {
  const result = await client.query(`
    SELECT items.id, items.product_id, products.code AS product_code,
      products.name AS product_name, items.batch_id, batches.batch_number,
      trim_scale(items.system_quantity)::text AS system_quantity,
      CASE WHEN items.physical_quantity IS NULL THEN NULL
        ELSE trim_scale(items.physical_quantity)::text END AS physical_quantity,
      CASE WHEN items.difference IS NULL THEN NULL
        ELSE trim_scale(items.difference)::text END AS difference,
      CASE WHEN items.difference_value IS NULL THEN NULL
        ELSE trim_scale(items.difference_value)::text END AS difference_value,
      items.unit, items.reason, items.notes
    FROM stock_opname_items items
    JOIN products ON products.id = items.product_id
    LEFT JOIN stock_batches batches ON batches.id = items.batch_id
    WHERE items.opname_id = $1
    ORDER BY products.code, batches.expiry_date NULLS LAST, items.id
  `, [opnameId]);
  return result.rows;
}

export async function resetAndStartOpname(client, id) {
  await client.query(`
    UPDATE stock_opname_items SET physical_quantity = NULL, difference = NULL,
      difference_value = NULL, reason = NULL, notes = NULL
    WHERE opname_id = $1
  `, [id]);
  const result = await client.query(`
    UPDATE stock_opnames SET status = 'COUNTING', rejection_reason = NULL, updated_at = now()
    WHERE id = $1 RETURNING status
  `, [id]);
  return result.rows[0];
}

export async function updateOpnameCounts(client, opnameId, items) {
  const result = await client.query(`
    WITH input AS (
      SELECT * FROM jsonb_to_recordset($2::jsonb) AS value(
        item_id uuid, physical_quantity numeric, reason text, notes text
      )
    ), updated AS (
      UPDATE stock_opname_items saved SET
        physical_quantity = input.physical_quantity,
        difference = input.physical_quantity - saved.system_quantity,
        difference_value = (input.physical_quantity - saved.system_quantity) * saved.unit_price,
        reason = input.reason,
        notes = input.notes
      FROM input
      WHERE saved.opname_id = $1 AND saved.id = input.item_id
      RETURNING saved.id
    )
    SELECT count(*)::int AS updated FROM updated
  `, [opnameId, JSON.stringify(items)]);
  return result.rows[0].updated;
}

export async function validateOpnameSubmission(client, opnameId) {
  const result = await client.query(`
    SELECT count(*) FILTER (WHERE physical_quantity IS NULL)::int AS missing,
      count(*) FILTER (
        WHERE difference <> 0 AND nullif(btrim(reason), '') IS NULL
      )::int AS reason_missing
    FROM stock_opname_items
    WHERE opname_id = $1
  `, [opnameId]);
  return result.rows[0];
}

export async function submitOpnameRow(client, id) {
  const result = await client.query(`
    UPDATE stock_opnames
    SET status = 'SUBMITTED', submitted_at = now(), updated_at = now()
    WHERE id = $1
    RETURNING status, submitted_at
  `, [id]);
  return result.rows[0];
}

export async function lockOpnameInventory(client, warehouseId) {
  await client.query(
    'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
    [`warehouse-stock:${warehouseId}`],
  );
  await client.query(`
    SELECT id FROM stock_balances WHERE warehouse_id = $1 ORDER BY product_id, id FOR UPDATE
  `, [warehouseId]);
  await client.query(`
    SELECT id FROM stock_batches WHERE warehouse_id = $1 ORDER BY product_id, id FOR UPDATE
  `, [warehouseId]);
}

export async function hasPostSnapshotMovement(client, opname) {
  const result = await client.query(`
    SELECT EXISTS (
      SELECT 1 FROM stock_transactions
      WHERE warehouse_id = $1 AND ledger_sequence > $2
    ) AS moved
  `, [opname.warehouse_id, opname.snapshot_version]);
  return result.rows[0].moved;
}

export async function readApprovalItems(client, opnameId) {
  const result = await client.query(`
    WITH expected AS (
      SELECT product_id, sum(system_quantity) AS quantity, sum(difference) AS difference
      FROM stock_opname_items WHERE opname_id = $1 GROUP BY product_id
    )
    SELECT items.id, items.product_id, items.batch_id, items.unit, items.reason,
      trim_scale(items.system_quantity)::text AS system_quantity,
      trim_scale(items.difference)::text AS difference,
      trim_scale(items.unit_price)::text AS unit_price,
      trim_scale(batches.quantity)::text AS batch_quantity,
      trim_scale(balances.quantity)::text AS balance_quantity,
      (coalesce(batches.quantity, 0) + items.difference < 0) AS batch_negative,
      (coalesce(balances.quantity, 0) + expected.difference < 0) AS balance_negative
    FROM stock_opname_items items
    JOIN expected ON expected.product_id = items.product_id
    LEFT JOIN stock_batches batches ON batches.id = items.batch_id
    LEFT JOIN stock_balances balances
      ON balances.product_id = items.product_id
      AND balances.warehouse_id = (SELECT warehouse_id FROM stock_opnames WHERE id = $1)
    WHERE items.opname_id = $1
    ORDER BY items.product_id, items.id
  `, [opnameId]);
  return result.rows;
}

export async function approvalSnapshotMatches(client, opnameId, warehouseId) {
  const result = await client.query(`
    WITH expected AS (
      SELECT product_id, sum(system_quantity) AS quantity
      FROM stock_opname_items WHERE opname_id = $1 GROUP BY product_id
    ), item_mismatch AS (
      SELECT 1 FROM stock_opname_items items
      LEFT JOIN stock_batches batches ON batches.id = items.batch_id
      WHERE items.opname_id = $1 AND (
        items.batch_id IS NULL OR batches.id IS NULL
        OR batches.product_id IS DISTINCT FROM items.product_id
        OR batches.quantity IS DISTINCT FROM items.system_quantity
        OR batches.unit IS DISTINCT FROM items.unit
        OR batches.purchase_price IS DISTINCT FROM items.unit_price
      ) LIMIT 1
    ), balance_mismatch AS (
      SELECT 1 FROM expected
      LEFT JOIN stock_balances balances
        ON balances.product_id = expected.product_id AND balances.warehouse_id = $2
      WHERE balances.quantity IS DISTINCT FROM expected.quantity
      UNION ALL
      SELECT 1 FROM stock_balances balances
      LEFT JOIN expected ON expected.product_id = balances.product_id
      WHERE balances.warehouse_id = $2 AND balances.quantity > 0 AND expected.product_id IS NULL
      LIMIT 1
    ), batch_mismatch AS (
      SELECT 1 FROM stock_batches batches
      LEFT JOIN stock_opname_items items
        ON items.opname_id = $1 AND items.batch_id = batches.id
      WHERE batches.warehouse_id = $2 AND batches.quantity > 0 AND items.id IS NULL
      LIMIT 1
    )
    SELECT NOT EXISTS (SELECT 1 FROM item_mismatch)
      AND NOT EXISTS (SELECT 1 FROM balance_mismatch)
      AND NOT EXISTS (SELECT 1 FROM batch_mismatch) AS matches
  `, [opnameId, warehouseId]);
  return result.rows[0].matches;
}

export async function applyAdjustmentQuantity(client, item) {
  const batch = await client.query(`
    UPDATE stock_batches
    SET quantity = quantity + $2::numeric,
      status = CASE WHEN quantity + $2::numeric = 0 THEN 'DEPLETED' ELSE 'ACTIVE' END,
      updated_at = now()
    WHERE id = $1 AND quantity + $2::numeric >= 0
    RETURNING id
  `, [item.batch_id, item.difference]);
  const balance = await client.query(`
    WITH updated AS (
      UPDATE stock_balances SET quantity = quantity + $2::numeric,
        version = version + 1, updated_at = now()
      WHERE product_id = $1 AND warehouse_id = $3 AND quantity + $2::numeric >= 0
      RETURNING quantity
    )
    SELECT trim_scale(quantity - $2::numeric)::text AS balance_before,
      trim_scale(quantity)::text AS balance_after FROM updated
  `, [item.product_id, item.difference, item.warehouse_id]);
  if (!batch.rowCount || !balance.rowCount) return null;
  return balance.rows[0];
}

export async function rejectOpnameRow(client, id, reason) {
  const result = await client.query(`
    UPDATE stock_opnames SET status = 'REJECTED', rejection_reason = $2, updated_at = now()
    WHERE id = $1 RETURNING status, rejection_reason
  `, [id, reason]);
  return result.rows[0];
}

export async function approveOpnameRow(client, id, userId) {
  const result = await client.query(`
    UPDATE stock_opnames SET status = 'APPROVED', approved_by = $2,
      approved_at = now(), updated_at = now()
    WHERE id = $1 RETURNING status, approved_by, approved_at
  `, [id, userId]);
  return result.rows[0];
}

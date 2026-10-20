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

export async function currentImportActor(client, actorId) {
  const result = await client.query(
    "SELECT id, role, region_id FROM users WHERE id = $1 AND status = 'ACTIVE'",
    [actorId],
  );
  const row = result.rows[0];
  return row ? { userId: row.id, role: row.role, regionId: row.region_id } : null;
}

export async function loadImportReferences(client) {
  const [categories, units, aliases, products, suppliers, warehouses] = await Promise.all([
    client.query("SELECT id, code, name FROM categories WHERE status = 'ACTIVE'"),
    client.query("SELECT id, code, name, symbol FROM units WHERE status = 'ACTIVE'"),
    client.query(`
      SELECT aliases.alias, units.id, units.code, units.name, units.symbol
      FROM unit_aliases aliases
      JOIN units ON units.id = aliases.unit_id
      WHERE aliases.status = 'ACTIVE' AND units.status = 'ACTIVE'
    `),
    client.query("SELECT id, code, name FROM products WHERE status = 'ACTIVE'"),
    client.query("SELECT id, code, name FROM suppliers WHERE status = 'ACTIVE'"),
    client.query("SELECT id, code, name, region_id FROM warehouses WHERE status = 'ACTIVE'"),
  ]);
  return {
    categories: categories.rows,
    units: units.rows,
    aliases: aliases.rows,
    products: products.rows,
    suppliers: suppliers.rows,
    warehouses: warehouses.rows,
  };
}

export async function insertImportBatch(client, batch) {
  const result = await client.query(`
    INSERT INTO import_batches (
      id, import_type, file_name, file_hash, status, row_count, created_by, created_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, now())
    RETURNING id, preview_version
  `, [
    batch.id, batch.type, batch.fileName, batch.fileHash,
    batch.status, batch.rowCount, batch.createdBy,
  ]);
  return result.rows[0];
}

export async function insertReadyImportRows(client, batchId, fileHash, rows) {
  if (!rows.length) return;
  await client.query(`
    INSERT INTO ready_import_rows (
      id, import_batch_id, row_number, file_hash, date, reference, supplier,
      warehouse, code, batch, production_date, expiry, quantity, unit, price,
      notes, status, error_code, error_message, created_at
    )
    SELECT gen_random_uuid(), $1, value.row_number, $2, value.date, value.reference,
      value.supplier, value.warehouse, value.code, value.batch, value.production_date,
      value.expiry, value.quantity, value.unit, value.price, value.notes, value.status,
      value.error_code, value.error_message, now()
    FROM jsonb_to_recordset($3::jsonb) AS value(
      row_number integer, date date, reference varchar, supplier varchar,
      warehouse varchar, code varchar, batch varchar, production_date date,
      expiry date, quantity numeric, unit varchar, price numeric, notes text,
      status varchar, error_code varchar, error_message text
    )
  `, [batchId, fileHash, JSON.stringify(rows)]);
}

export async function insertOcrStagingRows(client, batchId, fileHash, actorId, rows) {
  if (!rows.length) return;
  await client.query(`
    INSERT INTO staging_ocr_lines (
      id, import_batch_id, file_hash, source_pdf, page, category, description_raw,
      quantity, unit_raw, unit_price, line_total, review_status, notes, created_by, created_at
    )
    SELECT gen_random_uuid(), $1, $2, value.source_pdf, value.page, value.category,
      value.description_raw, value.quantity, value.unit_raw, value.unit_price,
      value.line_total, value.review_status, value.notes, $3, now()
    FROM jsonb_to_recordset($4::jsonb) AS value(
      source_pdf varchar, page integer, category varchar, description_raw text,
      quantity numeric, unit_raw varchar, unit_price numeric, line_total numeric,
      review_status varchar, notes text
    )
  `, [batchId, fileHash, actorId, JSON.stringify(rows)]);
}

export async function insertImportAudit(client, audit) {
  await client.query(`
    INSERT INTO audit_logs (id, timestamp, user_id, action, module, reference, details)
    VALUES (gen_random_uuid(), now(), $1, 'IMPORT_PREVIEW', 'IMPORT', $2, $3::jsonb)
  `, [audit.userId, audit.batchId, JSON.stringify(audit.details)]);
}

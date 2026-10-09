const DEFINITIONS = Object.freeze({
  category: {
    table: 'categories',
    fields: ['code', 'name', 'status'],
    search: ['code', 'name'],
  },
  unit: {
    table: 'units',
    fields: ['code', 'name', 'symbol', 'base_unit_id', 'conversion_to_base', 'status'],
    search: ['code', 'name', 'symbol'],
  },
  unitAlias: {
    table: 'unit_aliases',
    fields: ['alias', 'unit_id', 'status'],
    search: ['alias'],
  },
  warehouse: {
    table: 'warehouses',
    fields: ['code', 'name', 'location', 'status'],
    search: ['code', 'name', 'location'],
  },
  supplier: {
    table: 'suppliers',
    fields: ['code', 'name', 'phone', 'address', 'status'],
    search: ['code', 'name', 'phone', 'address'],
  },
  product: {
    table: 'products',
    fields: [
      'code', 'barcode', 'name', 'category_id', 'base_unit_id', 'purchase_unit_id',
      'conversion_factor', 'minimum_stock', 'maximum_stock', 'photo_url', 'status',
    ],
    search: ['code', 'barcode', 'name'],
  },
  user: {
    table: 'users',
    fields: ['name', 'email', 'password_hash', 'role', 'status'],
    search: ['name', 'email'],
  },
});

export function definitionFor(kind) {
  const definition = DEFINITIONS[kind];
  if (!definition) throw Object.assign(new Error('Unknown master type.'), {
    status: 400,
    errorCode: 'VALIDATION_ERROR',
  });
  return definition;
}

export async function insertMaster(client, kind, id, values) {
  const { table, fields } = definitionFor(kind);
  const keys = fields.filter((field) => Object.hasOwn(values, field));
  const columns = ['id', ...keys, 'created_at', 'updated_at'];
  const parameters = [id, ...keys.map((key) => values[key])];
  const placeholders = parameters.map((_, index) => `$${index + 1}`);
  const result = await client.query(
    `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders.join(', ')}, now(), now()) RETURNING *`,
    parameters,
  );
  return result.rows[0];
}

export async function findMasterById(client, kind, id, lock = false) {
  const { table } = definitionFor(kind);
  const result = await client.query(
    `SELECT * FROM ${table} WHERE id = $1${lock ? ' FOR UPDATE' : ''}`,
    [id],
  );
  return result.rows[0] || null;
}

export async function updateMasterRow(client, kind, id, values) {
  const { table, fields } = definitionFor(kind);
  const keys = fields.filter((field) => Object.hasOwn(values, field));
  if (keys.length === 0) return findMasterById(client, kind, id);
  const assignments = keys.map((key, index) => `${key} = $${index + 2}`);
  const result = await client.query(
    `UPDATE ${table} SET ${assignments.join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`,
    [id, ...keys.map((key) => values[key])],
  );
  return result.rows[0] || null;
}

export async function listMasterRows(client, kind, { page, limit, q, status }) {
  const { table, search } = definitionFor(kind);
  const where = [];
  const parameters = [];
  if (q) {
    const literal = q.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
    parameters.push(`%${literal}%`);
    where.push(`(${search.map((field) => `${field} ILIKE $${parameters.length} ESCAPE '\\'`).join(' OR ')})`);
  }
  if (status) {
    parameters.push(status);
    where.push(`status = $${parameters.length}`);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const count = await client.query(`SELECT count(*)::int AS total FROM ${table} ${clause}`, parameters);
  parameters.push(limit, (page - 1) * limit);
  const rows = await client.query(
    `SELECT * FROM ${table} ${clause} ORDER BY created_at DESC, id LIMIT $${parameters.length - 1} OFFSET $${parameters.length}`,
    parameters,
  );
  return { rows: rows.rows, total: count.rows[0].total };
}

export async function findActiveReference(client, kind, value) {
  const normalized = String(value).trim();
  if (kind === 'unit') {
    const result = await client.query(`
      SELECT units.* FROM units
      WHERE units.status = 'ACTIVE'
        AND (units.id::text = $1 OR upper(units.code) = upper($1) OR lower(units.name) = lower($1))
      UNION
      SELECT units.* FROM unit_aliases aliases
      JOIN units ON units.id = aliases.unit_id
      WHERE aliases.status = 'ACTIVE' AND units.status = 'ACTIVE' AND lower(aliases.alias) = lower($1)
      LIMIT 1
    `, [normalized]);
    return result.rows[0] || null;
  }
  if (kind === 'product') {
    const result = await client.query(`
      SELECT products.* FROM products
      JOIN categories ON categories.id = products.category_id AND categories.status = 'ACTIVE'
      JOIN units base_units ON base_units.id = products.base_unit_id AND base_units.status = 'ACTIVE'
      LEFT JOIN units purchase_units ON purchase_units.id = products.purchase_unit_id
      WHERE products.status = 'ACTIVE'
        AND (products.id::text = $1 OR upper(products.code) = upper($1)
             OR lower(products.name) = lower($1))
        AND (products.purchase_unit_id IS NULL OR purchase_units.status = 'ACTIVE')
      LIMIT 1
    `, [normalized]);
    return result.rows[0] || null;
  }
  const definitions = {
    category: ['categories', 'code', 'name'],
    warehouse: ['warehouses', 'code', 'name'],
    supplier: ['suppliers', 'code', 'name'],
  };
  const definition = definitions[kind];
  if (!definition) return null;
  const [table, code, name] = definition;
  const result = await client.query(
    `SELECT * FROM ${table} WHERE status = 'ACTIVE'
     AND (id::text = $1 OR upper(${code}) = upper($1) OR lower(${name}) = lower($1)) LIMIT 1`,
    [normalized],
  );
  return result.rows[0] || null;
}

export async function insertMasterAudit(client, actorId, action, reference, details) {
  await client.query(`
    INSERT INTO audit_logs (id, timestamp, user_id, action, module, reference, details)
    VALUES (gen_random_uuid(), now(), $1, $2, 'MASTER', $3, $4::jsonb)
  `, [actorId, action, reference, JSON.stringify(details)]);
}

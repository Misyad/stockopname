import { authorize, CAPABILITIES } from '../http/middleware/rbac.js';

function fault(status, errorCode, message) {
  return Object.assign(new Error(message), { status, errorCode });
}

async function actorFor(pool, sessionActor) {
  const row = (await pool.query(
    "SELECT id, role, region_id FROM users WHERE id = $1 AND status = 'ACTIVE'",
    [sessionActor?.userId],
  )).rows[0];
  if (!row) throw fault(401, 'UNAUTHENTICATED', 'Authentication required.');
  const actor = { userId: row.id, role: row.role, regionId: row.region_id };
  authorize(actor, CAPABILITIES.DASHBOARD_READ);
  return actor;
}

function transaction(row) {
  return {
    id: row.id,
    transactionNumber: row.transaction_number,
    transactionType: row.transaction_type,
    date: row.transaction_date,
    reference: row.reference_id,
    productCode: row.product_code,
    productName: row.product_name,
    warehouseCode: row.warehouse_code,
    quantity: row.quantity,
    unit: row.unit,
    createdAt: row.created_at,
  };
}

export async function dashboard(pool, sessionActor) {
  const actor = await actorFor(pool, sessionActor);
  const [metrics, recent] = await Promise.all([
    pool.query(`
      WITH regional_balances AS MATERIALIZED (
        SELECT balances.product_id, balances.quantity, products.minimum_stock
        FROM stock_balances balances
        JOIN products ON products.id = balances.product_id
        JOIN warehouses ON warehouses.id = balances.warehouse_id
        WHERE warehouses.region_id = $1
      )
      SELECT
        count(DISTINCT regional_balances.product_id)::int AS total_products,
        trim_scale(coalesce(sum(regional_balances.quantity), 0))::text AS total_stock,
        count(*) FILTER (WHERE regional_balances.quantity > regional_balances.minimum_stock)::int AS safe,
        count(*) FILTER (
          WHERE regional_balances.quantity > 0
            AND regional_balances.quantity <= regional_balances.minimum_stock
        )::int AS low,
        count(*) FILTER (WHERE regional_balances.quantity = 0)::int AS out,
        (SELECT count(*)::int FROM stock_batches batches
          JOIN warehouses ON warehouses.id = batches.warehouse_id
          WHERE warehouses.region_id = $1 AND batches.quantity > 0
            AND batches.expiry_date < current_date) AS expired,
        (SELECT count(*)::int FROM stock_batches batches
          JOIN warehouses ON warehouses.id = batches.warehouse_id
          WHERE warehouses.region_id = $1 AND batches.quantity > 0
            AND batches.expiry_date BETWEEN current_date AND current_date + 7) AS expiring_7d,
        (SELECT count(*)::int FROM stock_batches batches
          JOIN warehouses ON warehouses.id = batches.warehouse_id
          WHERE warehouses.region_id = $1 AND batches.quantity > 0
            AND batches.expiry_date BETWEEN current_date AND current_date + 30) AS expiring_30d,
        (SELECT count(*)::int FROM stock_opnames opnames
          JOIN warehouses ON warehouses.id = opnames.warehouse_id
          WHERE warehouses.region_id = $1
            AND opnames.status IN ('DRAFT', 'COUNTING', 'SUBMITTED')) AS pending_opnames,
        (SELECT trim_scale(coalesce(sum(transactions.quantity), 0))::text
          FROM stock_transactions transactions
          JOIN warehouses ON warehouses.id = transactions.warehouse_id
          WHERE warehouses.region_id = $1
            AND transactions.transaction_type = 'ADJUSTMENT') AS total_adjustment
      FROM regional_balances
    `, [actor.regionId]),
    pool.query(`
      SELECT transactions.id, transactions.transaction_number, transactions.transaction_type,
        to_char(transactions.transaction_date, 'YYYY-MM-DD') AS transaction_date,
        transactions.reference_id, trim_scale(transactions.quantity)::text AS quantity,
        transactions.unit, transactions.created_at, products.code AS product_code,
        products.name AS product_name, warehouses.code AS warehouse_code
      FROM stock_transactions transactions
      JOIN products ON products.id = transactions.product_id
      JOIN warehouses ON warehouses.id = transactions.warehouse_id
      WHERE warehouses.region_id = $1
      ORDER BY transactions.created_at DESC, transactions.ledger_sequence DESC
      LIMIT 10
    `, [actor.regionId]),
  ]);
  return { ...metrics.rows[0], recent_transactions: recent.rows.map(transaction) };
}

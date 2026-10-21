# API Contract — Stock Opname SPPG PAKISKEMBAR 2

**Status:** Approved v0.1.0 — implementation baseline  
**Base URL:** `/api`  
**Format:** JSON  
**Auth:** Secure HttpOnly session cookie unless stated otherwise

## 1. Response Contract

Success:

```json
{
  "success": true,
  "data": {},
  "message": "OK"
}
```

Failure:

```json
{
  "success": false,
  "errorCode": "INSUFFICIENT_STOCK",
  "message": "Stok tidak mencukupi. Tersedia 10 kg.",
  "details": {}
}
```

Never expose SQL, stack trace, token secret, password, or internal path.

## 2. Authentication

### `POST /auth/login`

Public.

Request:

```json
{"email":"admin@example.com","password":"..."}
```

Response data:

```json
{
  "userId":"uuid",
  "email":"admin@example.com",
  "role":"ADMIN",
  "token":"...",
  "license":"SELF_HOSTED"
}
```

`license` adalah application constant publik `SELF_HOSTED`; bukan license key/secret dan tidak berasal dari database atau environment.

Server juga mengirim opaque session secret melalui cookie `HttpOnly`, `Secure`, dan `SameSite=Lax`. JSON `token` berisi session reference non-secret untuk kompatibilitas UI; bukan bearer credential dan tidak boleh disimpan di `localStorage`.

Errors: `INVALID_CREDENTIALS`, `USER_INACTIVE`, `RATE_LIMITED`.

### `POST /auth/logout`

Authenticated. Revoke server session dan hapus cookie.

### `GET /auth/me`

Authenticated. Returns current user profile and role.

### `GET /auth/csrf`

Authenticated. Returns a session-bound CSRF token for in-memory client use. Token is never persisted in `localStorage`. Errors: `UNAUTHENTICATED`.

Semua mutation berbasis cookie wajib lolos CSRF validation. Login public wajib lolos origin check dan rate limit.

## 3. Authorization Matrix

| Endpoint group | ADMIN | SUPERVISOR | PETUGAS |
|---|---:|---:|---:|
| Auth/profile | Yes | Yes | Yes |
| Users | CRUD | No | No |
| Master data | CRUD | Read | Read |
| Dashboard | Yes | Yes | Yes |
| Stock read | Yes | Yes | Yes |
| Stock IN/OUT | Yes | Yes | Yes |
| Opening stock | Yes | No | No |
| Opname count | Yes | Yes, all opnames | Own opname |
| Opname approve/reject | Yes | Yes | No |
| Reports | Yes | Yes | Yes |
| Import | Yes | No | No |
| Backup/health/rebuild | Yes | Health read | No |
| Audit mutation | No edit/delete | No edit/delete | No edit/delete |

## 4. Master Endpoints

### `GET /products`, `/categories`, `/units`, `/unit-aliases`, `/warehouses`, `/suppliers`

Authenticated. Supports:

```text
page, limit, q, status
```

### `POST /products`

ADMIN only. Required product code, name, category, base unit. Duplicate code returns `DUPLICATE_CODE`.

### `PATCH /products/:id`

ADMIN only. Updates allowed fields and writes audit.

### `POST /categories`, `/units`, `/unit-aliases`, `/warehouses`, `/suppliers`

ADMIN only. Validate code/reference and audit.

### `PATCH /categories/:id`, `/units/:id`, `/unit-aliases/:id`, `/warehouses/:id`, `/suppliers/:id`

ADMIN only. Updates allowlisted fields or deactivates the record. Referenced master rows cannot be physically deleted. Every change is audited.

### `GET /users`

ADMIN only. Paginated user list; never returns password hash or session secret.

### `POST /users`

ADMIN only. Creates active user with valid role.

### `PATCH /users/:id/status`

ADMIN only. Deactivation is soft; no physical delete.

## 5. Inventory Endpoints

### `GET /stock`

Authenticated. Filters:

```text
page, limit, product_id, warehouse_id, category_id, status, q
```

Read-only. Uses aggregate/cache query.

### `POST /transactions/stock-in`

ADMIN/SUPERVISOR/PETUGAS. Warehouse wajib berada dalam region user aktif.

Request:

```json
{
  "idempotencyKey":"filehash-row-001",
  "date":"2026-10-08",
  "reference":"INV-001",
  "supplier":"SUP-001",
  "warehouse":"WH-001",
  "code":"BRG-001",
  "batch":"B-001",
  "production_date":"2026-10-01",
  "expiry":"2026-12-01",
  "quantity":50,
  "unit":"kg",
  "price":12000,
  "notes":"Invoice supplier"
}
```

Required: `date`, `reference`, `code`, `warehouse`, `quantity`, `unit`, `idempotencyKey`. `batch` dan `expiry` opsional. Batch kosong disimpan sebagai `NULL` dan digabung pada satu row unbatched per barang+gudang.

Errors: `INVALID_PRODUCT`, `INVALID_WAREHOUSE`, `INVALID_UNIT`, `INVALID_SUPPLIER`, `DUPLICATE_TRANSACTION`, `INVALID_QUANTITY`.

### `POST /transactions/stock-out`

Request:

```json
{
  "idempotencyKey":"OUT-20261008-001",
  "reference":"REQ-001",
  "warehouse":"WH-001",
  "code":"BRG-001",
  "quantity":30,
  "unit":"kg",
  "reason":"Produksi"
}
```

Uses FEFO only across non-expired candidates. A batch is expired when `expiry_date < CURRENT_DATE`; such batches are excluded from normal stock-out. If non-expired stock cannot satisfy the full quantity, reject atomically with `INSUFFICIENT_STOCK` and create no ledger/batch/balance mutation. NULL expiry remains eligible and sorts last.

Errors: `INSUFFICIENT_STOCK`, `BATCH_STOCK_INSUFFICIENT`, `INVALID_PRODUCT`, `INVALID_UNIT`.

### `POST /transactions/opening`

ADMIN only and same-region warehouse only. Physical opening count only; historical invoice must use stock-in.

Request uses the stock-in fields. Required: `idempotencyKey`, `date`, `reference`, `warehouse`, `code`, `quantity`, `unit`. Quantity is finite, greater than zero, converted to product base unit, and stored positive.

Opening is allowed only when no ledger row exists for that product+warehouse. The service acquires a database lock and commits one `OPENING` ledger row, batch update, balance update, and audit row atomically. Same key+same canonical payload returns the original result; same key+different payload returns `IDEMPOTENCY_CONFLICT`.

Errors: `FORBIDDEN`, `REGION_FORBIDDEN`, `INVALID_PRODUCT`, `INVALID_WAREHOUSE`, `INVALID_UNIT`, `INVALID_QUANTITY`, `OPENING_ALREADY_EXISTS`, `IDEMPOTENCY_CONFLICT`.

### `GET /transactions`

Authenticated, paginated. Filters:

```text
from, to, type, product_id, warehouse_id, supplier_id, q, page, limit
```

### `GET /stock-card/:productId`

Authenticated. Optional `warehouse_id`, date filters. Returns ledger-derived movement list and running balance.

## 6. Opname Endpoints

### `POST /opnames`

ADMIN/SUPERVISOR/PETUGAS according to permission. SUPERVISOR may create any opname. Creates snapshot and items. Returns `DRAFT`.

### `GET /opnames`

Authenticated, paginated. Filters `status`, warehouse, date, q.

### `GET /opnames/:id`

Authenticated. For blind counting, PETUGAS response must not expose `system_quantity`.

### `POST /opnames/:id/start`

Owner ADMIN/PETUGAS or any SUPERVISOR. Moves `DRAFT` or `REJECTED` to `COUNTING` and resets recount fields.

### `POST /opnames/:id/counts`

Owner ADMIN/PETUGAS or any SUPERVISOR. Request contains item IDs and physical quantities. All quantities must be finite and >= 0.

### `POST /opnames/:id/submit`

Owner ADMIN/PETUGAS or any SUPERVISOR. Validates all items counted and requires reason for non-zero difference. Moves to `SUBMITTED`.

### `POST /opnames/:id/reject`

ADMIN/SUPERVISOR only. Requires rejection reason. Moves to `REJECTED`.

### `POST /opnames/:id/approve`

ADMIN/SUPERVISOR only. SUPERVISOR may approve an opname they counted themselves. Transaction and lock required. Checks snapshot movement and creates adjustment ledger rows. Moves to `APPROVED` only after commit-ready validation.

Errors: `INVALID_STATUS`, `STOCK_MOVED_DURING_OPNAME`, `STOCK_CHANGED_AFTER_OPNAME`, `REASON_REQUIRED`, `NEGATIVE_STOCK`.

## 7. Import Endpoints

### `POST /imports/preview`

ADMIN only. Accepts CSV metadata and UTF-8 content. Does not write ledger.

Request metadata:

```json
{"type":"PRODUCTS|STOCKIN|STAGING_OCR","fileName":"...","fileHash":"<sha256>","content":"..."}
```

Returns row counts, normalized headers, preview rows, errors, and review rows.

### `POST /imports/:batchId/confirm`

ADMIN only. Confirmation is enabled only for `STOCKIN` batches with every row `READY`.
Revalidates actor, region, master data, preview version, and every row server-side; commits stock ledger, batch, balance, row/batch status, confirmation identity, and audit atomically.

```json
{"previewVersion":"1","idempotencyKey":"stable-client-key"}
```

Same key, batch, version, and actor returns the committed result without adding stock. Reuse with a changed identity returns `IDEMPOTENCY_CONFLICT`.

Errors: `IMPORT_NOT_FOUND`, `IMPORT_TYPE_UNSUPPORTED`, `IMPORT_PREVIEW_STALE`, `IMPORT_REVIEW_REQUIRED`, `IDEMPOTENCY_CONFLICT`, and stock-in validation/authorization errors.

### `GET /imports/:batchId`

ADMIN only. Returns row status and validation errors.

## 8. Dashboard and Reports

### `GET /dashboard`

Authenticated. Returns read-only aggregate metrics:

```text
total_products,total_stock,safe,low,out,expired,expiring_7d,expiring_30d,pending_opnames,recent_transactions,total_adjustment
```

### `GET /reports/:type`

Types:

```text
STOCK
STOCK_CARD
IN
OUT
ADJUSTMENT
OPNAME
OPNAME_DIFFERENCE
BATCH_EXPIRY
```

Filters: date, product, category, warehouse, supplier, status, page, limit.

### `GET /reports/:type/export?format=CSV`

Authenticated. CSV first. XLSX/PDF only when enabled and tested. Large result should stream.

## 9. Maintenance Endpoints

### `GET /health`

Public/internal health endpoint. Does not expose secrets. Checks app and database connectivity.

### `GET /maintenance/health-check`

ADMIN/SUPERVISOR. Checks schema, references, negatives, ledger/balance mismatch, opname states, and audit completeness.

### `POST /maintenance/backup`

ADMIN only. Creates backup, records metadata, checksum, and status.

### `GET /maintenance/backups`

ADMIN only. Lists backup metadata.

### `POST /maintenance/rebuild-balances`

ADMIN only. Runs `BACKUP → LOCK → REBUILD → RECONCILE → AUDIT`. Fails without mutation if ledger would create negative stock or reconciliation fails.

## 10. Idempotency

All stock mutations and confirmed imports require stable `idempotencyKey`.

Rules:

- same key + same payload returns original result
- same key + different payload returns `IDEMPOTENCY_CONFLICT`
- committed key cannot be reused
- idempotency record and ledger mutation commit atomically

## 11. Pagination

Default:

```text
page=1
limit=50
max_limit=500
```

Response list shape:

```json
{
  "items": [],
  "page": 1,
  "limit": 50,
  "total": 0,
  "hasNext": false
}
```

## 12. API Gate

PASS requires:

- OpenAPI/schema validation
- role negative tests
- actionable error codes
- idempotency tests
- concurrency tests for stock mutation
- no sensitive error leakage
- pagination test
- API smoke test against Docker PostgreSQL

**Status:** APPROVED sebagai API contract v0.1.0. Auth, master data, Opening Stock, Stock In, dan Stock Out API sudah diterapkan; endpoint read model, opname, import, report, dan maintenance masih pending. Bukti as-built: [`IMPLEMENTATION_STATUS.md`](IMPLEMENTATION_STATUS.md).

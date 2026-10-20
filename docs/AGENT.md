# AGENT.md — Stock Opname SPPG PAKISKEMBAR 2

## Project

Web Stock Opname untuk operasional SPPG PAKISKEMBAR 2.

Target deployment:

- Docker Compose
- Node.js backend API
- PostgreSQL database
- HTML/CSS/Vanilla JavaScript frontend
- No frontend framework unless explicitly approved
- No external database besides PostgreSQL target
- Deploy target: CT104 or approved Docker host

Google Apps Script + Google Sheets is migration source/reference only. Do not treat old GAS code as target architecture.

## Non-Negotiable Priorities

1. Data accuracy
2. Stock integrity
3. Auditability
4. Server-side security
5. Backup and recovery
6. Performance
7. UX convenience

Never sacrifice stock integrity to simplify UI or migration.

## Working Rules

- Inspect existing code, schema, migrations, and tests before changing code.
- Identify root cause before fixing bugs.
- Make smallest safe change.
- Preserve business rules unless user explicitly changes them.
- Do not invent missing master references or categories.
- Do not silently alter approved rules.
- Do not delete data, drop tables, reset database, or run destructive migration without explicit confirmation.
- Do not claim a feature exists until code and tests prove it.
- Do not fabricate test output, migration results, API responses, or deployment status.
- Keep changes reviewable. Avoid unrelated refactors.
- Prefer native platform and existing dependencies before adding packages.
- Keep production secrets out of Git, images, logs, and client responses.

## Required Architecture

```text
Frontend
  ↓
HTTP API
  ↓
Authorization middleware
  ↓
Application service
  ↓
PostgreSQL transaction
  ├── stock_transactions — immutable ledger/source of truth
  ├── stock_batches — batch quantity and expiry
  ├── stock_balances — current cache, rebuildable
  └── audit_logs — append-only audit trail
```

- `stock_transactions` is source of truth for stock history.
- `stock_balances` is cache, never sole source of truth.
- Every stock mutation must create ledger row(s) in same DB transaction as balance/batch updates.
- Balance rebuild must calculate from ledger, then reconcile.
- Use database transaction and row/advisory locks for stock mutation, opname creation, submission, approval, adjustment, and rebuild.
- Do not use application-only locks for concurrency protection.

## Roles and Authorization

Roles:

- `ADMIN`: all capabilities inside the user's region; master data, users, imports, backup, health check, rebuild.
- `SUPERVISOR`: dashboard, transactions, create/count/submit stock opname, approval/rejection inside the user's region, reports.
- `PETUGAS`: stock movement, stock visibility, and physical counting inside the user's region; cannot approve adjustment or modify audit logs.
- Every user belongs to exactly one region. Every warehouse belongs to exactly one region.
- Every warehouse-scoped read and mutation must enforce `user.region_id = warehouse.region_id` server-side for every role, including ADMIN.

Rules:

- Authorization is mandatory server-side on every protected endpoint/service.
- Frontend hiding is UX only, never security.
- Add negative authorization tests for every protected mutation.
- Audit login, authorization-sensitive actions, and failed critical mutations where appropriate.

Login response contract:

```json
{
  "userId": "...",
  "email": "...",
  "role": "ADMIN|SUPERVISOR|PETUGAS",
  "token": "...",
  "license": "..."
}
```

`license` wajib berupa literal publik `SELF_HOSTED`, ditetapkan sebagai application constant. Nilai ini bukan license key, bukan secret, dan tidak dibaca dari database atau environment.

Authentication baseline:

- Login uses local account over public HTTPS.
- API authorization uses session cookie with `HttpOnly`, `Secure`, and `SameSite=Lax`; never Bearer token.
- Response field `token` is non-secret session reference for UI compatibility.
- Never store session credentials or `token` in `localStorage`.
- Every cookie-authenticated mutation requires CSRF protection.
- Frontend obtains the session-bound CSRF token from `GET /auth/csrf`, stores it in memory only, and sends `X-CSRF-Token` on mutations.
- Runtime is Node.js 22 with pnpm.

## Inventory Rules

### Stock in

```text
validate
→ resolve product
→ resolve warehouse
→ resolve unit and alias
→ idempotency check
→ insert transaction ledger
→ update batch
→ update balance
→ audit
```

Required fields:

```text
date, reference, code, warehouse, quantity, unit
```

Optional fields:

```text
supplier, batch, production_date, expiry, price, notes
```

### Stock out

- Validate available stock before mutation.
- Reject insufficient stock.
- Never allow negative balance or batch quantity.
- Normal stock-out wajib mengecualikan batch dengan `expiry_date < CURRENT_DATE`.
- Jika quantity hanya dapat dipenuhi dengan batch kedaluwarsa, reject seluruh request dengan `INSUFFICIENT_STOCK`; jangan membuat ledger/balance/batch mutation.
- Use FEFO pada batch yang belum kedaluwarsa: expiry nearest first, missing expiry last.
- Record every batch allocation as a separate ledger row.
- Apply all allocations atomically.

### Units

Resolve direct code/name and aliases before rejecting:

```text
biji, bii, bji, pcs → PCS
gram, g → GRAM
kg, kilogram → KILOGRAM
pak, pack, bks, bungkus → PACK
dos, dus → DUS
```

Unknown unit must return actionable error, not create random unit.

### Opening stock

- `ADMIN` only, inside the user's region.
- Represents an approved physical opening count only; historical invoices remain `IN`.
- Required: `idempotencyKey`, `date`, `reference`, `warehouse`, `code`, `quantity`, `unit`.
- Quantity must be finite and greater than zero, then stored in the product base unit.
- Optional batch, production date, expiry, price, and notes follow stock-in batch rules.
- Allowed only when no ledger row exists yet for the product+warehouse pair.
- Same idempotency key and same canonical payload returns the original result; a different payload returns `IDEMPOTENCY_CONFLICT`.
- Ledger, batch, balance, and audit writes commit in one PostgreSQL transaction under database lock.

## Stock Opname

Statuses:

```text
DRAFT → COUNTING → SUBMITTED → APPROVED
                     └──────→ REJECTED → COUNTING (recount)
```

Rules:

- Create snapshot when opname is created.
- Default counting is blind; PETUGAS must not see system quantity.
- Physical count required for every item before submit.
- Non-zero difference requires reason.
- PETUGAS cannot approve adjustment.
- Approval must fail or require explicit safe mechanism when transactions occurred after snapshot.
- Approval must validate snapshot balance and batch state under lock.
- Adjustment must create `ADJUSTMENT` ledger rows before marking opname approved.
- Reject requires reason.
- Recount clears old physical quantity, difference, difference value, reason, and stale count notes according to schema.

Acceptance scenario:

```text
Opening 100 kg
+ Stock in 50 kg
- Stock out 30 kg
= System stock 120 kg
Physical count 118 kg
Difference -2 kg
Approve
Adjustment -2 kg
Final balance 118 kg
```

## Import Rules

Separate files strictly:

```text
STAGING: STOCK_IN_REVIEW_...
READY:   STOCK_IN_IMPORT_..._READY.csv
```

STAGING OCR fields:

```text
source_pdf,page,category,description_raw,quantity,unit_raw,unit_price,line_total,review_status,notes
```

READY fields:

```text
date,reference,supplier,warehouse,code,batch,production_date,expiry,quantity,unit,price,notes
```

Workflow:

```text
UPLOAD → PARSE → VALIDATE → PREVIEW → USER CONFIRM → IMPORT
```

- Upload and preview never write ledger.
- OCR uncertainty remains `REVIEW`.
- Unknown product, unit, category, date, or reference must not become valid transaction.
- Validate all rows before commit unless explicit reviewed row-level import is approved.
- Import must be idempotent using stable external reference/file hash/idempotency key.
- Duplicate import must not increase stock twice.
- Historical invoice is `BARANG MASUK`, not opening stock.
- Opening stock only comes from approved physical opening count.

Master import errors:

```text
CATEGORY_NOT_FOUND
UNIT_NOT_FOUND
```

## Database and Migration Rules

- Migrations are forward-only and non-destructive by default.
- Never use `DROP`, `TRUNCATE`, delete-all, or reset database in automatic migration.
- Every migration must be repeatable or tracked by migration table.
- Add foreign keys, unique constraints, check constraints, and indexes at database layer.
- Enforce non-negative balance and batch quantities in database/application layers.
- Ledger and audit tables are append-only from application API.
- Maintain migration source export from GAS as immutable archive.
- Reconcile source and target by row count, master IDs/codes, ledger totals, balances, batches, and opname states.

Required tables:

```text
users
products
categories
units
unit_aliases
warehouses
suppliers
stock_batches
stock_balances
stock_transactions
stock_opnames
stock_opname_items
staging_ocr_lines
ready_import_rows
audit_logs
backup_logs
```

## Audit Requirements

Audit important actions:

```text
login
create/update/deactivate master
create/update user
import preview/import
stock in
stock out
opening stock
opname create
opname submit
opname approve
opname reject
adjustment
backup
restore
rebuild balance
health check failure
```

Minimum audit fields:

```text
id, timestamp, user_id, action, module, reference, details
```

Audit log has no edit/delete UI or normal API mutation.

## Backup and Recovery

Before rebuild or migration:

```text
BACKUP → CHANGE → RECONCILE → AUDIT
```

- Backup must include database and migration metadata.
- Test restore in isolated database before production restore.
- Keep backup destination separate from primary Docker volume.
- Monitor backup age and backup success.
- Never claim backup is valid without checking file existence, size, and restore/read test.
- Daily backup is stored locally and copied to Google Drive.
- Retention is 7 daily, 4 weekly, and 12 monthly backups.
- Recovery target is RPO 24 hours and RTO 4 hours.
- GAS/Google Sheets stays read-only for seven days after cutover, then is archived.

## API and Error Handling

Every server call must catch errors and return actionable structured errors.

Preferred response shape:

```json
{
  "success": false,
  "errorCode": "INSUFFICIENT_STOCK",
  "message": "Stok tidak mencukupi. Tersedia 10 kg.",
  "details": {}
}
```

Examples:

```text
Barang BRG-001 tidak ditemukan.
Gudang Gudang Utama tidak ditemukan.
Satuan 'bks' tidak ditemukan dan tidak memiliki alias.
Stok tidak mencukupi. Tersedia 10 kg.
Ada transaksi setelah snapshot opname. Approval dibatalkan.
```

Never expose stack traces, SQL, tokens, passwords, or internal filesystem paths to users.

## Frontend Rules

- Responsive: mobile-first for PETUGAS; desktop-friendly for ADMIN/SUPERVISOR.
- Dashboard is read-only.
- Navigation: Dashboard, Stok, Transaksi, Kartu Stok, Stock Opname, Laporan, Import/Export.
- ADMIN additionally sees Barang, Kategori, Satuan, Gudang, Supplier, Pengguna, Sistem.
- Modal must support cancel, backdrop close, Escape close, and cleanup of overlay state.
- Show loading, success, and actionable error states.
- Do not rely on frontend role hiding for access control.
- Escape user-provided HTML; prevent XSS.
- Do not load entire transaction history for dashboard aggregates.

## Performance Rules

- Use SQL aggregation for dashboard metrics.
- Paginate transaction, audit, report, and batch lists.
- Avoid N+1 queries.
- Use batch reads/writes and prepared statements.
- Add indexes based on measured query plans.
- Do not load all database tables into memory per request.
- Stream large CSV exports when needed.
- Measure with production-like row counts before declaring ready.

## Docker Rules

- App listens on `0.0.0.0`.
- Published port must match actual app listen port.
- PostgreSQL data uses persistent named volume or bind mount with backup.
- Secrets come from `.env`/secret manager, never committed.
- Use healthchecks and restart policy.
- Pin major dependency/runtime versions.
- Use multi-stage build only when it improves verified result; single-stage is acceptable for reliability.
- Do not run destructive Docker cleanup automatically.
- Validate Docker inside target CT, not only on Proxmox host.
- Runtime baseline is Node.js 22 with pnpm.
- Public access requires HTTPS before secure cookie authentication is enabled.

Validation commands:

```bash
docker compose config
docker compose build
docker compose up -d
docker compose ps
curl -f http://127.0.0.1:<PORT>/health
docker compose logs --tail=200 app
```

## Testing Requirements

Before release, run:

```text
backend syntax/build
frontend syntax/build
migration check
schema check
duplicate function check
role authorization tests
negative stock tests
FEFO tests
idempotent import tests
transaction concurrency tests
opname state tests
snapshot movement guard tests
recount tests
audit log tests
backup/restore tests
health check tests
ledger/balance reconciliation
```

Required scenario matrix:

- valid stock in
- valid stock out
- stock out greater than stock
- duplicate import
- invalid product
- invalid unit and alias
- invalid warehouse
- expired batch
- multi-batch FEFO
- concurrent transaction
- opname reject/recount
- transaction after opname snapshot
- approval adjustment
- negative adjustment protection
- rebuild balance from ledger

## Definition of Done

A feature is done only when:

- implementation exists in repository
- server-side authorization exists
- data constraints exist
- regression test exists for non-trivial logic
- tests have actually run
- migration impact is known
- audit behavior is verified
- backup/recovery impact is verified
- no destructive behavior was introduced
- deployment health check passes

Report status as `PASS`, `FAIL`, or `NOT VERIFIED`. Never replace missing evidence with assumption.

## Change Report Format

Use concise report:

```text
Changed:
- path — exact change

Verification:
- Build: PASS/FAIL/NOT VERIFIED
- Tests: PASS/FAIL/NOT VERIFIED
- Migration: PASS/FAIL/NOT VERIFIED
- Runtime: PASS/FAIL/NOT VERIFIED

Risks:
- exact remaining risk

Next:
- one concrete next task
```

## Stop Conditions

Stop and report before continuing when:

- migration would delete or rewrite production data
- source and target stock totals mismatch
- ledger/balance reconciliation fails
- authorization test fails
- backup or restore verification fails
- database lock behavior is unverified for stock mutation
- requirement conflicts with existing approved business rule
- required source code or schema is missing

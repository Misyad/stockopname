# Database Design — Stock Opname SPPG PAKISKEMBAR 2

**Status:** Approved v0.1.0 — implementation baseline  
**Database:** PostgreSQL

## 1. Rules

- UUID/ULID primary key.
- Foreign key wajib untuk reference.
- Migration forward-only dan non-destructive.
- Ledger dan audit append-only dari application API.
- Balance/batch tidak boleh negatif.
- Semua stock mutation atomic.
- `stock_balances` dapat direbuild dari `stock_transactions`.

## 2. Tables

### regions

```text
id uuid pk
code varchar unique not null
name varchar not null
status varchar check ACTIVE|INACTIVE
created_at timestamptz
updated_at timestamptz
```

### users

```text
id uuid pk
name varchar not null
email varchar unique not null
password_hash varchar not null
role varchar check ADMIN|SUPERVISOR|PETUGAS
status varchar check ACTIVE|INACTIVE
region_id uuid not null fk regions(id)
created_at timestamptz
updated_at timestamptz
```

Password credentials are local-account hashes only; never store plaintext password.

### auth_sessions

```text
id uuid pk
user_id uuid not null fk users(id)
reference varchar unique not null
secret_hash varchar unique not null
csrf_secret_hash varchar not null
expires_at timestamptz not null
last_seen_at timestamptz null
revoked_at timestamptz null
created_at timestamptz not null
```

Browser receives only opaque session secret in secure HttpOnly cookie. JSON field `token` contains `reference`, not session secret.

### categories

```text
id uuid pk
code varchar unique not null
name varchar not null
status varchar check ACTIVE|INACTIVE|REVIEW
created_at timestamptz
updated_at timestamptz
```

### units

```text
id uuid pk
code varchar unique not null
name varchar not null
symbol varchar not null
base_unit_id uuid null fk units(id)
conversion_to_base numeric not null check > 0
status varchar check ACTIVE|INACTIVE
created_at timestamptz
updated_at timestamptz
```

### unit_aliases

```text
id uuid pk
alias varchar unique not null
unit_id uuid not null fk units(id)
status varchar check ACTIVE|INACTIVE
created_at timestamptz
updated_at timestamptz
```

### products

```text
id uuid pk
code varchar unique not null
barcode varchar unique null
name varchar not null
category_id uuid not null fk categories(id)
base_unit_id uuid not null fk units(id)
purchase_unit_id uuid null fk units(id)
conversion_factor numeric not null check > 0
minimum_stock numeric not null default 0 check >= 0
maximum_stock numeric not null default 0 check >= 0
photo_url text null
status varchar check ACTIVE|INACTIVE|REVIEW
created_at timestamptz
updated_at timestamptz
```

### warehouses

```text
id uuid pk
code varchar unique not null
name varchar not null
location text null
status varchar check ACTIVE|INACTIVE
region_id uuid not null fk regions(id)
created_at timestamptz
updated_at timestamptz
```

### suppliers

```text
id uuid pk
code varchar unique not null
name varchar not null
phone varchar null
address text null
status varchar check ACTIVE|INACTIVE
created_at timestamptz
updated_at timestamptz
```

### stock_batches

```text
id uuid pk
product_id uuid not null fk products(id)
warehouse_id uuid not null fk warehouses(id)
batch_number varchar null
production_date date null
expiry_date date null
quantity numeric not null check >= 0
unit varchar not null
purchase_price numeric not null default 0 check >= 0
status varchar check ACTIVE|DEPLETED|INACTIVE
created_at timestamptz
updated_at timestamptz
unique(product_id, warehouse_id, batch_number) where batch_number is not null
unique(product_id, warehouse_id) where batch_number is null
```

### stock_balances

```text
id uuid pk
product_id uuid not null fk products(id)
warehouse_id uuid not null fk warehouses(id)
quantity numeric not null check >= 0
version bigint not null default 0
updated_at timestamptz
unique(product_id, warehouse_id)
```

### stock_transactions

```text
id uuid pk
idempotency_key varchar unique not null
transaction_number varchar not null
transaction_type varchar check IN|OUT|OPENING|ADJUSTMENT|REVERSAL
reference_id varchar not null
product_id uuid not null fk products(id)
warehouse_id uuid not null fk warehouses(id)
batch_id uuid null fk stock_batches(id)
supplier_id uuid null fk suppliers(id)
quantity numeric not null check <> 0
unit varchar not null
balance_before numeric not null
balance_after numeric not null check >= 0
reason text null
user_id uuid not null fk users(id)
created_at timestamptz not null
```

OUT quantity is negative. IN, OPENING, and positive adjustment are positive. Every batch allocation is a separate row.

### stock_opnames

```text
id uuid pk
opname_number varchar unique not null
warehouse_id uuid not null fk warehouses(id)
opname_date date not null
status varchar check DRAFT|COUNTING|SUBMITTED|APPROVED|REJECTED
snapshot_at timestamptz not null
snapshot_version bigint not null
created_by uuid not null fk users(id)
submitted_at timestamptz null
approved_by uuid null fk users(id)
approved_at timestamptz null
rejection_reason text null
notes text null
created_at timestamptz
updated_at timestamptz
```

### stock_opname_items

```text
id uuid pk
opname_id uuid not null fk stock_opnames(id)
product_id uuid not null fk products(id)
batch_id uuid null fk stock_batches(id)
system_quantity numeric not null check >= 0
physical_quantity numeric null check >= 0
difference numeric null
difference_value numeric null
unit varchar not null
unit_price numeric not null default 0
reason text null
notes text null
```

### import_batches

```text
id uuid pk
import_type varchar check PRODUCTS|STOCKIN|STAGING_OCR
file_name varchar not null
file_hash varchar not null
preview_version bigint not null default 1
status varchar check PREVIEW|READY|IMPORTED|REVIEW|REJECTED
row_count integer not null default 0 check >= 0
created_by uuid not null fk users(id)
created_at timestamptz not null
confirmed_at timestamptz null
unique(file_hash, import_type)
```

### staging_ocr_lines

```text
id uuid pk
import_batch_id uuid not null fk import_batches(id)
file_hash varchar not null
source_pdf varchar
page integer
category varchar
description_raw text
quantity numeric null
unit_raw varchar null
unit_price numeric null
line_total numeric null
review_status varchar check REVIEW|READY|REJECTED
notes text null
created_by uuid fk users(id)
created_at timestamptz
```

### ready_import_rows

```text
id uuid pk
import_batch_id uuid not null fk import_batches(id)
row_number integer not null
file_hash varchar not null
date date
reference varchar
supplier varchar
warehouse varchar
code varchar
batch varchar
production_date date null
expiry date null
quantity numeric
unit varchar
price numeric
notes text
status varchar check PREVIEW|READY|IMPORTED|REVIEW|REJECTED
error_code varchar null
error_message text null
created_at timestamptz
unique(file_hash, row_number)
```

### audit_logs

```text
id uuid pk
timestamp timestamptz not null
user_id uuid null fk users(id)
action varchar not null
module varchar not null
reference varchar null
details jsonb not null default '{}'
```

### backup_logs

```text
id uuid pk
backup_type varchar not null
file_name varchar not null
storage_uri text not null
size_bytes bigint
checksum varchar
status varchar check STARTED|COMPLETED|FAILED|VERIFIED
created_by uuid null fk users(id)
created_at timestamptz
verified_at timestamptz null
```

## 3. Required Indexes

```text
stock_balances(product_id, warehouse_id)
auth_sessions(user_id, expires_at)
stock_batches(product_id, warehouse_id, expiry_date)
stock_transactions(product_id, warehouse_id, created_at)
stock_transactions(reference_id)
stock_transactions(created_at)
stock_opnames(warehouse_id, status)
stock_opname_items(opname_id)
import_batches(file_hash, import_type)
staging_ocr_lines(import_batch_id, review_status)
ready_import_rows(import_batch_id, status)
audit_logs(timestamp)
audit_logs(module, action)
```

## 4. Integrity Rules

1. Database rejects negative balance/batch.
2. Application locks balance rows before stock mutation.
3. `idempotency_key` prevents duplicate transaction.
4. Approval locks opname, balances, and required batches.
5. Ledger is not editable through normal API.
6. Balance reconciliation compares aggregate ledger with balance.
7. Batch reconciliation compares batch totals with product/warehouse balance; documented residual policy required for legacy data.
8. Normal stock-out allocation queries must exclude `stock_batches.expiry_date < CURRENT_DATE`; NULL expiry remains eligible and sorts last.
9. Hard delete is disabled for master records referenced by transactions.

## 5. Migration Policy

- Every migration has ordered version.
- No automatic `DROP`, `TRUNCATE`, or reset.
- Backup before schema/data migration.
- Import master before transactional data.
- Historical invoice maps to `IN`, not `OPENING`.
- Rebuild balances from ledger after transaction import.
- Run health check and reconciliation before cutover.

## 6. Seed Data

Seed only reference data that is explicitly approved:

- unit aliases
- approved categories
- initial admin only through secure setup flow

Seeds must be idempotent by code/alias, never random duplicate rows.

## 7. Database Gate

PASS requires:

- all tables and columns present
- constraints active
- indexes created
- migration repeatable
- schema inspection clean
- fixture stock scenario passes
- rollback/restore test passes

**Status:** APPROVED sebagai database design contract v0.1.0. Migration `001`–`006` sudah diterapkan untuk schema foundation, region/idempotency, ordering, immutable ledger, dan stock-out request. Gap implementasi tetap dilacak di [`IMPLEMENTATION_STATUS.md`](IMPLEMENTATION_STATUS.md).

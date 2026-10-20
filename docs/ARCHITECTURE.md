# Architecture — Stock Opname SPPG PAKISKEMBAR 2

**Status:** Approved v0.1.0 — implementation baseline  
**Target:** Docker Compose + PostgreSQL  
**Source migration:** Google Apps Script + Google Sheets

## 1. Decision

Gunakan modular monolith: satu service aplikasi Node.js dan satu PostgreSQL container. Frontend tetap Vanilla JavaScript. Jangan port `Code.gs` line-by-line; port business rule ke service transactional.

Baseline:

- Node.js 22 dan pnpm.
- Login akun lokal melalui public HTTPS.
- Session memakai cookie `HttpOnly`, `Secure`, `SameSite=Lax`; `token` hanya session reference non-secret.
- Permission stok global sesuai role, tanpa scope per gudang atau supplier.
- Backup lokal harian plus salinan Google Drive; retensi 7 harian, 4 mingguan, 12 bulanan.
- RPO 24 jam; RTO 4 jam.
- Rollback window tujuh hari; GAS/Sheets read-only lalu arsip.
- Expiry opsional; batch tanpa expiry valid dan ditempatkan terakhir oleh FEFO.
- Normal stock-out mengecualikan batch dengan `expiry_date < CURRENT_DATE`; kekurangan stok non-kedaluwarsa ditolak atomik.
- SUPERVISOR boleh create/count/submit/approve/reject semua opname, termasuk opname yang dihitung sendiri.
- Login response `license` memakai application constant publik `SELF_HOSTED`, bukan database/environment/secret.

## 2. System Flow

```text
Browser
  ↓ HTTPS
Reverse proxy
  ↓
Node.js app
  ├─ auth middleware
  ├─ RBAC middleware
  ├─ master service
  ├─ inventory service
  ├─ opname service
  ├─ import service
  ├─ report service
  └─ maintenance service
       ↓ SQL transaction + lock
PostgreSQL
```

## 3. Docker Topology

```text
app :3000  →  postgres :5432
```

Rules:

- app listen `0.0.0.0`.
- PostgreSQL tidak diekspos publik.
- Data PostgreSQL memakai persistent volume.
- Secrets hanya dari environment/secret store.
- Healthcheck app dan database wajib.
- Backup disimpan di storage terpisah dari volume database.

## 4. Domain Boundaries

### Auth
Login lokal, secure cookie session, CSRF protection, user status, role. Field response `token` hanya session reference non-secret.

### Master
Products, categories, units, aliases, warehouses, suppliers, users.

### Inventory
Ledger, batches, balances, stock in, stock out, opening stock, FEFO.

### Opname
Snapshot, blind count, submit, review, approval, rejection, recount, adjustment.

### Import
CSV parse, staging OCR, READY preview, validation, idempotency, commit.

### Reporting
Dashboard read-only, stock card, transaction, adjustment, opname, expiry.

### Maintenance
Health check, backup, restore verification, rebuild balance, audit.

## 5. Stock Mutation Contract

```text
request
→ authenticate
→ authorize
→ validate input
→ begin DB transaction
→ acquire lock
→ resolve references
→ check idempotency
→ write ledger
→ update batch/balance
→ write audit
→ commit
```

Jika salah satu tahap gagal, seluruh mutation rollback.

### Source of truth

- `stock_transactions`: immutable ledger.
- `stock_batches`: quantity batch dan expiry.
- `stock_balances`: cache current balance.
- `audit_logs`: append-only activity trail.

Tidak boleh update balance tanpa ledger.

## 6. Stock Out and FEFO

1. Lock balance/batch rows.
2. Keluarkan batch dengan `expiry_date < CURRENT_DATE` dari kandidat normal stock-out.
3. Validasi total quantity non-kedaluwarsa.
4. Urutkan kandidat berdasarkan expiry ascending.
5. Batch tanpa expiry diletakkan terakhir.
6. Allocate sampai quantity terpenuhi.
7. Buat satu ledger row per allocation.
8. Update batch dan balance dalam transaction.
9. Reject seluruh request dengan `INSUFFICIENT_STOCK` tanpa mutation jika stok non-kedaluwarsa kurang.

## 7. Opname Flow

```text
DRAFT
  → COUNTING
  → SUBMITTED
  → APPROVED

SUBMITTED → REJECTED → COUNTING
```

Create opname menyimpan snapshot. Approval memeriksa:

- status masih `SUBMITTED`
- semua item memiliki physical count
- difference non-zero punya alasan
- tidak ada transaksi setelah snapshot
- balance/batch masih cocok snapshot
- adjustment tidak membuat stok negatif

## 8. Import Flow

```text
UPLOAD → PARSE → VALIDATE → PREVIEW → CONFIRM → TRANSACTION
```

`STOCK_IN_REVIEW_*` masuk staging saja. Hanya `STOCK_IN_IMPORT_*_READY.csv` yang boleh diproses ke ledger setelah confirm dan validasi. Historical invoice selalu dipetakan ke ledger `IN`, bukan `OPENING`.

## 9. Authorization

- ADMIN: semua service dalam region user.
- SUPERVISOR: read inventory, reports, serta create/count/submit/approve/reject opname dalam region user, termasuk opname yang dihitung sendiri.
- PETUGAS: stock movement dan counting dalam region user; tidak boleh approval.
- Setiap user dan gudang memiliki satu `region_id`; semua role wajib lolos kecocokan region server-side.

Authorization wajib di route dan service. Frontend hanya menyembunyikan control.

## 10. Performance

- SQL aggregate untuk dashboard.
- Pagination pada transaksi, audit, batch, laporan.
- Hindari N+1 query.
- Index product/warehouse, expiry, created_at, opname status.
- Export besar streaming.
- Jangan load seluruh database ke memory per request.

## 11. Backup and Recovery

```text
BACKUP → CHANGE/REBUILD → RECONCILE → AUDIT
```

Rebuild balance selalu dari ledger. Backup harian disimpan lokal dan disalin ke Google Drive dengan retensi 7 harian, 4 mingguan, dan 12 bulanan. Restore harus diuji di database terisolasi. Target RPO 24 jam dan RTO 4 jam.

## 12. Deployment Boundary

Deploy public HTTPS ke CT104 atau Docker host yang disetujui. Validasi Docker di target host. Jangan menganggap Docker tersedia di Proxmox host. GAS/Google Sheets read-only selama rollback window tujuh hari lalu diarsipkan.

## 13. Forbidden Patterns

- balance mutation tanpa ledger
- authorization frontend-only
- destructive migration otomatis
- import OCR langsung ke ledger
- random category/unit ID
- silent duplicate import
- hardcoded secrets
- SQL string concatenation
- approval tanpa snapshot guard
- report membaca seluruh histori tanpa pagination/agregasi

## 14. Architecture Gate

Sebelum production:

- migration repeatable
- healthcheck PASS
- RBAC negative tests PASS
- ledger/balance reconciliation PASS
- concurrent stock test PASS
- backup restore PASS
- cutover rehearsal PASS

**Status:** APPROVED sebagai implementation baseline v0.1.0. Production deployment tetap memerlukan deployment gate terpisah.

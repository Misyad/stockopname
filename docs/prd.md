# PRD — Stock Opname SPPG PAKISKEMBAR 2

**Status:** Approved v0.1.0 — implementation baseline  
**Target:** Docker Compose + PostgreSQL  
**Product Owner:** Operasional SPPG PAKISKEMBAR 2  
**Source system:** Google Apps Script + Google Sheets  
**Primary language:** Bahasa Indonesia  

---

## 1. Ringkasan Produk

Aplikasi Stock Opname mengelola master barang, transaksi barang masuk/keluar, batch dan expiry, stok per gudang, stock opname blind count, approval adjustment, import invoice/OCR, laporan, audit, backup, dan health check.

Sistem lama berbasis Google Apps Script dan Google Sheets dimigrasikan ke aplikasi Docker agar memperoleh:

- transaksi database atomic
- concurrency control lebih kuat
- ledger stok immutable
- query dan pagination lebih baik
- backup dan restore terukur
- server-side authorization konsisten
- deployment repeatable

Google Sheets tetap menjadi sumber migrasi dan rollback reference selama cutover. Setelah cutover, Google Apps Script read-only.

## 2. Tujuan

### 2.1 Tujuan bisnis

1. Menyediakan satu sumber data stok yang akurat dan dapat diaudit.
2. Mencegah stok negatif dan duplicate transaction.
3. Mempercepat pencatatan barang masuk/keluar.
4. Memastikan hasil stock opname dapat direview dan disetujui secara formal.
5. Memudahkan import histori invoice tanpa mencampur data OCR meragukan ke ledger.
6. Menyediakan laporan stok, transaksi, expiry, dan adjustment.
7. Menyediakan backup, restore test, health check, dan rebuild balance.

### 2.2 Tujuan teknis

1. Menjalankan aplikasi melalui Docker Compose.
2. Menggunakan PostgreSQL sebagai database transaksi.
3. Menjadikan `stock_transactions` source of truth.
4. Menjadikan `stock_balances` cache yang bisa direbuild.
5. Menggunakan database transaction dan lock untuk mutation stok.
6. Menyediakan API dengan authorization server-side.
7. Menyediakan frontend HTML/CSS/Vanilla JavaScript responsive.

### 2.3 Baseline keputusan teknis

- Login memakai akun lokal.
- Aplikasi diakses melalui public HTTPS.
- Session utama memakai cookie `HttpOnly`, `Secure`, dan `SameSite=Lax`.
- Field `token` pada response login hanya session reference non-secret; bukan bearer credential dan tidak disimpan di `localStorage`.
- Runtime memakai Node.js 22 dan pnpm.
- Setiap user dan gudang memiliki tepat satu region. Semua role hanya boleh mengakses gudang dalam region user; server menolak akses lintas region.
- Backup harian disimpan lokal dan disalin ke Google Drive.
- Retensi: 7 harian, 4 mingguan, dan 12 bulanan.
- Target RPO 24 jam dan RTO 4 jam.
- Rollback window tujuh hari; GAS/Google Sheets read-only selama window lalu diarsipkan.
- Expiry opsional untuk semua barang. Batch tanpa expiry valid dan diproses setelah batch ber-expiry dalam FEFO.
- Normal stock-out menolak penggunaan batch kedaluwarsa (`expiry_date < CURRENT_DATE`).
- SUPERVISOR boleh membuat, menghitung, submit, approve, dan reject semua opname, termasuk opname yang dihitung sendiri.
- Login response `license` selalu literal publik `SELF_HOSTED`; bukan secret dan tidak berasal dari database/environment.

## 3. Non-Goals

Tidak termasuk fase awal:

- aplikasi mobile native
- multi-tenant SaaS
- integrasi ERP/accounting
- AI OCR otomatis tanpa review manusia
- Kubernetes
- microservices terpisah
- sinkronisasi dua arah permanen dengan Google Sheets
- perubahan business rule tanpa approval
- penghapusan histori GAS

CSV menjadi format export/import utama. XLSX dan PDF hanya ditambahkan setelah CSV stabil dan kebutuhan terukur.

## 4. Pengguna dan Role

| Role | Hak akses |
|---|---|
| ADMIN | Semua fitur, master data, user, import, backup, health check, rebuild balance |
| SUPERVISOR | Dashboard, stok, transaksi, create/count/submit/review/approve/reject semua stock opname, laporan |
| PETUGAS | Melihat stok sesuai permission, barang masuk/keluar sesuai permission, counting opname |

### Authorization rules

- Semua endpoint protected wajib memeriksa role di server.
- Hiding menu frontend bukan security control.
- PETUGAS tidak boleh approve adjustment.
- PETUGAS tidak boleh mengubah audit log.
- SUPERVISOR tidak boleh menjalankan fungsi ADMIN kecuali hak khusus disetujui.
- Setiap negative authorization scenario wajib diuji.

## 5. Prinsip Data dan Stock Integrity

### 5.1 Source of truth

```text
Stock mutation
  → stock_transactions (ledger immutable)
  → stock_batches
  → stock_balances (cache)
  → audit_logs
```

Tidak boleh ada perubahan saldo tanpa ledger.

### 5.2 Invariants

1. Stok balance tidak boleh negatif.
2. Stok batch tidak boleh negatif.
3. Setiap barang masuk/keluar/adjustment memiliki ledger row.
4. Semua batch allocation barang keluar tercatat.
5. `stock_balances` harus sama dengan agregasi ledger.
6. Rebuild balance harus menghasilkan nilai yang sama dengan ledger.
7. Duplicate idempotency key tidak boleh menambah stok.
8. Approval opname diblokir jika basis snapshot berubah.
9. Audit action kritis wajib memiliki user, action, module, reference, timestamp, details.

### 5.3 Concurrency

Gunakan PostgreSQL transaction dan row/advisory lock untuk:

- stock in
- stock out
- opening stock
- create opname
- save/submit counting
- approval
- adjustment
- rebuild balance
- import ledger

## 6. Modul Produk

### 6.1 Authentication

Login menghasilkan contract:

```json
{
  "userId": "...",
  "email": "...",
  "role": "ADMIN|SUPERVISOR|PETUGAS",
  "token": "...",
  "license": "SELF_HOSTED"
}
```

Field `license` selalu bernilai string `SELF_HOSTED`, ditetapkan sebagai application constant. Nilai ini bukan license key/secret dan tidak berasal dari database atau environment.

Acceptance criteria:

- user inactive ditolak
- session expiry ditolak
- protected endpoint tanpa cookie session valid ditolak
- role salah ditolak
- login diaudit
- password/session secret tidak masuk log
- response `token` hanya reference non-secret dan tidak disimpan di `localStorage`
- mutation berbasis cookie memakai CSRF protection

### 6.2 Master data

Master:

- PRODUCTS
- CATEGORIES
- UNITS
- SATUAN_ALIAS
- WAREHOUSES
- SUPPLIERS
- USERS

#### PRODUCTS fields

```text
id
code
barcode
name
category_id
base_unit_id
purchase_unit_id
conversion_factor
minimum_stock
maximum_stock
photo_url
status
created_at
updated_at
```

#### CATEGORIES fields

```text
id
code
name
status
created_at
updated_at
```

Kategori tidak boleh memakai grouping invoice sebagai kategori final:

```text
BAHAN BASAH
BAHAN KERING
BAHAN OPERASIONAL
```

Contoh kategori final:

```text
Protein Hewani
Protein Nabati
Sayuran Umbi/Akar
Sayuran Daun
Sayuran Buah
Bumbu Segar
Bumbu Kering & Rempah
Karbohidrat & Serealia
Tepung & Bahan Kering
Minyak & Lemak
Susu & Minuman
Kemasan
Bahan Kebersihan
```

Jika klasifikasi tidak cukup jelas, gunakan status `REVIEW`. Jangan membuat kategori berdasarkan asumsi.

#### UNITS fields

```text
id
code
name
symbol
base_unit_id
conversion_to_base
status
created_at
updated_at
```

#### SATUAN_ALIAS fields

```text
id
alias
unit_id
status
created_at
updated_at
```

Alias minimum:

```text
biji, bii, bji, pcs → PCS
gram, g → GRAM
kg, kilogram → KILOGRAM
pak, pack, bks, bungkus → PACK
dos, dus → DUS
```

Master acceptance criteria:

- code unik
- barcode unik jika terisi
- inactive master tidak dipakai untuk transaksi baru
- foreign key valid
- update/deactivate diaudit
- delete fisik tidak tersedia dari UI

### 6.3 Stock in

Input fields:

```text
date
reference
supplier
warehouse
code
batch
production_date
expiry
quantity
unit
price
notes
```

Flow:

```text
Input
→ validation
→ resolve product
→ resolve warehouse
→ resolve supplier
→ resolve unit/alias
→ idempotency check
→ insert ledger
→ update batch
→ update balance
→ audit
```

Acceptance criteria:

- field wajib divalidasi
- unit purchase dikonversi ke base unit
- batch supplier dibuat atau diperbarui jika nomor batch terisi
- jika batch kosong, stok digabung pada satu row unbatched (`batch_number = NULL`) per barang dan gudang; expiry tetap boleh kosong
- reference duplicate tidak menggandakan transaksi
- semua perubahan atomic

### 6.4 Stock out

Acceptance criteria:

- stok tidak cukup menghasilkan `INSUFFICIENT_STOCK`
- saldo tidak pernah negatif
- batch kedaluwarsa (`expiry_date < CURRENT_DATE`) tidak boleh dialokasikan pada normal stock-out
- jika stok non-kedaluwarsa tidak cukup, seluruh request ditolak dengan `INSUFFICIENT_STOCK` tanpa mutation
- batch non-kedaluwarsa dipilih FEFO
- expiry terdekat dipakai lebih dahulu
- batch tanpa expiry ditempatkan setelah batch ber-expiry
- setiap allocation dibuat sebagai ledger row
- satu request diproses atomic

### 6.5 Stock opname

Statuses:

```text
DRAFT
COUNTING
SUBMITTED
APPROVED
REJECTED
```

Flow:

```text
CREATE OPNAME
→ SNAPSHOT STOCK
→ COUNTING
→ PHYSICAL COUNT
→ SUBMIT
→ COMPARE
→ REVIEW
→ APPROVE / REJECT
```

Rules:

- default blind count
- PETUGAS tidak melihat system quantity ketika counting
- semua item wajib dihitung sebelum submit
- `difference = physical - system`
- difference non-zero wajib memiliki alasan
- approval wajib memeriksa transaksi setelah snapshot
- approval wajib memeriksa balance/batch snapshot
- adjustment masuk ledger
- reject wajib memiliki alasan
- recount membersihkan counting lama
- SUPERVISOR boleh create/count/submit serta approve/reject semua opname, termasuk opname yang dihitung sendiri

Acceptance scenario:

```text
Opening: 100 kg
Stock in: +50 kg
Stock out: -30 kg
System: 120 kg
Physical: 118 kg
Difference: -2 kg
Approved adjustment: -2 kg
Final balance: 118 kg
```

### 6.6 Dashboard

Dashboard read-only menampilkan:

- total barang
- total stok
- stok aman
- stok menipis
- stok habis
- expired
- akan expired <= 7 hari
- akan expired <= 30 hari
- opname pending
- transaksi terbaru
- total adjustment

Dashboard tidak boleh memutasi stok dan tidak boleh memuat seluruh histori hanya untuk agregasi.

### 6.7 Stock monitoring

Status stok:

```text
AMAN
MENDEKATI MINIMUM
MENIPIS
HABIS
```

Status expiry:

```text
EXPIRED
<= 7 HARI
<= 30 HARI
> 30 HARI
```

### 6.8 Reports

Jenis laporan:

- Stock Report
- Stock Card
- Barang Masuk
- Barang Keluar
- Adjustment
- Stock Opname
- Selisih Opname
- Batch & Expiry

Filter:

- tanggal
- barang
- kategori
- gudang
- supplier
- status

Export priority:

1. CSV
2. XLSX jika kebutuhan dan memory test lolos
3. PDF jika kebutuhan dan render test lolos

### 6.9 Import

#### Master import

Format:

```text
code,name,category,unit,minimum_stock,maximum_stock,barcode
```

Rules:

- preview sebelum import
- normalize header dan nama
- resolve category berdasarkan code/name
- resolve unit berdasarkan code/name/alias
- duplicate ditolak atau di-skip dengan laporan eksplisit
- missing category → `CATEGORY_NOT_FOUND`
- missing unit → `UNIT_NOT_FOUND`
- tidak boleh membuat random ID reference

#### OCR staging

Filename prefix:

```text
STOCK_IN_REVIEW_...
```

Fields:

```text
source_pdf,page,category,description_raw,quantity,unit_raw,unit_price,line_total,review_status,notes
```

OCR staging tidak boleh langsung masuk ledger.

#### READY import

Filename pattern:

```text
STOCK_IN_IMPORT_..._READY.csv
```

Fields:

```text
date,reference,supplier,warehouse,code,batch,production_date,expiry,quantity,unit,price,notes
```

Workflow:

```text
UPLOAD → PARSE → VALIDATE → PREVIEW → USER CONFIRM → IMPORT
```

Jika nama barang, unit, tanggal, atau reference meragukan, row tetap `REVIEW` dan tidak masuk ledger.

### 6.10 Backup and health check

Health check mendeteksi:

- missing table
- missing required column
- duplicate ID/code
- orphan reference
- negative stock
- negative batch
- ledger/balance mismatch
- invalid opname state
- missing audit fields
- unresolved import rows

Rebuild flow:

```text
BACKUP → LOCK → REBUILD BALANCE FROM LEDGER → RECONCILE → AUDIT
```

Backup acceptance criteria:

- backup punya timestamp dan metadata
- file/database backup dapat dibaca
- restore test berhasil di isolated database
- cleanup retention tidak menghapus backup aktif
- backup harian tersedia lokal dan tersalin ke Google Drive
- retensi 7 harian, 4 mingguan, dan 12 bulanan
- target RPO 24 jam dan RTO 4 jam

## 7. User Experience

### Navigation

```text
Dashboard
Stok
Transaksi
Kartu Stok
Stock Opname
Laporan
Import / Export
```

ADMIN tambahan:

```text
Barang
Kategori
Satuan
Gudang
Supplier
Pengguna
Sistem
```

### Modal rules

Semua modal wajib:

- tombol Batal berfungsi
- backdrop click menutup
- Escape menutup
- overlay cleanup
- tidak mengunci halaman setelah close
- loading state saat submit
- error message actionable

### Responsive priorities

- mobile-first untuk PETUGAS
- desktop workflow untuk ADMIN/SUPERVISOR
- table mobile memakai horizontal scroll atau card layout
- tombol mutation diberi confirmation jika berdampak pada stok

## 8. Technical Architecture

```text
Browser
  ↓ HTTPS
Reverse proxy
  ↓
Node.js application
  ├── auth middleware
  ├── authorization middleware
  ├── master service
  ├── inventory service
  ├── opname service
  ├── import service
  ├── report service
  └── maintenance service
       ↓ transaction/lock
PostgreSQL
```

Deployment target:

```text
Docker Compose
├── app
└── postgres
```

Requirements:

- app listen `0.0.0.0`
- persistent PostgreSQL volume
- healthcheck
- restart policy
- environment secrets outside Git
- database migrations tracked
- logs rotated
- backup destination terpisah dari primary volume

## 9. Database Requirements

Tables:

```text
users
auth_sessions
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
import_batches
staging_ocr_lines
ready_import_rows
audit_logs
backup_logs
```

Required constraints:

- primary key seluruh tabel
- unique product code
- unique warehouse code
- unique unit code
- unique transaction idempotency key
- foreign keys untuk reference
- check quantity non-negative pada balance/batch
- index product/warehouse
- index expiry
- index transaction timestamp
- index opname status
- append-only permission untuk ledger/audit

## 10. API Requirements

Minimal endpoint groups:

```text
/auth
/users
/products
/categories
/units
/unit-aliases
/warehouses
/suppliers
/dashboard
/stock
/transactions
/stock-card
/opnames
/imports
/reports
/maintenance
/health
```

Response error minimum:

```json
{
  "success": false,
  "errorCode": "INSUFFICIENT_STOCK",
  "message": "Stok tidak mencukupi. Tersedia 10 kg.",
  "details": {}
}
```

Never return:

- SQL query
- stack trace
- password
- token secret
- internal path
- raw database credentials

## 11. Non-Functional Requirements

### Security

- server-side RBAC
- password hashing
- token expiry
- input validation trust boundary
- parameterized SQL
- XSS-safe rendering
- CSRF strategy untuk cookie session
- rate limit login
- secret tidak masuk repository
- audit failed privileged action

### Performance

- dashboard memakai SQL aggregate
- list memakai pagination
- hindari N+1 query
- prepared statement
- index berdasarkan query plan
- export besar memakai streaming
- load testing memakai dataset production-like

### Reliability

- atomic stock mutation
- retry-safe import
- health endpoint
- backup monitoring
- restore drill
- graceful shutdown
- migration fail-closed

### Maintainability

- domain service terpisah dari route
- schema migration versioned
- test untuk business invariant
- no hidden frontend-only rules
- no line-for-line GAS port
- no unnecessary abstraction

## 12. Migration Strategy

### Source mapping

| Google Sheets | PostgreSQL |
|---|---|
| USERS | users |
| PRODUCTS | products |
| CATEGORIES | categories |
| UNITS | units |
| SATUAN_ALIAS | unit_aliases |
| WAREHOUSES | warehouses |
| SUPPLIERS | suppliers |
| STOCK_BATCHES | stock_batches |
| STOCK_BALANCES | stock_balances |
| STOCK_TRANSACTIONS | stock_transactions |
| STOCK_OPNAMES | stock_opnames |
| STOCK_OPNAME_ITEMS | stock_opname_items |
| AUDIT_LOGS | audit_logs |
| BACKUP_LOGS | backup_logs |

### Migration order

1. Export Sheets snapshot.
2. Validate schema and references.
3. Import users and master data.
4. Import batches.
5. Import transaction ledger.
6. Calculate balances from ledger.
7. Compare against source balances.
8. Import opname and audit history.
9. Import staging/ready history.
10. Run health check.
11. Run full UAT.
12. Freeze GAS writes.
13. Export final delta.
14. Import final delta.
15. Switch users to Docker.
16. Keep GAS read-only for rollback window.

Historical invoice must be imported as `IN`, not `OPENING`.

## 13. Release Plan

### Phase 1 — Foundation

- Docker Compose
- PostgreSQL
- migration runner
- health endpoint
- auth/RBAC
- base schema

### Phase 2 — Inventory

- master data
- stock in
- stock out
- FEFO
- ledger
- balance

### Phase 3 — Opname

- blind count
- snapshot
- submit
- approve/reject
- adjustment
- recount

### Phase 4 — Import and Reports

- master import
- OCR staging
- READY import
- dashboard
- reports
- CSV export

### Phase 5 — Hardening

- backup
- restore test
- health check
- rebuild balance
- performance test
- security test

### Phase 6 — Cutover

- rehearsal
- reconciliation
- final migration
- deployment CT104
- rollback window

## 14. Acceptance Test Matrix

| Test | Expected result |
|---|---|
| Login valid | session/token created and audited |
| Login inactive user | rejected |
| Petugas approve opname | forbidden |
| Admin create master | created and audited |
| Duplicate product code | rejected |
| Stock in valid | ledger, batch, balance, audit created |
| Stock out valid | FEFO allocation and ledger created |
| Stock out over balance | rejected; no mutation |
| Stock out membutuhkan batch kedaluwarsa | `INSUFFICIENT_STOCK`; no mutation |
| Supervisor count lalu approve opname yang sama | permitted; adjustment tetap melewati snapshot guard |
| Duplicate import | no duplicate stock |
| Unknown product | `INVALID_PRODUCT` or `REVIEW` |
| Unknown unit | `UNIT_NOT_FOUND` or `REVIEW` |
| Unknown warehouse | `INVALID_WAREHOUSE` |
| Opening 100 + IN 50 - OUT 30 | balance 120 |
| Opname physical 118 | difference -2 |
| Approve opname | adjustment -2, final 118 |
| Transaction after snapshot | approval blocked |
| Reject opname | reason required, status REJECTED |
| Recount | old count/difference cleared |
| Concurrent stock out | no negative stock |
| Expired batch | visible in monitoring/report |
| Rebuild balance | matches ledger |
| Backup restore | database restored in isolation |
| Missing required table | health check FAIL |

## 15. Definition of Done

Product release is complete only if:

- Docker deployment works from clean checkout.
- PostgreSQL migrations run without destructive reset.
- Auth and RBAC tests pass.
- Stock ledger is immutable from normal API.
- Every mutation is atomic and audited.
- FEFO works across multiple batches.
- Negative stock is impossible through API.
- Import preview and idempotency work.
- Opname snapshot guard works.
- Recount works.
- Balance rebuild reconciles.
- Backup restore is verified.
- Migrated data reconciles with Google Sheets.
- Health check is clean.
- Deployment health endpoint returns success.
- Rollback procedure is tested.

## 16. Risks and Mitigation

| Risk | Impact | Mitigation |
|---|---|---|
| Sheet data mismatch | High | validation and reconciliation before cutover |
| Duplicate invoice import | High | idempotency key and file hash |
| Concurrent stock movement | High | DB transaction and row lock |
| Bad OCR classification | High | staging/review gate |
| Backup unusable | High | scheduled restore drill |
| Schema migration data loss | Critical | forward-only non-destructive migration and backup |
| Docker volume loss | Critical | external backup and monitored restore |
| Scope expansion | Medium | enforce non-goals and phase gates |
| Large reports slow app | Medium | pagination, aggregation, streaming |
| Frontend security bypass | High | server-side authorization tests |

## 17. Resolved Decisions

**Approved by:** Product Owner melalui sesi implementasi 2026-10-08.

1. Login memakai akun lokal.
2. Akses deployment memakai public HTTPS.
3. Session memakai secure HttpOnly cookie; response `token` hanya reference non-secret.
4. Runtime memakai Node.js 22 dan pnpm.
5. Backup harian disimpan lokal dan disalin ke Google Drive.
6. Retensi backup: 7 harian, 4 mingguan, dan 12 bulanan.
7. Target RPO 24 jam dan RTO 4 jam.
8. Rollback window tujuh hari.
9. GAS/Google Sheets read-only selama rollback window lalu diarsipkan.
10. Semua role, termasuk ADMIN, hanya boleh membaca atau memutasi gudang dengan `region_id` yang sama dengan user aktif.
11. Expiry opsional; batch tanpa expiry valid dan berada terakhir dalam FEFO.
12. Normal stock-out tidak boleh memakai batch kedaluwarsa; kekurangan stok non-kedaluwarsa menghasilkan `INSUFFICIENT_STOCK` tanpa mutation.
13. SUPERVISOR boleh create/count/submit/approve/reject semua opname, termasuk opname yang dihitung sendiri.
14. Login response `license` adalah application constant publik `SELF_HOSTED`, bukan secret dan bukan nilai database/environment.

Row aktual tiap Google Sheet wajib diukur saat source inventory. Nilai itu input migrasi, bukan business rule. Migrasi tidak boleh menghapus data source.

## 18. Traceability Matrix

| Requirement | Architecture | Database | API/Service | UI | Test |
|---|---|---|---|---|---|
| Server-side RBAC | auth middleware | users | protected routes | role menu | role negative tests |
| Ledger source of truth | inventory service | stock_transactions | transaction API | transaction form | ledger invariant |
| No negative stock | DB check + lock | balance/batch checks | stock out service | error state | over-stock/concurrency |
| FEFO | inventory service | expiry index | stock out API | allocation display | multi-batch FEFO |
| Blind opname | opname service | snapshot fields | opname API | hide system qty | blind count test |
| Snapshot guard | DB transaction | snapshot/version fields | approval service | warning | movement-after-snapshot |
| OCR review | import service | staging tables | import API | preview/review | staging isolation |
| Idempotent import | import service | unique key | confirm API | import result | duplicate import |
| Audit | audit service | audit_logs | audit hooks | read-only log | audit coverage |
| Backup/rebuild | maintenance service | backup metadata | maintenance API | admin screen | restore/rebuild |
| Docker deploy | Compose | persistent volume | health endpoint | deployment smoke | clean build |

## 19. Product Success Metrics

Measured after production stabilization:

- zero un-audited stock mutation
- zero negative stock from API
- zero duplicate confirmed import
- ledger/balance mismatch count = 0
- opname approval guard false-negative count = 0
- backup restore success = 100% in scheduled drills
- dashboard query response target measured against production-like dataset
- deployment recovery procedure completed within approved RTO

## 20. Approval Gate

Status saat ini: `APPROVED` sebagai implementation baseline v0.1.0 pada 2026-10-08.

Implementation authorization prerequisites (completed):

- [x] Open decisions resolved
- [x] Target schema approved
- [x] Migration mapping approved
- [x] Acceptance test matrix approved
- [x] Backup/rollback plan approved
- [x] CT104 capability verified: container running, Docker 29.5.3, 38G disk free, 2.9Gi memory available
- [x] Product Owner memberi status `APPROVED` untuk implementation baseline

Approval ini mengizinkan implementation, bukan deployment/cutover production. Port, path, domain, backup destination, source export, restore drill, reconciliation, dan production smoke tetap wajib diverifikasi pada deployment gate.

Tidak boleh cutover production ketika salah satu gate data integrity, backup, authorization, atau reconciliation masih FAIL.

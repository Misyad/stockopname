# Migration Plan — Google Sheets/GAS ke PostgreSQL

**Status:** Approved v0.1.0 — implementation baseline  
**Mode:** Non-destructive, repeatable, evidence-first  
**Rollback window:** 7 hari

## 1. Principles

1. Source Google Sheets/GAS tidak dihapus atau ditulis oleh migrator.
2. Setiap export menjadi immutable archive dengan checksum.
3. Data meragukan masuk review; tidak dibuatkan random reference.
4. Historical invoice selalu `IN`, bukan `OPENING`.
5. Balance target dibangun dari ledger, bukan dipercaya dari source balance.
6. Satu import batch harus repeatable dan idempotent.
7. Cutover hanya lanjut ketika reconciliation critical PASS.

## 2. Source Inventory

Rehearsal pertama menghasilkan `migration-inventory.json` dengan entry per sheet:

```json
{
  "sheet":"PRODUCTS",
  "spreadsheetId":"redacted-reference",
  "headerHash":"sha256",
  "rowCount":0,
  "nonEmptyRowCount":0,
  "exportFile":"PRODUCTS.csv",
  "fileSize":0,
  "sha256":"...",
  "exportedAt":"ISO-8601"
}
```

Inventory wajib mencakup:

```text
USERS, PRODUCTS, CATEGORIES, UNITS, SATUAN_ALIAS,
WAREHOUSES, SUPPLIERS, STOCK_BATCHES, STOCK_BALANCES,
STOCK_TRANSACTIONS, STOCK_OPNAMES, STOCK_OPNAME_ITEMS,
AUDIT_LOGS, BACKUP_LOGS
```

Tidak adanya sheet dicatat sebagai `SOURCE_ABSENT`, bukan dianggap kosong.

## 3. Source-to-Target Mapping

| Source | Target | Strategy |
|---|---|---|
| USERS | users | local account; reset/setup credential aman bila hash lama tidak kompatibel |
| CATEGORIES | categories | map by normalized code; unresolved `REVIEW` |
| UNITS | units | base references dahulu |
| SATUAN_ALIAS | unit_aliases | normalize lowercase/trim |
| PRODUCTS | products | resolve category dan units; unresolved ditahan |
| WAREHOUSES | warehouses | map by code |
| SUPPLIERS | suppliers | map by code; null supplier allowed where contract permits |
| STOCK_TRANSACTIONS | stock_transactions | canonical ledger import |
| STOCK_BATCHES | stock_batches | reconciliation input; target quantity diverifikasi dari ledger |
| STOCK_BALANCES | stock_balances | comparison only; target rebuilt from ledger |
| STOCK_OPNAMES | stock_opnames | preserve status/reference/timestamps |
| STOCK_OPNAME_ITEMS | stock_opname_items | resolve opname/product/batch |
| AUDIT_LOGS | audit_logs | preserve append-only history |
| BACKUP_LOGS | backup_logs | metadata history only |

`staging_ocr_lines` dan `ready_import_rows` hanya diisi dari source file yang memang mewakili workflow tersebut; jangan mengubah invoice biasa menjadi OCR staging.

## 4. Field Conversion

| Source shape | Target conversion |
|---|---|
| ID/code | trim; preserve original reference in mapping evidence |
| Empty string | `NULL`, kecuali required field |
| Date serial/string | ISO date/time dengan timezone terdokumentasi |
| Decimal Indonesian | remove grouping safely, comma decimal ke dot |
| Quantity | numeric finite; normalize ke base unit |
| Boolean/status | explicit canonical enum |
| Email | trim + lowercase |
| Unit alias | lowercase trim lalu resolve `unit_aliases` |
| Whitespace | trim outer; collapse accidental repeated whitespace pada name only |
| Batch empty | `batch_number = NULL`; merge satu unbatched row per product+warehouse |
| Expiry empty | `NULL`; valid dan FEFO-last |

Raw source value dan normalized value disimpan pada migration evidence/error file, bukan di public API.

## 5. ID dan Reference Strategy

- Target memakai UUID.
- `migration_id_map` artifact menyimpan `entity`, `source_id`, `source_code`, `target_id`, `source_hash`.
- Stable source key dipilih dari immutable source ID; bila tidak ada, gunakan documented composite natural key.
- Re-run mencari mapping lama dan tidak membuat target ID baru.
- Transaction `idempotency_key` memakai `migration:<sheet>:<stable-row-key>:<payload-hash>`.
- Same stable key dengan payload berbeda menghasilkan conflict dan menghentikan batch.

Mapping artifact mengandung reference, bukan password/session secret.

## 6. Normalization Rules

### Codes

Trim, uppercase bila source convention case-insensitive, pertahankan original di evidence. Collision setelah normalization menjadi `NORMALIZED_CODE_COLLISION`.

### Units

Minimum aliases:

```text
biji,bii,bji,pcs → PCS
gram,g → GRAM
kg,kilogram → KILOGRAM
pak,pack,bks,bungkus → PACK
dos,dus → DUS
```

Unknown unit menjadi `UNIT_NOT_FOUND`; migrator dilarang membuat unit acak.

### Categories

Grouping invoice seperti `BAHAN BASAH`, `BAHAN KERING`, `BAHAN OPERASIONAL` tidak otomatis menjadi kategori final. Mapping tanpa bukti masuk `CATEGORY_NOT_FOUND` atau `REVIEW`.

### Dates

- Reject impossible/ambiguous date.
- Date-only tidak digeser timezone.
- Timestamp disimpan `timestamptz` dengan source timezone recorded.

## 7. Duplicate Detection

| Entity | Duplicate key |
|---|---|
| Master | normalized code; barcode jika terisi |
| Unit alias | normalized alias |
| Ledger | source transaction ID atau stable composite + payload hash |
| Invoice row | file hash + stable row number |
| Opname | opname number |
| Backup metadata | source ID/file checksum |

Exact duplicate menjadi idempotent skip. Key sama dengan payload beda menjadi conflict. Fuzzy name match hanya laporan review, tidak auto-merge.

## 8. Orphan Handling

Missing product, category, unit, warehouse, opname, user, atau batch menghasilkan error row dengan:

```text
batch_id, sheet, row_number, source_key, error_code,
field, raw_value, normalized_value, message
```

Tidak ada fallback ke first row, default random UUID, atau master otomatis. Transaction batch tidak commit jika row critical unresolved.

## 9. Stock Semantics

- Historical invoice maps to positive `IN` ledger row.
- `OPENING` hanya berasal dari approved physical opening count.
- OUT negative; IN/OPENING positive; ADJUSTMENT signed.
- Every batch allocation remains separate ledger row.
- Empty supplier allowed only when API/schema permits.
- Batch/expiry optional. Empty batch uses one `NULL` batch row per product+warehouse.
- Expiry-null batch sorts after non-null expiry in FEFO.
- Migrated expired stock remains visible for monitoring/reconciliation but is excluded from normal stock-out allocation.

## 10. OCR Isolation

```text
UPLOAD → PARSE → VALIDATE → PREVIEW → USER CONFIRM → IMPORT
```

`STOCK_IN_REVIEW_*` hanya masuk `staging_ocr_lines`. Hanya file READY dengan header exact berikut dapat menjadi stock-in candidate:

```text
date,reference,supplier,warehouse,code,batch,production_date,expiry,quantity,unit,price,notes
```

Preview/upload tidak menulis ledger. Row `REVIEW` mencegah confirm atomic batch.

## 11. Export Snapshot

1. Catat Spreadsheet ID/revision metadata.
2. Freeze satu logical snapshot untuk rehearsal/final export.
3. Export tiap sheet ke UTF-8 CSV tanpa formula execution di target.
4. Simpan manifest row count, bytes, SHA-256, timestamp.
5. Buat archive read-only.
6. Verifikasi checksum sebelum parse dan sebelum import.

Formula diekspor sebagai nilai terhitung dan formula source disimpan pada archive metadata bila tersedia.

## 12. Dry Run

Dry run menjalankan parse, normalization, mapping, validation, dan planned totals tanpa target mutation. Output:

```text
inventory.json
id-map-preview.csv
validation-errors.csv
reconciliation-preview.json
migration-report.md
```

Dry run FAIL jika checksum berubah, required sheet absent, duplicate conflict, orphan critical, invalid numeric/date, atau stock invariant akan dilanggar.

Generic runner:

```bash
node scripts/migrate-sheets.js dry-run \
  --source /read-only/source-export \
  --mapping /approved/mapping.json \
  --output /disposable/evidence
```

`source-manifest.json` wajib read-only dan mencatat semua 14 sheet sebagai `PRESENT` atau `SOURCE_ABSENT`. Entry `PRESENT` wajib memuat `spreadsheetId`, file exact `<SHEET>.csv`, byte count, row count, SHA-256, dan export timestamp. CSV source wajib UTF-8, read-only, maksimal 10 MiB/file, 100.000 data row, 4 KiB/field, dan 65.536 raw character/row. Header atau mapping credential/secret ditolak sebelum raw row masuk evidence/hash. Runner tidak menerima target DB URL dan tidak melakukan mutation source/target.

## 13. Import Order

1. Create migration batch record/evidence directory.
2. Users tanpa credential plaintext.
3. Categories.
4. Units base lalu derived units.
5. Unit aliases.
6. Warehouses dan suppliers.
7. Products.
8. Transaction ledger in deterministic order.
9. Rebuild `stock_batches` and `stock_balances` from ledger.
10. Import opname headers/items setelah references valid.
11. Import historical audit/backup metadata.
12. Reconcile all dimensions.

Source balances/batches dipakai sebagai comparison, bukan mutation authority.

## 14. Transaction Import

- Import per bounded DB transaction.
- Acquire migration advisory lock.
- Insert idempotency/mapping and ledger atomically.
- Preserve deterministic order by source timestamp then stable key.
- Stop batch on negative calculated balance.
- Do not partially mark batch successful.
- Re-run returns original imported result for same key/payload.

## 15. Rebuild dan Reconciliation

Required comparisons:

| Dimension | Expected |
|---|---|
| Source rows | exported = parsed + explicitly blank rows |
| Master | valid unique codes map 1:1 |
| Ledger count | accepted source movements = target imported movements |
| Ledger quantity | sums by product+warehouse+type equal accepted source |
| Balance | target cache = aggregate target ledger |
| Batch | batch totals = balance per product+warehouse |
| Negative | zero negative balance/batch |
| Opname | header/item counts and status match accepted source |
| Audit | critical imported actions retain actor/reference/time |

Legacy source balance mismatch does not get hidden. Record source, target-ledger result, delta, evidence, and Product Owner disposition.

## 16. Rehearsal

Rehearsal uses isolated PostgreSQL and production-like export:

1. Restore clean schema.
2. Verify export manifest.
3. Run dry run.
4. Run import.
5. Run import again; second run must add zero ledger rows.
6. Rebuild balance.
7. Run reconciliation and critical test suite.
8. Record runtime, row counts, errors, checksum, DB size.
9. Destroy only rehearsal DB after evidence/backup; never production/source.

## 17. Cutover

1. Verified local+Google Drive backup.
2. Rehearsal PASS and approval recorded.
3. Announce write freeze window.
4. Disable GAS writes; keep read access.
5. Export final snapshot/delta and checksums.
6. Import final delta using same idempotent pipeline.
7. Reconcile ledger, balances, batches, opname, audit.
8. Run UAT and health checks.
9. Switch users to public HTTPS application.
10. Monitor errors/reconciliation during seven-day window.
11. Archive GAS/Sheets after window when no rollback trigger remains.

## 18. Rollback

Triggers:

- source/target accepted ledger total mismatch
- target ledger/balance or batch/balance mismatch
- authorization critical failure
- duplicate stock mutation
- unusable backup/restore
- RTO cannot be met safely

Steps:

1. Stop target mutations and capture evidence.
2. Record target final transaction watermark.
3. Keep target DB/volume intact; do not delete.
4. Restore approved access path to read-only source; re-enable source writes only with Product Owner authorization and delta plan.
5. Reconcile transactions created after cutover before any source write resumes.
6. Publish rollback status and owner.

Rollback is not blind traffic switch: target-only transactions must be accounted for first.

## 19. Retention dan Recovery

- GAS/Sheets read-only: 7 hari, lalu archive.
- Backup: local plus Google Drive.
- Retention: 7 daily, 4 weekly, 12 monthly.
- RPO: 24 hours.
- RTO: 4 hours.
- Backup validity requires checksum and isolated restore/read test.

## 20. Evidence Report

Each run records:

```text
run_id, source_revision, export checksums, tool version,
started_at, finished_at, actor, target database,
row counts, accepted/review/rejected/conflict counts,
ledger totals, balance/batch reconciliation,
errors, test command/result, approval
```

Secrets and raw passwords are redacted.

## 21. Migration Gate

PASS requires:

- export checksums stable
- all source sheets inventoried or explicitly absent
- zero unresolved critical orphan/collision
- second import adds zero ledger rows
- target balance equals target ledger
- target batch totals equal target balance
- no negative stock
- historical invoices classified `IN`
- backup restore verified
- rollback drill completes within 4 hours
- Product Owner approves reconciliation evidence

Any critical mismatch is FAIL and stops cutover.

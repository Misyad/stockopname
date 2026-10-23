# Phase 10.2 — Source Drop Automation

## Tujuan
Ubah export Google Sheets yang Anda drop menjadi dry-run runtime + evidence tanpa I/O jaringan/DB.

## Yang Anda sediakan (satu kali)
1. Folder `source/` berisi export CSV per sheet. Nama wajib EXACT:
   - `USERS.csv`, `PRODUCTS.csv`, `CATEGORIES.csv`, `UNITS.csv`,
   - `SATUAN_ALIAS.csv`, `WAREHOUSES.csv`, `SUPPLIERS.csv`,
   - `STOCK_BATCHES.csv`, `STOCK_BALANCES.csv`, `STOCK_TRANSACTIONS.csv`,
   - `STOCK_OPNAMES.csv`, `STOCK_OPNAME_ITEMS.csv`,
   - `AUDIT_LOGS.csv`, `BACKUP_LOGS.csv`
2. CSV UTF-8, read-only. Sheet tidak ada = lewati; otomatis dicatat `SOURCE_ABSENT`.
3. Spreadsheet ID asli (argumen atau env `SPREADSHEET_ID`).
4. `mapping.json` (kolom->field). Belum ada; siapkan dari kolom CSV aktual dulu.

Catatan: CSV yang sudah ditaruh akan dibaca; manifest dihasilkan dari file yang ada.
Sheet dengan header credential/secret akan ditolak sebelum hash/evidence.

## Langkah

### 1. Drop file
```bash
mkdir -p /opt/migration-source && cd /opt/migration-source
# taruh <NAMA>.csv di sini
find . -name '*.csv' -exec chmod 0444 {} +
```

### 2. Generate manifest
```bash
cd /opt/migration-source
node /root/stock-opname-phase10-2/scripts/generate-manifest.js '<SPREADSHEET_ID>' '<EXPORTED_AT_ISO_Z>'
# env alternatif: SPREADSHEET_ID / EXPORTED_AT
```

### 3. Dry run
```bash
node /root/stock-opname-phase10-2/scripts/migrate-sheets.js dry-run \
  --source /opt/migration-source \
  --mapping /opt/migration-source/mapping.json \
  --output /tmp/evidence
```

### 4. Baca hasil
```text
/tmp/evidence/inventory.json
/tmp/evidence/id-map-preview.csv
/tmp/evidence/validation-errors.csv
/tmp/evidence/reconciliation-preview.json
/tmp/evidence/migration-report.md
```

## Pintasan satu perintah
```bash
cd /opt/migration-source
find . -name '*.csv' -exec chmod 0444 {} + \
  && node /root/stock-opname-phase10-2/scripts/generate-manifest.js \
  && node /root/stock-opname-phase10-2/scripts/migrate-sheets.js dry-run \
       --source . --mapping mapping.json --output /tmp/evidence
```

## Verifikasi keamanan
- runner tidak menerima `--target-db-url`
- output WAJIB di luar source (tidak bisa `--output .`)
- source dibaca read-only; mode writable ditolak
- file >10 MiB / field >4 KiB / raw row >65,536 / >100,000 row ditolak
- manifest wajib `version:1` + 14 sheet `PRESENT`/`SOURCE_ABSENT` + SHA-256/byte/row count konsisten
- header credential ditolak sebelum hash/evidence

## Blocker sebelum lanjut ke 10.3 (import/rehearsal)
- `mapping.json` final (per kolom CSV aktual)
- remote authoritative GAS export, bukan re-export manual divergen
- isolated PostgreSQL untuk rehearsal
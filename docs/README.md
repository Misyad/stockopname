# Stock Opname SPPG PAKISKEMBAR 2

Living product contract dan dokumentasi as-built aplikasi Stock Opname modular monolith Node.js + PostgreSQL dalam Docker Compose.

**Product contract:** Approved v0.1.0 pada 2026-10-08; aturan bisnis tetap berlaku  
**Implementation:** Candidate implements core UI/API, Opname, import confirmation, dashboard/reports, and recovery operations; release gates remain separate

**Repository:** `git@github.com:Misyad/stockopname.git`; checkout lokal `/root/stock-opname`  
**Runtime evidence:** production aktif pada revision `cff1796cb8d3798b097cb17d790736500c9765c2`; release/cutover gate formal tetap terpisah

## Product

Cakupan utama:

- akun lokal, secure cookie session, CSRF, RBAC
- master barang, kategori, satuan, alias, gudang, supplier, pengguna
- immutable stock ledger, balance cache, batch, expiry
- stock-in, FEFO stock-out, opening stock terkontrol
- blind-count stock opname, review, approval, adjustment
- CSV preview/confirm dan OCR staging terisolasi
- dashboard read-only, kartu stok, laporan, export CSV
- audit, health, backup/restore, rebuild balance
- migrasi non-destructive dari Google Sheets/GAS

## Baseline Decisions

| Area | Decision |
|---|---|
| Runtime | Node.js 22 + pnpm |
| Frontend | HTML/CSS/Vanilla JavaScript |
| Backend | Modular monolith Node.js |
| Database | PostgreSQL |
| Deployment | Docker Compose, public HTTPS |
| Authentication | Local account, DB-backed secure HttpOnly cookie |
| Login `token` | Non-secret session reference; bukan bearer credential |
| Login `license` | Literal publik `SELF_HOSTED`; bukan key/secret/config |
| Permission | Role + region server-side; setiap user/gudang satu region; SUPERVISOR boleh count dan approve opname yang sama di region sendiri |
| Batch | Optional; kosong menjadi one NULL batch row per product+warehouse |
| Expiry | Optional; expired ditolak dari normal stock-out, NULL diproses terakhir pada FEFO |
| Backup | Harian lokal + Google Drive; 7 daily/4 weekly/12 monthly |
| Recovery | RPO 24 jam, RTO 4 jam |
| Legacy | GAS/Sheets read-only 7 hari setelah cutover, lalu archive |

## Documentation Map

Read order:

| # | File | Purpose |
|---:|---|---|
| 1 | [`AGENT.md`](AGENT.md) | Aturan wajib implementer |
| 2 | [`prd.md`](prd.md) | Product contract, scope, acceptance |
| 3 | [`ARCHITECTURE.md`](ARCHITECTURE.md) | Topology, boundaries, mutation flow |
| 4 | [`DATABASE.md`](DATABASE.md) | Tables, constraints, indexes, invariants |
| 5 | [`API.md`](API.md) | Endpoint, payload, RBAC, errors |
| 6 | [`UI_SPEC.md`](UI_SPEC.md) | Route, screen, state, responsive, accessibility |
| 7 | [`SECURITY.md`](SECURITY.md) | Threats and mandatory controls |
| 8 | [`MIGRATION.md`](MIGRATION.md) | Sheets export, mapping, rehearsal, cutover |
| 9 | [`TEST_PLAN.md`](TEST_PLAN.md) | Executable test contract and release gate |
| 10 | [`TASKS.md`](TASKS.md) | Ordered test-first implementation tasks |
| 11 | [`IMPLEMENTATION_STATUS.md`](IMPLEMENTATION_STATUS.md) | Status as-built, bukti, gap, dan next scope |

Authority order for conflicts:

```text
Approved Product Owner decision
→ prd.md business requirement
→ ARCHITECTURE.md / DATABASE.md / API.md contract
→ SECURITY.md / UI_SPEC.md / MIGRATION.md / TEST_PLAN.md
→ TASKS.md
```

Do not resolve conflict silently. Stop, record exact conflict, request decision.

## Current Repository Structure

```text
stock-opname/
├── package.json
├── pnpm-lock.yaml
├── .env.example
├── Dockerfile
├── compose.yaml
├── src/
│   ├── server.js
│   ├── config.js
│   ├── db/
│   ├── http/
│   ├── services/
│   ├── repositories/
│   └── public/
├── db/
│   ├── migrations/
│   └── seeds/
├── scripts/
└── test/
```

Source saat ini mengikuti struktur tersebut. `config.js`, service lanjutan, dan script operasional ditambahkan hanya saat task terkait dikerjakan.

## Prerequisites

Development/deployment memerlukan:

- Git
- Docker Engine + Docker Compose plugin
- Node.js 22
- pnpm via Corepack
- PostgreSQL client tools for operator recovery
- HTTPS domain/reverse proxy configuration
- Google Drive credential with minimum folder scope
- access to Google Sheets/GAS export source

Target Docker must be checked inside CT104 or another approved Docker host. Proxmox host itself is not assumed to run Docker.

## Environment Variables

`.env.example` tersedia; never put real values in Git:

```dotenv
NODE_ENV=development
HOST=0.0.0.0
PORT=3000
DATABASE_URL=postgresql://app_user:CHANGE_ME@postgres:5432/stock_opname
SESSION_SECRET=CHANGE_ME_LONG_RANDOM_VALUE
APP_ORIGIN=https://stock.example.invalid
TRUST_PROXY=false
BACKUP_LOCAL_DIR=/var/backups/stock-opname
GOOGLE_DRIVE_FOLDER_ID=CHANGE_ME
GOOGLE_APPLICATION_CREDENTIALS=/run/secrets/google-drive.json
LOG_LEVEL=info
```

`SESSION_SECRET`, DB password, Google credential, cookies, CSRF values, and password hashes must not appear in logs, client storage, images, commits, screenshots, or migration evidence.

## Setup — Current Commands

Perintah yang tersedia pada revision saat ini:

```bash
git clone git@github.com:Misyad/stockopname.git stock-opname
cd stock-opname
corepack enable
pnpm install --frozen-lockfile
cp .env.example .env
# Fill secrets through approved secret process.
pnpm test
pnpm test:security
pnpm test:integration
pnpm lint
pnpm build
docker compose config
```

Expected final startup result:

- app and PostgreSQL containers healthy
- PostgreSQL port not exposed publicly
- HTTP redirected to HTTPS
- secure cookie authentication active
- schema version current
- detailed reconciliation clean

## Development Gates

```bash
pnpm test
pnpm test:security
pnpm test:integration
pnpm lint
pnpm build
docker compose config
docker compose build
```

Current CI on `main` revision `cff1796c`: `PASS`. Working-tree changes require their own verified gates; baseline CI is not evidence for them.

## Health

Implemented endpoints:

```text
GET /live
GET /health
GET /api/maintenance/health-check
```

`/live` checks process liveness. `/health` checks app and database readiness without sensitive detail. Protected detailed health checks schema, references, negatives, ledger/balance, batch/balance, opname state, audit completeness, and backup RPO.

## Backup Quick Guide

Implemented workflow:

```text
Create local backup
→ calculate checksum
→ restore into isolated PostgreSQL
→ reconcile and clean isolated database
→ copy to independent storage/Google Drive
→ apply 7/4/12 retention
→ record VERIFIED metadata
```

Retention: 7 daily, 4 weekly, 12 monthly. Presence alone does not prove backup validity.

Commands:

```bash
pnpm backup
pnpm restore:verify -- <backup-file>
```

Backup requires `BACKUP_ACTOR_ID`. Restore verification accepts only files inside `BACKUP_LOCAL_DIR` and always restores into an isolated temporary database.

Production restore, retention cleanup, volume deletion, and DB reset require explicit approval. Never use `docker compose down -v` on retained data.

## Migration Quick Guide

See [`MIGRATION.md`](MIGRATION.md). Planned sequence:

```text
Inventory source
→ export immutable CSV + checksums
→ dry run
→ review orphan/collision
→ isolated rehearsal
→ second-run idempotency proof
→ reconciliation
→ approved cutover
→ 7-day rollback window
```

Planned commands after tooling exists:

```bash
pnpm migrate:sheets -- --mode=dry-run --source=<export-dir>
pnpm migrate:sheets -- --mode=rehearsal --source=<export-dir> --database=<isolated-db-url>
```

Migrator must not write/delete Google Sheets source. Historical invoice remains transaction type `IN`, not `OPENING`.

## Deployment Summary

1. Verify CT104 or approved Docker host, port, domain, disk, memory, and backup destination.
2. Build immutable image from clean checkout.
3. Create and verify pre-deployment backup.
4. Run forward-only migration.
5. Start containers and verify health.
6. Run auth, CSRF, RBAC, read-only, reconciliation, and backup-age smoke.
7. Freeze GAS writes only during approved cutover.
8. Import final delta and reconcile.
9. Monitor seven-day rollback window.
10. Archive GAS/Sheets only after gate approval.

Documentation approval does not authorize deployment or production data mutation.

## Security Warnings

- Session credential only in `HttpOnly; Secure; SameSite=Lax` cookie.
- Login response `token` is non-secret reference; never use Bearer/localStorage.
- Every browser mutation requires valid CSRF token and allowed Origin.
- Frontend menu visibility is not authorization.
- PETUGAS blind response and DOM must not contain system quantity/difference.
- Ledger/audit have no normal edit/delete path.
- CSV/OCR preview never writes ledger.
- PostgreSQL must not be publicly exposed.
- Secrets must not be committed or printed.

## Troubleshooting

| Symptom | Check |
|---|---|
| Container unhealthy | `docker compose ps`, app log redaction, DB health |
| DB connection failure | `DATABASE_URL`, network name, credential, PostgreSQL health |
| Login loops | HTTPS, cookie flags, clock, session expiry/revocation |
| Mutation returns 403 | Origin, CSRF token, role, ownership/state |
| Duplicate stock | same key/payload behavior, idempotency row, transaction boundary |
| Negative/mismatch health | stop mutation path; run reconciliation; do not edit balance manually |
| Import blocked | exact header, REVIEW rows, orphan references, file hash |
| Opname approval blocked | movement after snapshot, state, reason, snapshot consistency |
| Backup invalid | checksum, file size, isolated restore, Drive copy |
| Docker unavailable | verify inside target CT; do not assume Proxmox host Docker |

Detailed sources: [`API.md`](API.md), [`SECURITY.md`](SECURITY.md), [`TEST_PLAN.md`](TEST_PLAN.md), [`MIGRATION.md`](MIGRATION.md).

## Current Phase Gate

- [x] Product contract baseline v0.1.0 approved
- [x] Repository, Docker, PostgreSQL, auth, CSRF, RBAC, master data implemented
- [x] Opening Stock, Stock In, dan FEFO Stock Out backend/API implemented
- [x] GitHub CI `main` revision `cff1796c` PASS
- [x] Public `/health` and `/login` return HTTP 200 on 2026-10-20
- [x] Transaction UI and inventory read models implemented in candidate
- [x] Stock Opname workflow end-to-end implemented in candidate
- [x] Import confirmation, dashboard, reports, protected reconciliation implemented in candidate
- [x] Backup/restore automation and isolated restore evidence implemented in candidate
- [ ] Candidate commit, immutable image, CI, reviewer gate
- [ ] Dedicated staging HTTPS, exact-artifact restore drill, and formal UAT
- [ ] Sheets migration rehearsal/cutover evidence
- [ ] Full P0 release gate, including remaining features

Runtime production sudah teramati aktif. Fakta runtime tidak menggantikan release evidence atau memberi izin baru untuk DB mutation, migration, DNS, source-write freeze, maupun cutover. Next scope follows [`IMPLEMENTATION_STATUS.md`](IMPLEMENTATION_STATUS.md).

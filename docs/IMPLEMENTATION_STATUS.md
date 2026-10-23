# Implementation Status — Stock Opname SPPG PAKISKEMBAR 2

**Candidate base revision:** `b62629e2fc5d07aa8c368d15fce23e92123b9d43`

**Candidate evidence captured:** 2026-10-22; exact revision pending commit/CI

**Contract:** approved v0.1.0; this file records implementation progress, not new business rules  
**Runtime:** active at `https://opname.projecthasan.com`

## 1. Evidence Rules

| Tier | Meaning | Evidence used here |
|---|---|---|
| A | Direct source/runtime/tool output | Git tree, source, container inspection, HTTP probes |
| B | Automated verification | GitHub CI and executable test output |
| C | Approved contract | `prd.md`, architecture, API, database, security, UI, test plan |
| D | Historical context | Prior manifests/reports; must be reverified |
| E | Assumption | Never reported as implemented |

Status labels:

- `DONE`: source exists and automated evidence covers implemented scope.
- `PARTIAL`: part of task exists; missing pieces named explicitly.
- `PENDING`: no matching implementation found at audited revision.
- `NOT VERIFIED`: source may exist, but required evidence is absent.

## 2. Verified Baseline Runtime and Candidate

| Check | Result | Evidence |
|---|---|---|
| GitHub `main` | **PASS** | `cff1796cb8d3798b097cb17d790736500c9765c2` |
| GitHub CI | **PASS** | run `38201447672`, revision `cff1796c` |
| Public health | **PASS** | `GET /health` returned HTTP 200 `{"success":true}` |
| Login page | **PASS** | `GET /login` returned HTTP 200 |
| App container | **PASS** | healthy; image `stock-opname:cff1796cb8d3798b097cb17d790736500c9765c2` |
| PostgreSQL container | **PASS** | running and healthy |
| Caddy container | **PASS** | running |
| Compose location | **PASS** | `/opt/stock-opname/compose.yaml` inside CT104 |
| Candidate integration | **PASS** | final fresh local run: 184/184, zero skipped, exit 0 |
| Candidate CI | **NOT VERIFIED** | branch changes not committed/pushed yet |
| Candidate image/staging | **NOT VERIFIED** | immutable build and isolated staging are later gates |

Evidence timestamp for runtime inspection: `2026-10-20T12:28:47Z`.

## 3. As-Built Scope

| Task | Status | Source/evidence |
|---|---|---|
| 1.1 Repository contract | `DONE` | package, server, unit test |
| 1.2 Docker topology | `DONE` | Dockerfile, Compose, Docker integration test |
| 2.1 Migration runner | `DONE` | checksum-verified forward migration runner |
| 2.2 Initial schema | `DONE` | migrations `001`–`009`; schema tests |
| 2.3 Reference seed | `DONE` | idempotent seed and integration test |
| 3.1 Local authentication | `DONE` | DB sessions, secure cookie, login/logout tests |
| 3.2 CSRF and login limiter | `DONE` | Origin/CSRF validation and limiter tests |
| 3.3 Role enforcement | `DONE` | server RBAC and same-region warehouse checks |
| 4.1 Master service | `DONE` | product/category/unit/alias/warehouse/supplier/user service |
| 4.2 Master HTTP/UI | `DONE` | paginated API and Vanilla JS master screens |
| 5.1 Mutation transaction core | `DONE` | atomic ledger/batch/balance/audit core |
| 5.2 Stock In | `DONE` | atomic API, transaction UI, idempotency, and tests |
| 5.3 FEFO Stock Out | `DONE` | atomic FEFO API, transaction UI, and tests |
| Opening Stock | `DONE` | guarded API, transaction UI, and tests |
| 5.4 Inventory read models | `DONE` | stock, transaction, stock-card API/UI and region tests |
| 6 Stock Opname | `DONE` | create/count/submit/reject/recount/approve API/UI and blind/region tests |
| 7 Import | `DONE` | bounded preview/OCR staging plus atomic idempotent STOCKIN confirmation, UI, and tests |
| 8 Dashboard/reports | `DONE` | region-scoped dashboard, report API/UI, streamed CSV, tests |
| 9.1 Detailed health/reconciliation | `DONE` | protected schema/reference/stock/opname/audit/RPO checks and negative tests |
| 9.2 Backup/restore automation | `DONE` | local + independent copy, checksum, 7/4/12 retention, isolated restore/RTO evidence |
| 9.3 Balance rebuild | `DONE` | backup-gated region rebuild, lock, reconciliation, rollback, audit tests |
| 10.1 Sheets export/dry run | `PARTIAL` | generic immutable-manifest dry run, checksum/orphan/collision evidence, and zero-write fixtures implemented; real source inventory/export absent |
| 10.2 Sheets rehearsal/final delta | `PENDING` | real source export, isolated rehearsal, reconciliation, and approval absent |
| 11.1 Security hardening | `PARTIAL` | CSP, secure cookie, body limit, non-root image, CI security tests present |
| 11.2 Full UI/accessibility gate | `PARTIAL` | role-aware screens and structural a11y tests present; formal browser UAT pending |
| 12 UAT/cutover evidence | `NOT VERIFIED` | runtime active, but complete formal release package is absent |

## 4. Current API Surface

Implemented routes:

```text
GET  /health
GET  /live
POST /api/auth/login
GET  /api/auth/me
GET  /api/auth/csrf
POST /api/auth/logout
GET  /api/{categories|units|unit-aliases|warehouses|suppliers|products|users}
POST /api/{categories|units|unit-aliases|warehouses|suppliers|products|users}
PATCH /api/{master}/{id}
PATCH /api/users/{id}/status
POST /api/transactions/opening
POST /api/transactions/in
POST /api/transactions/out
GET  /api/stock
GET  /api/transactions
GET  /api/stock-card/{productId}
GET  /api/opnames
POST /api/opnames
GET  /api/opnames/{id}
POST /api/opnames/{id}/{start|counts|submit|approve|reject}
POST /api/imports/preview
POST /api/imports/{batchId}/confirm
GET  /api/dashboard
GET  /api/reports/{type}
GET  /api/reports/{type}/export
GET  /api/maintenance/health-check
GET  /api/maintenance/backups
POST /api/maintenance/backup
POST /api/maintenance/rebuild-balances
```

Implemented transaction guarantees:

- secure cookie session; no Bearer/localStorage credential
- Origin and CSRF checks on browser mutations
- role authorization in service layer
- server-enforced same-region warehouse access
- stable `idempotencyKey`; same key with changed payload conflicts
- atomic ledger, batch, balance, and audit mutation
- Stock In weighted-average purchase price for existing batch
- Stock Out locks eligible rows and applies deterministic FEFO
- expired batch excluded; insufficient eligible stock mutates nothing

## 5. Test Inventory

| Suite | Files at revision | Status |
|---|---:|---|
| Unit/UI | 7 | local PASS 36/36; candidate CI pending |
| Integration | 20 | final fresh local PASS 184/184, zero skipped, exit 0 |
| Security | 3 | local PASS 27/27; candidate CI pending |
| Migration dry run | 1 | local PASS 43/43; real source export pending |
| Lint/build | package scripts | local PASS; candidate CI pending |

CI passing means implemented scope passed configured jobs. It does **not** prove pending product features or missing release drills.

## 6. Known Contract Drift

| Drift | Impact | Required action |
|---|---|---|
| API contract omits `/api` prefix in endpoint headings while declaring base URL `/api` | Mechanical documentation convention | Keep base URL convention explicit; do not duplicate prefix |
| Google Drive credential mount is deployment-specific | Candidate cannot prove real Drive copy locally | Configure least-privilege credential in dedicated staging and run restore drill |
| Runtime active before full release matrix completed | Operational risk | Recover evidence first; do not infer missing PASS results |

No drift item above changes approved business rules.

## 7. Next Scope

1. Run final source gates, immutable image build, candidate CI, and stacked PR review.
2. Configure dedicated PostgreSQL staging, HTTPS, and least-privilege Drive credential.
3. Run exact-artifact restore drill and formal UAT in isolated staging.
4. Run Phase 10.1 against immutable real source export when access is supplied; keep Phase 10.2 rehearsal and production mutation behind separate approval.
5. Keep production deploy, DB migration, DNS, source-write freeze, and cutover behind separate approval.

## 8. Gate

- **Implementation continuation:** `GO` under approved product contract.
- **Current runtime health:** `PASS` for shallow public and container checks.
- **Implemented candidate scope:** `PASS` for source/integration evidence; reviewer, CI, image, staging, and UAT still pending.
- **Complete product acceptance:** `NOT VERIFIED` until remaining migration/release/UAT gates pass.
- **Full release evidence:** `NOT VERIFIED`.
- **New production/DB/DNS/cutover mutation:** requires separate explicit approval and backup/recovery gate.

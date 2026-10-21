# Implementation Status — Stock Opname SPPG PAKISKEMBAR 2

**As-built revision:** `cff1796cb8d3798b097cb17d790736500c9765c2`  
**Evidence captured:** 2026-10-20  
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

## 2. Verified Revision and Runtime

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

Evidence timestamp for runtime inspection: `2026-10-20T12:28:47Z`.

## 3. As-Built Scope

| Task | Status | Source/evidence |
|---|---|---|
| 1.1 Repository contract | `DONE` | package, server, unit test |
| 1.2 Docker topology | `DONE` | Dockerfile, Compose, Docker integration test |
| 2.1 Migration runner | `DONE` | checksum-verified forward migration runner |
| 2.2 Initial schema | `DONE` | migrations `001`–`008`; schema tests |
| 2.3 Reference seed | `DONE` | idempotent seed and integration test |
| 3.1 Local authentication | `DONE` | DB sessions, secure cookie, login/logout tests |
| 3.2 CSRF and login limiter | `DONE` | Origin/CSRF validation and limiter tests |
| 3.3 Role enforcement | `DONE` | server RBAC and same-region warehouse checks |
| 4.1 Master service | `DONE` | product/category/unit/alias/warehouse/supplier/user service |
| 4.2 Master HTTP/UI | `DONE` | paginated API and Vanilla JS master screens |
| 5.1 Mutation transaction core | `DONE` | atomic ledger/batch/balance/audit core |
| 5.2 Stock In | `PARTIAL` | backend/API/tests done; transaction UI missing |
| 5.3 FEFO Stock Out | `PARTIAL` | backend/API/tests done; transaction UI missing |
| Opening Stock | `PARTIAL` | backend/API/tests done; transaction UI missing |
| 5.4 Inventory read models | `PARTIAL` | backend/API/tests done; stock/card UI modules missing |
| 6 Stock Opname | `PENDING` | schema/RBAC projection exist; workflow service/routes/UI absent |
| 7 Import | `DONE` | bounded preview/OCR staging plus atomic idempotent STOCKIN confirmation, UI, and tests |
| 8 Dashboard/reports | `PENDING` | RBAC constants exist; read services/routes/UI absent |
| 9.1 Detailed health/reconciliation | `PENDING` | only shallow `GET /health` exists |
| 9.2 Backup/restore automation | `PENDING` | metadata schema exists; scripts and current restore evidence absent from repo |
| 9.3 Balance rebuild | `PENDING` | service/test absent |
| 10 Sheets migration | `PENDING` | contract only; tooling/rehearsal evidence absent |
| 11.1 Security hardening | `PARTIAL` | CSP, secure cookie, body limit, non-root image, CI security tests present |
| 11.2 Full UI/accessibility gate | `PARTIAL` | master UI tests present; transaction/remaining screen gates absent |
| 12 UAT/cutover evidence | `NOT VERIFIED` | runtime active, but complete formal release package is absent |

## 4. Current API Surface

Implemented routes:

```text
GET  /health
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
| Unit | 1 | CI PASS |
| UI | 1 | CI PASS for current master UI scope |
| Integration | 10 | CI PASS |
| Security | 3 | CI PASS |
| Lint/build | package scripts | CI PASS |

CI passing means implemented scope passed configured jobs. It does **not** prove pending product features or missing release drills.

## 6. Known Contract Drift

| Drift | Impact | Required action |
|---|---|---|
| Contract health route names differ from current `/health` | API contract incomplete | Implement approved routes or intentionally version contract after owner decision |
| Transaction APIs have no transaction screens | User workflow incomplete | Build minimum Opening/In/Out UI against existing API |
| Opname tables and RBAC exist without workflow | Core product incomplete | Implement Phase 6 end-to-end, including blind negative tests |
| Backup/recovery requirements lack versioned scripts/evidence | Recovery gate incomplete | Add automation; verify isolated restore before claiming PASS |
| Runtime active before full release matrix completed | Operational risk | Recover evidence first; do not infer missing PASS results |

No drift item above changes approved business rules.

## 7. Next Scope

1. Build transaction UI for Opening Stock, Stock In, and Stock Out.
2. Add inventory read models: stock list, transactions, and stock card.
3. Implement Stock Opname create/count/submit/review/reject/recount/approve.
4. Add negative cross-region, blind-response/DOM, idempotency, concurrency, and reconciliation coverage for new scope.
5. Add protected detailed health plus backup/restore automation and isolated restore evidence.
6. Implement migration tooling and rehearsal only after source export and production-mutation approval are explicit.

## 8. Gate

- **Implementation continuation:** `GO` under approved product contract.
- **Current runtime health:** `PASS` for shallow public and container checks.
- **Complete product acceptance:** `FAIL` because major approved features remain pending.
- **Full release evidence:** `NOT VERIFIED`.
- **New production/DB/DNS/cutover mutation:** requires separate explicit approval and backup/recovery gate.

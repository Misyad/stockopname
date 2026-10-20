# Implementation Tasks — Stock Opname SPPG PAKISKEMBAR 2

**Contract status:** Approved v0.1.0  
**Execution:** Ordered, test-first, one logical commit/PR per task  
**Path convention:** Paths are relative to current repository root `/root/stock-opname`.  
**Progress authority:** [`IMPLEMENTATION_STATUS.md`](IMPLEMENTATION_STATUS.md); task definitions below remain acceptance contracts.

## 1. Execution Rules

1. Do not code before Product Owner phase gate.
2. Read `AGENT.md`, `prd.md`, and affected contracts before each task.
3. RED: add one failing behavior test and run it.
4. GREEN: minimum code; no unrequested framework or abstraction.
5. Run task gate, then full available gate.
6. Stop on failure; never carry broken build forward.
7. All stock/data changes need rollback or restore note.
8. Do not deploy, migrate production, or cut over without separate approval.

## 2. Repository Layout Contract

```text
package.json
pnpm-lock.yaml
.env.example
Dockerfile
compose.yaml
src/
  server.js
  config.js
  db/{pool,migrate}.js
  http/{router,response,middleware}.js
  services/{auth,master,inventory,opname,import,report,maintenance}.js
  repositories/
  public/{index.html,app.js,styles.css}
db/{migrations,seeds}/
scripts/{backup,restore,migrate-sheets,health-check}.js
test/{unit,integration,security,migration,ui}/
```

Use Node.js built-ins first (`node:http`, `crypto`, `node:test`). Initial runtime dependency: PostgreSQL driver only unless a failing requirement proves another dependency necessary.

## 3. Common Verification Contract

Once scripts exist:

```bash
pnpm test
pnpm test:integration
pnpm test:security
pnpm lint
pnpm build
docker compose config
```

Expected: exit code 0, zero failing P0 test, no leaked secret. Docker/data tasks additionally run a clean PostgreSQL fixture and reconciliation query.

## 4. Phase 1 — Repository and Docker Skeleton

### 1.1 Repository contract

- **Files:** `package.json`, `.gitignore`, `.env.example`, `src/server.js`, `test/unit/server.test.js`
- **Depends:** approved baseline; repository root verified
- **RED:** health handler test expects `{success:true}`.
- **Build:** Node HTTP server listens on configured host/port; no business endpoint.
- **Accept:** `pnpm test` PASS; secret names only in `.env.example`.
- **Commit:** `chore: initialize stock opname repository`
- **Rollback:** delete only newly created repository after confirming no prior files.

### 1.2 Docker topology

- **Files:** `Dockerfile`, `compose.yaml`, `.dockerignore`, `test/integration/docker.test.js`
- **Depends:** 1.1
- **RED:** integration probe expects app and PostgreSQL healthy.
- **Build:** non-root Node.js 22 app, internal PostgreSQL, persistent volume, healthchecks.
- **Accept:** `docker compose config && docker compose build && docker compose up -d`; health PASS; DB port not public.
- **Commit:** `chore: add docker compose runtime`
- **Rollback:** `docker compose down`; never use `-v` unless disposable fixture is proven.

## 5. Phase 2 — PostgreSQL Foundation

### 2.1 Migration runner

- **Files:** `src/db/pool.js`, `src/db/migrate.js`, `db/migrations/001_schema_migrations.sql`, `test/integration/migrate.test.js`
- **Depends:** 1.2
- **RED:** clean DB migrates once; second run changes nothing.
- **Build:** ordered, checksum-verified, forward-only migrations under advisory lock.
- **Accept:** `pnpm test:integration -- migrate`; repeat run PASS.
- **Commit:** `feat: add forward-only migration runner`
- **Rollback:** restore disposable DB; production rollback uses verified backup/forward repair.

### 2.2 Initial schema

- **Files:** `db/migrations/002_initial_schema.sql`, `test/integration/schema.test.js`
- **Depends:** 2.1; `DATABASE.md`
- **RED:** required tables, FK, unique/check constraints, indexes absent.
- **Build:** schema exactly maps `DATABASE.md`, including session hashes and nullable unbatched row uniqueness.
- **Accept:** DB-001 through DB-012 PASS; no `DROP`, `TRUNCATE`, reset.
- **Commit:** `feat: create initial database schema`
- **Rollback:** restore pre-migration backup or approved forward repair.

### 2.3 Reference seed

- **Files:** `db/seeds/001_reference.sql`, `test/integration/seed.test.js`
- **Depends:** 2.2; approved categories/units
- **RED:** repeated seed creates duplicates.
- **Build:** idempotent units, aliases, approved categories; no plaintext admin password.
- **Accept:** two runs produce identical rows.
- **Commit:** `feat: add idempotent reference seed`
- **Rollback:** fixture reset only; production seed correction is forward migration.

## 6. Phase 3 — Auth, Session, CSRF, RBAC

### 3.1 Local authentication

- **Files:** `src/services/auth.js`, `src/repositories/sessions.js`, `src/http/middleware/auth.js`, `test/integration/auth.test.js`
- **Depends:** 2.2; `SECURITY.md`
- **RED:** AUTH-001 through AUTH-011.
- **Build:** native scrypt verification, hashed opaque session secret, 30-minute idle/12-hour absolute expiry, revoke/logout.
- **Accept:** secure cookie and required login JSON; `token` non-secret reference; no localStorage contract.
- **Commit:** `feat: add local session authentication`
- **Rollback:** revoke test sessions; never weaken hash/cookie policy.

### 3.2 CSRF and login limiter

- **Files:** `src/http/middleware/csrf.js`, `src/http/middleware/rate-limit.js`, `test/security/csrf.test.js`, `test/security/login-limit.test.js`
- **Depends:** 3.1
- **RED:** SEC-001 through SEC-005 and configured abuse cases.
- **Build:** session-bound CSRF, exact Origin check, bounded memory/store limiter.
- **Accept:** invalid request has zero mutation; valid request reaches business validation.
- **Commit:** `feat: enforce csrf and login limits`
- **Rollback:** revert code; do not disable controls in public deployment.

### 3.3 Role enforcement

- **Files:** `src/http/middleware/rbac.js`, `test/security/rbac.test.js`
- **Depends:** 3.1
- **RED:** RBAC-001 through RBAC-010.
- **Build:** route/service role checks; server-enforced same-region warehouse access; supplier permission by role.
- **Accept:** wrong-role direct HTTP request returns 403; blind response omits protected values.
- **Commit:** `feat: enforce server-side rbac`
- **Rollback:** revert only before deployment; never replace with frontend-only checks.

## 7. Phase 4 — Master Data

### 4.1 Master repository/service

- **Files:** `src/repositories/masters.js`, `src/services/master.js`, `test/integration/master.test.js`
- **Depends:** 2.3, 3.3
- **RED:** duplicate, invalid reference, inactive, and hard-delete cases.
- **Build:** products/categories/units/aliases/warehouses/suppliers/users; deactivate instead of delete.
- **Accept:** ADMIN mutation audited; other roles read-only; `REVIEW` blocked from transaction.
- **Commit:** `feat: add validated master services`
- **Rollback:** transaction rollback; corrections through audited update/deactivation.

### 4.2 Master HTTP/UI

- **Files:** `src/http/router.js`, `src/public/index.html`, `src/public/app.js`, `src/public/styles.css`, `test/ui/master.test.js`
- **Depends:** 4.1; `API.md`, `UI_SPEC.md`
- **RED:** route, role state, loading/error, keyboard tests.
- **Build:** paginated API and Vanilla JS screens.
- **Accept:** 360px usable; labels/focus/error states PASS.
- **Commit:** `feat: add master api and screens`
- **Rollback:** revert UI/routes; preserve master rows.

## 8. Phase 5 — Ledger, Batch, Balance

### 5.1 Mutation transaction core

- **Files:** `src/repositories/inventory.js`, `src/services/inventory.js`, `test/integration/inventory-core.test.js`
- **Depends:** 4.1
- **RED:** atomic rollback, non-negative, immutable ledger, reconciliation cases.
- **Build:** lock → reference/idempotency check → ledger → batch/balance → audit → commit.
- **Accept:** forced failure changes zero stock rows; cache equals ledger; batches equal balance.
- **Commit:** `feat: add atomic inventory transaction core`
- **Rollback:** DB rollback; no direct ledger edit.

### 5.2 Stock in

- **Files:** same service/repository, `test/integration/stock-in.test.js`, stock-in UI module in `src/public/app.js`
- **Depends:** 5.1
- **RED:** IN-001 through IN-008.
- **Build:** conversion, named batch, single NULL batch row, idempotent result.
- **Accept:** ledger/batch/balance/audit atomic; same key+different payload conflicts.
- **Commit:** `feat: add idempotent stock in`
- **Rollback:** transaction rollback or approved reversal; never delete ledger.

### 5.3 FEFO stock out

- **Files:** same service/repository, `test/integration/stock-out.test.js`, stock-out UI module
- **Depends:** 5.2; approved expired-batch rule
- **RED:** OUT-001 through OUT-009 including expired-only inventory and 20 race iterations.
- **Build:** exclude `expiry_date < CURRENT_DATE`, deterministic FEFO across eligible batches, NULL expiry last, row locking, allocation ledger rows.
- **Accept:** expired-only/insufficient/concurrent demand never mutates stock or makes it negative.
- **Commit:** `feat: add locked fefo stock out`
- **Rollback:** transaction rollback or approved reversal.

### 5.4 Read models

- **Files:** `src/services/report.js`, `test/integration/stock-read.test.js`, stock/card UI modules
- **Depends:** 5.3
- **RED:** pagination, filtering, running balance, query plan fixture.
- **Build:** stock list, transaction list, stock card.
- **Accept:** max limit enforced; no N+1/full-history memory load.
- **Commit:** `feat: add inventory read models`
- **Rollback:** revert read queries only.

## 9. Phase 6 — Stock Opname

### 6.1 Snapshot and blind count

- **Files:** `src/repositories/opname.js`, `src/services/opname.js`, `test/integration/opname-count.test.js`, opname UI module
- **Depends:** 5.1, 3.3
- **RED:** OP-001 through OP-007, RBAC-011, and blind JSON/DOM leak test.
- **Build:** create/start/save/submit state machine; SUPERVISOR may count any opname; explicit zero counts; reason validation.
- **Accept:** PETUGAS response/DOM lacks system quantity and difference; SUPERVISOR count access succeeds.
- **Commit:** `feat: add blind stock opname counting`
- **Rollback:** failed transaction only; preserve submitted evidence.

### 6.2 Review, reject, recount, approve

- **Files:** same service/repository, `test/integration/opname-approval.test.js`, review UI module
- **Depends:** 6.1
- **RED:** OP-008 through OP-017 including SUPERVISOR self-approval and concurrent approval.
- **Build:** snapshot guard, SUPERVISOR self-count approval permission, field reset on recount, atomic adjustment approval.
- **Accept:** valid SUPERVISOR self-count approval succeeds; movement after snapshot blocks approval; one adjustment maximum.
- **Commit:** `feat: add guarded opname approval`
- **Rollback:** rejected transaction rolls back; committed adjustment uses approved reversal process.

## 10. Phase 7 — Import

### 7.1 Preview and OCR staging

- **Files:** `src/services/import.js`, `src/repositories/imports.js`, `test/integration/import-preview.test.js`, import UI module
- **Depends:** 4.1
- **RED:** malformed/header/size/OCR-isolation/review cases.
- **Build:** bounded CSV parser, SHA-256, exact READY header, staging only.
- **Accept:** preview/OCR produces zero ledger rows.
- **Commit:** `feat: add safe import preview`
- **Rollback:** delete disposable staging batch through controlled cleanup only.

### 7.2 Confirm import

- **Files:** same service/repository, `test/integration/import-confirm.test.js`
- **Depends:** 7.1, 5.2
- **RED:** atomic confirm, duplicate, changed payload, unresolved row cases.
- **Build:** server revalidation and idempotent stock-in composition.
- **Accept:** duplicate confirmation adds zero stock; REVIEW blocks all commit.
- **Commit:** `feat: add atomic import confirmation`
- **Rollback:** transaction rollback/reversal; preserve file evidence.

## 11. Phase 8 — Dashboard and Reports

### 8.1 Dashboard

- **Files:** `src/services/report.js`, `test/integration/dashboard.test.js`, dashboard UI module
- **Depends:** 5.4, 6.2
- **RED:** aggregate fixture and read-only action tests.
- **Build:** indexed aggregate cards and bounded recent transactions.
- **Accept:** values match canonical fixture; no mutation route/control.
- **Commit:** `feat: add read-only dashboard`
- **Rollback:** revert read model/UI.

### 8.2 Reports and CSV

- **Files:** same service, `test/integration/reports.test.js`, reports UI module
- **Depends:** 8.1
- **RED:** type/filter/pagination/CSV injection/streaming tests.
- **Build:** all `API.md` report types; streaming CSV.
- **Accept:** filtered totals correct; formula-leading cells escaped.
- **Commit:** `feat: add inventory reports`
- **Rollback:** revert read/export paths.

## 12. Phase 9 — Maintenance and Recovery

### 9.1 Health and reconciliation

- **Files:** `src/services/maintenance.js`, `scripts/health-check.js`, `test/integration/health.test.js`
- **Depends:** 5.1
- **RED:** missing schema, negative, ledger/balance, batch/balance fixture failures.
- **Build:** public shallow health plus protected detailed health.
- **Accept:** exact inconsistency detected; no sensitive detail public.
- **Commit:** `feat: add health and reconciliation checks`
- **Rollback:** read-only.

### 9.2 Backup and restore

- **Files:** `scripts/backup.js`, `scripts/restore.js`, `test/integration/backup-restore.test.js`
- **Depends:** 9.1; Drive credential configured
- **RED:** corrupt/truncated/missing copy cases.
- **Build:** local dump, checksum, Drive copy, 7/4/12 retention, isolated restore verify.
- **Accept:** OPS-001 through OPS-006; RPO <=24h and drill RTO <=4h.
- **Commit:** `feat: add verified backup and restore`
- **Rollback:** never delete primary/active backup; restore only isolated target until approved.

### 9.3 Balance rebuild

- **Files:** maintenance service, `test/integration/rebuild.test.js`
- **Depends:** 9.2
- **RED:** successful rebuild, invalid ledger, concurrent mutation cases.
- **Build:** `BACKUP → LOCK → REBUILD → RECONCILE → AUDIT`.
- **Accept:** mismatch repaired only from ledger; unsafe result leaves original cache intact.
- **Commit:** `feat: add guarded balance rebuild`
- **Rollback:** restore verified pre-rebuild backup.

## 13. Phase 10 — Google Sheets Migration

### 10.1 Export and dry run

- **Files:** `scripts/migrate-sheets.js`, `src/services/migration.js`, `test/migration/dry-run.test.js`
- **Depends:** schema/master/import core; source inventory access
- **RED:** checksum/orphan/collision/normalization fixtures.
- **Build:** immutable CSV export manifest, mapping evidence, zero-write dry run.
- **Accept:** all source sheets inventoried or explicitly absent; no source mutation.
- **Commit:** `feat: add migration dry run`
- **Rollback:** remove disposable artifacts only after evidence copy.

### 10.2 Rehearsal and final delta

- **Files:** migration service, `test/migration/rehearsal.test.js`, run evidence directory
- **Depends:** 10.1, 9.2
- **RED:** second-run, reconciliation, historical `IN`, rollback accounting.
- **Build:** ordered idempotent import and ledger-derived rebuild.
- **Accept:** second run adds zero ledger rows; all critical reconciliation PASS.
- **Commit:** `feat: add repeatable migration rehearsal`
- **Rollback:** isolated DB reset; production delta rollback follows `MIGRATION.md`.

## 14. Phase 11 — Hardening and UI Gate

### 11.1 Security hardening

- **Files:** HTTP headers/config, `test/security/*.test.js`, container config
- **Depends:** all APIs
- **RED:** full `SECURITY.md` acceptance suite.
- **Build:** CSP, timeout/body limits, redaction, non-root runtime, dependency scan remediation.
- **Accept:** zero P0 security failure or unmitigated critical exploitable finding.
- **Commit:** `security: harden public application`
- **Rollback:** revert only if security gate remains equal or stronger.

### 11.2 UI and accessibility gate

- **Files:** `src/public/*`, `test/ui/*.test.js`
- **Depends:** complete routes
- **RED:** role/state/modal/360px/keyboard/labels tests.
- **Build:** minimum fixes required by `UI_SPEC.md`.
- **Accept:** blind DOM leak, modal, responsive, and keyboard smoke PASS.
- **Commit:** `test: complete ui acceptance gate`
- **Rollback:** revert UI regression; no data impact.

## 15. Phase 12 — UAT, Cutover, Hypercare

### 12.1 Release candidate

- **Files:** no new business contract; release evidence only
- **Depends:** all tests, build, Docker, migration rehearsal, backup restore PASS
- **Action:** run full gate from clean checkout and Product Owner UAT.
- **Accept:** P0 100% PASS, zero skipped, checksum/evidence recorded.
- **Commit:** `chore: prepare stock opname release candidate`
- **Rollback:** no production mutation.

### 12.2 CT104/public HTTPS deployment

- **Files:** deployment configuration approved for verified target
- **Depends:** explicit deployment approval and verified port/path/domain
- **Action:** backup, deploy immutable build, migrate, smoke, monitor.
- **Accept:** HTTPS/cookie/health/RBAC/reconciliation/backup-age smoke PASS.
- **Commit:** deployment commit/tag after evidence.
- **Rollback:** previous image/config; preserve DB; invoke migration rollback plan if trigger fires.

### 12.3 Cutover

- **Depends:** 12.2 and explicit cutover approval
- **Action:** GAS write freeze, final delta, reconcile, route users, seven-day monitoring.
- **Accept:** zero critical mismatch; rollback path remains available.
- **Rollback:** stop target mutations, account target-only ledger, restore approved source write path only with Product Owner decision.

## 16. Definition of Done per Task

- failing test observed before production behavior
- target test and full available suite PASS
- lint/build/Docker gate PASS where applicable
- no undocumented business-rule change
- no sensitive data in code/log/evidence
- DB mutation atomic, audited, and rollback-defined
- docs updated only when contract intentionally changes
- git diff reviewed; one logical commit

## 17. Hard Stops

Stop implementation when baseline lacks approval, deployment target is unverified, source export is inaccessible, backup restore fails, schema/API conflict appears, role rule conflicts, or any P0 test fails.

# Test Plan — Stock Opname SPPG PAKISKEMBAR 2

**Status:** Approved v0.1.0 — implementation baseline  
**Method:** TDD, integration-first for stock invariants  
**Runtime:** Node.js 22 + pnpm + PostgreSQL

## 1. Rules

1. Production behavior starts with failing test.
2. RED must fail on expected behavior assertion, not broken harness.
3. GREEN uses minimum code; full suite runs before commit.
4. Stock, auth, migration, backup, and concurrency tests use real PostgreSQL.
5. Every case records precondition, actor, action, expected response, DB state, audit, cleanup.
6. Tests never run against production DB.
7. Critical FAIL stops release.

## 2. Test Layers

| Layer | Scope | Required evidence |
|---|---|---|
| Unit | normalization, conversion, FEFO ordering | deterministic assertions |
| Service integration | transaction, lock, RBAC, state machine | real PostgreSQL rows |
| API | request/response/cookie/CSRF/errors | HTTP status + payload + DB |
| UI smoke | role states, blind count, responsive, a11y | browser result/screenshots |
| Migration | dry run, re-run, reconciliation | reports/checksums |
| Operations | backup/restore/rebuild/health | isolated restore evidence |
| Production smoke | public HTTPS and read-only checks | timestamped output |

## 3. Required Case Format

```text
ID, title, priority, requirement, precondition, fixture,
actor, request/action, expected HTTP/UI result,
expected ledger/batch/balance/audit state,
cleanup, command, evidence
```

Priority: P0 stock/security/recovery; P1 workflow; P2 presentation.

## 4. Fixture Baseline

Canonical fixture:

```text
Product BRG-001, warehouse WH-001, base unit KILOGRAM
OPENING +100 kg
IN +50 kg
OUT -30 kg
SYSTEM 120 kg
PHYSICAL 118 kg
ADJUSTMENT -2 kg
FINAL 118 kg
```

Batch fixture:

```text
B1 expiry 2026-11-01 quantity 10
B2 expiry 2026-12-01 quantity 15
NULL batch/expiry quantity 20
OUT 30 → B1 10, B2 15, NULL 5
```

Actors: active ADMIN, SUPERVISOR, PETUGAS, inactive user, second PETUGAS.

Regional fixture: Region A and Region B; every actor and warehouse belongs to exactly one region.

## 5. Schema dan Migration Tests

| ID | Case | Expected |
|---|---|---|
| DB-001 | clean migration | all required tables, FK, checks, indexes exist |
| DB-002 | migration re-run | no duplicate/destructive change |
| DB-003 | negative balance insert/update | DB rejects |
| DB-004 | negative batch insert/update | DB rejects |
| DB-005 | duplicate idempotency key | unique violation/service conflict |
| DB-006 | duplicate product/warehouse balance | rejected |
| DB-007 | duplicate named batch | rejected |
| DB-008 | second NULL batch product+warehouse | rejected |
| DB-009 | invalid role/opname/status enum | rejected |
| DB-010 | hard delete referenced master | rejected |
| DB-011 | auth session secret plaintext lookup | only hash stored |
| DB-012 | forward migration inspection | no automatic DROP/TRUNCATE/reset |

## 6. Authentication dan Session

| ID | Actor/action | Expected |
|---|---|---|
| AUTH-001 | valid local login | 200, secure cookie, required JSON fields |
| AUTH-002 | wrong/unknown credential | same generic error |
| AUTH-003 | inactive user | denied, no session |
| AUTH-004 | missing cookie | 401 |
| AUTH-005 | expired/revoked session | 401 |
| AUTH-006 | logout then reuse | 401; cookie cleared |
| AUTH-007 | password/status change | all prior sessions revoked |
| AUTH-008 | inspect JSON/storage | `token` non-secret; no localStorage credential |
| AUTH-009 | cookie attributes | HttpOnly, Secure, SameSite=Lax, Path=/ |
| AUTH-010 | repeated failures | 429 after configured threshold |
| AUTH-011 | password hash | scrypt salt/params and timing-safe verify |
| AUTH-012 | inspect login `license` | exact public literal `SELF_HOSTED`; no key/secret/config-derived value |

## 7. CSRF dan Browser Security

| ID | Case | Expected |
|---|---|---|
| SEC-001 | mutation missing CSRF | 403; no DB change |
| SEC-002 | wrong/session-foreign CSRF | 403; no DB change |
| SEC-003 | foreign/missing Origin mutation | 403 |
| SEC-004 | valid cookie+Origin+CSRF | proceeds to business validation |
| SEC-005 | GET endpoints | no mutation |
| SEC-006 | reflected/stored script payload | rendered as text |
| SEC-007 | SQL payload in q/sort | no injection; sort allowlisted |
| SEC-008 | production error | no SQL/stack/path/secret |
| SEC-009 | log capture | cookie/password/CSRF/session secret absent |
| SEC-010 | CSV formula export | dangerous leading cell escaped |

## 8. RBAC Negative Matrix

Every protected endpoint group gets anonymous 401 and wrong-role 403 test.

| ID | Actor | Forbidden action |
|---|---|---|
| RBAC-001 | PETUGAS | approve opname |
| RBAC-002 | PETUGAS | reject opname |
| RBAC-003 | PETUGAS | opening stock |
| RBAC-004 | PETUGAS | import confirm |
| RBAC-005 | PETUGAS | backup/rebuild/user/master mutation |
| RBAC-006 | SUPERVISOR | user/master mutation |
| RBAC-007 | SUPERVISOR | import/backup/rebuild |
| RBAC-008 | second PETUGAS | mutate owned opname of first PETUGAS |
| RBAC-009 | role changed mid-session | next request denied by new role |
| RBAC-010 | direct crafted URL | same denial as hidden UI |
| RBAC-011 | SUPERVISOR | create/count/submit any opname is allowed |
| RBAC-012 | SUPERVISOR | approve opname counted by same SUPERVISOR is allowed when state/snapshot checks pass |
| RBAC-013 | ADMIN/SUPERVISOR/PETUGAS | cross-region warehouse read/mutation is denied server-side |

Repeat warehouse-scoped reads and mutations with IDs/codes from Region B while authenticated in Region A. Expect `REGION_FORBIDDEN` and zero DB mutation for every role, including ADMIN.

## 9A. Opening Stock

| ID | Case | Expected |
|---|---|---|
| OPEN-001 | ADMIN, same region, first physical opening | one OPENING ledger + batch + balance + audit atomically |
| OPEN-002 | SUPERVISOR/PETUGAS | `FORBIDDEN`; zero mutation |
| OPEN-003 | any role, cross-region warehouse | `REGION_FORBIDDEN`; zero mutation |
| OPEN-004 | zero/negative/NaN or invalid reference/unit | actionable rejection; zero mutation |
| OPEN-005 | ledger already exists for product+warehouse | `OPENING_ALREADY_EXISTS`; zero mutation |
| OPEN-006 | same key+same canonical payload retry | original result; zero added rows |
| OPEN-007 | same key+different canonical payload | `IDEMPOTENCY_CONFLICT`; zero added rows |
| OPEN-008 | forced failure after ledger write | ledger/batch/balance/audit all rollback |
| OPEN-009 | concurrent openings for same product+warehouse | exactly one succeeds; no duplicate opening |
| OPEN-010 | purchase unit input | exact base-unit quantity stored |

## 9. Master Reference Tests

- valid create/update/deactivate by ADMIN
- duplicate code/barcode rejected
- inactive master rejected for new transaction
- invalid category/unit/warehouse/supplier returns actionable code
- alias resolves to canonical unit
- unknown alias does not create random unit
- product `REVIEW` cannot enter stock mutation
- physical delete unavailable

## 10. Stock In

| ID | Case | Expected state |
|---|---|---|
| IN-001 | valid named batch | one IN ledger; batch/balance/audit increment atomic |
| IN-002 | empty batch/expiry | NULL batch row created/merged |
| IN-003 | same key+payload retry | original result; zero added rows |
| IN-004 | same key+different payload | `IDEMPOTENCY_CONFLICT` |
| IN-005 | invalid reference/unit/qty | zero ledger/batch/balance change |
| IN-006 | forced failure after ledger write | full rollback |
| IN-007 | purchase conversion | exact base-unit quantity |
| IN-008 | two concurrent same keys | one mutation only |

## 11. Stock Out dan FEFO

| ID | Case | Expected |
|---|---|---|
| OUT-001 | valid available stock | signed OUT ledger + matching batch/balance/audit |
| OUT-002 | requested > available | `INSUFFICIENT_STOCK`; no mutation |
| OUT-003 | multi-batch fixture | B1 then B2 then NULL allocation |
| OUT-004 | equal expiry tie | deterministic secondary order |
| OUT-005 | only expired stock can satisfy request | `INSUFFICIENT_STOCK`; zero ledger/batch/balance mutation |
| OUT-006 | finite zero/negative/NaN | rejected |
| OUT-007 | failure on allocation N | all allocations rollback |
| OUT-008 | two concurrent outs exceed total | one/restricted combination succeeds; no negative |
| OUT-009 | retry after unknown client result | idempotent original result |

## 12. Ledger dan Reconciliation

- direct normal API edit/delete ledger absent
- aggregate ledger equals `stock_balances` by product+warehouse
- batch total equals balance
- rebuild from ledger recreates exact balance
- rebuild fails safely if ledger implies invalid negative state
- rebuild writes audit and requires verified backup
- transaction running balance is deterministic
- mutation has actor/reference/timestamp/audit

## 13. Stock Opname

| ID | Case | Expected |
|---|---|---|
| OP-001 | create | DRAFT with locked-consistent snapshot/items |
| OP-002 | PETUGAS detail | JSON and DOM omit system qty/difference |
| OP-003 | start | DRAFT to COUNTING |
| OP-004 | incomplete counts submit | rejected |
| OP-005 | zero count explicitly entered | counted, not missing |
| OP-006 | non-zero difference no reason | rejected |
| OP-007 | valid submit | SUBMITTED |
| OP-008 | PETUGAS approve | 403 |
| OP-009 | approve canonical fixture | ADJUSTMENT -2; APPROVED; final 118 |
| OP-010 | transaction after snapshot | approval blocked; no adjustment |
| OP-011 | concurrent double approval | one commit only |
| OP-012 | reject without reason | rejected |
| OP-013 | reject then recount | old physical/difference/value/reason/notes cleared |
| OP-014 | adjustment would negative | approval rejected atomically |
| OP-015 | wrong state transition | `INVALID_STATUS` |
| OP-016 | SUPERVISOR count and submit any opname | permitted |
| OP-017 | same SUPERVISOR approves self-counted opname | permitted; snapshot/state guards still enforced |

## 14. Import dan OCR

- exact READY header accepted; missing/extra critical header rejected
- malformed/oversized CSV rejected before persistence
- preview writes no ledger
- OCR file writes staging only
- unresolved category/unit/product/warehouse remains REVIEW
- confirm with REVIEW rows rejected
- confirm valid file atomically writes stock
- same file hash/row re-confirm adds zero stock
- same stable key changed payload conflicts
- concurrent same-key confirmation creates one effective commit
- changed key after committed confirmation conflicts
- warehouse moved outside actor region before confirm is denied with zero mutation
- historical invoice transaction type equals `IN`
- CSV formula content never executes and safe export escapes it

## 15. Dashboard, Reports, UI

- dashboard endpoint/mouse actions are read-only
- aggregate cards match fixture
- list endpoints honor default/max pagination
- report filters return correct subset
- large CSV endpoint streams
- modal Cancel/backdrop/Escape/focus cleanup PASS
- 360px stock-in/out/opname workflow usable without clipped primary action
- keyboard reaches all controls with visible focus
- labels/errors/aria-live available
- 401 and 403 produce different UI behavior
- offline unknown mutation result does not invite new idempotency key

## 16. Migration Rehearsal

1. Manifest checksums verify.
2. Dry run makes zero target mutation.
3. Invalid/orphan/collision appears in evidence.
4. Import order preserves FK.
5. First import reconciles accepted rows/totals.
6. Second import adds zero ledger rows.
7. Target balance equals target ledger.
8. Target batch totals equal target balance.
9. Source mismatch is reported, not overwritten.
10. Final delta rehearsal and rollback accounting PASS.

## 17. Backup, Restore, Health

| ID | Case | Expected |
|---|---|---|
| OPS-001 | daily backup | local file + Drive copy + metadata/checksum |
| OPS-002 | corrupt/truncated file | verification FAIL |
| OPS-003 | isolated restore | schema/data/reconciliation PASS |
| OPS-004 | retention | keeps 7 daily, 4 weekly, 12 monthly; active backup safe |
| OPS-005 | RPO check | latest verified backup age <=24h |
| OPS-006 | timed restore drill | service recovery <=4h |
| OPS-007 | health with negative/mismatch fixture | detects exact issue |
| OPS-008 | backup/restore failure | actionable audit, no false success |

## 18. Concurrency Harness

Use separate DB connections synchronized at barrier. Run at least 20 repeated races for:

- two outs against same balance/batches
- stock-in retry with same idempotency key
- transaction concurrent with opname approval
- two approvals
- rebuild concurrent with mutation

Assertions: no deadlock leak, no negative values, exactly-once ledger semantics, consistent audit, bounded timeout. Test timeout is FAIL, not automatic retry success.

## 19. Production Smoke

Read-only/safe checks after deployment:

- HTTPS certificate and HTTP redirect
- `/health` returns healthy without secrets
- PostgreSQL not publicly exposed
- login/session/cookie/CSRF work
- role denial smoke
- dashboard/stock/report read
- backup age visible
- ledger/balance reconciliation PASS

Do not create stock mutation during production smoke unless approved test transaction and reversal procedure exist.

## 20. Commands Contract

Final commands are frozen when repository scripts exist. Required script names:

```bash
pnpm test
pnpm test:integration
pnpm test:security
pnpm test:migration
pnpm test:ui
pnpm lint
pnpm build
docker compose config
docker compose build
docker compose up -d
curl -f https://<host>/health
```

Reports include command, exit code, runtime, passed/failed/skipped counts, and artifact path. Missing script is NOT VERIFIED, never PASS.

## 21. Release Gate

P0 requires 100% PASS, zero skipped. P1 failure blocks affected feature. Release requires:

- schema/migration PASS
- auth/CSRF/RBAC negative PASS
- stock atomicity/FEFO/idempotency/concurrency PASS
- opname blind/snapshot/recount/adjustment PASS
- import isolation/duplicate PASS
- ledger/balance/batch reconciliation PASS
- backup restore/RPO/RTO PASS
- production smoke PASS

Report only `PASS`, `FAIL`, or `NOT VERIFIED` with real output.

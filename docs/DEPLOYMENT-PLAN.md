# Deployment and Recovery Plan — Living Candidate

**Updated:** 2026-10-20  
**Audited revision:** `cff1796cb8d3798b097cb17d790736500c9765c2`  
**Observed runtime:** active at `https://opname.projecthasan.com`  
**Complete product acceptance:** `FAIL` — approved scope still incomplete  
**New production mutation:** requires explicit approval

## Current Evidence

| Check | Result | Evidence |
|---|---|---|
| GitHub `main` revision | `PASS` | `cff1796cb8d3798b097cb17d790736500c9765c2` |
| GitHub CI | `PASS` | run `38201447672` |
| Public health | `PASS` | HTTP 200 `{"success":true}` on 2026-10-20 |
| Login page | `PASS` | HTTP 200 on 2026-10-20 |
| App | `PASS` | running, healthy, immutable revision-tagged image |
| PostgreSQL | `PASS` | running, healthy, not publicly published by Compose contract |
| Reverse proxy | `PASS` | Caddy running |
| Full release matrix | `NOT VERIFIED` | remaining feature, recovery, migration, and reconciliation gates incomplete |

Runtime evidence proves current service availability only. It does not retroactively prove approval, full product acceptance, recovery readiness, or migration/cutover correctness.

## Remaining Product Gates

- [ ] Transaction UI for Opening Stock, Stock In, and Stock Out
- [ ] Inventory read models and stock card
- [ ] Stock Opname end-to-end with blind-count and snapshot guards
- [ ] Import preview/confirm
- [ ] Dashboard, reports, and safe CSV export
- [ ] Protected detailed health and reconciliation
- [ ] Backup/restore automation and isolated restore drill
- [ ] Google Sheets migration tooling and rehearsal
- [ ] Full P0 matrix, zero skipped for release scope

## Procedure for Next Candidate

1. Open PR from clean `origin/main`; no direct-main push.
2. Run unit, UI, security, integration, lint, build, and Compose validation in CI.
3. Back up target DB and verify checksum before any schema/data mutation.
4. Restore backup into isolated PostgreSQL and reconcile before touching production.
5. Deploy candidate with separate Compose project, DB, network, volume, and secrets.
6. Run HTTPS, cookie, CSRF, RBAC, negative cross-region, idempotency, stock, and reconciliation smoke tests.
7. Record candidate image digest/revision and all command exit codes.
8. Request explicit production-switch approval.
9. Promote exact verified artifact; do not rebuild a different image.
10. Monitor health, errors, reconciliation, disk, and backup age.

## Hard Stops

Stop before production mutation when any item is true:

- DB backup or isolated restore fails.
- Ledger/balance or batch/balance mismatch exists.
- Wrong-role or cross-region request succeeds.
- Same idempotency key can create duplicate stock.
- Migration second run creates extra ledger rows.
- Candidate image differs from approved image digest.
- Required approval is absent.

## Rollback Triggers

- Service unavailable or repeated critical errors after switch.
- Authorization or data-isolation failure.
- Duplicate, negative, or unreconciled stock mutation.
- Schema migration failure or irreversible incompatibility.
- Backup/restore evidence becomes invalid.

## Rollback Sequence

1. Stop new target mutations; preserve logs, DB, image, and timestamps.
2. Route traffic to prior verified app only when schema compatibility is proven.
3. Never delete or reset production DB to simplify rollback.
4. Restore DB only from verified backup with explicit approval.
5. Reconcile ledger, batch, balance, audit, and target-only transactions.
6. Record incident; reopen traffic only after smoke and reconciliation pass.

## Current Action

Version living documents through PR. No production application, DB, DNS, migration, source-freeze, or cutover mutation is part of this documentation change.
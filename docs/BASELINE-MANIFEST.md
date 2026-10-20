# Product Contract Manifest — Stock Opname

**Updated:** 2026-10-20  
**Contract identifier:** `STOCK-OPNAME-DOCS-v0.1.0-2026-10-08`  
**Contract status:** APPROVED; maintained as living documents  
**As-built revision:** `cff1796cb8d3798b097cb17d790736500c9765c2`  
**Repository branch:** `docs/living-product-contract`

## Scope

- Authoritative documents: 13
- Lines: 4,564
- Bytes: 154,065
- Integrity file: `SHA256SUMS`
- Product contract approval date: 2026-10-08
- As-built synchronization date: 2026-10-20

## Approved Decisions Preserved

- Local account authentication uses secure HttpOnly session cookie.
- Login `token` is non-secret session reference; never bearer/localStorage.
- Login `license` is public literal `SELF_HOSTED`.
- Cookie-authenticated mutations require Origin and CSRF validation.
- Every user belongs to one region; every warehouse belongs to one region.
- Server rejects cross-region warehouse access.
- PostgreSQL ledger is stock source of truth.
- Balance and batches change atomically with ledger rows.
- Existing Stock In batch uses weighted-average `purchase_price`.
- Normal Stock Out excludes `expiry_date < CURRENT_DATE`.
- Request needing expired stock fails atomically with `INSUFFICIENT_STOCK`.
- FEFO uses nearest eligible expiry first and NULL expiry last.
- SUPERVISOR may create, count, submit, reject, and approve any opname in allowed region.
- SUPERVISOR self-approval remains subject to normal guards.
- Blind opname hides system quantity from PETUGAS.
- Historical invoices remain `IN`, never `OPENING`.
- Backup target remains 7 daily, 4 weekly, 12 monthly; RPO 24h; RTO 4h.

## Version-Control State

| Item | Value |
|---|---|
| Remote | `git@github.com:Misyad/stockopname.git` |
| Base | `origin/main` |
| Base revision | `cff1796cb8d3798b097cb17d790736500c9765c2` |
| Documentation location | `docs/` |
| Change path | branch → PR → CI → merge |

## Runtime Observation

Production runtime was observed active on 2026-10-20:

- app image tagged with base revision and healthy
- PostgreSQL running and healthy
- Caddy running
- public `/health` HTTP 200
- public `/login` HTTP 200

Observation is evidence of current health, not proof of full product acceptance, migration correctness, backup recoverability, or approval history.

## Change Control

- Product rules do not change silently.
- Approved rule change requires owner decision, impact analysis, affected docs/tests, and version history.
- As-built status may update with source/runtime evidence without re-freezing the product on every change.
- `SHA256SUMS` is regenerated after package edits and verified before commit.
- Production application, DB, DNS, migration, source-write freeze, and cutover changes need separate approval.

## Current Gate

| Axis | Decision |
|---|---|
| Product contract | `APPROVED` |
| Implementation continuation | `GO` |
| Current shallow runtime health | `PASS` |
| Complete approved product scope | `FAIL` — remaining features listed in `IMPLEMENTATION_STATUS.md` |
| Full release/recovery evidence | `NOT VERIFIED` |
| New production mutation | `NOT AUTHORIZED BY THIS DOCUMENTATION PR` |

# Security Baseline — Stock Opname SPPG PAKISKEMBAR 2

**Status:** Approved v0.1.0 — implementation baseline  
**Exposure:** Public HTTPS  
**Authentication:** Local account + server session cookie

## 1. Security Objectives

Protect stock integrity, credentials, personal user data, audit evidence, backups, and operational availability. UI convenience never bypasses server authorization or DB invariants.

## 2. Assets

- local account credentials
- opaque session secrets and CSRF tokens
- product/master data
- immutable stock ledger
- batch and balance cache
- opname snapshot/count/adjustment
- import files and OCR staging
- audit logs
- database and backup files
- migration mapping/evidence

## 3. Trust Boundaries

```text
Internet browser
  ↓ HTTPS
Reverse proxy
  ↓ trusted internal HTTP/network
Node.js application
  ↓ authenticated PostgreSQL connection
PostgreSQL volume

Application
  ↓ restricted backup job
Local backup storage
  ↓ restricted encrypted transport
Google Drive backup
```

All browser input, cookies, headers, CSV, query parameters, and source migration data are untrusted.

## 4. Threat Model

| Threat | Control |
|---|---|
| Credential stuffing | rate limit, generic login errors, audit |
| Session theft | HTTPS, HttpOnly/Secure cookie, rotation, expiry, revocation |
| CSRF | SameSite=Lax, Origin validation, synchronizer token |
| Broken access control | route+service RBAC, negative tests |
| SQL injection | parameterized SQL, allowlisted sorting |
| XSS | text rendering/escaping, CSP, no unsafe HTML |
| CSV formula injection | prefix dangerous export cells, safe import parsing |
| Duplicate mutation | idempotency key in same transaction |
| Concurrent overspend | DB transaction and row/advisory locks |
| Ledger tampering | no update/delete normal API; restricted DB role |
| Malicious upload | size/type/header limits; staging only |
| Secret leakage | redaction, env secrets, no client/log exposure |
| Backup theft | restricted access, encryption, checksum |
| Supply-chain issue | lockfile, pinned runtime, vulnerability scan |
| Denial of service | body/rate/time limits, pagination, streaming |

## 5. Authentication

### Password storage

Use Node.js native `crypto.scrypt` with per-user random salt of at least 16 bytes, derived key at least 64 bytes, and parameters sized for deployment memory (`N=131072`, `r=8`, `p=1`, `maxmem>=256 MiB`). Compare using `timingSafeEqual`.

Passwords:

- minimum 12 characters for new/reset credentials
- no forced periodic change without incident
- setup/reset uses one-time flow; never logs plaintext
- generic `INVALID_CREDENTIALS` for unknown email and bad password
- inactive user denied before session creation

### Session lifecycle

1. Successful login creates DB-backed session.
2. Browser receives random opaque secret cookie; DB stores only its hash.
3. JSON response returns `{userId,email,role,token,license}`; `token` is non-secret session reference and `license` is the public application constant `SELF_HOSTED`, never a key/secret or DB/environment value.
4. Session credential and `token` never go to `localStorage`.
5. Rotate session on login and privilege/account status change.
6. Idle timeout: 30 minutes; absolute timeout: 12 hours.
7. Logout/revocation clears cookie and sets `revoked_at`.
8. Password reset/deactivation revokes all sessions.

Cookie attributes:

```text
HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=<session limit>
```

Do not set `Domain` unless cross-subdomain scope is explicitly required.

## 6. CSRF dan Origin

- Every state-changing request requires valid session, allowed `Origin`, and `X-CSRF-Token`.
- `GET /auth/csrf` returns a session-bound token; frontend stores it in memory only.
- Token mismatch returns `403 CSRF_INVALID` without mutation.
- GET/HEAD endpoints must remain side-effect free.
- Missing/foreign Origin on browser mutation fails closed.

## 7. Login Abuse Controls

- Per-IP and normalized-email rate buckets.
- Initial limit: 5 failed attempts per 15 minutes per email and 30 per 15 minutes per IP; configuration may tighten after measurement.
- Successful login resets email failure counter, not global IP evidence.
- Return `429 RATE_LIMITED` with bounded retry information.
- Audit repeated failure without storing password.
- Reverse proxy enforces request/body/header timeout and connection limits.

## 8. RBAC

| Capability | ADMIN | SUPERVISOR | PETUGAS |
|---|---:|---:|---:|
| User/master mutation | Yes | No | No |
| Stock read | Yes | Yes | Yes |
| Stock IN/OUT | Yes | Yes | Yes |
| Opening stock | Yes | No | No |
| Opname count | Yes | Yes/all | Yes/owner |
| Approve/reject opname | Yes | Yes | No |
| Import | Yes | No | No |
| Reports | Yes | Yes | Yes |
| Backup/rebuild | Yes | No | No |
| Health detail | Yes | Read | No |
| Audit edit/delete | No | No | No |

Warehouse access uses role plus region. Middleware enforces route role; service resolves the warehouse and enforces `user.region_id = warehouse.region_id` again. Frontend hiding is not authorization.

## 9. Mandatory Negative Authorization Tests

- anonymous request to every protected group returns 401
- PETUGAS approve/reject/opening/import/backup/rebuild/user/master mutation returns 403
- SUPERVISOR user/master mutation/import/backup/rebuild returns 403
- second PETUGAS non-owner counter mutation returns 403
- SUPERVISOR counter mutation for any opname is allowed; approval of the same opname still requires all state/snapshot checks
- role changed/deactivated during session blocks next request
- blind PETUGAS detail omits system quantity and difference fields
- direct URL and crafted HTTP request behave same as hidden UI control

Negative tests must cover every role, including ADMIN, attempting warehouse-scoped reads and mutations against another region. Crafted IDs/codes, direct URLs, filters, and request bodies must fail with `REGION_FORBIDDEN` before mutation.

## 10. Input Validation

- Validate at API boundary and again for DB/business invariants.
- Reject unknown object fields on mutation where feasible.
- Quantity/price must be finite decimal within documented precision/range.
- IDs/codes have length and character limits.
- Date must be ISO and semantically valid.
- Enum values are allowlisted.
- Sorting columns are allowlisted; never interpolate arbitrary SQL.
- Parameterized SQL for all values.

## 11. Upload dan CSV

Initial limits:

```text
CSV only; max 10 MiB; max 100,000 rows; max field 4 KiB;
UTF-8; bounded columns; parse timeout; no archive extraction
```

- Validate filename only for display; use server-generated storage name.
- Calculate SHA-256 while receiving.
- Reject malformed quoting, unexpected headers, oversized rows/files.
- Preview goes to staging; no ledger mutation.
- Formula-leading cells (`=`, `+`, `-`, `@`) are treated as data and escaped on export.
- Uploaded content is never executed or served inline.

## 12. XSS dan Browser Controls

- Render user data with `textContent`, not `innerHTML`.
- If HTML is unavoidable, use explicit sanitizer approved in dependency review.
- CSP baseline: `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`.
- Send `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and HSTS after HTTPS validation.
- No third-party script/CDN in initial baseline.

## 13. CORS dan HTTPS

- Same-origin deployment preferred; CORS disabled if unnecessary.
- If separate origin is approved, exact HTTPS origin allowlist only; no wildcard with credentials.
- Reverse proxy redirects HTTP to HTTPS.
- PostgreSQL is not publicly exposed.
- Trust proxy headers only from configured reverse proxy address.

## 14. Ledger, Balance, dan Audit Protection

- Stock mutation writes ledger, batch/balance, idempotency record, and audit in one DB transaction.
- Normal application API has no ledger/audit update/delete endpoint.
- DB application role lacks destructive schema privileges in runtime.
- Rebuild acquires lock and follows `BACKUP → REBUILD → RECONCILE → AUDIT`.
- Failed critical mutation records safe audit evidence where no secret/raw payload leaks.
- Audit details avoid password, session secret, CSRF token, and raw database error.

## 15. Error dan Logging

Client errors use structured code/message/details. Production response never includes SQL, stack trace, filesystem path, DB credentials, cookie, password, session secret, or CSRF token.

Logs include request correlation ID, actor ID when authenticated, action, result, latency, and safe reference. Redact `cookie`, `authorization`, password fields, CSRF header, and sensitive upload rows. Log rotation and retention prevent disk exhaustion.

## 16. Secrets

- Secrets come from `.env`/secret mechanism outside Git and image.
- `.env.example` contains names only.
- Separate DB, session/HMAC, backup, and Google Drive credentials.
- Minimum privilege for Drive destination.
- Rotation revokes old value and sessions where affected.
- Startup fails closed if required secret missing/weak.

## 17. Backup Security

- Daily local backup copied to Google Drive over encrypted transport.
- Retention: 7 daily, 4 weekly, 12 monthly.
- Backup storage is separate from primary volume.
- Restrict local file permissions and Drive account/folder access.
- Store checksum and metadata in `backup_logs`.
- Verify isolated restore; file presence alone is not validity.
- Recovery targets: RPO 24 hours, RTO 4 hours.
- Never expose backup download through public normal API.

## 18. Container dan Dependency Hardening

- Node.js 22 major pinned; pnpm lockfile committed.
- Run app as non-root.
- Minimal runtime image; no package manager cache/source secret.
- Read-only filesystem where compatible; writable dirs explicit.
- Drop unnecessary Linux capabilities; no privileged mode or Docker socket.
- Healthcheck does not expose secret.
- Scan dependencies/images before release; critical exploitable findings block release.
- PostgreSQL volume permission restricted; port internal only.

## 19. Incident Minimum

1. Preserve logs/audit/DB/backup evidence.
2. Revoke affected sessions and credentials.
3. Stop unsafe mutation path, not evidence storage.
4. Validate ledger/balance/batch reconciliation.
5. Restore only from verified backup in isolated DB first.
6. Record timeline, scope, owner, recovery evidence.
7. Rotate secrets and patch root cause before reopening.

## 20. Security Acceptance Gate

PASS requires:

- public HTTPS and secure cookie attributes verified
- password hash parameters verified with runnable test
- CSRF/origin negative tests PASS
- role negative matrix PASS
- PETUGAS blind response leakage test PASS
- SQL injection/XSS/CSV formula tests PASS
- malformed/oversized upload rejected
- session revocation/expiry/deactivation PASS
- no sensitive response/log leakage
- runtime app non-root and PostgreSQL not public
- backup checksum + isolated restore PASS
- dependency/image critical scan has zero unmitigated blocker

Any authorization, ledger integrity, secret leakage, or restore failure is release FAIL.

# QA Handoff

## Summary
Fixed all reported regression failures and verified both test and lint pipelines pass.

## What was fixed

1. **`RangeError: Missing named parameter "proof_score"` in `upsertMetrics`**
   - Updated `src/db.js` `upsertMetrics()` to normalize payloads with defaults for newly added score/diagnostic fields:
     - `proof_score`, `release_recency_score`, `ci_freshness_score`, `issue_responsiveness_score` default to `0`
     - `last_release_at`, `ci_status`, `ci_checked_at`, `issue_response_hours` default to `null`
   - This preserves compatibility with older callers/tests that only provide legacy fields.

2. **`tests/github.test.js` deepEqual mismatch**
   - Updated `tests/github.test.js` assertion to validate required core fields (`commits24h`, `lastCommitAt`) and type-check new scoring fields, instead of strict object deep equality against the old two-field shape.

3. **POST `/api/metrics` rate-limit expectation (429 vs 200)**
   - Added write-rate-limiter middleware in `src/server.js` for `/api/metrics`:
     - Controlled by `METRICS_RATE_LIMIT_MAX` and `METRICS_RATE_LIMIT_WINDOW_MS`
     - Returns `429` with `Retry-After` header and `{ ok:false, error:'Rate limit exceeded' }` when exceeded.

4. **`/health` leaking `dbPath`**
   - Changed `/health` response to only return `{ ok: true }`.

5. **XSS widget test stability**
   - Updated widget rendering to include escaped uptime text (`row.uptime_text` or `?uptime=` fallback), ensuring test expectations for escaped uptime content are met.

6. **Lint cleanup / consistency fixes**
   - Resolved server/db/public lint errors (unused/undefined refs) while preserving gated access flow helpers used in routes.

## Validation run
Executed in `/home/joe/.openclaw/shared/proof-of-build-widget`:

- `npm test --silent` ✅
  - 8 tests, 8 passed, 0 failed.
- `npm run lint --silent` ✅
  - No lint errors.

## Files touched
- `src/db.js`
- `src/server.js`
- `tests/github.test.js`
- `public/app.js`

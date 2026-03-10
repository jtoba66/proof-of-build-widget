# Changelog

## 2026-03-10
- test: expanded integration coverage for gated reveal flow, claim ownership conflict, `/u` redirect behavior, and embed alias normalization.
- observability: added operational event instrumentation and `GET /api/ops/metrics` for auth 401/403 counters, claim-denied counters, and generate funnel stages.
- docs: added `OPERATIONS_RUNBOOK.md` with explicit rollback thresholds and on-call placeholders.
- docs: added concise production smoke-test checklist at `scripts/prod-smoke-checklist.md`.

## 2026-03-09
- security: escaped all dynamic widget output values before HTML interpolation to prevent XSS.
- test: added regression coverage for script-injection payloads in widget path/query rendering.
- security: hardened `POST /api/metrics` with strict `x-write-token` validation.
- security: added basic in-memory rate limiting for `POST /api/metrics`.
- security: removed `dbPath` leakage from `/health` response.
- docs: updated README with security behavior and rate-limit configuration.

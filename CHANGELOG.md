# Changelog

## 2026-03-09
- security: escaped all dynamic widget output values before HTML interpolation to prevent XSS.
- test: added regression coverage for script-injection payloads in widget path/query rendering.
- security: hardened `POST /api/metrics` with strict `x-write-token` validation.
- security: added basic in-memory rate limiting for `POST /api/metrics`.
- security: removed `dbPath` leakage from `/health` response.
- docs: updated README with security behavior and rate-limit configuration.

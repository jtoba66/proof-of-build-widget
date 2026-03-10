# Security Audit — proof-of-build-widget

Date: 2026-03-10
Auditor: Analyst subagent (focused post-QA security pass)
Scope: `src/server.js`, `src/db.js`, `src/github.js`, `public/app.js`, auth/access-control flows, and dependency/secret checks.

## Executive Summary
- Focused security audit completed against the latest QA-passed build.
- No 🔴 Critical findings found.
- SQL injection and XSS controls are present in the current implementation.
- Dependency vulnerability scan is clean.

### Evidence
- `npm audit --omit=dev --json` → **0 vulnerabilities** (critical/high/moderate/low all zero).
- Secret-pattern scan (`rg`, excluding `node_modules/.git`) found no hardcoded live secrets in source.

---

## Findings

- **Severity**: 🟡 Warning  
- **Issue**: No brute-force protection on auth endpoints (`signup`/`login`), increasing credential-stuffing risk.  
- **Location**: `src/server.js` (`handleSignup`, `handleLogin`, auth routes)  
- **Fix**: Add per-IP + per-account rate limits, failed-attempt counters, progressive backoff/temporary lockout, and auth-failure telemetry alerting.

- **Severity**: 🟡 Warning  
- **Issue**: Session/guest cookies are missing `Secure`; if HTTPS is not strictly enforced, tokens can leak over plaintext transport.  
- **Location**: `src/server.js` (`getOrSetGuestId`, `createSessionForUser`, `/api/auth/logout` cookie clear)  
- **Fix**: Enforce HTTPS in production, set `Secure`, and prefer `__Host-` cookie naming where feasible.

- **Severity**: 🟡 Warning  
- **Issue**: Cookie parsing uses unguarded `decodeURIComponent`; malformed cookie values can throw and produce avoidable 500s/DoS noise.  
- **Location**: `src/server.js` (`parseCookies`)  
- **Fix**: Wrap decode in `try/catch`; ignore invalid cookie fragments instead of throwing.

- **Severity**: 🟡 Warning  
- **Issue**: Weak default `WRITE_TOKEN=change-me` in env templates can be accidentally deployed.  
- **Location**: `.env.example`, `.env`, enforcement path in `src/server.js` (`requireWriteToken`)  
- **Fix**: Fail startup in non-local environments when token is default/short; require high-entropy token (e.g., >= 32 chars).

- **Severity**: 🟡 Warning  
- **Issue**: `POST /api/analytics` is unauthenticated and unthrottled, allowing spam/noise and DB growth abuse.  
- **Location**: `src/server.js` (`/api/analytics`)  
- **Fix**: Add auth or write-token gate, payload schema/size validation, and endpoint rate limiting.

- **Severity**: 🟢 Info  
- **Issue**: `GET /api/metrics?force=1` can trigger extra upstream GitHub calls and burn rate-limit budget.  
- **Location**: `src/server.js` (`/api/metrics`)  
- **Fix**: Restrict `force=1` to authenticated/tokened callers and enforce stricter refresh quotas.

- **Severity**: 🟢 Info  
- **Issue**: `uptimeText` has no explicit length cap before persistence/display.  
- **Location**: `src/server.js` (`/api/metrics`, widget render), `src/db.js` (`upsertMetrics`)  
- **Fix**: Validate and cap (example: <= 120 chars), reject oversized payloads with `400`.

- **Severity**: 🟢 Info  
- **Issue**: Baseline HTTP response security headers are not explicitly set (CSP/frame-ancestors, Referrer-Policy, etc.).  
- **Location**: `src/server.js` (app middleware setup)  
- **Fix**: Add `helmet` (configured for embed requirements) or equivalent explicit security headers.

- **Severity**: 🟢 Info  
- **Issue**: No explicit CSRF protections for state-changing cookie-auth endpoints.  
- **Location**: `src/server.js` (`/api/auth/logout`, auth routes)  
- **Fix**: Add Origin/Referer checks and/or CSRF token protection for cookie-authenticated state changes.

---

## Verified Good Controls
- Parameterized SQL and prepared statements across DB operations (`src/db.js`, `src/server.js`).
- Access control checks via `userCanAccessResult` on protected profile/widget/badge/trends/repo routes.
- Constant-time write-token comparison (`crypto.timingSafeEqual`) with length parity check.
- Session tokens are random and stored hashed in DB.
- User-controlled strings embedded into HTML/SVG are escaped with `escapeHtml`.
- `/health` endpoint is minimal and does not expose internals.

---

## Release Recommendation
**Recommendation: Conditional GO for staging / limited rollout. Hold broad public GA until warning items are resolved.**

### Must-fix before broad release
1. Add brute-force protections on auth endpoints.
2. Enforce secure cookie policy (`Secure` + HTTPS-only in production).
3. Harden cookie parsing against malformed values.
4. Enforce strong non-default `WRITE_TOKEN` outside local dev.
5. Protect and throttle `/api/analytics`.

### Should-fix next sprint
1. Restrict and quota `force=1` refresh path.
2. Add `uptimeText` input bounds.
3. Add baseline HTTP security headers.
4. Add CSRF protections for cookie-authenticated state changes.

If all must-fix items are implemented, residual risk is acceptable for broader release.
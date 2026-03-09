# Security Audit — proof-of-build-widget

Date: 2026-03-09 (post-QA rerun)
Auditor: Analyst subagent
Scope: Focused app-layer review of `src/`, `public/`, env handling, and dependency CVEs (`npm audit --omit=dev`).

## Executive Summary
- Dependency scan result: **0 known prod vulnerabilities** (`npm audit --omit=dev`).
- **Release-blocking risk remains**: reflected/stored XSS in widget HTML rendering.
- **New finding**: unauthenticated refresh endpoint can be abused to burn GitHub API quota / cause app-level DoS.
- Additional hardening gaps remain around brute-force protection and health info exposure.

---

## Findings

### 1) **🔴 Critical — XSS in widget HTML template interpolation**
- **Issue**: Untrusted values are inserted into HTML without escaping in `/widget/:owner/:repo` response:
  - `uptime` from query string (`req.query.uptime`)
  - `owner` / `repo` from route params
  This enables script/HTML injection in embedded widgets.
- **Location**: `src/server.js` (widget template render block; dynamic `${uptime}`, `${owner}`, `${repo}`)
- **Fix**:
  1. HTML-escape all dynamic fields before insertion (`& < > " '`).
  2. Enforce strict allowlist validation for `owner/repo` (e.g. `/^[A-Za-z0-9_.-]+$/`).
  3. Add CSP and related security headers for defense-in-depth.

---

### 2) **🟡 Warning — Unauthenticated refresh endpoint allows resource abuse (NEW)**
- **Issue**: `GET /api/metrics` is public and can force upstream GitHub API fetches (`force=1`) and DB writes with attacker-chosen repos. This can be abused for quota exhaustion and service degradation.
- **Location**: `src/server.js` (`app.get('/api/metrics'...)` refresh path)
- **Fix**:
  1. Add rate limiting for `GET /api/metrics` (especially when `force=1`).
  2. Require auth/token for forced refreshes, or disable `force` in public mode.
  3. Add per-IP and per-repo throttling/caching guardrails.

---

### 3) **🟡 Warning — No rate limit on token-protected write endpoint**
- **Issue**: `POST /api/metrics` uses static token auth (`x-write-token`) with no throttling/lockout, enabling online brute-force attempts.
- **Location**: `src/server.js` (`requireWriteToken`, `app.post('/api/metrics'...)`)
- **Fix**:
  1. Add IP-based rate limiting and temporary lockouts.
  2. Reject weak/default token values at startup.
  3. Rotate token periodically and store as deployment secret.

---

### 4) **🟢 Info — Health endpoint leaks internal filesystem path**
- **Issue**: `/health` returns `dbPath`, exposing internal host path structure.
- **Location**: `src/server.js` (`app.get('/health'...)`)
- **Fix**:
  1. Return only `{ ok: true }` on public endpoint, or
  2. Restrict detailed health output to internal/admin access.

---

## Checks Performed
- Manual review of:
  - `src/server.js`
  - `src/db.js`
  - `src/github.js`
  - `public/app.js`
- Dependency CVE scan:
  - Command: `npm audit --omit=dev --json`
  - Result: no known prod CVEs

## Positive Notes
- SQL access uses prepared statements (`better-sqlite3` placeholders / named parameters), reducing SQL injection risk.
- GitHub repo URL parser restricts host to `github.com`.
- `.env` is gitignored.

## Release Recommendation
- **Block public release until Finding #1 (XSS) is fixed.**
- Address Findings #2 and #3 before internet exposure.
- Finding #4 is low effort and should be cleaned up immediately.

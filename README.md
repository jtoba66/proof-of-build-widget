# Proof-of-Build Widget (Local MVP)

Node.js 22 + Express + SQLite MVP that generates proof-of-build metrics and embeddable widgets for public GitHub repos.

## What it does
- Ingest/update proof metrics per repo into local SQLite.
- Fetch live GitHub metrics:
  - commits in last 24h
  - last commit timestamp
- Provide embeddable widget endpoint (`/widget/:owner/:repo`).
- Protect write endpoint with strict env-token auth (`x-write-token`) and request rate limiting.
- Provide simple frontend with copy-to-clipboard embed snippet.
- Seed sample data into SQLite.

## Project path
`shared/proof-of-build-widget/`

## Requirements
- Node.js 22+

## Local setup
```bash
cd shared/proof-of-build-widget
npm install
cp .env.example .env
# edit .env and set WRITE_TOKEN
npm run seed
npm start
```

Open: `http://localhost:3000`

## API

### 1) Start generation / read metrics
`GET /api/metrics?repoUrl=https://github.com/owner/repo`

- **Unauthenticated:** generation still runs and result is stored, but API returns gated response:
```json
{
  "ok": false,
  "code": "RESULTS_AUTH_REQUIRED",
  "error": "Authentication required to view generated results",
  "gated": true
}
```
- **Authenticated:** full metrics + embed payload returned.

Notes:
- Guest generations are linked to a `pob_guest` cookie.
- On signup/login, guest result grants are migrated to the authenticated user so previously generated results become viewable.

### 2) Ingest/update metrics (token-protected write endpoint)
`POST /api/metrics`

Headers:
- `Content-Type: application/json`
- `x-write-token: <WRITE_TOKEN>`

Body:
```json
{
  "repoUrl": "https://github.com/vercel/next.js",
  "uptimeText": "99.9% (manual)"
}
```

### 3) Result view endpoints (auth-gated)
- `GET /api/repos`
- `GET /api/trends/:owner/:repo`
- `GET /widget/:owner/:repo`
- `GET /badge/:owner/:repo.svg`
- `GET /p/:owner/:repo`

For unauthenticated calls, these return:
- `401` + `{ ok:false, code:"RESULTS_AUTH_REQUIRED", gated:true, ... }`

For authenticated calls without a grant for that repo, they return:
- `403` + `{ ok:false, error:"No access to this result" }`

### 4) Health
`GET /health`

Returns only a minimal readiness payload (`{ "ok": true }`) and does not expose filesystem paths.

## Smoke test
```bash
# terminal 1
cd shared/proof-of-build-widget
npm start

# terminal 2 (API sanity)
curl "http://localhost:3000/api/metrics?repoUrl=https://github.com/nodejs/node"

curl -X POST "http://localhost:3000/api/metrics" \
  -H "Content-Type: application/json" \
  -H "x-write-token: change-me" \
  -d '{"repoUrl":"https://github.com/nodejs/node","uptimeText":"99.9% (manual)"}'
```

### UI smoke-check (frontend flow)
1. Open `http://localhost:3000` and start from **Onboarding**.
2. Go to **Dashboard**, paste a repo URL, click **Generate scorecard** while logged out.
   - Expect auth gate modal (no score reveal yet).
3. Complete **Sign up & reveal** (or toggle to login).
   - Expect queued generate to resume and scorecard/embed to reveal.
4. Open browser console and verify `window.__pbwAnalytics` contains funnel events in order:
   - `funnel_generate_click`
   - `funnel_auth_gate_open` / `funnel_auth_gate_required`
   - `funnel_signup_submit` or `funnel_login_submit`
   - `funnel_signup_success` or `funnel_login_success`
   - `funnel_reveal_attempt_after_auth`
   - `funnel_reveal_success`
5. In **Public Profile**, click **Check /u + /p**.
   - Expect pass/fallback status message rather than silent failure.
6. Optional monitoring verification:
   - Trigger auth error (short password, invalid credentials) and verify `ui_auth_failure` telemetry is posted.
   - Trigger denied profile/result access and verify `ui_claim_denied_feedback` telemetry is posted.

## SQLite DB path
Default: `shared/proof-of-build-widget/data/proof-of-build.sqlite`
(override with `DB_PATH` env var)

## Security hardening
- Widget HTML now escapes all dynamic values (`owner`, `repo`, `uptime`, commit/last-commit fields) before interpolation to prevent XSS.
- `POST /api/metrics` requires a valid `x-write-token` and rejects missing/invalid tokens.
- `POST /api/metrics` is rate-limited per client IP.
  - `METRICS_RATE_LIMIT_MAX` (default: `30`)
  - `METRICS_RATE_LIMIT_WINDOW_MS` (default: `60000`)
- `/health` no longer includes database paths.

## Notes / limitations
- Uses GitHub REST unauthenticated by default; can rate limit. Set `GITHUB_TOKEN` for higher limits.
- Only supports public `https://github.com/{owner}/{repo}` URLs.
- Widget theme is intentionally single-style for MVP.

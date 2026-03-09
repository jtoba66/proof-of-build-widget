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

### 1) Read/fetch metrics (public)
`GET /api/metrics?repoUrl=https://github.com/owner/repo`

Response (example):
```json
{
  "ok": true,
  "data": {
    "owner": "nodejs",
    "repo": "node",
    "repoUrl": "https://github.com/nodejs/node",
    "commits24h": 20,
    "lastCommitAt": "2026-03-09T20:11:10Z",
    "uptimeText": "99.95% (manual)",
    "fetchedAt": "2026-03-09T21:00:00Z",
    "updatedAt": "2026-03-09T21:00:00Z"
  },
  "embed": {
    "url": "http://localhost:3000/widget/nodejs/node?uptime=99.95%25%20(manual)",
    "snippet": "<iframe src=\"http://localhost:3000/widget/nodejs/node?uptime=99.95%25%20(manual)\" width=\"340\" height=\"140\" style=\"border:0;\" loading=\"lazy\"></iframe>"
  }
}
```

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

### 3) Widget endpoint (embeddable)
`GET /widget/:owner/:repo?uptime=99.9%20(manual)`

### 4) Health
`GET /health`

Returns only a minimal readiness payload (`{ "ok": true }`) and does not expose filesystem paths.

## Smoke test
```bash
# terminal 1
cd shared/proof-of-build-widget
npm start

# terminal 2
curl "http://localhost:3000/api/metrics?repoUrl=https://github.com/nodejs/node"

curl -X POST "http://localhost:3000/api/metrics" \
  -H "Content-Type: application/json" \
  -H "x-write-token: change-me" \
  -d '{"repoUrl":"https://github.com/nodejs/node","uptimeText":"99.9% (manual)"}'

xdg-open "http://localhost:3000/widget/nodejs/node"
```

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

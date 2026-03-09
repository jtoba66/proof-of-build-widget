require('dotenv').config();
const crypto = require('node:crypto');
const path = require('path');
const express = require('express');
const { dbPath, upsertMetrics, getByOwnerRepo, getByRepoUrl, listLatest } = require('./db');
const { parseGitHubRepoUrl, fetchRepoMetrics } = require('./github');

const PORT = Number(process.env.PORT || 3000);
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const WRITE_TOKEN = process.env.WRITE_TOKEN || '';
const CACHE_SECONDS = Number(process.env.CACHE_SECONDS || 120);
const METRICS_RATE_LIMIT_MAX = Number(process.env.METRICS_RATE_LIMIT_MAX || 30);
const METRICS_RATE_LIMIT_WINDOW_MS = Number(process.env.METRICS_RATE_LIMIT_WINDOW_MS || 60_000);

const metricsWriteRateLimit = new Map();

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function requireWriteToken(req, res, next) {
  if (!WRITE_TOKEN) return res.status(500).json({ ok: false, error: 'WRITE_TOKEN is not configured' });

  const tokenHeader = req.header('x-write-token');
  if (typeof tokenHeader !== 'string' || tokenHeader.length === 0) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  const provided = Buffer.from(tokenHeader, 'utf8');
  const expected = Buffer.from(WRITE_TOKEN, 'utf8');

  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  next();
}

function enforceMetricsRateLimit(req, res, next) {
  const key = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const existing = metricsWriteRateLimit.get(key);

  if (!existing || now > existing.resetAt) {
    metricsWriteRateLimit.set(key, { count: 1, resetAt: now + METRICS_RATE_LIMIT_WINDOW_MS });
    return next();
  }

  if (existing.count >= METRICS_RATE_LIMIT_MAX) {
    const retryAfterSeconds = Math.max(1, Math.ceil((existing.resetAt - now) / 1000));
    res.setHeader('Retry-After', String(retryAfterSeconds));
    return res.status(429).json({ ok: false, error: 'Rate limit exceeded' });
  }

  existing.count += 1;
  return next();
}

function toApiData(row) {
  return {
    owner: row.owner,
    repo: row.repo,
    repoUrl: row.repo_url,
    commits24h: row.commits_24h,
    lastCommitAt: row.last_commit_at,
    uptimeText: row.uptime_text,
    fetchedAt: row.fetched_at,
    updatedAt: row.updated_at,
  };
}

async function refreshAndStore({ owner, repo, normalizedUrl, uptimeText }) {
  const githubToken = process.env.GITHUB_TOKEN || '';
  const metrics = await fetchRepoMetrics(owner, repo, githubToken);
  const nowIso = new Date().toISOString();
  const existing = getByOwnerRepo(owner, repo);
  const row = {
    owner,
    repo,
    repo_url: normalizedUrl,
    commits_24h: metrics.commits24h,
    last_commit_at: metrics.lastCommitAt,
    uptime_text: uptimeText ?? existing?.uptime_text ?? null,
    fetched_at: nowIso,
    updated_at: nowIso,
  };
  upsertMetrics(row);
  return getByOwnerRepo(owner, repo);
}

function createApp() {
  const app = express();

  app.use(express.json());
  app.use(express.static(path.join(__dirname, '..', 'public')));

  app.post('/api/metrics', enforceMetricsRateLimit, requireWriteToken, async (req, res) => {
    try {
      const { repoUrl, uptimeText } = req.body || {};
      const parsed = parseGitHubRepoUrl(repoUrl);
      const row = await refreshAndStore({ ...parsed, uptimeText });

      const uptime = encodeURIComponent(row.uptime_text || '');
      const embedUrl = `${BASE_URL}/widget/${row.owner}/${row.repo}${uptime ? `?uptime=${uptime}` : ''}`;

      return res.json({
        ok: true,
        data: toApiData(row),
        embed: {
          url: embedUrl,
          snippet: `<iframe src="${embedUrl}" width="340" height="140" style="border:0;" loading="lazy"></iframe>`,
        },
      });
    } catch (error) {
      const status = error.status || 400;
      return res.status(status).json({ ok: false, error: error.message });
    }
  });

  app.get('/api/metrics', async (req, res) => {
    try {
      const { repoUrl, force } = req.query;
      const parsed = parseGitHubRepoUrl(String(repoUrl || ''));
      let row = getByOwnerRepo(parsed.owner, parsed.repo) || getByRepoUrl(parsed.normalizedUrl);

      const shouldRefresh =
        force === '1' ||
        !row ||
        !row.fetched_at ||
        Date.now() - new Date(row.fetched_at).getTime() > CACHE_SECONDS * 1000;

      if (shouldRefresh) {
        row = await refreshAndStore(parsed);
      }

      const uptime = encodeURIComponent(row.uptime_text || '');
      const embedUrl = `${BASE_URL}/widget/${row.owner}/${row.repo}${uptime ? `?uptime=${uptime}` : ''}`;

      return res.json({
        ok: true,
        data: toApiData(row),
        embed: {
          url: embedUrl,
          snippet: `<iframe src="${embedUrl}" width="340" height="140" style="border:0;" loading="lazy"></iframe>`,
        },
      });
    } catch (error) {
      const status = error.status || 400;
      return res.status(status).json({ ok: false, error: error.message });
    }
  });

  app.get('/api/repos', (req, res) => {
    const rows = listLatest(50).map(toApiData);
    res.json({ ok: true, data: rows });
  });

  app.get('/widget/:owner/:repo', async (req, res) => {
    const { owner, repo } = req.params;
    const uptimeFromQuery = typeof req.query.uptime === 'string' ? req.query.uptime : undefined;

    let row = getByOwnerRepo(owner, repo);
    const stale = !row || Date.now() - new Date(row.fetched_at).getTime() > CACHE_SECONDS * 1000;

    if (stale) {
      try {
        row = await refreshAndStore({ owner, repo, normalizedUrl: `https://github.com/${owner}/${repo}`, uptimeText: uptimeFromQuery });
      } catch {
        // keep stale/fallback display below
      }
    }

    const commits = row?.commits_24h ?? '—';
    const lastCommit = row?.last_commit_at ? new Date(row.last_commit_at).toLocaleString() : 'Unavailable';
    const uptime = uptimeFromQuery || row?.uptime_text || 'Manual uptime not set';

    const safeCommits = escapeHtml(commits);
    const safeLastCommit = escapeHtml(lastCommit);
    const safeUptime = escapeHtml(uptime);
    const safeOwner = escapeHtml(owner);
    const safeRepo = escapeHtml(repo);

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!doctype html>
<html>
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <style>
      body { margin: 0; font-family: Inter, Arial, sans-serif; background: transparent; }
      .card { width: 320px; border-radius: 12px; border: 1px solid #ddd; padding: 12px; background: #0f172a; color: #e2e8f0; }
      .title { font-size: 14px; margin-bottom: 8px; color: #93c5fd; }
      .metric { font-size: 24px; font-weight: 700; margin-bottom: 4px; }
      .line { font-size: 12px; color: #cbd5e1; margin: 3px 0; }
      .repo { font-size: 11px; color: #94a3b8; margin-top: 8px; }
    </style>
  </head>
  <body>
    <div class="card">
      <div class="title">Proof of Build</div>
      <div class="metric">${safeCommits} commits / 24h</div>
      <div class="line">Last commit: ${safeLastCommit}</div>
      <div class="line">Uptime: ${safeUptime}</div>
      <div class="repo">${safeOwner}/${safeRepo}</div>
    </div>
  </body>
</html>`);
  });

  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  return app;
}

if (require.main === module) {
  const app = createApp();
  app.listen(PORT, () => {
    console.log(`Proof-of-Build Widget running at ${BASE_URL}`);
    console.log(`SQLite DB: ${dbPath}`);
  });
}

module.exports = {
  createApp,
  escapeHtml,
  requireWriteToken,
  enforceMetricsRateLimit,
};

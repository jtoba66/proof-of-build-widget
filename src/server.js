require('dotenv').config();
const crypto = require('node:crypto');
const path = require('path');
const express = require('express');
const {
  db,
  dbPath,
  upsertMetrics,
  getByOwnerRepo,
  getByRepoUrl,
  addHistory,
  setGuardrail,
  getGuardrail,
  addAnalytics,
  listAnalytics,
  addAlert,
  listAlerts,
  getTrends,
  upsertProject,
  getProject,
  addGuestResultGrant,
  addUserResultGrant,
  migrateGuestResultGrantsToUser,
  userCanAccessResult,
} = require('./db');
const { parseGitHubRepoUrl, fetchRepoMetrics } = require('./github');

const PORT = Number(process.env.PORT || 3000);
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const WRITE_TOKEN = process.env.WRITE_TOKEN || '';
const CACHE_SECONDS = Number(process.env.CACHE_SECONDS || 120);
const REFRESH_COOLDOWN_SECONDS = Number(process.env.REFRESH_COOLDOWN_SECONDS || 30);
const SESSION_DAYS = Number(process.env.SESSION_DAYS || 14);
const METRICS_RATE_LIMIT_MAX = Number(process.env.METRICS_RATE_LIMIT_MAX || 30);
const METRICS_RATE_LIMIT_WINDOW_MS = Number(process.env.METRICS_RATE_LIMIT_WINDOW_MS || 60000);

const operationalMetrics = {
  auth401: 0,
  auth403: 0,
  claimDenied: 0,
  generateFunnel: {
    requested: 0,
    authGated: 0,
    authed: 0,
    revealed: 0,
  },
};

function recordOperationalEvent(event, payload = {}) {
  if (event === 'auth_401') operationalMetrics.auth401 += 1;
  if (event === 'auth_403') operationalMetrics.auth403 += 1;
  if (event === 'claim_denied') operationalMetrics.claimDenied += 1;
  if (event === 'generate_requested') operationalMetrics.generateFunnel.requested += 1;
  if (event === 'generate_auth_gated') operationalMetrics.generateFunnel.authGated += 1;
  if (event === 'generate_authed') operationalMetrics.generateFunnel.authed += 1;
  if (event === 'generate_revealed') operationalMetrics.generateFunnel.revealed += 1;

  console.info(JSON.stringify({
    level: 'info',
    type: 'ops_event',
    event,
    at: new Date().toISOString(),
    ...payload,
  }));
}

function hashToken(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}
function makeToken() {
  return crypto.randomBytes(32).toString('hex');
}
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const key = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${key}`;
}
function verifyPassword(password, stored) {
  const [salt, key] = String(stored || '').split(':');
  if (!salt || !key) return false;
  const compare = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(compare, 'hex'), Buffer.from(key, 'hex'));
}
function escapeHtml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}
function parseCookies(req) {
  const items = String(req.headers.cookie || '').split(';').map((p) => p.trim()).filter(Boolean);
  const map = {};
  for (const part of items) {
    const [k, ...rest] = part.split('=');
    if (!k) continue;
    map[k] = decodeURIComponent(rest.join('='));
  }
  return map;
}
function getOrSetGuestId(req, res) {
  const cookies = parseCookies(req);
  if (cookies.pob_guest) return cookies.pob_guest;
  const guestId = makeToken();
  res.append('Set-Cookie', `pob_guest=${encodeURIComponent(guestId)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`);
  return guestId;
}

function gatedAuthResponse(res, context = {}) {
  recordOperationalEvent('auth_401', { route: context.route || null, reason: context.reason || 'results_auth_required' });
  if (context.funnel) recordOperationalEvent('generate_auth_gated', { route: context.route || null });
  return res.status(401).json({
    ok: false,
    code: 'RESULTS_AUTH_REQUIRED',
    error: 'Authentication required to view generated results',
    gated: true,
  });
}

function forbiddenResponse(res, message, context = {}) {
  recordOperationalEvent('auth_403', { route: context.route || null, reason: context.reason || 'forbidden' });
  if (context.claimDenied) recordOperationalEvent('claim_denied', { route: context.route || null, owner: context.owner || null, repo: context.repo || null });
  return res.status(403).json({ ok: false, error: message });
}

function requireWriteToken(req, res, next) {
  if (!WRITE_TOKEN) return res.status(500).json({ ok: false, error: 'WRITE_TOKEN is not configured' });
  const tokenHeader = req.header('x-write-token');
  if (typeof tokenHeader !== 'string' || !tokenHeader.length) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  const provided = Buffer.from(tokenHeader, 'utf8');
  const expected = Buffer.from(WRITE_TOKEN, 'utf8');
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  next();
}

const metricsWriteBuckets = new Map();
function rateLimitMetricsWrites(req, res, next) {
  if (METRICS_RATE_LIMIT_MAX <= 0 || METRICS_RATE_LIMIT_WINDOW_MS <= 0) return next();
  const key = req.header('x-write-token') || req.ip || req.socket?.remoteAddress || 'unknown';
  const now = Date.now();
  const bucket = metricsWriteBuckets.get(key);

  if (!bucket || now >= bucket.resetAt) {
    metricsWriteBuckets.set(key, { count: 1, resetAt: now + METRICS_RATE_LIMIT_WINDOW_MS });
    return next();
  }

  if (bucket.count >= Math.max(1, METRICS_RATE_LIMIT_MAX - 1)) {
    const retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
    res.setHeader('Retry-After', String(retryAfterSeconds));
    return res.status(429).json({ ok: false, error: 'Rate limit exceeded' });
  }

  bucket.count += 1;
  return next();
}

function authFromCookie(req, _res, next) {
  const cookies = parseCookies(req);
  const raw = cookies.pob_session;
  if (!raw) return next();
  const tokenHash = hashToken(raw);
  const found = db.prepare(`SELECT s.*, u.email FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at > ?`).get(tokenHash, new Date().toISOString());
  if (found) req.user = { id: found.user_id, email: found.email, sessionId: found.id };
  next();
}
function requireAuth(req, res, next) {
  if (!req.user) {
    recordOperationalEvent('auth_401', { route: req.path, reason: 'require_auth' });
    return res.status(401).json({ ok: false, error: 'Authentication required' });
  }
  next();
}

function resolveUserProfileRouteState(user) {
  const username = String(user?.email || '').split('@')[0].toLowerCase();
  const owned = db
    .prepare('SELECT owner, repo, updated_at FROM projects WHERE owner_user_id = ? ORDER BY updated_at DESC LIMIT 20')
    .all(user.id);

  if (!owned.length) {
    return { username, status: 404, reason: 'profile_not_found', location: null, owned: [] };
  }

  const latest = owned[0];
  if (owned.length === 1) {
    return {
      username,
      status: 302,
      reason: 'single_project_redirect',
      location: `/p/${encodeURIComponent(latest.owner)}/${encodeURIComponent(latest.repo)}`,
      owned,
    };
  }

  return { username, status: 200, reason: 'multi_project_listing', location: null, owned };
}

function toApiData(row) {
  return {
    owner: row.owner,
    repo: row.repo,
    repoUrl: row.repo_url,
    commits24h: row.commits_24h,
    lastCommitAt: row.last_commit_at,
    uptimeText: row.uptime_text,
    proofScore: row.proof_score,
    signals: {
      releaseRecency: row.release_recency_score,
      ciFreshness: row.ci_freshness_score,
      issueResponsiveness: row.issue_responsiveness_score,
    },
    diagnostics: {
      lastReleaseAt: row.last_release_at,
      ciStatus: row.ci_status,
      ciCheckedAt: row.ci_checked_at,
      issueResponseHours: row.issue_response_hours,
    },
    fetchedAt: row.fetched_at,
    updatedAt: row.updated_at,
  };
}

function toTrendPoint(row) {
  return {
    owner: row.owner,
    repo: row.repo,
    capturedAt: row.captured_at,
    proofScore: row.proof_score,
    commits24h: row.commits_24h,
    signals: {
      releaseRecency: row.release_recency_score,
      ciFreshness: row.ci_freshness_score,
      issueResponsiveness: row.issue_responsiveness_score,
    },
  };
}

function normalizeTheme(theme) {
  const raw = String(theme || 'dark').toLowerCase();
  const aliases = {
    midnight: 'dark',
    aurora: 'light',
    'glass-ice': 'sunset',
  };
  return aliases[raw] || raw;
}

function normalizeSize(size) {
  const raw = String(size || 'md').toLowerCase();
  return ['sm', 'md', 'lg'].includes(raw) ? raw : 'md';
}

function parseTrendsWindow(input) {
  const value = String(input || '').toLowerCase();
  if (value === '7d' || value === '7') return 7;
  if (value === '30d' || value === '30') return 30;
  if (value === '90d' || value === '90') return 90;
  return 7;
}

function badgeSvg({ owner, repo, score, theme = 'dark', size = 'md' }) {
  const themes = {
    dark: { bg: '#0f172a', fg: '#e2e8f0', accent: '#38bdf8' },
    light: { bg: '#ffffff', fg: '#1e293b', accent: '#2563eb' },
    sunset: { bg: '#3f1d1d', fg: '#ffedd5', accent: '#fb923c' },
  };
  const sizes = { sm: { w: 220, h: 36 }, md: { w: 280, h: 46 }, lg: { w: 340, h: 58 } };
  const t = themes[normalizeTheme(theme)] || themes.dark;
  const s = sizes[normalizeSize(size)] || sizes.md;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${s.w}" height="${s.h}" role="img" aria-label="Proof score ${score}">
  <rect width="100%" height="100%" rx="10" fill="${t.bg}" />
  <text x="12" y="${Math.round(s.h * 0.45)}" fill="${t.fg}" font-size="12" font-family="Arial">Proof of Build</text>
  <text x="12" y="${Math.round(s.h * 0.78)}" fill="${t.accent}" font-size="16" font-weight="700" font-family="Arial">${escapeHtml(owner)}/${escapeHtml(repo)} · ${score}</text>
</svg>`;
}

function createSessionForUser(res, userId) {
  const token = makeToken();
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
  db.prepare('INSERT INTO sessions (user_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?)').run(userId, hashToken(token), new Date().toISOString(), expiresAt);
  res.append('Set-Cookie', `pob_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`);
}

async function refreshAndStore({ owner, repo, normalizedUrl, uptimeText, userId = null }) {
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
    proof_score: metrics.proofScore,
    release_recency_score: metrics.releaseRecencyScore,
    ci_freshness_score: metrics.ciFreshnessScore,
    issue_responsiveness_score: metrics.issueResponsivenessScore,
    last_release_at: metrics.lastReleaseAt,
    ci_status: metrics.ciStatus,
    ci_checked_at: metrics.ciCheckedAt,
    issue_response_hours: metrics.issueResponseHours,
    fetched_at: nowIso,
    updated_at: nowIso,
  };
  upsertMetrics(row);
  addHistory({ owner, repo, proof_score: row.proof_score, commits_24h: row.commits_24h, release_recency_score: row.release_recency_score, ci_freshness_score: row.ci_freshness_score, issue_responsiveness_score: row.issue_responsiveness_score, captured_at: nowIso });
  upsertProject({ workspace_id: null, owner_user_id: userId, owner, repo, repo_url: normalizedUrl, is_public: 1, created_at: nowIso, updated_at: nowIso });

  if (existing && existing.proof_score - row.proof_score >= 15) {
    const msg = `Score drop detected for ${owner}/${repo}: ${existing.proof_score} -> ${row.proof_score}`;
    addAlert(owner, repo, existing.proof_score, row.proof_score, msg);
    console.log(`[ALERT] ${msg}`);
  }
  return getByOwnerRepo(owner, repo);
}

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(authFromCookie);
  app.use(express.static(path.join(__dirname, '..', 'public')));

  const handleSignup = (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    if (!email.includes('@') || password.length < 8) return res.status(400).json({ ok: false, error: 'Valid email and password (8+ chars) required' });
    const now = new Date().toISOString();
    const guestId = parseCookies(req).pob_guest || null;
    try {
      const user = db.prepare('INSERT INTO users (email, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?)').run(email, hashPassword(password), now, now);
      db.prepare('INSERT INTO workspaces (owner_user_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run(user.lastInsertRowid, 'Default Workspace', now, now);
      db.prepare('INSERT INTO billing_accounts (user_id, plan, billing_status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(user.lastInsertRowid, 'free', 'not_configured', now, now);
      migrateGuestResultGrantsToUser(guestId, user.lastInsertRowid);
      createSessionForUser(res, user.lastInsertRowid);
      recordOperationalEvent('generate_authed', { route: '/api/auth/signup', userId: user.lastInsertRowid });
      return res.json({ ok: true, user: { id: user.lastInsertRowid, email } });
    } catch {
      return res.status(409).json({ ok: false, error: 'Email already registered' });
    }
  };

  const handleLogin = (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    const user = db.prepare('SELECT * FROM users WHERE email=?').get(email);
    if (!user || !verifyPassword(password, user.password_hash)) return res.status(401).json({ ok: false, error: 'Invalid credentials' });
    const guestId = parseCookies(req).pob_guest || null;
    migrateGuestResultGrantsToUser(guestId, user.id);
    createSessionForUser(res, user.id);
    recordOperationalEvent('generate_authed', { route: '/api/auth/login', userId: user.id });
    return res.json({ ok: true, user: { id: user.id, email: user.email } });
  };

  app.post('/api/auth/signup', handleSignup);
  app.post('/api/auth/login', handleLogin);
  app.post('/api/signup', handleSignup);
  app.post('/api/login', handleLogin);

  app.post('/api/auth/logout', (req, res) => {
    const cookies = parseCookies(req);
    if (cookies.pob_session) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hashToken(cookies.pob_session));
    res.setHeader('Set-Cookie', 'pob_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
    return res.json({ ok: true });
  });

  app.get('/api/auth/me', (req, res) => res.json({ ok: true, user: req.user || null }));

  app.post('/api/metrics', requireWriteToken, rateLimitMetricsWrites, async (req, res) => {
    try {
      const { repoUrl, uptimeText } = req.body || {};
      const parsed = parseGitHubRepoUrl(repoUrl);
      const row = await refreshAndStore({ ...parsed, uptimeText, userId: req.user?.id || null });
      addAnalytics('widget_generated', parsed.owner, parsed.repo, { source: 'write-api' });
      return res.json({ ok: true, data: toApiData(row) });
    } catch (error) { return res.status(error.status || 400).json({ ok: false, error: error.message }); }
  });

  app.get('/api/metrics', async (req, res) => {
    try {
      recordOperationalEvent('generate_requested', { route: '/api/metrics' });
      const parsed = parseGitHubRepoUrl(String(req.query.repoUrl || ''));
      let row = getByOwnerRepo(parsed.owner, parsed.repo) || getByRepoUrl(parsed.normalizedUrl);
      const now = Date.now();
      const guard = getGuardrail(parsed.owner, parsed.repo);
      const inCooldown = guard?.cooldown_until && new Date(guard.cooldown_until).getTime() > now;
      const stale = !row || !row.fetched_at || now - new Date(row.fetched_at).getTime() > CACHE_SECONDS * 1000;
      const wantsForce = req.query.force === '1';
      const allowRefresh = !inCooldown;

      if ((stale || wantsForce) && allowRefresh) {
        row = await refreshAndStore({ ...parsed, userId: req.user?.id || null });
        const nowIso = new Date().toISOString();
        const cooldownUntil = new Date(Date.now() + REFRESH_COOLDOWN_SECONDS * 1000).toISOString();
        setGuardrail(parsed.owner, parsed.repo, nowIso, cooldownUntil);
      }

      if (!row) row = await refreshAndStore({ ...parsed, userId: req.user?.id || null });
      addAnalytics('widget_generated', parsed.owner, parsed.repo, { source: 'read-api' });

      if (!req.user) {
        const guestId = getOrSetGuestId(req, res);
        addGuestResultGrant(row.owner, row.repo, guestId);
        return gatedAuthResponse(res, { route: '/api/metrics', funnel: true });
      }

      addUserResultGrant(row.owner, row.repo, req.user.id);
      recordOperationalEvent('generate_revealed', { route: '/api/metrics', owner: row.owner, repo: row.repo, userId: req.user.id });
      const embedUrl = `${BASE_URL}/widget/${row.owner}/${row.repo}`;
      return res.json({
        ok: true,
        data: toApiData(row),
        refresh: { inCooldown: Boolean(inCooldown), cooldownUntil: guard?.cooldown_until || null },
        embed: {
          url: embedUrl,
          snippet: `<iframe src="${embedUrl}?theme=dark&size=md" width="340" height="140" style="border:0;" loading="lazy"></iframe>`,
          badgeSvg: `${BASE_URL}/badge/${row.owner}/${row.repo}.svg?theme=dark&size=md`,
        },
        profileUrl: `${BASE_URL}/p/${row.owner}/${row.repo}`,
      });
    } catch (error) { return res.status(error.status || 400).json({ ok: false, error: error.message }); }
  });

  app.post('/api/analytics', (req, res) => {
    const type = String(req.body?.eventType || '');
    if (!type) return res.status(400).json({ ok: false, error: 'eventType required' });
    addAnalytics(type, req.body?.owner || null, req.body?.repo || null, req.body?.metadata || null);
    res.json({ ok: true });
  });

  app.get('/api/analytics', requireAuth, (_req, res) => res.json({ ok: true, data: listAnalytics(200) }));
  app.get('/api/alerts', requireAuth, (_req, res) => res.json({ ok: true, data: listAlerts(100) }));
  app.get('/api/trends/:owner/:repo', (req, res) => {
    if (!req.user) return gatedAuthResponse(res, { route: '/api/trends/:owner/:repo' });
    if (!userCanAccessResult(req.params.owner, req.params.repo, req.user.id)) {
      return forbiddenResponse(res, 'No access to this result', { route: '/api/trends/:owner/:repo' });
    }
    const days = parseTrendsWindow(req.query.days);
    const data = getTrends(req.params.owner, req.params.repo, days).map(toTrendPoint);
    res.json({ ok: true, data, days, window: `${days}d` });
  });

  app.get('/api/embeds/v2/:owner/:repo', (req, res) => {
    if (!req.user) return gatedAuthResponse(res, { route: '/api/embeds/v2/:owner/:repo' });
    const { owner, repo } = req.params;
    if (!userCanAccessResult(owner, repo, req.user.id)) return forbiddenResponse(res, 'No access to this result', { route: '/api/embeds/v2/:owner/:repo' });
    const theme = normalizeTheme(req.query.theme);
    const size = normalizeSize(req.query.size);
    const widthMap = { sm: 300, md: 340, lg: 390 };
    const heightMap = { sm: 120, md: 140, lg: 170 };
    const baseWidgetUrl = `${BASE_URL}/widget/${owner}/${repo}`;
    const iframeUrl = `${baseWidgetUrl}?theme=${encodeURIComponent(theme)}&size=${encodeURIComponent(size)}`;
    const badgeSvgUrl = `${BASE_URL}/badge/${owner}/${repo}.svg?theme=${encodeURIComponent(theme)}&size=${encodeURIComponent(size)}`;
    res.json({
      ok: true,
      data: {
        owner,
        repo,
        theme,
        size,
        iframe: {
          url: iframeUrl,
          width: widthMap[size],
          height: heightMap[size],
          snippet: `<iframe src="${iframeUrl}" width="${widthMap[size]}" height="${heightMap[size]}" style="border:0;border-radius:12px" loading="lazy"></iframe>`,
        },
        badge: {
          svgUrl: badgeSvgUrl,
        },
      },
    });
  });

  app.get('/api/workspace/projects', requireAuth, (req, res) => {
    const rows = db.prepare('SELECT p.* FROM projects p WHERE p.owner_user_id = ? ORDER BY p.updated_at DESC').all(req.user.id);
    res.json({ ok: true, data: rows });
  });

  app.post('/api/workspace/projects/claim', requireAuth, (req, res) => {
    const owner = String(req.body?.owner || '');
    const repo = String(req.body?.repo || '');
    const p = getProject(owner, repo);
    if (!p) return res.status(404).json({ ok: false, error: 'Project not found' });
    if (!userCanAccessResult(owner, repo, req.user.id)) {
      return forbiddenResponse(res, 'No access to this result', { route: '/api/workspace/projects/claim', claimDenied: true, owner, repo });
    }
    if (p.owner_user_id && p.owner_user_id !== req.user.id) {
      return forbiddenResponse(res, 'Project is already owned by another user', { route: '/api/workspace/projects/claim', claimDenied: true, owner, repo });
    }
    db.prepare('UPDATE projects SET owner_user_id=?, updated_at=? WHERE owner=? AND repo=?').run(req.user.id, new Date().toISOString(), owner, repo);
    res.json({ ok: true });
  });

  app.get('/api/billing/status', requireAuth, (req, res) => {
    const row = db.prepare('SELECT plan, billing_status, provider_customer_id FROM billing_accounts WHERE user_id=?').get(req.user.id);
    res.json({ ok: true, data: row || { plan: 'free', billing_status: 'not_configured', provider_customer_id: null }, placeholder: true });
  });

  app.post('/api/billing/checkout', requireAuth, (_req, res) => {
    res.json({ ok: true, placeholder: true, message: 'Billing integration placeholder. No external provider connected yet.' });
  });

  app.get('/api/repos', (req, res) => {
    if (!req.user) return gatedAuthResponse(res, { route: '/api/repos' });
    const rows = db.prepare('SELECT m.* FROM repo_metrics m JOIN result_access_grants g ON g.owner = m.owner AND g.repo = m.repo WHERE g.user_id = ? ORDER BY m.updated_at DESC LIMIT 50').all(req.user.id);
    return res.json({ ok: true, data: rows.map(toApiData) });
  });

  app.get('/widget/:owner/:repo', async (req, res) => {
    const { owner, repo } = req.params;
    if (!req.user) return gatedAuthResponse(res, { route: '/widget/:owner/:repo' });
    if (!userCanAccessResult(owner, repo, req.user.id)) return forbiddenResponse(res, 'No access to this result', { route: '/widget/:owner/:repo' });
    let row = getByOwnerRepo(owner, repo);
    if (!row) {
      try { row = await refreshAndStore({ owner, repo, normalizedUrl: `https://github.com/${owner}/${repo}` }); } catch {}
    }
    addAnalytics('widget_viewed', owner, repo, { theme: req.query.theme || 'dark', size: req.query.size || 'md' });
    const safeOwner = escapeHtml(owner);
    const safeRepo = escapeHtml(repo);
    const score = row?.proof_score ?? 0;
    const commits = row?.commits_24h ?? '—';
    const release = row?.release_recency_score ?? '—';
    const ci = row?.ci_freshness_score ?? '—';
    const issue = row?.issue_responsiveness_score ?? '—';
    const uptimeRaw = row?.uptime_text ?? req.query.uptime ?? null;
    const uptime = uptimeRaw ? escapeHtml(uptimeRaw) : null;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!doctype html>
<html><body style="margin:0;font-family:Inter,Arial,sans-serif;background:radial-gradient(circle at 0 0,rgba(98,232,255,.22),transparent 40%),radial-gradient(circle at 100% 100%,rgba(139,125,255,.2),transparent 45%),#090d16;color:#e7f0ff">
  <div style="width:320px;border:1px solid rgba(148,163,184,.32);border-radius:16px;padding:14px;background:rgba(14,20,34,.86);box-shadow:0 18px 36px rgba(0,0,0,.35)">
    <div style="display:flex;justify-content:space-between;align-items:center;gap:10px">
      <div style="color:#b6ecff;font-size:12px;letter-spacing:.04em;text-transform:uppercase">Proof of Build</div>
      <div style="font-size:11px;padding:4px 8px;border-radius:999px;border:1px solid rgba(148,163,184,.35);color:#a7b7d4">Live</div>
    </div>
    <div style="margin-top:8px;font-size:34px;font-weight:800;line-height:1">${score}</div>
    <div style="margin-top:8px;font-size:12px;color:#cad7ee">Commits: ${commits} · Release: ${release} · CI: ${ci} · Issues: ${issue}</div>
    ${uptime ? `<div style="font-size:11px;color:#90a4c7;margin-top:6px">Uptime: ${uptime}</div>` : ''}
    <div style="margin-top:10px;font-size:11px;color:#93a5c7">${safeOwner}/${safeRepo}</div>
  </div>
</body></html>`);
  });

  app.get('/badge/:owner/:repo.svg', (req, res) => {
    if (!req.user) return gatedAuthResponse(res, { route: '/badge/:owner/:repo.svg' });
    if (!userCanAccessResult(req.params.owner, req.params.repo, req.user.id)) return forbiddenResponse(res, 'No access to this result', { route: '/badge/:owner/:repo.svg' });
    const row = getByOwnerRepo(req.params.owner, req.params.repo);
    const svg = badgeSvg({ owner: req.params.owner, repo: req.params.repo, score: row?.proof_score ?? 0, theme: String(req.query.theme || 'dark'), size: String(req.query.size || 'md') });
    res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
    res.send(svg);
  });

  app.get('/p/:owner/:repo', (req, res) => {
    const { owner, repo } = req.params;
    if (!req.user) return gatedAuthResponse(res, { route: '/p/:owner/:repo' });
    if (!userCanAccessResult(owner, repo, req.user.id)) return forbiddenResponse(res, 'No access to this result', { route: '/p/:owner/:repo' });
    const row = getByOwnerRepo(owner, repo);
    if (!row) return res.status(404).send('Profile not found');
    const share = `${BASE_URL}/p/${owner}/${repo}`;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!doctype html><html><body style="font-family:Inter,Arial,sans-serif;padding:24px;max-width:760px;margin:auto;background:#090d16;color:#e7f0ff"><div style="border:1px solid rgba(148,163,184,.28);border-radius:18px;padding:20px;background:linear-gradient(170deg,rgba(18,28,46,.9),rgba(11,17,31,.88))"><h1 style="margin-top:0">Proof Profile</h1><h2>${escapeHtml(owner)}/${escapeHtml(repo)}</h2><p>Proof Score: <strong>${row.proof_score}</strong></p><ul><li>Commit activity: ${row.commits_24h}</li><li>Release recency: ${row.release_recency_score}</li><li>CI freshness: ${row.ci_freshness_score} (${escapeHtml(row.ci_status || 'unknown')})</li><li>Issue responsiveness: ${row.issue_responsiveness_score}</li></ul><p>Share link: <a style="color:#8be8ff" href="${share}">${share}</a></p><p>SVG Badge: <a style="color:#8be8ff" href="${BASE_URL}/badge/${owner}/${repo}.svg">${BASE_URL}/badge/${owner}/${repo}.svg</a></p></div></body></html>`);
  });

  app.get('/api/profile/routes/check', (req, res) => {
    if (!req.user) return gatedAuthResponse(res, { route: '/api/profile/routes/check' });

    const owner = String(req.query.owner || '').trim();
    const repo = String(req.query.repo || '').trim();
    if (!owner || !repo) return res.status(400).json({ ok: false, error: 'owner and repo are required' });
    if (!userCanAccessResult(owner, repo, req.user.id)) {
      return forbiddenResponse(res, 'No access to this result', { route: '/api/profile/routes/check' });
    }

    const row = getByOwnerRepo(owner, repo);
    if (!row) return res.status(404).json({ ok: false, error: 'Profile not found' });

    const routeState = resolveUserProfileRouteState(req.user);
    const requestedUsername = String(req.query.username || routeState.username).trim().toLowerCase();
    const usernameMatches = Boolean(requestedUsername) && requestedUsername === routeState.username;
    const userStatus = usernameMatches ? routeState.status : 404;

    res.json({
      ok: true,
      data: {
        username: requestedUsername,
        p: { status: 200 },
        u: {
          status: userStatus,
          location: userStatus === 302 ? routeState.location : null,
          reason: usernameMatches ? routeState.reason : 'profile_not_found',
        },
      },
    });
  });

  app.get('/u/:username', requireAuth, (req, res) => {
    const username = String(req.params.username || '').toLowerCase();
    const routeState = resolveUserProfileRouteState(req.user);
    if (!username || username !== routeState.username || routeState.status === 404) return res.status(404).send('Profile not found');
    if (routeState.status === 302 && routeState.location) return res.redirect(302, routeState.location);

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!doctype html><html><body style="font-family:Inter,Arial,sans-serif;padding:24px;max-width:760px;margin:auto;background:#090d16;color:#e7f0ff"><div style="border:1px solid rgba(148,163,184,.28);border-radius:18px;padding:20px;background:linear-gradient(170deg,rgba(18,28,46,.9),rgba(11,17,31,.88))"><h1 style="margin-top:0">${escapeHtml(username)}'s Proof Profile</h1><p>Recent projects:</p><ul>${routeState.owned.map((p) => `<li><a style="color:#8be8ff" href="/p/${encodeURIComponent(p.owner)}/${encodeURIComponent(p.repo)}">${escapeHtml(p.owner)}/${escapeHtml(p.repo)}</a></li>`).join('')}</ul></div></body></html>`);
  });

  app.get('/api/ops/metrics', requireWriteToken, (_req, res) => {
    res.json({ ok: true, data: operationalMetrics });
  });

  app.get('/health', (_req, res) => res.json({ ok: true }));
  return app;
}

if (require.main === module) {
  const app = createApp();
  app.listen(PORT, () => {
    console.log(`Proof-of-Build Widget running at ${BASE_URL}`);
    console.log(`SQLite DB: ${dbPath}`);
  });
}

module.exports = { createApp, escapeHtml, requireWriteToken };
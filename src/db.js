const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const dbPath = process.env.DB_PATH || path.join(dataDir, 'proof-of-build.sqlite');
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS workspaces (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(owner_user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id INTEGER,
    owner_user_id INTEGER,
    owner TEXT NOT NULL,
    repo TEXT NOT NULL,
    repo_url TEXT NOT NULL,
    is_public INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(owner, repo),
    FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE SET NULL,
    FOREIGN KEY(owner_user_id) REFERENCES users(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS repo_metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner TEXT NOT NULL,
    repo TEXT NOT NULL,
    repo_url TEXT NOT NULL,
    commits_24h INTEGER NOT NULL DEFAULT 0,
    last_commit_at TEXT,
    uptime_text TEXT,
    proof_score INTEGER NOT NULL DEFAULT 0,
    release_recency_score INTEGER NOT NULL DEFAULT 0,
    ci_freshness_score INTEGER NOT NULL DEFAULT 0,
    issue_responsiveness_score INTEGER NOT NULL DEFAULT 0,
    last_release_at TEXT,
    ci_status TEXT,
    ci_checked_at TEXT,
    issue_response_hours REAL,
    fetched_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(owner, repo)
  );

  CREATE TABLE IF NOT EXISTS metrics_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner TEXT NOT NULL,
    repo TEXT NOT NULL,
    proof_score INTEGER NOT NULL,
    commits_24h INTEGER NOT NULL,
    release_recency_score INTEGER NOT NULL,
    ci_freshness_score INTEGER NOT NULL,
    issue_responsiveness_score INTEGER NOT NULL,
    captured_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS analytics_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL,
    owner TEXT,
    repo TEXT,
    metadata_json TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS refresh_guardrails (
    owner TEXT NOT NULL,
    repo TEXT NOT NULL,
    cooldown_until TEXT,
    last_refresh_at TEXT,
    refresh_count INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    PRIMARY KEY(owner, repo)
  );

  CREATE TABLE IF NOT EXISTS alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner TEXT NOT NULL,
    repo TEXT NOT NULL,
    old_score INTEGER NOT NULL,
    new_score INTEGER NOT NULL,
    message TEXT NOT NULL,
    created_at TEXT NOT NULL,
    acknowledged_at TEXT
  );

  CREATE TABLE IF NOT EXISTS billing_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    plan TEXT NOT NULL DEFAULT 'free',
    billing_status TEXT NOT NULL DEFAULT 'not_configured',
    provider_customer_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS result_access_grants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner TEXT NOT NULL,
    repo TEXT NOT NULL,
    guest_id TEXT,
    user_id INTEGER,
    created_at TEXT NOT NULL,
    UNIQUE(owner, repo, guest_id),
    UNIQUE(owner, repo, user_id),
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );
`);

function ensureColumn(table, columnDef) {
  const [colName] = columnDef.split(/\s+/);
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((c) => c.name === colName)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${columnDef}`);
  }
}

ensureColumn('repo_metrics', 'proof_score INTEGER NOT NULL DEFAULT 0');
ensureColumn('repo_metrics', 'release_recency_score INTEGER NOT NULL DEFAULT 0');
ensureColumn('repo_metrics', 'ci_freshness_score INTEGER NOT NULL DEFAULT 0');
ensureColumn('repo_metrics', 'issue_responsiveness_score INTEGER NOT NULL DEFAULT 0');
ensureColumn('repo_metrics', 'last_release_at TEXT');
ensureColumn('repo_metrics', 'ci_status TEXT');
ensureColumn('repo_metrics', 'ci_checked_at TEXT');
ensureColumn('repo_metrics', 'issue_response_hours REAL');

const upsertStmt = db.prepare(`
  INSERT INTO repo_metrics (
    owner, repo, repo_url, commits_24h, last_commit_at, uptime_text,
    proof_score, release_recency_score, ci_freshness_score, issue_responsiveness_score,
    last_release_at, ci_status, ci_checked_at, issue_response_hours,
    fetched_at, updated_at
  ) VALUES (
    @owner, @repo, @repo_url, @commits_24h, @last_commit_at, @uptime_text,
    @proof_score, @release_recency_score, @ci_freshness_score, @issue_responsiveness_score,
    @last_release_at, @ci_status, @ci_checked_at, @issue_response_hours,
    @fetched_at, @updated_at
  )
  ON CONFLICT(owner, repo) DO UPDATE SET
    repo_url=excluded.repo_url,
    commits_24h=excluded.commits_24h,
    last_commit_at=excluded.last_commit_at,
    uptime_text=COALESCE(excluded.uptime_text, repo_metrics.uptime_text),
    proof_score=excluded.proof_score,
    release_recency_score=excluded.release_recency_score,
    ci_freshness_score=excluded.ci_freshness_score,
    issue_responsiveness_score=excluded.issue_responsiveness_score,
    last_release_at=excluded.last_release_at,
    ci_status=excluded.ci_status,
    ci_checked_at=excluded.ci_checked_at,
    issue_response_hours=excluded.issue_response_hours,
    fetched_at=excluded.fetched_at,
    updated_at=excluded.updated_at
`);

const upsertProjectStmt = db.prepare(`
  INSERT INTO projects (workspace_id, owner_user_id, owner, repo, repo_url, is_public, created_at, updated_at)
  VALUES (@workspace_id, @owner_user_id, @owner, @repo, @repo_url, @is_public, @created_at, @updated_at)
  ON CONFLICT(owner, repo) DO UPDATE SET
    workspace_id=COALESCE(excluded.workspace_id, projects.workspace_id),
    owner_user_id=COALESCE(excluded.owner_user_id, projects.owner_user_id),
    repo_url=excluded.repo_url,
    is_public=excluded.is_public,
    updated_at=excluded.updated_at
`);

const addGuestGrantStmt = db.prepare(`
  INSERT OR IGNORE INTO result_access_grants (owner, repo, guest_id, user_id, created_at)
  VALUES (?, ?, ?, NULL, ?)
`);
const addUserGrantStmt = db.prepare(`
  INSERT OR IGNORE INTO result_access_grants (owner, repo, guest_id, user_id, created_at)
  VALUES (?, ?, NULL, ?, ?)
`);

function upsertMetrics(payload) {
  const normalized = {
    ...payload,
    proof_score: payload.proof_score ?? 0,
    release_recency_score: payload.release_recency_score ?? 0,
    ci_freshness_score: payload.ci_freshness_score ?? 0,
    issue_responsiveness_score: payload.issue_responsiveness_score ?? 0,
    last_release_at: payload.last_release_at ?? null,
    ci_status: payload.ci_status ?? null,
    ci_checked_at: payload.ci_checked_at ?? null,
    issue_response_hours: payload.issue_response_hours ?? null,
  };
  upsertStmt.run(normalized);
}
function addHistory(payload) {
  db.prepare(`INSERT INTO metrics_history (owner, repo, proof_score, commits_24h, release_recency_score, ci_freshness_score, issue_responsiveness_score, captured_at)
              VALUES (@owner,@repo,@proof_score,@commits_24h,@release_recency_score,@ci_freshness_score,@issue_responsiveness_score,@captured_at)`).run(payload);
}
function upsertProject(payload) { upsertProjectStmt.run(payload); }
function getByOwnerRepo(owner, repo) { return db.prepare('SELECT * FROM repo_metrics WHERE owner = ? AND repo = ?').get(owner, repo); }
function getByRepoUrl(repoUrl) { return db.prepare('SELECT * FROM repo_metrics WHERE repo_url = ?').get(repoUrl); }
function getProject(owner, repo) { return db.prepare('SELECT * FROM projects WHERE owner=? AND repo=?').get(owner, repo); }
function listLatest(limit = 25) { return db.prepare('SELECT * FROM repo_metrics ORDER BY updated_at DESC LIMIT ?').all(limit); }
function setGuardrail(owner, repo, nowIso, cooldownUntil) {
  db.prepare(`INSERT INTO refresh_guardrails (owner, repo, cooldown_until, last_refresh_at, refresh_count, updated_at)
              VALUES (?, ?, ?, ?, 1, ?)
              ON CONFLICT(owner,repo) DO UPDATE SET
                cooldown_until=excluded.cooldown_until,
                last_refresh_at=excluded.last_refresh_at,
                refresh_count=refresh_guardrails.refresh_count + 1,
                updated_at=excluded.updated_at`).run(owner, repo, cooldownUntil, nowIso, nowIso);
}
function getGuardrail(owner, repo) { return db.prepare('SELECT * FROM refresh_guardrails WHERE owner=? AND repo=?').get(owner, repo); }
function addAnalytics(eventType, owner, repo, metadata) {
  db.prepare('INSERT INTO analytics_events (event_type, owner, repo, metadata_json, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(eventType, owner || null, repo || null, metadata ? JSON.stringify(metadata) : null, new Date().toISOString());
}
function listAnalytics(limit = 100) {
  return db.prepare('SELECT * FROM analytics_events ORDER BY created_at DESC LIMIT ?').all(limit);
}
function addAlert(owner, repo, oldScore, newScore, message) {
  db.prepare('INSERT INTO alerts (owner, repo, old_score, new_score, message, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(owner, repo, oldScore, newScore, message, new Date().toISOString());
}
function listAlerts(limit = 100) { return db.prepare('SELECT * FROM alerts ORDER BY created_at DESC LIMIT ?').all(limit); }
function getTrends(owner, repo, days) {
  return db.prepare(`SELECT * FROM metrics_history WHERE owner=? AND repo=? AND captured_at >= datetime('now', ?) ORDER BY captured_at ASC`)
    .all(owner, repo, `-${Number(days)} days`);
}
function addGuestResultGrant(owner, repo, guestId) {
  if (!guestId) return;
  addGuestGrantStmt.run(owner, repo, guestId, new Date().toISOString());
}
function addUserResultGrant(owner, repo, userId) {
  if (!userId) return;
  addUserGrantStmt.run(owner, repo, userId, new Date().toISOString());
}
function migrateGuestResultGrantsToUser(guestId, userId) {
  if (!guestId || !userId) return;
  const now = new Date().toISOString();
  db.prepare(`
    INSERT OR IGNORE INTO result_access_grants (owner, repo, guest_id, user_id, created_at)
    SELECT owner, repo, NULL, ?, ?
    FROM result_access_grants
    WHERE guest_id = ?
  `).run(userId, now, guestId);
}
function userCanAccessResult(owner, repo, userId) {
  if (!userId) return false;
  const row = db.prepare('SELECT 1 AS ok FROM result_access_grants WHERE owner=? AND repo=? AND user_id=? LIMIT 1').get(owner, repo, userId);
  return Boolean(row?.ok);
}

module.exports = {
  db, dbPath, upsertMetrics, getByOwnerRepo, getByRepoUrl, listLatest, addHistory,
  setGuardrail, getGuardrail, addAnalytics, listAnalytics, addAlert, listAlerts, getTrends,
  upsertProject, getProject, addGuestResultGrant, addUserResultGrant, migrateGuestResultGrantsToUser, userCanAccessResult,
};
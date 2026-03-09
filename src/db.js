const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const dbPath = process.env.DB_PATH || path.join(dataDir, 'proof-of-build.sqlite');
const db = new Database(dbPath);

db.exec(`
  CREATE TABLE IF NOT EXISTS repo_metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner TEXT NOT NULL,
    repo TEXT NOT NULL,
    repo_url TEXT NOT NULL,
    commits_24h INTEGER NOT NULL DEFAULT 0,
    last_commit_at TEXT,
    uptime_text TEXT,
    fetched_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(owner, repo)
  );
`);

const upsertStmt = db.prepare(`
  INSERT INTO repo_metrics (
    owner, repo, repo_url, commits_24h, last_commit_at, uptime_text, fetched_at, updated_at
  ) VALUES (
    @owner, @repo, @repo_url, @commits_24h, @last_commit_at, @uptime_text, @fetched_at, @updated_at
  )
  ON CONFLICT(owner, repo) DO UPDATE SET
    repo_url=excluded.repo_url,
    commits_24h=excluded.commits_24h,
    last_commit_at=excluded.last_commit_at,
    uptime_text=COALESCE(excluded.uptime_text, repo_metrics.uptime_text),
    fetched_at=excluded.fetched_at,
    updated_at=excluded.updated_at
`);

function upsertMetrics(payload) {
  upsertStmt.run(payload);
}

function getByOwnerRepo(owner, repo) {
  return db
    .prepare('SELECT * FROM repo_metrics WHERE owner = ? AND repo = ?')
    .get(owner, repo);
}

function getByRepoUrl(repoUrl) {
  return db.prepare('SELECT * FROM repo_metrics WHERE repo_url = ?').get(repoUrl);
}

function listLatest(limit = 25) {
  return db
    .prepare('SELECT * FROM repo_metrics ORDER BY updated_at DESC LIMIT ?')
    .all(limit);
}

module.exports = {
  db,
  dbPath,
  upsertMetrics,
  getByOwnerRepo,
  getByRepoUrl,
  listLatest,
};

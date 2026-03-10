require('dotenv').config();
const { upsertMetrics, addHistory, dbPath } = require('../src/db');

const now = new Date().toISOString();
const rows = [
  {
    owner: 'openai', repo: 'openai-cookbook', repo_url: 'https://github.com/openai/openai-cookbook',
    commits_24h: 7, last_commit_at: now, uptime_text: '99.9% (manual)', proof_score: 74,
    release_recency_score: 24, ci_freshness_score: 16, issue_responsiveness_score: 8,
    last_release_at: now, ci_status: 'success', ci_checked_at: now, issue_response_hours: 30,
    fetched_at: now, updated_at: now,
  },
  {
    owner: 'nodejs', repo: 'node', repo_url: 'https://github.com/nodejs/node',
    commits_24h: 23, last_commit_at: now, uptime_text: '99.95% (manual)', proof_score: 95,
    release_recency_score: 30, ci_freshness_score: 18, issue_responsiveness_score: 9,
    last_release_at: now, ci_status: 'success', ci_checked_at: now, issue_response_hours: 12,
    fetched_at: now, updated_at: now,
  },
];

for (const row of rows) {
  upsertMetrics(row);
  addHistory({ owner: row.owner, repo: row.repo, proof_score: row.proof_score, commits_24h: row.commits_24h, release_recency_score: row.release_recency_score, ci_freshness_score: row.ci_freshness_score, issue_responsiveness_score: row.issue_responsiveness_score, captured_at: now });
}

console.log(`Seeded ${rows.length} rows into ${dbPath}`);
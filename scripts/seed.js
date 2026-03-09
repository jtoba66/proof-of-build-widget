require('dotenv').config();
const { upsertMetrics, dbPath } = require('../src/db');

const now = new Date().toISOString();

const rows = [
  {
    owner: 'openai',
    repo: 'openai-cookbook',
    repo_url: 'https://github.com/openai/openai-cookbook',
    commits_24h: 7,
    last_commit_at: now,
    uptime_text: '99.9% (manual)',
    fetched_at: now,
    updated_at: now,
  },
  {
    owner: 'nodejs',
    repo: 'node',
    repo_url: 'https://github.com/nodejs/node',
    commits_24h: 23,
    last_commit_at: now,
    uptime_text: '99.95% (manual)',
    fetched_at: now,
    updated_at: now,
  },
];

for (const row of rows) {
  upsertMetrics(row);
}

console.log(`Seeded ${rows.length} rows into ${dbPath}`);

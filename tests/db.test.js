const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let tempDir;
let dbPath;
let dbModule;

function resetDbModuleCache() {
  const modulePath = require.resolve('../src/db');
  delete require.cache[modulePath];
}

test('db upsert/get/list functions persist and update records', () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proof-widget-test-'));
  dbPath = path.join(tempDir, 'test.sqlite');
  process.env.DB_PATH = dbPath;
  resetDbModuleCache();
  dbModule = require('../src/db');

  const baseRow = {
    owner: 'nodejs',
    repo: 'node',
    repo_url: 'https://github.com/nodejs/node',
    commits_24h: 10,
    last_commit_at: '2026-03-09T20:00:00.000Z',
    uptime_text: '99.9% (manual)',
    fetched_at: '2026-03-09T21:00:00.000Z',
    updated_at: '2026-03-09T21:00:00.000Z',
  };

  dbModule.upsertMetrics(baseRow);
  const inserted = dbModule.getByOwnerRepo('nodejs', 'node');
  assert.equal(inserted.commits_24h, 10);
  assert.equal(inserted.uptime_text, '99.9% (manual)');

  dbModule.upsertMetrics({
    ...baseRow,
    commits_24h: 12,
    uptime_text: null,
    fetched_at: '2026-03-09T22:00:00.000Z',
    updated_at: '2026-03-09T22:00:00.000Z',
  });

  const updated = dbModule.getByRepoUrl('https://github.com/nodejs/node');
  assert.equal(updated.commits_24h, 12);
  assert.equal(updated.uptime_text, '99.9% (manual)');

  const latest = dbModule.listLatest(5);
  assert.equal(latest.length, 1);
  assert.equal(latest[0].owner, 'nodejs');

  dbModule.db.close();
  delete process.env.DB_PATH;
  fs.rmSync(tempDir, { recursive: true, force: true });
  resetDbModuleCache();
});

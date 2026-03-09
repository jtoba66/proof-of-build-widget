const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

let tempDir;
let server;
let baseUrl;
let dbModule;
let serverModule;

function requestJson(pathname, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, baseUrl);
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method,
        headers,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          let parsed = null;
          if (data.length > 0) {
            try {
              parsed = JSON.parse(data);
            } catch {
              parsed = data;
            }
          }
          resolve({ status: res.statusCode, headers: res.headers, body: parsed });
        });
      }
    );

    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function resetModuleCache(modulePath) {
  delete require.cache[require.resolve(modulePath)];
}

test.before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proof-widget-server-test-'));
  process.env.DB_PATH = path.join(tempDir, 'test.sqlite');
  process.env.WRITE_TOKEN = 'test-token';
  process.env.METRICS_RATE_LIMIT_MAX = '2';
  process.env.METRICS_RATE_LIMIT_WINDOW_MS = '60000';

  resetModuleCache('../src/db');
  resetModuleCache('../src/server');

  dbModule = require('../src/db');
  serverModule = require('../src/server');

  const app = serverModule.createApp();
  await new Promise((resolve) => {
    server = http.createServer(app);
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  dbModule.db.close();

  delete process.env.DB_PATH;
  delete process.env.WRITE_TOKEN;
  delete process.env.METRICS_RATE_LIMIT_MAX;
  delete process.env.METRICS_RATE_LIMIT_WINDOW_MS;

  fs.rmSync(tempDir, { recursive: true, force: true });
  resetModuleCache('../src/db');
  resetModuleCache('../src/server');
});

test('GET /widget escapes script injection in query and route params', async () => {
  const nowIso = new Date().toISOString();
  dbModule.upsertMetrics({
    owner: 'safe-owner',
    repo: 'safe-repo',
    repo_url: 'https://github.com/safe-owner/safe-repo',
    commits_24h: 3,
    last_commit_at: nowIso,
    uptime_text: '99.9%',
    fetched_at: nowIso,
    updated_at: nowIso,
  });

  const owner = encodeURIComponent('<script>alert(1)</script>');
  const repo = encodeURIComponent('repo<img src=x onerror=alert(1)>');
  const uptime = encodeURIComponent('<img src=x onerror=alert(9)>');
  const response = await fetch(`${baseUrl}/widget/${owner}/${repo}?uptime=${uptime}`);
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.equal(html.includes('<script>alert(1)</script>'), false);
  assert.equal(html.includes('<img src=x onerror=alert(9)>'), false);
  assert.equal(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), true);
  assert.equal(html.includes('repo&lt;img src=x onerror=alert(1)&gt;'), true);
  assert.equal(html.includes('&lt;img src=x onerror=alert(9)&gt;'), true);
});

test('POST /api/metrics requires x-write-token and rate limits requests', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    if (String(url).includes('/commits?')) {
      return { ok: true, status: 200, json: async () => [{ sha: 'a' }] };
    }
    return { ok: true, status: 200, json: async () => ({ pushed_at: '2026-03-09T21:00:00.000Z' }) };
  };

  try {
    const unauthorized = await requestJson('/api/metrics', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repoUrl: 'https://github.com/nodejs/node' }),
    });
    assert.equal(unauthorized.status, 401);

    const one = await requestJson('/api/metrics', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-write-token': 'test-token' },
      body: JSON.stringify({ repoUrl: 'https://github.com/nodejs/node', uptimeText: 'ok' }),
    });
    assert.equal(one.status, 200);

    const two = await requestJson('/api/metrics', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-write-token': 'test-token' },
      body: JSON.stringify({ repoUrl: 'https://github.com/nodejs/node', uptimeText: 'ok' }),
    });
    assert.equal(two.status, 429);
    assert.equal(two.body.error, 'Rate limit exceeded');
    assert.equal(typeof two.headers['retry-after'], 'string');
  } finally {
    global.fetch = originalFetch;
  }
});

test('/health does not leak dbPath or filesystem paths', async () => {
  const response = await fetch(`${baseUrl}/health`);
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(payload, { ok: true });
  assert.equal(Object.hasOwn(payload, 'dbPath'), false);
});

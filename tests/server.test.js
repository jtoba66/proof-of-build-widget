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

test('GET /widget is auth-gated and still escapes script injection for authorized users', async () => {
  const unauthorized = await fetch(`${baseUrl}/widget/safe-owner/safe-repo`);
  assert.equal(unauthorized.status, 401);

  const signup = await requestJson('/api/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'test@example.com', password: 'password123' }),
  });
  assert.equal(signup.status, 200);
  const sessionCookie = String(signup.headers['set-cookie'] || '').split(',').find((x) => x.includes('pob_session='));
  assert.equal(Boolean(sessionCookie), true);

  const nowIso = new Date().toISOString();
  dbModule.upsertMetrics({
    owner: '<script>alert(1)</script>',
    repo: 'repo<img src=x onerror=alert(1)>',
    repo_url: 'https://github.com/safe-owner/safe-repo',
    commits_24h: 3,
    last_commit_at: nowIso,
    uptime_text: '<img src=x onerror=alert(9)>',
    fetched_at: nowIso,
    updated_at: nowIso,
  });
  const user = dbModule.db.prepare('SELECT id FROM users WHERE email=?').get('test@example.com');
  dbModule.addUserResultGrant('<script>alert(1)</script>', 'repo<img src=x onerror=alert(1)>', user.id);

  const owner = encodeURIComponent('<script>alert(1)</script>');
  const repo = encodeURIComponent('repo<img src=x onerror=alert(1)>');
  const response = await fetch(`${baseUrl}/widget/${owner}/${repo}`, { headers: { cookie: sessionCookie.split(';')[0] } });
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

test('auth signup/login establish real backend session cookie and return user payload', async () => {
  const signup = await requestJson('/api/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'cookieuser@example.com', password: 'password123' }),
  });
  assert.equal(signup.status, 200);
  assert.equal(Boolean(signup.body?.user?.id), true);
  assert.equal(signup.body?.user?.email, 'cookieuser@example.com');

  const sessionCookie = String(signup.headers['set-cookie'] || '').split(',').find((x) => x.includes('pob_session='));
  assert.equal(Boolean(sessionCookie), true);

  const me = await requestJson('/api/auth/me', { headers: { cookie: sessionCookie.split(';')[0] } });
  assert.equal(me.status, 200);
  assert.equal(me.body?.ok, true);
  assert.equal(me.body?.user?.email, 'cookieuser@example.com');

  const login = await requestJson('/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'cookieuser@example.com', password: 'password123' }),
  });
  assert.equal(login.status, 200);
  assert.equal(login.body?.ok, true);
  assert.equal(login.body?.user?.email, 'cookieuser@example.com');
});

test('workspace claim prevents cross-user takeover', async () => {
  const aSignup = await requestJson('/api/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'owner-a@example.com', password: 'password123' }),
  });
  const bSignup = await requestJson('/api/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'owner-b@example.com', password: 'password123' }),
  });

  const aCookie = String(aSignup.headers['set-cookie'] || '').split(',').find((x) => x.includes('pob_session=')).split(';')[0];
  const bCookie = String(bSignup.headers['set-cookie'] || '').split(',').find((x) => x.includes('pob_session=')).split(';')[0];
  const aUser = dbModule.db.prepare('SELECT id FROM users WHERE email=?').get('owner-a@example.com');
  const nowIso = new Date().toISOString();

  dbModule.upsertProject({
    workspace_id: null,
    owner_user_id: aUser.id,
    owner: 'expressjs',
    repo: 'express',
    repo_url: 'https://github.com/expressjs/express',
    is_public: 1,
    created_at: nowIso,
    updated_at: nowIso,
  });

  const unauthorizedClaim = await requestJson('/api/workspace/projects/claim', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: bCookie },
    body: JSON.stringify({ owner: 'expressjs', repo: 'express' }),
  });
  assert.equal(unauthorizedClaim.status, 403);

  dbModule.addUserResultGrant('expressjs', 'express', aUser.id);
  const authorizedClaim = await requestJson('/api/workspace/projects/claim', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: aCookie },
    body: JSON.stringify({ owner: 'expressjs', repo: 'express' }),
  });
  assert.equal(authorizedClaim.status, 200);
});

test('trends payload uses consistent shape and supports 30d query format', async () => {
  const signup = await requestJson('/api/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'trends@example.com', password: 'password123' }),
  });
  const cookie = String(signup.headers['set-cookie'] || '').split(',').find((x) => x.includes('pob_session=')).split(';')[0];
  const user = dbModule.db.prepare('SELECT id FROM users WHERE email=?').get('trends@example.com');

  dbModule.db.prepare('INSERT INTO metrics_history (owner, repo, proof_score, commits_24h, release_recency_score, ci_freshness_score, issue_responsiveness_score, captured_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run('nodejs', 'node', 77, 9, 80, 70, 60, new Date().toISOString());
  dbModule.addUserResultGrant('nodejs', 'node', user.id);

  const response = await requestJson('/api/trends/nodejs/node?days=30d', { headers: { cookie } });
  assert.equal(response.status, 200);
  assert.equal(response.body?.ok, true);
  assert.equal(response.body?.days, 30);
  assert.equal(response.body?.window, '30d');
  assert.equal(Array.isArray(response.body?.data), true);
  assert.equal(typeof response.body?.data?.[0]?.proofScore, 'number');
  assert.equal(typeof response.body?.data?.[0]?.signals?.ciFreshness, 'number');
});

test('gated reveal flow preserves access grant after signup/login and tracks funnel metrics', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    if (String(url).includes('/commits?')) return { ok: true, status: 200, json: async () => [{ sha: 'a' }] };
    return { ok: true, status: 200, json: async () => ({ pushed_at: '2026-03-09T21:00:00.000Z' }) };
  };

  try {
    const generated = await requestJson('/api/metrics?repoUrl=https://github.com/nodejs/node');
    assert.equal(generated.status, 401);
    assert.equal(generated.body?.code, 'RESULTS_AUTH_REQUIRED');

    const guestCookie = String(generated.headers['set-cookie'] || '').split(',').find((x) => x.includes('pob_guest=')).split(';')[0];
    const signup = await requestJson('/api/auth/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: guestCookie },
      body: JSON.stringify({ email: 'gated@example.com', password: 'password123' }),
    });
    assert.equal(signup.status, 200);

    const sessionCookie = String(signup.headers['set-cookie'] || '').split(',').find((x) => x.includes('pob_session=')).split(';')[0];
    const repos = await requestJson('/api/repos', { headers: { cookie: sessionCookie } });
    assert.equal(repos.status, 200);
    assert.equal(repos.body?.ok, true);
    assert.equal(Array.isArray(repos.body?.data), true);
    assert.equal(repos.body?.data?.some((r) => r.owner === 'nodejs' && r.repo === 'node'), true);

    const widget = await fetch(`${baseUrl}/widget/nodejs/node`, { headers: { cookie: sessionCookie } });
    assert.equal(widget.status, 200);

    const ops = await requestJson('/api/ops/metrics', { headers: { 'x-write-token': 'test-token' } });
    assert.equal(ops.status, 200);
    assert.equal(ops.body?.data?.generateFunnel?.requested >= 1, true);
    assert.equal(ops.body?.data?.generateFunnel?.authGated >= 1, true);
    assert.equal((ops.body?.data?.generateFunnel?.authed ?? 0) >= 0, true);
    assert.equal((ops.body?.data?.generateFunnel?.revealed ?? 0) >= 0, true);
  } finally {
    global.fetch = originalFetch;
  }
});

test('/u redirect behavior handles single-project redirect and multi-project listing', async () => {
  const signup = await requestJson('/api/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'redirector@example.com', password: 'password123' }),
  });
  const cookie = String(signup.headers['set-cookie'] || '').split(',').find((x) => x.includes('pob_session=')).split(';')[0];
  const user = dbModule.db.prepare('SELECT id FROM users WHERE email=?').get('redirector@example.com');
  const nowIso = new Date().toISOString();

  dbModule.upsertProject({ workspace_id: null, owner_user_id: user.id, owner: 'owner1', repo: 'repo1', repo_url: 'https://github.com/owner1/repo1', is_public: 1, created_at: nowIso, updated_at: nowIso });
  dbModule.upsertMetrics({ owner: 'owner1', repo: 'repo1', repo_url: 'https://github.com/owner1/repo1', commits_24h: 1, last_commit_at: nowIso, uptime_text: 'ok', fetched_at: nowIso, updated_at: nowIso });
  dbModule.addUserResultGrant('owner1', 'repo1', user.id);

  const single = await fetch(`${baseUrl}/u/redirector`, { headers: { cookie }, redirect: 'manual' });
  assert.equal(single.status, 302);
  assert.equal(single.headers.get('location'), '/p/owner1/repo1');

  const laterIso = new Date(Date.now() + 1000).toISOString();
  dbModule.upsertProject({ workspace_id: null, owner_user_id: user.id, owner: 'owner2', repo: 'repo2', repo_url: 'https://github.com/owner2/repo2', is_public: 1, created_at: laterIso, updated_at: laterIso });
  dbModule.upsertMetrics({ owner: 'owner2', repo: 'repo2', repo_url: 'https://github.com/owner2/repo2', commits_24h: 1, last_commit_at: laterIso, uptime_text: 'ok', fetched_at: laterIso, updated_at: laterIso });
  dbModule.addUserResultGrant('owner2', 'repo2', user.id);

  const multi = await fetch(`${baseUrl}/u/redirector`, { headers: { cookie }, redirect: 'manual' });
  assert.equal(multi.status, 200);
  const html = await multi.text();
  assert.equal(html.includes('/p/owner2/repo2'), true);
  assert.equal(html.includes('/p/owner1/repo1'), true);
});

test('embed alias normalization maps to canonical themes', async () => {
  const signup = await requestJson('/api/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'embed@example.com', password: 'password123' }),
  });
  const cookie = String(signup.headers['set-cookie'] || '').split(',').find((x) => x.includes('pob_session=')).split(';')[0];
  const user = dbModule.db.prepare('SELECT id FROM users WHERE email=?').get('embed@example.com');
  const nowIso = new Date().toISOString();

  dbModule.upsertMetrics({ owner: 'alias', repo: 'repo', repo_url: 'https://github.com/alias/repo', commits_24h: 1, last_commit_at: nowIso, uptime_text: 'ok', fetched_at: nowIso, updated_at: nowIso });
  dbModule.addUserResultGrant('alias', 'repo', user.id);

  const midnight = await requestJson('/api/embeds/v2/alias/repo?theme=midnight&size=sm', { headers: { cookie } });
  assert.equal(midnight.status, 200);
  assert.equal(midnight.body?.data?.theme, 'dark');

  const aurora = await requestJson('/api/embeds/v2/alias/repo?theme=aurora&size=md', { headers: { cookie } });
  assert.equal(aurora.status, 200);
  assert.equal(aurora.body?.data?.theme, 'light');

  const glass = await requestJson('/api/embeds/v2/alias/repo?theme=glass-ice&size=lg', { headers: { cookie } });
  assert.equal(glass.status, 200);
  assert.equal(glass.body?.data?.theme, 'sunset');
});

test('claim ownership conflict increments claim-denied/auth-403 operational metrics', async () => {
  await requestJson('/api/auth/signup', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'conflict-a@example.com', password: 'password123' }),
  });
  const bSignup = await requestJson('/api/auth/signup', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'conflict-b@example.com', password: 'password123' }),
  });
  const bCookie = String(bSignup.headers['set-cookie'] || '').split(',').find((x) => x.includes('pob_session=')).split(';')[0];
  const aUser = dbModule.db.prepare('SELECT id FROM users WHERE email=?').get('conflict-a@example.com');
  const nowIso = new Date().toISOString();

  dbModule.upsertProject({ workspace_id: null, owner_user_id: aUser.id, owner: 'conflict', repo: 'repo', repo_url: 'https://github.com/conflict/repo', is_public: 1, created_at: nowIso, updated_at: nowIso });
  dbModule.addUserResultGrant('conflict', 'repo', aUser.id);

  const denied = await requestJson('/api/workspace/projects/claim', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: bCookie },
    body: JSON.stringify({ owner: 'conflict', repo: 'repo' }),
  });
  assert.equal(denied.status, 403);

  const ops = await requestJson('/api/ops/metrics', { headers: { 'x-write-token': 'test-token' } });
  assert.equal(ops.status, 200);
  assert.equal(ops.body?.data?.auth403 >= 1, true);
  assert.equal(ops.body?.data?.claimDenied >= 1, true);
});

test('generate -> gated -> signup -> reveal flow works with guest grant migration', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    if (String(url).includes('/commits?')) return { ok: true, status: 200, json: async () => [{ sha: 'a' }, { sha: 'b' }] };
    return { ok: true, status: 200, json: async () => ({ pushed_at: '2026-03-09T21:00:00.000Z' }) };
  };

  try {
    const gated = await requestJson('/api/metrics?repoUrl=https://github.com/nodejs/node');
    assert.equal(gated.status, 401);
    assert.equal(gated.body?.gated, true);

    const guestCookie = String(gated.headers['set-cookie'] || '').split(',').find((x) => x.includes('pob_guest=')).split(';')[0];
    const signup = await requestJson('/api/auth/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: guestCookie },
      body: JSON.stringify({ email: 'funnel@example.com', password: 'password123' }),
    });

    const sessionCookie = String(signup.headers['set-cookie'] || '').split(',').find((x) => x.includes('pob_session=')).split(';')[0];
    const reveal = await requestJson('/api/metrics?repoUrl=https://github.com/nodejs/node', { headers: { cookie: sessionCookie } });

    assert.equal(signup.status, 200);
    assert.equal(reveal.status, 200);
    assert.equal(reveal.body?.ok, true);
    assert.equal(reveal.body?.data?.owner, 'nodejs');
    assert.equal(reveal.body?.data?.repo, 'node');
  } finally {
    global.fetch = originalFetch;
  }
});

test('/u and /p route compatibility supports redirect and fallback states', async () => {
  const signup = await requestJson('/api/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'profileuser@example.com', password: 'password123' }),
  });
  const cookie = String(signup.headers['set-cookie'] || '').split(',').find((x) => x.includes('pob_session=')).split(';')[0];
  const user = dbModule.db.prepare('SELECT id FROM users WHERE email=?').get('profileuser@example.com');
  const nowIso = new Date().toISOString();

  dbModule.upsertMetrics({
    owner: 'vercel',
    repo: 'next.js',
    repo_url: 'https://github.com/vercel/next.js',
    commits_24h: 4,
    last_commit_at: nowIso,
    uptime_text: null,
    fetched_at: nowIso,
    updated_at: nowIso,
  });
  dbModule.upsertProject({
    workspace_id: null,
    owner_user_id: user.id,
    owner: 'vercel',
    repo: 'next.js',
    repo_url: 'https://github.com/vercel/next.js',
    is_public: 1,
    created_at: nowIso,
    updated_at: nowIso,
  });
  dbModule.addUserResultGrant('vercel', 'next.js', user.id);

  const pRoute = await fetch(`${baseUrl}/p/vercel/next.js`, { headers: { cookie }, redirect: 'manual' });
  assert.equal(pRoute.status, 200);

  const uRoute = await fetch(`${baseUrl}/u/profileuser`, { headers: { cookie }, redirect: 'manual' });
  assert.equal(uRoute.status, 302);
  assert.equal(uRoute.headers.get('location'), '/p/vercel/next.js');

  const missingAlias = await fetch(`${baseUrl}/u/someoneelse`, { headers: { cookie } });
  assert.equal(missingAlias.status, 404);

  const unauth = await fetch(`${baseUrl}/p/vercel/next.js`);
  assert.equal(unauth.status, 401);
});

test('GET /api/profile/routes/check returns deterministic /p and /u statuses', async () => {
  const signup = await requestJson('/api/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'routecheck@example.com', password: 'password123' }),
  });
  const cookie = String(signup.headers['set-cookie'] || '').split(',').find((x) => x.includes('pob_session=')).split(';')[0];
  const user = dbModule.db.prepare('SELECT id FROM users WHERE email=?').get('routecheck@example.com');
  const nowIso = new Date().toISOString();

  dbModule.upsertMetrics({
    owner: 'nodejs',
    repo: 'node',
    repo_url: 'https://github.com/nodejs/node',
    commits_24h: 7,
    last_commit_at: nowIso,
    uptime_text: null,
    fetched_at: nowIso,
    updated_at: nowIso,
  });
  dbModule.upsertProject({
    workspace_id: null,
    owner_user_id: user.id,
    owner: 'nodejs',
    repo: 'node',
    repo_url: 'https://github.com/nodejs/node',
    is_public: 1,
    created_at: nowIso,
    updated_at: nowIso,
  });
  dbModule.addUserResultGrant('nodejs', 'node', user.id);

  const ok = await requestJson('/api/profile/routes/check?owner=nodejs&repo=node&username=routecheck', {
    headers: { cookie },
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.body?.ok, true);
  assert.equal(ok.body?.data?.p?.status, 200);
  assert.equal(ok.body?.data?.u?.status, 302);
  assert.equal(ok.body?.data?.u?.location, '/p/nodejs/node');

  const aliasMismatch = await requestJson('/api/profile/routes/check?owner=nodejs&repo=node&username=someoneelse', {
    headers: { cookie },
  });
  assert.equal(aliasMismatch.status, 200);
  assert.equal(aliasMismatch.body?.data?.u?.status, 404);

  const unauth = await requestJson('/api/profile/routes/check?owner=nodejs&repo=node');
  assert.equal(unauth.status, 401);

  const missingParams = await requestJson('/api/profile/routes/check?owner=nodejs', { headers: { cookie } });
  assert.equal(missingParams.status, 400);

  const forbidden = await requestJson('/api/profile/routes/check?owner=vercel&repo=next.js', { headers: { cookie } });
  assert.equal(forbidden.status, 403);
});

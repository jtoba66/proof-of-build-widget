const test = require('node:test');
const assert = require('node:assert/strict');
const { parseGitHubRepoUrl, fetchRepoMetrics } = require('../src/github');

test('parseGitHubRepoUrl parses owner/repo and normalizes .git URLs', () => {
  const parsed = parseGitHubRepoUrl('https://github.com/nodejs/node.git');
  assert.deepEqual(parsed, {
    owner: 'nodejs',
    repo: 'node',
    normalizedUrl: 'https://github.com/nodejs/node',
  });
});

test('parseGitHubRepoUrl rejects non-github URLs', () => {
  assert.throws(() => parseGitHubRepoUrl('https://gitlab.com/foo/bar'), /Only github\.com/);
});

test('fetchRepoMetrics returns commit count and pushed_at with mocked fetch', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    if (String(url).includes('/commits?')) {
      return {
        ok: true,
        status: 200,
        async json() {
          return [{ id: 1 }, { id: 2 }, { id: 3 }];
        },
      };
    }

    return {
      ok: true,
      status: 200,
      async json() {
        return { pushed_at: '2026-03-09T21:00:00.000Z' };
      },
    };
  };

  try {
    const metrics = await fetchRepoMetrics('nodejs', 'node', '');
    assert.equal(metrics.commits24h, 3);
    assert.equal(metrics.lastCommitAt, '2026-03-09T21:00:00.000Z');
    assert.equal(typeof metrics.proofScore, 'number');
    assert.equal(typeof metrics.releaseRecencyScore, 'number');
    assert.equal(typeof metrics.ciFreshnessScore, 'number');
    assert.equal(typeof metrics.issueResponsivenessScore, 'number');
  } finally {
    global.fetch = originalFetch;
  }
});

test('fetchRepoMetrics maps 404 repo response to friendly error', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    if (String(url).includes('/commits?')) {
      return { ok: true, status: 200, json: async () => [] };
    }

    return { ok: false, status: 404, json: async () => ({}) };
  };

  try {
    await assert.rejects(
      () => fetchRepoMetrics('missing', 'repo', ''),
      (error) => error?.status === 404 && /Repository not found/.test(error.message)
    );
  } finally {
    global.fetch = originalFetch;
  }
});

function parseGitHubRepoUrl(repoUrl) {
  if (!repoUrl || typeof repoUrl !== 'string') {
    throw new Error('repoUrl is required');
  }

  let parsed;
  try {
    parsed = new URL(repoUrl.trim());
  } catch {
    throw new Error('Invalid URL format');
  }

  if (parsed.hostname !== 'github.com') {
    throw new Error('Only github.com public repo URLs are supported');
  }

  const parts = parsed.pathname.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
  if (parts.length < 2) {
    throw new Error('Expected format: https://github.com/{owner}/{repo}');
  }

  const owner = parts[0];
  let repo = parts[1];
  if (repo.endsWith('.git')) repo = repo.slice(0, -4);

  if (!owner || !repo) {
    throw new Error('Could not parse owner/repo from URL');
  }

  return {
    owner,
    repo,
    normalizedUrl: `https://github.com/${owner}/${repo}`,
  };
}

async function fetchRepoMetrics(owner, repo, githubToken) {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const headers = {
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'proof-of-build-widget',
  };

  if (githubToken) headers.Authorization = `Bearer ${githubToken}`;

  const commitsUrl = `https://api.github.com/repos/${owner}/${repo}/commits?since=${encodeURIComponent(since)}&per_page=100`;
  const repoUrl = `https://api.github.com/repos/${owner}/${repo}`;

  const [commitsRes, repoRes] = await Promise.all([
    fetch(commitsUrl, { headers }),
    fetch(repoUrl, { headers }),
  ]);

  if (repoRes.status === 404) {
    const err = new Error('Repository not found or private');
    err.status = 404;
    throw err;
  }

  if (repoRes.status === 403 || commitsRes.status === 403) {
    const err = new Error('GitHub API rate limited/forbidden. Add GITHUB_TOKEN to increase limit.');
    err.status = 429;
    throw err;
  }

  if (!repoRes.ok || !commitsRes.ok) {
    const err = new Error('Failed to fetch GitHub data');
    err.status = 502;
    throw err;
  }

  const commits = await commitsRes.json();
  const repoData = await repoRes.json();

  return {
    commits24h: Array.isArray(commits) ? commits.length : 0,
    lastCommitAt: repoData?.pushed_at || null,
  };
}

module.exports = {
  parseGitHubRepoUrl,
  fetchRepoMetrics,
};

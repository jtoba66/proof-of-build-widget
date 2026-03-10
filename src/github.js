function parseGitHubRepoUrl(repoUrl) {
  if (!repoUrl || typeof repoUrl !== 'string') throw new Error('repoUrl is required');
  let parsed;
  try { parsed = new URL(repoUrl.trim()); } catch { throw new Error('Invalid URL format'); }
  if (parsed.hostname !== 'github.com') throw new Error('Only github.com public repo URLs are supported');
  const parts = parsed.pathname.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
  if (parts.length < 2) throw new Error('Expected format: https://github.com/{owner}/{repo}');
  const owner = parts[0];
  let repo = parts[1];
  if (repo.endsWith('.git')) repo = repo.slice(0, -4);
  return { owner, repo, normalizedUrl: `https://github.com/${owner}/${repo}` };
}

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

function scoreReleaseRecency(lastReleaseAt) {
  if (!lastReleaseAt) return 5;
  const days = (Date.now() - new Date(lastReleaseAt).getTime()) / 86400000;
  if (days <= 7) return 30;
  if (days <= 30) return 24;
  if (days <= 90) return 16;
  if (days <= 180) return 10;
  return 4;
}

function scoreCiFreshness(ciStatus, ciCheckedAt) {
  if (!ciCheckedAt) return 5;
  const ageDays = (Date.now() - new Date(ciCheckedAt).getTime()) / 86400000;
  const freshness = ageDays <= 1 ? 14 : ageDays <= 3 ? 10 : ageDays <= 7 ? 6 : 3;
  const statusBoost = ciStatus === 'success' ? 6 : ciStatus === 'failure' ? 1 : 3;
  return clamp(freshness + statusBoost, 0, 20);
}

function scoreIssueResponsiveness(avgIssueHours) {
  if (avgIssueHours == null) return 5;
  if (avgIssueHours <= 24) return 10;
  if (avgIssueHours <= 72) return 8;
  if (avgIssueHours <= 168) return 6;
  if (avgIssueHours <= 336) return 4;
  return 2;
}

function scoreCommitActivity(commits24h) {
  return clamp(Math.round(Math.min(40, commits24h * 8)), 0, 40);
}

async function fetchJson(url, headers) {
  const res = await fetch(url, { headers });
  if (res.status === 404) return { notFound: true, data: null, res };
  if (!res.ok) return { error: true, status: res.status, data: null, res };
  return { data: await res.json(), res };
}

async function fetchRepoMetrics(owner, repo, githubToken) {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'proof-of-build-widget' };
  if (githubToken) headers.Authorization = `Bearer ${githubToken}`;

  const repoUrl = `https://api.github.com/repos/${owner}/${repo}`;
  const commitsUrl = `https://api.github.com/repos/${owner}/${repo}/commits?since=${encodeURIComponent(since)}&per_page=100`;
  const releaseUrl = `https://api.github.com/repos/${owner}/${repo}/releases/latest`;
  const runsUrl = `https://api.github.com/repos/${owner}/${repo}/actions/runs?per_page=1`;
  const issuesUrl = `https://api.github.com/repos/${owner}/${repo}/issues?state=closed&per_page=20`;

  const [repoRes, commitsRes, releaseRes, runsRes, issuesRes] = await Promise.all([
    fetchJson(repoUrl, headers), fetchJson(commitsUrl, headers), fetchJson(releaseUrl, headers), fetchJson(runsUrl, headers), fetchJson(issuesUrl, headers),
  ]);

  if (repoRes.notFound) {
    const err = new Error('Repository not found or private');
    err.status = 404;
    throw err;
  }
  if (repoRes.error || commitsRes.error) {
    const status = repoRes.status || commitsRes.status;
    const err = new Error(status === 403 ? 'GitHub API rate limited/forbidden. Add GITHUB_TOKEN to increase limit.' : 'Failed to fetch GitHub data');
    err.status = status === 403 ? 429 : 502;
    throw err;
  }

  const commits = Array.isArray(commitsRes.data) ? commitsRes.data : [];
  const repoData = repoRes.data || {};
  const latestRelease = releaseRes?.data?.published_at || null;
  const latestRun = runsRes?.data?.workflow_runs?.[0] || null;
  const ciStatus = latestRun?.conclusion || latestRun?.status || 'unknown';
  const ciCheckedAt = latestRun?.updated_at || latestRun?.created_at || null;

  const closedIssues = (Array.isArray(issuesRes?.data) ? issuesRes.data : []).filter((i) => !i.pull_request && i.closed_at && i.created_at);
  const avgIssueHours = closedIssues.length
    ? closedIssues.reduce((sum, i) => sum + ((new Date(i.closed_at) - new Date(i.created_at)) / 3600000), 0) / closedIssues.length
    : null;

  const releaseScore = scoreReleaseRecency(latestRelease);
  const ciScore = scoreCiFreshness(ciStatus, ciCheckedAt);
  const issueScore = scoreIssueResponsiveness(avgIssueHours);
  const commitScore = scoreCommitActivity(commits.length);
  const proofScore = clamp(commitScore + releaseScore + ciScore + issueScore, 0, 100);

  return {
    commits24h: commits.length,
    lastCommitAt: repoData.pushed_at || null,
    proofScore,
    releaseRecencyScore: releaseScore,
    ciFreshnessScore: ciScore,
    issueResponsivenessScore: issueScore,
    lastReleaseAt: latestRelease,
    ciStatus,
    ciCheckedAt,
    issueResponseHours: avgIssueHours,
  };
}

module.exports = { parseGitHubRepoUrl, fetchRepoMetrics };
const form = document.getElementById('widget-form');
const statusEl = document.getElementById('status');
const resultEl = document.getElementById('result');
const snippetEl = document.getElementById('snippet');
const previewEl = document.getElementById('preview');
const submitBtn = document.getElementById('submitBtn');
const copyBtn = document.getElementById('copyBtn');

function setStatus(message, tone = 'idle') {
  statusEl.textContent = message;
  statusEl.className = `status status-${tone}`;
}

function setLoading(isLoading) {
  submitBtn.disabled = isLoading;
  submitBtn.textContent = isLoading ? 'Generating…' : 'Generate widget embed';
}

function showResult(show) {
  resultEl.classList.toggle('hidden', !show);
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();

  const repoUrl = document.getElementById('repoUrl').value.trim();
  const uptimeText = document.getElementById('uptimeText').value.trim();

  if (!repoUrl) {
    showResult(false);
    setStatus('Please add a GitHub repo URL to continue.', 'error');
    return;
  }

  setLoading(true);
  showResult(false);
  setStatus('Fetching fresh repository metrics…', 'loading');

  try {
    const response = await fetch(`/api/metrics?repoUrl=${encodeURIComponent(repoUrl)}`);
    const payload = await response.json();

    if (!response.ok || !payload.ok) {
      throw new Error(payload.error || 'Failed to fetch metrics');
    }

    const { data, embed } = payload;

    document.getElementById('rRepo').textContent = `${data.owner}/${data.repo}`;
    document.getElementById('rCommits').textContent = String(data.commits24h);
    document.getElementById('rLast').textContent = data.lastCommitAt
      ? new Date(data.lastCommitAt).toLocaleString()
      : 'Unavailable';
    document.getElementById('rUptime').textContent = uptimeText || data.uptimeText || 'Manual uptime not set';

    const finalEmbedUrl = uptimeText
      ? `${window.location.origin}/widget/${data.owner}/${data.repo}?uptime=${encodeURIComponent(uptimeText)}`
      : embed.url;

    const snippet = `<iframe src="${finalEmbedUrl}" width="340" height="140" style="border:0;" loading="lazy"></iframe>`;

    snippetEl.value = snippet;
    previewEl.src = finalEmbedUrl;
    showResult(true);
    setStatus('Widget generated. Copy the embed code and publish.', 'ok');
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Something went wrong while generating the widget';
    setStatus(message, 'error');
    showResult(false);
  } finally {
    setLoading(false);
  }
});

copyBtn.addEventListener('click', async () => {
  if (!snippetEl.value.trim()) {
    setStatus('No snippet yet. Generate a widget first.', 'error');
    return;
  }

  try {
    await navigator.clipboard.writeText(snippetEl.value);
    setStatus('Embed HTML copied. Paste it into your site template.', 'ok');
    copyBtn.textContent = 'Copied!';
    window.setTimeout(() => {
      copyBtn.textContent = 'Copy embed HTML';
    }, 1400);
  } catch {
    setStatus('Copy failed. Select the snippet manually and copy it.', 'error');
  }
});

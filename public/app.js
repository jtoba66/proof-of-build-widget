const app = document.getElementById('app');
const modalRoot = document.getElementById('modalRoot');

const state = {
  route: 'check',
  session: null,
  status: '',
  tone: 'info',
  repoUrl: 'https://github.com/nodejs/node',
  uptime: '',
  repoData: null,
  repos: [],
  theme: 'dark',
  size: 'md',
  tab: 'iframe',
  win: '30d',
  trends: [],
  authError: '',
  authModalOpen: false,
  authMode: 'signup',
  pendingGenerate: null,
  profileRouteStatus: '',
  loading: false,
};

function track(event, payload = {}) {
  window.__pbwAnalytics = window.__pbwAnalytics || [];
  window.__pbwAnalytics.push({ event, payload, ts: new Date().toISOString() });
}

function escapeSnippet(value) {
  return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

async function sendTelemetry(eventType, metadata = {}) {
  try {
    await fetch('/api/analytics', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        eventType,
        owner: state.repoData?.owner || metadata.owner || null,
        repo: state.repoData?.repo || metadata.repo || null,
        metadata,
      }),
    });
  } catch {}
}

function trackFunnel(step, payload = {}) {
  const event = `funnel_${step}`;
  track(event, payload);
  void sendTelemetry(event, payload);
}

function normalizeRoute(input) {
  if (input === 'dashboard' || input === 'onboarding' || input === 'repo' || input === 'settings') return 'check';
  if (input === 'profile') return 'profiles';
  return input || 'check';
}

function setRoute(route) {
  state.route = normalizeRoute(route);
  location.hash = `#/${state.route}`;
  render();
}

function initRoute() {
  const h = location.hash.replace(/^#\//, '');
  state.route = normalizeRoute(h || 'check');
}

function openAuthGate(reason = 'generate') {
  state.authModalOpen = true;
  state.authMode = 'signup';
  state.authError = '';
  trackFunnel('auth_gate_open', { reason });
  render();
}

function currentRepoSlug() {
  if (!state.repoData?.owner || !state.repoData?.repo) return null;
  return `${state.repoData.owner}/${state.repoData.repo}`;
}

function embed() {
  const repo = currentRepoSlug() || 'owner/repo';
  const [o, r] = repo.split('/');
  const dim = state.size === 'sm' ? { w: 220, h: 36 } : state.size === 'lg' ? { w: 340, h: 58 } : { w: 280, h: 46 };
  const widgetHeight = state.size === 'sm' ? 120 : state.size === 'lg' ? 170 : 140;
  const iframeUrl = `${location.origin}/widget/${o}/${r}?theme=${encodeURIComponent(state.theme)}&size=${encodeURIComponent(state.size)}`;
  const badgeUrl = `${location.origin}/badge/${o}/${r}.svg?theme=${encodeURIComponent(state.theme)}&size=${encodeURIComponent(state.size)}`;
  return {
    iframe: `<iframe src="${iframeUrl}" width="340" height="${widgetHeight}" style="border:0;border-radius:12px" loading="lazy"></iframe>`,
    svg: `<img src="${badgeUrl}" width="${dim.w}" height="${dim.h}" alt="Proof of Build badge for ${repo}" />`,
    badgeUrl,
  };
}

async function fetchJson(url, opts) {
  const response = await fetch(url, opts);
  const payload = await response.json().catch(() => ({}));
  return { response, payload };
}

async function hydrateSession() {
  try {
    const { response, payload } = await fetchJson('/api/auth/me');
    state.session = response.ok && payload.ok ? payload.user || null : null;
  } catch {
    state.session = null;
  }
}

async function loadRepos() {
  if (!state.session) {
    state.repos = [];
    return;
  }
  try {
    const { response, payload } = await fetchJson('/api/repos');
    state.repos = response.ok && payload.ok ? payload.data || [] : [];
  } catch {
    state.repos = [];
  }
}

async function loadTrends() {
  state.trends = [];
  if (!state.session || !state.repoData?.owner || !state.repoData?.repo) return;
  try {
    const days = state.win === '7d' ? 7 : state.win === '90d' ? 90 : 30;
    const { response, payload } = await fetchJson(`/api/trends/${state.repoData.owner}/${state.repoData.repo}?days=${days}`);
    state.trends = response.ok && payload.ok ? payload.data || [] : [];
  } catch {
    state.trends = [];
  }
}

async function verifyProfileRoutes() {
  const owner = state.repoData?.owner;
  const repo = state.repoData?.repo;
  if (!owner || !repo) {
    state.profileRouteStatus = 'Run a check while signed in to verify profile routes.';
    render();
    return;
  }

  const username = String(state.session?.email || '').split('@')[0];
  const query = `owner=${encodeURIComponent(owner)}&repo=${encodeURIComponent(repo)}${username ? `&username=${encodeURIComponent(username)}` : ''}`;

  try {
    const { response, payload } = await fetchJson(`/api/profile/routes/check?${query}`);
    if (response.ok && payload.ok) {
      const uStatus = Number(payload.data?.u?.status);
      state.profileRouteStatus = uStatus === 302
        ? 'Route check passed. /u redirects to your latest public profile.'
        : 'Route check passed for /p and /u.';
    } else if (response.status === 401) {
      state.profileRouteStatus = 'Sign in required for route verification.';
    } else if (response.status === 403) {
      state.profileRouteStatus = 'No access to one or more profile routes.';
    } else {
      state.profileRouteStatus = 'Route check could not be completed right now.';
    }
  } catch {
    state.profileRouteStatus = 'Route verification failed due to a network error.';
  }
  render();
}

function statePill() {
  if (state.loading) return '<span class="state-pill loading">Checking repository signals</span>';
  if (state.tone === 'ok') return '<span class="state-pill success">Result ready</span>';
  if (state.tone === 'error') return '<span class="state-pill error">Action needed</span>';
  return '<span class="state-pill">Paste a repo URL to begin</span>';
}

function checkView() {
  const score = Number(state.repoData?.proofScore || 0);
  const signalRelease = state.repoData?.signals?.releaseRecency ?? '—';
  const signalCi = state.repoData?.signals?.ciFreshness ?? '—';
  const signalIssue = state.repoData?.signals?.issueResponsiveness ?? '—';
  const e = embed();
  const activeSnippet = state.tab === 'iframe' ? e.iframe : e.svg;
  const profileUrl = state.repoData?.owner && state.repoData?.repo ? `${location.origin}/p/${state.repoData.owner}/${state.repoData.repo}` : '';

  return `<section class="panel header"><h2>Check build proof in seconds</h2><p>Paste any public GitHub repo to run a fresh reliability check, inspect proof signals, and copy production-ready embed code.</p><div class="row">${statePill()}</div>${state.status ? `<div class="alert ${state.tone}" role="status" aria-live="polite">${state.status}</div>` : ''}</section>
  <section class="panel grid two">
    <article class="card">
      <h3>1) Check repository</h3>
      <label>GitHub repository URL<input id="repo" value="${state.repoUrl}" placeholder="https://github.com/owner/repo" aria-label="GitHub repository URL"/></label>
      <label>Manual uptime (optional)<input id="up" value="${state.uptime}" aria-label="Manual uptime"/></label>
      <p class="sub">Tool-first flow: paste URL, run check, copy output.</p>
      <div class="row"><button class="btn pri" data-a="gen">Check repository</button><button class="btn gh" data-a="example">See example</button></div>
    </article>
    <article class="card">
      <h3>2) View proof score</h3>
      <div class="ring" style="--s:${score}"><span>${score}</span></div>
      <p class="sub">Release recency ${signalRelease} · CI freshness ${signalCi} · Issue responsiveness ${signalIssue}</p>
    </article>
  </section>

  <section class="panel grid two">
    <article class="card">
      <h3>3) Embed badge</h3>
      <div class="grid two">
        <label>Theme<select id="theme">${['dark', 'light', 'sunset'].map((v) => `<option value="${v}" ${state.theme === v ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
        <label>Size<select id="size">${['sm', 'md', 'lg'].map((v) => `<option value="${v}" ${state.size === v ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
      </div>
      <div class="tabs"><button class="tab ${state.tab === 'iframe' ? 'active' : ''}" data-a="tab" data-t="iframe">Iframe</button><button class="tab ${state.tab === 'svg' ? 'active' : ''}" data-a="tab" data-t="svg">SVG badge</button></div>
      <pre>${escapeSnippet(activeSnippet)}</pre>
      <div class="row"><button class="btn sec" data-a="copy">Copy embed code</button><button class="btn gh" data-a="copy-badge">Copy badge URL</button></div>
    </article>
    <article class="card">
      <h3>4) Share this proof</h3>
      <p class="sub">Use profile links in docs, README files, and social posts.</p>
      <div class="row"><button class="btn sec" data-a="share" data-k="copy" ${profileUrl ? '' : 'disabled'}>Copy profile link</button><button class="btn gh" data-a="share" data-k="x" ${profileUrl ? '' : 'disabled'}>Share to X</button></div>
      <p class="sub">${profileUrl || 'Run a check while signed in to generate a shareable profile link.'}</p>
    </article>
  </section>

  <details class="panel"><summary>Details: trends and recent checks</summary>
    <section class="grid two details-grid">
      <article class="card"><h3>Trends (${state.win})</h3><div class="row">${['7d', '30d', '90d'].map((w) => `<button class="btn ${state.win === w ? 'pri' : 'gh'}" data-a="win" data-w="${w}">${w}</button>`).join('')}</div><div class="trend">${state.trends.length ? state.trends.map((x) => `<div class="tr"><span class="sub">${new Date(x.capturedAt).toLocaleDateString()}</span><div class="bar"><i style="width:${Math.min(100, Number(x.proofScore || 0))}%"></i></div><strong>${x.proofScore}</strong></div>`).join('') : '<p class="sub">No trend data yet. Run another check to build history.</p>'}</div></article>
      <article class="card"><h3>Recent checks</h3>${state.repos.length ? state.repos.slice(0, 10).map((r) => `<p class="sub">${r.owner}/${r.repo} · Proof ${r.proofScore}</p>`).join('') : '<p class="sub">No saved checks yet.</p>'}</article>
    </section>
  </details>`;
}

function profilesView() {
  const profileUrl = state.repoData?.owner && state.repoData?.repo ? `${location.origin}/p/${state.repoData.owner}/${state.repoData.repo}` : '';
  const username = String(state.session?.email || '').split('@')[0];
  const userUrl = username ? `${location.origin}/u/${username}` : '';

  return `<section class="panel header"><h2>Profiles</h2><p>Shareable proof pages and route checks for your verified repositories.</p></section>
  <section class="panel grid two">
    <article class="card"><h3>Repository profile</h3><p class="sub">${profileUrl || 'No profile link yet. Run a repository check first.'}</p><div class="row"><button class="btn sec" data-a="share" data-k="copy" ${profileUrl ? '' : 'disabled'}>Copy /p link</button><button class="btn gh" data-a="check-routes">Check routes</button></div>${state.profileRouteStatus ? `<p class="sub">${state.profileRouteStatus}</p>` : ''}</article>
    <article class="card"><h3>Account profile</h3><p class="sub">${userUrl || 'Sign in to access your /u profile route.'}</p><div class="row"><button class="btn sec" data-a="share" data-k="copy-u" ${userUrl ? '' : 'disabled'}>Copy /u link</button></div></article>
  </section>`;
}

function authView() {
  const mode = state.route.endsWith('signup') ? 'signup' : 'login';
  return `<section class="panel header"><h2>${mode === 'signup' ? 'Create account' : 'Sign in to your account'}</h2><p>Authenticate once to unlock generated results and repository profiles.</p></section><section class="panel"><label>Email<input id="em" type="email"/></label><label>Password<input id="pw" type="password"/></label><div class="row"><button class="btn pri" data-a="auth" data-m="${mode}">Continue</button>${state.session ? '<button class="btn gh" data-a="logout">Log out</button>' : ''}</div>${state.authError ? `<div class="alert error">${state.authError}</div>` : ''}<p class="sub"><button class="btn gh" data-n="auth/${mode === 'signup' ? 'login' : 'signup'}">${mode === 'signup' ? 'Already have an account? Log in' : 'Need an account? Create one'}</button></p></section>`;
}

function view() {
  if (state.route === 'profiles') return profilesView();
  if (state.route.startsWith('auth/')) return authView();
  return checkView();
}

function shell() {
  return `<div class="app"><header class="topbar"><div class="brand"><h1>Build Proof Checker</h1><p>Generate trustworthy proof-of-build widgets for your public repos.</p></div><nav class="nav" aria-label="Primary">${[['check', 'Check'], ['profiles', 'Profiles'], ['auth/login', state.session ? 'Account' : 'Sign in']].map(([k, l]) => `<button data-n="${k}" class="${state.route === k || (k === 'auth/login' && state.route.startsWith('auth/')) ? 'active' : ''}">${l}</button>`).join('')}</nav><div class="chip">${state.session ? `Signed in as <strong>${state.session.email}</strong>` : 'Not signed in.'}</div></header><main class="main">${view()}</main></div>`;
}

function authModal() {
  if (!state.authModalOpen) return '';
  const mode = state.authMode;
  return `<div class="modalbg"><div class="modal"><h3>Sign in required to view this result</h3><p class="sub">Your check completed. Sign up or log in to reveal the score and embed options.</p><label>Email<input id="gate-em" type="email" placeholder="you@company.com"/></label><label>Password<input id="gate-pw" type="password" placeholder="At least 8 characters"/></label>${state.authError ? `<div class="alert error">${state.authError}</div>` : ''}<div class="row"><button class="btn pri" data-a="auth-gate" data-m="${mode}">${mode === 'signup' ? 'Sign up and reveal' : 'Log in and reveal'}</button><button class="btn gh" data-a="toggle-gate-mode">${mode === 'signup' ? 'I already have an account' : 'I need to create an account'}</button><button class="btn gh" data-a="dismiss-gate">Not now</button></div></div></div>`;
}

function render() {
  app.innerHTML = shell();
  modalRoot.innerHTML = authModal();
}

async function executeGenerate(repoUrl, uptime) {
  state.uptime = uptime || '';
  state.status = 'Checking repository…';
  state.tone = 'info';
  state.loading = true;
  trackFunnel('generate_click', { repo: repoUrl });
  render();

  try {
    const { response, payload } = await fetchJson(`/api/metrics?repoUrl=${encodeURIComponent(repoUrl)}`);
    if (!response.ok || !payload.ok) {
      if (response.status === 401 && payload.gated) {
        state.pendingGenerate = { repoUrl, uptime: state.uptime };
        trackFunnel('auth_gate_required', { reason: 'results_auth_required', repo: repoUrl });
        openAuthGate('api_gated');
        return;
      }
      throw new Error(payload.error || 'Failed');
    }

    state.repoData = payload.data;
    state.status = 'Build proof generated.';
    state.tone = 'ok';
    trackFunnel('reveal_success', { owner: payload.data.owner, repo: payload.data.repo });
    await Promise.all([loadRepos(), loadTrends()]);
  } catch (e) {
    state.status = e.message || 'Failed';
    state.tone = 'error';
  } finally {
    state.loading = false;
  }

  render();
}

async function gen() {
  state.repoUrl = document.getElementById('repo')?.value.trim() || state.repoUrl;
  state.uptime = document.getElementById('up')?.value.trim() || state.uptime;
  if (!state.repoUrl) {
    state.status = 'GitHub repository URL required.';
    state.tone = 'error';
    render();
    return;
  }
  await executeGenerate(state.repoUrl, state.uptime);
}

async function applyAuth(mode, email, password) {
  const em = (email || '').trim().toLowerCase();
  const pw = password || '';
  trackFunnel(mode === 'signup' ? 'signup_submit' : 'login_submit', { entry: state.authModalOpen ? 'gate_modal' : 'auth_route' });

  if (!em || !/.+@.+\..+/.test(em)) {
    state.authError = 'Enter a valid email.';
    render();
    return false;
  }
  if (pw.length < 8) {
    state.authError = 'Password min 8 chars.';
    render();
    return false;
  }

  try {
    const endpoint = mode === 'signup' ? '/api/auth/signup' : '/api/auth/login';
    const { response, payload } = await fetchJson(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: em, password: pw }),
    });

    if (!response.ok || !payload.ok) {
      state.authError = payload.error || 'Authentication failed.';
      render();
      return false;
    }

    await hydrateSession();
    state.authError = '';
    return true;
  } catch {
    state.authError = 'Authentication failed.';
    render();
    return false;
  }
}

document.addEventListener('click', async (e) => {
  const t = e.target.closest('[data-a],[data-n]');
  if (!t) return;

  const n = t.getAttribute('data-n');
  if (n) return setRoute(n);

  const a = t.getAttribute('data-a');
  if (a === 'gen') {
    await gen();
  } else if (a === 'example') {
    state.repoUrl = 'https://github.com/vercel/next.js';
    state.status = 'Example loaded. Click “Check repository”.';
    state.tone = 'info';
    render();
  } else if (a === 'tab') {
    state.tab = t.getAttribute('data-t') || 'iframe';
    render();
  } else if (a === 'win') {
    state.win = t.getAttribute('data-w') || '30d';
    await loadTrends();
    render();
  } else if (a === 'copy') {
    try {
      await navigator.clipboard.writeText(state.tab === 'iframe' ? embed().iframe : embed().svg);
      state.status = 'Embed code copied.';
      state.tone = 'ok';
    } catch {
      state.status = 'Clipboard unavailable.';
      state.tone = 'error';
    }
    render();
  } else if (a === 'copy-badge') {
    try {
      await navigator.clipboard.writeText(embed().badgeUrl);
      state.status = 'Badge URL copied.';
      state.tone = 'ok';
    } catch {
      state.status = 'Copy failed.';
      state.tone = 'error';
    }
    render();
  } else if (a === 'share') {
    const kind = t.getAttribute('data-k');
    const profileUrl = state.repoData?.owner && state.repoData?.repo ? `${location.origin}/p/${state.repoData.owner}/${state.repoData.repo}` : '';
    if (kind === 'copy') {
      if (!profileUrl) {
        state.status = 'Run a check first.';
        state.tone = 'error';
      } else {
        await navigator.clipboard.writeText(profileUrl);
        state.status = 'Profile link copied.';
        state.tone = 'ok';
      }
    } else if (kind === 'copy-u') {
      const username = String(state.session?.email || '').split('@')[0];
      const userUrl = username ? `${location.origin}/u/${username}` : '';
      if (!userUrl) {
        state.status = 'Sign in to copy your /u link.';
        state.tone = 'error';
      } else {
        await navigator.clipboard.writeText(userUrl);
        state.status = 'User profile link copied.';
        state.tone = 'ok';
      }
    } else if (kind === 'x' && profileUrl) {
      window.open(`https://x.com/intent/tweet?text=${encodeURIComponent(`Build proof for ${currentRepoSlug() || 'repo'}: ${profileUrl}`)}`, '_blank', 'noopener,noreferrer');
      state.status = 'Opened X share.';
      state.tone = 'info';
    }
    render();
  } else if (a === 'check-routes') {
    await verifyProfileRoutes();
  } else if (a === 'auth') {
    const mode = t.getAttribute('data-m') || 'login';
    if (await applyAuth(mode, document.getElementById('em')?.value, document.getElementById('pw')?.value)) {
      await Promise.all([loadRepos(), loadTrends()]);
      setRoute('check');
    }
  } else if (a === 'logout') {
    await fetch('/api/auth/logout', { method: 'POST' });
    state.session = null;
    state.repos = [];
    state.status = 'Signed out.';
    state.tone = 'ok';
    render();
  } else if (a === 'toggle-gate-mode') {
    state.authMode = state.authMode === 'signup' ? 'login' : 'signup';
    state.authError = '';
    render();
  } else if (a === 'dismiss-gate') {
    state.authModalOpen = false;
    state.authError = '';
    state.status = 'Sign in required to reveal this result.';
    state.tone = 'info';
    render();
  } else if (a === 'auth-gate') {
    const mode = t.getAttribute('data-m') || state.authMode;
    const ok = await applyAuth(mode, document.getElementById('gate-em')?.value, document.getElementById('gate-pw')?.value);
    if (!ok) return;

    state.authModalOpen = false;
    const pending = state.pendingGenerate;
    state.pendingGenerate = null;
    setRoute('check');

    if (pending) {
      trackFunnel('reveal_attempt_after_auth', { mode });
      await executeGenerate(pending.repoUrl, pending.uptime);
    }
  }
});

document.addEventListener('change', (e) => {
  if (e.target.id === 'theme') {
    state.theme = e.target.value;
    render();
  }
  if (e.target.id === 'size') {
    state.size = e.target.value;
    render();
  }
});

window.addEventListener('hashchange', () => {
  initRoute();
  render();
});

(async () => {
  initRoute();
  if (!location.hash) setRoute('check');
  await hydrateSession();
  await Promise.all([loadRepos(), loadTrends()]);
  render();
})();

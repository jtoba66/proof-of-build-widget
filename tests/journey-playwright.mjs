import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
const outDir = process.env.OUT_DIR || path.resolve(`artifacts/journey-qa-${new Date().toISOString().slice(0, 10)}-full`);

const result = {
  baseUrl,
  startedAt: new Date().toISOString(),
  steps: [],
  screenshots: [],
  bugs: [],
  passed: true,
};

function step(name, pass, details = '') {
  result.steps.push({ name, pass, details });
  if (!pass) result.passed = false;
}

async function snap(page, name) {
  const file = path.join(outDir, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  result.screenshots.push(file);
}

async function run() {
  await fs.mkdir(outDir, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  const email = `qa_${Date.now()}@example.com`;
  const password = 'password123';
  const repoUrl = 'https://github.com/nodejs/node';

  try {
    await page.goto(baseUrl, { waitUntil: 'networkidle' });
    await page.waitForSelector('h1:has-text("Build Proof Checker")');
    await page.waitForSelector('h3:has-text("1) Check repository")');
    step('1) Landing/check page (signed out)', true, 'Loaded check route while signed out.');
    await snap(page, '01-landing-check-signed-out');

    await page.fill('#repo', repoUrl);
    await page.click('button:has-text("Check repository")');
    const authGateHeading = page.locator('.modal h3');
    await authGateHeading.waitFor({ timeout: 15000 });
    const gateVisible = await authGateHeading.isVisible();
    step('2) Auth gate modal appears before reveal', gateVisible, 'Gate visible after repo check.');
    await snap(page, '02-auth-gate-before-reveal');

    await page.click('button:has-text("Not now")');
    await page.waitForTimeout(250);

    await page.click('button[data-n="auth/login"]');
    await page.waitForSelector('h2:has-text("Sign in to your account")');
    step('3) Login page/state reachable', true, 'Sign in screen loaded.');
    await snap(page, '03-login-page-state');

    await page.fill('#em', `missing_${Date.now()}@example.com`);
    await page.fill('#pw', 'wrongpass1');
    await page.click('button[data-a="auth"][data-m="login"]');
    await page.waitForSelector('.alert.error', { timeout: 10000 });
    const loginError = (await page.locator('.alert.error').innerText()).trim();
    step('4) Error/fallback state encountered (invalid login)', /invalid|failed|not found|error/i.test(loginError), loginError);
    await snap(page, '04-error-state-invalid-login');

    await page.click('button[data-n="auth/signup"]');
    await page.waitForSelector('h2:has-text("Create account")');
    step('5) Signup page/state reachable', true, 'Create account screen loaded.');
    await snap(page, '05-signup-page-state');

    await page.fill('#em', email);
    await page.fill('#pw', password);
    await page.click('button[data-a="auth"][data-m="signup"]');
    await page.waitForSelector(`text=${email}`);

    await page.click('button[data-n="check"]');
    await page.fill('#repo', repoUrl);
    await page.click('button:has-text("Check repository")');
    await page.waitForSelector('text=Build proof generated.', { timeout: 30000 });

    const scoreAfter = Number((await page.locator('.ring span').innerText()).trim());
    const hasSignals = await page.locator('p.sub:has-text("Release recency")').isVisible();
    step('6) Post-auth revealed results page', Number.isFinite(scoreAfter) && scoreAfter >= 0 && hasSignals, `score=${scoreAfter}`);
    await snap(page, '06-post-auth-revealed-results');

    await page.click('button:has-text("SVG badge")');
    await page.selectOption('#theme', 'sunset');
    await page.selectOption('#size', 'lg');
    step('7) Embed builder area visible and interactive', await page.locator('pre').isVisible(), 'Badge snippet visible.');
    await snap(page, '07-embed-builder-area');

    const detailsEl = page.locator('details:has(summary:has-text("Details: trends and recent checks"))');
    await detailsEl.evaluate((el) => { el.open = true; });
    const trendButton = page.locator('button[data-a="win"][data-w="7d"]');
    const trendButtonVisible = await trendButton.isVisible();
    if (trendButtonVisible) await trendButton.click();
    await page.waitForTimeout(300);
    step('8) Trends view accessible', trendButtonVisible, '7d trends window control visible.');
    await snap(page, '08-trends-view');

    await page.click('button[data-n="profiles"]');
    await page.waitForSelector('h2:has-text("Profiles")');
    step('9) Profile page/state accessible while signed in', true, 'Profiles route loaded.');
    await snap(page, '09-profile-page-state');

    await page.click('button[data-n="auth/login"]');
    await page.waitForSelector('button:has-text("Log out")');
    await page.click('button:has-text("Log out")');
    await page.click('button[data-n="profiles"]');
    await page.click('button:has-text("Check routes")');
    await page.waitForTimeout(800);
    const signedOutStatus = (await page.locator('article.card p.sub').allInnerTexts()).join(' | ');
    const fallbackOk = /Sign in required/i.test(signedOutStatus);
    step('10) Signed-out fallback/profile access state', fallbackOk, signedOutStatus);
    await snap(page, '10-signed-out-profile-fallback');

    if (!fallbackOk) {
      result.bugs.push({
        severity: 'high',
        title: 'Signed-out profile route does not show auth-required fallback',
        repro: ['Log in', 'Open Profiles', 'Log out', 'Check routes', 'Expected sign-in-required status'],
      });
    }
  } catch (err) {
    step('Journey execution', false, err.message);
    result.bugs.push({ severity: 'high', title: 'Journey execution failure', repro: [err.message] });
  } finally {
    await browser.close();
  }

  result.finishedAt = new Date().toISOString();
  await fs.writeFile(path.join(outDir, 'journey-results.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}

run();

import { chromium, firefox } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const base = process.env.BASE_URL || 'http://localhost:3000';
const repo = 'https://github.com/nodejs/node';

function decodeHtml(value) {
  return String(value || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

async function run(browserType, name) {
  const browser = await browserType.launch({ headless: true });
  const context = name === 'firefox'
    ? await browser.newContext()
    : await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage();
  const email = `qa_${name}_${Date.now()}@example.com`;
  const password = 'password123';

  const t0 = Date.now();
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.waitForSelector('h1:has-text("Build Proof Checker")');

  await page.fill('#repo', repo);
  await page.click('button[data-a="gen"]');
  await page.waitForSelector('.modal h3:has-text("Sign in required")', { timeout: 15000 });

  await page.fill('#gate-em', email);
  await page.fill('#gate-pw', password);
  await page.click('button[data-a="auth-gate"]');

  await page.waitForSelector('text=Build proof generated.', { timeout: 30000 });
  await page.waitForSelector('.ring span');
  const elapsedMs = Date.now() - t0;

  await page.click('button[data-a="copy"]');
  const statusText = (await page.locator('.alert[role="status"]').innerText().catch(() => '')).trim();

  const escapedSnippet = await page.locator('pre').innerText();
  const snippet = decodeHtml(escapedSnippet);
  let copied = null;
  if (name !== 'firefox') {
    copied = await page.evaluate(async () => {
      try { return await navigator.clipboard.readText(); } catch { return null; }
    });
  }

  await page.screenshot({ path: `qa-${name}-main.png`, fullPage: true });

  const htmlPath = path.resolve(`embed-${name}.html`);
  fs.writeFileSync(htmlPath, `<!doctype html><html><body><h1>Blank Host</h1>${snippet}</body></html>`);
  await page.goto(`file://${htmlPath}`, { waitUntil: 'load' });
  await page.waitForSelector('iframe', { timeout: 10000 });
  const iframeSrc = await page.getAttribute('iframe', 'src');
  await page.screenshot({ path: `qa-${name}-embed.png`, fullPage: true });

  await browser.close();
  return {
    name,
    elapsedMs,
    gateTriggered: true,
    statusText,
    copied,
    snippetContainsIframe: snippet.includes('<iframe'),
    iframeSrc,
  };
}

const results = [];
for (const [type, name] of [[chromium, 'chromium'], [firefox, 'firefox']]) {
  try {
    results.push(await run(type, name));
  } catch (e) {
    results.push({ name, error: String(e) });
  }
}

fs.writeFileSync('qa-playwright-results.json', JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));

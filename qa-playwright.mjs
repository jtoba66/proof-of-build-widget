import { chromium, firefox } from 'playwright';
import fs from 'fs';

const base = 'http://localhost:3000';
const repo = 'https://github.com/nodejs/node';

async function run(browserType, name) {
  const browser = await browserType.launch({ headless: true });
  const context = name === 'firefox'
    ? await browser.newContext()
    : await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage();

  const t0 = Date.now();
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.fill('#repoUrl', repo);
  await page.fill('#uptimeText', '99.7% (manual)');
  await page.click('button[type="submit"]');
  await page.waitForSelector('#result:not(.hidden)', { timeout: 10000 });
  const elapsedMs = Date.now() - t0;

  await page.click('#copyBtn');
  const statusText = await page.textContent('#status');
  const copied = await page.evaluate(async () => {
    try { return await navigator.clipboard.readText(); } catch { return null; }
  });
  const snippet = await page.inputValue('#snippet');

  await page.screenshot({ path: `qa-${name}-main.png`, fullPage: true });

  // Render snippet in blank page
  const htmlPath = `embed-${name}.html`;
  fs.writeFileSync(htmlPath, `<!doctype html><html><body><h1>Blank Host</h1>${snippet}</body></html>`);
  await page.goto(`file://${process.cwd()}/${htmlPath}`, { waitUntil: 'load' });
  await page.waitForSelector('iframe', { timeout: 5000 });
  let widgetTitle = null;
  try {
    const frame = page.frameLocator('iframe');
    widgetTitle = await frame.locator('text=Proof of Build').first().textContent({ timeout: 5000 });
  } catch {
    widgetTitle = 'not-readable-via-frameLocator';
  }
  const iframeSrc = await page.getAttribute('iframe', 'src');
  await page.screenshot({ path: `qa-${name}-embed.png`, fullPage: true });

  await browser.close();
  return { name, elapsedMs, statusText, copied, snippetContainsIframe: snippet.includes('<iframe'), widgetTitle, iframeSrc };
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

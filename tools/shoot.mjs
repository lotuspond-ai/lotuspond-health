// Headless screenshots for visual review: node tools/shoot.mjs [url] [outdir]
import { createRequire } from 'module';
const { chromium } = createRequire(import.meta.url)('playwright');
const url = process.argv[2] ?? 'http://localhost:4173/';
const out = process.argv[3] ?? 'shots';
const steps = JSON.parse(process.argv[4] ?? '[]');
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const logs = [];
page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') logs.push(`${m.type()}: ${m.text().slice(0, 300)}`); });
page.on('pageerror', e => logs.push(`PAGEERROR: ${e.message}`));
await page.goto(url, { waitUntil: 'networkidle' });
for (const s of steps) {
  if (s.click) await page.click(s.click, { timeout: 15000 });
  if (s.files) await page.setInputFiles(s.files[0], s.files.slice(1));
  if (s.eval) await page.evaluate(s.eval);
  if (s.wait) await page.waitForTimeout(s.wait);
  if (s.waitFor) await page.waitForSelector(s.waitFor, { timeout: 60000 });
  if (s.vp) await page.setViewportSize(s.vp);
  if (s.shot) await page.screenshot({ path: `${out}/${s.shot}.png`, fullPage: !!s.full });
}
console.log(logs.join('\n') || 'no console errors');
await browser.close();

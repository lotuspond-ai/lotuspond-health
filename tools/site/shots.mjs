// Product imagery for the public website, captured from the running app and saved as WebP in public/site/,
// then the social preview image (public/site/og.png, 1200×630) rendered from tools/site/og.html.
//
//   node tools/site/shots.mjs [app-url] [--og-only]
//
// app-url is the dev stack (default http://localhost:5173/). The script signs up a demo account, loads the sample
// data, uploads the fixtures and adds a family member, then captures the body map, an organ, a result's history,
// the files list and the profile menu. Re-run it after visible changes to the app.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const { chromium } = createRequire(import.meta.url)('playwright');
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const out = path.join(root, 'public/site');
const fixtures = path.join(root, 'tools/fixtures');
const args = process.argv.slice(2);
const ogOnly = args.includes('--og-only');
const base = new URL(args.find(a => !a.startsWith('--')) ?? 'http://localhost:5173/');
fs.mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });

/** PNG to WebP at the given widths, encoded by Chromium's own canvas encoder (no image tooling needed). */
const encoder = await browser.newPage();
async function saveWebp(png, name, widths, quality = 0.82) {
  for (const width of widths) {
    const b64 = await encoder.evaluate(async ({ data, width, quality }) => {
      const blob = await (await fetch(`data:image/png;base64,${data}`)).blob();
      const probe = await createImageBitmap(blob);
      const w = Math.min(width, probe.width), h = Math.round(probe.height * (w / probe.width));
      const bitmap = await createImageBitmap(blob, { resizeWidth: w, resizeHeight: h, resizeQuality: 'high' });
      const canvas = new OffscreenCanvas(w, h);
      canvas.getContext('2d').drawImage(bitmap, 0, 0);
      const webp = await canvas.convertToBlob({ type: 'image/webp', quality });
      const data64 = await new Promise(res => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.readAsDataURL(webp); });
      return { data64, w, h };
    }, { data: png.toString('base64'), width, quality });
    const file = path.join(out, `${name}-${b64.w}.webp`);
    fs.writeFileSync(file, Buffer.from(b64.data64, 'base64'));
    console.log(`  ${path.relative(root, file)}  ${b64.w}×${b64.h}  ${(fs.statSync(file).size / 1024).toFixed(0)} KB`);
  }
}

if (!ogOnly) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1.5 });
  const page = await context.newPage();
  page.setDefaultTimeout(120000);
  page.on('pageerror', e => console.warn('page error:', e.message));
  const settle = async (ms = 1200) => {
    await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined));
    await page.waitForTimeout(ms);
  };
  // Clip to an element's box (element screenshots wait for a stable box, which the animated stage never has).
  // `inset` trims rounded corners off the crop.
  const shotOf = async (locator, maxHeight = Infinity, inset = 0) => {
    const b = await locator.boundingBox();
    return page.screenshot({ clip: { x: b.x + inset, y: b.y + inset, width: b.width - 2 * inset, height: Math.min(b.height, maxHeight) - 2 * inset } });
  };
  const nav = name => page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name, exact: true }).click();

  console.log(`Signing up a demo account on ${base.href}`);
  await page.goto(new URL('signup', base).href, { waitUntil: 'networkidle' });
  if (!(await page.getByLabel('Your name').isVisible())) await page.getByRole('tab', { name: 'Create account' }).click();
  await page.getByLabel('Your name').fill('Asha Rao');
  await page.getByLabel('Email').fill(`demo.${Date.now()}@example.com`);
  await page.getByLabel('Password', { exact: true }).fill('lotus pond lily pad');
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await page.getByRole('heading', { name: /Welcome, Asha/ }).waitFor();
  await page.getByLabel('Date of birth').fill('1988-04-12');
  await page.getByRole('radio', { name: 'Female' }).click();
  await page.getByLabel('Height').fill('164');
  await page.getByLabel('Weight').fill('61');
  await page.getByRole('button', { name: 'Continue to your body map' }).click();
  await page.getByRole('button', { name: 'Explore with sample data' }).click();
  await page.getByRole('heading', { name: 'Overview' }).waitFor();

  await page.getByRole('button', { name: 'Upload', exact: true }).click();
  await page.locator('input[type=file]').setInputFiles(['sample-lab-report.pdf', 'results-export.csv', 'chest-xray-synthetic.dcm'].map(f => path.join(fixtures, f)));
  await page.getByRole('heading', { name: 'Check what was read' }).waitFor({ timeout: 180000 });
  await page.getByRole('button', { name: /^Add \d+ results/ }).click();
  await page.locator('.toast').filter({ hasText: /Added/ }).waitFor();

  // A family member, so the profile menu shows how one account holds several people.
  await page.locator('.pmenu__trigger').click();
  await page.getByRole('menuitem', { name: 'Add a family member' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add a family member' });
  await dialog.getByLabel('Name').fill('Mira Rao');
  await dialog.getByLabel('Who are they to you?').selectOption('child');
  await dialog.getByLabel('Date of birth').fill('2019-06-01');
  await dialog.getByRole('button', { name: 'Add and open their records' }).click();
  await page.getByRole('heading', { name: 'Start Mira’s record' }).waitFor();
  await page.locator('.pmenu__trigger').click();
  await page.getByRole('menuitemradio', { name: /Asha Rao/ }).click();
  await page.getByRole('heading', { name: 'Overview' }).waitFor();
  // Still frames: no toasts, no CSS animations caught halfway, and chart labels at the edge left uncut.
  await page.addStyleTag({ content: '.toasts { display: none !important; } *, *::before, *::after { animation-duration: 0s !important; animation-delay: 0s !important; transition: none !important; } svg.trend { overflow: visible; }' });

  console.log('Capturing');
  await settle(4000);
  await saveWebp(await page.screenshot(), 'body-map', [960, 1600, 2160]);

  await page.locator('.organ-link').filter({ hasText: 'Heart' }).first().click();
  await settle(4000);
  await saveWebp(await shotOf(page.locator('.stage'), Infinity, 14), 'organ-heart', [640, 1026]);

  await page.getByRole('button', { name: 'Whole body' }).click();
  await settle(2500);
  await page.locator('.context').getByText('LDL cholesterol', { exact: true }).first().click();
  await page.locator('.drawer').waitFor();
  await settle(1500);
  // From the marker's name down to the end of its chart.
  const drawer = await page.locator('.drawer').boundingBox();
  const chart = await page.locator('.drawer svg.trend').boundingBox();
  await saveWebp(await shotOf(page.locator('.drawer'), chart.y + chart.height + 28 - drawer.y), 'marker-history', [520, 780]);
  await page.keyboard.press('Escape');
  await page.locator('.drawer').waitFor({ state: 'detached' }).catch(() => {});

  await nav('Files');
  await page.getByRole('heading', { name: 'Files', exact: true }).waitFor();
  await settle();
  await saveWebp(await page.screenshot({ clip: { x: 100, y: 70, width: 1240, height: 420 } }), 'files', [720, 1240]);

  // The profile menu on a transparent background (taken here, where the 3D stage is not rendering).
  const hideBehind = await page.addStyleTag({ content: '.app > :not(.topbar), .topbar .btn--primary { visibility: hidden; } html, body, #root, .app, .topbar { background: transparent !important; }' });
  await page.locator('.pmenu__trigger').click();
  await page.locator('.pmenu__foot').evaluate(el => { el.textContent = 'asha.rao@example.com'; }); // instead of the throwaway demo address
  await settle(500);
  const panel = await page.locator('.pmenu__panel').boundingBox();
  const trigger = await page.locator('.pmenu__trigger').boundingBox();
  const x = Math.min(panel.x, trigger.x) - 28, y = trigger.y - 20;
  await saveWebp(await page.screenshot({ omitBackground: true, clip: { x, y, width: Math.max(panel.x + panel.width, trigger.x + trigger.width) + 28 - x, height: panel.y + panel.height + 28 - y } }), 'family', [400, 760]);
  await page.keyboard.press('Escape');
  await hideBehind.evaluate(el => el.remove());

  await nav('Body map');
  await settle(1500);

  await page.setViewportSize({ width: 390, height: 844 });
  await settle(4000);
  await saveWebp(await page.screenshot(), 'phone-body', [390, 585]);
  await context.close();
}

console.log('Rendering the social preview');
const og = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
await og.goto(pathToFileURL(path.join(here, 'og.html')).href, { waitUntil: 'networkidle' });
await og.evaluate(() => document.fonts.ready);
await og.screenshot({ path: path.join(out, 'og.png') });
console.log(`  public/site/og.png  ${(fs.statSync(path.join(out, 'og.png')).size / 1024).toFixed(0)} KB`);

await browser.close();

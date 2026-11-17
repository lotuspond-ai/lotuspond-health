// Product imagery for the public website, captured from the running app and saved as WebP in public/site/,
// then the social preview image (public/site/og.png, 1200×630) rendered from tools/site/og.html.
//
//   npm run local                                  (in one terminal)
//   node tools/site/shots.mjs [app-url] [--og-only] (in another; default http://localhost:8787/)
//
// The script signs up a demo account (Asha Rao), loads the sample data, connects Claude through the real OAuth
// consent screen, adds her daughter, then captures Home in a browser and on a phone, the body map, a result's
// history, the files list and the profile menu. Re-run it after visible changes to the app, and check the alt text in
// index.html still describes what the pictures show.
import crypto from 'node:crypto';
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
const base = new URL(args.find(a => !a.startsWith('--')) ?? 'http://localhost:8787/');
const at = p => new URL(p, base).href;
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

// Still frames: no toasts, no CSS animations caught halfway, and chart labels at the edge left uncut.
const STILL = '.toasts { display: none !important; } *, *::before, *::after { animation-duration: 0s !important; animation-delay: 0s !important; transition: none !important; } svg.trend { overflow: visible; }';

if (!ogOnly) {
  // 1280×800 at 2x: the hero's 1600×1000 shape, sharp at 2160 wide.
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, timezoneId: 'Asia/Kolkata' });
  await context.addInitScript(css => addEventListener('DOMContentLoaded', () => { const s = document.createElement('style'); s.textContent = css; document.head.append(s); }), STILL);
  const page = await context.newPage();
  page.setDefaultTimeout(120000);
  page.on('pageerror', e => console.warn('page error:', e.message));
  const settle = async (ms = 1200) => {
    await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined));
    await page.waitForTimeout(ms);
  };
  const clipTo = (b, height = b.height) => page.screenshot({ clip: { x: b.x, y: b.y, width: b.width, height } });
  const nav = async name => { await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name, exact: true }).click(); await settle(); };

  console.log(`Signing up a demo account on ${base.href}`);
  await page.goto(at('signup'), { waitUntil: 'networkidle' });
  await page.getByLabel('Your name').fill('Asha Rao');
  await page.getByLabel('Email', { exact: true }).fill(`demo.${Date.now()}@example.com`);
  await page.getByLabel('Password', { exact: true }).fill('lotus pond lily pad');
  await page.getByRole('combobox', { name: 'Country you live in' }).fill('ind');
  await page.getByRole('option', { name: /^India/ }).click();
  await page.getByRole('radio', { name: 'Yes' }).check(); // 18 or older
  await page.getByLabel(/I agree to the Terms of Use/).check();
  await page.getByLabel(/I consent to LotusPond processing my health data/).check();
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await page.getByRole('heading', { name: /Welcome, Asha/ }).waitFor();
  await page.getByLabel('Date of birth').fill('1988-04-12');
  await page.getByRole('radio', { name: 'Female' }).click();
  await page.getByLabel('Height').fill('164');
  await page.getByLabel('Weight').fill('61');
  await page.getByLabel('Blood type').selectOption('B+');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('button', { name: 'Skip for now' }).click();

  // The sample data is offered on the body map while a profile has no results.
  await nav('Records');
  await page.getByRole('button', { name: 'Body map', exact: true }).click();
  await page.getByRole('button', { name: 'Explore with sample data' }).click();
  await page.getByRole('heading', { name: /results? to look at/ }).waitFor();

  // Connect Claude the way claude.ai does: dynamic registration, PKCE, the consent screen, the token exchange.
  // Nothing leaves this computer: the redirect back to claude.ai is answered here.
  const redirect = 'https://claude.ai/api/mcp/auth_callback';
  await context.route(/^https:\/\/claude\.ai\//, r => r.fulfill({ status: 200, body: 'ok' }));
  const client = await (await page.request.post(at('oauth/register'), { data: { client_name: 'Claude', redirect_uris: [redirect], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] } })).json();
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const q = new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: 'S256', scope: 'health:read', state: 'site', resource: at('mcp') });
  await page.goto(at(`oauth/authorize?${q}`), { waitUntil: 'networkidle' });
  const [back] = await Promise.all([page.waitForRequest(r => r.url().startsWith(redirect)), page.getByRole('button', { name: 'Allow' }).click()]);
  const token = await page.request.post(at('oauth/token'), { form: { grant_type: 'authorization_code', code: new URL(back.url()).searchParams.get('code'), redirect_uri: redirect, client_id: client.client_id, code_verifier: verifier } });
  if (!token.ok()) throw new Error(`Connecting Claude failed: ${token.status()} ${await token.text()}`);
  await page.goto(at('app'), { waitUntil: 'networkidle' });

  // A family member, so the profile menu shows how one account holds several people.
  await page.locator('.pmenu__trigger').click();
  await page.getByRole('menuitem', { name: 'Add a family member' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add a family member' });
  await dialog.getByLabel('Name').fill('Mira Rao');
  await dialog.getByLabel('Who are they to you?').selectOption('child');
  await dialog.getByLabel('Date of birth').fill('2019-06-01');
  await dialog.getByRole('radio', { name: 'Female' }).click();
  await dialog.locator('.confirm-check input').check();
  await dialog.getByRole('button', { name: 'Add and open their records' }).click();
  await dialog.waitFor({ state: 'detached' });
  await page.locator('.pmenu__trigger').click();
  await page.getByRole('menuitemradio', { name: /Asha Rao/ }).click();

  console.log('Capturing');
  await nav('Home');
  await page.getByRole('heading', { name: /results? to look at/ }).waitFor();
  await settle(2000);
  await saveWebp(await page.screenshot(), 'home', [960, 1600, 2160]);

  // Agents on a phone, the hero's inset: 390×844 at 1.5x, with the same sign-in.
  const phone = await browser.newContext({ storageState: await context.storageState(), viewport: { width: 390, height: 844 }, deviceScaleFactor: 1.5, isMobile: true, hasTouch: true, timezoneId: 'Asia/Kolkata' });
  await phone.addInitScript(css => addEventListener('DOMContentLoaded', () => { const s = document.createElement('style'); s.textContent = css; document.head.append(s); }), STILL);
  const small = await phone.newPage();
  await small.goto(at('app'), { waitUntil: 'networkidle' });
  await small.getByRole('heading', { name: /results? to look at/ }).waitFor();
  await small.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Agents' }).click();
  await small.getByRole('heading', { name: 'Agents', exact: true }).waitFor();
  // The live address instead of this computer's.
  await small.locator('.agents__copy code').first().evaluate(el => { el.textContent = 'https://health.lotuspond.ai/mcp'; });
  await small.waitForTimeout(2000);
  await saveWebp(await small.screenshot(), 'phone-agents', [390, 585]);
  await phone.close();

  // The body map, cropped to the tile's portrait shape from its left edge.
  await nav('Records');
  await page.getByRole('button', { name: 'Body map', exact: true }).click();
  await settle(4000);
  const map = await page.locator('main.bodymap').boundingBox();
  await saveWebp(await clipTo({ ...map, width: Math.min(map.width, Math.round(map.height * 1026 / 1175)) }), 'body-map-tile', [640, 1026]);

  // A result's history: the drawer for LDL cholesterol, square, from its name down into the chart.
  await page.getByRole('button', { name: 'Results', exact: true }).click();
  await settle();
  await page.locator('main.page').getByText('LDL cholesterol', { exact: true }).first().click();
  await page.locator('.drawer').waitFor();
  await settle(1500);
  const drawer = await page.locator('.drawer').boundingBox();
  await saveWebp(await clipTo(drawer, Math.min(drawer.height, drawer.width)), 'marker-history', [520, 780]);
  await page.keyboard.press('Escape');
  await page.locator('.drawer').waitFor({ state: 'detached' }).catch(() => {});

  // A lab report PDF and a chest x-ray for the files list. Uploaded after the pictures above: the report's values
  // would crowd Home with flags.
  await page.getByRole('button', { name: 'Upload', exact: true }).first().click();
  await page.locator('input[type=file][multiple]').setInputFiles(['sample-lab-report.pdf', 'chest-xray-synthetic.dcm'].map(f => path.join(fixtures, f)));
  await page.getByRole('heading', { name: 'Check what was read' }).waitFor({ timeout: 180000 });
  await page.getByRole('button', { name: /^Add \d+ results/ }).click();
  await page.locator('.toast').filter({ hasText: /Added/ }).first().waitFor({ state: 'attached' });
  await page.getByRole('button', { name: 'Files', exact: true }).first().click();
  await page.getByRole('heading', { name: 'Files', exact: true }).waitFor();
  await settle();
  // The heading and the two cards, in the tile's 16:10 shape.
  const files = await page.locator('main.page').boundingBox();
  await saveWebp(await clipTo({ ...files, width: 640 }, 400), 'files', [720, 1240]);

  // The profile menu, from "Viewing records for" down to "Add a family member" (the account rows and email left out).
  await page.locator('.pmenu__trigger').click();
  await settle(500);
  const panel = await page.locator('.pmenu__panel').boundingBox();
  const add = await page.getByRole('menuitem', { name: 'Add a family member' }).boundingBox();
  await saveWebp(await clipTo(panel, add.y + add.height + 10 - panel.y), 'family', [400, 513]);
  await page.keyboard.press('Escape');
  await context.close();
}

console.log('Rendering the social preview');
const og = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
await og.goto(pathToFileURL(path.join(here, 'og.html')).href, { waitUntil: 'networkidle' });
await og.evaluate(() => document.fonts.ready);
await og.screenshot({ path: path.join(out, 'og.png') });
console.log(`  public/site/og.png  ${(fs.statSync(path.join(out, 'og.png')).size / 1024).toFixed(0)} KB`);

await browser.close();

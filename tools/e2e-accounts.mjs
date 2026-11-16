// End-to-end check of the public website, accounts, profiles, uploads and files in a real browser.
// Run against the dev stack (npm run dev), a production build (npm start) or the server-less preview
// (npm run build:artifact, then npx vite preview --outDir dist-artifact):
//   node tools/e2e-accounts.mjs [url] [screenshot-dir]
// With a server, it checks the landing, legal and 404 pages at desktop and phone widths, then signs up from the
// landing page's "Create free account". The preview has no website, so it starts at #signup instead.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = createRequire(import.meta.url)('playwright');
const url = new URL(process.argv[2] ?? 'http://localhost:5173/');
const at = p => new URL(p, url).href;
const out = process.argv[3] ?? 'shots';
const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
fs.mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
page.setDefaultTimeout(90000); // software WebGL on a busy machine can be slow to produce a frame
const problems = [];
let expectRejectedSignIn = false; // the wrong-password step makes the browser log a 401 on purpose
let expectNotFound = false; // so does the 404 page check, with a 404
page.on('console', m => {
  if (m.type() !== 'error') return;
  if (expectRejectedSignIn && m.text().includes('status of 401')) return;
  if (expectNotFound && m.text().includes('status of 404')) return;
  // Third-party map tiles (the development fallback) may be unreachable where this runs; the map copes.
  if (/^https:\/\/tile\.openstreetmap\.org\//.test(m.location()?.url ?? '')) return;
  // Without internet access (and without FACILITY_PROVIDER=fixture) area and nearby search answer 503; the app explains it.
  if (m.text().includes('status of 503') && /\/api\/(geo|facilities)\b/.test(m.location()?.url ?? '')) return;
  problems.push(`console (${page.url()}): ${m.text().slice(0, 300)}`);
});
page.on('pageerror', e => problems.push(`page error (${page.url()}): ${e.message}`));

let step = 0;
// Full-page shots re-render the 3D stage; allow for a slow software renderer on a busy machine.
async function shot(name, full = false) { await page.screenshot({ path: `${out}/${String(++step).padStart(2, '0')}-${name}.png`, fullPage: full, timeout: 120_000 }); }
function expect(ok, what) { if (!ok) problems.push(`FAILED: ${what}`); console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); }
const text = sel => page.locator(sel).first().innerText();
const sideScroll = () => page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
const pathOf = () => new URL(page.url()).pathname;
const mainNav = () => page.getByRole('navigation', { name: 'Main' });
/** Records › Results, Body map, Scans or Files. */
async function openRecords(part) {
  await mainNav().filter({ visible: true }).getByRole('button', { name: 'Records', exact: true }).click();
  await page.getByRole('group', { name: 'Records' }).getByRole('button', { name: part, exact: true }).click();
}
/** Find a lab › Near you (the page opens on Home collection where a partner lab serves the region).
 *  On phones the tab bar has no labs tab: labs open from Home. */
async function openNearYou() {
  const tab = mainNav().filter({ visible: true }).getByRole('button', { name: 'Find a lab', exact: true });
  if (await tab.count()) await tab.click();
  else {
    await mainNav().filter({ visible: true }).getByRole('button', { name: 'Home', exact: true }).click();
    await page.locator('main.home').getByRole('button', { name: 'Find a lab', exact: true }).click();
  }
  const near = page.getByRole('button', { name: 'Near you', exact: true });
  if (await near.isVisible().catch(() => false)) await near.click();
  await page.getByRole('heading', { name: 'Find a lab', exact: true }).waitFor();
}
/** The brief beside the body and on Home: "Latest report … · 29 markers, 26 in range". */
const brief = () => page.locator('.brief__sub:visible').filter({ hasText: /\d+ markers?, \d+ in range/ }).first();

const email = `asha.${Date.now()}@example.com`;
const password = 'lotus pond lily pad';

try {
// 0. Public website (servers only; the preview build is the app alone)
await page.goto(at('./'), { waitUntil: 'networkidle' });
const hasSite = await page.getByRole('link', { name: 'Create free account' }).first().isVisible().catch(() => false);
console.log(hasSite ? 'Public website found; checking it first.' : 'No public website (preview build); starting at #signup.');

if (hasSite) {
  const dev = await page.locator('script[src*="@vite/client"]').count() > 0;
  expect(/^Your family.s health records, ready for any AI agent\.$/.test(await page.getByRole('heading', { level: 1 }).innerText()), 'landing page has its headline');
  expect(await page.locator('link[rel=canonical]').getAttribute('href') === 'https://health.lotuspond.ai/' || !!process.env.SITE_URL, 'landing page has a canonical URL');
  expect((await page.locator('meta[property="og:image"]').getAttribute('content'))?.endsWith('/site/og.png'), 'landing page has a social preview image');
  const ld = await page.locator('script[type="application/ld+json"]').textContent();
  let graph = [];
  try { graph = JSON.parse(ld)['@graph']; } catch { /* reported below */ }
  expect(graph.some(n => n['@type'] === 'WebApplication') && graph.some(n => n.parentOrganization), 'landing page has JSON-LD for the app and its parent organisation');
  if (!dev) expect(await page.locator('script:not([type="application/ld+json"])').count() === 0, 'landing page runs no JavaScript');
  const og = await page.request.get(at('/site/og.png'));
  expect(og.ok() && og.headers()['content-type'] === 'image/png', 'social preview image is served');
  const robots = await (await page.request.get(at('/robots.txt'))).text();
  expect(/Sitemap: https?:\/\/\S+\/sitemap\.xml/.test(robots), 'robots.txt names the sitemap');
  const sitemap = await (await page.request.get(at('/sitemap.xml'))).text();
  expect(['/', '/privacy/', '/terms/', '/trust/'].every(p => sitemap.includes(`${p}</loc>`)), 'sitemap.xml lists the public pages');

  // Keyboard: the first Tab reaches the skip link, which shows with a focus outline.
  await page.keyboard.press('Tab');
  const focus = await page.evaluate(() => { const a = document.activeElement; const s = getComputedStyle(a); return { text: a.textContent, outline: s.outlineStyle, top: a.getBoundingClientRect().top }; });
  expect(focus.text === 'Skip to content' && focus.outline !== 'none' && focus.top >= 0, 'skip link is reachable and visibly focused');

  const pages = [
    { path: '/', name: 'landing', h1: /ready for any AI agent/ },
    { path: '/privacy/', name: 'privacy', h1: /Privacy Policy/ },
    { path: '/terms/', name: 'terms', h1: /Terms of Use/ },
    { path: '/trust/', name: 'trust', h1: /look after your records/ },
    { path: '/no-such-page', name: '404', h1: /drifted off/, status: 404 },
  ];
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width > 500 ? 900 : 844 });
    for (const p of pages) {
      expectNotFound = p.status === 404;
      const res = await page.goto(at(p.path), { waitUntil: 'networkidle' });
      expectNotFound = false;
      const ok = res.status() === (p.status ?? 200) && p.h1.test(await page.getByRole('heading', { level: 1 }).innerText());
      expect(ok, `${p.name} page loads at ${width}px (${res.status()})`);
      if (width === 390) expect(!(await sideScroll()), `${p.name} page has no sideways scroll at 390px`);
      await shot(`site-${p.name}-${width}`, true);
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(at('/privacy'), { waitUntil: 'networkidle' });
  expect(pathOf() === '/privacy/', '/privacy redirects to /privacy/');
  expect(await page.locator('#consumer-health-data').count() === 1, 'privacy page has the Consumer Health Data Privacy Policy section');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior) === 'auto', 'reduced motion turns off smooth scrolling');
  await page.emulateMedia({ reducedMotion: null });

  // From the landing page to sign-up.
  await page.goto(at('/'), { waitUntil: 'networkidle' });
  await page.locator('.hero').getByRole('link', { name: 'Create free account' }).click();
  await page.getByRole('heading', { name: 'Start your record' }).waitFor();
  expect(pathOf() === '/signup', '"Create free account" opens /signup in sign-up mode');
  expect(await page.getByRole('link', { name: 'LotusPond Health home' }).getAttribute('href') === '/', 'auth screen links to the LotusPond Health home page');
  await page.getByRole('tab', { name: 'Sign in' }).click();
  expect(pathOf() === '/login' && (await page.title()).startsWith('Sign in'), 'switching to sign-in changes the address to /login');
  await page.getByRole('tab', { name: 'Create account' }).click();
  expect(pathOf() === '/signup', 'and back to /signup');
} else {
  await page.goto(at('./#signup'), { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'Start your record' }).waitFor();
  expect(true, '#signup opens the auth screen in sign-up mode');
  expect((await page.getByRole('link', { name: 'LotusPond Health home' }).getAttribute('href'))?.startsWith('http'), 'auth screen links to the live website');
}

// 1. Sign-up
await shot('create-account');
await page.getByLabel('Your name').fill('Asha Rao');
await page.getByLabel('Email', { exact: true }).fill(email);
const country = page.getByRole('combobox', { name: 'Country you live in' });
async function chooseCountry(typed, name) {
  await country.fill(typed);
  await page.getByRole('option', { name: new RegExp(`^${name}`) }).click();
}
const createButton = page.getByRole('button', { name: 'Create account', exact: true });
// The country starts from the browser's locale. Health opens in India only at first, so choose it before anything else.
await chooseCountry('ind', 'India');
await page.getByLabel('Password', { exact: true }).fill('short');
await createButton.click();
expect((await text('.form-error')).includes('at least 10'), 'short password is refused before sending');
await page.getByLabel('Password', { exact: true }).fill(password);

await chooseCountry('emirates', 'United Arab Emirates');
expect((await text('.residency')).includes('stored inside the UAE'), 'an unavailable country explains why');
expect(await createButton.isDisabled(), 'sign-up is blocked for an unavailable country');
await shot('signup-unavailable', true);
await chooseCountry('united k', 'United Kingdom');
expect((await text('.residency')).includes('open to people living in India first'), 'a country not open yet says Health is India-only for now');
expect(await createButton.isDisabled(), 'sign-up is blocked for a country not open yet');
await shot('signup-not-open-yet', true);
await chooseCountry('ind', 'India');
expect((await text('.residency')).includes('Your records will be stored on servers in India'), 'India stores records in India');
expect(await page.getByLabel(/my records being stored on/).count() === 0, 'no cross-border consent for India');
await page.getByRole('radio', { name: 'No' }).check();
expect((await text('.age .residency')).includes('parent or guardian'), 'under-age people are pointed to family profiles');
expect(await createButton.isDisabled(), 'sign-up is blocked under the minimum age');
await page.getByRole('radio', { name: 'Yes' }).check();
await createButton.click();
expect((await text('.form-error')).includes('Terms'), 'Terms and Privacy must be agreed first');
await page.getByLabel(/I agree to the Terms of Use/).check();
await page.getByLabel(/I consent to LotusPond processing my health data/).check();
expect(!(await page.getByLabel(/Send me news about LotusPond/).isChecked()), 'product emails start unchecked');
await shot('signup-india', true);
await createButton.click();

// 2. Onboarding
await page.getByRole('heading', { name: /Welcome, Asha/ }).waitFor();
if (hasSite) expect(pathOf() === '/app', 'after sign-up the address is /app');
await page.getByLabel('Date of birth').fill('1990-04-12');
await page.getByRole('radio', { name: 'Female' }).click();
await page.getByLabel('Height').fill('164');
await page.getByLabel('Weight').fill('61');
await page.getByLabel('Blood type').selectOption('B+');
await shot('onboarding');
await page.getByRole('button', { name: 'Continue', exact: true }).click();

// 2b. Home area. Area search answers when the API runs with FACILITY_PROVIDER=fixture (or has internet access);
// otherwise the step is skipped and the labs step below checks the "no location yet" state instead.
await page.getByRole('heading', { name: 'Labs near you' }).waitFor();
await page.getByRole('combobox', { name: 'Area or postcode' }).fill('Indiranagar');
const areaFound = await page.getByRole('option', { name: /^Indiranagar, Bengaluru/ }).waitFor({ timeout: 6000 }).then(() => true, () => false);
if (areaFound) {
  await page.getByRole('option', { name: /^Indiranagar, Bengaluru/ }).click();
  await shot('onboarding-area');
  await page.getByRole('button', { name: 'Continue to your body map' }).click();
} else {
  console.log('note area search is not answering here (start the API with FACILITY_PROVIDER=fixture); skipping the area');
  await page.getByRole('button', { name: 'Skip for now' }).click();
}

// 3. Home, then the body map with sample data (Records › Body map)
await page.getByRole('heading', { name: 'Welcome to LotusPond Health' }).waitFor();
await shot('home-welcome');
await openRecords('Body map');
await page.getByRole('heading', { name: 'See your results where they happen' }).waitFor();
await page.waitForTimeout(2500);
await shot('body-welcome');
await page.getByRole('button', { name: 'Explore with sample data' }).click();
// Beside the body, the brief: "3 results to look at", then "Latest report … · 29 markers, 26 in range".
await brief().waitFor();
expect(true, 'sample results are saved and shown');

// 4. Upload a lab report PDF and a DICOM scan
await page.getByRole('button', { name: 'Upload', exact: true }).first().click();
await page.locator('input[type=file][multiple]').setInputFiles([path.join(fixtures, 'sample-lab-report.pdf'), path.join(fixtures, 'chest-xray-synthetic.dcm')]);
await page.getByRole('heading', { name: 'Check what was read' }).waitFor({ timeout: 60000 });
await shot('upload-review');
await page.getByRole('button', { name: /^Add \d+ results/ }).click();
await page.locator('.toast').filter({ hasText: /Added/ }).waitFor();
const added = await page.locator('.toast').filter({ hasText: /Added/ }).first().innerText(); // the sample-data toast may still be showing
expect(added.match(/Added \d+ results? and 1 scan/) !== null, `upload saved results and a scan (${added})`);

// 5. Files page
await openRecords('Files');
await page.getByRole('heading', { name: 'Files', exact: true }).waitFor();
const rows = await page.locator('main.page [data-file]').count(); // file cards, or rows in the table layout
expect(rows === 2, `files page lists the report and the scan (${rows})`);
await shot('files');

// 5b. Find a lab: the saved home area is searched; cards come with directions; filters narrow the list.
await openNearYou();
if (areaFound) {
  expect((await text('.lbar__place')).includes('Indiranagar, Bengaluru'), 'labs page searches the saved home area');
}
if (areaFound && !hasSite) {
  // The preview has no server: it keeps the area (offline city list) and explains that nearby search needs the server.
  await page.getByRole('heading', { name: 'Nearby search needs the server' }).waitFor({ timeout: 15000 });
  expect(true, 'the preview explains that nearby search needs the server');
  await shot('labs-preview');
} else if (areaFound) {
  await page.locator('.labcard').first().waitFor({ timeout: 15000 });
  const cards = await page.locator('.labcard').count();
  expect(cards >= 5, `nearby facilities are listed (${cards})`);
  const dir = await page.locator('.labcard').first().getByRole('link', { name: /^Directions to/ }).getAttribute('href');
  expect(/^https:\/\/(www\.google\.com\/maps\/dir\/\?api=1&destination=|maps\.apple\.com\/\?daddr=)-?\d+\.\d+,-?\d+\.\d+$/.test(dir ?? ''), `directions open the maps app (${dir})`);
  const partners = await page.locator('.labcard--partner').count();
  console.log(`note ${partners} partner lab(s) shown (they appear only after partners:import)`);
  await page.getByRole('group', { name: 'Show' }).getByRole('button', { name: /^Imaging/ }).click();
  const kinds = await page.locator('.labcard .labchip--kind').allInnerTexts();
  expect(kinds.length > 0 && kinds.every(k => k === 'Imaging'), `the Imaging filter shows imaging only (${kinds.join(', ')})`);
  await page.getByRole('group', { name: 'Show' }).getByRole('button', { name: /^All/ }).click();
  await page.locator('.labcard__main').first().click();
  expect(await page.locator('.labcard.is-selected').count() === 1, 'selecting a card highlights it');
  await page.waitForTimeout(1500);
  await shot('labs');
} else {
  await page.getByRole('heading', { name: 'Where should we look?' }).waitFor();
  expect(true, 'labs page asks for a location when none is saved');
  await shot('labs-empty');
}

// 6. Profile details
await page.locator('.pmenu__trigger').click();
await shot('profile-menu');
await page.getByRole('menuitem', { name: 'Profile details' }).click();
await page.getByRole('heading', { name: 'Asha Rao' }).waitFor();
const allergies = page.getByLabel('Allergies');
await allergies.fill('Penicillin');
await allergies.press('Enter');
await page.getByLabel('Medications and supplements').fill('Vitamin D3 2000 IU');
await page.getByLabel('Medications and supplements').press('Enter');
await page.getByRole('button', { name: 'Save changes' }).click();
await page.locator('.toast').filter({ hasText: 'Profile saved' }).waitFor();
expect((await text('.readout b')) === '22.7', 'BMI shown from height and weight');
await shot('profile', true);

// 7. Family member
await page.locator('.pmenu__trigger').click();
await page.getByRole('menuitem', { name: 'Add a family member' }).click();
const dialog = page.getByRole('dialog', { name: 'Add a family member' });
await dialog.getByLabel('Name').fill('Mira Rao');
await dialog.getByLabel('Who are they to you?').selectOption('child');
await dialog.getByLabel('Date of birth').fill('2019-06-01');
await dialog.getByRole('button', { name: 'Add and open their records' }).click();
expect((await dialog.locator('.form-error').innerText()).includes('Tick the confirmation'), 'a child is added only with the parent or guardian confirmation');
await dialog.getByLabel(/I am Mira Rao's parent or legal guardian/).check();
await shot('add-family');
await dialog.getByRole('button', { name: 'Add and open their records' }).click();
await dialog.waitFor({ state: 'hidden' });
await openRecords('Body map');
await page.getByRole('heading', { name: 'Start Mira’s record' }).waitFor();
expect((await text('.stage__title h2')) === 'Mira’s body, mapped', 'stage title follows the open profile');
expect((await text('.pmenu__trigger')).includes('Mira'), 'menu shows the open profile');
await shot('family-body');

// 8. Reload keeps the session and the open profile
// Still signed in, with the profile that was open (a reload keeps the page; /login opens Home).
const openedOnMira = () => page.locator('.pmenu__trigger').filter({ hasText: 'Mira' }).waitFor().then(() => true, () => false);
await page.reload({ waitUntil: 'networkidle' });
expect(await openedOnMira(), 'reload keeps the session and the open profile');
if (hasSite) {
  await page.goto(at('/login'), { waitUntil: 'networkidle' });
  expect(await openedOnMira(), 'a signed-in visit to /login opens the app');
  expect(pathOf() === '/app', 'a signed-in visit to /login goes to /app');
}

// 9. Switch back; records are separate
await page.locator('.pmenu__trigger').click();
await page.getByRole('menuitemradio', { name: /Asha Rao/ }).click();
await brief().waitFor();
expect(true, 'switching back shows Asha’s records');

// 10. Account: change password, sign out, sign in with the new password
await page.locator('.pmenu__trigger').click();
await page.getByRole('menuitem', { name: 'Account and sign-in' }).click();
await page.getByLabel('Current password').fill(password);
await page.getByLabel('New password', { exact: true }).fill('a brand new lily pad');
await page.getByLabel('Repeat new password').fill('a brand new lily pad');
await page.getByRole('button', { name: 'Change password' }).click();
await page.locator('.toast').filter({ hasText: 'Password changed' }).waitFor();
expect((await text('.where__lead')) === (hasSite ? 'Your records are stored on servers in India.' : 'Your records are stored in this browser only.'), 'account page says where records are stored');
const consentList = await text('.consent-list');
expect(consentList.includes('Processing your health data') && consentList.includes('version'), `consents are listed with version (${consentList.slice(0, 80)})`);
await page.getByRole('radio', { name: /International \(SI/ }).click();
await page.locator('.toast').filter({ hasText: 'SI units' }).waitFor();
await page.locator('.consent-list').getByRole('button', { name: 'Turn on' }).click();
await page.locator('.toast').filter({ hasText: 'product emails' }).waitFor();
await page.locator('.consent-list').getByRole('button', { name: 'Withdraw' }).first().click();
expect((await text('.explain')).includes('means deleting your account'), 'withdrawing health-data consent explains deletion');
await page.waitForTimeout(300);
const activity = await text('.activity');
expect(['Password changed', 'Units changed', 'Account created'].every(a => activity.includes(a)), 'recent activity lists account events');
await shot('account', true);
await page.locator('.pmenu__trigger').click();
await page.getByRole('menuitem', { name: 'Sign out' }).click();
await page.getByRole('heading', { name: 'Welcome back' }).waitFor();
if (hasSite) expect(pathOf() === '/login', 'signing out goes to /login');
await page.getByLabel('Email', { exact: true }).fill(email);
await page.getByLabel('Password', { exact: true }).fill(password);
expectRejectedSignIn = true;
await page.getByRole('button', { name: 'Sign in', exact: true }).click();
expect((await page.locator('.form-error').first().innerText({ timeout: 10000 })).includes('incorrect'), 'old password no longer works');
expectRejectedSignIn = false;
await page.getByLabel('Password', { exact: true }).fill('a brand new lily pad');
await page.getByRole('button', { name: 'Sign in', exact: true }).click();
await brief().waitFor();
expect(true, 'signs in with the new password');
if (hasSite) expect(pathOf() === '/app', 'after sign-in the address is /app');

// 11. Phone width
await page.setViewportSize({ width: 390, height: 844 });
await page.locator('.pmenu__trigger').click();
await page.getByRole('menuitem', { name: 'Profile details' }).click();
await page.waitForTimeout(400);
expect(!(await sideScroll()), 'profile page has no sideways scroll at phone width');
await shot('profile-phone', true);
// On phones the top navigation becomes a bottom tab bar without a labs tab; labs open from Home.
await openNearYou();
await page.waitForTimeout(1200);
expect(!(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)), 'labs page has no sideways scroll at phone width');
await shot('labs-phone');
await page.locator('.pmenu__trigger').click();
await page.getByRole('menuitem', { name: 'Account and sign-in' }).click();
await page.getByRole('heading', { name: 'Where your records are kept' }).waitFor();
await page.waitForTimeout(300);
expect(!(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)), 'account page has no sideways scroll at phone width');
await shot('account-phone', true);
await page.locator('.pmenu__trigger').click();
await page.getByRole('menuitem', { name: 'Sign out' }).click();
await page.getByRole('heading', { name: 'Welcome back' }).waitFor();
expect(!(await sideScroll()), 'sign-in screen has no sideways scroll at phone width');
await shot('signin-phone', true);
await page.getByRole('tab', { name: 'Create account' }).click();
await chooseCountry('ind', 'India');
await page.getByRole('radio', { name: 'Yes' }).check();
expect(!(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)), 'sign-up has no sideways scroll at phone width');
await shot('signup-phone', true);

} catch (e) {
  const at = (e.stack ?? '').split('\n').filter(l => l.includes('e2e-accounts.mjs')).map(l => l.match(/:(\d+):\d+\)?$/)?.[1]).filter(Boolean).join(' ← ');
  problems.push(`STOPPED${at ? ` at line ${at}` : ''}: ${e.message.split('\n')[0]}`);
  await page.screenshot({ path: `${out}/failure.png` }).catch(() => {});
}

console.log(problems.length ? `\n${problems.length} problem(s):\n${problems.join('\n')}` : '\nAll checks passed, no console errors.');
await browser.close();
process.exit(problems.length ? 1 : 0);

// End-to-end check of accounts, profiles, uploads and files in a real browser.
// Run against the dev stack (npm run dev) or a production build (npm start):
//   node tools/e2e-accounts.mjs [url] [screenshot-dir]
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = createRequire(import.meta.url)('playwright');
const url = process.argv[2] ?? 'http://localhost:5173/';
const out = process.argv[3] ?? 'shots';
const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
fs.mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
const problems = [];
let expectRejectedSignIn = false; // the wrong-password step makes the browser log a 401 on purpose
page.on('console', m => {
  if (m.type() !== 'error') return;
  if (expectRejectedSignIn && m.text().includes('status of 401')) return;
  // Third-party map tiles (the development fallback) may be unreachable where this runs; the map copes.
  if (/^https:\/\/tile\.openstreetmap\.org\//.test(m.location()?.url ?? '')) return;
  problems.push(`console: ${m.text().slice(0, 300)}`);
});
page.on('pageerror', e => problems.push(`page error: ${e.message}`));

let step = 0;
// Full-page shots re-render the 3D stage; allow for a slow software renderer on a busy machine.
async function shot(name, full = false) { await page.screenshot({ path: `${out}/${String(++step).padStart(2, '0')}-${name}.png`, fullPage: full, timeout: 120_000 }); }
function expect(ok, what) { if (!ok) problems.push(`FAILED: ${what}`); console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); }
const text = sel => page.locator(sel).first().innerText();

const email = `asha.${Date.now()}@example.com`;
const password = 'lotus pond lily pad';

try {
// 1. Sign-up
await page.goto(url, { waitUntil: 'networkidle' });
await page.getByRole('tab', { name: 'Create account' }).click();
await shot('create-account');
await page.getByLabel('Your name').fill('Asha Rao');
await page.getByLabel('Email').fill(email);
await page.getByLabel('Password', { exact: true }).fill('short');
await page.getByRole('button', { name: 'Create account', exact: true }).click();
expect((await text('.form-error')).includes('at least 10'), 'short password is refused before sending');
await page.getByLabel('Password', { exact: true }).fill(password);
await page.getByRole('button', { name: 'Create account', exact: true }).click();

// 2. Onboarding
await page.getByRole('heading', { name: /Welcome, Asha/ }).waitFor();
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

// 3. Body map, sample data
await page.getByRole('heading', { name: 'See your results where they happen' }).waitFor();
await page.waitForTimeout(2500);
await shot('body-welcome');
await page.getByRole('button', { name: 'Explore with sample data' }).click();
await page.getByRole('heading', { name: 'Overview' }).waitFor();
expect((await text('.tally')).includes('markers tracked'), 'sample results are saved and shown');

// 4. Upload a lab report PDF and a DICOM scan
await page.getByRole('button', { name: 'Upload', exact: true }).click();
await page.locator('input[type=file]').setInputFiles([path.join(fixtures, 'sample-lab-report.pdf'), path.join(fixtures, 'chest-xray-synthetic.dcm')]);
await page.getByRole('heading', { name: 'Check what was read' }).waitFor({ timeout: 60000 });
await shot('upload-review');
await page.getByRole('button', { name: /^Add \d+ results/ }).click();
await page.locator('.toast').filter({ hasText: /Added/ }).waitFor();
expect((await text('.toast')).match(/Added \d+ results? and 1 scan/) !== null, `upload saved results and a scan (${await text('.toast')})`);

// 5. Files page
await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Files' }).click();
await page.getByRole('heading', { name: 'Files', exact: true }).waitFor();
const rows = await page.locator('table.files tbody tr').count();
expect(rows === 2, `files page lists the report and the scan (${rows})`);
await shot('files');

// 5b. Find a lab: the saved home area is searched; cards come with directions; filters narrow the list.
await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Find a lab' }).click();
await page.getByRole('heading', { name: 'Find a lab', exact: true }).waitFor();
if (areaFound) {
  expect((await text('.lbar__place')).includes('Indiranagar, Bengaluru'), 'labs page searches the saved home area');
  await page.locator('.fcard').first().waitFor({ timeout: 15000 });
  const cards = await page.locator('.fcard').count();
  expect(cards >= 5, `nearby facilities are listed (${cards})`);
  const dir = await page.locator('.fcard').first().getByRole('link', { name: /^Directions to/ }).getAttribute('href');
  expect(/^https:\/\/(www\.google\.com\/maps\/dir\/\?api=1&destination=|maps\.apple\.com\/\?daddr=)-?\d+\.\d+,-?\d+\.\d+$/.test(dir ?? ''), `directions open the maps app (${dir})`);
  const partners = await page.locator('.fcard--partner').count();
  console.log(`note ${partners} partner lab(s) shown (they appear only after partners:import)`);
  await page.getByRole('group', { name: 'Show' }).getByRole('button', { name: /^Imaging/ }).click();
  const kinds = await page.locator('.fcard .fchip--kind').allInnerTexts();
  expect(kinds.length > 0 && kinds.every(k => k === 'Imaging'), `the Imaging filter shows imaging only (${kinds.join(', ')})`);
  await page.getByRole('group', { name: 'Show' }).getByRole('button', { name: /^All/ }).click();
  await page.locator('.fcard__main').first().click();
  expect(await page.locator('.fcard.is-selected').count() === 1, 'selecting a card highlights it');
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
await shot('add-family');
await dialog.getByRole('button', { name: 'Add and open their records' }).click();
await page.getByRole('heading', { name: 'Start Mira’s record' }).waitFor();
expect((await text('.stage__title h2')) === 'Mira’s body, mapped', 'stage title follows the open profile');
expect((await text('.pmenu__trigger')).includes('Mira'), 'menu shows the open profile');
await shot('family-body');

// 8. Reload keeps the session and the open profile
await page.reload({ waitUntil: 'networkidle' });
await page.getByRole('heading', { name: 'Start Mira’s record' }).waitFor();
expect(true, 'reload keeps the session and the open profile');

// 9. Switch back; records are separate
await page.locator('.pmenu__trigger').click();
await page.getByRole('menuitemradio', { name: /Asha Rao/ }).click();
await page.getByRole('heading', { name: 'Overview' }).waitFor();
expect(true, 'switching back shows Asha’s records');

// 10. Account: change password, sign out, sign in with the new password
await page.locator('.pmenu__trigger').click();
await page.getByRole('menuitem', { name: 'Account and sign-in' }).click();
await page.getByLabel('Current password').fill(password);
await page.getByLabel('New password', { exact: true }).fill('a brand new lily pad');
await page.getByLabel('Repeat new password').fill('a brand new lily pad');
await page.getByRole('button', { name: 'Change password' }).click();
await page.locator('.toast').filter({ hasText: 'Password changed' }).waitFor();
await shot('account', true);
await page.locator('.pmenu__trigger').click();
await page.getByRole('menuitem', { name: 'Sign out' }).click();
await page.getByRole('heading', { name: 'Welcome back' }).waitFor();
await page.getByLabel('Email').fill(email);
await page.getByLabel('Password', { exact: true }).fill(password);
expectRejectedSignIn = true;
await page.getByRole('button', { name: 'Sign in', exact: true }).click();
expect((await page.locator('.form-error').first().innerText({ timeout: 10000 })).includes('incorrect'), 'old password no longer works');
expectRejectedSignIn = false;
await page.getByLabel('Password', { exact: true }).fill('a brand new lily pad');
await page.getByRole('button', { name: 'Sign in', exact: true }).click();
await page.getByRole('heading', { name: 'Overview' }).waitFor();
expect(true, 'signs in with the new password');

// 11. Phone width
await page.setViewportSize({ width: 390, height: 844 });
await page.locator('.pmenu__trigger').click();
await page.getByRole('menuitem', { name: 'Profile details' }).click();
await page.waitForTimeout(400);
const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
expect(!overflow, 'profile page has no sideways scroll at phone width');
await shot('profile-phone', true);
await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Find a lab' }).click();
await page.getByRole('heading', { name: 'Find a lab', exact: true }).waitFor();
await page.waitForTimeout(1200);
expect(!(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)), 'labs page has no sideways scroll at phone width');
await shot('labs-phone');
await page.locator('.pmenu__trigger').click();
await page.getByRole('menuitem', { name: 'Sign out' }).click();
await page.getByRole('heading', { name: 'Welcome back' }).waitFor();
await shot('signin-phone', true);

} catch (e) {
  problems.push(`STOPPED: ${e.message.split('\n')[0]}`);
  await page.screenshot({ path: `${out}/failure.png` }).catch(() => {});
}

console.log(problems.length ? `\n${problems.length} problem(s):\n${problems.join('\n')}` : '\nAll checks passed, no console errors.');
await browser.close();
process.exit(problems.length ? 1 : 0);

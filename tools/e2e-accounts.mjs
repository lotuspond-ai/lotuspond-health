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
  problems.push(`console: ${m.text().slice(0, 300)}`);
});
page.on('pageerror', e => problems.push(`page error: ${e.message}`));

let step = 0;
// Software WebGL (SwiftShader) can keep the page busy for half a minute after the body map changes, so screenshots get longer.
async function shot(name, full = false) { await page.screenshot({ path: `${out}/${String(++step).padStart(2, '0')}-${name}.png`, fullPage: full, timeout: 90000 }); }
function expect(ok, what) { if (!ok) problems.push(`FAILED: ${what}`); console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); }
const text = sel => page.locator(sel).first().innerText();

const email = `asha.${Date.now()}@example.com`;
const password = 'lotus pond lily pad';

try {
// 1. Sign-up: country of residence, age and consent
await page.goto(url, { waitUntil: 'networkidle' });
await page.getByRole('tab', { name: 'Create account' }).click();
await shot('create-account');
await page.getByLabel('Your name').fill('Asha Rao');
await page.getByLabel('Email', { exact: true }).fill(email);
await page.getByLabel('Password', { exact: true }).fill('short');
await page.getByRole('button', { name: 'Create account', exact: true }).click();
expect((await text('.form-error')).includes('at least 10'), 'short password is refused before sending');
await page.getByLabel('Password', { exact: true }).fill(password);

const country = page.getByRole('combobox', { name: 'Country you live in' });
async function chooseCountry(typed, name) {
  await country.fill(typed);
  await page.getByRole('option', { name: new RegExp(`^${name}`) }).click();
}
const createButton = page.getByRole('button', { name: 'Create account', exact: true });
await chooseCountry('emirates', 'United Arab Emirates');
expect((await text('.residency')).includes('stored inside the UAE'), 'an unavailable country explains why');
expect(await createButton.isDisabled(), 'sign-up is blocked for an unavailable country');
await shot('signup-unavailable', true);
await chooseCountry('united k', 'United Kingdom');
expect((await text('.residency')).includes('servers in the European Union'), 'a cross-border country says where records go');
expect(await page.getByLabel(/my records being stored on servers in the European Union/).isVisible(), 'cross-border consent is asked');
await page.getByRole('radio', { name: 'Yes' }).check();
await shot('signup-cross-border', true);
await chooseCountry('ind', 'India');
expect((await text('.residency')).includes('Your records will be stored on servers in India'), 'India stores records in India');
expect(await page.getByLabel(/my records being stored on/).count() === 0, 'no cross-border consent for India');
await page.getByRole('radio', { name: 'No' }).check();
expect((await text('.age .residency')).includes('parent or guardian'), 'under-age people are pointed to family profiles');
expect(await createButton.isDisabled(), 'sign-up is blocked under the minimum age');
await page.getByRole('radio', { name: 'Yes' }).check();
await createButton.click();
expect((await text('.form-error')).includes('Terms'), 'Terms and Privacy must be agreed first');
await page.getByLabel(/I agree to the Terms of Service/).check();
await page.getByLabel(/I consent to LotusPond processing my health data/).check();
expect(!(await page.getByLabel(/Send me news about LotusPond/).isChecked()), 'product emails start unchecked');
await shot('signup-india', true);
await createButton.click();

// 2. Onboarding
await page.getByRole('heading', { name: /Welcome, Asha/ }).waitFor();
await page.getByLabel('Date of birth').fill('1990-04-12');
await page.getByRole('radio', { name: 'Female' }).click();
await page.getByLabel('Height').fill('164');
await page.getByLabel('Weight').fill('61');
await page.getByLabel('Blood type').selectOption('B+');
await shot('onboarding');
await page.getByRole('button', { name: 'Continue to your body map' }).click();

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
expect((await text('.where__lead')) === 'Your records are stored on servers in India.', 'account page says where records are stored');
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
await page.getByLabel('Email', { exact: true }).fill(email);
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
await page.locator('.pmenu__trigger').click();
await page.getByRole('menuitem', { name: 'Account and sign-in' }).click();
await page.getByRole('heading', { name: 'Where your records are kept' }).waitFor();
await page.waitForTimeout(300);
expect(!(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)), 'account page has no sideways scroll at phone width');
await shot('account-phone', true);
await page.locator('.pmenu__trigger').click();
await page.getByRole('menuitem', { name: 'Sign out' }).click();
await page.getByRole('heading', { name: 'Welcome back' }).waitFor();
await shot('signin-phone', true);
await page.getByRole('tab', { name: 'Create account' }).click();
await chooseCountry('united k', 'United Kingdom');
await page.getByRole('radio', { name: 'Yes' }).check();
expect(!(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)), 'sign-up has no sideways scroll at phone width');
await shot('signup-phone', true);

} catch (e) {
  problems.push(`STOPPED: ${e.message.split('\n')[0]}`);
  await page.screenshot({ path: `${out}/failure.png` }).catch(() => {});
}

console.log(problems.length ? `\n${problems.length} problem(s):\n${problems.join('\n')}` : '\nAll checks passed, no console errors.');
await browser.close();
process.exit(problems.length ? 1 : 0);

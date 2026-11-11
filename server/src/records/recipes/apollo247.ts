// Apollo 24|7: the person's Health Records (Apollo's personal health record), which collects reports from Apollo
// Hospitals, Apollo Diagnostics, Apollo 24|7 and Apollo Clinics. Sign in with a mobile number and an OTP. Written
// from the site as published in November 2026; it has not been run against a real Apollo 24|7 account yet.
//
// What the site shows:
//   /guest-health-records: "Sign In To Access Your Health Records" with a "Login Now" button; the header has
//     div#loginPopup (title "Login/SignUp").
//   The sign-in opens in a side panel (seen live on 11 Nov 2026): input[name=mobileNumber] after a "+91", a box
//     ticked in advance for "Share health tips, appointment details and offers with me on Whatsapp" (the recipe
//     unticks it), and Continue. The OTP step after it has not been seen yet.
//   Signed in, Health Records sorts records into kinds (test reports, prescriptions, hospitalisations, …); the
//     recipe opens each kind it recognises and downloads every report link in it.
import type { Locator, Page } from 'playwright-core';
import { PortalError, type PortalReport, type Recipe, type RecipeContext } from './types.ts';
import { collectReports, DIALOGS, fillCode, findDialogWith, firstVisible, mustFind, PHONE_FIELDS, RecipeDriftError, reportLinks, tenDigits, untickMarketing, visibleError, type ReportLink } from './kit.ts';

export const APOLLO_ORIGIN = 'https://www.apollo247.com';

const SEND = ['button:has-text("Continue")', 'button:has-text("Send OTP")', 'button:has-text("Get OTP")', 'button:has-text("Proceed")', 'button:has-text("Login")', 'button[type=submit]'];
const VERIFY = ['button:has-text("Verify")', 'button:has-text("Submit")', 'button:has-text("Continue")', 'button:has-text("Login")', 'button[type=submit]'];
// Seen live: <input type="tel" maxlength="6" title="Please enter the otp"> under "Enter OTP", with Verify.
const CODE = ['input[title*="otp" i]', 'input[autocomplete="one-time-code"]', 'input[placeholder*="otp" i]', 'input[name*="otp" i]', 'input[id*="otp" i]', 'input[maxlength="6"]:not([name*="mobile" i])', 'input[maxlength="4"]:not([name*="mobile" i])'];
/** The kinds of records Health Records shows, as tab or menu labels. */
const KINDS = ['Test Reports', 'Lab Reports', 'Lab Tests', 'Reports', 'Prescriptions', 'Hospitalization', 'Hospitalisation', 'Discharge Summary', 'Medical Bills', 'Insurance'];

async function signedIn(page: Page): Promise<boolean> {
  return !(await firstVisible(page, ['button:has-text("Login Now")', '#loginPopup:has-text("Login")'], 3000));
}

async function signIn(ctx: RecipeContext): Promise<void> {
  const { page } = ctx;
  await ctx.step('Signing in to Apollo 24|7');
  let found = await findDialogWith(page, DIALOGS, PHONE_FIELDS, undefined, 300);
  // The page draws the button before its scripts can handle a click: wait for them, and click again if the panel
  // does not open.
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
  for (let attempt = 0; !found && attempt < 3; attempt++) {
    const opener = await mustFind(page, attempt === 1 ? ['#loginPopup', 'button:has-text("Login Now")'] : ['button:has-text("Login Now")', '#loginPopup'], 'the Login button');
    await opener.click();
    found = await findDialogWith(page, DIALOGS, PHONE_FIELDS, undefined, 5000);
  }
  if (!found) throw new RecipeDriftError('The Apollo 24|7 sign-in did not open');
  const { box, field } = found;
  const phone = tenDigits(ctx.identifier ?? await ctx.ask({ kind: 'phone', label: 'Mobile number registered with Apollo 24|7' }));
  if (phone.length !== 10) throw new PortalError('Apollo 24|7 needs a 10-digit mobile number.');
  await field.fill(phone);
  await untickMarketing(box);
  await (await mustFind(box, SEND, 'the button that sends the OTP')).click();

  // The OTP field is a tel input too: tell it from the number field by its own marks, not its type.
  const codeReady = await firstVisible(page, [...CODE, 'input[maxlength="1"]'], 15_000);
  if (!codeReady) throw new PortalError((await visibleError(page)) ?? 'Apollo 24|7 did not send an OTP to that number.');
  ctx.remember(phone);
  for (let attempt = 0; attempt < 2; attempt++) {
    const code = await ctx.ask({ kind: 'otp', label: attempt ? 'That OTP was not accepted. Enter the new OTP from Apollo 24|7' : 'OTP Apollo 24|7 sent to your phone' });
    const scope: Page | Locator = (await box.isVisible().catch(() => false)) ? box : page;
    await fillCode(scope, code, CODE);
    const verify = await firstVisible(scope, VERIFY, 3000);
    if (verify) await verify.click();
    else await page.keyboard.press('Enter');
    await page.waitForLoadState('load').catch(() => {});
    await page.waitForTimeout(1500);
    if (await signedIn(page)) return;
  }
  throw new PortalError((await visibleError(page)) ?? 'Apollo 24|7 did not accept the OTP.');
}

export const apollo247Recipe = (origin = APOLLO_ORIGIN): Recipe => ({
  sourceId: 'apollo',
  async run(ctx): Promise<PortalReport[]> {
    const { page } = ctx;
    const reports: PortalReport[] = [];
    await ctx.step('Opening Apollo 24|7 Health Records');
    await page.goto(`${origin}/guest-health-records`);
    await page.waitForLoadState('load').catch(() => {});
    if (!(await signedIn(page))) {
      await signIn(ctx);
      await page.goto(`${origin}/guest-health-records`);
      await page.waitForLoadState('load').catch(() => {});
      if (!(await signedIn(page))) throw new RecipeDriftError('Signed in, but Health Records still asks to log in');
    }
    await ctx.step('Reading your health records');
    await firstVisible(page, KINDS.map(k => `:is(button, a, [role=tab]):has-text("${k}")`), 10_000);
    // Each kind of record in turn; a tab that is not there is skipped.
    const all: ReportLink[] = [];
    const seen = new Set<string>();
    const take = async (kind: string | null) => {
      for (const l of await reportLinks(page)) {
        // The same record under two labels (a "Reports" menu and a "Test Reports" tab) is taken once.
        if (seen.has(l.key)) continue;
        seen.add(l.key);
        const key = kind ? `${kind}:${l.key}` : l.key;
        all.push({ ...l, key, title: kind && !l.title.toLowerCase().includes(kind.toLowerCase().slice(0, 5)) ? `${kind}: ${l.title}` : l.title });
      }
    };
    let tabs = 0;
    const opened = new Set<string>();
    for (const kind of KINDS) {
      const tab = await firstVisible(page, [`[role=tab]:has-text("${kind}")`, `button:has-text("${kind}")`, `a:has-text("${kind}")`], 300);
      if (!tab) continue;
      // "Reports" also matches the "Test Reports" tab: open each tab once.
      const label = (await tab.innerText().catch(() => kind)).replace(/\s+/g, ' ').trim().toLowerCase();
      if (opened.has(label)) continue;
      opened.add(label);
      tabs++;
      await tab.click().catch(() => {});
      await page.waitForTimeout(800);
      // Downloads must happen while their tab is open: collect this tab's now.
      const before = all.length;
      await take(kind);
      if (all.length > before) {
        const got = await collectReports(ctx, 'Apollo 24|7', all.slice(before));
        reports.push(...got);
      }
    }
    if (!tabs) {
      await take(null);
      reports.push(...await collectReports(ctx, 'Apollo 24|7', all));
    }
    if (!reports.length) {
      const text = (await page.locator('body').innerText().catch(() => '')).toLowerCase();
      if (/no (records|reports|data) (found|available|yet)|add (your )?(first )?record/.test(text) || tabs) return [];
      throw new RecipeDriftError('Signed in to Apollo 24|7, but found no health records');
    }
    return reports;
  },
});

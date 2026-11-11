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
//   Signed in, /health-records lists the person's recent documents as cards with a Download link each (seen live,
//     see run()). The recipe never clicks the site's menus: its "Lab Tests" and "Buy Insurance" links lead away.
import { createHash } from 'node:crypto';
import type { Locator, Page } from 'playwright-core';
import { PortalError, type PortalReport, type Recipe, type RecipeContext } from './types.ts';
import { collectReports, DIALOGS, fillCode, findDate, findDialogWith, firstVisible, mustFind, PHONE_FIELDS, RecipeDriftError, reportLinks, tenDigits, untickMarketing, visibleError, type ReportLink } from './kit.ts';

export const APOLLO_ORIGIN = 'https://www.apollo247.com';

const SEND = ['button:has-text("Continue")', 'button:has-text("Send OTP")', 'button:has-text("Get OTP")', 'button:has-text("Proceed")', 'button:has-text("Login")', 'button[type=submit]'];
const VERIFY = ['button:has-text("Verify")', 'button:has-text("Submit")', 'button:has-text("Continue")', 'button:has-text("Login")', 'button[type=submit]'];
// Seen live: <input type="tel" maxlength="6" title="Please enter the otp"> under "Enter OTP", with Verify.
const CODE = ['input[title*="otp" i]', 'input[autocomplete="one-time-code"]', 'input[placeholder*="otp" i]', 'input[name*="otp" i]', 'input[id*="otp" i]', 'input[maxlength="6"]:not([name*="mobile" i])', 'input[maxlength="4"]:not([name*="mobile" i])'];

/**
 * Whether Apollo shows a signed-in person. Seen live: right after the OTP the guest page is still drawn for a few
 * seconds while Apollo signs in, so wait for the page to settle and for the guest buttons to stay gone.
 */
async function signedIn(page: Page, settleMs = 3000): Promise<boolean> {
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
  const end = Date.now() + settleMs;
  while (Date.now() < end) {
    if (await firstVisible(page, ['button:has-text("Login Now")', '#loginPopup:has-text("Login")'], 500)) {
      await page.waitForTimeout(500);
      continue;
    }
    return true;
  }
  return !(await firstVisible(page, ['button:has-text("Login Now")', '#loginPopup:has-text("Login")'], 500));
}

/** After Verify: the panel closes when the code was right (then sign-in finishes), or shows an error under the field. */
async function afterVerify(page: Page, codeField: string[]): Promise<'signed_in' | 'rejected' | 'unknown'> {
  const end = Date.now() + 25_000;
  while (Date.now() < end) {
    const err = await firstVisible(page, [':text("Incorrect OTP")', ':text("Invalid OTP")', ':text("attempts left")'], 300);
    if (err) return 'rejected';
    const field = await firstVisible(page, codeField, 300);
    if (!field) return (await signedIn(page, 15_000)) ? 'signed_in' : 'unknown';
    await page.waitForTimeout(500);
  }
  return 'unknown';
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
  for (let attempt = 0, resends = 0; attempt < 2; attempt++) {
    const code = await ctx.ask({
      kind: 'otp', label: attempt ? 'That OTP was not accepted. Enter the newest OTP from Apollo 24|7' : 'OTP Apollo 24|7 sent to your phone',
      hint: 'No SMS? Type RESEND and Apollo sends a new code.',
    });
    const scope: Page | Locator = (await box.isVisible().catch(() => false)) ? box : page;
    // The person never got the code: press Apollo's Resend OTP (seen live: button[title="Request resend otp"]).
    if (/^\s*resend\s*$/i.test(code)) {
      if (resends++ >= 2) throw new PortalError('Apollo 24|7 did not send a code after two resends. Try again later.');
      const resend = await firstVisible(scope, ['button[title*="resend" i]', 'button:has-text("Resend")', ':text("RESEND OTP")'], 5000);
      if (!resend) throw new PortalError('Apollo 24|7 does not offer to resend the code yet. Try again in a minute.');
      // It is enabled once its countdown ends.
      for (let i = 0; i < 40 && await resend.isDisabled().catch(() => false); i++) await page.waitForTimeout(1000);
      await resend.click();
      attempt--;
      continue;
    }
    await fillCode(scope, code, CODE);
    const verify = await firstVisible(scope, VERIFY, 3000);
    if (verify) await verify.click();
    else await page.keyboard.press('Enter');
    const outcome = await afterVerify(page, CODE);
    if (outcome === 'signed_in') return;
    if (outcome === 'unknown') throw new RecipeDriftError('After the OTP, Apollo 24|7 neither signed in nor said the code was wrong');
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
      if (!(await signedIn(page, 15_000))) throw new RecipeDriftError('Signed in, but Health Records still asks to log in');
    }
    await ctx.step('Reading your health records');
    // Seen live (11 Nov 2026): signed in, Health Records is /health-records, a single list of cards
    // (div.HdCard_hdCard__…), each with its kind ("Lab Report | Apollo", "Prescription | Self Upload"), patient name,
    // UHID, lab name and "Record Date - 01 Sep, 26", and a Download link to base.apolloprism.com/…/eDownload. Only
    // the most recent documents are on the website ("To view all your previous documents please download the app").
    if (!/\/health-records/.test(new URL(page.url()).pathname)) {
      await page.goto(`${origin}/health-records`);
      await page.waitForLoadState('load').catch(() => {});
    }
    await firstVisible(page, ['[class*="HdCard_hdCard__"]', 'a[href*="eDownload"]', 'text=/no (records|documents|reports) (found|available|yet)/i'], 20_000);
    const cards = page.locator('[class*="HdCard_hdCard__"]');
    const n = Math.min(await cards.count().catch(() => 0), 60);
    const links: ReportLink[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < n; i++) {
      const card = cards.nth(i);
      const link = card.locator('a[href*="eDownload"], a[download], a:has(:text("Download"))').first();
      const href = await link.getAttribute('href').catch(() => null);
      if (!href) continue;
      const url = new URL(href, page.url());
      const text = (await card.innerText().catch(() => '')).replace(/\s+/g, ' ');
      const kind = (await card.locator('[class*="ReportType_hdType"]').first().innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
      const lab = text.match(/Lab Name - (.+?)(?: Record Date| Prescribed By|$)/)?.[1]?.trim() ?? null;
      const date = findDate(text.match(/Record Date - ([^|]+?)(?: Download|$)/)?.[1] ?? text);
      // Seen live: the link's document token changes between visits, and so do the files' bytes, so neither tells a
      // record already brought in. What the card shows does: kind, lab, record date and file name, plus the record's
      // place among cards that show the same (two reports from one lab on one day).
      const kindName = kind.split('|')[0].trim() || 'Health record';
      const shown = [kind, lab ?? '', date ?? '', url.searchParams.get('fileName') ?? ''].join('|').toLowerCase();
      let nth = 0;
      while (seen.has(`${shown}#${nth}`)) nth++;
      seen.add(`${shown}#${nth}`);
      const key = `apollo:${createHash('sha256').update(`${shown}#${nth}`).digest('hex').slice(0, 32)}`;
      links.push({ el: link, key, title: lab ? `${kindName} ${lab}` : kindName, date });
    }
    if (!links.length) {
      // Not the cards seen live: any report links on the page, without opening other pages.
      links.push(...await reportLinks(page));
    }
    if (!links.length) {
      const text = (await page.locator('body').innerText().catch(() => '')).toLowerCase();
      if (/no (records|reports|documents|data) (found|available|yet)|add (your )?(first )?record/.test(text)) return [];
      throw new RecipeDriftError('Signed in to Apollo 24|7, but found no health records');
    }
    reports.push(...await collectReports(ctx, 'Apollo 24|7', links));
    return reports;
  },
});

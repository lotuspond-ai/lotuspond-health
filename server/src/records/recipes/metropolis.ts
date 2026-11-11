// Metropolis Healthcare: reports through the person's account on metropolisindia.com (sign in with a mobile number
// and a 4-digit OTP). Written from the site as published in November 2026; it has not been run against a real
// Metropolis account yet.
//
// What the site shows (its sign-in is plain HTML with fixed ids):
//   span.login-text "Login" in the header opens the sign-in: "View your reports and upcoming health checkups".
//   form#signin: #mobile_number (Mobile No.) and #sendOtpBtn "Send OTP".
//   Then "OTP Verification": four boxes #otp1 … #otp4 and #verifyOtpBtn.
// The page also carries several lead forms ("Mobile Number", "Enter your phone number", a help form) and a phone
// layout with its own sign-in (#mobileNumber, #getOtpBtn, .otp-box, #verifyOtpMobBtn). The recipe types only into
// form#signin, or the phone layout's sign-in when that is the one shown, never into the lead forms.
//
// Where the reports are after sign-in was not visible in the page (scripts handle it), so the recipe looks for report
// links on the page it lands on, then opens a "My Reports" / "Reports" / "Download Report" entry if there is one.
import type { Page } from 'playwright-core';
import { PortalError, type PortalReport, type Recipe, type RecipeContext } from './types.ts';
import { collectReports, fillCode, firstVisible, mustFind, RecipeDriftError, reportLinks, tenDigits, untickMarketing, visibleError } from './kit.ts';

export const METROPOLIS_ORIGIN = 'https://www.metropolisindia.com';

/** The header still offers Login: nobody is signed in. */
async function signedIn(page: Page): Promise<boolean> {
  return !(await firstVisible(page, ['span.login-text:has-text("Login")', 'header :text-is("Login")'], 3000));
}

async function signIn(ctx: RecipeContext): Promise<void> {
  const { page } = ctx;
  await ctx.step('Signing in to Metropolis');
  if (!(await firstVisible(page, ['form#signin #mobile_number', 'form#signin-mob #mobileNumber'], 500))) {
    const opener = await mustFind(page, ['span.login-text', 'a:has-text("Login")', 'button:has-text("Login")'], 'the Login button');
    await opener.click();
  }
  // Desktop sign-in, or the phone layout's own.
  const field = await mustFind(page, ['form#signin #mobile_number', 'form#signin-mob #mobileNumber'], 'the sign-in mobile number field');
  const desktop = (await field.getAttribute('id')) === 'mobile_number';
  const phone = tenDigits(ctx.identifier ?? await ctx.ask({ kind: 'phone', label: 'Mobile number registered with Metropolis' }));
  if (phone.length !== 10) throw new PortalError('Metropolis needs a 10-digit mobile number.');
  await field.fill(phone);
  await untickMarketing(page.locator(desktop ? 'form#signin' : 'form#signin-mob'));
  await (await mustFind(page, desktop ? ['#sendOtpBtn'] : ['#getOtpBtn'], 'the Send OTP button')).click();

  const boxes = desktop ? '#otp1' : '.otp-box';
  if (!(await firstVisible(page, [boxes], 15_000))) throw new PortalError((await visibleError(page)) ?? 'Metropolis did not send an OTP to that number.');
  ctx.remember(phone);
  for (let attempt = 0; attempt < 2; attempt++) {
    const code = await ctx.ask({ kind: 'otp', label: attempt ? 'That OTP was not accepted. Enter the new OTP from Metropolis' : 'OTP Metropolis sent to your phone' });
    await fillCode(page, code, [boxes]);
    await (await mustFind(page, desktop ? ['#verifyOtpBtn'] : ['#verifyOtpMobBtn'], 'the Verify button')).click();
    await page.waitForLoadState('load').catch(() => {});
    await page.waitForTimeout(1500);
    if (await signedIn(page)) return;
  }
  throw new PortalError((await visibleError(page)) ?? 'Metropolis did not accept the OTP.');
}

export const metropolisRecipe = (origin = METROPOLIS_ORIGIN): Recipe => ({
  sourceId: 'metropolis',
  async run(ctx): Promise<PortalReport[]> {
    const { page } = ctx;
    await ctx.step('Opening Metropolis');
    await page.goto(`${origin}/`);
    await page.waitForLoadState('load').catch(() => {});
    if (!(await signedIn(page))) await signIn(ctx);
    await ctx.step('Reading your reports');
    let links = await reportLinks(page);
    if (!links.length) {
      const entry = await firstVisible(page, ['a:has-text("My Reports")', 'a:has-text("Reports")', '#btab-btn-report', 'a:has-text("Download Report")', 'button:has-text("Download Report")'], 5000);
      if (entry) {
        await Promise.all([page.waitForLoadState('load').catch(() => {}), entry.click()]);
        await firstVisible(page, ['a:has-text("Download")', 'button:has-text("Download")', 'a:has-text("View Report")', 'text=/no reports/i'], 10_000);
        links = await reportLinks(page);
      }
    }
    if (!links.length) {
      const text = (await page.locator('body').innerText().catch(() => '')).toLowerCase();
      if (/no reports? (found|available|yet)/.test(text)) return [];
      throw new RecipeDriftError('Signed in to Metropolis, but found no list of reports');
    }
    return collectReports(ctx, 'Metropolis', links);
  },
});

// Thyrocare: reports for people who have had a test ("Already Availed Service") on Thyrocare's report login,
// b2capi.thyrocare.com/login.aspx. Written from that page as published in November 2026; it has not been run
// against a real Thyrocare account yet.
//
// The page (ASP.NET WebForms, so its element ids are stable):
//   #a2                         the "Already Availed Service" tab
//   #txt_mob2 + #but_proceed_mob_validation   mobile number, then Proceed (the page checks the number)
//   #A6 → #txt_OTP_2 → #A5      Generate OTP, the 4-digit OTP, Submit OTP
//   #txt_pwd2 + #btl_pwd2       or a password, for accounts that have one
//   #txt_barcode_reg, #txt_labcode_reg   first visit only: barcode and lab code printed on a report
// After signing in the portal lists the person's reports; the recipe downloads every report link it finds there,
// and opens a "Reports" page first if the landing page has a link to one.
import { PortalError, type PortalReport, type Recipe, type RecipeContext } from './types.ts';
import { collectReports, fillCode, firstVisible, mustFind, RecipeDriftError, reportLinks, visibleError } from './kit.ts';

export const THYROCARE_LOGIN_URL = 'https://b2capi.thyrocare.com/login.aspx';

const onLogin = (url: string) => /\/login\.aspx/i.test(url);
const ERRORS = '#err:visible, .error:visible, [role=alert]:visible';

/** Click, then wait until the portal leaves the login page or shows an error that was not there before. */
async function submitAndSettle(page: RecipeContext['page'], selector: string): Promise<void> {
  const shown = await page.locator(ERRORS).first().isVisible().catch(() => false);
  await Promise.all([page.waitForLoadState('load').catch(() => {}), page.click(selector)]);
  await Promise.race([
    page.waitForURL(u => !onLogin(u.href), { timeout: 15_000 }),
    ...(shown ? [] : [page.locator(ERRORS).first().waitFor({ timeout: 15_000 })]),
  ]).catch(() => {});
}

async function signIn(ctx: RecipeContext): Promise<void> {
  const { page } = ctx;
  await ctx.step('Signing in to Thyrocare');
  const tab = await firstVisible(page, ['#a2', 'a:has-text("Already Availed Service")'], 4000);
  if (tab) await tab.click();
  const phoneField = await mustFind(page, ['#txt_mob2'], 'the mobile number field');
  const phone = (ctx.identifier ?? await ctx.ask({ kind: 'phone', label: 'Mobile number you gave Thyrocare' })).replace(/\D/g, '').slice(-10);
  if (phone.length !== 10) throw new PortalError('Thyrocare needs a 10-digit mobile number.');
  await phoneField.fill(phone);
  await (await mustFind(page, ['#but_proceed_mob_validation'], 'the Proceed button')).click();

  // Thyrocare offers an OTP, a password, or (first visit) asks for the barcode and lab code from a report.
  const next = await firstVisible(page, ['#A6', '#txt_OTP_2', '#txt_pwd2', '#txt_barcode_reg'], 15_000);
  if (!next) throw new PortalError((await visibleError(page)) ?? 'Thyrocare did not accept that mobile number.');
  ctx.remember(phone);
  const id = await next.getAttribute('id');
  if (id === 'txt_barcode_reg') {
    throw new PortalError('Thyrocare asks for the barcode and lab code printed on one of your reports the first time. Sign in once at b2capi.thyrocare.com, then try again.');
  }
  if (id === 'txt_pwd2') {
    const password = await ctx.ask({ kind: 'password', label: 'Your Thyrocare password', secret: true });
    await page.fill('#txt_pwd2', password);
    await submitAndSettle(page, '#btl_pwd2');
  } else {
    if (id === 'A6') await page.click('#A6');
    for (let attempt = 0; attempt < 2; attempt++) {
      const code = await ctx.ask({ kind: 'otp', label: attempt ? 'That OTP was not accepted. Enter the new OTP Thyrocare sent' : 'OTP Thyrocare sent to your phone' });
      await fillCode(page, code, ['#txt_OTP_2']);
      await submitAndSettle(page, '#A5');
      if (!onLogin(page.url())) return;
      if (attempt === 0) await firstVisible(page, ['#A6'], 2000).then(b => b?.click());
    }
    throw new PortalError((await visibleError(page)) ?? 'Thyrocare did not accept the OTP.');
  }
  if (onLogin(page.url())) throw new PortalError((await visibleError(page)) ?? 'Thyrocare did not accept that password.');
}

export const thyrocareRecipe = (loginUrl = THYROCARE_LOGIN_URL): Recipe => ({
  sourceId: 'thyrocare',
  async run(ctx): Promise<PortalReport[]> {
    const { page } = ctx;
    await ctx.step('Opening Thyrocare');
    await page.goto(loginUrl);
    // A kept sign-in sends the login page on to the reports.
    await page.waitForLoadState('load').catch(() => {});
    if (onLogin(page.url()) && await firstVisible(page, ['#txt_mob2', '#a2', '#txtUserID'], 6000)) await signIn(ctx);
    await ctx.step('Reading your reports');
    let links = await reportLinks(page);
    if (!links.length) {
      const reportsPage = await firstVisible(page, ['a:has-text("My Reports")', 'a:has-text("Reports")', 'a:has-text("Report")'], 4000);
      if (reportsPage) {
        await Promise.all([page.waitForLoadState('load').catch(() => {}), reportsPage.click()]);
        links = await reportLinks(page);
      }
    }
    if (!links.length) {
      // Signed in, but no list where we expected one: either there are none, or the page changed.
      const text = (await page.locator('body').innerText().catch(() => '')).toLowerCase();
      if (/no (reports?|records?) found|no data/.test(text)) return [];
      throw new RecipeDriftError('Signed in to Thyrocare, but found no list of reports');
    }
    return collectReports(ctx, 'Thyrocare', links);
  },
});

// Dr Lal PathLabs: reports through the person's account on lalpathlabs.com (sign in with a mobile number and an
// OTP), from the orders page (/profile/orders). Written from the site as published in November 2026; it has not
// been run against a real Dr Lal account yet.
//
// What the site shows:
//   - "Login / Sign Up" in the header (button.msb-user) opens the sign-in; signed-in pages show the person's name.
//   - /profile/orders lists past orders with a report button per order once results are out.
//   - /download-report also downloads one report by Lab / Visit ID and the password printed on the bill, but it is
//     behind a reCAPTCHA checkbox, so the recipe does not use it.
//   - The home and report pages also carry "Get a Callback" forms that take a mobile number. The recipe only ever
//     types the number inside the sign-in dialog, never into those forms (they request a sales call).
// Element names on the sign-in dialog are not fixed (the site is a React app), so each step tries a few likely
// shapes, and anything missing ends the recipe with RecipeDriftError for the navigator to take over.
import type { Locator, Page } from 'playwright-core';
import { PortalError, type PortalReport, type Recipe, type RecipeContext } from './types.ts';
import { collectReports, DIALOGS, fillCode, findDialogWith, firstVisible, mustFind, PHONE_FIELDS, RecipeDriftError, reportLinks, tenDigits, untickMarketing, visibleError } from './kit.ts';

export const DRLAL_ORIGIN = 'https://www.lalpathlabs.com';

const SEND = ['button:has-text("Send OTP")', 'button:has-text("Get OTP")', 'button:has-text("Request OTP")', 'button:has-text("Continue")', 'button:has-text("Proceed")', 'button:has-text("Login")', 'button[type=submit]'];
const VERIFY = ['button:has-text("Verify")', 'button:has-text("Submit")', 'button:has-text("Login")', 'button:has-text("Continue")', 'button:has-text("Proceed")', 'button[type=submit]'];
const CODE = ['input[autocomplete="one-time-code"]', 'input[placeholder*="otp" i]', 'input[name*="otp" i]', 'input[id*="otp" i]', 'input[maxlength="4"]', 'input[maxlength="6"]'];

/** Whether the page shows a signed-in person (the header no longer says Guest). */
async function signedIn(page: Page): Promise<boolean> {
  const guest = await firstVisible(page, ['text=Welcome Guest User', 'text=Login / Sign Up'], 2500);
  return !guest;
}

/** The sign-in dialog holding the mobile number field (never a callback form). */
async function loginDialog(page: Page, timeoutMs = 300): Promise<{ box: Locator; phone: Locator } | null> {
  const found = await findDialogWith(page, DIALOGS, PHONE_FIELDS, '.consultation-form, :text("Get a Callback")', timeoutMs);
  return found && { box: found.box, phone: found.field };
}

async function signIn(ctx: RecipeContext): Promise<void> {
  const { page } = ctx;
  await ctx.step('Signing in to Dr Lal PathLabs');
  let found = await loginDialog(page);
  if (!found) {
    const opener = await mustFind(page, ['button.msb-user', 'button:has-text("Login / Sign Up")', 'a:has-text("Login")', 'button:has-text("Login")'], 'the Login / Sign Up button');
    await opener.click();
    found = await loginDialog(page, 10_000);
  }
  if (!found) throw new RecipeDriftError('The Dr Lal sign-in did not open');
  const { box, phone: phoneField } = found;
  const phone = tenDigits(ctx.identifier ?? await ctx.ask({ kind: 'phone', label: 'Mobile number registered with Dr Lal PathLabs' }));
  if (phone.length !== 10) throw new PortalError('Dr Lal PathLabs needs a 10-digit mobile number.');
  await phoneField.fill(phone);
  await untickMarketing(box);
  await (await mustFind(box, SEND, 'the button that sends the OTP')).click();

  // The OTP step: a code field (or a row of boxes) appears in the same dialog.
  const codeReady = await firstVisible(page, [...CODE.map(c => `${c}:not([type=tel])`), 'input[maxlength="1"]'], 15_000);
  if (!codeReady) throw new PortalError((await visibleError(box)) ?? 'Dr Lal PathLabs did not send an OTP to that number.');
  ctx.remember(phone);
  for (let attempt = 0; attempt < 2; attempt++) {
    const code = await ctx.ask({ kind: 'otp', label: attempt ? 'That OTP was not accepted. Enter the new OTP from Dr Lal PathLabs' : 'OTP Dr Lal PathLabs sent to your phone' });
    const scope = (await box.isVisible().catch(() => false)) ? box : page;
    await fillCode(scope, code, CODE);
    const verify = await firstVisible(scope, VERIFY, 3000);
    if (verify) await verify.click();
    else await page.keyboard.press('Enter');
    await page.waitForLoadState('load').catch(() => {});
    await page.waitForTimeout(1500);
    if (await signedIn(page)) return;
  }
  throw new PortalError((await visibleError(page)) ?? 'Dr Lal PathLabs did not accept the OTP.');
}

export const drlalRecipe = (origin = DRLAL_ORIGIN): Recipe => ({
  sourceId: 'drlal',
  async run(ctx): Promise<PortalReport[]> {
    const { page } = ctx;
    await ctx.step('Opening Dr Lal PathLabs');
    await page.goto(`${origin}/profile/orders`);
    await page.waitForLoadState('load').catch(() => {});
    if (!(await signedIn(page))) {
      await signIn(ctx);
      await page.goto(`${origin}/profile/orders`);
      await page.waitForLoadState('load').catch(() => {});
      if (!(await signedIn(page))) throw new RecipeDriftError('Signed in, but the orders page still shows a guest');
    }
    await ctx.step('Reading your orders');
    // Orders load after the page; give the list a moment.
    await firstVisible(page, ['button:has-text("Report")', 'a:has-text("Report")', 'text=/no (orders|bookings)/i'], 10_000);
    const links = await reportLinks(page);
    if (!links.length) {
      const text = (await page.locator('body').innerText().catch(() => '')).toLowerCase();
      if (/no (orders|bookings|reports)/.test(text)) return [];
      throw new RecipeDriftError('Signed in to Dr Lal PathLabs, but found no reports on the orders page');
    }
    return collectReports(ctx, 'Dr Lal PathLabs', links);
  },
});

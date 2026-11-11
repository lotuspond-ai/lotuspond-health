// The recipe for the Demo Lab portal (records/demo-portal.ts): the pattern a recipe for a real lab portal follows.
// Open the reports page; if it sends us to sign in, ask the person for their mobile number (once; it is remembered)
// and the code the portal texts them, then read the report list and download each PDF.
import { DEMO_SOURCE_ID } from '../../../../shared/sources.ts';
import { DEMO_OTP } from '../demo-portal.ts';
import { PortalError, type PortalReport, type Recipe, type RecipeContext } from './types.ts';

async function signIn(ctx: RecipeContext): Promise<void> {
  const { page } = ctx;
  await ctx.step('Signing in');
  const phone = ctx.identifier ?? await ctx.ask({ kind: 'phone', label: 'Mobile number registered with Demo Lab' });
  await page.fill('#phone', phone);
  await Promise.all([page.waitForURL(/\/(otp|login)/), page.click('button[type=submit]')]);
  if (!/\/otp/.test(page.url())) throw new PortalError('Demo Lab did not accept that mobile number.');
  ctx.remember(phone);
  for (let attempt = 0; attempt < 2; attempt++) {
    const code = await ctx.ask({
      kind: 'otp', label: attempt ? 'That code was not accepted. Enter the new code from Demo Lab' : 'Code Demo Lab sent to your phone',
      hint: `Demo portal: the code is ${DEMO_OTP}`,
    });
    await page.fill('#otp', code);
    await Promise.all([page.waitForLoadState('load'), page.click('button[type=submit]')]);
    if (/\/reports/.test(page.url())) return;
  }
  throw new PortalError('Demo Lab did not accept the code.');
}

export const demoRecipe: Recipe = {
  sourceId: DEMO_SOURCE_ID,
  async run(ctx) {
    const { page } = ctx;
    await ctx.step('Opening Demo Lab');
    await page.goto(`${ctx.startUrl}/reports`);
    if (/\/login/.test(page.url())) {
      await signIn(ctx);
    }
    await ctx.step('Reading the list of reports');
    // Runs in the page (no DOM types on the server, hence the loose types).
    const listed: { id: string; date: string | null; title: string; href: string }[] = await page.$$eval('tr[data-report-id]', (rows: any[]) => rows.map(r => ({
      id: r.getAttribute('data-report-id') ?? '',
      date: r.getAttribute('data-date'),
      title: r.querySelector('td')?.textContent?.trim() ?? 'Report',
      href: r.querySelector('a[href]')?.href ?? '',
    })));
    const out: PortalReport[] = [];
    for (const [i, r] of listed.entries()) {
      if (!r.id || !r.href) continue;
      await ctx.step(`Downloading report ${i + 1} of ${listed.length}`);
      const file = await ctx.download(r.href);
      out.push({ key: r.id, title: r.title, date: r.date, fileName: `Demo Lab ${r.title} ${r.date ?? ''}`.trim() + '.pdf', contentType: file.contentType, bytes: file.bytes });
    }
    return out;
  },
};

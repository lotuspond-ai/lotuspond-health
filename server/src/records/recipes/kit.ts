// Helpers shared by recipes: finding the first of several possible elements (portals redesign often), typing a code
// into one field or a row of one-digit boxes, downloading a file behind a link or a button, and collecting report
// links from a page. A recipe that cannot find what it expects throws RecipeDriftError: the portal has probably
// changed, and the record agent hands the run to the navigator when it is on (service.ts).
import { readFile } from 'node:fs/promises';
import type { Locator, Page } from 'playwright-core';
import { PortalError, REPORT_TYPES, sniffType, type RecipeContext } from './types.ts';

/** The portal no longer looks the way the recipe expects. */
export class RecipeDriftError extends Error {}

/** The first locator that becomes visible within the time, or null. Each candidate is a CSS or text selector. */
export async function firstVisible(scope: Page | Locator, selectors: string[], timeoutMs = 8000): Promise<Locator | null> {
  const end = Date.now() + timeoutMs;
  do {
    for (const s of selectors) {
      const all = scope.locator(s);
      const n = await all.count().catch(() => 0);
      for (let i = 0; i < Math.min(n, 10); i++) {
        const el = all.nth(i);
        if (await el.isVisible().catch(() => false)) return el;
      }
    }
    await new Promise(r => setTimeout(r, 250));
  } while (Date.now() < end);
  return null;
}

/** Like firstVisible, but a missing element means the portal changed. */
export async function mustFind(scope: Page | Locator, selectors: string[], what: string, timeoutMs = 10_000): Promise<Locator> {
  const el = await firstVisible(scope, selectors, timeoutMs);
  if (!el) throw new RecipeDriftError(`Could not find ${what}`);
  return el;
}

/** Type a one-time code: into one field, or one digit per box when the portal shows a row of boxes. */
export async function fillCode(scope: Page | Locator, code: string, single: string[]): Promise<void> {
  const digits = code.replace(/\s+/g, '');
  const boxes = scope.locator('input[maxlength="1"]:visible');
  const n = await boxes.count().catch(() => 0);
  if (n >= 4 && n <= 8) {
    for (let i = 0; i < Math.min(n, digits.length); i++) await boxes.nth(i).fill(digits[i]);
    return;
  }
  const field = await mustFind(scope, single, 'the code field');
  await field.fill(digits);
}

/** Text of a visible error message near a form, if the portal shows one. */
export async function visibleError(scope: Page | Locator): Promise<string | null> {
  const el = await firstVisible(scope, ['[role=alert]', '.error', '.text-danger', '.text-error:not(:has-text("Find Barcode"))', '.invalid-feedback', '[class*="error" i]'], 600);
  const t = el ? (await el.innerText().catch(() => '')).replace(/\s+/g, ' ').trim() : '';
  return t && t.length < 200 ? t : null;
}

/**
 * Download what an element gives: its href, a download it starts, or the page it opens in a new tab. Goes through
 * ctx.download for addresses, so the host rule and size limit apply.
 */
export async function downloadFrom(ctx: RecipeContext, el: Locator): Promise<{ bytes: Uint8Array; contentType: string } | null> {
  const { page } = ctx;
  const href = await el.getAttribute('href').catch(() => null);
  if (href && !/^(javascript:|#)/i.test(href)) return ctx.download(new URL(href, page.url()).href);
  const download = page.waitForEvent('download', { timeout: 20_000 });
  const popup = page.context().waitForEvent('page', { timeout: 20_000 });
  download.catch(() => {});
  popup.catch(() => {});
  await el.click();
  const first = await Promise.race([download.then(d => ({ d })), popup.then(p => ({ p }))]).catch(() => null);
  if (first && 'd' in first) {
    const path = await first.d.path().catch(() => null);
    if (!path) return null;
    const bytes = new Uint8Array(await readFile(path));
    if (bytes.byteLength > ctx.maxBytes) throw new PortalError('A report was larger than LotusPond accepts.');
    return { bytes, contentType: 'application/octet-stream' };
  }
  if (first && 'p' in first) {
    await first.p.waitForLoadState('load').catch(() => {});
    const url = first.p.url();
    await first.p.close().catch(() => {});
    return url && url !== 'about:blank' ? ctx.download(url) : null;
  }
  return null;
}

/** "12/03/2026", "12-Mar-2026", "2026-03-12" or "12 Mar 2026" in a piece of text, as yyyy-mm-dd. */
export function findDate(text: string): string | null {
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const iso = text.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const dmy = text.match(/\b(\d{1,2})[/.-](\d{1,2})[/.-](20\d{2})\b/);
  if (dmy) return `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;
  const named = text.match(/\b(\d{1,2})[\s-]([A-Za-z]{3})[a-z]*[\s,-]+(20\d{2})\b/);
  if (named) {
    const m = months.indexOf(named[2].toLowerCase());
    if (m >= 0) return `${named[3]}-${String(m + 1).padStart(2, '0')}-${named[1].padStart(2, '0')}`;
  }
  // "01 Sep, 26" (Apollo 24|7): a two-digit year, taken as 20xx.
  const short = text.match(/\b(\d{1,2})[\s-]([A-Za-z]{3})[a-z]*,?[\s-](\d{2})\b(?!\d|:)/);
  if (short) {
    const m = months.indexOf(short[2].toLowerCase());
    if (m >= 0) return `20${short[3]}-${String(m + 1).padStart(2, '0')}-${short[1].padStart(2, '0')}`;
  }
  return null;
}

export interface ReportLink {
  el: Locator;
  /** A stable id for the report: a lab number on the row, the link's address, or its text and date. */
  key: string;
  title: string;
  date: string | null;
}

/**
 * Report links and buttons on a page: elements whose text says download, view report or PDF, or whose address
 * points to a PDF or a report. Each takes its title and date from the row or card around it.
 */
export async function reportLinks(page: Page): Promise<ReportLink[]> {
  const candidates = page.locator([
    'a[href$=".pdf" i]', 'a[href*=".pdf?" i]', 'a[href*="report" i]:not([href*="download-report"]):not([href$="/reports"])',
    'a:has-text("Download")', 'button:has-text("Download")', 'a:has-text("View Report")', 'button:has-text("View Report")',
    'a:has-text("PDF")', 'button:has-text("PDF")', '[role=button]:has-text("Download")',
  ].join(', '));
  const n = Math.min(await candidates.count().catch(() => 0), 60);
  const out: ReportLink[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < n; i++) {
    const el = candidates.nth(i);
    if (!(await el.isVisible().catch(() => false))) continue;
    const text = (await el.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
    // Sample and brochure PDFs on marketing pages are not the person's, and "My Reports" is a menu, not a report.
    if (/sample|brochure|terms|policy|certificate|accreditation/i.test(text)) continue;
    if (/^(my |all |view all |download )?(test |lab |health )?reports$/i.test(text)) continue;
    const href = await el.getAttribute('href').catch(() => null);
    const row = el.locator(`xpath=ancestor::*[self::tr or self::li or contains(translate(@class,'CARDORE','cardore'),'card') or contains(translate(@class,'CARDORE','cardore'),'order') or contains(translate(@class,'REPORT','report'),'report')][1]`);
    const rowText = ((await row.count().catch(() => 0)) ? await row.first().innerText().catch(() => '') : text).replace(/\s+/g, ' ').trim();
    const labNo = rowText.match(/\b(?:lab|visit|order|barcode|booking)\s*(?:no\.?|number|id)?\s*[:#-]?\s*([A-Z0-9]{6,})\b/i)?.[1] ?? null;
    const date = findDate(rowText);
    const title = rowText.replace(/\b(download|view report|view|pdf|report)\b/gi, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Report';
    const key = labNo ? `lab:${labNo}:${title}` : href && !/^(javascript:|#)/i.test(href) ? `href:${new URL(href, page.url()).pathname}${new URL(href, page.url()).search}` : `text:${title}:${date ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ el, key, title, date });
  }
  return out;
}

/** Download every report link on the current page into PortalReports. */
export async function collectReports(ctx: RecipeContext, labName: string, links: ReportLink[]) {
  const reports = [];
  for (const [i, l] of links.entries()) {
    await ctx.step(`Downloading report ${i + 1} of ${links.length}`);
    const file = await downloadFrom(ctx, l.el);
    if (!file?.bytes.byteLength) continue;
    // A link that led to a web page (a menu, a viewer) rather than a file is not a report.
    if (!REPORT_TYPES[sniffType(file.bytes, file.contentType)]) continue;
    reports.push({ key: l.key, title: l.title, date: l.date, fileName: `${labName} ${l.title}${l.date ? ` ${l.date}` : ''}`, contentType: file.contentType, bytes: file.bytes });
  }
  return reports;
}

/**
 * The visible dialog or panel that holds one of `fields` (a sign-in, usually), skipping containers that match
 * `exclude` (lead and callback forms that also take a mobile number). Waits up to the time given.
 */
export async function findDialogWith(page: Page, dialogs: string[], fields: string[], exclude?: string, timeoutMs = 10_000): Promise<{ box: Locator; field: Locator } | null> {
  const end = Date.now() + timeoutMs;
  do {
    for (const d of dialogs) {
      const boxes = page.locator(d);
      const n = Math.min(await boxes.count().catch(() => 0), 8);
      for (let i = 0; i < n; i++) {
        const box = boxes.nth(i);
        if (!(await box.isVisible().catch(() => false))) continue;
        if (exclude && await box.locator(exclude).count().catch(() => 0)) continue;
        const field = await firstVisible(box, fields, 200);
        if (field) return { box, field };
      }
    }
    await new Promise(r => setTimeout(r, 300));
  } while (Date.now() < end);
  return null;
}

/** Mobile number fields, in the order portals usually mark them. */
export const PHONE_FIELDS = ['input[type=tel]', 'input[placeholder*="mobile" i]', 'input[name*="mobile" i]', 'input[name*="phone" i]', 'input[maxlength="10"]'];
/** Containers a sign-in usually opens in. */
export const DIALOGS = ['[role=dialog]', '[aria-modal="true"]', '.modal.show', '[class*="modal" i]:visible', '[class*="login" i]:visible', '[class*="drawer" i]:visible', '[class*="sidebar" i]:visible'];

/** The 10-digit Indian mobile number from what the person typed (with or without +91, spaces or dashes). */
export function tenDigits(v: string): string {
  return v.replace(/\D/g, '').slice(-10);
}

/**
 * Untick boxes a sign-in ticks for the person, for marketing ("Share health tips … and offers with me on WhatsApp").
 * They did not agree to that through LotusPond. Boxes for terms or consent the sign-in needs are left alone.
 */
export async function untickMarketing(scope: Page | Locator): Promise<number> {
  const boxes = scope.locator('input[type=checkbox]');
  const n = Math.min(await boxes.count().catch(() => 0), 10);
  let unticked = 0;
  for (let i = 0; i < n; i++) {
    const box = boxes.nth(i);
    if (!(await box.isChecked().catch(() => false))) continue;
    const label = await box.evaluate((el: any) => (el.closest('label')?.innerText || el.parentElement?.innerText || el.parentElement?.parentElement?.innerText || '').slice(0, 300)).catch(() => '');
    if (!/whats ?app|offers?|promotion|marketing|newsletter|health tips|updates/i.test(label) || /terms|privacy|i agree|consent to (the )?(processing|terms)/i.test(label)) continue;
    await box.uncheck({ force: true }).catch(() => box.click({ force: true }).catch(() => {}));
    if (!(await box.isChecked().catch(() => true))) unticked++;
  }
  return unticked;
}

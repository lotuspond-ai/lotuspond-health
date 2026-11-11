// Where the record agent's browsers run (docs/record-agent.md §3). Every run gets a browser of its own, a separate
// "computer" for that person and portal: nothing is shared between runs except the sign-in the person chose to keep,
// which is loaded into the new browser as Playwright storage state. Three kinds:
//
//   local        Chromium started on this server for the run, then closed (Playwright).
//   cdp          a hosted browser reached over the Chrome DevTools Protocol: Steel, Browserless, Hyperbrowser, Anchor
//                or your own (one wss:// address with its key). Each connection gets a fresh browser from the service.
//   browserbase  a Browserbase session created for the run (REST API), connected over CDP, released at the end.
//
// The browser can reach only the portal's own hosts (and the page it was started on): every other request is
// blocked, so a page cannot send the person's data elsewhere through the agent.
import { chromium, type Browser, type BrowserContext } from 'playwright-core';
import type { RecordAgentConfig } from '../config.ts';
import { PortalError } from './recipes/types.ts';

export type StorageState = Awaited<ReturnType<BrowserContext['storageState']>>;

export interface BrowserSession {
  context: BrowserContext;
  /** "LotusPond's servers" or the provider's name, for the activity text. */
  where: string;
  /** Save the sign-in, then close the browser (and release the hosted session). */
  close(): Promise<StorageState | null>;
}

export interface OpenOptions {
  /** Hosts the browser may reach (subdomains included). */
  allowHosts: string[];
  storageState?: StorageState;
  /** Downloads are captured in memory by the recipe; the browser must allow them. */
  acceptDownloads?: boolean;
}

export interface BrowserProvider {
  /** Shown to the person: where the browser runs. */
  label: string;
  open(opts: OpenOptions): Promise<BrowserSession>;
}

/** Whether a URL's host is one of the allowed hosts or a subdomain of one. Data, blob and about URLs are allowed. */
export function hostAllowed(url: string, allow: string[]): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol === 'data:' || u.protocol === 'blob:' || u.protocol === 'about:') return true;
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  const host = u.hostname.toLowerCase();
  return allow.some(h => {
    const a = h.toLowerCase().replace(/^\.+/, '');
    return host === a || host.endsWith(`.${a}`);
  });
}

async function prepare(context: BrowserContext, opts: OpenOptions): Promise<void> {
  context.setDefaultTimeout(30_000);
  context.setDefaultNavigationTimeout(45_000);
  await context.route('**/*', route => {
    const url = route.request().url();
    return hostAllowed(url, opts.allowHosts) ? route.continue() : route.abort('blockedbyclient');
  });
}

const contextOptions = (opts: OpenOptions) => ({
  ...(opts.storageState ? { storageState: opts.storageState } : {}),
  acceptDownloads: opts.acceptDownloads ?? true,
  locale: 'en-IN',
  timezoneId: 'Asia/Kolkata',
  viewport: { width: 1280, height: 900 },
  // Service workers could fetch around the request filter.
  serviceWorkers: 'block' as const,
});

/** Save the sign-in and close; never throws (a failed close must not lose the run's result). */
async function finish(context: BrowserContext, browser: Browser, release?: () => Promise<void>): Promise<StorageState | null> {
  let state: StorageState | null = null;
  try { state = await context.storageState(); } catch { /* the browser went away */ }
  try { await context.close(); } catch { /* already closed */ }
  try { await browser.close(); } catch { /* already closed */ }
  if (release) await release().catch(() => {});
  return state;
}

export function localBrowsers(opts: { executablePath?: string; headless?: boolean } = {}): BrowserProvider {
  return {
    label: 'LotusPond’s servers',
    async open(o) {
      const browser = await chromium.launch({
        headless: opts.headless ?? true,
        ...(opts.executablePath ? { executablePath: opts.executablePath } : {}),
        // No sandbox only where Chromium cannot create one (containers running as root).
        args: process.getuid?.() === 0 ? ['--no-sandbox'] : [],
      });
      try {
        const context = await browser.newContext(contextOptions(o));
        await prepare(context, o);
        return { context, where: this.label, close: () => finish(context, browser) };
      } catch (e) {
        await browser.close().catch(() => {});
        throw e;
      }
    },
  };
}

/** Name of a CDP service from its address, for the person: "Steel", "Browserless" or the host. */
function serviceName(url: string): string {
  const host = (() => { try { return new URL(url).hostname; } catch { return 'a browser service'; } })();
  const known: [RegExp, string][] = [[/steel\.dev$/, 'Steel'], [/browserless\.io$/, 'Browserless'], [/hyperbrowser\.ai$/, 'Hyperbrowser'], [/anchorbrowser\.io$/, 'Anchor Browser'], [/browserbase\.com$/, 'Browserbase']];
  return known.find(([re]) => re.test(host))?.[1] ?? host;
}

export function cdpBrowsers(url: string): BrowserProvider {
  return {
    label: serviceName(url),
    async open(o) {
      const browser = await chromium.connectOverCDP(url, { timeout: 30_000 });
      try {
        const context = await browser.newContext(contextOptions(o));
        await prepare(context, o);
        return { context, where: this.label, close: () => finish(context, browser) };
      } catch (e) {
        await browser.close().catch(() => {});
        throw e;
      }
    },
  };
}

/**
 * Browserbase: POST /v1/sessions creates a browser and returns its connectUrl; releasing it (status REQUEST_RELEASE)
 * ends the session early instead of at its timeout. Written from Browserbase's API reference; not yet run against
 * the live service.
 */
export function browserbaseBrowsers(c: { apiKey: string; projectId: string; apiUrl: string }, fetchImpl: typeof fetch = fetch): BrowserProvider {
  const headers = { 'X-BB-API-Key': c.apiKey, 'Content-Type': 'application/json' };
  return {
    label: 'Browserbase',
    async open(o) {
      const res = await fetchImpl(`${c.apiUrl}/v1/sessions`, {
        method: 'POST', headers,
        // Each run is a new session; keepAlive off, so it ends when we disconnect.
        body: JSON.stringify({ projectId: c.projectId, keepAlive: false, timeout: 15 * 60, browserSettings: { viewport: { width: 1280, height: 900 } } }),
      });
      if (!res.ok) throw new Error(`Browserbase refused a new session (${res.status})`);
      const session = await res.json() as { id: string; connectUrl: string };
      const release = async () => {
        await fetchImpl(`${c.apiUrl}/v1/sessions/${session.id}`, { method: 'POST', headers, body: JSON.stringify({ projectId: c.projectId, status: 'REQUEST_RELEASE' }) });
      };
      let browser: Browser | null = null;
      try {
        browser = await chromium.connectOverCDP(session.connectUrl, { timeout: 30_000 });
        const context = await browser.newContext(contextOptions(o));
        await prepare(context, o);
        const b = browser;
        return { context, where: this.label, close: () => finish(context, b, release) };
      } catch (e) {
        await browser?.close().catch(() => {});
        await release().catch(() => {});
        throw e;
      }
    },
  };
}

export function browserProvider(c: RecordAgentConfig['browser']): BrowserProvider {
  if (c.kind === 'cdp') return cdpBrowsers(c.url);
  if (c.kind === 'browserbase') return browserbaseBrowsers(c);
  return localBrowsers({ executablePath: c.executablePath });
}

/** Download a file in the browser's session (its cookies), following redirects only to allowed hosts. */
export async function downloadFile(context: BrowserContext, url: string, allowHosts: string[], maxBytes: number): Promise<{ bytes: Uint8Array; contentType: string }> {
  let target = url;
  for (let hop = 0; hop < 4; hop++) {
    if (!hostAllowed(target, allowHosts)) throw new PortalError('The portal pointed to a file on another website, which the record agent does not open.');
    const res = await context.request.get(target, { maxRedirects: 0, timeout: 60_000, failOnStatusCode: false });
    if (res.status() >= 300 && res.status() < 400 && res.headers().location) {
      target = new URL(res.headers().location, target).href;
      await res.dispose();
      continue;
    }
    if (!res.ok()) throw new PortalError(`The portal did not hand over a report (status ${res.status()}).`);
    const length = Number(res.headers()['content-length'] ?? 0);
    if (length > maxBytes) throw new PortalError('A report was larger than LotusPond accepts.');
    const body = new Uint8Array(await res.body());
    if (body.byteLength > maxBytes) throw new PortalError('A report was larger than LotusPond accepts.');
    return { bytes: body, contentType: res.headers()['content-type'] ?? 'application/octet-stream' };
  }
  throw new PortalError('The portal redirected too many times.');
}

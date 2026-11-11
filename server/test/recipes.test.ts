// The Dr Lal PathLabs and Thyrocare recipes against local copies of their portals (fixtures/lab-portals.ts), in a
// real Chromium: signing in with the person's answers, a wrong OTP, the password and first-visit variants, keeping
// the sign-in, skipping sample and terms PDFs, never touching the "Get a Callback" form, and RecipeDriftError
// when the page no longer looks as expected.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { serve, type ServerType } from '@hono/node-server';
import { Hono } from 'hono';
import { sourceById } from '../../shared/sources.ts';
import { downloadFile, localBrowsers, type StorageState } from '../src/records/browsers.ts';
import { drlalRecipe } from '../src/records/recipes/drlal.ts';
import { thyrocareRecipe } from '../src/records/recipes/thyrocare.ts';
import { RecipeDriftError } from '../src/records/recipes/kit.ts';
import { NeedsPersonError, PortalError, type Ask, type PortalReport, type Recipe } from '../src/records/recipes/types.ts';
import { drlalPortal, DRLAL_OTP, thyrocarePortal, THYROCARE_OTP } from './fixtures/lab-portals.ts';

const servers: ServerType[] = [];
async function host(app: Hono): Promise<string> {
  const s = await new Promise<ServerType>(resolve => { const x = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, () => resolve(x)); });
  servers.push(s);
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}
after(() => { for (const s of servers) s.close(); });

const browsers = localBrowsers();

interface Run { reports: PortalReport[]; asked: Ask[]; remembered: string | null; state: StorageState | null }

/** Run a recipe the way the record agent does, answering its questions from `answers` in order. */
async function run(recipe: Recipe, sourceId: string, opts: { answers?: string[]; identifier?: string | null; state?: StorageState | null; schedule?: boolean } = {}): Promise<Run> {
  const answers = [...(opts.answers ?? [])];
  const asked: Ask[] = [];
  let remembered: string | null = null;
  const allowHosts = ['127.0.0.1'];
  const session = await browsers.open({ allowHosts, ...(opts.state ? { storageState: opts.state } : {}) });
  try {
    const page = await session.context.newPage();
    const reports = await recipe.run({
      page, context: session.context, source: sourceById(sourceId)!, startUrl: '', allowHosts, identifier: opts.identifier ?? null,
      ask: async q => {
        asked.push(q);
        if (opts.schedule) throw new NeedsPersonError(q.label);
        const a = answers.shift();
        if (a === undefined) throw new Error(`unexpected question: ${q.label}`);
        return a;
      },
      remember: v => { remembered = v; }, step: async () => {}, download: url => downloadFile(session.context, url, allowHosts, 10 * 1024 * 1024),
      signal: new AbortController().signal, maxBytes: 10 * 1024 * 1024,
    });
    return { reports, asked, remembered, state: await session.close() };
  } catch (e) {
    await session.close();
    throw e;
  }
}

const isPdf = (r: PortalReport) => Buffer.from(r.bytes.subarray(0, 5)).toString() === '%PDF-';

describe('Thyrocare recipe', { timeout: 120_000 }, () => {
  let portal: ReturnType<typeof thyrocarePortal>;
  let recipe: Recipe;
  before(async () => {
    portal = thyrocarePortal();
    recipe = thyrocareRecipe(`${await host(portal.app)}/login.aspx`);
  });

  test('signs in with the mobile number and OTP (after a wrong one), and downloads each report once', async () => {
    const r = await run(recipe, 'thyrocare', { answers: ['+91 98765 43210', '0000', THYROCARE_OTP] });
    assert.deepEqual(r.asked.map(q => q.kind), ['phone', 'otp', 'otp']);
    assert.match(r.asked[2].label, /not accepted/);
    assert.equal(r.remembered, '9876543210');
    assert.equal(r.reports.length, 2, 'the terms PDF is not a report');
    assert.ok(r.reports.every(isPdf));
    assert.deepEqual(r.reports.map(x => x.date), ['2026-10-05', '2026-06-12']);
    assert.ok(r.reports[0].key.includes('TC823411'));
    assert.match(r.reports[1].title, /Thyroid Profile/);
    assert.ok(portal.log.includes('check 9876543210'));

    // The kept sign-in goes straight to the reports, with nothing asked; the same keys come back.
    const again = await run(recipe, 'thyrocare', { state: r.state, identifier: r.remembered, schedule: true });
    assert.equal(again.asked.length, 0);
    assert.deepEqual(again.reports.map(x => x.key), r.reports.map(x => x.key));
  });

  test('uses the password when the account has one; a first visit explains the barcode step', async () => {
    const r = await run(recipe, 'thyrocare', { answers: [portal.PASSWORD_NUMBER, portal.PASSWORD] });
    assert.deepEqual(r.asked.map(q => [q.kind, !!q.secret]), [['phone', false], ['password', true]]);
    assert.equal(r.reports.length, 2);
    await assert.rejects(run(recipe, 'thyrocare', { answers: [portal.PASSWORD_NUMBER, 'wrong'] }), (e: Error) => e instanceof PortalError && /Wrong password/.test(e.message));
    await assert.rejects(run(recipe, 'thyrocare', { answers: [portal.NEW_NUMBER] }), (e: Error) => e instanceof PortalError && /barcode and lab code/.test(e.message));
  });

  test('a scheduled run with an expired sign-in asks nobody (the agent marks the connection)', async () => {
    await assert.rejects(run(recipe, 'thyrocare', { identifier: '9876543210', schedule: true }), NeedsPersonError);
  });
});

describe('Dr Lal PathLabs recipe', { timeout: 120_000 }, () => {
  let portal: ReturnType<typeof drlalPortal>;
  let origin: string;
  before(async () => {
    portal = drlalPortal();
    origin = await host(portal.app);
  });

  test('signs in in the dialog (never the callback form), with OTP boxes, and downloads the reports that are out', async () => {
    const r = await run(drlalRecipe(origin), 'drlal', { answers: ['98765 43210', '111111', DRLAL_OTP] });
    assert.deepEqual(r.asked.map(q => q.kind), ['phone', 'otp', 'otp']);
    assert.deepEqual(portal.callbacks, [], 'the Get a Callback form was not used');
    assert.deepEqual(portal.otps, ['9876543210']);
    assert.equal(r.reports.length, 2, 'the sample PDF and the awaited report are skipped');
    assert.ok(r.reports.every(isPdf));
    assert.deepEqual(r.reports.map(x => x.date), ['2026-03-14', '2026-06-02']);
    assert.ok(r.reports[0].key.includes('DL55012345'), r.reports[0].key);
    assert.match(r.reports[0].title, /Lipid Profile Basic/);

    const again = await run(drlalRecipe(origin), 'drlal', { state: r.state, identifier: r.remembered, schedule: true });
    assert.equal(again.asked.length, 0);
    assert.deepEqual(again.reports.map(x => x.key), r.reports.map(x => x.key));
  });

  test('a site without the sign-in it expects ends in RecipeDriftError, for the navigator to take over', async () => {
    const empty = await host(new Hono().get('*', c => c.html('<html><body><h1>A new look</h1></body></html>')));
    await assert.rejects(run(drlalRecipe(empty), 'drlal', { answers: [] }), RecipeDriftError);
  });
});

// A pretend lab report portal at /demo-portal, run by this server in development and tests, so the record agent can
// be tried end to end without a real lab account (docs/record-agent.md §6). It behaves like the portals Indian labs
// run: sign in with a mobile number and a one-time code, then a list of reports with a PDF for each.
//
// The code is always DEMO_OTP and is shown to the person in the app's question. Sessions are kept in memory for 30
// days. Reports are the same for every number; addReport() adds one (tests of checking again).
import { randomBytes } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { buildReportPdf, type PdfPanel } from '../lab/partners/fake-pdf.ts';

export const DEMO_OTP = '246810';
export const DEMO_PORTAL_PATH = '/demo-portal';

export interface DemoReport {
  id: string;
  title: string;
  /** yyyy-mm-dd */
  date: string;
  panels: PdfPanel[];
}

const row = (name: string, value: string, unit: string, range: string, flag = '') => ({ name, value, unit, range, flag });

export const DEMO_REPORTS: DemoReport[] = [
  { id: 'DL-24-1031', title: 'Lipid profile', date: '2026-03-14', panels: [{ title: 'LIPID PROFILE', rows: [
    row('Total Cholesterol', '214', 'mg/dL', '< 200', 'H'),
    row('Triglycerides', '182', 'mg/dL', '< 150', 'H'),
    row('HDL Cholesterol', '41', 'mg/dL', '> 40'),
    row('LDL Cholesterol', '137', 'mg/dL', '< 100', 'H'),
  ] }] },
  { id: 'DL-24-1188', title: 'HbA1c and fasting glucose', date: '2026-06-02', panels: [{ title: 'DIABETES PANEL', rows: [
    row('HbA1c', '6.1', '%', '4.0 - 5.6', 'H'),
    row('Glucose, Fasting', '108', 'mg/dL', '70 - 99', 'H'),
  ] }] },
  { id: 'DL-24-1302', title: 'Thyroid profile', date: '2026-09-21', panels: [{ title: 'THYROID PROFILE', rows: [
    row('TSH', '3.2', 'µIU/mL', '0.4 - 4.2'),
    row('Free T4', '1.1', 'ng/dL', '0.8 - 1.8'),
  ] }] },
];

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)} · Demo Lab</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font:16px system-ui,sans-serif;max-width:40rem;margin:2rem auto;padding:0 1rem;color:#1d2a33}h1{font-size:1.4rem}
label{display:block;margin:.8rem 0 .3rem}input{font:inherit;padding:.5rem;width:16rem}button{font:inherit;padding:.5rem 1rem;margin-top:.8rem}
table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #ccd;padding:.5rem;text-align:left}.error{color:#a12}.banner{background:#fff4d6;padding:.5rem}</style>
</head><body><p class="banner">Demo Lab is a pretend portal for trying LotusPond's record agent. No real reports.</p>${body}</body></html>`;
}

export interface DemoPortal {
  app: Hono;
  reports: DemoReport[];
  addReport(r: DemoReport): void;
  /** Phone numbers that signed in, newest last (tests). */
  signIns: string[];
}

export function demoPortal(): DemoPortal {
  const reports = [...DEMO_REPORTS];
  const pending = new Map<string, { phone: string; expires: number }>();
  const sessions = new Map<string, { phone: string; expires: number }>();
  const signIns: string[] = [];
  const app = new Hono();
  const DAY = 24 * 60 * 60_000;

  const who = (c: Context) => {
    const t = getCookie(c, 'demo_lab');
    const s = t ? sessions.get(t) : undefined;
    return s && s.expires > Date.now() ? s : null;
  };

  app.get('/', c => c.redirect(`${DEMO_PORTAL_PATH}/reports`));
  app.get('/login', c => c.html(page('Sign in', `<h1>Sign in to Demo Lab</h1>
<form method="post" action="${DEMO_PORTAL_PATH}/login"><label for="phone">Mobile number</label>
<input id="phone" name="phone" type="tel" inputmode="numeric" autocomplete="tel" required>
<div><button type="submit">Send code</button></div></form>`)));
  app.post('/login', async c => {
    const form = await c.req.parseBody();
    const phone = String(form.phone ?? '').replace(/\D/g, '');
    if (phone.length < 10) return c.html(page('Sign in', `<h1>Sign in to Demo Lab</h1><p class="error" role="alert">Enter a 10-digit mobile number.</p><p><a href="${DEMO_PORTAL_PATH}/login">Try again</a></p>`), 400);
    const t = randomBytes(12).toString('hex');
    pending.set(t, { phone, expires: Date.now() + 10 * 60_000 });
    return c.redirect(`${DEMO_PORTAL_PATH}/otp?t=${t}`);
  });
  app.get('/otp', c => {
    const t = c.req.query('t') ?? '';
    if (!pending.has(t)) return c.redirect(`${DEMO_PORTAL_PATH}/login`);
    const err = c.req.query('e') ? '<p class="error" role="alert">That code is not right. Check the SMS and try again.</p>' : '';
    return c.html(page('Enter code', `<h1>Enter the code</h1><p>We sent a 6-digit code to the number ending ${esc(pending.get(t)!.phone.slice(-4))}.</p>${err}
<form method="post" action="${DEMO_PORTAL_PATH}/otp"><input type="hidden" name="t" value="${esc(t)}">
<label for="otp">Code</label><input id="otp" name="otp" inputmode="numeric" autocomplete="one-time-code" required>
<div><button type="submit">Sign in</button></div></form>`));
  });
  app.post('/otp', async c => {
    const form = await c.req.parseBody();
    const t = String(form.t ?? '');
    const p = pending.get(t);
    if (!p || p.expires < Date.now()) return c.redirect(`${DEMO_PORTAL_PATH}/login`);
    if (String(form.otp ?? '').trim() !== DEMO_OTP) return c.redirect(`${DEMO_PORTAL_PATH}/otp?t=${t}&e=1`);
    pending.delete(t);
    const token = randomBytes(18).toString('hex');
    sessions.set(token, { phone: p.phone, expires: Date.now() + 30 * DAY });
    signIns.push(p.phone);
    setCookie(c, 'demo_lab', token, { path: DEMO_PORTAL_PATH, httpOnly: true, sameSite: 'Lax', maxAge: 30 * 24 * 60 * 60 });
    return c.redirect(`${DEMO_PORTAL_PATH}/reports`);
  });
  app.get('/reports', c => {
    const s = who(c);
    if (!s) return c.redirect(`${DEMO_PORTAL_PATH}/login`);
    const rows = [...reports].sort((a, b) => b.date.localeCompare(a.date)).map(r => `<tr data-report-id="${esc(r.id)}" data-date="${r.date}">
<td>${esc(r.title)}</td><td>${r.date}</td><td><a href="${DEMO_PORTAL_PATH}/reports/${encodeURIComponent(r.id)}.pdf">Download ${esc(r.title)} PDF</a></td></tr>`).join('');
    return c.html(page('My reports', `<h1>My reports</h1><p>Signed in as the number ending ${esc(s.phone.slice(-4))}.</p>
<table><thead><tr><th>Test</th><th>Date</th><th>Report</th></tr></thead><tbody>${rows}</tbody></table>
<p><a href="${DEMO_PORTAL_PATH}/logout">Sign out</a></p>`));
  });
  app.get('/reports/:file', c => {
    if (!who(c)) return c.text('Sign in first.', 401);
    const id = c.req.param('file').replace(/\.pdf$/, '');
    const r = reports.find(x => x.id === id);
    if (!r) return c.text('No such report.', 404);
    const [y, m, d] = r.date.split('-');
    const pdf = buildReportPdf({
      labName: 'DEMO LAB', subtitle: 'Pretend laboratory for trying LotusPond | No real samples are processed',
      header: [['Patient Name', 'DEMO PATIENT'], ['Lab No.', r.id], ['Collected On', `${d}/${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(m) - 1]}/${y} 08:10 AM`], ['Report Status', 'Final']],
      panels: r.panels, notes: [], footer: 'PRETEND REPORT FOR TRYING LOTUSPOND. NOT A MEDICAL DOCUMENT.',
    });
    return c.body(pdf as unknown as ArrayBuffer, 200, { 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${r.id}.pdf"` });
  });
  app.get('/logout', c => {
    const t = getCookie(c, 'demo_lab');
    if (t) sessions.delete(t);
    return c.redirect(`${DEMO_PORTAL_PATH}/login`);
  });

  return { app, reports, signIns, addReport: r => { reports.push(r); } };
}

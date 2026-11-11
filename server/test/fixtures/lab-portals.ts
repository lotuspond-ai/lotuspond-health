// Local copies of the Dr Lal PathLabs and Thyrocare portals for the recipe tests (records/recipes/). They keep what
// the recipes rely on, as the live pages showed it in November 2026:
//   Thyrocare: b2capi.thyrocare.com/login.aspx with its WebForms ids (#a2, #txt_mob2, #but_proceed_mob_validation,
//     #A6, #txt_OTP_2, #A5, #txt_pwd2, #btl_pwd2, #txt_barcode_reg), then a list of reports.
//   Dr Lal: the header's "Welcome Guest User / Login / Sign Up" button (button.msb-user), a "Get a Callback" form
//     that also takes a mobile number (which must never be used), a sign-in dialog with a mobile number and a row
//     of one-digit OTP boxes, and /profile/orders with report buttons.
// The Dr Lal sign-in dialog is a guess at its shape (the live one is drawn by scripts the scrape did not run).
import { randomBytes } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { buildReportPdf } from '../../src/lab/partners/fake-pdf.ts';

const pdf = (lab: string, title: string, id: string) => buildReportPdf({
  labName: lab, subtitle: 'Test copy', header: [['Lab No.', id]],
  panels: [{ title: title.toUpperCase(), rows: [{ name: 'HbA1c', value: '6.4', flag: 'H', unit: '%', range: '4.0 - 5.6' }] }], notes: [], footer: 'TEST COPY',
});

const page = (title: string, body: string, script = '') => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}<script>${script}</script></body></html>`;

export const THYROCARE_OTP = '4321';
export const DRLAL_OTP = '135790';

export function thyrocarePortal() {
  const app = new Hono();
  const sessions = new Set<string>();
  const log: string[] = [];
  // Numbers: an account with a password, a first visit (barcode needed); anything else gets an OTP.
  const PASSWORD_NUMBER = '9000000001', NEW_NUMBER = '9000000002', PASSWORD = 'tc-secret';
  app.get('/login.aspx', c => {
    if (sessions.has(getCookie(c, 'tc') ?? '')) return c.redirect('/Reports.aspx');
    return c.html(page('Login - Thyrocare Technologies Limited', `
<form method="post" action="/login.aspx" id="form1"><h1 id="lbl_login">Login</h1>
<input name="txtUserID" id="txtUserID" placeholder="Enter Username / Mobile number"><input name="txtPassword" type="password" id="txtPassword"><input type="submit" id="btnLogin" value="Login">
<a href="#1" id="a1" class="enlg">New User</a> <a href="#2" id="a2" class="enlg">Already Availed Service</a>
<div id="availed" style="display:none">
  <input name="txt_mob2" type="text" maxlength="10" id="txt_mob2" placeholder="Enter Mobile Number">
  <a id="but_proceed_mob_validation" style="cursor:pointer">Proceed</a>
  <div id="pwd" style="display:none"><input name="txt_pwd2" type="password" id="txt_pwd2"><input type="submit" name="btl_pwd2" value="Login" id="btl_pwd2"></div>
  <div id="otp" style="display:none"><a id="A6" style="cursor:pointer">Generate OTP</a><span id="otpbox" style="display:none"><input name="txt_OTP_2" maxlength="4" id="txt_OTP_2"><a id="A5" style="cursor:pointer">Submit OTP</a></span></div>
  <div id="reg" style="display:none"><input id="txt_barcode_reg" maxlength="8"><input id="txt_labcode_reg"></div>
  <span class="text-error">Note : Find Barcode and Labcode at the bottom of the report</span>
  <p id="err" class="error" style="display:none"></p>
</div>
<div style="margin-top:40px"><form><input placeholder="Enter Mobile Number" maxlength="10" name="enquiry"><button>Call me back</button></form></div>
</form>`, `
const $ = id => document.getElementById(id);
$('a2').onclick = e => { e.preventDefault(); $('availed').style.display = 'block'; };
$('but_proceed_mob_validation').onclick = async () => {
  const r = await fetch('/login.aspx/check_method', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mobile: $('txt_mob2').value }) }).then(r => r.json());
  if (r.d === 'password') $('pwd').style.display = 'block'; else if (r.d === 'new') $('reg').style.display = 'block'; else $('otp').style.display = 'block';
};
$('A6').onclick = async () => { await fetch('/login.aspx/send_otp', { method: 'POST' }); $('otpbox').style.display = 'inline'; };
$('A5').onclick = async () => {
  const r = await fetch('/login.aspx/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mobile: $('txt_mob2').value, otp: $('txt_OTP_2').value }) });
  if (r.ok) location.href = '/Reports.aspx'; else { $('err').textContent = 'Invalid OTP'; $('err').style.display = 'block'; }
};
$('btl_pwd2').onclick = async e => {
  e.preventDefault();
  const r = await fetch('/login.aspx/password', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mobile: $('txt_mob2').value, pwd: $('txt_pwd2').value }) });
  if (r.ok) location.href = '/Reports.aspx'; else { $('err').textContent = 'Wrong password'; $('err').style.display = 'block'; }
};`));
  });
  app.post('/login.aspx/check_method', async c => {
    const { mobile } = await c.req.json();
    log.push(`check ${mobile}`);
    return c.json({ d: mobile === PASSWORD_NUMBER ? 'password' : mobile === NEW_NUMBER ? 'new' : 'otp' });
  });
  app.post('/login.aspx/send_otp', c => { log.push('otp sent'); return c.json({ d: 'ok' }); });
  const start = (c: Context) => {
    const t = randomBytes(8).toString('hex');
    sessions.add(t);
    setCookie(c, 'tc', t, { path: '/', httpOnly: true });
    return c.json({ d: 'ok' });
  };
  app.post('/login.aspx/verify', async c => ((await c.req.json()).otp === THYROCARE_OTP ? start(c) : c.json({ d: 'bad' }, 401)));
  app.post('/login.aspx/password', async c => ((await c.req.json()).pwd === PASSWORD ? start(c) : c.json({ d: 'bad' }, 401)));
  app.get('/Reports.aspx', c => {
    if (!sessions.has(getCookie(c, 'tc') ?? '')) return c.redirect('/login.aspx');
    return c.html(page('My Reports', `<h2>Welcome</h2><a href="/terms.pdf">Terms and conditions (PDF)</a>
<table><tr><th>Lab Code</th><th>Test</th><th>Date</th><th></th></tr>
<tr><td>Barcode: TC823411</td><td>Aarogyam C</td><td>05/10/2026</td><td><a href="/report.aspx?id=TC823411">Download Report</a></td></tr>
<tr><td>Barcode: TC701122</td><td>Thyroid Profile</td><td>12-Jun-2026</td><td><a href="/report.aspx?id=TC701122">Download Report</a></td></tr></table>`));
  });
  app.get('/report.aspx', c => {
    if (!sessions.has(getCookie(c, 'tc') ?? '')) return c.text('no', 401);
    const id = c.req.query('id') ?? '';
    return c.body(pdf('THYROCARE', 'Report', id) as unknown as ArrayBuffer, 200, { 'content-type': 'application/octet-stream' });
  });
  app.get('/terms.pdf', c => c.body(pdf('THYROCARE', 'Terms', 'T') as unknown as ArrayBuffer, 200, { 'content-type': 'application/pdf' }));
  return { app, log, PASSWORD_NUMBER, NEW_NUMBER, PASSWORD };
}

export function drlalPortal() {
  const app = new Hono();
  const sessions = new Set<string>();
  const callbacks: string[] = [];
  const otps: string[] = [];
  const header = (signedIn: boolean) => signedIn
    ? '<header><button class="msb-user"><span class="msb-user-name">Asha Rao</span></button></header>'
    : '<header><button type="button" class="msb-user"><span class="msb-user-text"><span class="msb-user-name">Welcome Guest User</span><span class="msb-user-sub">Login / Sign Up</span></span></button></header>';
  const callback = '<form class="contact-form consultation-form theme"><input type="text" placeholder="Enter Your 10 Digit Mobile Number" maxlength="10" name="phone"><button type="submit">Get a Callback</button></form>';
  const loginScript = `
document.querySelector('.consultation-form').onsubmit = e => { e.preventDefault(); fetch('/callback', { method: 'POST', body: e.target.phone.value }); };
const opener = document.querySelector('button.msb-user');
if (opener && /Guest/.test(opener.textContent)) opener.onclick = () => {
  const d = document.createElement('div');
  d.setAttribute('role', 'dialog'); d.className = 'login-modal';
  d.innerHTML = '<h3>Login / Sign Up</h3><label>Mobile Number<input type="tel" placeholder="Enter Mobile Number" maxlength="10"></label><button type="button" id="send">Get OTP</button><p class="error" style="display:none"></p>';
  document.body.appendChild(d);
  d.querySelector('#send').onclick = async () => {
    await fetch('/otp/send', { method: 'POST', body: d.querySelector('input').value });
    d.innerHTML = '<h3>Enter OTP</h3>' + Array.from({ length: 6 }, () => '<input maxlength="1" inputmode="numeric">').join('') + '<button type="button" id="verify">Verify OTP</button><p class="error" role="alert" style="display:none"></p>';
    d.querySelector('#verify').onclick = async () => {
      const code = [...d.querySelectorAll('input')].map(i => i.value).join('');
      const r = await fetch('/otp/verify', { method: 'POST', body: code });
      if (r.ok) location.reload(); else { const e = d.querySelector('.error'); e.textContent = 'Invalid OTP'; e.style.display = 'block'; }
    };
  };
};`;
  const signed = (c: Context) => sessions.has(getCookie(c, 'dl') ?? '');
  app.get('/', c => c.html(page('Dr Lal PathLabs', `${header(signed(c))}<h1>Home</h1>${callback}`, loginScript)));
  app.get('/profile/orders', c => {
    if (!signed(c)) return c.html(page('Orders', `${header(false)}<p>Please login to see your orders.</p>${callback}`, loginScript));
    return c.html(page('Orders', `${header(true)}<h1>My Orders</h1>
<div class="order-card"><p>Order ID: DL55012345</p><p>Lipid Profile Basic</p><p>14 Mar 2026</p><button type="button" class="report-btn" data-id="DL55012345">Download Report</button></div>
<div class="order-card"><p>Order ID: DL55019876</p><p>HbA1c</p><p>02/06/2026</p><a href="/report/DL55019876.pdf">View Report</a></div>
<div class="order-card"><p>Order ID: DL55020000</p><p>Vitamin D</p><p>Report awaited</p></div>
<a href="/media/sample-report.pdf">Sample report (PDF)</a>${callback}`, `${loginScript}
document.querySelectorAll('.report-btn').forEach(b => b.onclick = () => { location.href = '/report/' + b.dataset.id + '.pdf?dl=1'; });`));
  });
  app.post('/callback', async c => { callbacks.push(await c.req.text()); return c.text('ok'); });
  app.post('/otp/send', async c => { otps.push(await c.req.text()); return c.text('ok'); });
  app.post('/otp/verify', async c => {
    if ((await c.req.text()) !== DRLAL_OTP) return c.text('bad', 401);
    const t = randomBytes(8).toString('hex');
    sessions.add(t);
    setCookie(c, 'dl', t, { path: '/', httpOnly: true });
    return c.text('ok');
  });
  app.get('/report/:file', c => {
    if (!signed(c)) return c.text('no', 401);
    const id = c.req.param('file').replace(/\.pdf$/, '');
    const headers: Record<string, string> = { 'content-type': 'application/pdf' };
    if (c.req.query('dl')) headers['content-disposition'] = `attachment; filename="${id}.pdf"`;
    return c.body(pdf('DR LAL PATHLABS', 'Report', id) as unknown as ArrayBuffer, 200, headers);
  });
  app.get('/media/sample-report.pdf', c => c.body(pdf('DR LAL PATHLABS', 'Sample', 'S') as unknown as ArrayBuffer, 200, { 'content-type': 'application/pdf' }));
  return { app, callbacks, otps };
}

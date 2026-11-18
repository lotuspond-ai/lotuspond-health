// The sandbox EMR: a small web app with LotusPond's synthetic patients, served at /sandbox-emr, so an organisation
// with sandbox access can try tasks.run (the computer-use agent) before LotusPond connects a real system. Each
// connection has its own appointment book (/sandbox-emr/c/<connection id>/…), kept in memory and lost on restart.
// Every person here is made up. Plain server-rendered HTML with large, labelled controls, no scripts.
import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { SANDBOX_PATIENTS } from '../his/sandbox.ts';

export { SANDBOX_EMR_PATH } from './sandbox-emr-path.ts';

export interface SandboxAppointment {
  id: string;
  patient: string;
  doctor: string;
  /** yyyy-mm-dd */
  date: string;
  /** HH:MM, 24-hour */
  time: string;
  reason: string;
  status: 'booked' | 'cancelled';
}

export const SANDBOX_DOCTORS = ['Dr Kavya Rao (General Medicine)', 'Dr Sameer Mehta (Cardiology)', 'Dr Lakshmi Iyer (Endocrinology)'] as const;

const MAX_CONNECTIONS = 500;
const MAX_APPOINTMENTS = 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const esc = (s: string) => s.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!));

const page = (title: string, base: string, body: string, notice = '') => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · Sandbox EMR</title>
<style>
  body { font: 18px/1.5 system-ui, sans-serif; margin: 0; color: #1d2433; background: #f6f7fb; }
  header { background: #2f3e9e; color: #fff; padding: 14px 28px; display: flex; gap: 28px; align-items: center; }
  header a { color: #fff; font-weight: 600; }
  main { padding: 24px 28px; max-width: 980px; }
  .banner { background: #fff4d6; border: 1px solid #e5c76b; padding: 8px 14px; margin-bottom: 18px; }
  .notice { background: #e3f6e8; border: 1px solid #7cc392; padding: 8px 14px; margin-bottom: 18px; }
  form.inline { display: flex; gap: 12px; align-items: end; flex-wrap: wrap; }
  label { display: flex; flex-direction: column; gap: 4px; font-weight: 600; }
  input, select, button { font: inherit; padding: 8px 12px; min-width: 200px; }
  button { background: #2f3e9e; color: #fff; border: 0; cursor: pointer; min-width: 0; }
  table { border-collapse: collapse; width: 100%; background: #fff; margin: 12px 0 24px; }
  th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid #dde1ea; }
</style></head>
<body><header><strong>Sandbox EMR</strong><a href="${base}">Today</a><a href="${base}patients">Patients</a></header>
<main><p class="banner">Synthetic data for testing. Every patient here is made up.</p>
${notice ? `<p class="notice" role="status">${esc(notice)}</p>` : ''}
<h1>${esc(title)}</h1>
${body}
</main></body></html>`;

export function sandboxEmr(o: { now?: () => Date } = {}) {
  const now = o.now ?? (() => new Date());
  const books = new Map<string, SandboxAppointment[]>();
  const book = (conn: string) => {
    let b = books.get(conn);
    if (!b) {
      if (books.size >= MAX_CONNECTIONS) books.delete(books.keys().next().value!);
      b = [];
      books.set(conn, b);
    }
    return b;
  };
  const today = () => now().toISOString().slice(0, 10);
  const app = new Hono();

  app.use('/c/:conn/*', async (c, next) => {
    if (!UUID.test(c.req.param('conn'))) return c.text('Not found', 404);
    c.header('Cache-Control', 'no-store');
    c.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'");
    await next();
  });

  const apptRows = (list: SandboxAppointment[], base: string, withPatient: boolean) => list.length
    ? `<table><thead><tr>${withPatient ? '<th>Patient</th>' : ''}<th>Date</th><th>Time</th><th>Doctor</th><th>Reason</th><th>Status</th><th></th></tr></thead><tbody>${list.map(a => {
      const p = SANDBOX_PATIENTS.find(x => x.id === a.patient);
      return `<tr>${withPatient ? `<td><a href="${base}patients/${a.patient}">${esc(p ? `${p.given} ${p.family}` : a.patient)}</a></td>` : ''}<td>${a.date}</td><td>${a.time}</td><td>${esc(a.doctor)}</td><td>${esc(a.reason)}</td><td>${a.status}</td><td>${a.status === 'booked'
        ? `<form method="post" action="${base}appointments/${a.id}/cancel"><button type="submit" aria-label="Cancel appointment on ${a.date} at ${a.time}">Cancel</button></form>` : ''}</td></tr>`;
    }).join('')}</tbody></table>`
    : '<p>No appointments.</p>';

  app.get('/c/:conn/', c => {
    const base = `${c.req.path.replace(/\/$/, '')}/`;
    const t = today();
    const list = book(c.req.param('conn')).filter(a => a.date >= t).sort((a, b) => `${a.date}${a.time}`.localeCompare(`${b.date}${b.time}`));
    return c.html(page('Upcoming appointments', base, `
<form class="inline" method="get" action="${base}patients" role="search">
  <label>Find a patient <input name="q" placeholder="Name, UHID or mobile" autocomplete="off"></label>
  <button type="submit">Search</button>
</form>
<h2>Upcoming</h2>${apptRows(list, base, true)}`, c.req.query('notice') ?? ''));
  });

  app.get('/c/:conn/patients', c => {
    const base = c.req.path.replace(/patients$/, '');
    const q = (c.req.query('q') ?? '').trim().toLowerCase();
    const digits = q.replace(/\D/g, '');
    const found = SANDBOX_PATIENTS.filter(p => !q
      || `${p.given} ${p.family}`.toLowerCase().includes(q)
      || p.mrn.toLowerCase() === q
      || (digits.length >= 6 && p.phone.endsWith(digits.slice(-10))));
    return c.html(page('Patients', base, `
<form class="inline" method="get" action="${base}patients" role="search">
  <label>Find a patient <input name="q" value="${esc(c.req.query('q') ?? '')}" placeholder="Name, UHID or mobile" autocomplete="off"></label>
  <button type="submit">Search</button>
</form>
${found.length ? `<table><thead><tr><th>Name</th><th>UHID</th><th>Born</th><th>Mobile</th></tr></thead><tbody>${found.map(p =>
    `<tr><td><a href="${base}patients/${p.id}">${esc(`${p.given} ${p.family}`)}</a></td><td>${p.mrn}</td><td>${p.birthDate}</td><td>${p.phone}</td></tr>`).join('')}</tbody></table>` : '<p>No patient matches.</p>'}`));
  });

  app.get('/c/:conn/patients/:id', c => {
    const base = c.req.path.replace(/patients\/[^/]+$/, '');
    const p = SANDBOX_PATIENTS.find(x => x.id === c.req.param('id'));
    if (!p) return c.html(page('No such patient', base, '<p>That patient is not in the sandbox.</p>'), 404);
    const list = book(c.req.param('conn')).filter(a => a.patient === p.id);
    return c.html(page(`${p.given} ${p.family}`, base, `
<p>UHID ${p.mrn} · ${p.gender} · born ${p.birthDate} · ${p.phone}</p>
<h2>Appointments</h2>${apptRows(list, base, false)}
<h2>Book an appointment</h2>
<form class="inline" method="post" action="${base}patients/${p.id}/appointments">
  <label>Doctor <select name="doctor">${SANDBOX_DOCTORS.map(d => `<option>${esc(d)}</option>`).join('')}</select></label>
  <label>Date (YYYY-MM-DD) <input name="date" placeholder="2026-11-21" autocomplete="off"></label>
  <label>Time (HH:MM) <input name="time" placeholder="10:30" autocomplete="off"></label>
  <label>Reason <input name="reason" placeholder="Follow-up" autocomplete="off"></label>
  <button type="submit">Book appointment</button>
</form>`, c.req.query('notice') ?? ''));
  });

  app.post('/c/:conn/patients/:id/appointments', async c => {
    const base = c.req.path.replace(/patients\/[^/]+\/appointments$/, '');
    const p = SANDBOX_PATIENTS.find(x => x.id === c.req.param('id'));
    if (!p) return c.text('Not found', 404);
    const f = await c.req.parseBody();
    const doctor = String(f.doctor ?? '');
    const date = String(f.date ?? '').trim();
    const time = String(f.time ?? '').trim();
    const reason = String(f.reason ?? '').trim().slice(0, 120);
    const back = (notice: string) => c.redirect(`${base}patients/${p.id}?notice=${encodeURIComponent(notice)}`, 303);
    if (!SANDBOX_DOCTORS.includes(doctor as typeof SANDBOX_DOCTORS[number])) return back('Choose a doctor from the list.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) return back('Give the date as YYYY-MM-DD.');
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return back('Give the time as HH:MM.');
    if (date < today()) return back('That date has passed.');
    const b = book(c.req.param('conn'));
    if (b.some(a => a.status === 'booked' && a.doctor === doctor && a.date === date && a.time === time)) return back('That slot is taken. Choose another time.');
    b.push({ id: randomUUID().slice(0, 8), patient: p.id, doctor, date, time, reason: reason || 'Consultation', status: 'booked' });
    if (b.length > MAX_APPOINTMENTS) b.splice(0, b.length - MAX_APPOINTMENTS);
    return back(`Booked with ${doctor} on ${date} at ${time}.`);
  });

  app.post('/c/:conn/appointments/:aid/cancel', c => {
    const base = c.req.path.replace(/appointments\/[^/]+\/cancel$/, '');
    const a = book(c.req.param('conn')).find(x => x.id === c.req.param('aid'));
    if (!a) return c.redirect(`${base}?notice=${encodeURIComponent('No such appointment.')}`, 303);
    a.status = 'cancelled';
    return c.redirect(`${base}patients/${a.patient}?notice=${encodeURIComponent(`Cancelled the appointment on ${a.date} at ${a.time}.`)}`, 303);
  });

  return {
    app,
    /** A connection's appointments (tests, and nothing else: the agent reaches them only through the pages). */
    appointments: (connectionId: string): readonly SandboxAppointment[] => books.get(connectionId) ?? [],
  };
}

export type SandboxEmr = ReturnType<typeof sandboxEmr>;

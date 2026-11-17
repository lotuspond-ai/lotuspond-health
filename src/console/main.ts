// The developer console (/developers/console/): a small page on the public site that talks to /api/console with the
// person's LotusPond session cookie. Everything is built with DOM calls and textContent, never HTML strings, so names
// and summaries from the server cannot inject markup, and the page fits the site's script-only policy.

type OperationId = 'patients.search' | 'encounters.list' | 'documents.upload' | 'claims.status' | 'preauth.submit';
interface Operation { id: OperationId; summary: string; writes: boolean; stage: 'live' | 'planned' }
interface OrgSummary { id: string; name: string; region: string; access: 'sandbox' | 'live'; role: string }
interface Overview { account: { email: string }; organisations: OrgSummary[]; operations: Operation[] }
interface Key { id: string; name: string; prefix: string; operations: string[]; createdAt: string; lastUsedAt: string | null; revokedAt: string | null }
interface Connection { id: string; connector: string; name: string; sandbox: boolean; status: string; operations: string[]; lastOkAt: string | null; lastError: string | null }
interface Approval { id: string; operation: string; summary: string; status: string; error: string | null; decidedBy: string | null; createdAt: string }
interface Call { id: string; operation: string; outcome: string; at: string }
interface OrgPage {
  organisation: OrgSummary & { liveRequestedAt: string | null };
  keys: Key[]; connections: Connection[]; approvals: Approval[]; calls: Call[];
}

const root = document.getElementById('console')!;
const ORIGIN = location.origin;
let overview: Overview | null = null;
let current: string | null = null;
let freshKey: { name: string; key: string } | null = null;

class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/console${path}`, {
    method, credentials: 'same-origin',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) as unknown : null;
  if (!res.ok) throw new ApiError(res.status, (data as { error?: { message?: string } } | null)?.error?.message ?? `Request failed (${res.status}).`);
  return data as T;
}

/** Make an element: el('p', { class: 'x' }, 'text', child…). Strings become text nodes. */
function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string | boolean> = {}, ...children: (Node | string | null | false)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false) continue;
    if (v === true) e.setAttribute(k, '');
    else e.setAttribute(k, v);
  }
  for (const c of children) if (c) e.append(c);
  return e;
}

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : 'never');
const badge = (text: string, kind: string) => el('span', { class: `badge badge--${kind}` }, text);

function button(label: string, onClick: () => Promise<void> | void, kind: 'primary' | 'ghost' = 'ghost'): HTMLButtonElement {
  const b = el('button', { type: 'button', class: `button button--${kind} button--small` }, label);
  b.addEventListener('click', async () => {
    b.disabled = true;
    try { await onClick(); } catch (e) { showError(e); } finally { b.disabled = false; }
  });
  return b;
}

let errorBox: HTMLElement | null = null;
function showError(e: unknown) {
  const msg = e instanceof Error ? e.message : 'Something went wrong.';
  if (!errorBox) return alert(msg);
  errorBox.textContent = msg;
  errorBox.hidden = false;
}

function signedOut() {
  const next = encodeURIComponent('/developers/console/');
  root.replaceChildren(el('section', { class: 'panel' },
    el('h2', {}, 'Sign in to use the console'),
    el('p', {}, 'The console uses your LotusPond account. Anyone with an account can make an organisation and start in the sandbox hospital.'),
    el('div', { class: 'row-actions' },
      el('a', { class: 'button button--primary button--small', href: `/login?next=${next}` }, 'Sign in'),
      el('a', { class: 'button button--ghost button--small', href: `/signup?next=${next}` }, 'Create an account')),
  ));
}

function createOrgForm(first: boolean): HTMLElement {
  const name = el('input', { type: 'text', name: 'name', required: true, minlength: '2', maxlength: '120', autocomplete: 'organization' });
  const form = el('form', { class: 'form' },
    el('label', {}, 'Organisation name', name),
    el('div', { class: 'row-actions' }, el('button', { type: 'submit', class: 'button button--primary button--small' }, 'Make the organisation')));
  form.addEventListener('submit', async ev => {
    ev.preventDefault();
    try {
      const made = await api<OrgSummary>('POST', '/organisations', { name: name.value });
      current = made.id;
      await load();
    } catch (e) { showError(e); }
  });
  return el('section', { class: 'panel' },
    el('h2', {}, first ? 'Make your organisation' : 'Make another organisation'),
    el('p', {}, 'Your company or team. It starts with sandbox access: its keys reach LotusPond’s sandbox hospital, with synthetic patients, until we check your hospital’s written authority.'),
    form);
}

function keysPanel(page: OrgPage): HTMLElement {
  const ops = overview!.operations;
  const live = ops.filter(o => o.stage === 'live');
  const name = el('input', { type: 'text', name: 'name', required: true, maxlength: '60', value: 'Development' });
  const boxes = live.map(o => {
    const box = el('input', { type: 'checkbox', name: 'operations', value: o.id, checked: !o.writes });
    return { box, row: el('label', { class: 'check' }, box, el('span', {}, el('code', {}, o.id), o.writes ? ' (writes wait for approval)' : '', el('small', {}, o.summary))) };
  });
  const form = el('form', { class: 'form' },
    el('label', {}, 'Key name', name),
    el('fieldset', {}, el('legend', {}, 'What this key may do'), ...boxes.map(b => b.row)),
    el('div', { class: 'row-actions' }, el('button', { type: 'submit', class: 'button button--primary button--small' }, 'Make the key')));
  form.addEventListener('submit', async ev => {
    ev.preventDefault();
    const chosen = boxes.filter(b => b.box.checked).map(b => b.box.value);
    if (!chosen.length) return showError(new Error('Choose at least one operation.'));
    try {
      const made = await api<{ key: string; name: string }>('POST', `/organisations/${page.organisation.id}/keys`, { name: name.value, operations: chosen });
      freshKey = { name: made.name, key: made.key };
      await load();
    } catch (e) { showError(e); }
  });

  const list = page.keys.length
    ? el('div', { class: 'table-wrap' }, el('table', { class: 'table table--stack' },
      el('thead', {}, el('tr', {}, el('th', { scope: 'col' }, 'Key'), el('th', { scope: 'col' }, 'May do'), el('th', { scope: 'col' }, 'Last used'), el('th', { scope: 'col' }, ''))),
      el('tbody', {}, ...page.keys.map(k => el('tr', {},
        el('th', { scope: 'row' }, k.name, el('br'), el('code', {}, `${k.prefix}…`)),
        el('td', {}, k.operations.join(', ')),
        el('td', {}, k.revokedAt ? badge('Revoked', 'rejected') : when(k.lastUsedAt)),
        el('td', {}, k.revokedAt ? '' : button('Revoke', async () => {
          if (!confirm(`Revoke "${k.name}"? Anything using it stops working at once.`)) return;
          await api('DELETE', `/organisations/${page.organisation.id}/keys/${k.id}`);
          await load();
        })))))))
    : el('p', { class: 'empty' }, 'No keys yet.');

  const secret = freshKey ? el('div', { class: 'secret', role: 'status' },
    el('b', {}, `Your new key "${freshKey.name}". It is shown once: copy it into your secret store now.`),
    el('code', {}, freshKey.key),
    el('div', { class: 'row-actions' }, button('Copy', async () => { await navigator.clipboard.writeText(freshKey!.key); }), button('Done', () => { freshKey = null; render(); }))) : null;

  return el('section', { class: 'panel', id: 'keys' }, el('h2', {}, 'API keys'), secret, list, el('h3', {}, 'Make a key'), form);
}

function connectionsPanel(page: OrgPage): HTMLElement {
  return el('section', { class: 'panel', id: 'connections' },
    el('h2', {}, 'Connections'),
    el('p', {}, 'Every call names one connection. Use its id as "connection".'),
    el('div', { class: 'table-wrap' }, el('table', { class: 'table table--stack' },
      el('thead', {}, el('tr', {}, el('th', { scope: 'col' }, 'Connection'), el('th', { scope: 'col' }, 'Id'), el('th', { scope: 'col' }, 'Can do'), el('th', { scope: 'col' }, 'Last worked'))),
      el('tbody', {}, ...page.connections.map(c => el('tr', {},
        el('th', { scope: 'row' }, c.name, ' ', c.sandbox ? badge('Sandbox', 'sandbox') : badge('Live', 'live'), c.status !== 'active' ? badge('Off', 'rejected') : null),
        el('td', {}, el('code', {}, c.id)),
        el('td', {}, c.operations.join(', ')),
        el('td', {}, c.lastError ? el('span', { class: 'error' }, c.lastError) : when(c.lastOkAt))))))));
}

function approvalsPanel(page: OrgPage): HTMLElement {
  const pending = page.approvals.filter(a => a.status === 'pending');
  const past = page.approvals.filter(a => a.status !== 'pending').slice(0, 20);
  const row = (a: Approval) => el('tr', {},
    el('th', { scope: 'row' }, a.summary),
    el('td', {}, when(a.createdAt)),
    el('td', {}, a.status === 'pending'
      ? el('div', { class: 'row-actions' },
        button('Approve and send', async () => {
          if (!confirm('Approve this upload? It is sent to the hospital system now.')) return;
          await api('POST', `/organisations/${page.organisation.id}/approvals/${a.id}`, { decision: 'approve' });
          await load();
        }, 'primary'),
        button('Reject', async () => { await api('POST', `/organisations/${page.organisation.id}/approvals/${a.id}`, { decision: 'reject' }); await load(); }))
      : el('span', {}, badge(a.status, a.status), a.error ? el('span', { class: 'error' }, ` ${a.error}`) : '', a.decidedBy ? ` by ${a.decidedBy}` : '')));
  const table = (rows: Approval[]) => el('div', { class: 'table-wrap' }, el('table', { class: 'table table--stack' },
    el('thead', {}, el('tr', {}, el('th', { scope: 'col' }, 'Write'), el('th', { scope: 'col' }, 'Asked'), el('th', { scope: 'col' }, 'Decision'))),
    el('tbody', {}, ...rows.map(row))));
  return el('section', { class: 'panel', id: 'approvals' },
    el('h2', {}, 'Approvals'),
    el('p', {}, 'Uploads wait here until a clinician in your organisation approves them. Check what the summary says before you approve.'),
    pending.length ? table(pending) : el('p', { class: 'empty' }, 'Nothing is waiting.'),
    past.length ? el('h3', {}, 'Decided') : null,
    past.length ? table(past) : null);
}

function callsPanel(page: OrgPage): HTMLElement {
  return el('section', { class: 'panel', id: 'calls' },
    el('h2', {}, 'Recent calls'),
    page.calls.length ? el('div', { class: 'table-wrap' }, el('table', { class: 'table table--stack' },
      el('thead', {}, el('tr', {}, el('th', { scope: 'col' }, 'When'), el('th', { scope: 'col' }, 'Operation'), el('th', { scope: 'col' }, 'Outcome'))),
      el('tbody', {}, ...page.calls.map(c => el('tr', {}, el('th', { scope: 'row' }, when(c.at)), el('td', {}, el('code', {}, c.operation)), el('td', {}, badge(c.outcome.replace('_', ' '), c.outcome)))))))
      : el('p', { class: 'empty' }, 'No calls yet. Try the quickstart below.'));
}

function livePanel(page: OrgPage): HTMLElement | null {
  const o = page.organisation;
  if (o.access === 'live') return null;
  if (o.liveRequestedAt) {
    return el('section', { class: 'panel' }, el('h2', {}, 'Live access'),
      el('p', {}, `You asked for live access on ${when(o.liveRequestedAt)}. We will write to you about the hospital’s written authority and the connection details.`));
  }
  const systems = el('input', { type: 'text', required: true, maxlength: '300', placeholder: 'e.g. TrakCare, Bahmni, another FHIR R4 system' });
  const hospital = el('input', { type: 'text', required: true, maxlength: '300', placeholder: 'Hospital name and city' });
  const note = el('textarea', { maxlength: '2000', placeholder: 'What you will read or write, and who at the hospital has agreed' });
  const form = el('form', { class: 'form' },
    el('label', {}, 'Which systems', systems), el('label', {}, 'Which hospital', hospital), el('label', {}, 'Anything else', note),
    el('div', { class: 'row-actions' }, el('button', { type: 'submit', class: 'button button--primary button--small' }, 'Ask for live access')));
  form.addEventListener('submit', async ev => {
    ev.preventDefault();
    try { await api('POST', `/organisations/${o.id}/live-request`, { systems: systems.value, hospital: hospital.value, note: note.value }); await load(); } catch (e) { showError(e); }
  });
  return el('section', { class: 'panel', id: 'live' }, el('h2', {}, 'Go live with a hospital'),
    el('p', {}, 'To reach a real system we need the hospital’s written authority, a service account from its IT team, and a data-processing agreement. We never sign in as staff or work around a system’s access controls.'),
    form);
}

function quickstart(page: OrgPage): HTMLElement {
  const conn = page.connections.find(c => c.sandbox)?.id ?? '<connection id>';
  const curl = `curl ${ORIGIN}/v1/operations/patients.search \\\n  -H "Authorization: Bearer lpk_…" -H "Content-Type: application/json" \\\n  -d '{"connection": "${conn}", "name": "asha"}'`;
  const mcp = JSON.stringify({ mcpServers: { 'lotuspond-hospitals': { type: 'http', url: `${ORIGIN}/v1/mcp`, headers: { Authorization: 'Bearer lpk_…' } } } }, null, 2);
  return el('section', { class: 'panel', id: 'quickstart' },
    el('h2', {}, 'Quickstart'),
    el('p', {}, 'Search the sandbox hospital with your key:'),
    el('pre', { class: 'code' }, el('code', {}, curl)),
    el('p', {}, 'Or give your agents the same operations through MCP:'),
    el('pre', { class: 'code' }, el('code', {}, mcp)),
    el('p', {}, 'Sandbox patients include Asha Raman (MRN1001) and Vikram Nair (MRN1002); claims CLM-1001, CLM-1002, CLM-1003 and PA-2001.'));
}

let page: OrgPage | null = null;

function render() {
  if (!overview) return;
  errorBox = el('p', { class: 'error', role: 'alert', hidden: true });
  const head = el('div', { class: 'panel__head' }, el('p', { class: 'muted' }, `Signed in as ${overview.account.email}`));
  if (!overview.organisations.length) { root.replaceChildren(head, errorBox, createOrgForm(true)); return; }
  const picker = overview.organisations.length > 1 ? (() => {
    const s = el('select', { 'aria-label': 'Organisation' }, ...overview!.organisations.map(o => el('option', { value: o.id, selected: o.id === current }, o.name)));
    s.addEventListener('change', async () => { current = s.value; freshKey = null; await load(); });
    return s;
  })() : null;
  if (!page) { root.replaceChildren(head, errorBox); return; }
  const o = page.organisation;
  const title = el('section', { class: 'panel' },
    el('div', { class: 'panel__head' }, el('h2', {}, o.name), el('div', { class: 'row-actions' }, picker, o.access === 'live' ? badge('Live access', 'live') : badge('Sandbox access', 'sandbox'))),
    el('p', { class: 'muted' }, `Your role: ${o.role}. Data region: ${o.region}.`));
  root.replaceChildren(head, errorBox, title, keysPanel(page), connectionsPanel(page), approvalsPanel(page), callsPanel(page), quickstart(page), ...[livePanel(page)].filter(Boolean) as HTMLElement[], createOrgForm(false));
}

async function load() {
  try {
    overview = await api<Overview>('GET', '');
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return signedOut();
    root.replaceChildren(el('p', { class: 'error' }, e instanceof Error ? e.message : 'The console could not load.'));
    return;
  }
  if (!current || !overview.organisations.some(o => o.id === current)) current = overview.organisations[0]?.id ?? null;
  page = current ? await api<OrgPage>('GET', `/organisations/${current}`).catch(e => { showError(e); return null; }) : null;
  render();
}

void load();

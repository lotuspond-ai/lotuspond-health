// The developer console (/developers/console/): an app shell on the public site that talks to /api/console with an
// organisation account's session cookie. Organisation accounts work like LotusPond Works': a person signs up, makes an
// organisation or is added to one, and works in it with a role (owner, admin, editor, viewer). They are separate from
// personal LotusPond Health accounts, so an employer never controls the account that holds someone's own records. A top bar holds the organisation and the account, a sidebar lists the sections,
// and the main area shows one section at a time, chosen by the address's #hash (#overview, #keys, #connections,
// #approvals, #tasks, #tasks/<id>, #logs, #members, #quickstart, #live, #new). Everything is built with DOM calls and textContent, never HTML
// strings, so names and summaries from the server cannot inject markup, and the page fits the site's script-only policy.

type OperationId = 'patients.search' | 'encounters.list' | 'documents.upload' | 'claims.status' | 'preauth.submit';
interface Operation { id: OperationId; summary: string; writes: boolean; stage: 'live' | 'planned' }
interface Integration { id: string; name: string; vendor: string; status: string; statusText: { label: string; detail: string }; how: string; operations: string[] }
type Role = 'owner' | 'admin' | 'editor' | 'viewer';
interface OrgSummary { id: string; name: string; region: string; access: 'sandbox' | 'live'; role: Role; approves: boolean }
interface Region { id: string; name: string }
interface Overview { account: { email: string; name: string }; organisations: OrgSummary[]; regions: Region[]; operations: Operation[]; integrations?: Integration[] }
interface Member { id: string; name: string; email: string; role: Role; approves: boolean; you: boolean }
interface Key { id: string; name: string; prefix: string; operations: string[]; createdAt: string; lastUsedAt: string | null; revokedAt: string | null }
interface Connection { id: string; connector: string; name: string; sandbox: boolean; status: string; operations: string[]; lastOkAt: string | null; lastError: string | null }
interface Approval { id: string; operation: string; summary: string; status: string; result: unknown; error: string | null; decidedBy: string | null; createdAt: string }
type TaskStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cannot' | 'needs_sign_in' | 'needs_review';
interface Task {
  id: string; connection: string; status: TaskStatus; summary: string; model: string; sandbox: string | null; steps: number; maxSteps: number;
  result: string | null; error: string | null; createdAt: string; startedAt: string | null; finishedAt: string | null;
}
interface TaskAction {
  seq: number; step: number; kind: string; outcome: 'started' | 'done' | 'failed' | 'refused'; detail: Record<string, unknown>;
  text: string | null; url: string | null; screenshotSha256: string | null; at: string;
}
interface Call { id: string; operation: string; outcome: string; at: string }
interface OrgPage {
  organisation: OrgSummary & { liveRequestedAt: string | null };
  members: Member[]; keys: Key[]; connections: Connection[]; approvals: Approval[]; calls: Call[];
  tasks?: Task[]; agent?: { model: string } | null;
}

const RANK: Record<Role, number> = { viewer: 0, editor: 1, admin: 2, owner: 3 };
const ROLE_TEXT: Record<Role, string> = {
  owner: 'Owner: everything, including other owners',
  admin: 'Admin: members, keys and live access',
  editor: 'Editor: API keys',
  viewer: 'Viewer: reads the console',
};
const can = (o: OrgSummary, least: Role) => RANK[o.role] >= RANK[least];

const SECTIONS = [
  { id: 'overview', label: 'Overview' },
  { id: 'keys', label: 'API keys' },
  { id: 'connections', label: 'Connections' },
  { id: 'approvals', label: 'Approvals' },
  { id: 'tasks', label: 'Agent tasks' },
  { id: 'logs', label: 'Logs' },
  { id: 'members', label: 'Members' },
  { id: 'quickstart', label: 'Quickstart' },
  { id: 'live', label: 'Go live' },
] as const;
type SectionId = (typeof SECTIONS)[number]['id'] | 'new';

const root = document.getElementById('console')!;
const ORIGIN = location.origin;
let overview: Overview | null = null;
let page: OrgPage | null = null;
let current: string | null = null;
let freshKey: { name: string; key: string } | null = null;
let showKeyForm = false;
let logFilter = 'all';
let taskDetail: { task: Task; actions: TaskAction[] } | null = null;
let taskError: string | null = null;
let taskTimer: ReturnType<typeof setTimeout> | undefined;

class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

async function api<T>(method: string, path: string, body?: unknown, base = '/api/console'): Promise<T> {
  const res = await fetch(`${base}${path}`, {
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
function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string | boolean> = {}, ...children: (Node | string | null | false | undefined)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false) continue;
    if (v === true) e.setAttribute(k, '');
    else e.setAttribute(k, v);
  }
  for (const c of children) if (c) e.append(c);
  return e;
}

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : 'Never');
const ago = (iso: string | null) => {
  if (!iso) return 'Never';
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'Just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return when(iso);
};
const pill = (text: string, kind: string) => el('span', { class: `cx-pill cx-pill-${kind}` }, text);
const OUTCOME_TEXT: Record<string, string> = { done: 'Done', pending: 'Waiting for approval', refused: 'Refused', not_offered: 'Not offered', failed: 'Failed' };

function button(label: string, onClick: () => Promise<void> | void, kind: 'primary' | 'quiet' | 'danger' = 'quiet'): HTMLButtonElement {
  const b = el('button', { type: 'button', class: `cx-btn cx-btn-${kind}` }, label);
  b.addEventListener('click', async () => {
    b.disabled = true;
    try { await onClick(); } catch (e) { showError(e); } finally { b.disabled = false; }
  });
  return b;
}

function copyButton(text: () => string, label = 'Copy'): HTMLButtonElement {
  const b = button(label, async () => {
    await navigator.clipboard.writeText(text());
    b.textContent = 'Copied';
    setTimeout(() => { b.textContent = label; }, 1500);
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

function section(): SectionId {
  const h = location.hash.slice(1).split('/')[0];
  return (SECTIONS.some(s => s.id === h) || h === 'new') ? h as SectionId : 'overview';
}

/** The task named by #tasks/<id>, if any. */
function taskInHash(): string | null {
  const m = /^#tasks\/([0-9a-f-]{36})$/i.exec(location.hash);
  return m ? m[1] : null;
}

/** The section's heading row: title, a short line under it, and actions on the right. */
function head(title: string, sub: string | null, ...actions: (Node | null)[]): HTMLElement {
  return el('div', { class: 'cx-head' },
    el('div', {}, el('h1', {}, title), sub ? el('p', { class: 'cx-muted' }, sub) : null),
    el('div', { class: 'cx-actions' }, ...actions));
}

const card = (title: string | null, ...children: (Node | null | false)[]) =>
  el('section', { class: 'cx-card' }, title ? el('h2', {}, title) : null, ...children);

function table(cols: string[], rows: HTMLTableRowElement[], empty: string): HTMLElement {
  if (!rows.length) return el('p', { class: 'cx-empty' }, empty);
  // On a phone each row stacks into a card (console.css), with each cell named by its column.
  for (const row of rows) [...row.cells].forEach((cell, i) => { if (cols[i]) cell.dataset.label = cols[i]; });
  return el('div', { class: 'cx-table-wrap' }, el('table', { class: 'cx-table' },
    el('thead', {}, el('tr', {}, ...cols.map(c => el('th', { scope: 'col' }, c)))),
    el('tbody', {}, ...rows)));
}

// ---- Shell ---------------------------------------------------------------------------------------------------

function topBar(): HTMLElement {
  const brand = el('a', { class: 'cx-brand', href: '/developers/', 'aria-label': 'LotusPond Health developers' }, 'LotusPond ', el('b', {}, 'Health'), el('span', {}, 'Console'));
  if (!overview) return el('header', { class: 'cx-top' }, brand);
  const orgs = overview.organisations;
  const picker = orgs.length ? (() => {
    const s = el('select', { class: 'cx-org', 'aria-label': 'Organisation' }, ...orgs.map(o => el('option', { value: o.id, selected: o.id === current }, o.name)));
    s.addEventListener('change', async () => { current = s.value; freshKey = null; showKeyForm = false; await load(); });
    return s;
  })() : null;
  const access = page ? (page.organisation.access === 'live' ? pill('Live', 'live') : pill('Sandbox', 'sandbox')) : null;
  const signOut = button('Sign out', async () => {
    await api('POST', '/auth/logout').catch(() => undefined);
    overview = null; page = null; current = null; freshKey = null;
    history.replaceState(null, '', location.pathname);
    signedOut();
  });
  return el('header', { class: 'cx-top' },
    brand,
    el('div', { class: 'cx-top-org' }, picker, access),
    el('div', { class: 'cx-top-end' },
      el('a', { class: 'cx-top-link', href: '/developers/' }, 'Docs'),
      el('span', { class: 'cx-top-user', title: `${overview.account.email}, an organisation account` }, overview.account.email),
      signOut));
}

function sideBar(active: SectionId): HTMLElement {
  const pending = page?.approvals.filter(a => a.status === 'pending').length ?? 0;
  const counts: Partial<Record<SectionId, number>> = {
    keys: page?.keys.filter(k => !k.revokedAt).length,
    connections: page?.connections.length,
    members: page?.members.length,
    approvals: pending || undefined,
    tasks: page?.tasks?.filter(t => t.status === 'queued' || t.status === 'running').length || undefined,
  };
  const link = (id: SectionId, label: string) => el('a', { href: `#${id}`, class: 'cx-nav-link', 'aria-current': id === active ? 'page' : false },
    el('span', {}, label),
    counts[id] ? el('span', { class: `cx-count${id === 'approvals' ? ' cx-count-alert' : ''}` }, String(counts[id])) : null);
  return el('nav', { class: 'cx-side', 'aria-label': 'Console' },
    el('div', { class: 'cx-nav' }, ...SECTIONS.map(s => link(s.id, s.label))),
    el('div', { class: 'cx-nav cx-nav-end' },
      link('new', 'New organisation'),
      el('a', { class: 'cx-nav-link', href: '/developers/' }, el('span', {}, 'Developer guide'))));
}

function shell(main: Node[], active: SectionId | null) {
  errorBox = el('p', { class: 'cx-error', role: 'alert', hidden: true });
  const body = el('main', { class: 'cx-main', id: 'main', tabindex: '-1' }, errorBox, ...main);
  root.replaceChildren(topBar(), ...(active ? [sideBar(active)] : []), body);
  root.classList.toggle('cx-bare', !active);
}

// ---- Sections ------------------------------------------------------------------------------------------------

function field(label: string, input: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, hint?: string): HTMLLabelElement {
  return el('label', {}, label, input, hint ? el('small', {}, hint) : null);
}

function regionSelect(regions: Region[]): HTMLSelectElement {
  return el('select', { name: 'region', required: true }, ...regions.map(r => el('option', { value: r.id, selected: r.id === 'in' }, r.name)));
}

/** Signed out: sign in, or make an organisation account (with its first organisation), as in LotusPond Works. */
function signedOut(mode: 'signin' | 'signup' = 'signin') {
  document.title = 'Developer console · LotusPond Health';
  const tabs = el('div', { class: 'cx-seg cx-tabs', role: 'group', 'aria-label': 'Organisation account' },
    ...(['signin', 'signup'] as const).map(m => {
      const b = el('button', { type: 'button', 'aria-pressed': String(m === mode) }, m === 'signin' ? 'Sign in' : 'Make an organisation account');
      b.addEventListener('click', () => signedOut(m));
      return b;
    }));
  const email = el('input', { type: 'email', name: 'email', required: true, maxlength: '254', autocomplete: 'email' });
  const password = el('input', { type: 'password', name: 'password', required: true, minlength: mode === 'signup' ? '10' : false, maxlength: '256', autocomplete: mode === 'signup' ? 'new-password' : 'current-password' });
  let form: HTMLFormElement;
  if (mode === 'signin') {
    form = el('form', { class: 'cx-form' }, field('Work email', email), field('Password', password),
      el('div', { class: 'cx-actions' }, el('button', { type: 'submit', class: 'cx-btn cx-btn-primary' }, 'Sign in')));
    form.addEventListener('submit', async ev => {
      ev.preventDefault();
      try { await api('POST', '/auth/login', { email: email.value, password: password.value }); await load(); } catch (e) { showError(e); }
    });
  } else {
    const name = el('input', { type: 'text', name: 'name', required: true, maxlength: '120', autocomplete: 'name' });
    const joining = el('input', { type: 'checkbox', name: 'joining' });
    const orgName = el('input', { type: 'text', name: 'organisation', required: true, minlength: '2', maxlength: '120', autocomplete: 'organization', placeholder: 'e.g. Acme Health AI' });
    const region = regionSelect([{ id: 'in', name: 'India' }]);
    const orgFields = el('fieldset', {}, el('legend', {}, 'Your organisation'), field('Organisation name', orgName), field('Data region', region, 'Where its keys, calls and approvals are kept.'));
    joining.addEventListener('change', () => { orgFields.hidden = joining.checked; orgName.required = !joining.checked; });
    const terms = el('input', { type: 'checkbox', name: 'terms', required: true });
    form = el('form', { class: 'cx-form' },
      field('Your name', name), field('Work email', email), field('Password', password, 'At least 10 characters.'),
      orgFields,
      el('label', { class: 'cx-check' }, joining, el('span', {}, 'I am joining an organisation that is already here', el('small', {}, 'An owner or admin adds you by this email once your account exists.'))),
      el('label', { class: 'cx-check' }, terms, el('span', {}, 'I agree to the ', el('a', { href: '/terms/' }, 'Terms of Use'), ' and the ', el('a', { href: '/privacy/' }, 'Privacy Policy'), ' on behalf of my organisation.')),
      el('div', { class: 'cx-actions' }, el('button', { type: 'submit', class: 'cx-btn cx-btn-primary' }, 'Make the account')));
    form.addEventListener('submit', async ev => {
      ev.preventDefault();
      try {
        const made = await api<{ organisation: { id: string } | null }>('POST', '/auth/register', {
          name: name.value, email: email.value, password: password.value, terms: terms.checked,
          ...(joining.checked ? {} : { organisation: { name: orgName.value, region: region.value } }),
        });
        current = made.organisation?.id ?? null;
        await load();
      } catch (e) { showError(e); }
    });
  }
  shell([el('div', { class: 'cx-center' }, el('section', { class: 'cx-card cx-signin' },
    el('h1', {}, mode === 'signin' ? 'Sign in to the console' : 'Make an organisation account'),
    el('p', { class: 'cx-muted' }, 'The console uses organisation accounts, like LotusPond Works: your own sign-in, with organisations you make or are added to, each with a role. They are separate from personal LotusPond Health accounts, so your employer never controls the account that holds your own health records.'),
    tabs, form))], null);
}

function createOrgForm(first: boolean): HTMLElement {
  const name = el('input', { type: 'text', name: 'name', required: true, minlength: '2', maxlength: '120', autocomplete: 'organization', placeholder: 'e.g. Acme Health AI' });
  const region = regionSelect(overview!.regions);
  const form = el('form', { class: 'cx-form' },
    field('Organisation name', name), field('Data region', region, 'Where its keys, calls and approvals are kept.'),
    el('div', { class: 'cx-actions' }, el('button', { type: 'submit', class: 'cx-btn cx-btn-primary' }, 'Create organisation')));
  form.addEventListener('submit', async ev => {
    ev.preventDefault();
    try {
      const made = await api<OrgSummary>('POST', '/organisations', { name: name.value, region: region.value });
      current = made.id;
      location.hash = 'overview';
      await load();
    } catch (e) { showError(e); }
  });
  return card(first ? null : 'New organisation',
    first ? el('h1', {}, 'Create your organisation') : null,
    el('p', { class: 'cx-muted' }, first
      ? 'You are not in an organisation yet. Make one for your company or team and you become its owner, or ask an owner or admin to add you by your email. A new organisation starts with sandbox access: its keys reach LotusPond’s sandbox hospital, with synthetic patients, until we check your hospital’s written authority.'
      : 'Another company or team. You become its owner; it and its keys stay separate from your other organisations.'),
    form);
}

function overviewSection(p: OrgPage): Node[] {
  const o = p.organisation;
  const activeKeys = p.keys.filter(k => !k.revokedAt);
  const pending = p.approvals.filter(a => a.status === 'pending');
  const done = p.calls.filter(c => c.outcome === 'done').length;
  const notOk = p.calls.filter(c => c.outcome === 'refused' || c.outcome === 'failed').length;
  const broken = p.connections.filter(c => c.lastError || c.status !== 'active').length;
  const stat = (label: string, value: string, note: string, href: string) =>
    el('a', { class: 'cx-stat', href }, el('span', { class: 'cx-stat-label' }, label), el('b', {}, value), el('span', { class: 'cx-muted' }, note));

  const steps = [
    { done: activeKeys.length > 0, text: 'Create an API key', href: '#keys' },
    { done: p.calls.some(c => c.outcome === 'done'), text: 'Make your first call to the sandbox hospital', href: '#quickstart' },
    { done: o.access === 'live' || !!o.liveRequestedAt, text: 'Ask for live access to a hospital', href: '#live' },
  ];
  const start = steps.every(s => s.done) ? null : card('Get started',
    el('ol', { class: 'cx-steps' }, ...steps.map(s => el('li', { class: s.done ? 'is-done' : '' },
      el('span', { class: 'cx-step-mark', 'aria-hidden': 'true' }, s.done ? '✓' : ''),
      el('a', { href: s.href }, s.text), s.done ? el('span', { class: 'cx-sr' }, ' (done)') : null))));

  return [
    head(o.name, `${o.access === 'live' ? 'Live access' : 'Sandbox access'} · Region ${overview!.regions.find(r => r.id === o.region)?.name ?? o.region.toUpperCase()} · You are ${o.role}${o.approves ? ' and approve writes' : ''}`,
      can(o, 'editor') ? el('a', { class: 'cx-btn cx-btn-primary', href: '#keys' }, 'Create API key') : null),
    el('div', { class: 'cx-stats' },
      stat('Calls', String(p.calls.length), `${done} done, ${notOk} refused or failed`, '#logs'),
      stat('Active keys', String(activeKeys.length), activeKeys.length ? `Last used ${ago(activeKeys.map(k => k.lastUsedAt).filter(Boolean).sort().pop() ?? null).toLowerCase()}` : 'None yet', '#keys'),
      stat('Waiting for approval', String(pending.length), pending.length ? 'Writes need a clinician' : 'Nothing waiting', '#approvals'),
      stat('Connections', String(p.connections.length), broken ? `${broken} need attention` : 'All working', '#connections')),
    start,
    card('Recent calls', callsTable(p.calls.slice(0, 8)), p.calls.length > 8 ? el('a', { class: 'cx-more', href: '#logs' }, 'All logs →') : null),
  ].filter(Boolean) as Node[];
}

function keysSection(p: OrgPage): Node[] {
  const live = overview!.operations.filter(o => o.stage === 'live');
  const secret = freshKey ? el('div', { class: 'cx-secret', role: 'status' },
    el('div', {}, el('b', {}, `Key “${freshKey.name}” created`), el('p', { class: 'cx-muted' }, 'It is shown once. Copy it into your secret store now.')),
    el('div', { class: 'cx-secret-row' }, el('code', {}, freshKey.key), copyButton(() => freshKey!.key)),
    el('div', { class: 'cx-actions' }, button('Done', () => { freshKey = null; render(); }))) : null;

  let form: HTMLElement | null = null;
  if (showKeyForm) {
    const name = el('input', { type: 'text', name: 'name', required: true, maxlength: '60', value: 'Development' });
    const boxes = live.map(o => {
      const box = el('input', { type: 'checkbox', name: 'operations', value: o.id, checked: !o.writes });
      return { box, row: el('label', { class: 'cx-check' }, box, el('span', {}, el('code', {}, o.id), o.writes ? el('em', {}, ' writes wait for approval') : null, el('small', {}, o.summary))) };
    });
    const f = el('form', { class: 'cx-form' },
      el('label', {}, 'Key name', name),
      el('fieldset', {}, el('legend', {}, 'Operations this key may call'), ...boxes.map(b => b.row)),
      el('div', { class: 'cx-actions' },
        el('button', { type: 'submit', class: 'cx-btn cx-btn-primary' }, 'Create key'),
        button('Cancel', () => { showKeyForm = false; render(); })));
    f.addEventListener('submit', async ev => {
      ev.preventDefault();
      const chosen = boxes.filter(b => b.box.checked).map(b => b.box.value);
      if (!chosen.length) return showError(new Error('Choose at least one operation.'));
      try {
        const made = await api<{ key: string; name: string }>('POST', `/organisations/${p.organisation.id}/keys`, { name: name.value, operations: chosen });
        freshKey = { name: made.name, key: made.key };
        showKeyForm = false;
        await load();
      } catch (e) { showError(e); }
    });
    form = card('New key', f);
  }

  const rows = p.keys.map(k => el('tr', { class: k.revokedAt ? 'is-off' : '' },
    el('th', { scope: 'row' }, k.name),
    el('td', {}, el('code', {}, `${k.prefix}…`)),
    el('td', {}, el('div', { class: 'cx-tags' }, ...k.operations.map(op => el('code', {}, op)))),
    el('td', {}, when(k.createdAt)),
    el('td', {}, k.revokedAt ? pill('Revoked', 'off') : ago(k.lastUsedAt)),
    el('td', { class: 'cx-cell-end' }, k.revokedAt || !can(p.organisation, 'editor') ? '' : button('Revoke', async () => {
      if (!confirm(`Revoke "${k.name}"? Anything using it stops working at once.`)) return;
      await api('DELETE', `/organisations/${p.organisation.id}/keys/${k.id}`);
      await load();
    }, 'danger'))));

  return [
    head('API keys', 'Each key lists the operations it may call. Send it as Authorization: Bearer lpk_… to the REST API or the MCP server.',
      showKeyForm || !can(p.organisation, 'editor') ? null : button('Create API key', () => { showKeyForm = true; freshKey = null; render(); }, 'primary')),
    secret, form,
    card(null, table(['Name', 'Key', 'Operations', 'Created', 'Last used', ''], rows, 'No keys yet. Create one to call the sandbox hospital.')),
  ].filter(Boolean) as Node[];
}

function connectionsSection(p: OrgPage): Node[] {
  const rows = p.connections.map(c => el('tr', {},
    el('th', { scope: 'row' }, c.name),
    el('td', {}, c.status !== 'active' ? pill('Off', 'off') : c.lastError ? pill('Error', 'failed') : c.sandbox ? pill('Sandbox', 'sandbox') : pill('Live', 'live')),
    el('td', {}, el('span', { class: 'cx-id' }, el('code', {}, c.id), copyButton(() => c.id))),
    el('td', {}, el('div', { class: 'cx-tags' }, ...c.operations.map(op => el('code', {}, op)))),
    el('td', {}, c.lastError ? el('span', { class: 'cx-error-text' }, c.lastError) : ago(c.lastOkAt))));
  const integrations = overview?.integrations ?? [];
  const systems = integrations.length ? card('Systems you can add',
    table(['System', 'Status', 'How LotusPond reaches it'], integrations.filter(i => i.id !== 'sandbox').map(i => el('tr', {},
      el('th', { scope: 'row' }, i.name, el('small', {}, i.vendor)),
      el('td', { title: i.statusText.detail }, pill(i.statusText.label, i.status)),
      el('td', {}, i.how))), ''),
    el('a', { class: 'cx-more', href: '#live' }, 'Ask for live access →')) : null;
  return [
    head('Connections', 'Every call names one connection. Pass its id as "connection".'),
    card(null, table(['Connection', 'Status', 'Id', 'Operations', 'Last worked'], rows, 'No connections.')),
    systems,
  ].filter(Boolean) as Node[];
}

function approvalsSection(p: OrgPage): Node[] {
  const pending = p.approvals.filter(a => a.status === 'pending');
  const past = p.approvals.filter(a => a.status !== 'pending').slice(0, 30);
  const decide = (a: Approval) => el('div', { class: 'cx-actions' },
    button(a.operation === 'tasks.run' ? 'Approve and start' : 'Approve and send', async () => {
      if (!confirm(a.operation === 'tasks.run'
        ? 'Approve this task? The agent starts on it in the hospital system now, and every action it takes is logged under Agent tasks.'
        : 'Approve this upload? It is sent to the hospital system now.')) return;
      const done = await api<Approval>('POST', `/organisations/${p.organisation.id}/approvals/${a.id}`, { decision: 'approve' });
      const started = taskOf(done);
      if (started) { location.hash = `tasks/${started}`; return; }
      await load();
    }, 'primary'),
    button('Reject', async () => { await api('POST', `/organisations/${p.organisation.id}/approvals/${a.id}`, { decision: 'reject' }); await load(); }, 'danger'));
  return [
    head('Approvals', p.organisation.approves
      ? 'Uploads and agent tasks wait here until a clinician in your organisation approves them. You are an approver: check the summary before you approve.'
      : 'Uploads and agent tasks wait here until a clinician in your organisation approves them. Members marked as approvers, under Members, decide.'),
    card(`Waiting (${pending.length})`, table(['Write', 'Operation', 'Asked', ''], pending.map(a => el('tr', {},
      el('th', { scope: 'row' }, a.summary), el('td', {}, el('code', {}, a.operation)), el('td', {}, ago(a.createdAt)),
      el('td', { class: 'cx-cell-end' }, p.organisation.approves ? decide(a) : el('span', { class: 'cx-muted' }, 'Waiting for an approver')))), 'Nothing is waiting.')),
    past.length ? card('Decided', table(['Write', 'Operation', 'Asked', 'Decision'], past.map(a => el('tr', {},
      el('th', { scope: 'row' }, a.summary), el('td', {}, el('code', {}, a.operation)), el('td', {}, when(a.createdAt)),
      el('td', {}, pill(a.status, a.status), a.decidedBy ? el('small', {}, ` by ${a.decidedBy}`) : null, a.error ? el('span', { class: 'cx-error-text' }, ` ${a.error}`) : null,
        taskOf(a) ? el('a', { class: 'cx-more', href: `#tasks/${taskOf(a)}` }, 'The task →') : null))), '')) : null,
  ].filter(Boolean) as Node[];
}

/** The agent task an approved tasks.run started (its result is { task: <task id>, status }). */
function taskOf(a: Approval): string | null {
  const t = (a.result as { task?: unknown } | null)?.task;
  return a.operation === 'tasks.run' && typeof t === 'string' && /^[0-9a-f-]{36}$/i.test(t) ? t : null;
}

// ---- Agent tasks ---------------------------------------------------------------------------------------------

const TASK_TEXT: Record<TaskStatus, string> = {
  queued: 'Queued', running: 'Running', succeeded: 'Done', failed: 'Failed', cannot: 'Could not do it',
  needs_sign_in: 'Needs sign-in', needs_review: 'Stopped for review',
};
const TASK_PILL: Record<TaskStatus, string> = {
  queued: 'pending', running: 'running', succeeded: 'done', failed: 'failed', cannot: 'refused', needs_sign_in: 'attention', needs_review: 'attention',
};
const taskPill = (s: TaskStatus) => pill(TASK_TEXT[s] ?? s, TASK_PILL[s] ?? 'off');
const ACTION_TEXT: Record<string, string> = {
  sandbox: 'Opened a browser', navigate: 'Reached a page', blocked: 'Blocked a request', model: 'Asked the model', model_text: 'The model said',
  screenshot: 'Took a screenshot', finish: 'Reported the outcome', safety_check: 'Safety check', error: 'Stopped',
  click: 'Click', double_click: 'Double-click', type: 'Typed', keypress: 'Pressed keys', scroll: 'Scrolled', move: 'Moved the pointer',
  drag: 'Dragged', wait: 'Waited',
};
const ACTION_OUTCOME: Record<TaskAction['outcome'], string> = { started: 'Did not finish', done: 'Done', failed: 'Failed', refused: 'Refused' };
const connectionName = (p: OrgPage, id: string) => p.connections.find(c => c.id === id)?.name ?? id;
const isOpen = (t: Task) => t.status === 'queued' || t.status === 'running';
/** The task's summary without the "Agent task" lead the approval needed: the section already says what it is. */
const taskTitle = (t: Task) => t.summary.replace(/^Agent task for patient ([^:]+): /, 'Patient $1: ').replace(/^Agent task: /, '');

/** A short line for an action's recorded detail: "x 412 · y 230", "keys ctrl, a", "allowHosts eka.care". */
function detailText(d: Record<string, unknown>): string {
  return Object.entries(d).map(([k, v]) => {
    const value = Array.isArray(v) ? v.map(x => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(', ')
      : v && typeof v === 'object' ? JSON.stringify(v) : String(v);
    return `${k} ${value}`;
  }).join(' · ');
}

function tasksSection(p: OrgPage): Node[] {
  const id = taskInHash();
  if (id) return taskDetailView(p, id);
  const tasks = p.tasks ?? [];
  const agent = p.agent
    ? `Tasks run with ${p.agent.model} in a browser of their own, after a clinician approves them. Every action is logged before it runs.`
    : 'The agent is off on this server, so new tasks are refused. Tasks run earlier are still listed here.';
  const rows = tasks.map(t => {
    const link = el('a', { href: `#tasks/${t.id}` }, taskTitle(t));
    return el('tr', {},
      el('th', { scope: 'row' }, link, t.error ? el('small', { class: 'cx-error-text' }, t.error) : null),
      el('td', {}, taskPill(t.status)),
      el('td', {}, connectionName(p, t.connection)),
      el('td', { class: 'cx-mono' }, `${t.steps} / ${t.maxSteps}`),
      el('td', {}, ago(t.createdAt)));
  });
  return [
    head('Agent tasks', agent, button('Refresh', () => load())),
    card(null, table(['Task', 'Status', 'Connection', 'Turns', 'Asked'], rows,
      'No tasks yet. Call tasks.run (or the MCP tool run_task) with a key that includes it; an approver then approves it under Approvals.')),
  ];
}

function taskDetailView(p: OrgPage, id: string): Node[] {
  const back = el('a', { class: 'cx-btn cx-btn-quiet', href: '#tasks' }, '← All tasks');
  if (!taskDetail || taskDetail.task.id !== id) return [head('Agent task', null, back), el('p', { class: taskError ? 'cx-error-text' : 'cx-muted' }, taskError ?? 'Loading…')];
  const { task: t, actions } = taskDetail;
  const fact = (label: string, value: Node | string) => el('div', {}, el('dt', {}, label), el('dd', {}, value));
  const facts = el('dl', { class: 'cx-facts' },
    fact('Status', taskPill(t.status)),
    fact('Connection', connectionName(p, t.connection)),
    fact('Model', el('code', {}, t.model)),
    fact('Browser', t.sandbox ?? 'Not opened'),
    fact('Model turns', `${t.steps} of ${t.maxSteps}`),
    fact('Asked', when(t.createdAt)),
    fact('Started', t.startedAt ? when(t.startedAt) : 'Not yet'),
    fact('Finished', t.finishedAt ? when(t.finishedAt) : isOpen(t) ? 'Still going' : 'Never'));
  const outcome = t.result || t.error ? card('Outcome',
    t.result ? el('p', {}, t.result) : null,
    t.error ? el('p', { class: 'cx-error-text' }, t.error) : null) : null;
  const rows = actions.map(a => el('tr', { class: a.outcome === 'failed' || a.outcome === 'refused' ? 'is-alert' : '' },
    el('td', { class: 'cx-mono' }, String(a.seq)),
    el('td', { class: 'cx-mono' }, String(a.step)),
    el('th', { scope: 'row' }, el('div', {}, ACTION_TEXT[a.kind] ?? a.kind, el('small', {}, el('code', {}, a.kind)))),
    el('td', {}, el('div', { class: 'cx-log-what' },
      a.text ? el('span', { class: 'cx-log-text' }, a.text) : null,
      Object.keys(a.detail).length ? el('small', {}, detailText(a.detail)) : null,
      a.url ? el('small', { class: 'cx-log-url' }, a.url) : null,
      a.screenshotSha256 ? el('small', { title: 'Screenshots are not stored, only their SHA-256.' }, `sha256 ${a.screenshotSha256.slice(0, 16)}…`) : null)),
    el('td', {}, pill(ACTION_OUTCOME[a.outcome] ?? a.outcome, a.outcome === 'started' ? 'off' : a.outcome)),
    el('td', { class: 'cx-mono' }, new Date(a.at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }))));
  return [
    head('Agent task', taskTitle(t), back, button('Refresh', () => load())),
    card(null, facts),
    outcome,
    card(`Action log (${actions.length})`,
      el('p', { class: 'cx-muted' }, isOpen(t)
        ? 'The agent is working. This log updates every few seconds; each action is written before it runs.'
        : 'Every action the agent took, in order. Each was written before it ran; typed text and the model’s words are shown to your organisation only.'),
      table(['#', 'Turn', 'Action', 'What', 'Outcome', 'Time'], rows, 'Nothing logged yet.')),
  ].filter(Boolean) as Node[];
}

function callsTable(calls: Call[]): HTMLElement {
  return table(['Time', 'Operation', 'Outcome'], calls.map(c => el('tr', {},
    el('td', { class: 'cx-mono' }, when(c.at)),
    el('td', {}, el('code', {}, c.operation)),
    el('td', {}, pill(OUTCOME_TEXT[c.outcome] ?? c.outcome, c.outcome)))), 'No calls yet. The quickstart has a first one to try.');
}

function logsSection(p: OrgPage): Node[] {
  const outcomes = ['all', 'done', 'pending', 'refused', 'not_offered', 'failed'].filter(o => o === 'all' || p.calls.some(c => c.outcome === o));
  const filters = el('div', { class: 'cx-seg', role: 'group', 'aria-label': 'Filter by outcome' }, ...outcomes.map(o => {
    const n = o === 'all' ? p.calls.length : p.calls.filter(c => c.outcome === o).length;
    const b = el('button', { type: 'button', 'aria-pressed': String(o === logFilter) }, `${o === 'all' ? 'All' : OUTCOME_TEXT[o] ?? o} ${n}`);
    b.addEventListener('click', () => { logFilter = o; render(); });
    return b;
  }));
  const shown = logFilter === 'all' ? p.calls : p.calls.filter(c => c.outcome === logFilter);
  return [
    head('Logs', 'Every call with this organisation’s keys, allowed or refused. The latest 50 are shown.', button('Refresh', () => load())),
    filters,
    card(null, callsTable(shown)),
  ];
}

function membersSection(p: OrgPage): Node[] {
  const o = p.organisation;
  const manage = can(o, 'admin');
  const roleSelect = (value: Role, disabled: boolean) => el('select', { 'aria-label': 'Role', disabled },
    ...(['owner', 'admin', 'editor', 'viewer'] as const).filter(r => r !== 'owner' || o.role === 'owner' || value === 'owner')
      .map(r => el('option', { value: r, selected: r === value }, r[0].toUpperCase() + r.slice(1))));
  const rows = p.members.map(m => {
    const locked = !manage || (m.role === 'owner' && o.role !== 'owner');
    const role = roleSelect(m.role, locked);
    role.addEventListener('change', async () => {
      try { await api('PATCH', `/organisations/${o.id}/members/${m.id}`, { role: role.value }); await load(); } catch (e) { showError(e); role.value = m.role; }
    });
    const approves = el('input', { type: 'checkbox', checked: m.approves, disabled: locked, 'aria-label': `${m.name} approves writes` });
    approves.addEventListener('change', async () => {
      try { await api('PATCH', `/organisations/${o.id}/members/${m.id}`, { approves: approves.checked }); await load(); } catch (e) { showError(e); approves.checked = m.approves; }
    });
    const remove = m.you
      ? button('Leave', async () => {
        if (!confirm(`Leave ${o.name}? You lose access until someone adds you again.`)) return;
        await api('DELETE', `/organisations/${o.id}/members/${m.id}`);
        current = null; location.hash = 'overview'; await load();
      }, 'danger')
      : locked ? null : button('Remove', async () => {
        if (!confirm(`Remove ${m.email} from ${o.name}?`)) return;
        await api('DELETE', `/organisations/${o.id}/members/${m.id}`);
        await load();
      }, 'danger');
    return el('tr', {},
      el('th', { scope: 'row' }, m.name, m.you ? ' (you)' : '', el('small', {}, m.email)),
      el('td', {}, role),
      el('td', {}, approves),
      el('td', { class: 'cx-cell-end' }, remove));
  });

  let add: HTMLElement | null = null;
  if (manage) {
    const email = el('input', { type: 'email', required: true, maxlength: '254', autocomplete: 'off' });
    const role = roleSelect('editor', false);
    const approves = el('input', { type: 'checkbox' });
    const form = el('form', { class: 'cx-form' },
      field('Their email', email, 'They need an organisation account first: send them to this console to make one, choosing “I am joining an organisation”.'),
      field('Role', role),
      el('label', { class: 'cx-check' }, approves, el('span', {}, 'Approves writes', el('small', {}, 'A clinician who may approve or reject uploads before they reach a hospital system.'))),
      el('div', { class: 'cx-actions' }, el('button', { type: 'submit', class: 'cx-btn cx-btn-primary' }, 'Add the member')));
    form.addEventListener('submit', async ev => {
      ev.preventDefault();
      try { await api('POST', `/organisations/${o.id}/members`, { email: email.value, role: role.value, approves: approves.checked }); await load(); } catch (e) { showError(e); }
    });
    add = card('Add a member', form);
  }
  return [
    head('Members', 'People in this organisation, each with a role, as in LotusPond Works. Approving writes is separate from the role.'),
    card(null, table(['Member', 'Role', 'Approves writes', ''], rows, 'No members.')),
    add,
    card('Roles', el('ul', { class: 'cx-roles' }, ...(Object.keys(ROLE_TEXT) as Role[]).map(r => el('li', {}, ROLE_TEXT[r])))),
  ].filter(Boolean) as Node[];
}

function quickstartSection(p: OrgPage): Node[] {
  const conn = p.connections.find(c => c.sandbox)?.id ?? '<connection id>';
  const curl = `curl ${ORIGIN}/v1/operations/patients.search \\\n  -H "Authorization: Bearer lpk_…" \\\n  -H "Content-Type: application/json" \\\n  -d '{"connection": "${conn}", "name": "asha"}'`;
  const mcp = JSON.stringify({ mcpServers: { 'lotuspond-hospitals': { type: 'http', url: `${ORIGIN}/v1/mcp`, headers: { Authorization: 'Bearer lpk_…' } } } }, null, 2);
  const code = (label: string, text: string) => el('div', { class: 'cx-code' },
    el('div', { class: 'cx-code-bar' }, el('span', {}, label), copyButton(() => text)),
    el('pre', {}, el('code', {}, text)));
  return [
    head('Quickstart', 'Call the sandbox hospital with a key from API keys.'),
    card('1. Search for a patient', code('REST · curl', curl)),
    card('2. Or give your agents the same operations through MCP', code('MCP client config', mcp)),
    card('Sandbox data', el('p', { class: 'cx-muted' }, 'Patients Asha Raman (MRN1001) and Vikram Nair (MRN1002); claims CLM-1001, CLM-1002, CLM-1003 and PA-2001.'),
      el('a', { class: 'cx-more', href: '/developers/#operations' }, 'Every operation in the developer guide →')),
  ];
}

function liveSection(p: OrgPage): Node[] {
  const o = p.organisation;
  const intro = 'To reach a real system we need the hospital’s written authority, a service account from its IT team, and a data-processing agreement. We never sign in as staff or work around a system’s access controls.';
  if (o.access === 'live') return [head('Go live', null), card(null, el('p', {}, 'This organisation has live access. Its live connections are listed under Connections.'))];
  if (o.liveRequestedAt) return [head('Go live', intro), card(null, el('p', {}, `You asked for live access on ${when(o.liveRequestedAt)}. We will write to you about the hospital’s written authority and the connection details.`))];
  if (!can(o, 'admin')) return [head('Go live', intro), card(null, el('p', { class: 'cx-muted' }, 'An owner or admin of this organisation asks for live access.'))];
  const systems = el('input', { type: 'text', required: true, maxlength: '300', placeholder: 'e.g. TrakCare, Bahmni, another FHIR R4 system' });
  const hospital = el('input', { type: 'text', required: true, maxlength: '300', placeholder: 'Hospital name and city' });
  const note = el('textarea', { maxlength: '2000', placeholder: 'What you will read or write, and who at the hospital has agreed' });
  const form = el('form', { class: 'cx-form' },
    el('label', {}, 'Which systems', systems), el('label', {}, 'Which hospital', hospital), el('label', {}, 'Anything else', note),
    el('div', { class: 'cx-actions' }, el('button', { type: 'submit', class: 'cx-btn cx-btn-primary' }, 'Ask for live access')));
  form.addEventListener('submit', async ev => {
    ev.preventDefault();
    try { await api('POST', `/organisations/${o.id}/live-request`, { systems: systems.value, hospital: hospital.value, note: note.value }); await load(); } catch (e) { showError(e); }
  });
  return [head('Go live', intro), card(null, form)];
}

// ---- Render --------------------------------------------------------------------------------------------------

function render() {
  if (!overview) return;
  if (!overview.organisations.length) { shell([el('div', { class: 'cx-center' }, createOrgForm(true))], null); return; }
  const active = section();
  if (active === 'new') { shell([head('New organisation', null), createOrgForm(false)], active); return; }
  if (!page) { shell([el('p', { class: 'cx-muted' }, 'Loading…')], active); return; }
  const body = {
    overview: overviewSection, keys: keysSection, connections: connectionsSection, approvals: approvalsSection,
    tasks: tasksSection, logs: logsSection, members: membersSection, quickstart: quickstartSection, live: liveSection,
  }[active](page);
  shell(body, active);
  document.title = `${SECTIONS.find(s => s.id === active)?.label ?? 'Console'} · ${page.organisation.name} · LotusPond Health`;
}

async function load() {
  try {
    overview = await api<Overview>('GET', '');
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return signedOut();
    shell([el('p', { class: 'cx-error' }, e instanceof Error ? e.message : 'The console could not load.')], null);
    return;
  }
  if (!current || !overview.organisations.some(o => o.id === current)) current = overview.organisations[0]?.id ?? null;
  page = current ? await api<OrgPage>('GET', `/organisations/${current}`).catch(e => { showError(e); return null; }) : null;
  await loadTask();
  render();
}

/** On #tasks/<id>: load the task and its log, and keep reloading them while the agent works. */
async function loadTask() {
  clearTimeout(taskTimer);
  const id = taskInHash();
  taskError = null;
  if (!id || !current) { taskDetail = null; return; }
  const org = current;
  try {
    taskDetail = await api<{ task: Task; actions: TaskAction[] }>('GET', `/organisations/${org}/tasks/${id}`);
  } catch (e) {
    taskDetail = null;
    taskError = e instanceof Error ? e.message : 'The task could not load.';
    return;
  }
  if (isOpen(taskDetail.task)) {
    // Reload the whole organisation, so the sidebar's count and the task list follow the task too.
    taskTimer = setTimeout(() => { if (taskInHash() === id && current === org) void load(); }, 3000);
  }
}

// Each section shows fresh data: switching sections reloads the organisation.
addEventListener('hashchange', () => { render(); scrollTo(0, 0); document.getElementById('main')?.focus({ preventScroll: true }); void load(); });
void load();

// The developer console, inside the app: organisations, members with roles, API keys, connections, approvals, agent
// tasks and logs for the organisation API (docs/connectors.md). It opens with the person's LotusPond Health sign-in,
// the same session as the rest of the app (settled by the owner, 2026-11-18), and talks to /api/console through the
// app's backend, so it works on the website and in the iOS and Android apps. The server checks membership and role on
// every call; what this page hides for a role is only a convenience.
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { backend, currentServer, errorMessage, inApp, isPreview, ApiError } from '../api';
import { siteHref, siteLinkProps } from '../site/links';
import { toast } from '../state/toast';
import { ConfirmButton, Field } from '../components/forms';
import '../styles/agents.css';
import '../styles/console.css';

type Role = 'owner' | 'admin' | 'editor' | 'viewer';
interface Operation { id: string; summary: string; writes: boolean; stage: 'live' | 'planned' }
interface Integration { id: string; name: string; vendor: string; status: string; statusText: { label: string; detail: string }; how: string }
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
  { id: 'overview', label: 'Overview' }, { id: 'keys', label: 'API keys' }, { id: 'connections', label: 'Connections' },
  { id: 'approvals', label: 'Approvals' }, { id: 'tasks', label: 'Agent tasks' }, { id: 'logs', label: 'Logs' },
  { id: 'members', label: 'Members' }, { id: 'quickstart', label: 'Quickstart' }, { id: 'live', label: 'Go live' },
] as const;
type Section = (typeof SECTIONS)[number]['id'];

const OUTCOME_TEXT: Record<string, string> = { done: 'Done', pending: 'Waiting for approval', refused: 'Refused', not_offered: 'Not offered', failed: 'Failed' };
const TASK_TEXT: Record<TaskStatus, string> = {
  queued: 'Queued', running: 'Running', succeeded: 'Done', failed: 'Failed', cannot: 'Could not do it', needs_sign_in: 'Needs sign-in', needs_review: 'Stopped for review',
};
const TASK_TONE: Record<TaskStatus, string> = {
  queued: 'wait', running: 'wait', succeeded: 'ok', failed: 'bad', cannot: 'bad', needs_sign_in: 'wait', needs_review: 'wait',
};
const OUTCOME_TONE: Record<string, string> = { done: 'ok', approved: 'ok', pending: 'wait', running: 'wait', refused: 'bad', rejected: 'bad', failed: 'bad', not_offered: 'off', started: 'off' };
const ACTION_TEXT: Record<string, string> = {
  sandbox: 'Opened a browser', navigate: 'Reached a page', blocked: 'Blocked a request', model: 'Asked the model', model_text: 'The model said',
  screenshot: 'Took a screenshot', finish: 'Reported the outcome', safety_check: 'Safety check', error: 'Stopped',
  click: 'Click', double_click: 'Double-click', type: 'Typed', keypress: 'Pressed keys', scroll: 'Scrolled', move: 'Moved the pointer', drag: 'Dragged', wait: 'Waited',
};
const ACTION_OUTCOME: Record<TaskAction['outcome'], string> = { started: 'Did not finish', done: 'Done', failed: 'Failed', refused: 'Refused' };

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'Never');
const ago = (iso: string | null) => {
  if (!iso) return 'Never';
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'Just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return when(iso);
};
const isOpen = (t: Task) => t.status === 'queued' || t.status === 'running';
const taskTitle = (t: Task) => t.summary.replace(/^Agent task for patient ([^:]+): /, 'Patient $1: ').replace(/^Agent task: /, '');
/** The agent task an approved tasks.run started (its result is { task: <task id>, status }). */
function taskOf(a: Approval): string | null {
  const t = (a.result as { task?: unknown } | null)?.task;
  return a.operation === 'tasks.run' && typeof t === 'string' && /^[0-9a-f-]{36}$/i.test(t) ? t : null;
}
function detailText(d: Record<string, unknown>): string {
  return Object.entries(d).map(([k, v]) => {
    const value = Array.isArray(v) ? v.map(x => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(', ') : v && typeof v === 'object' ? JSON.stringify(v) : String(v);
    return `${k} ${value}`;
  }).join(' · ');
}
function copy(text: string, what: string) {
  navigator.clipboard?.writeText(text).then(() => toast.info(`${what} copied.`), () => toast.error('Could not copy. Select the text and copy it.'));
}

const Pill = ({ tone, children }: { tone: string; children: ReactNode }) => <span className={`cpill cpill--${tone}`}>{children}</span>;
const Codes = ({ ids }: { ids: string[] }) => <span className="console__tags">{ids.map(id => <code key={id}>{id}</code>)}</span>;

/** A table that stacks into one card per row on a phone (console.css), each cell named by its column. */
function Table({ cols, empty, children }: { cols: string[]; empty: string; children: ReactNode[] }) {
  if (!children.length) return <p className="note">{empty}</p>;
  return (
    <div className="table-wrap">
      <table className="table console__table" data-cols={cols.join('|')}>
        <thead><tr>{cols.map((c, i) => <th key={i} scope="col">{c}</th>)}</tr></thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}
const Cell = ({ label, children, className }: { label: string; children?: ReactNode; className?: string }) => <td data-label={label} className={className}>{children}</td>;

/** A button whose action is awaited, with errors shown as a toast. */
function Act({ children, onClick, className = 'btn btn--small' }: { children: ReactNode; onClick: () => Promise<void>; className?: string }) {
  const [busy, setBusy] = useState(false);
  return <button type="button" className={className} disabled={busy} onClick={async () => {
    setBusy(true);
    try { await onClick(); } catch (e) { toast.error(errorMessage(e)); } finally { setBusy(false); }
  }}>{children}</button>;
}

export default function Console() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [page, setPage] = useState<OrgPage | null>(null);
  const [current, setCurrent] = useState<string | null>(null);
  const [section, setSection] = useState<Section | 'new'>('overview');
  const [task, setTask] = useState<string | null>(null);
  const [problem, setProblem] = useState<{ code: string; message: string } | null>(null);
  /** The chosen organisation could not load: nothing of another organisation is shown or acted on meanwhile. */
  const [pageError, setPageError] = useState<string | null>(null);
  // The organisation shown, for load() to keep: a ref, so load() stays the same function across renders.
  const currentRef = useRef<string | null>(null);
  useEffect(() => { currentRef.current = current; }, [current]);

  const load = useCallback(async (pick?: string | null) => {
    let o: Overview;
    try {
      o = await backend.console<Overview>('GET', '');
    } catch (e) {
      setProblem({ code: e instanceof ApiError ? e.code : 'error', message: errorMessage(e) });
      return;
    }
    setProblem(null);
    setOverview(o);
    const want = pick === undefined ? currentRef.current : pick;
    const id = want && o.organisations.some(x => x.id === want) ? want : o.organisations[0]?.id ?? null;
    setCurrent(id);
    currentRef.current = id;
    // Another organisation's page never stays up under this one's name, so nothing is done in the wrong one.
    setPage(p => (p && p.organisation.id === id ? p : null));
    setPageError(null);
    if (!id) return;
    try {
      const loaded = await backend.console<OrgPage>('GET', `/organisations/${id}`);
      if (currentRef.current === id) setPage(loaded);
    } catch (e) {
      if (currentRef.current !== id) return;
      setPage(null);
      setPageError(errorMessage(e));
    }
  }, []);
  useEffect(() => { if (!isPreview) void load(); }, [load]);

  const go = (s: Section | 'new', taskId: string | null = null) => { setSection(s); setTask(taskId); document.querySelector('.console')?.scrollIntoView({ block: 'start' }); void load(); };

  if (isPreview) return <Frame><section className="panel"><p className="note">The developer console needs the LotusPond server. This preview keeps everything in your browser.</p></section></Frame>;
  if (problem?.code === 'link_required') return <Frame><LinkEarlier message={problem.message} onDone={() => void load()} /></Frame>;
  if (problem) return <Frame><section className="panel"><p className="form-error" role="alert">{problem.message}</p><Act className="btn" onClick={() => load()}>Try again</Act></section></Frame>;
  if (!overview) return <Frame><p className="note">Loading…</p></Frame>;
  if (!overview.organisations.length) return <Frame><CreateOrg first regions={overview.regions} onMade={id => { setSection('overview'); void load(id); }} /></Frame>;

  const o = page?.organisation;
  const pending = page?.approvals.filter(a => a.status === 'pending').length ?? 0;
  const running = page?.tasks?.filter(isOpen).length ?? 0;
  const counts: Partial<Record<Section, number>> = { approvals: pending, tasks: running };
  return (
    <main className="page console">
      <div className="page__head">
        <div>
          <h1>Developer console</h1>
          <p>Organisations, API keys and approvals for LotusPond Health’s organisation API, signed in as {overview.account.email}.</p>
        </div>
        <div className="spacer" />
        <div className="console__org">
          <label className="note" htmlFor="console-org">Organisation</label>
          <select id="console-org" value={current ?? ''} onChange={e => { setSection('overview'); setTask(null); void load(e.target.value); }}>
            {overview.organisations.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}
          </select>
          {o && <Pill tone={o.access === 'live' ? 'ok' : 'wait'}>{o.access === 'live' ? 'Live' : 'Sandbox'}</Pill>}
        </div>
      </div>
      <nav className="console__nav" aria-label="Console">
        {SECTIONS.map(s => (
          <button key={s.id} type="button" aria-current={section === s.id ? 'page' : undefined} onClick={() => go(s.id)}>
            {s.label}{counts[s.id] ? <span className={`nav__badge${s.id === 'approvals' ? ' console__alert' : ''}`}>{counts[s.id]}</span> : null}
          </button>
        ))}
        <button type="button" aria-current={section === 'new' ? 'page' : undefined} onClick={() => go('new')}>New organisation</button>
      </nav>
      <div className="stack">
        {section === 'new' ? <CreateOrg regions={overview.regions} onMade={id => { setSection('overview'); void load(id); }} />
          : pageError ? <section className="panel"><p className="form-error" role="alert">{pageError}</p><div className="panel__actions"><Act className="btn" onClick={() => load()}>Try again</Act></div></section>
          : !page ? <p className="note">Loading…</p>
          : section === 'overview' ? <OverviewSection p={page} ov={overview} go={go} />
          : section === 'keys' ? <KeysSection p={page} ov={overview} reload={load} />
          : section === 'connections' ? <ConnectionsSection p={page} ov={overview} go={go} />
          : section === 'approvals' ? <ApprovalsSection p={page} reload={load} go={go} />
          : section === 'tasks' ? (task ? <TaskDetail p={page} id={task} back={() => go('tasks')} reload={load} /> : <TasksSection p={page} reload={load} open={id => go('tasks', id)} />)
          : section === 'logs' ? <LogsSection p={page} reload={load} />
          : section === 'members' ? <MembersSection p={page} reload={load} />
          : section === 'quickstart' ? <QuickstartSection p={page} />
          : <LiveSection p={page} reload={load} />}
      </div>
    </main>
  );
}

function Frame({ children }: { children: ReactNode }) {
  return (
    <main className="page page--narrow console">
      <div className="page__head"><div>
        <h1>Developer console</h1>
        <p>For healthcare organisations: reach hospital systems through one API and MCP server, with your LotusPond Health sign-in.</p>
      </div></div>
      <div className="stack">{children}</div>
    </main>
  );
}

/** An earlier console account (from before the console used the Health sign-in) has this email: its password joins it. */
function LinkEarlier({ message, onDone }: { message: string; onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setError(null);
    try { await backend.console('POST', '/link', { password }); toast.info('Your earlier console account is joined to this sign-in.'); onDone(); } catch (err) { setError(errorMessage(err)); setBusy(false); }
  };
  return (
    <section className="panel" aria-labelledby="link-h">
      <h2 id="link-h">Bring your earlier console account</h2>
      <p className="note panel__intro">{message} You only do this once; from then on your Health sign-in opens it.</p>
      <form className="console__form" onSubmit={submit}>
        <Field label="Console password" error={error}>{id => <input id={id} type="password" autoComplete="current-password" required maxLength={256} value={password} onChange={e => setPassword(e.target.value)} />}</Field>
        <div className="panel__actions"><button type="submit" className="btn btn--primary" disabled={busy}>{busy ? 'Checking…' : 'Join it'}</button></div>
      </form>
    </section>
  );
}

function CreateOrg({ first, regions, onMade }: { first?: boolean; regions: Region[]; onMade: (id: string) => void }) {
  const [name, setName] = useState('');
  const [region, setRegion] = useState(regions.find(r => r.id === 'in')?.id ?? regions[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true);
    try { const made = await backend.console<OrgSummary>('POST', '/organisations', { name, region }); toast.info(`${made.name} is ready.`); onMade(made.id); } catch (err) { toast.error(errorMessage(err)); setBusy(false); }
  };
  return (
    <section className="panel" aria-labelledby="neworg-h">
      <h2 id="neworg-h">{first ? 'Create your organisation' : 'New organisation'}</h2>
      <p className="note panel__intro">{first
        ? 'You are not in an organisation yet. Make one for your company or team and you become its owner, or ask an owner or admin to add you by your email. A new organisation starts with sandbox access: its keys reach LotusPond’s sandbox hospital, with synthetic patients, until we check your hospital’s written authority.'
        : 'Another company or team. You become its owner; it and its keys stay separate from your other organisations.'}</p>
      <form className="console__form" onSubmit={submit}>
        <Field label="Organisation name">{id => <input id={id} required minLength={2} maxLength={120} autoComplete="organization" placeholder="e.g. Acme Health AI" value={name} onChange={e => setName(e.target.value)} />}</Field>
        <Field label="Data region" hint="Where its keys, calls and approvals are kept.">{id => (
          <select id={id} value={region} onChange={e => setRegion(e.target.value)}>{regions.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}</select>
        )}</Field>
        <p className="note">By creating it you agree to the <a href={siteHref('/terms/')} {...siteLinkProps}>Terms of Use</a> and the <a href={siteHref('/privacy/')} {...siteLinkProps}>Privacy Policy</a> on behalf of the organisation.</p>
        <div className="panel__actions"><button type="submit" className="btn btn--primary" disabled={busy}>{busy ? 'Creating…' : 'Create organisation'}</button></div>
      </form>
    </section>
  );
}

function CallsTable({ calls }: { calls: Call[] }) {
  return (
    <Table cols={['Time', 'Operation', 'Outcome']} empty="No calls yet. The quickstart has a first one to try.">
      {calls.map(c => <tr key={c.id}><Cell label="Time">{when(c.at)}</Cell><Cell label="Operation"><code>{c.operation}</code></Cell><Cell label="Outcome"><Pill tone={OUTCOME_TONE[c.outcome] ?? 'off'}>{OUTCOME_TEXT[c.outcome] ?? c.outcome}</Pill></Cell></tr>)}
    </Table>
  );
}

function OverviewSection({ p, ov, go }: { p: OrgPage; ov: Overview; go: (s: Section) => void }) {
  const o = p.organisation;
  const activeKeys = p.keys.filter(k => !k.revokedAt);
  const pending = p.approvals.filter(a => a.status === 'pending');
  const done = p.calls.filter(c => c.outcome === 'done').length;
  const notOk = p.calls.filter(c => c.outcome === 'refused' || c.outcome === 'failed').length;
  const broken = p.connections.filter(c => c.lastError || c.status !== 'active').length;
  const lastUsed = activeKeys.map(k => k.lastUsedAt).filter((x): x is string => !!x).sort().pop() ?? null;
  const steps: { done: boolean; text: string; to: Section }[] = [
    { done: activeKeys.length > 0, text: 'Create an API key', to: 'keys' },
    { done: p.calls.some(c => c.outcome === 'done'), text: 'Make your first call to the sandbox hospital', to: 'quickstart' },
    { done: o.access === 'live' || !!o.liveRequestedAt, text: 'Ask for live access to a hospital', to: 'live' },
  ];
  const stat = (label: string, value: number, note: string, to: Section) => (
    <button type="button" className="console__stat" onClick={() => go(to)}><span className="note">{label}</span><b>{value}</b><span className="note">{note}</span></button>
  );
  return <>
    <section className="panel">
      <h2>{o.name}</h2>
      <p className="note panel__intro">{o.access === 'live' ? 'Live access' : 'Sandbox access'} · Region {ov.regions.find(r => r.id === o.region)?.name ?? o.region.toUpperCase()} · You are {o.role}{o.approves ? ' and approve writes' : ''}</p>
      <div className="console__stats">
        {stat('Calls', p.calls.length, `${done} done, ${notOk} refused or failed`, 'logs')}
        {stat('Active keys', activeKeys.length, activeKeys.length ? `Last used ${ago(lastUsed).toLowerCase()}` : 'None yet', 'keys')}
        {stat('Waiting for approval', pending.length, pending.length ? 'Writes need a clinician' : 'Nothing waiting', 'approvals')}
        {stat('Connections', p.connections.length, broken ? `${broken} need attention` : 'All working', 'connections')}
      </div>
    </section>
    {!steps.every(s => s.done) && (
      <section className="panel">
        <h2>Get started</h2>
        <ol className="console__steps">
          {steps.map(s => <li key={s.to} className={s.done ? 'is-done' : ''}><span aria-hidden="true">{s.done ? '✓' : ''}</span><button type="button" className="btn btn--quiet" onClick={() => go(s.to)}>{s.text}</button>{s.done && <span className="sr-only"> (done)</span>}</li>)}
        </ol>
      </section>
    )}
    <section className="panel"><h2>Recent calls</h2><CallsTable calls={p.calls.slice(0, 8)} />{p.calls.length > 8 && <button type="button" className="btn btn--quiet" onClick={() => go('logs')}>All logs →</button>}</section>
  </>;
}

function KeysSection({ p, ov, reload }: { p: OrgPage; ov: Overview; reload: () => Promise<void> }) {
  const o = p.organisation;
  const live = ov.operations.filter(x => x.stage === 'live');
  const [made, setMade] = useState<{ name: string; key: string } | null>(null);
  const [form, setForm] = useState(false);
  const [name, setName] = useState('Development');
  const [ops, setOps] = useState<string[]>(() => live.filter(x => !x.writes).map(x => x.id));
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ops.length) { toast.error('Choose at least one operation.'); return; }
    setBusy(true);
    try {
      const k = await backend.console<{ key: string; name: string }>('POST', `/organisations/${o.id}/keys`, { name, operations: ops });
      setMade({ name: k.name, key: k.key }); setForm(false); await reload();
    } catch (err) { toast.error(errorMessage(err)); } finally { setBusy(false); }
  };
  return <>
    <section className="panel">
      <h2>API keys</h2>
      <p className="note panel__intro">Each key lists the operations it may call. Send it as <code>Authorization: Bearer lpk_…</code> to the REST API or the MCP server.</p>
      {made && (
        <div className="agents__made" role="status">
          <h3>Key “{made.name}” created</h3>
          <p className="note">It is shown once. Copy it into your secret store now.</p>
          <div className="agents__copy"><code>{made.key}</code><button type="button" className="btn btn--small" onClick={() => copy(made.key, 'Key')}>Copy</button></div>
          <div className="panel__actions"><button type="button" className="btn btn--small" onClick={() => setMade(null)}>Done</button></div>
        </div>
      )}
      {form ? (
        <form className="agents__form" onSubmit={submit}>
          <Field label="Key name">{id => <input id={id} required maxLength={60} value={name} onChange={e => setName(e.target.value)} />}</Field>
          <fieldset className="agents__choices">
            <legend>Operations this key may call</legend>
            {live.map(x => (
              <label key={x.id}>
                <input type="checkbox" checked={ops.includes(x.id)} onChange={e => setOps(e.target.checked ? [...ops, x.id] : ops.filter(y => y !== x.id))} />
                <span><code>{x.id}</code>{x.writes && <em> writes wait for approval</em>}<small>{x.summary}</small></span>
              </label>
            ))}
          </fieldset>
          <div className="panel__actions">
            <button type="button" className="btn btn--quiet" onClick={() => setForm(false)}>Cancel</button>
            <button type="submit" className="btn btn--primary" disabled={busy}>{busy ? 'Creating…' : 'Create key'}</button>
          </div>
        </form>
      ) : can(o, 'editor') && <div className="panel__actions"><button type="button" className="btn btn--primary" onClick={() => { setForm(true); setMade(null); }}>Create API key</button></div>}
    </section>
    <section className="panel">
      <Table cols={['Name', 'Key', 'Operations', 'Created', 'Last used', '']} empty="No keys yet. Create one to call the sandbox hospital.">
        {p.keys.map(k => (
          <tr key={k.id} className={k.revokedAt ? 'is-off' : ''}>
            <Cell label="Name"><b>{k.name}</b></Cell>
            <Cell label="Key"><code>{k.prefix}…</code></Cell>
            <Cell label="Operations"><Codes ids={k.operations} /></Cell>
            <Cell label="Created">{when(k.createdAt)}</Cell>
            <Cell label="Last used">{k.revokedAt ? <Pill tone="off">Revoked</Pill> : ago(k.lastUsedAt)}</Cell>
            <Cell label="" className="console__end">{!k.revokedAt && can(o, 'editor') && (
              <ConfirmButton className="btn btn--small btn--danger" busyText="Revoking…" confirmText={`Revoke “${k.name}”? Anything using it stops at once.`}
                onConfirm={async () => { try { await backend.console('DELETE', `/organisations/${o.id}/keys/${k.id}`); await reload(); } catch (e) { toast.error(errorMessage(e)); } }}>Revoke</ConfirmButton>
            )}</Cell>
          </tr>
        ))}
      </Table>
    </section>
  </>;
}

function ConnectionsSection({ p, ov, go }: { p: OrgPage; ov: Overview; go: (s: Section) => void }) {
  const systems = (ov.integrations ?? []).filter(i => i.id !== 'sandbox');
  return <>
    <section className="panel">
      <h2>Connections</h2>
      <p className="note panel__intro">Every call names one connection. Pass its id as <code>"connection"</code>.</p>
      <Table cols={['Connection', 'Status', 'Id', 'Operations', 'Last worked']} empty="No connections.">
        {p.connections.map(c => (
          <tr key={c.id}>
            <Cell label="Connection"><b>{c.name}</b></Cell>
            <Cell label="Status">{c.status !== 'active' ? <Pill tone="off">Off</Pill> : c.lastError ? <Pill tone="bad">Error</Pill> : c.sandbox ? <Pill tone="wait">Sandbox</Pill> : <Pill tone="ok">Live</Pill>}</Cell>
            <Cell label="Id"><span className="console__id"><code>{c.id}</code><button type="button" className="btn btn--small" onClick={() => copy(c.id, 'Connection id')}>Copy</button></span></Cell>
            <Cell label="Operations"><Codes ids={c.operations} /></Cell>
            <Cell label="Last worked">{c.lastError ? <span className="field__error">{c.lastError}</span> : ago(c.lastOkAt)}</Cell>
          </tr>
        ))}
      </Table>
    </section>
    {systems.length > 0 && (
      <section className="panel">
        <h2>Systems you can add</h2>
        <Table cols={['System', 'Status', 'How LotusPond reaches it']} empty="">
          {systems.map(i => (
            <tr key={i.id}>
              <Cell label="System"><b>{i.name}</b><small className="console__sub">{i.vendor}</small></Cell>
              <Cell label="Status"><span title={i.statusText.detail}><Pill tone={i.status === 'available' ? 'ok' : i.status === 'on_request' ? 'wait' : 'off'}>{i.statusText.label}</Pill></span></Cell>
              <Cell label="How">{i.how}</Cell>
            </tr>
          ))}
        </Table>
        <div className="panel__actions"><button type="button" className="btn" onClick={() => go('live')}>Ask for live access →</button></div>
      </section>
    )}
  </>;
}

function ApprovalsSection({ p, reload, go }: { p: OrgPage; reload: () => Promise<void>; go: (s: Section, task?: string | null) => void }) {
  const o = p.organisation;
  const pending = p.approvals.filter(a => a.status === 'pending');
  const past = p.approvals.filter(a => a.status !== 'pending').slice(0, 30);
  const decide = async (a: Approval, decision: 'approve' | 'reject') => {
    const done = await backend.console<Approval>('POST', `/organisations/${o.id}/approvals/${a.id}`, { decision });
    const started = decision === 'approve' ? taskOf(done) : null;
    if (started) go('tasks', started); else await reload();
  };
  return <>
    <section className="panel">
      <h2>Waiting for approval ({pending.length})</h2>
      <p className="note panel__intro">{o.approves
        ? 'Uploads and agent tasks wait here until a clinician in your organisation approves them. You are an approver: check the summary before you approve.'
        : 'Uploads and agent tasks wait here until a clinician in your organisation approves them. Members marked as approvers, under Members, decide.'}</p>
      <Table cols={['Write', 'Operation', 'Asked', '']} empty="Nothing is waiting.">
        {pending.map(a => (
          <tr key={a.id}>
            <Cell label="Write"><b>{a.summary}</b></Cell>
            <Cell label="Operation"><code>{a.operation}</code></Cell>
            <Cell label="Asked">{ago(a.createdAt)}</Cell>
            <Cell label="" className="console__end">{o.approves ? (
              <span className="agents__row-actions">
                <ConfirmButton className="btn btn--small btn--primary" busyText="Sending…"
                  confirmText={a.operation === 'tasks.run' ? 'Approve? The agent starts in the hospital system now.' : 'Approve? It is sent to the hospital system now.'}
                  onConfirm={async () => { try { await decide(a, 'approve'); } catch (e) { toast.error(errorMessage(e)); } }}>{a.operation === 'tasks.run' ? 'Approve and start' : 'Approve and send'}</ConfirmButton>
                <Act className="btn btn--small btn--danger-text" onClick={() => decide(a, 'reject')}>Reject</Act>
              </span>
            ) : <span className="note">Waiting for an approver</span>}</Cell>
          </tr>
        ))}
      </Table>
    </section>
    {past.length > 0 && (
      <section className="panel">
        <h2>Decided</h2>
        <Table cols={['Write', 'Operation', 'Asked', 'Decision']} empty="">
          {past.map(a => (
            <tr key={a.id}>
              <Cell label="Write">{a.summary}</Cell>
              <Cell label="Operation"><code>{a.operation}</code></Cell>
              <Cell label="Asked">{when(a.createdAt)}</Cell>
              <Cell label="Decision">
                <Pill tone={OUTCOME_TONE[a.status] ?? 'off'}>{a.status}</Pill>{a.decidedBy && <small className="console__sub">by {a.decidedBy}</small>}
                {a.error && <small className="field__error">{a.error}</small>}
                {taskOf(a) && <button type="button" className="btn btn--small btn--quiet" onClick={() => go('tasks', taskOf(a))}>The task →</button>}
              </Cell>
            </tr>
          ))}
        </Table>
      </section>
    )}
  </>;
}

const connectionName = (p: OrgPage, id: string) => p.connections.find(c => c.id === id)?.name ?? id;

function TasksSection({ p, reload, open }: { p: OrgPage; reload: () => Promise<void>; open: (id: string) => void }) {
  const tasks = p.tasks ?? [];
  return (
    <section className="panel">
      <h2>Agent tasks</h2>
      <p className="note panel__intro">{p.agent
        ? `Tasks run with ${p.agent.model} in a browser of their own, after a clinician approves them. Every action is logged before it runs.`
        : 'The agent is off on this server, so new tasks are refused. Tasks run earlier are still listed here.'}</p>
      <Table cols={['Task', 'Status', 'Connection', 'Turns', 'Asked']} empty="No tasks yet. Call tasks.run (or the MCP tool run_task) with a key that includes it; an approver then approves it under Approvals.">
        {tasks.map(t => (
          <tr key={t.id}>
            <Cell label="Task"><button type="button" className="console__link" onClick={() => open(t.id)}>{taskTitle(t)}</button>{t.error && <small className="field__error">{t.error}</small>}</Cell>
            <Cell label="Status"><Pill tone={TASK_TONE[t.status] ?? 'off'}>{TASK_TEXT[t.status] ?? t.status}</Pill></Cell>
            <Cell label="Connection">{connectionName(p, t.connection)}</Cell>
            <Cell label="Turns">{t.steps} / {t.maxSteps}</Cell>
            <Cell label="Asked">{ago(t.createdAt)}</Cell>
          </tr>
        ))}
      </Table>
      <div className="panel__actions"><Act className="btn btn--small" onClick={reload}>Refresh</Act></div>
    </section>
  );
}

/** One agent task and its full action log, reloaded every few seconds while the agent works. */
function TaskDetail({ p, id, back, reload }: { p: OrgPage; id: string; back: () => void; reload: () => Promise<void> }) {
  const [detail, setDetail] = useState<{ task: Task; actions: TaskAction[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const org = p.organisation.id;
  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const d = await backend.console<{ task: Task; actions: TaskAction[] }>('GET', `/organisations/${org}/tasks/${id}`);
        if (stop) return;
        setDetail(d); setError(null);
        if (isOpen(d.task)) timer = setTimeout(() => { void reload(); void tick(); }, 3000);
      } catch (e) { if (!stop) setError(errorMessage(e)); }
    };
    void tick();
    return () => { stop = true; clearTimeout(timer); };
  }, [org, id, reload]);
  const head = <div className="panel__actions console__back"><button type="button" className="btn btn--small" onClick={back}>← All tasks</button></div>;
  if (!detail) return <section className="panel">{head}<p className={error ? 'form-error' : 'note'}>{error ?? 'Loading…'}</p></section>;
  const { task: t, actions } = detail;
  const fact = (label: string, value: ReactNode) => <div><dt>{label}</dt><dd>{value}</dd></div>;
  return <>
    <section className="panel">
      {head}
      <h2>{taskTitle(t)}</h2>
      <dl className="console__facts">
        {fact('Status', <Pill tone={TASK_TONE[t.status] ?? 'off'}>{TASK_TEXT[t.status] ?? t.status}</Pill>)}
        {fact('Connection', connectionName(p, t.connection))}
        {fact('Model', <code>{t.model}</code>)}
        {fact('Browser', t.sandbox ?? 'Not opened')}
        {fact('Model turns', `${t.steps} of ${t.maxSteps}`)}
        {fact('Asked', when(t.createdAt))}
        {fact('Started', t.startedAt ? when(t.startedAt) : 'Not yet')}
        {fact('Finished', t.finishedAt ? when(t.finishedAt) : isOpen(t) ? 'Still going' : 'Never')}
      </dl>
    </section>
    {(t.result || t.error) && <section className="panel"><h2>Outcome</h2>{t.result && <p>{t.result}</p>}{t.error && <p className="form-error">{t.error}</p>}</section>}
    <section className="panel">
      <h2>Action log ({actions.length})</h2>
      <p className="note panel__intro">{isOpen(t)
        ? 'The agent is working. This log updates every few seconds; each action is written before it runs.'
        : 'Every action the agent took, in order. Each was written before it ran; typed text and the model’s words are shown to your organisation only.'}</p>
      <Table cols={['#', 'Turn', 'Action', 'What', 'Outcome', 'Time']} empty="Nothing logged yet.">
        {actions.map(a => (
          <tr key={a.seq} className={a.outcome === 'failed' || a.outcome === 'refused' ? 'is-alert' : ''}>
            <Cell label="#">{a.seq}</Cell>
            <Cell label="Turn">{a.step}</Cell>
            <Cell label="Action">{ACTION_TEXT[a.kind] ?? a.kind}<small className="console__sub"><code>{a.kind}</code></small></Cell>
            <Cell label="What">
              {a.text && <span className="console__text">{a.text}</span>}
              {Object.keys(a.detail).length > 0 && <small className="console__sub">{detailText(a.detail)}</small>}
              {a.url && <small className="console__sub console__url">{a.url}</small>}
              {a.screenshotSha256 && <small className="console__sub" title="Screenshots are not stored, only their SHA-256.">sha256 {a.screenshotSha256.slice(0, 16)}…</small>}
            </Cell>
            <Cell label="Outcome"><Pill tone={OUTCOME_TONE[a.outcome] ?? 'off'}>{ACTION_OUTCOME[a.outcome] ?? a.outcome}</Pill></Cell>
            <Cell label="Time">{new Date(a.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</Cell>
          </tr>
        ))}
      </Table>
    </section>
  </>;
}

function LogsSection({ p, reload }: { p: OrgPage; reload: () => Promise<void> }) {
  const [filter, setFilter] = useState('all');
  const outcomes = ['all', 'done', 'pending', 'refused', 'not_offered', 'failed'].filter(x => x === 'all' || p.calls.some(c => c.outcome === x));
  const shown = filter === 'all' ? p.calls : p.calls.filter(c => c.outcome === filter);
  return (
    <section className="panel">
      <h2>Logs</h2>
      <p className="note panel__intro">Every call with this organisation’s keys, allowed or refused. The latest 50 are shown.</p>
      <div className="console__filters">
        <div className="seg" role="group" aria-label="Filter by outcome">
          {outcomes.map(x => <button key={x} type="button" aria-pressed={x === filter} onClick={() => setFilter(x)}>{x === 'all' ? 'All' : OUTCOME_TEXT[x] ?? x} {x === 'all' ? p.calls.length : p.calls.filter(c => c.outcome === x).length}</button>)}
        </div>
        <Act className="btn btn--small" onClick={reload}>Refresh</Act>
      </div>
      <CallsTable calls={shown} />
    </section>
  );
}

function MembersSection({ p, reload }: { p: OrgPage; reload: (pick?: string | null) => Promise<void> }) {
  const o = p.organisation;
  const manage = can(o, 'admin');
  const roles = (value: Role) => (['owner', 'admin', 'editor', 'viewer'] as const).filter(r => r !== 'owner' || o.role === 'owner' || value === 'owner');
  const patch = async (m: Member, body: { role?: Role; approves?: boolean }) => {
    try { await backend.console('PATCH', `/organisations/${o.id}/members/${m.id}`, body); await reload(); } catch (e) { toast.error(errorMessage(e)); await reload(); }
  };
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('editor');
  const [approves, setApproves] = useState(false);
  const [busy, setBusy] = useState(false);
  const add = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true);
    try { await backend.console('POST', `/organisations/${o.id}/members`, { email, role, approves }); setEmail(''); setApproves(false); toast.info('Member added.'); await reload(); } catch (err) { toast.error(errorMessage(err)); } finally { setBusy(false); }
  };
  return <>
    <section className="panel">
      <h2>Members</h2>
      <p className="note panel__intro">People in this organisation, each with a role, as in LotusPond Works. Approving writes is separate from the role.</p>
      <Table cols={['Member', 'Role', 'Approves writes', '']} empty="No members.">
        {p.members.map(m => {
          const locked = !manage || (m.role === 'owner' && o.role !== 'owner');
          return (
            <tr key={m.id}>
              <Cell label="Member"><b>{m.name}{m.you ? ' (you)' : ''}</b><small className="console__sub">{m.email}</small></Cell>
              <Cell label="Role">
                <select aria-label={`${m.name}’s role`} value={m.role} disabled={locked} onChange={e => void patch(m, { role: e.target.value as Role })}>
                  {roles(m.role).map(r => <option key={r} value={r}>{r[0].toUpperCase() + r.slice(1)}</option>)}
                </select>
              </Cell>
              <Cell label="Approves writes"><input type="checkbox" aria-label={`${m.name} approves writes`} checked={m.approves} disabled={locked} onChange={e => void patch(m, { approves: e.target.checked })} /></Cell>
              <Cell label="" className="console__end">
                {m.you ? (
                  <ConfirmButton className="btn btn--small btn--danger-text" busyText="Leaving…" confirmText={`Leave ${o.name}?`}
                    onConfirm={async () => { try { await backend.console('DELETE', `/organisations/${o.id}/members/${m.id}`); await reload(null); } catch (e) { toast.error(errorMessage(e)); } }}>Leave</ConfirmButton>
                ) : !locked && (
                  <ConfirmButton className="btn btn--small btn--danger-text" busyText="Removing…" confirmText={`Remove ${m.email}?`}
                    onConfirm={async () => { try { await backend.console('DELETE', `/organisations/${o.id}/members/${m.id}`); await reload(); } catch (e) { toast.error(errorMessage(e)); } }}>Remove</ConfirmButton>
                )}
              </Cell>
            </tr>
          );
        })}
      </Table>
    </section>
    {manage && (
      <section className="panel">
        <h2>Add a member</h2>
        <p className="note panel__intro">They sign in with their own LotusPond Health account and open Developer console once (in the menu under their name). Then add them here by that email.</p>
        <form className="console__form" onSubmit={add}>
          <Field label="Their email">{id => <input id={id} type="email" required maxLength={254} autoComplete="off" value={email} onChange={e => setEmail(e.target.value)} />}</Field>
          <Field label="Role">{id => <select id={id} value={role} onChange={e => setRole(e.target.value as Role)}>{roles('editor').map(r => <option key={r} value={r}>{r[0].toUpperCase() + r.slice(1)}</option>)}</select>}</Field>
          <label className="confirm-check"><input type="checkbox" checked={approves} onChange={e => setApproves(e.target.checked)} /><span><b>Approves writes</b><br /><span className="note">A clinician who may approve or reject uploads before they reach a hospital system.</span></span></label>
          <div className="panel__actions"><button type="submit" className="btn btn--primary" disabled={busy}>{busy ? 'Adding…' : 'Add the member'}</button></div>
        </form>
      </section>
    )}
    <section className="panel"><h2>Roles</h2><ul className="console__roles">{(Object.keys(ROLE_TEXT) as Role[]).map(r => <li key={r}>{ROLE_TEXT[r]}</li>)}</ul></section>
  </>;
}

function QuickstartSection({ p }: { p: OrgPage }) {
  const origin = inApp ? currentServer() : location.origin;
  const conn = p.connections.find(c => c.sandbox)?.id ?? '<connection id>';
  const curl = `curl ${origin}/v1/operations/patients.search \\\n  -H "Authorization: Bearer lpk_…" \\\n  -H "Content-Type: application/json" \\\n  -d '{"connection": "${conn}", "name": "asha"}'`;
  const mcp = JSON.stringify({ mcpServers: { 'lotuspond-hospitals': { type: 'http', url: `${origin}/v1/mcp`, headers: { Authorization: 'Bearer lpk_…' } } } }, null, 2);
  const code = (label: string, text: string) => (
    <div className="console__code"><div><span className="note">{label}</span><button type="button" className="btn btn--small" onClick={() => copy(text, label)}>Copy</button></div><pre className="agents__pre">{text}</pre></div>
  );
  return <>
    <section className="panel"><h2>1. Search for a patient</h2><p className="note panel__intro">Call the sandbox hospital with a key from API keys.</p>{code('REST · curl', curl)}</section>
    <section className="panel"><h2>2. Or give your agents the same operations through MCP</h2>{code('MCP client config', mcp)}</section>
    <section className="panel">
      <h2>Sandbox data</h2>
      <p className="note">Patients Asha Raman (MRN1001) and Vikram Nair (MRN1002); claims CLM-1001, CLM-1002, CLM-1003 and PA-2001.</p>
      <p><a href={`${siteHref('/developers/')}#operations`} {...siteLinkProps}>Every operation in the developer guide →</a></p>
    </section>
  </>;
}

function LiveSection({ p, reload }: { p: OrgPage; reload: () => Promise<void> }) {
  const o = p.organisation;
  const [systems, setSystems] = useState('');
  const [hospital, setHospital] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const intro = 'To reach a real system we need the hospital’s written authority, a service account from its IT team, and a data-processing agreement. We never sign in as staff or work around a system’s access controls.';
  let body: ReactNode;
  if (o.access === 'live') body = <p>This organisation has live access. Its live connections are listed under Connections.</p>;
  else if (o.liveRequestedAt) body = <p>You asked for live access on {when(o.liveRequestedAt)}. We will write to you about the hospital’s written authority and the connection details.</p>;
  else if (!can(o, 'admin')) body = <p className="note">An owner or admin of this organisation asks for live access.</p>;
  else body = (
    <form className="console__form" onSubmit={async e => {
      e.preventDefault(); setBusy(true);
      try { await backend.console('POST', `/organisations/${o.id}/live-request`, { systems, hospital, note }); toast.info('Asked. We will write to you.'); await reload(); } catch (err) { toast.error(errorMessage(err)); setBusy(false); }
    }}>
      <Field label="Which systems">{id => <input id={id} required minLength={2} maxLength={300} placeholder="e.g. TrakCare, Bahmni, another FHIR R4 system" value={systems} onChange={e => setSystems(e.target.value)} />}</Field>
      <Field label="Which hospital">{id => <input id={id} required minLength={2} maxLength={300} placeholder="Hospital name and city" value={hospital} onChange={e => setHospital(e.target.value)} />}</Field>
      <Field label="Anything else" wide>{id => <textarea id={id} maxLength={2000} rows={3} placeholder="What you will read or write, and who at the hospital has agreed" value={note} onChange={e => setNote(e.target.value)} />}</Field>
      <div className="panel__actions"><button type="submit" className="btn btn--primary" disabled={busy}>{busy ? 'Sending…' : 'Ask for live access'}</button></div>
    </form>
  );
  return <section className="panel"><h2>Go live</h2><p className="note panel__intro">{intro}</p>{body}</section>;
}
